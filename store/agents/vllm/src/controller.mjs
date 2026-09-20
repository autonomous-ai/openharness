import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import * as ollama from './ollama.mjs';
import { resolveIntent, validateAction } from './intents.mjs';
import { CATALOG } from './catalog.mjs';

export const BENCHMARK_PROMPT = 'Explain how a bicycle works to a curious beginner. Discuss the pedals, chain, gears, wheels, brakes, and balance. Write a clear explanation of at least 250 words without a heading.';
export const BENCHMARK_SETTINGS = { context: 2048, maxTokens: 128, seed: 42, temperature: 0, thinking: false };
export const median = values => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v[Math.floor((v.length - 1) / 2)] + v[Math.ceil((v.length - 1) / 2)]) / 2 : null; };
const terminal = job => !['queued', 'running'].includes(job.status);
export const safeError = error => /TLS handshake timeout|fetch failed/.test(error.message) ? 'The model download or runtime connection timed out. Check your connection and retry; partial downloads can resume.' : String(error.message || error).replace(/https?:\/\/[^\s"<>]+/g, url => url.split('?')[0]).slice(0, 700);

export class Controller extends EventEmitter {
  constructor(store, adapter = ollama, profile = {}) {
    super();
    this.profile = { id: 'ollama', name: 'Ollama', catalog: CATALOG, ...profile };
    this.store = store; this.adapter = adapter; this.queue = []; this.aborts = new Map(); this.actions = new Map(); this.processing = false; this.closing = false;
    this.system = { platform: os.platform(), arch: os.arch(), chip: os.cpus()[0]?.model || 'Local machine', totalMemory: os.totalmem(), cores: os.cpus().length };
    this.runtime = { id: this.profile.id, name: this.profile.name, online: false, models: [] };
    this.updatedAt = null;
  }
  snapshot() { return { runtime: this.runtime, system: { ...this.system, freeMemory: os.freemem() }, benchmarks: this.store.data.benchmarks, loadTests: this.store.data.loadTests, runs: this.store.data.runs, jobs: this.store.data.jobs, catalog: this.profile.catalog, updatedAt: this.updatedAt }; }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.adapter.discover().then(runtime => { this.runtime = runtime; this.updatedAt = new Date().toISOString(); this.emit('state', this.snapshot()); }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async command(text, { selectedModel, history } = {}) {
    await this.refresh();
    const intent = (this.profile.resolveIntent || resolveIntent)(text, { models: this.runtime.models, selectedModel, profile: this.profile });
    if (intent.kind === 'action') {
      if (intent.action.type === 'chat') intent.action.history = history;
      return { kind: 'job', job: await this.submit(intent.action) };
    }
    if (intent.kind === 'inventory') {
      const models = this.runtime.models;
      return { kind: 'reply', message: !this.runtime.online ? `${this.profile.name} is not running. Say “start ${this.profile.name}” or “run a lightweight model”.` : models.length ? `${models.length} model${models.length === 1 ? '' : 's'} on disk, ${models.filter(m => m.running).length} in memory.\n${models.map(m => `${m.name} — ${m.running ? 'in memory' : 'on disk'}`).join('\n')}` : `${this.profile.name} is ready. Say “run a lightweight model” to download your first model.` };
    }
    return intent;
  }
  async submit(input) {
    if (this.closing) throw new Error('Harness is shutting down. Try again after it restarts.');
    if (this.queue.length >= 8) throw new Error('There are already eight jobs waiting. Let them finish or cancel one.');
    const action = this.profile.validateAction ? this.profile.validateAction(input) : validateAction(input, this.profile.validateModel);
    const job = { id: randomUUID(), type: action.type, model: action.model || null, models: action.models || [], status: 'queued', progress: 0, message: 'Waiting for the model operator', createdAt: new Date().toISOString(), output: '', result: null };
    this.store.data.jobs.unshift(job);
    this.store.data.jobs = this.store.data.jobs.filter((j, i) => i < 40 || !terminal(j));
    this.actions.set(job.id, action); this.queue.push(job.id);
    await this.store.save(); this.emit('job', job);
    void this.drain();
    return job;
  }
  async cancel(id) {
    const job = this.store.data.jobs.find(j => j.id === id);
    if (!job) throw new Error('Job not found.');
    if (terminal(job)) return job;
    this.aborts.get(id)?.abort(new Error('Cancelled by you.'));
    if (job.status === 'queued') { job.status = 'cancelled'; job.message = 'Cancelled before starting.'; job.completedAt = new Date().toISOString(); this.queue = this.queue.filter(queued => queued !== id); this.actions.delete(id); await this.store.save(); }
    else job.message = 'Cancelling…';
    this.emit('job', job); return job;
  }
  async drain() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length && !this.closing) {
        const id = this.queue.shift(); const job = this.store.data.jobs.find(j => j.id === id); const action = this.actions.get(id);
        if (!job || job.status !== 'queued') continue;
        const abort = new AbortController(); this.aborts.set(id, abort);
        job.status = 'running'; job.startedAt = new Date().toISOString();
        const progress = (message, value, extra) => { job.message = message; if (Number.isFinite(value)) job.progress = Math.max(0, Math.min(100, value)); if (extra) job.download = extra; this.emit('job', job); };
        try {
          await this.store.save();
          progress(`Connecting to ${this.profile.name}`, 1);
          await this.adapter.ensureRunning(this.store.directory, { signal: abort.signal, onProgress: progress });
          await this.refresh();
          job.result = await this.execute(action, { signal: abort.signal, progress, job });
          abort.signal.throwIfAborted();
          job.status = 'succeeded'; job.progress = 100; job.message = job.result.message;
        } catch (error) {
          job.status = abort.signal.aborted ? 'cancelled' : 'failed';
          job.message = abort.signal.aborted ? 'Cancelled. Any downloaded files stay cached; retrying can resume the download.' : safeError(error);
        } finally {
          job.completedAt = new Date().toISOString(); this.aborts.delete(id); this.actions.delete(id);
          try { await this.refresh(); await this.store.save(); } catch (error) { job.persistenceError = error.message; }
          this.emit('job', job);
        }
      }
    } finally { this.processing = false; }
  }
  async deploy(model, { signal, progress }, load = true, context) {
    await this.refresh();
    if (!this.runtime.models.some(m => m.id === model)) {
      progress(`Inspecting ${model} before downloading`, 2);
      await this.adapter.pullModel(model, { signal, onProgress: (message, value, extra) => progress(message, 3 + (value || 0) * 0.75, extra) });
    }
    await this.adapter.localModelDetails(model, { signal });
    if (load) {
      progress(`Loading ${model} into memory`, 82);
      await this.adapter.loadModel(model, { signal, context: context ?? (this.profile.preserveServingConfig ? undefined : 4096) });
      for (let i = 0; i < 15; i++) { await this.refresh(); if (this.runtime.models.some(m => m.id === model && m.running)) return; await delay(200, undefined, { signal }); }
      throw new Error(`${this.profile.name} accepted the load request, but the model did not appear in memory. Check the runtime log and try again.`);
    }
    await this.refresh();
    if (!this.runtime.models.some(m => m.id === model)) throw new Error(`${this.profile.name} did not report the model as installed after the download.`);
  }
  async execute(action, ctx) {
    const { signal, progress, job } = ctx;
    if (action.model) job.activeModel = action.model;
    if (action.type === 'start') return { message: `${this.profile.name} ${this.runtime.version} is ready. ${this.runtime.models.length} models found on disk.` };
    if (action.type === 'serve') {
      await this.deploy(action.model, ctx, false);
      progress(`Starting ${action.model} with the requested serving settings`, 80);
      await this.adapter.loadModel(action.model, { ...action, signal });
      await this.refresh();
      return { model: action.model, serving: this.runtime.serving, message: `${action.model} is serving · ${this.runtime.serving.context.toLocaleString()} context · ${this.runtime.serving.maxSequences} parallel sequences · prefix cache ${this.runtime.serving.prefixCaching ? 'on' : 'off'}.` };
    }
    if (action.type === 'load_test') {
      await this.deploy(action.model, ctx);
      progress('Warming the server before the concurrent test', 5);
      await this.adapter.generate(action.model, [{ role: 'user', content: BENCHMARK_PROMPT }], { ...BENCHMARK_SETTINGS, maxTokens: 32, signal });
      const serving = { ...this.runtime.serving }; const samples = []; let next = 0; let complete = 0;
      const began = performance.now();
      const worker = async () => {
        while (next < action.requests) {
          signal.throwIfAborted(); const index = next++;
          try {
            const { metrics } = await this.adapter.generate(action.model, [{ role: 'user', content: `${BENCHMARK_PROMPT} Reference number: ${index + 1}.` }], { ...BENCHMARK_SETTINGS, signal });
            samples.push({ index, status: 'succeeded', ...metrics });
          } catch (error) { signal.throwIfAborted(); samples.push({ index, status: 'failed', error: safeError(error) }); }
          complete++; progress(`${complete} of ${action.requests} requests completed · concurrency ${action.concurrency}`, 10 + complete / action.requests * 85);
        }
      };
      const outcomes = await Promise.allSettled(Array.from({ length: action.concurrency }, worker)); signal.throwIfAborted();
      const rejected = outcomes.find(outcome => outcome.status === 'rejected'); if (rejected) throw rejected.reason;
      const totalMs = performance.now() - began;
      const passed = samples.filter(s => s.status === 'succeeded');
      const latency = passed.map(s => s.totalMs).sort((a, b) => a - b);
      const result = { id: randomUUID(), at: new Date().toISOString(), model: action.model, digest: this.runtime.models.find(m => m.id === action.model)?.digest, runtime: { name: this.profile.name, version: this.runtime.version, backend: this.runtime.backend, backendVersion: this.runtime.backendVersion }, hardware: this.system, concurrency: action.concurrency, requests: action.requests, succeeded: passed.length, failed: samples.length - passed.length, totalMs, aggregateTokensPerSecond: passed.reduce((sum, s) => sum + s.tokens, 0) / (totalMs / 1000), medianLatencyMs: median(latency), p95LatencyMs: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null, medianFirstTokenMs: median(passed.map(s => s.firstTokenMs)), settings: { ...BENCHMARK_SETTINGS, context: serving.context }, serving, prompt: BENCHMARK_PROMPT, promptVariation: 'Reference number: {1-based request index}.', mode: 'one discarded warmup; repeated prompt prefixes may be cached; client end-to-end measurements', samples: samples.sort((a, b) => a.index - b.index) };
      this.store.data.loadTests.unshift(result); this.store.data.loadTests = this.store.data.loadTests.slice(0, 200); await this.store.save();
      if (!passed.length) throw new Error(`All ${action.requests} requests failed. The load-test record contains each error.`);
      return { model: action.model, loadTestId: result.id, message: `${passed.length}/${action.requests} requests succeeded at concurrency ${action.concurrency} · ${result.aggregateTokensPerSecond.toFixed(1)} aggregate tokens/s · ${Math.round(result.p95LatencyMs)} ms p95 request latency · ${result.failed} errors.` };
    }
    if (['deploy', 'download'].includes(action.type)) {
      await this.deploy(action.model, ctx, action.type === 'deploy');
      return { model: action.model, message: action.type === 'deploy' ? `${action.model} is ready on this Mac. Ask a question, or say “benchmark it”. ${this.profile.readyMessage || 'Idle models unload after 15 minutes; their files stay on disk.'}` : `${action.model} is downloaded. Say “run ${action.model}” to load it into memory.` };
    }
    if (['unload', 'unload_all'].includes(action.type)) {
      const targets = action.type === 'unload_all' ? this.runtime.models.filter(m => m.running).map(m => m.id) : [action.model];
      for (const model of targets) { progress(`Releasing ${model} from memory`, 30); await this.adapter.unloadModel(model, { signal }); }
      await this.refresh();
      if (targets.some(model => this.runtime.models.some(m => m.id === model && m.running))) throw new Error('The runtime still reports a requested model in memory. It may be in use by another client.');
      return { message: targets.length ? `${targets.length === 1 ? targets[0] : `${targets.length} models`} unloaded. Downloaded files are still on disk.` : 'No models were in memory.' };
    }
    if (action.type === 'chat') {
      await this.deploy(action.model, ctx);
      progress(`Generating with ${action.model}`, 90);
      let lastEmit = 0;
      const generated = await this.adapter.generate(action.model, [...action.history, { role: 'user', content: action.prompt }], { signal, onToken: text => { job.output += text; if (Date.now() - lastEmit > 80) { this.emit('job', job); lastEmit = Date.now(); } } });
      const run = { id: randomUUID(), at: new Date().toISOString(), ...generated.metrics };
      this.store.data.runs.unshift(run); this.store.data.runs = this.store.data.runs.slice(0, 200);
      return { model: action.model, metrics: generated.metrics, message: `Response from ${action.model}.` };
    }
    if (action.type === 'benchmark') {
      const results = [];
      for (const [modelIndex, model] of action.models.entries()) {
        job.activeModel = model;
        await this.deploy(model, ctx, true, BENCHMARK_SETTINGS.context);
        const metadata = this.runtime.models.find(m => m.id === model);
        progress(`Warming up ${model} (not included in results)`, 5 + modelIndex / action.models.length * 90);
        await this.adapter.generate(model, [{ role: 'user', content: BENCHMARK_PROMPT }], { ...BENCHMARK_SETTINGS, maxTokens: 32, signal });
        const samples = [];
        for (let i = 0; i < 3; i++) {
          progress(`${model} · measured run ${i + 1} of 3`, 10 + (modelIndex + i / 3) / action.models.length * 85);
          const { metrics } = await this.adapter.generate(model, [{ role: 'user', content: BENCHMARK_PROMPT }], { ...BENCHMARK_SETTINGS, signal });
          if (!Number.isFinite(metrics.tokensPerSecond) || !Number.isFinite(metrics.firstTokenMs)) throw new Error(`${this.profile.name} did not return usable timing data; no benchmark was recorded.`);
          samples.push(metrics);
        }
        await this.refresh();
        const result = { id: randomUUID(), model, digest: metadata?.digest || null, at: new Date().toISOString(), runtime: { name: this.profile.name, version: this.runtime.version, mlxVersion: this.runtime.mlxVersion, backend: this.runtime.backend, backendVersion: this.runtime.backendVersion }, hardware: this.system, settings: BENCHMARK_SETTINGS, prompt: BENCHMARK_PROMPT, promptHash: createHash('sha256').update(BENCHMARK_PROMPT).digest('hex'), mode: this.profile.benchmarkMode || 'warm; repeated prompt may use prefix cache', samples, medianTokensPerSecond: median(samples.map(s => s.tokensPerSecond)), medianFirstTokenMs: median(samples.map(s => s.firstTokenMs)), medianFirstOutputMs: median(samples.map(s => s.firstOutputMs)), residentBytes: this.runtime.models.find(m => m.id === model)?.resident?.size || null };
        this.store.data.benchmarks.unshift(result); this.store.data.benchmarks = this.store.data.benchmarks.slice(0, 200); results.push(result);
        await this.store.save();
      }
      return { model: action.models.at(-1), benchmarkIds: results.map(r => r.id), message: results.map(r => `${r.model}: ${r.medianTokensPerSecond.toFixed(1)} tokens/s · ${Math.round(r.medianFirstTokenMs)} ms to first token (median of 3 warm runs).`).join('\n') };
    }
    throw new Error('Unknown action.');
  }
  async close() { this.closing = true; for (const abort of this.aborts.values()) abort.abort(new Error('Harness shutting down.')); await this.store.save(); await this.adapter.close?.(); }
}
