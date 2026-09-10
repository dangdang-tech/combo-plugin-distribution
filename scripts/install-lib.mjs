import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { MARKETPLACE, PLUGIN_ID, REPOSITORY, SHA, TEST_ORIGIN, VERSION } from './release-lib.mjs';

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

// Inventory is untrusted and may include MCP credentials. Reports deliberately
// select identity fields, never spread raw CLI objects, transports or environment.
const label = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256) : 'unknown';
function localSource(source, typeKey, pathKey) {
  const type = source?.[typeKey];
  return { type: label(type), path: ['local', 'directory'].includes(type) && typeof source?.[pathKey] === 'string'
    && isAbsolute(source[pathKey]) ? label(source[pathKey]) : 'not_reported' };
}

function pluginSummary(plugin, client) {
  return { id: label(plugin.id), version: label(plugin.version),
    enabled: typeof plugin.enabled === 'boolean' ? plugin.enabled : 'unknown',
    scope: client === 'codex' ? 'user_inventory' : label(plugin.scope),
    marketplace: label(plugin.marketplace),
    source: client === 'codex' ? localSource(plugin.source, 'source', 'path') : { type: 'see_marketplace', path: 'not_reported' },
    provenance: 'not_verified' };
}

export function inspectInstallation({ client, plugins, marketplaces, mcpNames, codexMcp = [], root }) {
  if (!Array.isArray(mcpNames) || mcpNames.some((name) => typeof name !== 'string')) {
    throw new Error('Unsupported MCP inventory; installation stopped');
  }
  const exact = plugins.filter((plugin) => plugin.id === PLUGIN_ID);
  const conflicting = plugins.filter((plugin) =>
    (comboName(plugin.name) && plugin.id !== PLUGIN_ID)
    || (plugin.id !== PLUGIN_ID && Object.keys(plugin.mcpServers ?? {}).some(comboName)));
  const issues = [];
  const issue = (code, message) => issues.push({ code, message });
  const relatedMcpNames = mcpNames.filter(comboName);
  if (new Set(relatedMcpNames).size !== relatedMcpNames.length) {
    issue('duplicate_mcp', 'The MCP inventory contains duplicate Combo names; attribution is ambiguous.');
  }
  if (conflicting.length) issue('other_combo', 'Another Combo registration needs source and migration review; its name does not prove official provenance.');
  if (exact.length > 1) issue('multiple_scopes', 'Combo is installed in multiple scopes; preserve every registration until the intended scope is selected.');
  const matchingMarkets = marketplaces.filter((market) => market.name === MARKETPLACE);
  if (matchingMarkets.length > 1) issue('ambiguous_marketplace', 'More than one marketplace has the target name.');
  const market = matchingMarkets[0];
  let matchingSource = false;
  if (market) {
    const source = client === 'codex' ? market.marketplaceSource : market;
    const type = client === 'codex' ? source?.sourceType : source?.source;
    const path = client === 'codex' ? source?.source : source?.path;
    matchingSource = ['local', 'directory'].includes(type) && typeof path === 'string'
      && isAbsolute(path) && resolve(path) === resolve(root);
    if (!matchingSource) issue('marketplace_source', 'The public marketplace points to a different or unknown source; it must not be repointed automatically.');
  }
  if (exact.length) {
    if (!market) issue('missing_marketplace', 'The installed target has no corresponding marketplace in the current inventory.');
    if (exact[0].version !== VERSION) issue('different_version', 'The installed target has a different or unknown version; historical payload provenance has not been verified.');
    if (exact[0].enabled === false) issue('disabled', 'The existing disabled state will be preserved; --apply is not authorization to enable it.');
    else if (exact[0].enabled !== true) issue('unknown_enabled_state', 'The client did not report an explicit enabled state.');
  }
  if (client === 'codex' && exact.length && (exact[0].name !== 'combo' || exact[0].marketplace !== MARKETPLACE
    || exact[0].source?.source !== 'local' || exact[0].source?.path !== resolve(root, 'plugins/combo')
    || exact[0].marketplaceSource?.sourceType !== 'local' || exact[0].marketplaceSource?.source !== root)) {
    issue('plugin_source', 'Installed Combo source metadata does not match the fixed distribution directory.');
  }
  if (client === 'claude' && exact.length && exact[0].scope !== 'user') {
    issue('non_user_scope', 'Existing Combo is outside user scope; its registration will be preserved.');
  }
  // Codex reports plugin MCPs under their short name. Its observed transport
  // provides the cache location; name alone never grants a collision exemption.
  const namedCodexMcps = codexMcp.filter((server) => server?.name === 'combo');
  if (client === 'codex' && (namedCodexMcps.length > 1 || mcpNames.filter((name) => name === 'combo').length > 1)) {
    issue('duplicate_mcp', 'More than one MCP uses the target short name; cache ownership is ambiguous.');
  }
  const ownCodexMcps = client === 'codex' && namedCodexMcps.length === 1 && exact.length === 1 && matchingSource
    && !issues.some(({ code }) => ['plugin_source', 'different_version', 'unknown_enabled_state'].includes(code)) ? codexMcp.filter((server) => {
    const transport = server.transport;
    return server.name === 'combo' && server.enabled === exact[0].enabled && transport?.type === 'stdio'
      && transport.command === 'node' && JSON.stringify(transport.args) === '["./bin/combo-mcp.mjs"]'
      && typeof transport.cwd === 'string' && isAbsolute(transport.cwd)
      && resolve(transport.cwd).endsWith(`/plugins/cache/${MARKETPLACE}/combo/${VERSION}`)
      && transport.env?.COMBO_CONTEXT_CLIENT === 'codex'
      && transport.env?.COMBO_CONTEXT_CLOUD_ORIGIN === TEST_ORIGIN
      && Object.keys(transport.env).length === 2 && Array.isArray(transport.env_vars) && transport.env_vars.length === 0;
  }) : [];
  const ownCodexMcp = ownCodexMcps.length === 1 ? ownCodexMcps[0] : undefined;
  const foreignMcp = mcpNames.filter((name) => comboName(name)
    && !(client === 'claude' && exact.length === 1 && matchingSource && exact[0].scope === 'user'
      && exact[0].version === VERSION && name === 'plugin:combo:combo')
    && !(name === 'combo' && ownCodexMcp));
  if (foreignMcp.length) issue('foreign_mcp', 'Combo MCP names cannot be attributed to the exact reviewed target transport.');
  const status = issues.length === 0 ? exact.length ? 'reuse_candidate' : 'fresh'
    : issues.every(({ code }) => code === 'disabled') ? 'disabled_preserved'
      : issues.every(({ code }) => ['different_version', 'disabled'].includes(code))
        ? 'migration_plan_required' : 'source_conflict';
  const relevantMarkets = marketplaces.filter((item) => item.name === MARKETPLACE
    || [...exact, ...conflicting].some((plugin) => plugin.marketplace === item.name));
  return { status, issues, alreadyInstalled: status === 'reuse_candidate', marketplacePresent: matchingSource,
    existing: { plugins: [...exact, ...conflicting].map((plugin) => pluginSummary(plugin, client)),
      marketplaces: relevantMarkets.map((item) => ({ name: label(item.name), source: client === 'codex'
        ? localSource(item.marketplaceSource, 'sourceType', 'source') : localSource(item, 'source', 'path') })),
      mcpNames: mcpNames.filter(comboName).map(label) },
    installedPath: client === 'codex' ? ownCodexMcp ? resolve(ownCodexMcp.transport.cwd) : undefined : exact[0]?.installPath };
}

