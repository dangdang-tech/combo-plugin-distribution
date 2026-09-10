import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectInstallation, installCommands, isolatedEnvironment, normalizeMarketplaces,
  normalizePlugins, parseArgs, parseClaudeMissingMcp, selectCli } from '../scripts/install-lib.mjs';
import { hash, MARKETPLACE, PLUGIN_ID, TEST_ORIGIN, VERSION } from '../scripts/release-lib.mjs';
import { commitFixture, fixture, git, write } from './fixtures.mjs';

const root = '/tmp/reviewed-distribution';
const empty = { client: 'codex', root, plugins: [], marketplaces: [], mcpNames: [] };
function exact(client = 'codex') {
  return { client, root, plugins: [{ id: PLUGIN_ID, name: 'combo', marketplace: MARKETPLACE,
    version: VERSION, enabled: true, scope: 'user', installPath: '/tmp/cache',
    source: { source: 'local', path: `${root}/plugins/combo` },
    marketplaceSource: { sourceType: 'local', source: root } }],
    marketplaces: [client === 'codex'
      ? { name: MARKETPLACE, marketplaceSource: { sourceType: 'local', source: root } }
      : { name: MARKETPLACE, source: 'directory', path: root }], mcpNames: [] };
}

test('full public SHA and explicit client are required; shell-looking values are rejected', () => {
  assert.deepEqual(parseArgs(['--client', 'codex', '--commit', 'a'.repeat(40), '--apply']),
    { apply: true, client: 'codex', commit: 'a'.repeat(40) });
  for (const args of [[], ['--client', 'codex', '--commit', 'main'],
    ['--client', 'codex', '--commit', 'a'.repeat(40), '--cli', 'codex; echo nope'],
    ['--client', 'claude', '--commit', 'a'.repeat(40), '--apply', '--apply']]) assert.throws(() => parseArgs(args));
});

test('prefer host-provided CLI and isolate only child environment without credentials', () => {
  const env = { PATH: '/bin', HOME: '/Users/example', CODEX_CLI_PATH: '/app/codex',
    OPENAI_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-only', CODEX_HOME: '/actual/config' };
  assert.equal(selectCli('codex', undefined, { env, exists: () => true }), '/app/codex');
  assert.equal(selectCli('codex', '/explicit/codex'), '/explicit/codex');
  const child = isolatedEnvironment('codex', '/tmp/combo-public-test-profile', env);
  assert.equal(child.CODEX_HOME, '/tmp/combo-public-test-profile');
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, '/actual/config');
  assert.equal(child.HOME, env.HOME);
});

test('unknown plugin or marketplace JSON fails closed', () => {
  assert.throws(() => normalizePlugins('codex', []), /Unsupported/);
  assert.throws(() => normalizePlugins('claude', [{}]), /identity/);
  assert.throws(() => normalizeMarketplaces('codex', {}), /Unsupported/);
  assert.equal(normalizePlugins('claude', [{ id: 'figma@official' }])[0].name, 'figma');
});

test('disabled old Combo, preview variants, standalone MCP and foreign source are conflicts', () => {
  for (const name of ['combo', 'combo-context-preview', 'combo_preview']) {
    assert.throws(() => inspectInstallation({ ...empty,
      plugins: [{ name, id: `${name}@old-market`, enabled: false }] }), /source conflicts/);
  }
  assert.throws(() => inspectInstallation({ ...empty, mcpNames: ['combo_context_preview'] }), /MCP conflicts/);
  const changed = exact();
  changed.marketplaces[0].marketplaceSource.source = '/tmp/different-commit';
  assert.throws(() => inspectInstallation(changed), /different or unknown source/);
  const disabled = exact(); disabled.plugins[0].enabled = false;
  assert.throws(() => inspectInstallation(disabled), /disabled state/);
  const wrongVersion = exact(); wrongVersion.plugins[0].version = '0.1.0';
  assert.throws(() => inspectInstallation(wrongVersion), /different version/);
});

