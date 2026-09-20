import { spawn } from 'node:child_process';
import { access, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';

export function validateMlxModel(model) {
  if (typeof model !== 'string' || model.length > 180 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(model) || model.includes('..')) throw new Error('Use a Hugging Face model ID, such as mlx-community/Qwen3-0.6B-4bit.');
  return model;
}

export const MLX_CATALOG = [
  { id: 'mlx-community/Qwen3-0.6B-4bit', name: 'Qwen 3 · 0.6B', purpose: 'A lightweight first model', description: 'A small MLX model for trying local chat and measuring this Mac.', downloadGB: 0.4, use: 'general', small: true },
  { id: 'mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit', name: 'Qwen 2.5 Coder · 1.5B', purpose: 'Small coding assistant', description: 'A compact MLX coding model for explanations and short snippets.', downloadGB: 1.0, use: 'coding', small: true },
  { id: 'mlx-community/Qwen2.5-0.5B-Instruct-4bit', name: 'Qwen 2.5 · 0.5B', purpose: 'Small baseline', description: 'A compact instruction model for short answers and a second performance baseline.', downloadGB: 0.3, use: 'writing', small: true },
].map(model => ({ ...model, source: `https://huggingface.co/${model.id}` }));

export const MLX_PROFILE = {
  id: 'mlx-lm', name: 'MLX-LM', catalog: MLX_CATALOG, defaultModel: MLX_CATALOG[0].id,
  validateModel: validateMlxModel, modelPattern: /\b[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\b/g,
  help: 'Try “run a lightweight model”, “benchmark it”, “ask it: explain unified memory”, or “free up memory”. Use Hugging Face MLX model IDs, such as mlx-community/Qwen3-0.6B-4bit.',
  benchmarkMode: 'warm model; fresh prompt cache for each sample',
  readyMessage: 'MLX-LM keeps one model loaded per workspace. Switching models releases the previous model; idle models unload after 15 minutes.',
};

export class MlxAdapter {
  constructor({ packageRoot, dataDir, python, interpreterArgs = ['-u'] } = {}) {
    this.python = python || join(packageRoot, '.venv/bin/python');
    this.interpreterArgs = interpreterArgs;
    this.workerPath = join(packageRoot, 'worker.py');
    this.dataDir = dataDir;
    this.child = null; this.starting = null; this.pending = new Map(); this.generation = 0;
    this.current = { models: [] }; this.version = null; this.mlxVersion = null; this.expiresAt = null;
    this.installed = false; this.closed = false;
  }
  async ensureRunning(_directory, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('The MLX-LM workspace is closing.');
    if (this.stopping) await this.stopping;
    signal?.throwIfAborted();
    if (this.closed) throw new Error('The MLX-LM workspace is closing.');
    if (this.child && this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.startWorker().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startWorker() {
    try { await access(this.python, constants.X_OK); this.installed = true; }
    catch { throw new Error('MLX-LM needs setup. Run this harness’s setup command to install its isolated Python environment.'); }
    await mkdir(this.dataDir, { recursive: true });
    const log = await open(join(this.dataDir, 'mlx-lm.log'), 'a', 0o600);
    const child = spawn(this.python, [...this.interpreterArgs, this.workerPath], { stdio: ['pipe', 'pipe', log.fd], env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false', HARNESS_MLX_REGISTRY: join(this.dataDir, 'mlx-models.json') } });
    await log.close();
    this.child = child; this.ready = false;
    child.stdin.on('error', () => {}); // The write callback rejects the corresponding request.
    const generation = ++this.generation;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MLX-LM did not start within 45 seconds. Check .harness/mlx-lm.log.')); }, 45000);
      const startupFailure = error => { clearTimeout(timer); reject(error); };
      child.once('error', startupFailure);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          if (line.length > 8 * 1024 * 1024) throw new Error('MLX-LM returned an oversized event.');
          const event = JSON.parse(line);
          if (this.generation !== generation) return;
          if (event.event === 'ready') {
            clearTimeout(timer); this.ready = true; this.current = event;
            this.version = event.version; this.mlxVersion = event.mlxVersion;
            resolve(); return;
          }
          if (event.state) this.current = { ...this.current, ...event.state };
          const pending = this.pending.get(event.id); if (!pending) return;
          if (event.event === 'error') pending.reject(new Error(event.message));
          else if (event.event === 'done') pending.resolve(event.result);
          else pending.onEvent(event);
        } catch (error) { child.kill('SIGKILL'); startupFailure(error); }
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer); lines.close();
        const error = new Error(`MLX-LM worker stopped (${signal || code}). Its loaded model was released. Check .harness/mlx-lm.log if unexpected.`);
        if (this.generation === generation) { this.child = null; this.ready = false; this.expiresAt = null; this.current = { ...this.current, models: this.current.models.map(m => ({ ...m, running: false, resident: null })) }; }
        for (const request of this.pending.values()) if (request.child === child) request.reject(error);
        startupFailure(error);
      });
    });
  }
  stopWorker(child, signal = 'SIGTERM') {
    if (child !== this.child) return;
    this.ready = false;
    if (this.stopping) return;
    this.stopping = new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill(signal);
    }).finally(() => { this.stopping = null; });
  }
  async request(action, body = {}, { signal, onEvent = () => {}, timeout = 180000 } = {}) {
    await this.ensureRunning(undefined, { signal }); signal?.throwIfAborted();
    const child = this.child; const id = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); fn(value); };
      const abort = () => { this.stopWorker(child); finish(reject, signal.reason || new Error('Cancelled.')); };
      const timer = setTimeout(() => { this.stopWorker(child, 'SIGKILL'); finish(reject, new Error(`MLX-LM ${action} timed out. Its worker was stopped to release memory.`)); }, timeout);
      this.pending.set(id, { child, resolve: value => finish(resolve, value), reject: error => finish(reject, error), onEvent });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ id, action, ...body }) + '\n', error => { if (error) finish(reject, error); });
    });
  }
  async discover() {
    let error;
    try {
      await this.ensureRunning();
      if (!this.pending.size) {
        const loaded = this.current.models.find(m => m.running);
        if (loaded && this.expiresAt && Date.now() > this.expiresAt) await this.unloadModel(loaded.id);
        await this.request('inventory');
      }
    } catch (e) { error = e.message; }
    return { id: 'mlx-lm', name: 'MLX-LM', online: Boolean(this.child && this.ready), installed: this.installed, version: this.version, mlxVersion: this.mlxVersion, error,
      endpoint: 'Private local worker', cacheRoot: this.current.cacheRoot, memoryScope: 'MLX active allocations; one model per workspace',
      models: this.current.models.map(m => ({ ...m, resident: m.resident ? { ...m.resident, expires_at: this.expiresAt ? new Date(this.expiresAt).toISOString() : null } : null })) };
  }
  async pullModel(model, { signal, onProgress = () => {} } = {}) {
    return this.request('download', { model: validateMlxModel(model), memoryBudget: Math.floor(totalmem() * 0.8) }, { signal, timeout: 30 * 60 * 1000, onEvent: event => { if (event.event === 'progress') onProgress(event.message, event.percent, { completed: event.completed, total: event.total }); } });
  }
  localModelDetails(model, options) { return this.request('details', { model: validateMlxModel(model) }, options); }
  async loadModel(model, { signal, context = 4096 } = {}) {
    const result = await this.request('load', { model: validateMlxModel(model), context }, { signal });
    this.expiresAt = Date.now() + 15 * 60 * 1000; return result;
  }
  async unloadModel(model, { signal } = {}) {
    const result = await this.request('unload', { model: validateMlxModel(model) }, { signal });
    this.expiresAt = null; return result;
  }
  async generate(model, messages, { signal, onToken = () => {}, ...options } = {}) {
    const started = performance.now(); let firstTokenMs = null; let firstOutputMs = null;
    const result = await this.request('generate', { model: validateMlxModel(model), messages, options }, { signal, onEvent: event => {
      if (event.event === 'first_token' && firstTokenMs === null) firstTokenMs = performance.now() - started;
      if (event.event === 'token') { if (firstOutputMs === null && /\S/.test(event.text)) firstOutputMs = performance.now() - started; onToken(event.text); }
    } });
    this.expiresAt = Date.now() + 15 * 60 * 1000;
    result.metrics.firstTokenMs = firstTokenMs; result.metrics.firstOutputMs = firstOutputMs;
    return result;
  }
  async close() {
    this.closed = true;
    if (this.starting) await this.starting.catch(() => {});
    if (this.child) this.stopWorker(this.child);
    await this.stopping;
  }
}
