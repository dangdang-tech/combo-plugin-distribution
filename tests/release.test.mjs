import assert from 'node:assert/strict';
import { readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { allowedPayloadPath, EXPECTED_PAYLOAD_PATHS, verifyInstalledPayload, verifyRelease } from '../scripts/release-lib.mjs';
import { fixture, installedCopy, rebuildManifest, write } from './fixtures.mjs';

test('exact 28-file payload verifies both installed client copies', async (t) => {
  const { root, temporaryRoot } = await fixture(t);
  const release = await verifyRelease(root);
  assert.equal(release.files.length, 28);
  assert.equal(EXPECTED_PAYLOAD_PATHS.length, 28);
  for (const [client, count] of [['codex', 14], ['claude', 12]]) {
    const path = await installedCopy(root, temporaryRoot, client);
    assert.equal((await verifyInstalledPayload(release, client, path)).files, count);
  }
});

test('unknown paths, traversal, missing runtime and unlisted root files fail closed', async (t) => {
  for (const path of ['../secret', '/tmp/foo', 'plugins/combo/.env', 'plugins/combo/bin/source-map.json',
    'apps/mcp-server/src/private.ts', 'plugins/combo/bin/../combo-context.mjs']) assert.equal(allowedPayloadPath(path), false);
  const { root } = await fixture(t);
  await write(root, 'apps/private.ts', 'not allowed');
  await assert.rejects(verifyRelease(root), /Unexpected public repository file/);
  await rm(join(root, 'apps'), { recursive: true });
  await rm(join(root, 'plugins/combo/bin/agent-package-context-compiler.mjs'));
  await rebuildManifest(root);
  await assert.rejects(verifyRelease(root), /exactly the 28/);
});

test('payload or cache byte tampering is rejected even at the same version', async (t) => {
  const { root, temporaryRoot, release } = await fixture(t);
  const installed = await installedCopy(root, temporaryRoot, 'codex');
  await writeFile(join(installed, 'bin/combo-context.mjs'), 'changed runtime');
  await assert.rejects(verifyInstalledPayload(release, 'codex', installed), /cache digest mismatch/);
  await write(root, 'plugins/combo/bin/combo-context.mjs', 'changed runtime');
  await assert.rejects(verifyRelease(root), /file digest mismatch/);
});

test('rehashing an incorrect Test binding or asymmetric client bundle cannot bless it', async (t) => {
  const { root } = await fixture(t);
  const path = join(root, 'plugins/combo/.mcp.json');
  const mcp = JSON.parse(await readFile(path, 'utf8'));
  mcp.mcpServers.combo.env.COMBO_CONTEXT_CLIENT = 'claude';
  await write(root, 'plugins/combo/.mcp.json', mcp);
  await rebuildManifest(root);
  await assert.rejects(verifyRelease(root), /fixed Test origin/);
  mcp.mcpServers.combo.env.COMBO_CONTEXT_CLIENT = 'codex';
  await write(root, 'plugins/combo/.mcp.json', mcp);
  await write(root, 'plugins/combo/bin/combo-context.mjs', 'different but rehashed');
  await rebuildManifest(root);
  await assert.rejects(verifyRelease(root), /identical shared bytes/);
});

test('a changed Test origin, extra MCP, or extra environment is rejected', async (t) => {
  for (const change of [
    (mcp) => { mcp.mcpServers.combo.env.COMBO_CONTEXT_CLOUD_ORIGIN = 'https://example.invalid'; },
    (mcp) => { mcp.mcpServers.other = { command: 'node' }; },
    (mcp) => { mcp.mcpServers.combo.env.COMBO_API_TOKEN = 'not-a-secret-fixture'; },
  ]) {
    const { root } = await fixture(t);
    const mcp = JSON.parse(await readFile(join(root, 'plugins/combo/.mcp.json'), 'utf8'));
    change(mcp);
    await write(root, 'plugins/combo/.mcp.json', mcp);
    await rebuildManifest(root);
    await assert.rejects(verifyRelease(root), /fixed Test origin/);
  }
});

test('release inventory and license provenance must remain consistent', async (t) => {
  const { root } = await fixture(t);
  const path = 'plugins/combo/third-party-licenses.json';
  const licenses = JSON.parse(await readFile(join(root, path), 'utf8'));
  licenses.packages[0].version = '9.9.9';
  await write(root, path, licenses);
  await rebuildManifest(root);
  await assert.rejects(verifyRelease(root), /notice inventory mismatch/);
});

test('symlinks at plugin root, intermediate directories and installed cache are rejected', async (t) => {
  for (const relative of ['plugins', 'plugins/combo/bin', 'plugins/combo/bin/combo-context.mjs']) {
    const { root, temporaryRoot } = await fixture(t);
    const target = join(root, relative);
    const moved = join(temporaryRoot, 'moved');
    await rename(target, moved);
    await symlink(moved, target);
    await assert.rejects(verifyRelease(root), /Symlinks|Invalid payload directory/);
  }
  const { root, temporaryRoot, release } = await fixture(t);
  const installed = await installedCopy(root, temporaryRoot, 'codex');
  await symlink(installed, join(temporaryRoot, 'cache-link'));
  await assert.rejects(verifyInstalledPayload(release, 'codex', join(temporaryRoot, 'cache-link')), /non-symlink/);
});

test('pending release is allowed only for empty infrastructure checks, never installation', async (t) => {
  const { root } = await fixture(t);
  await write(root, 'release.json', { schema: 'combo-plugin-public-release/1', version: '0.2.0',
    channel: 'test', status: 'pending-artifact-review', marketplace: 'dangdang-tech-combo-public-test',
    repository: 'https://github.com/dangdang-tech/combo-plugin-distribution.git', files: [], artifactSetSha256: null });
  await assert.rejects(verifyRelease(root), /no reviewed installable/);
  await assert.rejects(verifyRelease(root, { allowPending: true }), /must not carry unreviewed/);
  for (const path of ['plugins', '.agents', '.claude-plugin']) await rm(join(root, path), { recursive: true });
  assert.equal((await verifyRelease(root, { allowPending: true })).status, 'pending-artifact-review');
});
