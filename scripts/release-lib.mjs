import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export const REPOSITORY = 'https://github.com/dangdang-tech/combo-plugin-distribution.git';
export const MARKETPLACE = 'dangdang-tech-combo-public-test';
export const VERSION = '0.2.0';
export const TEST_ORIGIN = 'https://test.43-160-242-46.sslip.io';
export const PLUGIN_ID = `combo@${MARKETPLACE}`;
export const SHA = /^[a-f0-9]{40}$/;
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const exactPaths = [
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
];
export const SHARED_PLUGIN_FILES = ['bin/combo-mcp.mjs', 'bin/combo-context.mjs', 'bin/combo-local.mjs',
  'bin/agent-package-context-compiler.mjs', 'bin/agent-package-context-compiler.d.mts',
  'skills/combo-agent-builder/SKILL.md', 'ui/agent-card.html', 'ui/context-card.html',
  'THIRD_PARTY_NOTICES.md', 'third-party-licenses.json'];
export const EXPECTED_PAYLOAD_PATHS = [...exactPaths,
  ...['combo', 'combo-claude'].flatMap((directory) =>
    ['.mcp.json', ...SHARED_PLUGIN_FILES].map((path) => `plugins/${directory}/${path}`)),
  'plugins/combo/.codex-plugin/plugin.json', 'plugins/combo-claude/.claude-plugin/plugin.json',
  'plugins/combo/assets/icon.png', 'plugins/combo/assets/icon.svg'].sort();
const allowedPaths = new Set(EXPECTED_PAYLOAD_PATHS);
export const REPOSITORY_FILES = new Set([...EXPECTED_PAYLOAD_PATHS, 'README.md', 'package.json', 'release.json',
  '.github/workflows/ci.yml', 'docs/install.md', 'docs/maintainers.md', 'scripts/release-lib.mjs',
  'scripts/verify-release.mjs', 'scripts/build-release.mjs', 'scripts/install-lib.mjs', 'scripts/install.mjs',
  'tests/fixtures.mjs', 'tests/release.test.mjs', 'tests/install.test.mjs', 'tests/payload.test.mjs']);
export const LICENSE_PACKAGES = ['@modelcontextprotocol/ext-apps@1.7.5', '@modelcontextprotocol/sdk@1.29.0',
  'ajv@8.20.0', 'ajv-formats@3.0.1', 'commander@15.0.0', 'fast-deep-equal@3.1.3', 'fast-uri@3.1.4',
  'json-schema-traverse@1.0.0', 'zod-to-json-schema@3.25.2', 'zod@3.25.76', 'zod@4.4.3'].sort();

export function allowedPayloadPath(path) {
  return allowedPaths.has(path);
}

export async function walkFiles(root, prefix = '', { skipGit = false } = {}) {
  const directory = await lstat(join(root, prefix));
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error(`Invalid payload directory: ${prefix}`);
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (skipGit && prefix === '' && entry.name === '.git') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${path}`);
    if (entry.isDirectory()) paths.push(...await walkFiles(root, path, { skipGit }));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Non-regular file: ${path}`);
  }
  return paths.sort();
}

