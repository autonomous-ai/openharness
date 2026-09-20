import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveIntent, validateAction } from '../src/intents.mjs';
import { validateModel, readNDJSON, responseMetrics } from '../src/ollama.mjs';
import { Store } from '../src/store.mjs';
import { Controller, median, safeError } from '../src/controller.mjs';

const context = { models: [{ id: 'qwen3:0.6b', running: true }], selectedModel: 'qwen3:0.6b' };
test('operational language selects concrete local actions', () => {
  assert.deepEqual(resolveIntent('Could you run a lightweight model?').action, { type: 'deploy', model: 'qwen3:0.6b' });
  assert.equal(resolveIntent('Find a small model for coding').models[0].id, 'qwen2.5-coder:1.5b');
  assert.equal(resolveIntent('Run a small coding model').action.model, 'qwen2.5-coder:1.5b');
  assert.deepEqual(resolveIntent('benchmark it', context).action, { type: 'benchmark', models: ['qwen3:0.6b'] });
  assert.deepEqual(resolveIntent('compare qwen3:0.6b and gemma3:1b', context).action.models, ['qwen3:0.6b', 'gemma3:1b']);
  assert.equal(resolveIntent('free up memory').action.type, 'unload_all');
  assert.equal(resolveIntent('start Ollama').action.type, 'start');
  assert.equal(resolveIntent('show my models').kind, 'inventory');
});
test('negations, explanations and multi-step ambiguity do not execute', () => {
  for (const text of ["Don't run qwen3:0.6b", 'Do not unload it', 'How do I deploy a model?', 'Delete qwen3:0.6b', 'Run qwen3:0.6b and then benchmark it', 'stop']) assert.notEqual(resolveIntent(text, context).kind, 'action', text);
  assert.notEqual(resolveIntent('compare all', { models: Array.from({ length: 5 }, (_, i) => ({ id: `model${i}:latest` })) }).kind, 'action');
});
test('chat contents never become model operations', () => {
  const result = resolveIntent('Ask it: explain qwen3:cloud and do not run shell commands', context);
  assert.equal(result.action.type, 'chat'); assert.equal(result.action.model, 'qwen3:0.6b');
  assert.equal(result.action.prompt, 'explain qwen3:cloud and do not run shell commands');
  assert.equal(resolveIntent('What is the capital of France?', context).action.type, 'chat');
});
test('model and action validation exclude cloud, shell and remote targets', () => {
  assert.equal(validateModel('qwen3'), 'qwen3:latest');
  assert.equal(validateModel('user/model:q4_K_M'), 'user/model:q4_K_M');
  for (const model of ['qwen3:cloud', 'qwen3:4b-cloud', '../model', 'http://host/model', 'qwen3; echo secret', '$(date)', 'a\nb']) assert.throws(() => validateModel(model));
  assert.throws(() => validateAction({ type: 'delete', model: 'qwen3' }));
  assert.throws(() => validateAction({ type: 'benchmark', models: [] }));
  assert.throws(() => validateAction({ type: 'chat', model: 'qwen3', prompt: 'x', history: [{ role: 'system', content: 'x' }] }));
});
test('NDJSON handles UTF-8 across chunk boundaries and an unterminated final event', async () => {
  const bytes = new TextEncoder().encode('{"message":"✓🦙"}\n\n{"done":true}');
  async function* chunks() { for (let i = 0; i < bytes.length; i++) yield bytes.slice(i, i + 1); }
  const output = []; for await (const event of readNDJSON(chunks())) output.push(event);
  assert.deepEqual(output, [{ message: '✓🦙' }, { done: true }]);
});
test('stream errors and malformed events remain failures', async () => {
  for (const text of ['{"error":"out of memory"}\n', '{"done":', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    await assert.rejects(async () => { for await (const _ of readNDJSON([text])) {} });
  }
});
test('medians omit missing measurements and errors omit signed URL queries', () => {
  assert.equal(median([300, 100, 200]), 200); assert.equal(median([null, NaN]), null); assert.equal(median([10, 20]), 15);
  assert.equal(safeError(new Error('Get https://example.org/file?signature=secret failed')), 'Get https://example.org/file failed');
});
test('native nanosecond timings become rates and milliseconds without inventing missing data', () => {
  const metrics = responseMetrics({ eval_count: 100, eval_duration: 2e9, prompt_eval_count: 50, prompt_eval_duration: 5e8, load_duration: 12e6 });
  assert.equal(metrics.tokensPerSecond, 50); assert.equal(metrics.promptTokensPerSecond, 100); assert.equal(metrics.loadMs, 12); assert.equal(metrics.evalMs, 2000);
  assert.equal(responseMetrics({ eval_count: 100, eval_duration: 0 }).tokensPerSecond, null);
  assert.equal(responseMetrics({}).tokensPerSecond, null); assert.equal(responseMetrics({}).loadMs, null);
});
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).init();
  const model = { id: 'qwen3:0.6b', name: 'qwen3:0.6b', digest: 'sha256:fixture', running: false, resident: { size: 100 } };
  const runtime = { name: 'Ollama', online: true, installed: true, version: 'fixture', models: [model] };
  const calls = [];
  const adapter = { discover: async () => runtime, ensureRunning: async () => {}, localModelDetails: async () => ({}), loadModel: async () => { model.running = true; }, unloadModel: async () => { model.running = false; }, pullModel: async () => {}, generate: async (_m, _messages, options) => { calls.push(options); options.onToken?.('fixture response'); return { text: 'fixture response', metrics: { model: model.id, tokensPerSecond: calls.length * 10, firstTokenMs: 30, firstOutputMs: 30, tokens: 128 } }; }, ...overrides };
  const controller = new Controller(store, adapter);
  return { store, controller, model, calls };
}
const finished = (controller, id) => new Promise(resolve => {
  const check = job => { if (job.id === id && !['queued', 'running'].includes(job.status)) { controller.off('job', check); resolve(job); } };
  controller.on('job', check); const job = controller.store.data.jobs.find(j => j.id === id); if (job) check(job);
});
test('benchmark discards warmup, stores measured samples and real median', { timeout: 3000 }, async t => {
  const { controller, store, calls } = await fixture(t);
  const job = await controller.submit({ type: 'benchmark', models: ['qwen3:0.6b'] });
  assert.equal((await finished(controller, job.id)).status, 'succeeded');
  assert.equal(calls.length, 4); assert.equal(calls[0].maxTokens, 32); assert.equal(calls[1].maxTokens, 128);
  const benchmark = store.data.benchmarks[0]; assert.equal(benchmark.samples.length, 3); assert.equal(benchmark.medianTokensPerSecond, 30); assert.equal(benchmark.digest, 'sha256:fixture');
  assert.match(benchmark.mode, /warm/); assert.equal(JSON.parse(await readFile(store.file, 'utf8')).benchmarks.length, 1);
});
test('failed loading cannot report deployment success', { timeout: 3000 }, async t => {
  const { controller } = await fixture(t, { loadModel: async () => { throw new Error('not enough memory'); } });
  const job = await controller.submit({ type: 'deploy', model: 'qwen3:0.6b' }); const done = await finished(controller, job.id);
  assert.equal(done.status, 'failed'); assert.equal(done.result, null); assert.match(done.message, /memory/);
});
test('queued jobs can be cancelled and do not reach the model', { timeout: 3000 }, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { controller, calls } = await fixture(t, { ensureRunning: () => gate });
  const first = await controller.submit({ type: 'start' });
  const queued = await controller.submit({ type: 'chat', model: 'qwen3:0.6b', prompt: 'hello' });
  await controller.cancel(queued.id); release(); await finished(controller, first.id);
  assert.equal(queued.status, 'cancelled'); assert.equal(calls.length, 0);
});
test('restarting preserves measurements and marks unfinished jobs interrupted', async t => {
  const { store } = await fixture(t); store.data.jobs.push({ id: 'unfinished', status: 'running' }); store.data.benchmarks.push({ id: 'measured' }); await store.save();
  const restored = await new Store(store.directory).init(); assert.equal(restored.data.jobs[0].status, 'interrupted'); assert.equal(restored.data.benchmarks[0].id, 'measured');
});
