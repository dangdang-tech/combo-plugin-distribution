import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ID, REPOSITORY, verifyInstalledPayload, verifyRelease } from './release-lib.mjs';
import { inspectInstallation, installCommands, isolatedEnvironment, normalizeMarketplaces, normalizePlugins,
  parseArgs, parseClaudeMissingMcp, selectCli } from './install-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let lock;
let cliEnvironment = process.env;
let cliWorkingDirectory;
function run(bin, args, { allowFailure = false } = {}) {
  const result = spawnSync(bin, args, { cwd: bin === 'git' ? root : cliWorkingDirectory,
    encoding: 'utf8', timeout: 120000,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: cliEnvironment });
  if (!allowFailure && (result.error || result.status !== 0)) {
    // MCP inventory may contain secrets. Never copy child output into an error.
    throw new Error(`${bin} ${args.slice(0, 3).join(' ')} failed (${result.error?.code ?? result.status}). Check the matching host CLI; no runtime or user configuration was repaired.`);
  }
  return result;
}

function json(bin, args) {
  try { return JSON.parse(run(bin, args).stdout); }
  catch { throw new Error(`Could not read ${args.slice(0, 3).join(' ')} JSON; installation stopped`); }
}

async function verifyCheckout(commit) {
  if (await realpath(root) !== root) throw new Error('Distribution directory must not use a symlink');
  const head = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  if (head !== commit) throw new Error('Checkout does not match the requested full public commit SHA');
  const remote = run('git', ['remote', 'get-url', 'origin']).stdout.trim();
  if (remote !== REPOSITORY) throw new Error('Checkout origin is not the expected public distribution repository');
  if (run('git', ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()) {
    throw new Error('Distribution checkout has changes; preserve it and use a new clean checkout');
  }
  return verifyRelease(root);
}

function inventory(client, cli) {
  const plugins = normalizePlugins(client, json(cli, ['plugin', 'list', '--json']));
  const marketplaces = normalizeMarketplaces(client, json(cli, ['plugin', 'marketplace', 'list', '--json']));
  let mcpNames;
  let codexMcp;
  if (client === 'codex') {
    const mcp = json(cli, ['mcp', 'list', '--json']);
    if (!Array.isArray(mcp)) throw new Error('Unsupported Codex MCP inventory');
    codexMcp = mcp;
    mcpNames = mcp.map((item) => item.name);
  } else {
    // `mcp list` health-checks servers. `get` only reads one named configuration.
    mcpNames = parseClaudeMissingMcp(run(cli, ['mcp', 'get', 'combo'], { allowFailure: true }));
  }
  return inspectInstallation({ client, plugins, marketplaces, mcpNames, codexMcp, root });
}

async function readSmallJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 8192 || await realpath(path) !== path) throw new Error('Invalid local receipt file');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function prepareProfile(options) {
  const profile = options['profile-dir'];
  if (profile === process.env.HOME || profile === process.env.CODEX_HOME || profile === process.env.CLAUDE_CONFIG_DIR
    || !/(?:^|\/)combo-public-test-[A-Za-z0-9_-]+(?:\/(?:codex|claude))?$/.test(profile)
    || !(await lstat(profile)).isDirectory() || await realpath(profile) !== profile) {
    throw new Error('Test profile must be an existing isolated combo-public-test-* directory from mktemp');
  }
  const markerPath = resolve(profile, 'combo-distribution-test-profile.json');
  const marker = { schema: 'combo-distribution-isolated-profile/1', client: options.client, directory: profile };
  const entries = await readdir(profile);
  if (entries.length > 0) {
    let existing;
    try { existing = await readSmallJson(markerPath); }
    catch { throw new Error('Test profile is not empty and has no matching isolation marker; it was not modified'); }
    if (JSON.stringify(existing) !== JSON.stringify(marker)) throw new Error('Test profile belongs to a different client or directory');
  } else if (options.apply) await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 });
  return isolatedEnvironment(options.client, profile);
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required; it will not be installed automatically');
  const options = parseArgs(process.argv.slice(2));
  if (options['profile-dir']) cliEnvironment = await prepareProfile(options);
  const release = await verifyCheckout(options.commit);
  // Client management is user-scoped. Never let it discover Project configuration
  // from the distribution checkout or the caller's working-directory ancestry.
  cliWorkingDirectory = await realpath(await mkdtemp(join(tmpdir(), 'combo-public-test-cli-')));
  const cli = selectCli(options.client, options.cli);
  const cliVersion = run(cli, ['--version']).stdout.trim();
  let state = inventory(options.client, cli);
  const wasInstalled = state.alreadyInstalled;
  let installedPath = state.installedPath;
  let cache;
  if (state.alreadyInstalled) cache = await verifyInstalledPayload(release, options.client, installedPath);
  let commands = installCommands(options.client, root, state);
  if (options.apply && commands.length) {
    lock = `${root}.install-${options.client}.lock`;
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { lock = undefined; throw new Error('Another installation or an unfinished install lock exists; inspect it before retrying'); }
    await verifyCheckout(options.commit);
    state = inventory(options.client, cli);
    commands = installCommands(options.client, root, state);
    for (const command of commands) {
      const result = run(cli, command);
      if (options.client === 'codex' && command[1] === 'add') {
        let installed;
        try { installed = JSON.parse(result.stdout); } catch { throw new Error('Invalid Codex installation result'); }
        if (installed.pluginId !== PLUGIN_ID || typeof installed.installedPath !== 'string') {
          throw new Error('Codex did not return the expected plugin cache path');
        }
        installedPath = installed.installedPath;
      }
    }
    state = inventory(options.client, cli);
    if (!state.alreadyInstalled) throw new Error('Client did not report the expected installed version; host loading is unverified');
    if (!state.installedPath) throw new Error('Current client inventory cannot locate the actual installed cache; readiness remains unverified');
    if (installedPath && state.installedPath && resolve(installedPath) !== resolve(state.installedPath)) {
      throw new Error('CLI installation result and active MCP cache path disagree');
    }
    installedPath ??= state.installedPath;
    cache = await verifyInstalledPayload(release, options.client, installedPath);
  }
  console.log(JSON.stringify({ status: wasInstalled ? 'already_installed' : options.apply ? 'installed' : 'ready_to_install',
    client: options.client, cliVersion, commit: options.commit, version: release.version,
    artifactSetSha256: release.artifactSetSha256,
    installedCache: cache ?? 'not_installed',
    commands: options.apply ? [] : commands.map((args) => ({ executable: cli, args })),
    hostToolLoad: 'not_verified', modelExtraction: 'not_run', upload: 'not_requested',
    localCompiler: resolve(root, 'plugins', options.client === 'codex' ? 'combo' : 'combo-claude', 'bin/combo-context.mjs'),
    next: 'Use the current host context. If the new MCP tools are unavailable, use this exact local compiler with the synthesized method on stdin; do not scan conversations or Projects.' }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (lock) await rmdir(lock);
  if (cliWorkingDirectory) {
    try { await rmdir(cliWorkingDirectory); }
    catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
  }
}
