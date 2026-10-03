import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson, execute, now, publishSetup, stateDir } from './fleet.mjs';

/** The same bounded OpenAI-compatible request the manager already performs,
 * with a durable receipt the Models panel can read. Credentials stay in memory. */
export async function verifyModel(workspace, machine, mode, grid, model, { run = execute, request = fetch } = {}) {
  if (!grid || !model || [grid, model].some(v => typeof v !== 'string' || v.startsWith('-') || /[\x00-\x1f]/.test(v))) throw new Error('A grid and model name are required.');
  const record = { spec: 1, id: randomUUID(), stage: 'verifying', phase: 'running', model, grid, command: 'Verify model', machine: machine.id, startedAt: now(), updatedAt: now(), pid: process.pid };
  let pending = Promise.resolve();
  const publish = () => {
    const snapshot = { ...record, updatedAt: now() };
    pending = pending.then(async () => {
      await atomicJson(join(stateDir(workspace), 'operations', `${record.id}.json`), snapshot);
      await publishSetup(workspace, snapshot);
    });
    return pending;
  };
  await publish();
  const heartbeat = setInterval(() => { void publish().catch(() => {}); }, 5000);
  heartbeat.unref();
  try {
    const info = await run(machine, [`--${mode}`, 'info', grid, '--env']);
    if (!info.ok) throw new Error('Could not read the model endpoint. Check Model Manager and retry.');
    const values = {};
    for (const match of info.stdout.matchAll(/^export\s+(OPENAI_BASE_URL|OPENAI_API_KEY)=(.*)$/gm)) {
      const value = match[2].trim();
      values[match[1]] = value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0] ? value.slice(1, -1) : value;
    }
    if (!values.OPENAI_BASE_URL || !values.OPENAI_API_KEY) throw new Error('The model endpoint is not ready yet.');
    const response = await request(`${values.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${values.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(420_000),
    });
    if (!response.ok) throw new Error(`The model did not answer successfully (HTTP ${response.status}).`);
    const answer = await response.json();
    if (!/^\s*ok[.!]?\s*$/i.test(answer?.choices?.[0]?.message?.content ?? '')) throw new Error('The model did not complete the test reply. Ask Model Manager to check it.');
    record.phase = 'done';
    await publish();
    return { ok: true, model };
  } catch (error) {
    record.phase = 'failed';
    await publish();
    // No raw response bodies, endpoint credentials or arbitrary network errors.
    throw new Error(error.name === 'TimeoutError' ? 'The model did not answer in time. Ask Model Manager to check it.' :
      /^(Could not read|The model|The model endpoint)/.test(error.message) ? error.message : 'The model check was interrupted. Ask Model Manager to retry.');
  } finally { clearInterval(heartbeat); }
}

// Acceptance for a served model, step by step, every step bounded and every wait narrated: the engine
// (ready, listed, answers, calls a tool, speed) and then, with a grid, the relay (listed, answers).
// Nothing here waits without a deadline, and nothing is reported as working that was not seen working.
const TOOL = { type: 'function', function: { name: 'read_file', description: 'Read a text file from the project', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
// chat_template_kwargs is read by llama.cpp, mlx-lm, vLLM and SGLang; Ollama documents reasoning_effort "none".
const noThinking = kind => (kind === 'ollama' ? { reasoning_effort: 'none' } : { chat_template_kwargs: { enable_thinking: false } });

export function createLog(write = line => process.stderr.write(`${line}\n`), clock = Date.now) {
  const start = clock();
  return message => write(`[+${String(Math.round((clock() - start) / 1000)).padStart(4)}s] ${message}`);
}

async function call(fetchImpl, url, { body, headers = {}, timeoutMs, log, label }) {
  const started = Date.now();
  const heartbeat = setInterval(() => log(`${label}: still waiting (${Math.round((Date.now() - started) / 1000)}s of ${Math.round(timeoutMs / 1000)}s)`), 15_000);
  try {
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text: text.slice(0, 300), seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    return { status: 0, json: null, text: error.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)}s` : error.message, seconds: (Date.now() - started) / 1000 };
  } finally { clearInterval(heartbeat); }
}

