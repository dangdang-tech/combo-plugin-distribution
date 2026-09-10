import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyRelease, TEST_ORIGIN } from '../scripts/release-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = await verifyRelease(root, { allowPending: true });
const payloadEnvironment = Object.fromEntries(['PATH', 'LANG', 'SystemRoot'].filter((key) => process.env[key])
  .map((key) => [key, process.env[key]]));
const content = {
  name: '测试结果核验助手', description: '根据调用方明确提供的测试摘要区分实际证据和待验证事项。',
  instructions: '先阅读调用方明确提供的测试摘要。逐条说明已验证的行为、运行环境与失败结果。缺少证据时明确记为未验证，不推断其他历史或线上状态。输出下一步建议。',
  starterPrompts: ['请核验我提供的测试摘要'], outputDescription: '列出已验证结果、限制和下一步。',
  coverageSummary: '仅使用本次显式测试输入，未检查其他历史。',
};

function startMcp(t, directory, client) {
  const child = spawn(process.execPath, [resolve(directory, 'bin/combo-mcp.mjs')], {
    cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...payloadEnvironment, COMBO_CONTEXT_CLIENT: client,
      COMBO_CONTEXT_CLOUD_ORIGIN: TEST_ORIGIN },
  });
  let nextId = 0;
  let buffer = '';
  const pending = new Map();
  child.stderr.resume();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const deferred = pending.get(message.id);
      if (deferred) { clearTimeout(deferred.timer); pending.delete(message.id);
        if (message.error) deferred.reject(new Error(JSON.stringify(message.error)));
        else deferred.resolve(message.result); }
    }
  });
  const stop = () => {
    for (const deferred of pending.values()) { clearTimeout(deferred.timer); deferred.reject(new Error('MCP process exited')); }
    pending.clear();
  };
  child.on('error', stop); child.on('exit', stop);
  t.after(() => { stop(); child.kill(); });
  return (method, params) => new Promise((resolvePromise, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 10000);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

test('published payload compiles explicit input and prepares the reviewed digest on both clients',
  { skip: release.status !== 'test' }, () => {
    for (const client of ['codex', 'claude']) {
      const directory = resolve(root, 'plugins', client === 'codex' ? 'combo' : 'combo-claude');
      const request = { protocol: 'combo.agent-context-request/1', request: '整理本次明确提供的核验方法', content,
        ...(client === 'claude' ? { client } : {}) };
      const compiled = spawnSync(process.execPath, [resolve(directory, 'bin/combo-context.mjs')], {
        cwd: directory, input: JSON.stringify(request), encoding: 'utf8', timeout: 10000,
        env: payloadEnvironment,
      });
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = JSON.parse(compiled.stdout);
      assert.match(result.compilation.packageDigest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(result.compilation.files.some((file) => file.path === 'AGENT.md' && file.content.length > 0));
      assert.ok(result.compilation.files.some((file) => file.path.endsWith('/SKILL.md') && file.content.length > 0));
      const prepared = spawnSync(process.execPath, [resolve(directory, 'bin/combo-context.mjs'), '--prepare', result.compilation.packageDigest], {
        cwd: directory, input: JSON.stringify(request), encoding: 'utf8', timeout: 10000,
        env: payloadEnvironment,
      });
      assert.equal(prepared.status, 0, prepared.stderr);
      assert.ok(prepared.stdout.includes('AGENT.md'));
    }
  });

test('published stdio MCP exposes and executes local compilation without host or model claims',
  { skip: release.status !== 'test' }, async (t) => {
    for (const client of ['codex', 'claude']) {
      const directory = resolve(root, 'plugins', client === 'codex' ? 'combo' : 'combo-claude');
      const call = startMcp(t, directory, client);
      const initialized = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'distribution-test', version: '1.0.0' } });
      assert.ok(initialized.protocolVersion);
      const listed = await call('tools/list', {});
      for (const name of ['compile_agent_context', 'prepare_agent_context']) {
        assert.ok(listed.tools.some((tool) => tool.name === name));
      }
      const compiled = await call('tools/call', { name: 'compile_agent_context', arguments: {
        request: '整理本次明确提供的核验方法', content } });
      assert.notEqual(compiled.isError, true);
      assert.ok(compiled.content.some((block) => block.type === 'text' && block.text.includes('AGENT.md')));
      const digest = compiled.structuredContent.agent.compiled.packageDigest;
      const prepared = await call('tools/call', { name: 'prepare_agent_context', arguments: {
        request: '整理本次明确提供的核验方法', content, expectedPackageDigest: digest } });
      assert.notEqual(prepared.isError, true);
      assert.equal(prepared.structuredContent.packageDigest, digest);
      assert.equal(prepared.structuredContent.runtime.status, 'not_run');
      assert.ok(prepared.structuredContent.files.some((file) => file.path === 'AGENT.md'));
    }
  });
