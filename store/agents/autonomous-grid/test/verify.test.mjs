import test from 'node:test';
import assert from 'node:assert/strict';
import { createLog, relayOnlyRefusal, verifyEngine, verifyRelay } from '../lib/verify.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const quiet = () => {};
const instant = async () => {};

function engine({ bootFailures = 1, content = 'ok', reasoning = '', toolCall = true, seen = [], thinksFirst = false, row = { id: 'widget' }, reports = {} } = {}) {
  let boots = 0;
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ url, body });
    // An engine's own report of what it loaded (Ollama /api/ps, LM Studio /api/v0/models, llama.cpp /props).
    const path = new URL(url).pathname;
    if (path in reports) return json(reports[path]);
    if (!path.startsWith('/v1/')) return new Response('not found', { status: 404 });
    if (url.endsWith('/models')) return boots++ < bootFailures ? new Response('loading', { status: 503 }) : json({ data: [row] });
    if (body.tools) return json({ choices: [{ message: toolCall ? { tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } : { content: 'I cannot' } }] });
    if (body.max_tokens === 128) return json({ usage: { completion_tokens: 128 }, timings: { predicted_per_second: 21.5 }, choices: [{ message: { content: 'one two' } }] });
    // A model an engine keeps thinking: 16 tokens are all reasoning, a larger budget reaches the answer.
    if (thinksFirst) return json({ choices: [{ message: body.max_tokens > 16 ? { content: 'ok', reasoning_content: 'hmm' } : { content: '', reasoning_content: 'hmm' } }] });
    return json({ choices: [{ message: { content, reasoning_content: reasoning } }] });
  };
}

test('an engine passes only after ready, listed, a real answer, a tool call and a speed reading, each narrated', async () => {
  const lines = [], seen = [];
  const result = await verifyEngine({ url: 'http://127.0.0.1:9/v1', model: 'widget', fetchImpl: engine({ seen }), log: createLog(line => lines.push(line)), sleep: instant });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map(step => step.name), ['ready', 'listed', 'answer', 'context', 'tool call', 'speed']);
  assert.equal(result.steps.at(-1).tokensPerSecond, 21.5);
  assert.ok(lines.some(line => /attempt 1: 503/.test(line)), 'a failed readiness attempt is shown, not hidden');
  assert.ok(lines.every(line => /^\[\+\s*\d+s\]/.test(line)), 'every line carries elapsed time');
  assert.deepEqual(seen.find(call => call.body?.max_tokens === 16).body.chat_template_kwargs, { enable_thinking: false });
});

test('a model that always thinks first passes once it answers with room to think, and says thinking stays on', async () => {
  const lines = [], seen = [];
  const result = await verifyEngine({ url: 'http://127.0.0.1:9/v1', model: 'widget', fetchImpl: engine({ bootFailures: 0, thinksFirst: true, seen }), log: createLog(line => lines.push(line)), sleep: instant });
  const answer = result.steps.find(step => step.name === 'answer');
  assert.equal(answer.ok, true);
  assert.match(answer.note, /"ok" — thinking stays on here/);
  assert.ok(lines.some(line => /only thinking came back in 16 tokens; asking once more with room for it \(1024 tokens\)/.test(line)));
  assert.deepEqual(seen.filter(call => call.body?.messages?.[0]?.content?.startsWith('Reply')).map(call => call.body.max_tokens), [16, 1024]);
});

test('thinking-only output, a missing tool call and a URL without /v1 each fail with the reason', async () => {
  const thinking = await verifyEngine({ url: 'http://127.0.0.1:9/v1', model: 'widget', fetchImpl: engine({ bootFailures: 0, content: '', reasoning: 'Let me think' }), log: quiet, sleep: instant });
  assert.equal(thinking.ok, false);
  assert.match(thinking.steps.at(-1).note, /thinking is still on/);
  const noTool = await verifyEngine({ url: 'http://127.0.0.1:9/v1', model: 'widget', fetchImpl: engine({ bootFailures: 0, toolCall: false }), log: quiet, sleep: instant });
  assert.equal(noTool.steps.at(-1).name, 'tool call');
  assert.equal(noTool.ok, false);
  const root = await verifyEngine({ url: 'http://127.0.0.1:9', model: 'widget', fetchImpl: engine(), log: quiet, sleep: instant });
  assert.match(root.steps[0].note, /must end in \/v1/);
});

test('Ollama gets its documented thinking switch; readiness gives up at its deadline', async () => {
  const seen = [];
  await verifyEngine({ url: 'http://127.0.0.1:9/v1', model: 'widget', kind: 'ollama', fetchImpl: engine({ bootFailures: 0, seen }), log: quiet, sleep: instant });
  assert.equal(seen.find(call => call.body?.max_tokens === 16).body.reasoning_effort, 'none');
  const never = await verifyEngine({ url: 'http://127.0.0.1:9/v1', model: 'widget', readyMs: 30, fetchImpl: engine({ bootFailures: Infinity }), log: quiet, sleep: instant });
  assert.equal(never.ok, false);
  assert.match(never.steps[0].note, /within/);
});

test('the relay must list the alias before one bounded answer through the grid counts', async () => {
  let polls = 0;
  const listModels = async () => ({ ok: true, models: ++polls < 3 ? ['other'] : ['other', 'widget-alias'] });
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer key');
    return json({ choices: [{ message: { content: 'ok' } }] });
  };
  const lines = [];
  const result = await verifyRelay({ alias: 'widget-alias', listModels, relay: { baseUrl: 'https://relay.test/v1', apiKey: 'key' }, fetchImpl, log: line => lines.push(line), sleep: instant });
  assert.equal(result.ok, true);
  assert.equal(polls, 3);
  assert.equal(lines.filter(line => /attempt \d+: .*not yet widget-alias/.test(line)).length, 2);
  const missing = await verifyRelay({ alias: 'gone', listModels: async () => ({ ok: true, models: [] }), relay: { baseUrl: 'https://relay.test/v1' }, listMs: 20, fetchImpl, log: quiet, sleep: instant });
  assert.equal(missing.ok, false);
});