test('matching public source is idempotent and its namespaced Claude MCP is recognized', () => {
  assert.deepEqual(installCommands('codex', root, inspectInstallation(exact())), []);
  const claude = exact('claude'); claude.mcpNames = ['plugin:combo:combo'];
  assert.equal(inspectInstallation(claude).alreadyInstalled, true);
  claude.mcpNames.push('combo');
  assert.throws(() => inspectInstallation(claude), /MCP conflicts/);
  assert.deepEqual(installCommands('claude', root, inspectInstallation({ ...empty, client: 'claude' })), [
    ['plugin', 'marketplace', 'add', root, '--scope', 'user'],
    ['plugin', 'install', PLUGIN_ID, '--scope', 'user'],
  ]);
});

test('Codex short-name MCP is exempted only for the observed exact cached transport', () => {
  const state = exact();
  const path = `/tmp/profile/plugins/cache/${MARKETPLACE}/combo/${VERSION}`;
  state.mcpNames = ['combo'];
  state.codexMcp = [{ name: 'combo', enabled: true, transport: { type: 'stdio', command: 'node',
    args: ['./bin/combo-mcp.mjs'], cwd: `${path}/.`,
    env: { COMBO_CONTEXT_CLIENT: 'codex', COMBO_CONTEXT_CLOUD_ORIGIN: TEST_ORIGIN }, env_vars: [] } }];
  assert.equal(inspectInstallation(state).installedPath, path);
  state.codexMcp[0].transport.cwd = '/tmp/other-plugin';
  assert.throws(() => inspectInstallation(state), /MCP conflicts/);
});

test('Claude absence parser accepts both observed forms but rejects unknown failures', () => {
  assert.deepEqual(parseClaudeMissingMcp({ status: 1,
    stderr: 'No MCP server named "combo". Run `claude mcp add` to add one.\n' }), []);
  assert.deepEqual(parseClaudeMissingMcp({ status: 1,
    stderr: 'No MCP server found with name: "combo". Configured servers: figma, plugin:combo:combo\n' }),
  ['figma', 'plugin:combo:combo']);
  assert.deepEqual(parseClaudeMissingMcp({ status: 1,
    stderr: 'No MCP server named "combo". Configured servers: plugin:combo:combo\n' }), ['plugin:combo:combo']);
  assert.throws(() => parseClaudeMissingMcp({ status: 1, stderr: 'Configuration could not be read' }), /Unable/);
  assert.deepEqual(parseClaudeMissingMcp({ status: 0, stdout: 'not printed' }), ['combo']);
});

