import { access, mkdir, open, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export const OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_CONTEXT = 4096;
let starting;

export function validateModel(model) {
  if (typeof model !== 'string' || model.length > 180 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(model) || model.includes('..')) throw new Error('Use an Ollama model name, such as qwen3:0.6b.');
  if (/(?:^|[-:])cloud(?:$|[-:])/i.test(model)) throw new Error('This harness runs local models. Choose a model without a cloud tag.');
  return model.includes(':') ? model : `${model}:latest`;
}

export async function* readNDJSON(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (buffer.length > 8 * 1024 * 1024) throw new Error('The runtime returned an oversized event.');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (line) { const event = JSON.parse(line); if (event.error) throw new Error(event.error); yield event; }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = JSON.parse(buffer); if (event.error) throw new Error(event.error); yield event; }
}

export async function streamRequest(path, body, { signal, timeout = 30 * 60 * 1000, onEvent = () => {} } = {}) {
  const response = await fetch(`${OLLAMA_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  if (!response.ok) { const message = await response.text(); throw new Error(message.slice(0, 600) || `Ollama returned ${response.status}`); }
  let last;
  for await (const event of readNDJSON(response.body)) { last = event; await onEvent(event); }
  return last;
}

export async function ensureRunning(dataDir, { signal, onProgress = () => {} } = {}) {
  try { return await ollamaJSON('/api/version', { timeout: 1500, signal }); } catch {}
  signal?.throwIfAborted();
  if (starting) return starting;
  starting = (async () => {
    const binary = await findOllama();
    if (!binary) throw new Error('Ollama is not installed. Install the official Ollama app from ollama.com, then try again.');
    onProgress('Starting Ollama on this Mac');
    await mkdir(dataDir, { recursive: true });
    const log = await open(join(dataDir, 'ollama.log'), 'a', 0o600);
    let failure;
    const child = spawn(binary, ['serve'], { env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: '1' }, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', error => { failure = error; });
    child.unref();
    await log.close();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      signal?.throwIfAborted();
      try { return await ollamaJSON('/api/version', { timeout: 1000, signal }); } catch {}
      if (child.exitCode !== null) throw new Error(`Ollama exited during startup. Details are in ${join(dataDir, 'ollama.log')}.`);
      await delay(300, undefined, { signal });
    }
    throw new Error('Ollama did not become ready within 30 seconds. Check the runtime log and try again.');
  })().finally(() => { starting = null; });
  return starting;
}

export async function modelManifest(model, { signal } = {}) {
  const normalized = validateModel(model);
  const [path, tag] = normalized.split(':');
  const repository = path.includes('/') ? path : `library/${path}`;
  const url = `https://registry.ollama.ai/v2/${repository}/manifests/${tag}`;
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' } });
  if (!response.ok) throw new Error(response.status === 404 ? `The model ${model} was not found in Ollama's registry. Check its name and tag.` : `Could not inspect the download size (${response.status}). Try again when the registry is reachable.`);
  const manifest = await response.json();
  const layers = [...(manifest.layers || []), ...(manifest.config ? [manifest.config] : [])];
  if (!layers.length || layers.some(layer => !Number.isSafeInteger(layer.size) || layer.size < 0)) throw new Error('The model registry returned an invalid manifest.');
  return { bytes: layers.reduce((total, layer) => total + layer.size, 0), repository, tag };
}

export async function pullModel(model, options = {}) {
  model = validateModel(model);
  const manifest = await modelManifest(model, options);
  if (manifest.bytes > totalmem() * 0.8) throw new Error(`This model download is ${(manifest.bytes / 1024 ** 3).toFixed(1)} GiB, too large for the pilot's memory budget on this Mac. Choose a smaller quantization or model.`);
  try {
    const disk = await statfs(process.env.OLLAMA_MODELS || join(homedir(), '.ollama'));
    if (disk.bavail * disk.bsize < manifest.bytes + 2 * 1024 ** 3) throw new Error('There is not enough free disk space for this download plus 2 GiB of headroom.');
  } catch (error) { if (!['ENOENT', 'EPERM', 'EACCES'].includes(error.code)) throw error; }
  const layers = new Map();
  const last = await streamRequest('/api/pull', { model }, { ...options, onEvent: event => {
    if (event.digest && event.total) layers.set(event.digest, { total: event.total, completed: event.completed || 0 });
    const known = [...layers.values()];
    const completed = known.reduce((sum, layer) => sum + layer.completed, 0);
    options.onProgress?.(event.status || 'Downloading model', Math.min(99, Math.floor(completed / manifest.bytes * 100)), { completed, total: manifest.bytes });
  } });
  if (last?.status !== 'success') throw new Error('The model download ended before Ollama confirmed success. You can retry to resume it.');
  return manifest;
}

export async function localModelDetails(model, options = {}) {
  const details = await ollamaJSON('/api/show', { method: 'POST', body: { model: validateModel(model) }, timeout: 15000, ...options });
  if (details.remote_host || details.remote_model) throw new Error('This model forwards inference to a remote service. Choose a local model for this harness.');
  if (Array.isArray(details.capabilities) && !details.capabilities.includes('completion')) throw new Error('This pilot supports language generation models. The selected model does not expose completion capability.');
  return details;
}

export async function loadModel(model, { signal, context = DEFAULT_CONTEXT, keepAlive = '15m' } = {}) {
  await localModelDetails(model, { signal });
  return ollamaJSON('/api/generate', { method: 'POST', body: { model, prompt: '', stream: false, keep_alive: keepAlive, options: { num_ctx: context } }, timeout: 180000, signal });
}

export async function unloadModel(model, { signal } = {}) {
  return ollamaJSON('/api/generate', { method: 'POST', body: { model: validateModel(model), stream: false, keep_alive: 0 }, timeout: 30000, signal });
}

export async function generate(model, messages, { signal, maxTokens = 512, context = DEFAULT_CONTEXT, keepAlive = '15m', seed = 42, temperature = 0.3, thinking = true, onToken = () => {} } = {}) {
  const details = await localModelDetails(model, { signal });
  const start = performance.now();
  let firstTokenMs = null;
  let firstOutputMs = null;
  let text = '';
  const body = { model, messages, options: { num_predict: maxTokens, num_ctx: context, temperature, seed }, keep_alive: keepAlive };
  if (details.capabilities?.includes('thinking')) body.think = /^gpt-oss(?::|$)/.test(model) ? 'low' : Boolean(thinking);
  const last = await streamRequest('/api/chat', body, { signal, timeout: 180000, onEvent: event => {
    const piece = event.message?.content || '';
    if (firstTokenMs === null && (piece || event.message?.thinking)) firstTokenMs = performance.now() - start;
    if (piece) { if (firstOutputMs === null) firstOutputMs = performance.now() - start; text += piece; onToken(piece); }
  } });
  if (!last?.done) throw new Error('The model response ended unexpectedly. Partial output was not counted as a successful run.');
  const elapsedMs = performance.now() - start;
  return { text, metrics: {
    model, ...responseMetrics(last), firstTokenMs, firstOutputMs, elapsedMs,
    context, maxTokens, temperature, seed, thinking: body.think ?? null,
  } };
}

export function responseMetrics(last) {
  return {
    tokens: last.eval_count ?? null,
    promptTokens: last.prompt_eval_count ?? null,
    tokensPerSecond: last.eval_duration > 0 && Number.isFinite(last.eval_count) ? last.eval_count / (last.eval_duration / 1e9) : null,
    promptTokensPerSecond: last.prompt_eval_duration > 0 && Number.isFinite(last.prompt_eval_count) ? last.prompt_eval_count / (last.prompt_eval_duration / 1e9) : null,
    loadMs: Number.isFinite(last.load_duration) ? last.load_duration / 1e6 : null,
    evalMs: Number.isFinite(last.eval_duration) ? last.eval_duration / 1e6 : null,
    doneReason: last.done_reason || null,
  };
}

export async function findOllama() {
  const candidates = [process.env.OLLAMA_BIN, '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama', ...String(process.env.PATH || '').split(':').map(p => join(p, 'ollama'))].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return null;
}

export async function ollamaJSON(path, { method = 'GET', body, timeout = 5000, signal } = {}) {
  const response = await fetch(`${OLLAMA_URL}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || `Ollama returned ${response.status}`);
  return result;
}

export async function discover() {
  const binary = await findOllama();
  try {
    const [version, tags, running] = await Promise.all([ollamaJSON('/api/version'), ollamaJSON('/api/tags'), ollamaJSON('/api/ps')]);
    return {
      id: 'ollama', name: 'Ollama', online: true, installed: Boolean(binary), version: version.version, endpoint: OLLAMA_URL,
      models: (tags.models || []).map(m => ({
        id: m.name, name: m.name, size: m.size, digest: m.digest, modifiedAt: m.modified_at,
        family: m.details?.family, parameters: m.details?.parameter_size, quantization: m.details?.quantization_level,
        running: Boolean((running.models || []).find(r => r.name === m.name || r.model === m.name)),
        resident: (running.models || []).find(r => r.name === m.name || r.model === m.name) || null,
      })).filter(m => !/(?:^|[-:])cloud(?:$|[-:])/i.test(m.name)),
    };
  } catch (error) {
    return { id: 'ollama', name: 'Ollama', online: false, installed: Boolean(binary), version: null, endpoint: OLLAMA_URL, models: [], error: error.message };
  }
}
