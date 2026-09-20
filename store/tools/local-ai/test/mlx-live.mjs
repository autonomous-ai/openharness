// Opt-in integration check. Uses the MLX viewer, existing HF cache and this Mac's GPU.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const packageRoot = new URL('../../../agents/mlx-lm/', import.meta.url);
const endpoint = JSON.parse(await readFile(new URL('.harness/endpoint.json', packageRoot), 'utf8'));
const base = `http://127.0.0.1:${endpoint.port}`;
const get = async path => { const res = await fetch(base + path); assert.equal(res.status, 200); return res.json(); };
const health = await get('/api/health'); assert.equal(health.runtime, 'mlx-lm');
let state = await get('/api/state'); const token = state.token;
const post = async (path, body) => { const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Harness-Token': token }, body: JSON.stringify(body) }); const value = await res.json(); assert.ok(res.ok, JSON.stringify(value)); return value; };
const wait = async (id, predicate = job => !['queued', 'running'].includes(job.status), timeout = 180000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const job = (await get('/api/jobs')).jobs.find(job => job.id === id);
    if (predicate(job)) return job;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${id}`);
};
const jobs = [];
const action = async body => {
  const { job } = await post('/api/action', body);
  const result = await wait(job.id); jobs.push(result);
  assert.equal(result.status, 'succeeded', result.message);
  console.log(`${result.type}: ${result.message}`);
  return result;
};
const model = 'mlx-community/Qwen3-0.6B-4bit';
const baseline = 'mlx-community/Qwen2.5-0.5B-Instruct-4bit';
for (const path of ['/?view=grid', '/app.js', '/styles.css', '/assets/mlx-icon.svg', '/assets/mlx-icon.png', '/favicon.ico']) assert.equal((await fetch(base + path)).status, 200, path);
await action({ type: 'deploy', model });
const chat = await action({ type: 'chat', model, prompt: 'Explain Apple Silicon unified memory in one short sentence.' });
assert.ok(chat.output.trim(), 'The model must produce visible text.');
assert.ok(chat.result.metrics.tokensPerSecond > 0);
assert.ok(chat.result.metrics.peakMemoryBytes > 0);
await action({ type: 'benchmark', models: [model, baseline] });
state = await get('/api/state');
assert.deepEqual(state.runtime.models.filter(m => m.running).map(m => m.id), [baseline], 'Switching must release the previous model.');
for (const id of [model, baseline]) {
  const result = state.benchmarks.find(b => b.model === id);
  assert.equal(result.samples.length, 3); assert.match(result.mode, /fresh prompt cache/);
  assert.equal(result.runtime.name, 'MLX-LM'); assert.equal(result.samples[0].thinking, false);
}
await action({ type: 'unload_all' });
assert.equal((await get('/api/state')).runtime.models.filter(m => m.running).length, 0);
await action({ type: 'deploy', model });
const { job: cancellable } = await post('/api/action', { type: 'chat', model, prompt: 'Write out the integers from 1 to 1000, each on a separate line. Do not stop early.' });
await wait(cancellable.id, job => job.status === 'running' && job.message.startsWith('Generating'), 30000);
await post('/api/cancel', { id: cancellable.id });
const cancelled = await wait(cancellable.id); jobs.push(cancelled); assert.equal(cancelled.status, 'cancelled');
assert.equal((await get('/api/state')).runtime.models.filter(m => m.running).length, 0);
await action({ type: 'deploy', model });
state = await get('/api/state');
assert.deepEqual(state.runtime.models.filter(m => m.running).map(m => m.id), [model]);
const output = new URL('../evidence/mlx-lm/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL('verification.json', output), JSON.stringify({ at: new Date().toISOString(), health, runtime: { ...state.runtime, models: state.runtime.models.map(({ resident, ...model }) => model) }, system: state.system, checks: ['asset routes', 'deploy', 'real streamed chat', 'native metrics', '3-sample benchmarks', 'single-model switching', 'unload', 'active cancellation releases model', 'worker recovery and reload'], jobs }, null, 2));
await writeFile(new URL('benchmarks.json', output), JSON.stringify({ at: new Date().toISOString(), benchmarks: state.benchmarks }, null, 2));
console.log('MLX live verification passed. Raw evidence saved under research/mlx-lm/.');
