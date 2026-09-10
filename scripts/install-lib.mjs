import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { MARKETPLACE, PLUGIN_ID, SHA, TEST_ORIGIN, VERSION } from './release-lib.mjs';

export function parseArgs(args) {
  const options = { apply: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') {
      if (options.apply) throw new Error('Duplicate --apply');
      options.apply = true;
    } else if (['--client', '--commit', '--cli', '--profile-dir'].includes(arg)) {
      const key = arg.slice(2);
      if (options[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid ${arg}`);
      options[key] = args[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['codex', 'claude'].includes(options.client) || !SHA.test(options.commit ?? '')) {
    throw new Error('Usage: node scripts/install.mjs --client codex|claude --commit <full public SHA> [--cli <absolute path>] [--profile-dir <isolated directory>] [--apply]');
  }
  if (options.cli && !isAbsolute(options.cli)) throw new Error('--cli must be an absolute executable path');
  if (options['profile-dir'] && !isAbsolute(options['profile-dir'])) throw new Error('--profile-dir must be absolute');
  return options;
}

export function isolatedEnvironment(client, profile, env = process.env) {
  const safeKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot'];
  const safe = Object.fromEntries(safeKeys.filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]]));
  safe[client === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = profile;
  return safe;
}

export function selectCli(client, explicit, { platform = process.platform, env = process.env,
  exists = existsSync } = {}) {
  if (explicit) return explicit;
  if (client === 'codex') {
    if (env.CODEX_CLI_PATH && isAbsolute(env.CODEX_CLI_PATH) && exists(env.CODEX_CLI_PATH)) return env.CODEX_CLI_PATH;
    const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
    if (platform === 'darwin' && exists(bundled)) return bundled;
  }
  return client;
}

export function normalizePlugins(client, value) {
  const items = client === 'codex' ? value?.installed : value;
  if (!Array.isArray(items)) throw new Error('Unsupported installed-plugin inventory; installation stopped');
  return items.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid plugin inventory');
    const id = client === 'codex' ? item.pluginId : item.id;
    const name = client === 'codex' ? item.name : id?.split('@')[0];
    const marketplace = client === 'codex' ? item.marketplaceName : id?.split('@')[1];
    if (typeof name !== 'string' || typeof id !== 'string') throw new Error('Invalid plugin inventory identity');
    return { ...item, id, name, marketplace };
  });
}

export function normalizeMarketplaces(client, value) {
  const items = client === 'codex' ? value?.marketplaces : value;
  if (!Array.isArray(items) || items.some((item) => !item || typeof item.name !== 'string')) {
    throw new Error('Unsupported marketplace inventory; installation stopped');
  }
  return items;
}

const comboName = (name) => typeof name === 'string' && /(?:^|:)combo(?:$|[-_:])/.test(name);

export function inspectInstallation({ client, plugins, marketplaces, mcpNames, codexMcp = [], root }) {
  if (!Array.isArray(mcpNames) || mcpNames.some((name) => typeof name !== 'string')) {
    throw new Error('Unsupported MCP inventory; installation stopped');
  }
  const exact = plugins.filter((plugin) => plugin.id === PLUGIN_ID);
  const conflicting = plugins.filter((plugin) =>
    (comboName(plugin.name) && plugin.id !== PLUGIN_ID)
    || (plugin.id !== PLUGIN_ID && Object.keys(plugin.mcpServers ?? {}).some(comboName)));
  if (conflicting.length) {
    throw new Error(`Existing Combo source conflicts: ${conflicting.map((plugin) => plugin.id).join(', ')}. Nothing was replaced or removed.`);
  }
  if (exact.length > 1) throw new Error('Combo is installed in multiple scopes; choose one explicitly before continuing');
  const matchingMarkets = marketplaces.filter((market) => market.name === MARKETPLACE);
  if (matchingMarkets.length > 1) throw new Error('Ambiguous public marketplace configuration');
  const market = matchingMarkets[0];
  if (market) {
    const source = client === 'codex' ? market.marketplaceSource : market;
    const type = client === 'codex' ? source?.sourceType : source?.source;
    const path = client === 'codex' ? source?.source : source?.path;
    if (!['local', 'directory'].includes(type) || typeof path !== 'string'
      || !isAbsolute(path) || resolve(path) !== resolve(root)) {
      throw new Error('Public marketplace already points to a different or unknown source; installation stopped');
    }
  }
  if (exact.length && (!market || exact[0].version !== VERSION || exact[0].enabled !== true)) {
    throw new Error('Existing public Combo has a different version, source or disabled state; installation stopped');
  }
  if (client === 'codex' && exact.length && (exact[0].name !== 'combo' || exact[0].marketplace !== MARKETPLACE
    || exact[0].source?.source !== 'local' || exact[0].source?.path !== resolve(root, 'plugins/combo')
    || exact[0].marketplaceSource?.sourceType !== 'local' || exact[0].marketplaceSource?.source !== root)) {
    throw new Error('Installed Combo source metadata does not match the fixed distribution directory');
  }
  if (client === 'claude' && exact.length && exact[0].scope !== 'user') {
    throw new Error('Existing Combo is installed outside user scope; choose the intended scope explicitly');
  }
  // Codex reports plugin MCPs under their short name. Its observed transport
  // provides the cache location; name alone never grants a collision exemption.
  const ownCodexMcp = client === 'codex' && exact.length === 1 ? codexMcp.find((server) => {
    const transport = server.transport;
    return server.name === 'combo' && server.enabled === true && transport?.type === 'stdio'
      && transport.command === 'node' && JSON.stringify(transport.args) === '["./bin/combo-mcp.mjs"]'
      && typeof transport.cwd === 'string' && isAbsolute(transport.cwd)
      && resolve(transport.cwd).endsWith(`/plugins/cache/${MARKETPLACE}/combo/${VERSION}`)
      && transport.env?.COMBO_CONTEXT_CLIENT === 'codex'
      && transport.env?.COMBO_CONTEXT_CLOUD_ORIGIN === TEST_ORIGIN
      && Object.keys(transport.env).length === 2 && Array.isArray(transport.env_vars) && transport.env_vars.length === 0;
  }) : undefined;
  const foreignMcp = mcpNames.filter((name) => comboName(name)
    && !(client === 'claude' && exact.length === 1 && name === 'plugin:combo:combo')
    && !(name === 'combo' && ownCodexMcp));
  if (foreignMcp.length) throw new Error(`Existing Combo MCP conflicts: ${foreignMcp.join(', ')}. Nothing was replaced or removed.`);
  return { alreadyInstalled: exact.length === 1, marketplacePresent: Boolean(market),
    installedPath: client === 'codex' ? ownCodexMcp ? resolve(ownCodexMcp.transport.cwd) : undefined : exact[0]?.installPath };
}

export function installCommands(client, root, { marketplacePresent, alreadyInstalled }) {
  if (alreadyInstalled) return [];
  const commands = [];
  if (!marketplacePresent) commands.push(client === 'codex'
    ? ['plugin', 'marketplace', 'add', root, '--json']
    : ['plugin', 'marketplace', 'add', root, '--scope', 'user']);
  commands.push(client === 'codex'
    ? ['plugin', 'add', PLUGIN_ID, '--json']
    : ['plugin', 'install', PLUGIN_ID, '--scope', 'user']);
  return commands;
}

export function parseClaudeMissingMcp(result) {
  if (result.status === 0) return ['combo'];
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 1 && text.trim() === 'No MCP server named "combo". Run `claude mcp add` to add one.') return [];
  if (result.status !== 1 || !/No MCP server (?:found with name:|named) "combo"\./.test(text)) {
    throw new Error('Unable to inspect Claude MCP names; installation stopped');
  }
  const names = text.match(/Configured servers:\s*([^\r\n]+)/)?.[1];
  if (!names) {
    if (/No MCP servers configured/i.test(text)) return [];
    throw new Error('Unsupported Claude MCP inventory; installation stopped');
  }
  return names.split(',').map((name) => name.trim()).filter(Boolean);
}
