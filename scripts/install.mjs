import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ID, REPOSITORY, verifyInstalledPayload, verifyRelease } from './release-lib.mjs';
import { inspectInstallation, installCommands, isolatedEnvironment, normalizeMarketplaces, normalizePlugins,
  failureRecovery, parseArgs, parseClaudeMissingMcp, reviewPlan, selectCli } from './install-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let lock;
let cliEnvironment = process.env;
let cliWorkingDirectory;
let stage = 'arguments';
let target;
const attemptedCommands = [];
const completedCommands = [];
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
  } else {
    // Even read-only native CLI commands may create their own tmp directory.
    // Mark an explicitly isolated, initially empty test profile before invoking
    // them so a following --apply can safely recognize it. Never mark a normal
    // user profile or anything that failed release/profile validation.
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return isolatedEnvironment(options.client, profile);
}

async function install() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required; it will not be installed automatically');
  const options = parseArgs(process.argv.slice(2));
  stage = 'release_verification';
  const release = await verifyCheckout(options.commit);
  target = { client: options.client, commit: options.commit, version: release.version,
    artifactSetSha256: release.artifactSetSha256, directory: root };
  stage = 'profile_validation';
  if (options['profile-dir']) cliEnvironment = await prepareProfile(options);
  // Client management is user-scoped. Never let it discover Project configuration
  // from the distribution checkout or the caller's working-directory ancestry.
  cliWorkingDirectory = await realpath(await mkdtemp(join(tmpdir(), 'combo-public-test-cli-')));
  const cli = selectCli(options.client, options.cli);
  stage = 'cli_inventory';
  const cliVersion = run(cli, ['--version']).stdout.trim();
  let state = inventory(options.client, cli);
  let installedPath = state.installedPath;
  let cache;
  async function verifyState() {
    cache = undefined;
    if (state.alreadyInstalled || (state.status === 'disabled_preserved' && state.installedPath)) {
      stage = 'installed_cache_verification';
      cache = await verifyInstalledPayload(release, options.client, state.installedPath);
    }
    if (state.issues.length) {
      console.log(JSON.stringify({ status: state.status, client: options.client, cliVersion,
        reviewPlan: reviewPlan({ client: options.client, root, commit: options.commit, release, state, cache }),
        commands: [], hostToolLoad: 'not_verified', modelExtraction: 'not_run', upload: 'not_requested',
        recovery: failureRecovery({ stage: 'installation_review', attemptedCommands, completedCommands }) }, null, 2));
      process.exitCode = 2;
      return false;
    }
    return true;
  }
  if (!await verifyState()) return;
  let commands = installCommands(options.client, root, state);
  let didInstall = false;
  if (options.apply && commands.length) {
    stage = 'installation_lock';
    lock = `${root}.install-${options.client}.lock`;
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { lock = undefined; throw new Error('Another installation or an unfinished install lock exists; inspect it before retrying'); }
    stage = 'release_revalidation';
    await verifyCheckout(options.commit);
    stage = 'inventory_revalidation';
    state = inventory(options.client, cli);
    if (!await verifyState()) return;
    commands = installCommands(options.client, root, state);
    for (const command of commands) {
      // Marketplace registration and plugin installation are not one atomic CLI
      // operation. Preserve an intervening install/disable/collision as well.
      stage = 'before_mutation_inventory';
      state = inventory(options.client, cli);
      if (!await verifyState()) return;
      if (state.alreadyInstalled) {
        installedPath = state.installedPath;
        break;
      }
      if (command[1] === 'marketplace' && state.marketplacePresent) continue;
      if (command[1] !== 'marketplace' && !state.marketplacePresent) {
        throw new Error('Target marketplace disappeared or was not registered; plugin installation was not attempted. Reinspect the fixed source before retrying.');
      }
      stage = command[1] === 'marketplace' ? 'marketplace_add' : 'plugin_install';
      attemptedCommands.push({ executable: cli, args: command });
      const result = run(cli, command);
      completedCommands.push({ executable: cli, args: command });
      if (options.client === 'codex' && command[1] === 'add') {
        let installed;
        try { installed = JSON.parse(result.stdout); } catch { throw new Error('Invalid Codex installation result'); }
        if (installed.pluginId !== PLUGIN_ID || typeof installed.installedPath !== 'string') {
          throw new Error('Codex did not return the expected plugin cache path');
        }
        installedPath = installed.installedPath;
      }
      if (command[1] === 'add' || command[1] === 'install') didInstall = true;
    }
    stage = 'post_install_inventory';
    state = inventory(options.client, cli);
    if (!await verifyState()) return;
    if (!state.alreadyInstalled) throw new Error('Client did not report the expected installed version; host loading is unverified');
    if (!state.installedPath) throw new Error('Current client inventory cannot locate the actual installed cache; readiness remains unverified');
    if (installedPath && state.installedPath && resolve(installedPath) !== resolve(state.installedPath)) {
      throw new Error('CLI installation result and active MCP cache path disagree');
    }
    installedPath ??= state.installedPath;
    // verifyState above checks the current authoritative cache even if another
    // installer completed between preflight and the lock recheck.
  }
  console.log(JSON.stringify({ status: didInstall ? 'installed' : state.alreadyInstalled ? 'already_installed' : 'ready_to_install',
    client: options.client, cliVersion, commit: options.commit, version: release.version,
    artifactSetSha256: release.artifactSetSha256,
    installedCache: cache ?? 'not_installed',
    commands: options.apply ? [] : commands.map((args) => ({ executable: cli, args })),
    hostToolLoad: 'not_verified', modelExtraction: 'not_run', upload: 'not_requested',
    localCompiler: resolve(root, 'plugins', options.client === 'codex' ? 'combo' : 'combo-claude', 'bin/combo-context.mjs'),
    next: cache ? 'Check tools actually available in this task. If the new tools are unavailable, use this exact local compiler only when the current conversation already contains a reusable method; otherwise report readiness and continue extraction in the original conversation. Do not scan history or Projects.'
      : 'This is a plan only. Apply the verified fresh installation before extraction; --apply does not authorize migration of existing registrations.' }, null, 2));
}

try {
  await install();
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', ...(target ? { target } : {}), error: error.message,
    recovery: failureRecovery({ stage, attemptedCommands, completedCommands }),
    hostToolLoad: 'not_verified', modelExtraction: 'not_run', upload: 'not_requested' }, null, 2));
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (lock) await rmdir(lock);
  if (cliWorkingDirectory) {
    try { await rmdir(cliWorkingDirectory); }
    catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
  }
}