const message = json => json?.choices?.[0]?.message ?? {};
const reasoningOf = json => message(json).reasoning_content || message(json).reasoning || '';
const THINKING_ROOM = 1024;

/**
 * The one bounded "does it answer?" request. Some engines keep a model thinking whatever the request
 * says (LM Studio with a reasoning MLX model ignored every switch [run]), so 16 tokens come back as
 * reasoning only. That model still works — it answers after thinking — so ask once more with room for
 * the thinking, and say that it stays on, instead of failing a working engine.
 */
async function answerOnce(fetchImpl, url, { body, log, label, timeoutMs, headers }) {
  const first = await call(fetchImpl, url, { timeoutMs, log, label, headers, body });
  const content = (message(first.json).content ?? '').trim();
  if (content || !reasoningOf(first.json)) return { answer: first, content, thinkingStaysOn: false };
  log(`  ${label}: only thinking came back in ${body.max_tokens} tokens; asking once more with room for it (${THINKING_ROOM} tokens)`);
  const second = await call(fetchImpl, url, { timeoutMs, log, label, headers, body: { ...body, max_tokens: THINKING_ROOM } });
  return { answer: second, content: (message(second.json).content ?? '').trim(), thinkingStaysOn: true };
}

/** The engine itself, at its own `/v1` URL. */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The least context a model here may serve with: every one is for an agent (AGENTS.md step 3). */
export const MIN_CONTEXT = 65_536;
const count = value => (Number.isInteger(value) && value > 0 ? value : null);
const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
// Ollama names a model without a tag `:latest`, so `llama3` and `llama3:latest` are one model.
const ollamaName = name => (typeof name === 'string' && !name.includes(':') ? `${name}:latest` : name);

/**
 * The context the engine loaded the model with, in its own words, or null when it does not say. An
 * engine already running is adopted as it is, and its window is its owner's setting: an Ollama at 16K
 * passed every other step here and would have failed the first long prompt [run]. Read after the first
 * answer, because Ollama and LM Studio load a model on its first request.
 */
async function loadedContext({ fetchImpl, base, kind, model, row, log }) {
  const root = base.replace(/\/v1$/, '');
  const read = path => call(fetchImpl, `${root}${path}`, { timeoutMs: 5_000, log, label: 'context' });
  if (kind === 'ollama') {
    const models = (await read('/api/ps')).json?.models ?? [];
    const loaded = models.find(entry => [entry.name, entry.model].some(name => sameId(ollamaName(name), ollamaName(model))));
    return count(loaded?.context_length);
  }
  if (kind === 'lm-studio') {
    const loaded = ((await read('/api/v0/models')).json?.data ?? []).find(entry => sameId(entry.id, model));
    return count(loaded?.loaded_context_length);
  }
  // llama-server reports one request slot's window: --ctx-size divided by --parallel.
  if (kind === 'llama.cpp') return count((await read('/props')).json?.default_generation_settings?.n_ctx);
  // vLLM and SGLang list the window they were started with beside the model.
  return count(row?.max_model_len);
}

const CONTEXT_FIX = {
  ollama: 'this Ollama runs every model with that window; leave theirs as it is and start a second Ollama with OLLAMA_CONTEXT_LENGTH (skills/engine-ollama)',
  'lm-studio': `load it again with \`lms load MODEL --context-length ${MIN_CONTEXT}\` or more (skills/engine-lm-studio)`,
  'llama.cpp': `one you started: start it again with --ctx-size ${MIN_CONTEXT} or more for each request slot (--ctx-size ÷ --parallel); one already running when you came is the person's: ask before serving its file a second time`,
  vllm: `start it again with --max-model-len ${MIN_CONTEXT} or more (skills/engine-vllm)`,
  sglang: `start it again with --context-length ${MIN_CONTEXT} or more (skills/engine-sglang)`,
};