// A synthetic executable exercises the installer process boundary. These tests do not
// claim that the real Codex or Claude host loaded or executed a released plugin.
async function installerFixture(t, mode = 'normal') {
  const value = await fixture(t, { support: true });
  const commit = commitFixture(value.root);
  const cli = join(value.temporaryRoot, 'fixture-cli.mjs');
  await writeFile(cli, `#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = ${JSON.stringify(mode)};
const profile = process.env.CODEX_HOME ?? process.env.CLAUDE_CONFIG_DIR;
const client = process.env.CODEX_HOME ? 'codex' : 'claude';
const args = process.argv.slice(2);
if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) process.exit(9);
const statePath = join(profile, 'fixture-state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { calls: [] };
state.calls.push(args);
const save = () => writeFileSync(statePath, JSON.stringify(state));
const out = (v) => process.stdout.write(JSON.stringify(v));
if (args[0] === '--version') { save(); console.log('synthetic-cli 0.0.0'); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') { state.source = args[3]; save(); out({}); process.exit(0); }
if (args[0] === 'plugin' && ['add', 'install'].includes(args[1])) {
  if (mode === 'fail-once' && !state.failedOnce) { state.failedOnce = true; save(); process.stderr.write('sensitive-fixture-output'); process.exit(4); }
  state.installed = true; state.path = join(profile, 'plugins/cache', ${JSON.stringify(MARKETPLACE)}, 'combo', ${JSON.stringify(VERSION)});
  mkdirSync(state.path, { recursive: true });
  cpSync(join(state.source, 'plugins', client === 'codex' ? 'combo' : 'combo-claude'), state.path, { recursive: true });
  save(); out({ pluginId: ${JSON.stringify(PLUGIN_ID)}, ...(mode === 'no-path' ? {} : { installedPath: state.path }) }); process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  let plugins = state.installed ? [{ pluginId: ${JSON.stringify(PLUGIN_ID)}, id: ${JSON.stringify(PLUGIN_ID)}, name: 'combo',
    marketplaceName: ${JSON.stringify(MARKETPLACE)}, version: ${JSON.stringify(VERSION)}, enabled: true, installed: true, scope: 'user',
    ...(client === 'claude' ? { installPath: state.path } : {}), source: { source: 'local', path: join(state.source, 'plugins/combo') },
    marketplaceSource: { sourceType: 'local', source: state.source } }] : [];
  if (mode === 'old-combo') plugins = [{ pluginId: 'combo@old', id: 'combo@old', name: 'combo', marketplaceName: 'old', version: '0.1.0', enabled: false }];
  save(); out(mode === 'unknown-json' ? {} : client === 'codex' ? { installed: plugins } : plugins); process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list') {
  const markets = state.source ? [{ name: ${JSON.stringify(MARKETPLACE)}, marketplaceSource: { sourceType: 'local', source: state.source },
    source: 'directory', path: state.source, installLocation: state.source }] : [];
  save(); out(client === 'codex' ? { marketplaces: markets } : markets); process.exit(0);
}
if (args[0] === 'mcp') {
  save(); if (client === 'codex') {
    out(state.installed && mode !== 'no-authoritative-path' ? [{ name: 'combo', enabled: true,
      transport: { type: 'stdio', command: 'node', args: ['./bin/combo-mcp.mjs'], cwd: state.path,
        env: { COMBO_CONTEXT_CLIENT: 'codex', COMBO_CONTEXT_CLOUD_ORIGIN: ${JSON.stringify(TEST_ORIGIN)} }, env_vars: [] } }] : []);
    process.exit(0);
  }
  process.stderr.write(state.installed ? 'No MCP server found with name: "combo". Configured servers: plugin:combo:combo\\n'
    : 'No MCP server named "combo". Run \\x60claude mcp add\\x60 to add one.\\n'); process.exit(1);
}
save(); process.exit(5);
`);
  await chmod(cli, 0o700);
  async function profile(client) { const path = join(value.temporaryRoot, client); await mkdir(path); return path; }
  function run(client, profilePath, args = [], commitValue = commit) {
    return spawnSync(process.execPath, [join(value.root, 'scripts/install.mjs'), '--client', client,
      '--commit', commitValue, '--cli', cli, '--profile-dir', profilePath, '--apply', ...args], {
      cwd: value.temporaryRoot, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, OPENAI_API_KEY: 'fixture-not-a-real-secret', ANTHROPIC_API_KEY: 'fixture-not-a-real-secret' },
    });
  }
  return { ...value, commit, cli, profile, run };
}

test('installer verifies installed bytes and repeats without another install for both clients', async (t) => {
  const f = await installerFixture(t);
  for (const client of ['codex', 'claude']) {
    const profile = await f.profile(client);
    const first = f.run(client, profile);
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.status, 'installed');
    assert.equal(result.hostToolLoad, 'not_verified');
    assert.equal(result.modelExtraction, 'not_run');
    assert.equal(result.installedCache.files, client === 'codex' ? 14 : 12);
    const second = f.run(client, profile);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).status, 'already_installed');
    const state = JSON.parse(await readFile(join(profile, 'fixture-state.json'), 'utf8'));
    assert.equal(state.calls.filter((args) => args[0] === 'plugin' && ['add', 'install'].includes(args[1])).length, 1);
  }
  assert.equal(git(f.root, ['status', '--porcelain']), '');
});

test('installed cache tampering stops repeated install without repair or readiness claim', async (t) => {
  const f = await installerFixture(t);
  const profile = await f.profile('codex');
  const first = f.run('codex', profile);
  assert.equal(first.status, 0, first.stderr);
  await writeFile(join(JSON.parse(first.stdout).installedCache.installedPath, 'bin/combo-mcp.mjs'), 'tampered');
  const second = f.run('codex', profile);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /cache digest mismatch/);
  assert.equal(second.stdout, '');
});

test('wrong SHA, dirty checkout and unrecognized profile stop before CLI mutations', async (t) => {
  const f = await installerFixture(t);
  const profile = await f.profile('codex');
  const wrong = f.run('codex', profile, [], 'b'.repeat(40));
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /does not match the requested/);
  await write(f.root, 'README.md', 'uncommitted');
  const dirty = f.run('codex', profile);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /checkout has changes/);
  const profileEntries = await readdir(profile);
  assert.equal(profileEntries.includes('fixture-state.json'), false);
});

