import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonWorker } from './json-worker.mjs';
import { MLX_CATALOG, validateMlxModel } from './mlx.mjs';
import { resolveIntent, validateAction } from './intents.mjs';

export const DEFAULT_SERVING = Object.freeze({ context: 4096, maxSequences: 4, memoryFraction: 0.1, prefixCaching: true });
const bounded = (value, name, min, max, integer = true) => {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) throw new Error(`${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  return value;
};
export function validateServing(input = {}, base = DEFAULT_SERVING) {
  const config = { ...base };
  if (input.context !== undefined) config.context = bounded(input.context, 'Context', 512, 16384);
  if (input.maxSequences !== undefined) config.maxSequences = bounded(input.maxSequences, 'Parallel sequences', 1, 8);
  if (input.memoryFraction !== undefined) config.memoryFraction = bounded(input.memoryFraction, 'Metal memory fraction', 0.05, 0.8, false);
  if (input.prefixCaching !== undefined) {
    if (typeof input.prefixCaching !== 'boolean') throw new Error('Prefix caching must be true or false.');
    config.prefixCaching = input.prefixCaching;
  }
  return config;
}
export function validateVllmAction(input) {
  if (!input || !['serve', 'load_test'].includes(input.type)) return validateAction(input, validateMlxModel);
  const action = { type: input.type, model: validateMlxModel(input.model) };
  if (input.type === 'serve') {
    const allowed = ['type', 'model', ...Object.keys(DEFAULT_SERVING)];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unknown serving setting.');
    validateServing(input);
    for (const key of Object.keys(DEFAULT_SERVING)) if (input[key] !== undefined) action[key] = input[key];
  } else {
    if (Object.keys(input).some(key => !['type', 'model', 'concurrency', 'requests'].includes(key))) throw new Error('Unknown load-test setting.');
    action.concurrency = bounded(input.concurrency ?? 4, 'Concurrency', 1, 8);
    action.requests = bounded(input.requests ?? 8, 'Requests', action.concurrency, 32);
  }
  return action;
}
export const VLLM_PROFILE = {
  id: 'vllm', name: 'vLLM', catalog: MLX_CATALOG, defaultModel: MLX_CATALOG[0].id,
  preserveServingConfig: true,
  validateModel: validateMlxModel, validateAction: validateVllmAction,
  modelPattern: /\b[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\b/g,
  help: 'Try “run a lightweight model”, “benchmark it”, “test 4 concurrent requests”, or “free up memory”. Ask the agent to change context, parallel sequences, Metal memory budget or prefix caching.',
  benchmarkMode: 'warm server; repeated prompt may use prefix cache; client end-to-end token throughput, including prompt processing and HTTP',
  readyMessage: 'This workspace owns one vLLM server using the Metal backend. Idle servers stop after 15 minutes.',
  resolveIntent(text, options) {
    const match = typeof text === 'string' && text.trim().match(/^(?:please )?(?:test|benchmark) (\d+) concurrent requests[.!?]?$/i);
    if (match) {
      const model = options.selectedModel || options.models.find(m => m.running)?.id;
      return model ? { kind: 'action', action: { type: 'load_test', model, concurrency: Number(match[1]), requests: Math.max(8, Number(match[1])) } } : { kind: 'reply', message: 'Load or select a model first.' };
    }
    if (typeof text === 'string' && /^(?:please )?start vllm[.!?]?$/i.test(text.trim())) return { kind: 'action', action: { type: 'start' } };
    return resolveIntent(text, options);
  },
};

// Decode streaming UTF-8 before splitting frames. Chunk boundaries are not tokens.
export async function readCompletion(body, onToken = () => {}, now = () => performance.now()) {
  const start = now(); const decoder = new TextDecoder(); let buffer = ''; let text = ''; let usage; let finishReason; let firstTokenMs = null; let firstOutputMs = null; let done = false;
  const frame = data => {
    if (data === '[DONE]') { done = true; return; }
    const event = JSON.parse(data);
    if (event.error) throw new Error(event.error.message || 'vLLM generation failed.');
    if (event.usage) usage = event.usage;
    for (const choice of event.choices || []) {
      const delta = choice.delta || {};
      const content = delta.content || '';
      const reasoning = delta.reasoning_content || delta.reasoning || '';
      if ((content.length || reasoning.length) && firstTokenMs === null) firstTokenMs = now() - start;
      if (/\S/.test(content) && firstOutputMs === null) firstOutputMs = now() - start;
      if (content) { text += content; onToken(content); }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  };
  const consume = () => {
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) frame(data);
    }
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Oversized vLLM stream frame.');
  };
  for await (const bytes of body) { buffer += decoder.decode(bytes, { stream: true }).replace(/\r/g, ''); consume(); }
  buffer += decoder.decode(); consume();
  if (!done || !Number.isInteger(usage?.completion_tokens) || !Number.isInteger(usage?.prompt_tokens)) throw new Error('vLLM returned an incomplete stream or missing token usage; no measurement was recorded.');
  return { text, usage, firstTokenMs, firstOutputMs, finishReason };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
export function parsePrometheus(text) {
  const sums = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^(vllm:[a-z_]+)(?:\{.*\})?\s+([\d.eE+-]+)$/);
    if (match && Number.isFinite(Number(match[2]))) sums[match[1]] = (sums[match[1]] || 0) + Number(match[2]);
  }
  return { runningRequests: sums['vllm:num_requests_running'] ?? null, waitingRequests: sums['vllm:num_requests_waiting'] ?? null, cacheUsage: sums['vllm:kv_cache_usage_perc'] ?? null, prefixQueries: sums['vllm:prefix_cache_queries_total'] ?? null, prefixHits: sums['vllm:prefix_cache_hits_total'] ?? null };
}
export class VllmAdapter {
  constructor({ packageRoot, dataDir, python } = {}) {
    Object.assign(this, { packageRoot, dataDir }); this.python = python || join(packageRoot, '.venv/bin/python');
    this.worker = new JsonWorker({ python: this.python, script: join(packageRoot, 'cache.py'), directory: dataDir, name: 'vLLM model cache', env: { HARNESS_MODEL_REGISTRY: join(dataDir, 'vllm-models.json'), HF_HUB_DISABLE_TELEMETRY: '1' } });
    this.config = { ...DEFAULT_SERVING }; this.server = null; this.loaded = null; this.inflight = 0; this.closed = false; this.expiresAt = null;
  }
  async ensureRunning(_directory, { signal } = {}) { signal?.throwIfAborted(); if (this.closed) throw new Error('vLLM is closing.'); await this.worker.start(); signal?.throwIfAborted(); }
  async discover() {
    try {
      await this.ensureRunning();
      if (this.loaded && !this.inflight && Date.now() > this.expiresAt) await this.stopServer();
      // Avoid putting inventory requests behind a long model download.
      if (!this.worker.pending.size) await this.worker.request('inventory', {}, { timeout: 10000 });
      let rss = null; let metrics = {};
      if (this.loaded && this.server) {
        const record = this.server;
        try {
          metrics = parsePrometheus(await (await this.fetchNative('/metrics', { signal: AbortSignal.timeout(1500) }, record)).text());
          if (!this.worker.pending.size) rss = (await this.worker.request('memory', { pid: record.child.pid }, { timeout: 5000 })).rssBytes;
        } catch {} // Scrape delay does not change server health or invent measurements.
      }
      const versions = this.worker.state.versions;
      const models = (this.worker.state.models || []).map(model => ({ ...model, running: model.id === this.loaded, resident: model.id === this.loaded ? { size: rss, context_length: this.config.context, expires_at: new Date(this.expiresAt).toISOString() } : null }));
      return { id: 'vllm', name: 'vLLM', online: true, version: versions?.vllm, backend: 'Metal', backendVersion: versions?.['vllm-metal'], mlxVersion: versions?.mlx, models, serving: { ...this.config, status: this.loaded ? 'serving' : this.server ? 'starting' : 'idle', model: this.loaded, processRssBytes: rss, ...metrics } };
    } catch (error) { return { id: 'vllm', name: 'vLLM', online: false, models: [], error: error.message, backend: 'Metal', serving: { ...this.config, status: 'offline' } }; }
  }
  async localModelDetails(model, { signal } = {}) { return this.worker.request('details', { model: validateMlxModel(model) }, { signal }); }
  async pullModel(model, { signal, onProgress = () => {} } = {}) {
    return this.worker.request('download', { model: validateMlxModel(model), memoryBudget: Math.floor(totalmem() * 0.8) }, { signal, timeout: 2 * 60 * 60 * 1000, onEvent: event => { if (event.event === 'progress') onProgress(event.message, event.percent, { completed: event.completed, total: event.total }); } });
  }
  async fetchNative(path, options = {}, record = this.server) {
    if (!record) throw new Error('The vLLM server is not running.');
    const response = await fetch(`http://127.0.0.1:${record.port}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${record.key}`, ...options.headers } });
    if (!response.ok) throw new Error(`vLLM HTTP ${response.status}: ${(await response.text()).slice(0, 700)}`);
    return response;
  }
  async loadModel(model, options = {}) {
    const config = validateServing(options, this.config); validateMlxModel(model); options.signal?.throwIfAborted();
    if (this.loaded === model && JSON.stringify(config) === JSON.stringify(this.config)) { this.touch(); return; }
    if (this.inflight) throw new Error('Wait for current requests before changing the server.');
    await this.stopServer();
    if (this.closed) throw new Error('vLLM is closing.');
    const details = await this.localModelDetails(model, options);
    const port = await freePort(); const key = randomBytes(32).toString('hex');
    await mkdir(this.dataDir, { recursive: true });
    const log = await open(join(this.dataDir, 'vllm.log'), 'a', 0o600);
    const args = ['-u', join(this.packageRoot, 'server.py'), 'serve', details.path, '--host', '127.0.0.1', '--port', String(port), '--served-model-name', model, '--tokenizer', details.path, '--max-model-len', String(config.context), '--max-num-seqs', String(config.maxSequences), '--max-num-batched-tokens', String(config.context), '--gpu-memory-utilization', String(config.memoryFraction), config.prefixCaching ? '--enable-prefix-caching' : '--no-enable-prefix-caching', '--middleware', 'guard.LocalOnlyMiddleware'];
    if (details.family === 'qwen3') args.push('--reasoning-parser', 'qwen3');
    options.signal?.throwIfAborted();
    const child = spawn(this.python, args, { detached: true, stdio: ['ignore', log.fd, log.fd], cwd: this.packageRoot, env: { ...process.env, PYTHONPATH: this.packageRoot, VLLM_API_KEY: key, HARNESS_VLLM_PORT: String(port), HARNESS_PARENT_PID: String(process.pid), HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false', VLLM_NO_USAGE_STATS: '1', DO_NOT_TRACK: '1', VLLM_METAL_MEMORY_FRACTION: 'auto', VLLM_MLX_DEVICE: 'gpu' } });
    const record = { child, port, key, exited: false, error: null };
    record.exit = new Promise(resolve => { child.once('error', error => { record.error = error; }); child.once('close', () => { record.exited = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } if (this.server === record) { this.server = null; this.loaded = null; } resolve(); }); });
    this.server = record; this.config = config; await log.close();
    const abort = () => { void this.stopServer(record); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        if (record.exited) {
          const tail = (await readFile(join(this.dataDir, 'vllm.log'), 'utf8')).slice(-2500);
          throw new Error(`vLLM did not start. ${record.error?.message || tail}`);
        }
        try {
          const response = await this.fetchNative('/v1/models', { signal: AbortSignal.timeout(1000) }, record);
          const inventory = await response.json();
          if (inventory.data?.some(item => item.id === model)) { options.signal?.throwIfAborted(); this.loaded = model; this.touch(); return; }
        } catch (error) { if (options.signal?.aborted) throw error; }
        await delay(300, undefined, { signal: options.signal });
      }
      throw new Error('vLLM startup exceeded three minutes. Check .harness/vllm.log.');
    } catch (error) { await this.stopServer(record); throw error; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }
  touch() { this.expiresAt = Date.now() + 15 * 60 * 1000; }
  async stopServer(record = this.server) {
    if (!record) return;
    if (record.stopping) return record.stopping;
    if (this.server === record) this.loaded = null;
    record.stopping = (async () => {
      // Only this detached, harness-owned process group is eligible for termination.
      const kill = signal => { if (!record.child.pid) return; try { process.kill(-record.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      if (!record.exited) kill('SIGTERM');
      const timer = setTimeout(() => { try { kill('SIGKILL'); } catch {} }, 4000);
      try { await record.exit; } finally { clearTimeout(timer); }
      // The close handler reaps remaining group members once, including after crashes.
      if (this.server === record) { this.server = null; this.loaded = null; }
    })();
    return record.stopping;
  }
  async unloadModel(model) { if (this.loaded === model || !this.loaded) await this.stopServer(); }
  async generate(model, messages, { signal, onToken, maxTokens = 512, temperature = 0.7, seed = 42, thinking = false } = {}) {
    signal?.throwIfAborted();
    if (this.loaded !== model) await this.loadModel(model, { signal });
    const record = this.server; this.inflight++; this.touch();
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]);
    const start = performance.now(); const abort = () => { void this.stopServer(record); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetchNative('/v1/chat/completions', { method: 'POST', signal: requestSignal, body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, seed, stream: true, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: thinking } }) }, record);
      const headersMs = performance.now() - start;
      const completion = await readCompletion(response.body, onToken);
      signal?.throwIfAborted();
      const totalMs = performance.now() - start;
      return { text: completion.text, metrics: { model, tokens: completion.usage.completion_tokens, promptTokens: completion.usage.prompt_tokens, tokensPerSecond: completion.usage.completion_tokens / (totalMs / 1000), firstTokenMs: completion.firstTokenMs === null ? null : headersMs + completion.firstTokenMs, firstOutputMs: completion.firstOutputMs === null ? null : headersMs + completion.firstOutputMs, totalMs, thinking, doneReason: completion.finishReason, metric: 'client_end_to_end', serving: { ...this.config } } };
    } finally { signal?.removeEventListener('abort', abort); if (requestSignal.aborted) await this.stopServer(record); this.inflight--; this.touch(); }
  }
  async close() { this.closed = true; await this.stopServer(); await this.worker.close(); }
}
