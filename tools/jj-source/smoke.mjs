#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileSHA256, nativeTarget, verifyPair, verifySourceVersion } from './artifacts.mjs';
import { sourceTree, isolatedGitConfig } from './materialize.mjs';

// This ordinary-file smoke is portable; executable/symlink and SSH lifecycle
// acceptance require their separate platform fixtures.
export async function smoke({ jj, crabbox, output }) {
  jj = await fs.realpath(jj);
  crabbox = await fs.realpath(crabbox);
  const target = nativeTarget(process.platform === 'win32' ? 'windows' : process.platform,
    process.arch === 'x64' ? 'amd64' : process.arch);
  const pair = await verifyPair(path.dirname(crabbox), { target, release: true, coinstalled: true });
  const helper = path.join(path.dirname(crabbox), target.binaryName);
  output = path.resolve(output);
  await fs.mkdir(output, { mode: 0o700 });
  output = await fs.realpath(output);
  const source = path.join(output, 'source');
  const home = path.join(output, 'home');
  const temp = path.join(output, 'temp');
  await fs.mkdir(home);
  await fs.mkdir(temp);
  const config = path.join(home, 'jj.toml');
  await fs.writeFile(config, '[user]\nname = "Native smoke"\nemail = "smoke@example.invalid"\n');
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, isolatedGitConfig(), { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: path.join(output, 'cache'),
    XDG_STATE_HOME: path.join(output, 'state'), JJ_CONFIG: config,
    TMPDIR: temp, TEMP: temp, TMP: temp, LANG: 'C', LC_ALL: 'C' });
  const run = (binary, args, cwd = source) => {
    const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${path.basename(binary)} ${args[0]}: ${result.stderr}`);
    return result.stdout;
  };
  const stock = (...args) => run(jj, ['--no-pager', '--color=never', ...args]);
  const jjVersion = run(jj, ['--version'], output).trim();
  assert.match(jjVersion, new RegExp(`^jj ${pair.receipt.nativeVersion.replaceAll('.', '\\.')}([ -]|$)`));
  run(jj, ['git', 'init', '--no-colocate', source], output);
  const recorded = 'Recorded UTF-8: café\n';
  const live = 'Live UTF-8: café\n';
  const pending = 'New ordinary file\n';
  await fs.writeFile(path.join(source, 'recorded.txt'), recorded);
  stock('new', '-m', 'live workspace');
  stock('bookmark', 'create', 'native-smoke', '-r', '@-');
  const commit = stock('log', '--no-graph', '-r', 'native-smoke', '-T', 'commit_id').trim();
  await fs.writeFile(path.join(source, 'recorded.txt'), live);
  await fs.writeFile(path.join(source, 'pending.txt'), pending);
  const before = await sourceTree(source);
  const read = (...args) => JSON.parse(run(helper, ['--no-pager', '--color=never',
    '--max-object-allocation-bytes', '16777216', '--max-input-bytes', '16777216',
    '--max-conflict-scratch-bytes', '16777216', ...args]));
  const version = read('source-version');
  verifySourceVersion(version);
  const context = read('source-context');
  const inventory = read('--at-op', context.operation_heads[0], 'source-recorded-inventory', '--revision', 'native-smoke');
  assert.equal(inventory.identity.commit, commit);
  assert.deepEqual(inventory.entries.map((item) => item.path), ['recorded.txt']);
  const liveInventory = read('--at-op', context.operation_heads[0], 'source-live-inventory');
  assert.equal(liveInventory.identity.operation, context.operation_heads[0]);
  const selected = path.join(output, 'selected.json');
  await fs.writeFile(selected, JSON.stringify({ protocol: 'crabbox-jj-source', schema_version: 1,
    identity: inventory.identity, paths: ['recorded.txt'] }));
  const payload = path.join(output, 'payload');
  const checkout = path.join(output, 'checkout');
  await fs.mkdir(payload);
  await fs.mkdir(checkout);
  const exported = read('--at-op', inventory.identity.operation, 'source-recorded-export',
    '--selected', selected, '--output', payload, '--state', checkout,
    '--max-entry-bytes', '1048576', '--max-output-bytes', '1048576');
  assert.deepEqual(exported.identity, inventory.identity);
  assert.deepEqual(await fs.readdir(payload), ['recorded.txt']);
  assert.equal(await fs.readFile(path.join(payload, 'recorded.txt'), 'utf8'), recorded);
  const cliConfig = path.join(output, 'crabbox.json');
  await fs.writeFile(cliConfig, JSON.stringify({ provider: 'ssh', target: 'linux',
    sync: { source: 'jj', include: ['recorded.txt', 'pending.txt'] }, results: { auto: false } }));
  env.CRABBOX_CONFIG = cliConfig;
  const plan = (revision) => JSON.parse(run(crabbox, ['sync-plan', '--sync-source', 'jj',
    '--sync-revision', revision, '--json']));
  const recordedPlan = plan('native-smoke');
  assert.equal(recordedPlan.jujutsu.recordedCommit, commit);
  assert.equal(recordedPlan.candidate.files, 1);
  assert.equal(recordedPlan.candidate.bytes, Buffer.byteLength(recorded));
  const livePlan = plan('');
  assert.equal(livePlan.candidate.files, 2);
  assert.equal(livePlan.candidate.bytes, Buffer.byteLength(live + pending));
  assert.notEqual(recordedPlan.jujutsu.contentSha256, livePlan.jujutsu.contentSha256);
  const after = await sourceTree(source);
  assert.deepEqual(after, before, 'native source or administration files changed during reads');
  const receipt = { schemaVersion: 1, scope: 'Native ordinary-file read/export and installed CLI smoke; not full platform or release acceptance.',
    node: process.version, platform: process.platform, architecture: process.arch, jjVersion,
    cliSHA256: await fileSHA256(crabbox), helper: pair,
    sourceUnchanged: true, recordedExportMatchesFixture: true,
    recordedPlan, livePlan, exportCapabilities: exported.capabilities };
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { jj: { type: 'string' }, crabbox: { type: 'string' }, output: { type: 'string' } } });
    if (!values.jj || !values.crabbox || !values.output) throw new Error('usage: smoke.mjs --jj STOCK_JJ --crabbox INSTALLED_CLI --output NEW_DIRECTORY');
    process.stdout.write(JSON.stringify(await smoke(values), null, 2) + '\n');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