test('foreign source and unsupported inventory never invoke marketplace or plugin add', async (t) => {
  for (const mode of ['old-combo', 'unknown-json']) {
    const f = await installerFixture(t, mode);
    const profile = await f.profile('codex');
    const result = f.run('codex', profile);
    assert.equal(result.status, 1);
    const state = JSON.parse(await readFile(join(profile, 'fixture-state.json'), 'utf8'));
    assert.equal(state.calls.some((args) => args.includes('add') || args.includes('install')), false);
  }
});

test('install failure preserves marketplace and retries only the unfinished install', async (t) => {
  const f = await installerFixture(t, 'fail-once');
  const profile = await f.profile('codex');
  const first = f.run('codex', profile);
  assert.equal(first.status, 1);
  assert.equal(first.stderr.includes('sensitive-fixture-output'), false);
  const second = f.run('codex', profile);
  assert.equal(second.status, 0, second.stderr);
  const state = JSON.parse(await readFile(join(profile, 'fixture-state.json'), 'utf8'));
  assert.equal(state.calls.filter((args) => args[1] === 'marketplace' && args[2] === 'add').length, 1);
  assert.equal(state.calls.filter((args) => args[1] === 'add').length, 2);
});

test('missing authoritative cache path fails and receipts cannot substitute the source directory', async (t) => {
  const missing = await installerFixture(t, 'no-path');
  const missingProfile = await missing.profile('codex');
  const failure = missing.run('codex', missingProfile);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /expected plugin cache path/);
  const retry = missing.run('codex', missingProfile);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).status, 'already_installed');

  const noAuthority = await installerFixture(t, 'no-authoritative-path');
  const noAuthorityProfile = await noAuthority.profile('codex');
  assert.match(noAuthority.run('codex', noAuthorityProfile).stderr, /cannot locate the actual installed cache/);
  const unlocatedState = JSON.parse(await readFile(join(noAuthorityProfile, 'fixture-state.json'), 'utf8'));
  await writeFile(join(unlocatedState.path, 'bin/combo-context.mjs'), 'tampered actual cache');
  const forgedDirectory = `${noAuthority.root}.install-receipts`;
  await mkdir(forgedDirectory);
  await writeFile(join(forgedDirectory, `codex-${hash(noAuthorityProfile).slice(0, 16)}.json`), JSON.stringify({
    schema: 'combo-install-cache-receipt/1', client: 'codex', commit: noAuthority.commit,
    artifactSetSha256: noAuthority.release.artifactSetSha256, installedPath: join(noAuthority.root, 'plugins/combo'),
  }));
  assert.match(noAuthority.run('codex', noAuthorityProfile).stderr, /verifiable, non-symlink installed cache/);

  const f = await installerFixture(t);
  const profile = await f.profile('codex');
  const first = f.run('codex', profile);
  assert.equal(first.status, 0);
  const installed = JSON.parse(first.stdout).installedCache.installedPath;
  await writeFile(join(installed, 'bin/combo-context.mjs'), 'tampered installed bytes');
  const directory = `${f.root}.install-receipts`;
  await mkdir(directory);
  const receiptPath = join(directory, 'forged.json');
  await writeFile(receiptPath, JSON.stringify({ schema: 'combo-install-cache-receipt/1', client: 'codex',
    commit: f.commit, artifactSetSha256: f.release.artifactSetSha256,
    installedPath: join(f.root, 'plugins/combo') }));
  assert.match(f.run('codex', profile).stderr, /cache digest mismatch/);
  await symlink(join(f.root, 'plugins/combo'), join(directory, 'forged-cache'));
  assert.match(f.run('codex', profile).stderr, /cache digest mismatch/);
});

test('existing install lock prevents writes and is never removed by another installer', async (t) => {
  const f = await installerFixture(t);
  const profile = await f.profile('codex');
  await mkdir(`${f.root}.install-codex.lock`);
  const result = f.run('codex', profile);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unfinished install lock/);
  assert.deepEqual(await readdir(`${f.root}.install-codex.lock`), []);
  const state = JSON.parse(await readFile(join(profile, 'fixture-state.json'), 'utf8'));
  assert.equal(state.calls.some((args) => args.includes('add') || args.includes('install')), false);
});
