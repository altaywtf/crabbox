#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { nativeTargets, fileSHA256, newOutputOutside } from './artifacts.mjs';
import { nativeBuildEnvironment } from './build.mjs';
import { materialize, verifyPreparedSource } from './materialize.mjs';
import { produce } from './produce.mjs';
import { smoke } from './smoke.mjs';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(packageRoot, '../..');

export async function qualify({ target: key, output, jjArchive, gixArchive }) {
  const target = nativeTargets.find((item) => item.key === key);
  assert.ok(target, 'select an explicit native target');
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  assert.equal(`${platform}_${arch}`, key, 'Node process must run natively for the selected target');
  const machine = os.machine().toLowerCase();
  assert.ok((arch === 'amd64' ? ['x86_64', 'amd64'] : ['aarch64', 'arm64']).includes(machine), 'native hardware architecture mismatch');
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'manifest.json'), 'utf8'));
  output = await newOutputOutside(repository, output);
  await fs.mkdir(output, { mode: 0o700 });
  const home = path.join(output, 'home');
  const temp = path.join(output, 'temp');
  await fs.mkdir(home);
  await fs.mkdir(temp);
  await fs.writeFile(path.join(home, 'jj.toml'), '');
  const targetDirectory = path.join(output, 'fixture-build');
  const env = nativeBuildEnvironment({ home, temp, targetDirectory });
  Object.assign(env, { GOENV: 'off', GOTOOLCHAIN: 'local', CGO_ENABLED: '0', CARGO_PROFILE_TEST_DEBUG: '0' });
  const run = (name, args, cwd = output, inherit = false) => {
    const result = spawnSync(name, args, { cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      timeout: 45 * 60_000, stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name} ${args[0]} failed: ${result.stderr ?? ''}`);
    return result.stdout?.trim() ?? '';
  };
  const rustc = run('rustc', ['-vV']);
  assert.equal(rustc.split('\n').find((line) => line.startsWith('host: ')), `host: ${target.targetTriple}`);
  const go = JSON.parse(run('go', ['env', '-json', 'GOHOSTOS', 'GOHOSTARCH', 'GOOS', 'GOARCH', 'GOVERSION']));
  assert.deepEqual([go.GOHOSTOS, go.GOOS, go.GOHOSTARCH, go.GOARCH], [target.targetOS, target.targetOS, target.targetArch, target.targetArch]);
  const architecture = { node: process.version, platform: process.platform, processArchitecture: process.arch,
    machine, osRelease: os.release(), rustc, cargo: run('cargo', ['--version']), go };
  await fs.writeFile(path.join(output, 'architecture.json'), JSON.stringify(architecture, null, 2) + '\n');
  const archive = async (provided, name, url) => {
    if (provided) return fs.realpath(provided);
    const destination = path.join(output, name);
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    assert.ok(response.ok && response.body, `archive download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    return destination;
  };
  const source = path.join(output, 'source');
  const prepared = await materialize({ output: source, inventoryFile: path.join(output, 'source-inventory.json'),
    jjArchive: await archive(jjArchive, 'jj.tar.gz', manifest.jj.archiveUrl),
    gixArchive: await archive(gixArchive, 'gix.crate', manifest.gix.archiveUrl) });
  const cargoArgs = ['--locked', '--offline', '--manifest-path', path.join(source, 'Cargo.toml'),
    '-p', 'jj-cli', '--no-default-features', '--features', 'git', '--target', target.targetTriple];
  // Network access is limited to dependency preparation; builds remain offline.
  run('cargo', ['fetch', '--locked', '--manifest-path', path.join(source, 'Cargo.toml'), '--target', target.targetTriple], source, true);
  run('cargo', ['test', ...cargoArgs, '--bin', 'crabbox-jj-source', 'object_ceiling_tests', '--', '--nocapture'], source, true);
  run('cargo', ['build', ...cargoArgs, '--bin', 'jj'], source, true);
  const stockJJ = path.join(targetDirectory, target.targetTriple, 'debug', `jj${target.targetOS === 'windows' ? '.exe' : ''}`);
  await verifyPreparedSource(source, manifest);
  const produced = await produce({ source, output: path.join(output, 'production') });
  const installed = path.join(output, 'installed');
  await fs.mkdir(installed);
  for (const name of await fs.readdir(produced.bundle)) await fs.copyFile(path.join(produced.bundle, name), path.join(installed, name));
  const cli = path.join(installed, `crabbox${target.targetOS === 'windows' ? '.exe' : ''}`);
  run('go', ['build', '-trimpath', '-o', cli, './cmd/crabbox'], repository, true);
  const runtime = await smoke({ jj: stockJJ, crabbox: cli, output: path.join(output, 'smoke') });
  const receipt = { schemaVersion: 1, target: key, architecture, prepared, artifact: produced.artifact,
    stockJJSHA256: await fileSHA256(stockJJ), runtime,
    scope: 'Native ordinary-file qualification and focused Rust test; not executable/symlink, SSH lifecycle, licensing, signing or full release acceptance.' };
  await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  // Keep permissions inside the archive when Actions transports the bundle.
  // macOS tar otherwise adds AppleDouble metadata outside the four-file contract.
  env.COPYFILE_DISABLE = '1';
  const members = (await fs.readdir(produced.bundle)).sort();
  const archivePath = path.join(output, 'native-bundle.tar');
  run('tar', ['-cf', archivePath, ...members], produced.bundle);
  assert.deepEqual(run('tar', ['-tf', archivePath]).split('\n').sort(), members);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { target: { type: 'string' }, output: { type: 'string' },
      'jj-archive': { type: 'string' }, 'gix-archive': { type: 'string' } } });
    if (!values.target || !values.output) throw new Error('usage: qualify.mjs --target OS_ARCH --output NEW_DIRECTORY [--jj-archive ARCHIVE --gix-archive ARCHIVE]');
    const result = await qualify({ ...values, jjArchive: values['jj-archive'], gixArchive: values['gix-archive'] });
    process.stdout.write(JSON.stringify({ target: result.target, sourceTreeSHA256: result.prepared.sourceTree.sha256, sourceUnchanged: result.runtime.sourceUnchanged }) + '\n');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