export function installCommands(client, root, { marketplacePresent, alreadyInstalled, status }) {
  // Only a complete fresh inventory can generate mutations. Even --apply cannot
  // convert a review plan, disabled install or unknown state into an upgrade.
  if (alreadyInstalled || status !== 'fresh') return [];
  const commands = [];
  if (!marketplacePresent) commands.push(client === 'codex'
    ? ['plugin', 'marketplace', 'add', root, '--json']
    : ['plugin', 'marketplace', 'add', root, '--scope', 'user']);
  commands.push(client === 'codex'
    ? ['plugin', 'add', PLUGIN_ID, '--json']
    : ['plugin', 'install', PLUGIN_ID, '--scope', 'user']);
  return commands;
}

export function reviewPlan({ client, root, commit, release, state, cache }) {
  const ids = state.existing.plugins.map((item) => item.id);
  const subjects = [...ids, ...state.existing.mcpNames.map((name) => `MCP ${name}`),
    ...state.existing.marketplaces.map((item) => `marketplace ${item.name}`)].join(', ');
  return {
    target: { client, pluginId: PLUGIN_ID, version: VERSION, repository: REPOSITORY, commit,
      directory: root, artifactSetSha256: release.artifactSetSha256, payloadVerification: 'passed' },
    existing: state.existing, issues: state.issues,
    installedCacheVerification: cache ? { status: 'passed', ...cache } : { status: 'not_verified' },
    migration: { supported: false, executable: false, commands: [],
      historicalProvenance: 'not_verified',
      reason: 'This release has no audited historical payload inventory or validated native migration/rollback path. Names, version strings and manifest authors are not provenance.',
      requiredEvidence: ['A publicly retrievable fixed historical commit and independently reviewed file hashes for each old registration.',
        'CLI-reported ownership, scope, enabled state, actual cache and MCP/Skill attribution; inspect only authorized installation metadata.',
        'Verified old-source availability and a tested restoration procedure before any destructive change.'] },
    proposedChanges: state.status === 'disabled_preserved'
      ? ids.map((id) => ({ subject: id, operation: 'activation_review_only', executable: false,
        action: 'Changing enabled=false to true needs separate authorization and a verified host activation mechanism. Do not reinstall the package or use the compiler to bypass this state.' }))
      : [...state.existing.plugins.map((plugin) => ({ subject: plugin.id, scope: plugin.scope,
        operation: plugin.id === PLUGIN_ID ? 'replacement_review_only' : 'retirement_review_only', executable: false,
        action: 'Preserve this registration now. Replacing or removing it would affect its cache and requires verified provenance, restoration and explicit authorization.' })),
      ...state.existing.mcpNames.map((name) => ({ subject: name, operation: 'ownership_review_only', executable: false,
        action: 'Attribute this MCP to an installed plugin or independent configuration before proposing any removal. Do not delete independent MCP configuration.' })),
      ...state.existing.marketplaces.filter((market) => market.name === MARKETPLACE && market.source.path !== root)
        .map((market) => ({ subject: market.name, operation: 'source_change_review_only', executable: false,
          action: 'The target marketplace name is occupied. Preserve its source; repointing it requires a separately reviewed effect on every associated plugin.' })),
      { subject: PLUGIN_ID, operation: 'install_after_resolution', executable: false,
        action: 'Install the fixed target only after listed collisions are resolved with explicit authorization; do not change marketplace names to evade a collision.' }],
    preservation: { now: 'This review plan performs no further changes. Consult recovery.attemptedCommands/completedCommands for any earlier installation attempts; existing registrations and enabled states are preserved.',
      configuration: 'Only client inventory is inspected. Credentials, conversations, Projects and raw config backups are not read or copied.',
      later: 'Codex plugin remove deletes the local cache. Data/config preservation for a future migration is unverified; this plan is not a backup.' },
    recovery: { automaticRollback: false, strategy: 'Preserve and re-inspect; never remove an existing plugin to compensate for failure.',
      limitations: 'A future destructive migration requires the verified old release and a proven restoration path. Reinstalling a plugin alone does not prove restoration of its configuration or data.' },
    verification: ['Recheck the fixed checkout, origin, clean state and every payload hash.',
      'Refresh full client inventories immediately before any authorized mutation.',
      'Verify actual installed cache bytes and exact MCP transport ownership after installation.',
      'Check tools and same-name Skills actually visible in this task separately; CLI installation is not host loading.',
      'Extract only if this conversation already contains a reusable method; compilation is not execution.'],
    decision: { requiredBeforeChanges: true,
      recommendedAction: 'keep_existing',
      question: state.status === 'disabled_preserved'
        ? `Should ${subjects} remain disabled? Activation would need an explicitly requested, supported host mechanism; this installer cannot activate it.`
        : `Keep ${subjects || 'the existing configuration'} and defer the target. If replacement is intended, what verified public source and fixed commit identify these existing items so their restoration plan can be completed?`,
      effect: 'Finish all already-authorized read-only checks before asking for missing source information or intent. Do not request permission to repeat those checks. No executable migration is offered; any later destructive plan requires explicit authorization and original restrictions remain in force.' },
  };
}

