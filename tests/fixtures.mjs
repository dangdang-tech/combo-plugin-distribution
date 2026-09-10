import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { artifactDigest, EXPECTED_PAYLOAD_PATHS, hash, LICENSE_PACKAGES, MARKETPLACE,
  payloadInventory, REPOSITORY, TEST_ORIGIN, VERSION } from '../scripts/release-lib.mjs';

export async function write(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

export async function temporary(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'combo-public-test-unit-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export async function rebuildManifest(root) {
  const files = await payloadInventory(root);
  const release = { schema: 'combo-plugin-public-release/1', version: VERSION, channel: 'test', status: 'test',
    marketplace: MARKETPLACE, repository: REPOSITORY, artifactSetSha256: artifactDigest(files), files };
  await write(root, 'release.json', release);
  return release;
}

export async function fixture(t, { support = false } = {}) {
  const temporaryRoot = await temporary(t);
  const root = join(temporaryRoot, 'distribution');
  await mkdir(root);
  for (const path of EXPECTED_PAYLOAD_PATHS) {
    await write(root, path, `Synthetic fixture only: ${path.replace(/^plugins\/combo(?:-claude)?\//, '')}\n`);
  }
  await write(root, '.agents/plugins/marketplace.json', { name: MARKETPLACE,
    plugins: [{ name: 'combo', source: { source: 'local', path: './plugins/combo' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }] });
  await write(root, '.claude-plugin/marketplace.json', { name: MARKETPLACE, owner: { name: 'Fixture' },
    plugins: [{ name: 'combo', source: './plugins/combo-claude' }] });
  const notices = 'Synthetic license text for boundary tests only.\n';
  const packages = LICENSE_PACKAGES.map((id) => ({ name: id.slice(0, id.lastIndexOf('@')),
    version: id.slice(id.lastIndexOf('@') + 1), license: 'Synthetic', usedBy: ['bin/combo-mcp.mjs'],
    notices: [{ file: 'LICENSE', sha256: hash(notices) }] }));
  for (const [directory, client, manifest] of [['combo', 'codex', '.codex-plugin/plugin.json'],
    ['combo-claude', 'claude', '.claude-plugin/plugin.json']]) {
    await write(root, `plugins/${directory}/${manifest}`, { name: 'combo', version: VERSION,
      description: 'Synthetic fixture only', repository: REPOSITORY });
    await write(root, `plugins/${directory}/.mcp.json`, { mcpServers: { combo: { command: 'node',
      args: [client === 'codex' ? './bin/combo-mcp.mjs' : '${CLAUDE_PLUGIN_ROOT}/bin/combo-mcp.mjs'],
      ...(client === 'codex' ? { cwd: '.' } : {}),
      env: { COMBO_CONTEXT_CLIENT: client, COMBO_CONTEXT_CLOUD_ORIGIN: TEST_ORIGIN } } } });
    await write(root, `plugins/${directory}/THIRD_PARTY_NOTICES.md`, notices);
    await write(root, `plugins/${directory}/third-party-licenses.json`, {
      schema: 'combo.third-party-notices/1', noticesSha256: hash(notices), packages });
  }
  if (support) {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    for (const path of ['scripts/install.mjs', 'scripts/install-lib.mjs', 'scripts/release-lib.mjs',
      'scripts/verify-release.mjs', 'scripts/build-release.mjs']) {
      await write(root, path, await readFile(join(sourceRoot, path), 'utf8'));
    }
  }
  const release = await rebuildManifest(root);
  return { root, temporaryRoot, release };
}

export async function installedCopy(root, temporaryRoot, client) {
  const path = join(temporaryRoot, `${client}-cache`);
  await cp(join(root, 'plugins', client === 'codex' ? 'combo' : 'combo-claude'), path, { recursive: true });
  return path;
}

export function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error(`Fixture git failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function commitFixture(root) {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Distribution Test']);
  git(root, ['config', 'user.email', 'distribution-test@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);
  git(root, ['remote', 'add', 'origin', REPOSITORY]);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'test: create synthetic payload']);
  return git(root, ['rev-parse', 'HEAD']);
}