async function readRegularFile(root, path) {
  if (!allowedPayloadPath(path)) throw new Error(`Unexpected payload path: ${path}`);
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(join(root, ...parts.slice(0, i)));
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${path}`);
    if (i < parts.length && !stat.isDirectory()) throw new Error(`Invalid directory: ${path}`);
    if (i === parts.length && !stat.isFile()) throw new Error(`Non-regular file: ${path}`);
  }
  return readFile(resolve(root, path));
}

export async function payloadInventory(root) {
  const paths = [...exactPaths, ...await walkFiles(root, 'plugins')].sort();
  return Promise.all(paths.map(async (path) => {
    const bytes = await readRegularFile(root, path);
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  }));
}

export function artifactDigest(files) {
  return hash(JSON.stringify(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))));
}

export async function verifyInstalledPayload(release, client, installedPath) {
  if (typeof installedPath !== 'string' || !isAbsolute(installedPath)
    || await realpath(installedPath) !== installedPath || !(await lstat(installedPath)).isDirectory()) {
    throw new Error('Client did not provide a verifiable, non-symlink installed cache directory');
  }
  const prefix = `plugins/${client === 'codex' ? 'combo' : 'combo-claude'}/`;
  const expected = release.files.filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  const actualPaths = await walkFiles(installedPath);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expected.map((entry) => entry.path))) {
    throw new Error('Installed cache file inventory does not match the reviewed payload');
  }
  for (const entry of expected) {
    if ((await lstat(join(installedPath, entry.path))).size !== entry.bytes) {
      throw new Error(`Installed cache digest mismatch: ${entry.path}`);
    }
    const bytes = await readFile(join(installedPath, entry.path));
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) {
      throw new Error(`Installed cache digest mismatch: ${entry.path}`);
    }
  }
  return { files: expected.length, installedPath };
}

export async function verifyRelease(root, { allowPending = false, candidateRelease } = {}) {
  const repositoryFiles = await walkFiles(root, '', { skipGit: true });
  for (const path of repositoryFiles) {
    if (!REPOSITORY_FILES.has(path)) throw new Error(`Unexpected public repository file: ${path}`);
  }
  const release = candidateRelease ?? JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
  if (release.schema !== 'combo-plugin-public-release/1' || release.version !== VERSION
    || release.channel !== 'test' || release.marketplace !== MARKETPLACE
    || release.repository !== REPOSITORY || !Array.isArray(release.files)) {
    throw new Error('Unrecognized release identity');
  }
  if (allowPending && release.status === 'pending-artifact-review' && release.files.length === 0
    && release.artifactSetSha256 === null) {
    if (repositoryFiles.some(allowedPayloadPath)) throw new Error('Pending release must not carry unreviewed plugin payload');
    return release;
  }
  if (release.status !== 'test' || release.files.length === 0) {
    throw new Error('This commit has no reviewed installable test payload');
  }
  for (const entry of release.files) {
    if (!allowedPayloadPath(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid release inventory');
  }
  const inventory = await payloadInventory(root);
  if (JSON.stringify(inventory.map((entry) => entry.path)) !== JSON.stringify(EXPECTED_PAYLOAD_PATHS)) {
    throw new Error('The release must contain exactly the 28 approved payload files');
  }
  if (JSON.stringify(inventory) !== JSON.stringify(release.files)
    || artifactDigest(inventory) !== release.artifactSetSha256) {
    throw new Error('Release inventory or file digest mismatch');
  }
  for (const [directory, manifest] of [
    ['combo', '.codex-plugin/plugin.json'], ['combo-claude', '.claude-plugin/plugin.json'],
  ]) {
    const plugin = JSON.parse(await readFile(join(root, 'plugins', directory, manifest), 'utf8'));
    if (plugin.name !== 'combo' || plugin.version !== VERSION || plugin.repository !== REPOSITORY) {
      throw new Error(`Plugin identity mismatch: ${directory}`);
    }
    for (const required of ['.mcp.json', 'bin/combo-context.mjs', 'bin/combo-mcp.mjs',
      'skills/combo-agent-builder/SKILL.md', 'ui/context-card.html', 'THIRD_PARTY_NOTICES.md',
      'third-party-licenses.json']) {
      if (!inventory.some((entry) => entry.path === `plugins/${directory}/${required}`)) {
        throw new Error(`Missing required file: ${directory}/${required}`);
      }
    }
    const notices = await readFile(join(root, 'plugins', directory, 'THIRD_PARTY_NOTICES.md'));
    const licenses = JSON.parse(await readFile(join(root, 'plugins', directory, 'third-party-licenses.json'), 'utf8'));
    if (licenses.schema !== 'combo.third-party-notices/1' || licenses.noticesSha256 !== hash(notices)
      || !Array.isArray(licenses.packages)
      || JSON.stringify(licenses.packages.map((item) => `${item.name}@${item.version}`).sort()) !== JSON.stringify(LICENSE_PACKAGES)
      || licenses.packages.some((item) => !Array.isArray(item.usedBy) || item.usedBy.length === 0
        || item.usedBy.some((path) => !SHARED_PLUGIN_FILES.includes(path))
        || !Array.isArray(item.notices) || item.notices.length === 0
        || item.notices.some((notice) => typeof notice.file !== 'string' || !/^[a-f0-9]{64}$/.test(notice.sha256)))) {
      throw new Error(`Bundled third-party notice inventory mismatch: ${directory}`);
    }
    const mcp = JSON.parse(await readFile(join(root, 'plugins', directory, '.mcp.json'), 'utf8'));
    const expectedMcp = { mcpServers: { combo: { command: 'node',
      args: [directory === 'combo' ? './bin/combo-mcp.mjs' : '${CLAUDE_PLUGIN_ROOT}/bin/combo-mcp.mjs'],
      ...(directory === 'combo' ? { cwd: '.' } : {}),
      env: { COMBO_CONTEXT_CLIENT: directory === 'combo' ? 'codex' : 'claude', COMBO_CONTEXT_CLOUD_ORIGIN: TEST_ORIGIN },
    } } };
    if (canonicalJson(mcp) !== canonicalJson(expectedMcp)) {
      throw new Error(`MCP must bind the matching client and fixed Test origin: ${directory}`);
    }
  }
  for (const path of SHARED_PLUGIN_FILES) {
    const codexFile = inventory.find((entry) => entry.path === `plugins/combo/${path}`);
    const claudeFile = inventory.find((entry) => entry.path === `plugins/combo-claude/${path}`);
    if (codexFile.sha256 !== claudeFile.sha256 || codexFile.bytes !== claudeFile.bytes) {
      throw new Error(`Client bundles must contain identical shared bytes: ${path}`);
    }
  }
  const codex = JSON.parse(await readFile(join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  const claude = JSON.parse(await readFile(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  if (codex.name !== MARKETPLACE || claude.name !== MARKETPLACE
    || codex.plugins?.length !== 1 || claude.plugins?.length !== 1
    || codex.plugins[0].name !== 'combo' || claude.plugins[0].name !== 'combo'
    || codex.plugins[0].source?.source !== 'local'
    || codex.plugins[0].source?.path !== './plugins/combo'
    || claude.plugins[0].source !== './plugins/combo-claude') {
    throw new Error('Marketplace must resolve only the bundled Combo plugin');
  }
  return release;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