export function failureRecovery({ stage, attemptedCommands, completedCommands }) {
  return { stage, attemptedCommands, completedCommands,
    mutationOutcome: attemptedCommands.length ? 'may_have_partial_changes' : 'no_install_commands_attempted',
    automaticRollback: false,
    next: 'Preserve all registrations and caches. Re-run without --apply to inspect current inventory and validate cache bytes. If only the verified target marketplace exists, --apply can finish the missing plugin installation after revalidation. If the exact package is verified, reuse it. Otherwise review the reported conflicts; never automatically remove, reinstall, re-enable or repoint.',
    restoration: 'No configuration backup was made and restoration is not claimed. A failed command may have changed state even without a success response.' };
}

export function parseClaudeMissingMcp(result) {
  if (result.status === 0) return ['combo'];
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.status === 1 && text === 'No MCP server named "combo". Run `claude mcp add` to add one.') return [];
  if (/and\s+\d+\s+more|awaiting approval|\u2026|\.\.\./i.test(text)) {
    throw new Error('Claude MCP inventory is incomplete or awaiting approval; installation stopped');
  }
  const match = text.match(/^No MCP server (?:found with name:|named) "combo"\. Configured servers: ([A-Za-z0-9_.:@/-]+(?:, [A-Za-z0-9_.:@/-]+)*)$/);
  if (result.status !== 1 || !match) {
    throw new Error('Unable to inspect Claude MCP names; installation stopped');
  }
  return match[1].split(', ');
}