test('a model registered under its raw id fails at once with the fix, instead of waiting out the deadline', async () => {
  let polls = 0;
  const result = await verifyRelay({
    alias: 'Coder', engineModel: '/Users/me/.cache/hub/snap', relay: { baseUrl: 'https://relay.test/v1' }, log: quiet, sleep: instant,
    listModels: async () => { polls++; return { ok: true, models: ['/users/me/.cache/hub/snap'] }; },
  });
  assert.equal(result.ok, false);
  assert.equal(polls, 1);
  assert.match(result.steps[0].note, /listed as \/users\/me\/\.cache\/hub\/snap, not Coder: join again with --advertise-as Coder/);
});

test('an alias the relay lists in another case passes at once, and is asked by the listed name', async () => {
  let polls = 0, asked = null;
  const result = await verifyRelay({
    alias: 'lfm2.5-vl-3b', relay: { baseUrl: 'https://relay.test/v1' }, log: quiet, sleep: instant,
    listModels: async () => { polls++; return { ok: true, models: ['LFM2.5-VL-3B', 'Qwen3-0.6B'] }; },
    fetchImpl: async (url, init) => { asked = JSON.parse(init.body).model; return json({ choices: [{ message: { content: 'ok' } }] }); },
  });
  assert.equal(result.ok, true);
  assert.equal(polls, 1);
  assert.equal(asked, 'LFM2.5-VL-3B');
});

test('an Ollama already running with a short window fails on context, with the fix, before anything is called working', async () => {
  const lines = [];
  const reports = { '/api/ps': { models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b', context_length: 16384 }] } };
  const result = await verifyEngine({ url: 'http://127.0.0.1:11434/v1', model: 'llama3.2:3b', kind: 'ollama', fetchImpl: engine({ bootFailures: 0, row: { id: 'llama3.2:3b' }, reports }), log: createLog(line => lines.push(line)), sleep: instant });
  assert.equal(result.ok, false);
  const context = result.steps.at(-1);
  assert.equal(context.name, 'context');
  assert.equal(context.contextTokens, 16384);
  assert.match(context.note, /16384 tokens, under 65536: .*start a second Ollama with OLLAMA_CONTEXT_LENGTH/);
  assert.ok(!result.steps.some(step => step.name === 'speed'), 'nothing after a failed step');
  assert.ok(lines.some(line => /FAIL context/.test(line)));
});

test('each engine is read where it reports its window: Ollama by name or :latest, LM Studio, llama.cpp, vLLM', async () => {
  const run = (kind, model, options) => verifyEngine({ url: 'http://127.0.0.1:9/v1', model, kind, fetchImpl: engine({ bootFailures: 0, row: { id: model }, ...options }), log: quiet, sleep: instant });
  const ollama = await run('ollama', 'qwen3', { reports: { '/api/ps': { models: [{ name: 'qwen3:latest', context_length: 131072 }] } } });
  assert.equal(ollama.steps.find(step => step.name === 'context').contextTokens, 131072);
  assert.equal(ollama.ok, true);
  const lmStudio = await run('lm-studio', 'google/gemma-4-e2b', { reports: { '/api/v0/models': { data: [{ id: 'google/gemma-4-e2b', state: 'loaded', max_context_length: 131072, loaded_context_length: 4096 }] } } });
  assert.match(lmStudio.steps.at(-1).note, /4096 tokens, under 65536: load it again with `lms load MODEL --context-length 65536`/);
  const llamaCpp = await run('llama.cpp', 'widget', { reports: { '/props': { default_generation_settings: { n_ctx: 32768 } } } });
  assert.match(llamaCpp.steps.at(-1).note, /32768 tokens, under 65536: .*--ctx-size ÷ --parallel/);
  const vllm = await run('vllm', 'org/model', { row: { id: 'org/model', max_model_len: 65536 } });
  assert.equal(vllm.ok, true);
  assert.equal(vllm.steps.find(step => step.name === 'context').note, '65536 tokens');
});

test('an engine that does not report its window is a skip, said as one, never a pass', async () => {
  const lines = [];
  const result = await verifyEngine({ url: 'http://127.0.0.1:9/v1', model: 'widget', kind: 'mlx-lm', fetchImpl: engine({ bootFailures: 0 }), log: createLog(line => lines.push(line)), sleep: instant });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.find(step => step.name === 'context'), { name: 'context', ok: true, skipped: true, note: 'mlx-lm does not report it' });
  assert.ok(lines.some(line => /SKIP context — mlx-lm does not report/.test(line)));
  assert.ok(!lines.some(line => /PASS context/.test(line)));
});

test('the grid-only check refuses a model served from this computer, which has an engine to check', () => {
  const rows = [{ model: 'gemma-4-e2b', engine: 'external', node: 'Studio Mac' }, { model: 'Big-Model', node: 'GPU rig' }];
  assert.match(relayOnlyRefusal(rows, 'GEMMA-4-E2B', 'Studio Mac'), /served from this computer \(Studio Mac\): check its engine with --at/);
  assert.equal(relayOnlyRefusal(rows, 'Big-Model', 'Studio Mac'), null, 'an engine on another machine is what --grid alone is for');
  assert.equal(relayOnlyRefusal(rows, 'gemma-4-e2b', undefined), null, 'no name for this computer: nothing to compare');
  assert.equal(relayOnlyRefusal({ error: 'not a list' }, 'gemma-4-e2b', 'Studio Mac'), null);
});
