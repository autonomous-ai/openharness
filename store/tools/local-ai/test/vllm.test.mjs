import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VLLM_PROFILE, validateVllmAction, validateServing, readCompletion, parsePrometheus } from '../src/vllm.mjs';
import { Controller } from '../src/controller.mjs';
import { Store } from '../src/store.mjs';

test('vLLM serving controls are bounded and explicit; prompts cannot become operations', () => {
  const model = VLLM_PROFILE.defaultModel;
  assert.equal(validateVllmAction({ type: 'serve', model, memoryFraction: 0.1 }).memoryFraction, 0.1);
  assert.deepEqual(validateVllmAction({ type: 'load_test', model }), { type: 'load_test', model, concurrency: 4, requests: 8 });
  for (const input of [{ context: 1 }, { context: '4096' }, { maxSequences: 9 }, { memoryFraction: 0.9 }, { prefixCaching: 'false' }]) assert.throws(() => validateServing(input));
  assert.throws(() => validateVllmAction({ type: 'serve', model, host: '0.0.0.0' }), /Unknown/);
  assert.throws(() => validateVllmAction({ type: 'load_test', model, concurrency: 9 }));
  assert.throws(() => validateVllmAction({ type: 'load_test', model, concurrency: 4, requests: 2 }));
  assert.throws(() => validateVllmAction({ type: 'serve', model: '../../file' }));
  const options = { profile: VLLM_PROFILE, models: [{ id: model, running: true }] };
  assert.equal(VLLM_PROFILE.resolveIntent('test 4 concurrent requests', options).action.type, 'load_test');
  assert.equal(VLLM_PROFILE.resolveIntent('ask it: test 4 concurrent requests', options).action.type, 'chat');
  assert.equal(VLLM_PROFILE.resolveIntent('do not benchmark it', options).kind, 'reply');
  assert.equal(VLLM_PROFILE.resolveIntent('explain how to benchmark it', options).kind, 'reply');
});

const stream = async function* (text, length = 1) { const bytes = Buffer.from(text); for (let offset = 0; offset < bytes.length; offset += length) yield bytes.subarray(offset, offset + length); };
test('OpenAI streams count native tokens and decode UTF-8 across arbitrary boundaries', async () => {
  const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
  const input = event({ choices: [{ delta: { reasoning_content: 'think' } }] }) + event({ choices: [{ delta: { content: '👋 héllo' } }] }) + event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 6, prompt_tokens: 12 } }) + 'data: [DONE]\r\n\r\n';
  let output = ''; let clock = 0;
  const result = await readCompletion(stream(input), text => { output += text; }, () => clock += 10);
  assert.equal(result.text, '👋 héllo'); assert.equal(output, result.text); assert.equal(result.usage.completion_tokens, 6);
  assert.equal(result.firstTokenMs, 10); assert.equal(result.firstOutputMs, 20); assert.equal(result.finishReason, 'stop');
  await assert.rejects(readCompletion(stream('data: [DONE]\n\n')), /missing token usage/);
  await assert.rejects(readCompletion(stream(event({ usage: { completion_tokens: 4, prompt_tokens: 3 } }))), /incomplete stream/);
  await assert.rejects(readCompletion(stream(event({ error: { message: 'failed' } }))), /failed/);
});

test('server gauges remain unknown when telemetry is missing', () => {
  assert.equal(parsePrometheus('# no samples').cacheUsage, null);
  assert.deepEqual(parsePrometheus('vllm:num_requests_running{model_name="x"} 2\nvllm:num_requests_waiting{model_name="x"} 1\nvllm:kv_cache_usage_perc{model_name="x"} 0.25').runningRequests, 2);
});

test('concurrent test actually overlaps requests and retains failed samples', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vllm-concurrency-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).init(); const model = VLLM_PROFILE.defaultModel;
  let active = 0; let peak = 0; let calls = 0; let loaded = false;
  const adapter = {
    async discover() { return { online: true, version: 'fixture', models: [{ id: model, running: loaded }], serving: { context: 1024, maxSequences: 4 } }; },
    async ensureRunning() {}, async localModelDetails() {}, async loadModel() { loaded = true; },
    async generate() {
      calls++; const index = calls; active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 10)); if (index === 3) throw new Error('fixture failure'); return { metrics: { model, tokens: 20, totalMs: 10, firstTokenMs: 2, tokensPerSecond: 2000 } }; }
      finally { active--; }
    },
  };
  const controller = new Controller(store, adapter, VLLM_PROFILE);
  const job = await controller.submit({ type: 'load_test', model, concurrency: 4, requests: 8 });
  while (['queued', 'running'].includes(job.status)) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(job.status, 'succeeded'); assert.equal(peak, 4); assert.equal(calls, 9);
  const result = store.data.loadTests[0]; assert.equal(result.samples.length, 8); assert.equal(result.failed, 1); assert.equal(result.succeeded, 7); assert.equal(result.settings.context, 1024);
  assert.equal(result.samples[1].error, 'fixture failure'); assert.equal(result.aggregateTokensPerSecond, 140 / (result.totalMs / 1000));
  assert.equal((await new Store(directory).init()).data.loadTests[0].id, result.id);
  await controller.close();
});