export async function verifyEngine({ url, model, kind, readyMs = 180_000, answerMs = 300_000, tools = true, fetchImpl = globalThis.fetch, log = createLog(), sleep = wait }) {
  const base = url.replace(/\/+$/, '');
  const steps = [];
  const record = (name, ok, detail) => { steps.push({ name, ok, ...detail }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail.note ? ` — ${detail.note}` : ''}`); return ok; };
  if (!/\/v1$/.test(base)) return { ok: false, steps: [{ name: 'url', ok: false, note: 'the URL must end in /v1' }] };

  log(`step 1/5 ready: GET ${base}/models (up to ${readyMs / 1000}s, every 3s)`);
  const deadline = Date.now() + readyMs;
  let listed = null, rows = [], attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const models = await call(fetchImpl, `${base}/models`, { timeoutMs: 5_000, log, label: 'models' });
    const ids = (models.json?.data ?? []).map(row => row.id);
    if (models.status === 200) { listed = ids; rows = models.json?.data ?? []; break; }
    if (attempt === 1 || attempt % 5 === 0) log(`  attempt ${attempt}: ${models.status || models.text}`);
    await sleep(3_000);
  }
  if (!record('ready', listed !== null, { note: listed === null ? `no 200 from /models within ${readyMs / 1000}s` : `${listed.length} model(s) listed` })) return { ok: false, steps };
  if (!record('listed', listed.includes(model), { note: listed.includes(model) ? model : `${model} not in ${JSON.stringify(listed.slice(0, 8))}` })) return { ok: false, steps };

  log(`step 2/5 answer: one request, max_tokens 16, thinking off (up to ${answerMs / 1000}s)`);
  const { answer, content, thinkingStaysOn } = await answerOnce(fetchImpl, `${base}/chat/completions`, { timeoutMs: answerMs, log, label: 'answer', body: {
    model, max_tokens: 16, temperature: 0, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], ...noThinking(kind) } });
  const thinkingOnly = !content && reasoningOf(answer.json);
  if (!record('answer', Boolean(content), { seconds: answer.seconds, note: content
    ? `${JSON.stringify(content.slice(0, 40))}${thinkingStaysOn ? ` — thinking stays on here: it answers after thinking, slower and with more tokens` : ''}`
    : thinkingOnly ? `only reasoning text came back, even with ${THINKING_ROOM} tokens: thinking is still on` : `HTTP ${answer.status}: ${answer.text}` })) return { ok: false, steps };

  log(`step 3/5 context: the window the engine loaded the model with (at least ${MIN_CONTEXT})`);
  const context = await loadedContext({ fetchImpl, base, kind, model, row: rows.find(row => row.id === model), log });
  if (context === null) {
    // Not seen, so not passed: said as a skip, and the person's own setting stays the word on it.
    steps.push({ name: 'context', ok: true, skipped: true, note: `${kind || 'this engine'} does not report it` });
    log(`SKIP context — ${kind || 'this engine'} does not report the window it loaded; say so rather than call it checked`);
  } else if (!record('context', context >= MIN_CONTEXT, { contextTokens: context, note: context >= MIN_CONTEXT
    ? `${context} tokens`
    : `${context} tokens, under ${MIN_CONTEXT}: ${CONTEXT_FIX[kind] ?? `start it again with at least ${MIN_CONTEXT}`}` })) return { ok: false, steps };

  if (tools) {
    log('step 4/5 tool call: a read_file tool, "Open the file README.md."');
    const tool = await call(fetchImpl, `${base}/chat/completions`, { timeoutMs: answerMs, log, label: 'tool call', body: {
      model, max_tokens: 256, temperature: 0, tools: [TOOL], messages: [{ role: 'user', content: 'Open the file README.md.' }], ...noThinking(kind) } });
    const called = message(tool.json).tool_calls?.[0]?.function;
    if (!record('tool call', called?.name === 'read_file', { seconds: tool.seconds, note: called ? `${called.name}(${called.arguments})` : `no tool_calls; HTTP ${tool.status}` })) return { ok: false, steps };
  } else log('step 4/5 tool call: skipped');

  log('step 5/5 speed: 128 tokens');
  const speed = await call(fetchImpl, `${base}/chat/completions`, { timeoutMs: answerMs, log, label: 'speed', body: {
    model, max_tokens: 128, temperature: 0, messages: [{ role: 'user', content: 'Count from 1 to 60 in words.' }], ...noThinking(kind) } });
  const reported = speed.json?.timings?.predicted_per_second;
  const tokens = speed.json?.usage?.completion_tokens;
  const perSecond = reported ?? (tokens ? tokens / speed.seconds : null);
  record('speed', perSecond !== null, { seconds: speed.seconds, tokensPerSecond: perSecond && Math.round(perSecond * 10) / 10,
    note: perSecond ? `${perSecond.toFixed(1)} tokens/s${reported ? ' (engine timing)' : ' (wall clock, includes reading the prompt)'}` : `HTTP ${speed.status}` });
  return { ok: steps.every(step => step.ok), steps };
}

/**
 * Why `verify --grid --alias` alone may not check this alias, or null. That form is for an engine on
 * another machine, which has no URL here to check; for one served from this computer it skips every
 * engine step, context included, and an agent that had just seen `FAIL context` ran it to get a pass
 * [run]. `rows` are `grid models` rows, whose `node` is the machine name every join is given.
 */
export function relayOnlyRefusal(rows, alias, localName) {
  const here = (Array.isArray(rows) ? rows : []).find(row => sameId(row?.model ?? row?.id, alias) && localName && row?.node === localName);
  return here ? `${alias} is served from this computer (${localName}): check its engine with --at http://127.0.0.1:PORT/v1 --model ID --kind ENGINE as well. --grid with --alias alone is for an engine on another machine.` : null;
}

/** After a join: the relay must list the alias, then answer through the grid's own endpoint. */
export async function verifyRelay({ alias, engineModel, listModels, relay, listMs = 300_000, answerMs = 420_000, fetchImpl = globalThis.fetch, log = createLog(), sleep = wait }) {
  const steps = [];
  const record = (name, ok, detail) => { steps.push({ name, ok, ...detail }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail.note ? ` — ${detail.note}` : ''}`); return ok; };
  log(`relay 1/2 listed: grid models, every 10s, up to ${listMs / 1000}s`);
  const deadline = Date.now() + listMs;
  let seen = false, attempt = 0, last = '';
  // The relay changes a name's case (an alias given in lower case came back upper case, and the other
  // way round), so names match whatever their case [run: 5 minutes lost waiting on a case difference].
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  while (Date.now() < deadline) {
    attempt++;
    const listed = await listModels();
    const found = listed.ok && listed.models.find(name => same(name, alias));
    if (found) { seen = true; alias = found; break; }
    // Registered under the engine's own id: waiting cannot fix a missing --advertise-as [run: 5 minutes lost].
    const raw = listed.ok && engineModel && listed.models.find(name => same(name, engineModel));
    if (raw) return (record('relay listed', false, { note: `listed as ${raw}, not ${alias}: join again with --advertise-as ${alias}` }), { ok: false, steps });
    last = listed.ok ? `${listed.models.length} model(s), not yet ${alias}: ${listed.models.slice(0, 5).map(name => String(name).slice(0, 60)).join(', ') || 'none'}` : listed.error;
    log(`  attempt ${attempt}: ${last}`);
    await sleep(10_000);
  }
  if (!record('relay listed', seen, { note: seen ? alias : `not listed within ${listMs / 1000}s (${last})` })) return { ok: false, steps };
  log(`relay 2/2 answer through the grid (up to ${answerMs / 1000}s: a new engine is probed first and may hold its slot for minutes)`);
  const { answer, content, thinkingStaysOn } = await answerOnce(fetchImpl, `${relay.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    timeoutMs: answerMs, log, label: 'relay answer', headers: relay.apiKey ? { authorization: `Bearer ${relay.apiKey}` } : {},
    body: { model: alias, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], ...noThinking() } });
  record('relay answer', Boolean(content), { seconds: answer.seconds, note: content
    ? `${JSON.stringify(content.slice(0, 40))}${thinkingStaysOn ? ' — thinking stays on' : ''}` : `HTTP ${answer.status}: ${answer.text}` });
  return { ok: steps.every(step => step.ok), steps };
}
