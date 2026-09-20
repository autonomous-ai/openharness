// Real cached-model serving, concurrency, route boundaries, cancellation and recovery.
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolve, join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { start } from '../src/server.mjs';
import { VllmAdapter, VLLM_PROFILE } from '../src/vllm.mjs';
const packageRoot = resolve('../../agents/vllm');
const adapter = new VllmAdapter({ packageRoot, dataDir: join(packageRoot, '.harness') });
const { server, controller } = await start(0, { workspaceRoot: packageRoot, assetRoot: join(packageRoot, 'dist'), adapter, profile: VLLM_PROFILE });
const model = VLLM_PROFILE.defaultModel; const checks = [];
async function run(action) {
  const job = await controller.submit(action); console.log('Running', action.type);
  const deadline = Date.now() + 240000;
  while (['queued', 'running'].includes(job.status) && Date.now() < deadline) await delay(150);
  assert.equal(job.status, 'succeeded', job.message); checks.push(action.type); console.log(job.message); return job;
}
try {
  await run({ type: 'serve', model, context: 2048, maxSequences: 4, memoryFraction: 0.1, prefixCaching: true });
  const privateBase = `http://127.0.0.1:${adapter.server.port}`;
  assert.equal((await fetch(privateBase + '/health')).status, 403);
  assert.equal((await fetch(privateBase + '/metrics', { headers: { Authorization: `Bearer ${adapter.server.key}`, Origin: 'https://evil.example' } })).status, 403);
  // fetch normalizes Host; use a raw HTTP request to exercise the actual boundary.
  const hostileHost = await new Promise((resolve, reject) => { const request = http.get({ host: '127.0.0.1', port: adapter.server.port, path: '/health', headers: { Authorization: `Bearer ${adapter.server.key}`, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(hostileHost, 403);
  assert.equal((await adapter.fetchNative('/health')).status, 200); checks.push('private API auth, host and origin');
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/?view=grid', '/app.js', '/styles.css', '/assets/vllm-icon.png', '/favicon.ico']) assert.equal((await fetch(base + path)).status, 200, path);
  checks.push('viewer and official icon HTTP assets');
  const chat = await run({ type: 'chat', model, prompt: 'In one sentence, why does a bicycle need brakes?' }); assert.ok(chat.output.trim()); assert.ok(chat.result.metrics.tokens > 0);
  await run({ type: 'benchmark', models: [model] });
  await run({ type: 'load_test', model, concurrency: 1, requests: 8 });
  await run({ type: 'load_test', model, concurrency: 4, requests: 8 });
  const tests = controller.snapshot().loadTests; assert.ok(tests.length >= 2); assert.equal(tests[0].failed, 0); assert.equal(tests[1].failed, 0);
  await run({ type: 'serve', model, context: 1024, maxSequences: 2, prefixCaching: false });
  await run({ type: 'chat', model, prompt: 'Say hello briefly.' });
  assert.equal(adapter.config.context, 1024); assert.equal(adapter.config.maxSequences, 2); assert.equal(adapter.config.prefixCaching, false); checks.push('serving settings apply and chat preserves them');
  const job = await controller.submit({ type: 'load_test', model, concurrency: 4, requests: 32 });
  while (!adapter.inflight && ['queued', 'running'].includes(job.status)) await delay(10);
  assert.ok(adapter.inflight); const ownedPid = adapter.server.child.pid;
  await controller.cancel(job.id);
  while (['queued', 'running'].includes(job.status)) await delay(50);
  assert.equal(job.status, 'cancelled'); await adapter.stopServer();
  assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' }); checks.push('active cancellation frees owned server');
  await run({ type: 'serve', model, context: 2048, maxSequences: 4, prefixCaching: true });
  await run({ type: 'chat', model, prompt: 'Say ready in a short sentence.' }); checks.push('recovery after cancellation');
  await run({ type: 'unload_all' }); assert.equal(adapter.loaded, null);
  const exported = await (await fetch(base + '/api/export')).json(); assert.ok(exported.loadTests.length >= 2);
  await mkdir('evidence/vllm', { recursive: true });
  await writeFile('evidence/vllm/benchmarks.json', JSON.stringify(exported, null, 2));
  await writeFile('evidence/vllm/verification.json', JSON.stringify({ at: new Date().toISOString(), checks, runtime: (await adapter.discover()), chat: { output: chat.output, metrics: chat.result.metrics } }, null, 2));
  console.log('All live vLLM checks passed.');
} finally { server.closeEvents(); server.closeAllConnections(); server.close(); await controller.close(); }
