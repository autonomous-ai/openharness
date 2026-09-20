// Opt-in: uses the running local harness and a real model. Changes model residency.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const workspace = resolve(process.env.HARNESS_WORKSPACE || '../../agents/ollama');
const endpoint = JSON.parse(await readFile(join(workspace, '.harness/endpoint.json'), 'utf8'));
const base = `http://127.0.0.1:${endpoint.port}`;
const model = process.env.HARNESS_TEST_MODEL || 'qwen3:0.6b';
const state = async () => (await fetch(`${base}/api/state`)).json();
const initial = await state();
const action = async body => {
  const response = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Harness-Token': initial.token }, body: JSON.stringify(body) });
  const result = await response.json(); assert.ok(response.ok, result.error);
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const { jobs } = await (await fetch(`${base}/api/jobs`)).json(); const job = jobs.find(j => j.id === result.job.id);
    if (!['queued', 'running'].includes(job.status)) { assert.equal(job.status, 'succeeded', job.message); console.log(`${body.type}: ${job.message}`); return job; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for job ${result.job.id}; inspect it before retrying.`);
};
await action({ type: 'unload', model });
assert.ok(!(await state()).runtime.models.find(m => m.id === model)?.running, 'Model is no longer resident');
await action({ type: 'deploy', model });
assert.equal((await state()).runtime.models.find(m => m.id === model)?.running, true);
const chat = await action({ type: 'chat', model, prompt: 'What is 2 + 2? Reply with just the number.' });
assert.match(chat.output.trim(), /^4[.!]?$/);
assert.ok(chat.result.metrics.tokensPerSecond > 0);
let snapshot = await state();
if (!snapshot.benchmarks.some(b => b.model === model)) { await action({ type: 'benchmark', models: [model] }); snapshot = await state(); }
const benchmark = snapshot.benchmarks.find(b => b.model === model);
assert.equal(benchmark.samples.length, 3); assert.ok(benchmark.samples.every(s => s.tokensPerSecond > 0 && s.firstTokenMs >= 0));
const evidence = { checkedAt: new Date().toISOString(), runtime: snapshot.runtime.version, hardware: snapshot.system, model: snapshot.runtime.models.find(m => m.id === model), checks: ['unload verified in runtime inventory', 'cached deployment verified resident', 'chat arithmetic sanity check', 'generation metrics present', 'three-run measured benchmark persisted'], chat: { prompt: 'What is 2 + 2? Reply with just the number.', output: chat.output, metrics: chat.result.metrics }, benchmark };
await mkdir('evidence', { recursive: true });
await writeFile('evidence/pilot-verification.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(`Verified ${model}; evidence saved in evidence/pilot-verification.json`);
