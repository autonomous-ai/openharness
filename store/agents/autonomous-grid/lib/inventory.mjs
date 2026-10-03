// Read-only inventory of this computer for local models: model files other apps already downloaded,
// engines answering on loopback, and the memory the OS reports right now. Nothing here starts, stops,
// moves or downloads anything; every probe is a file read, a GET, or a read-only system command.
import { execFile } from 'node:child_process';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { arch, cpus, freemem, homedir, platform, totalmem } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { kvBytesFromConfig } from './candidates.mjs';

const exec = promisify(execFile);
const SCALAR_BYTES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
// Grid's llama.cpp refuses higher tensor types: "invalid ggml type 143. should be in [0, 43)".
export const GGML_TYPE_LIMIT = 43;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.Trash']);
const KNOWN_PORTS = [11434, 1234, 8000, 8080, 8081, 30000];

class HeaderReader {
  constructor(handle) { this.handle = handle; this.buffer = Buffer.alloc(0); this.offset = 0; this.next = 0; }
  async need(bytes) {
    if (this.buffer.length - this.offset >= bytes) return;
    const kept = this.buffer.subarray(this.offset);
    const chunk = Buffer.alloc(Math.max(bytes - kept.length, 1 << 20));
    const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, this.next);
    this.next += bytesRead;
    this.buffer = Buffer.concat([kept, chunk.subarray(0, bytesRead)]);
    this.offset = 0;
    if (this.buffer.length < bytes) throw new Error('truncated GGUF header');
  }
  skip(bytes) {
    const buffered = this.buffer.length - this.offset;
    if (bytes <= buffered) { this.offset += bytes; return; }
    this.next += bytes - buffered; this.buffer = Buffer.alloc(0); this.offset = 0;
  }
  async number(type) {
    const size = SCALAR_BYTES[type];
    await this.need(size);
    const b = this.buffer, o = this.offset;
    this.offset += size;
    switch (type) {
      case 0: return b.readUInt8(o); case 1: return b.readInt8(o);
      case 2: return b.readUInt16LE(o); case 3: return b.readInt16LE(o);
      case 4: return b.readUInt32LE(o); case 5: return b.readInt32LE(o);
      case 6: return b.readFloatLE(o); case 7: return b.readUInt8(o) !== 0;
      case 10: return Number(b.readBigUInt64LE(o)); case 11: return Number(b.readBigInt64LE(o));
      default: return b.readDoubleLE(o);
    }
  }
  async string(limit = 1 << 20) {
    const length = await this.number(10);
    if (length > limit) { this.skip(length); return null; }
    await this.need(length);
    const text = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return text;
  }
  async value(type, keep) {
    if (type === 8) return this.string();
    if (type in SCALAR_BYTES) return this.number(type);
    if (type !== 9) throw new Error(`unsupported GGUF value type ${type}`);
    const itemType = await this.number(4), length = await this.number(10);
    if (itemType in SCALAR_BYTES) {
      if (!keep || length > 4096) { this.skip(length * SCALAR_BYTES[itemType]); return undefined; }
      const items = [];
      for (let i = 0; i < length; i++) items.push(await this.number(itemType));
      return items;
    }
    if (itemType !== 8) throw new Error(`unsupported GGUF array type ${itemType}`);
    for (let i = 0; i < length; i++) this.skip(await this.number(10));
    return undefined;
  }
}

/** The metadata and tensor types of a GGUF file, or null when the file is not GGUF. */
export async function readGguf(path) {
  const handle = await open(path, 'r');
  try {
    const reader = new HeaderReader(handle);
    await reader.need(4);
    if (reader.buffer.toString('latin1', 0, 4) !== 'GGUF') return null;
    reader.offset = 4;
    const version = await reader.number(4);
    const tensorCount = await reader.number(10), keyCount = await reader.number(10);
    if (version < 2 || keyCount > 100_000 || tensorCount > 1_000_000) throw new Error('unsupported GGUF header');
    const meta = {};
    for (let i = 0; i < keyCount; i++) {
      const key = await reader.string(4096), type = await reader.number(4);
      const keep = !key?.startsWith('tokenizer.') || key === 'tokenizer.chat_template';
      const value = await reader.value(type, keep);
      if (key && keep && value !== undefined) meta[key] = value;
    }
    const tensorTypes = new Set();
    for (let i = 0; i < tensorCount; i++) {
      reader.skip(await reader.number(10));
      reader.skip((await reader.number(4)) * 8);
      tensorTypes.add(await reader.number(4));
      reader.skip(8);
    }
    return { meta, tensorTypes: [...tensorTypes].sort((a, b) => a - b) };
  } finally { await handle.close(); }
}

/**
 * What an agent needs from GGUF metadata to size a start. The KV figure is f16 cache bytes per token of
 * context; llama.cpp reported exactly this (1024 MiB for 32768 cells, 8 of 32 layers) for Qwen3.5-4B.
 */
export function summarizeGguf({ meta, tensorTypes }) {
  const architecture = meta['general.architecture'];
  const get = key => meta[`${architecture}.${key}`];
  const layers = get('block_count'), heads = get('attention.head_count');
  const kvHeads = get('attention.head_count_kv') ?? heads;
  const widest = Array.isArray(heads) ? Math.max(...heads) : heads;
  const keyLength = get('attention.key_length') ?? (get('embedding_length') && widest ? get('embedding_length') / widest : undefined);
  const valueLength = get('attention.value_length') ?? keyLength;
  let kvBytesPerToken = null, kvBasis = null;
  if (get('attention.kv_lora_rank') !== undefined) kvBasis = 'latent attention: not estimated';
  else if (layers && keyLength && kvHeads !== undefined) {
    const perLayer = Array.isArray(kvHeads) ? kvHeads.slice(0, layers) : Array(layers).fill(kvHeads);
    const interval = get('full_attention_interval');
    const cached = perLayer.map((n, i) => (interval > 1 && (i + 1) % interval !== 0 ? 0 : n));
    kvBytesPerToken = cached.reduce((sum, n) => sum + n, 0) * (keyLength + valueLength) * 2;
    kvBasis = get('attention.sliding_window') ? 'upper bound (sliding-window layers hold less)' : 'f16 cache';
  }
  const template = meta['tokenizer.chat_template'] || '';
  return {
    architecture: architecture ?? null, name: meta['general.name'] ?? null, parameters: meta['general.size_label'] ?? null,
    contextLength: get('context_length') ?? null, layers: layers ?? null,
    experts: get('expert_count') ? { total: get('expert_count'), active: get('expert_used_count') ?? null } : null,
    kvBytesPerToken, kvBasis,
    toolCalls: /\btools\b/.test(template), thinking: /enable_thinking|<think>/.test(template),
    unsupportedTensorTypes: tensorTypes.filter(type => type >= GGML_TYPE_LIMIT),
  };
}

export function defaultRoots(env = process.env, home = homedir()) {
  const hub = env.HF_HUB_CACHE || (env.HF_HOME ? join(env.HF_HOME, 'hub') : join(env.XDG_CACHE_HOME || join(home, '.cache'), 'huggingface', 'hub'));
  return [
    { source: 'grid', path: join(env.GRID_HOME || join(home, '.grid'), 'models') },
    { source: 'ollama', path: env.OLLAMA_MODELS || join(home, '.ollama', 'models') },
    { source: 'ollama', path: '/usr/share/ollama/.ollama/models' },
    { source: 'lm-studio', path: join(home, '.lmstudio', 'models') },
    { source: 'lm-studio', path: join(home, '.cache', 'lm-studio', 'models') },
    { source: 'huggingface', path: hub },
    // llama.cpp's own `-hf` downloads: LLAMA_CACHE, else its platform cache folder. Newer builds put them in
    // the Hugging Face cache above instead (they read HF_HUB_CACHE and HF_HOME), so both are looked at.
    ...(env.LLAMA_CACHE ? [{ source: 'llama.cpp', path: env.LLAMA_CACHE }] : []),
    { source: 'llama.cpp', path: join(home, 'Library', 'Caches', 'llama.cpp') },
    { source: 'llama.cpp', path: join(env.XDG_CACHE_HOME || join(home, '.cache'), 'llama.cpp') },
    { source: 'folder', path: join(home, 'models') },
    { source: 'folder', path: join(home, 'Models') },
    { source: 'folder', path: join(home, 'Downloads'), depth: 3 },
  ];
}

const QUANT = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4|NVFP4))(?=[-_.]|$)/i;
const READERS = { gguf: ['llama.cpp', 'ollama', 'lm-studio'], mlx: ['mlx-lm', 'lm-studio'], safetensors: ['vllm', 'sglang', 'mlx-lm'] };

async function walk(dir, depth, visit, budget) {
  if (depth < 0 || budget.dirs-- <= 0) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  // A weight index with no weights yet is a download that started, which the table must show.
  if (entries.some(e => e.name === 'config.json')
    && entries.some(e => e.name.endsWith('.safetensors') || e.name === 'model.safetensors.index.json')) await visit('folder', dir);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && entry.name !== 'blobs') await walk(path, depth - 1, visit, budget); }
    else if (/\.gguf$/i.test(entry.name) && (entry.isFile() || entry.isSymbolicLink())) await visit('gguf', path);
  }
}

async function listFiles(dir, depth) {
  if (depth < 0) return [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const nested = await Promise.all(entries.map(e => (e.isDirectory() ? listFiles(join(dir, e.name), depth - 1) : [join(dir, e.name)])));
  return nested.flat();
}

async function ollamaEntries(root) {
  const manifests = join(root, 'manifests'), entries = [];
  for (const file of await listFiles(manifests, 4)) {
    const [host, namespace, model, tag] = relative(manifests, file).split(sep);
    if (!tag) continue;
    let layers;
    try { ({ layers = [] } = JSON.parse(await readFile(file, 'utf8'))); } catch { continue; }
    const blob = mediaType => layers.find(layer => layer.mediaType === `application/vnd.ollama.image.${mediaType}`)?.digest;
    const weights = blob('model'), projector = blob('projector');
    if (!weights) continue;
    const short = namespace === 'library' ? `${model}:${tag}` : `${namespace}/${model}:${tag}`;
    entries.push({
      kind: 'gguf', path: join(root, 'blobs', weights.replace(':', '-')),
      name: host === 'registry.ollama.ai' ? short : `${host}/${short}`,
      projector: projector ? join(root, 'blobs', projector.replace(':', '-')) : null,
    });
  }
  return entries;
}

function hubName(path) {
  const repo = path.split(sep).find(part => part.startsWith('models--'));
  return repo ? repo.slice('models--'.length).replace('--', '/') : null;
}

async function describeFolder(dir) {
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  // Complete = every weight file the folder names is really there. `stat` follows the Hugging Face
  // cache's links to the real blobs, so a link whose blob never arrived counts as missing. Said here so
  // an agent never re-checks by hand — one did, measured the links instead of the blobs, and wrongly
  // decided a complete model was not on disk [run].
  const present = new Map();
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.safetensors')) continue;
    const size = (await stat(join(dir, name)).catch(() => null))?.size;
    if (size) present.set(name, size);
  }
  const index = await readFile(join(dir, 'model.safetensors.index.json'), 'utf8').then(JSON.parse).catch(() => null);
  const expected = index?.weight_map ? [...new Set(Object.values(index.weight_map))] : [...present.keys()];
  const missingFiles = expected.filter(name => !present.has(name)).length;
  const bytes = [...present.values()].reduce((sum, size) => sum + size, 0);
  const mlx = Boolean(config.quantization?.bits) || /mlx/i.test(dir);
  const template = await readFile(join(dir, 'chat_template.jinja'), 'utf8')
    .catch(async () => JSON.parse(await readFile(join(dir, 'tokenizer_config.json'), 'utf8')).chat_template ?? '')
    .catch(() => '');
  return {
    format: mlx ? 'mlx' : 'safetensors', bytes,
    complete: expected.length > 0 && missingFiles === 0, missingFiles, weightFiles: expected.length,
    config: {
      architecture: config.architectures?.[0] ?? config.model_type ?? null,
      contextLength: config.max_position_embeddings ?? config.text_config?.max_position_embeddings ?? null,
      quantization: config.quantization?.bits ? `${config.quantization.bits}-bit` : config.quantization_config?.quant_method ?? null,
      kvBytesPerToken: kvBytesFromConfig(config),
      toolCalls: typeof template === 'string' && template ? /\btools\b/.test(template) : null,
    },
  };
}

/** Every model file under the roots, one entry per real file; later sightings of a file become `alsoAt`. */
export async function scanModels({ roots = defaultRoots(), minBytes = 50 * 1024 ** 2 } = {}) {
  const byRealPath = new Map(), projectors = [], seenRoots = new Set(), scanned = [];
  const add = async (source, found) => {
    let realPath, info;
    try { realPath = await realpath(found.path); info = await stat(realPath); } catch { return; }
    const sighting = { source, path: found.path, name: found.name ?? null };
    if (byRealPath.has(realPath)) { byRealPath.get(realPath).alsoAt.push(sighting); return; }
    const entry = { name: found.name ?? null, source, path: found.path, realPath, format: found.kind, bytes: info.size,
      quant: null, projector: found.projector ?? null, alsoAt: [], readableBy: [], gguf: null, config: null, error: null };
    try {
      if (found.kind === 'folder') {
        Object.assign(entry, await describeFolder(realPath));
        if (entry.bytes < minBytes && !entry.missingFiles) return; // a small folder is noise; a started download is news
      } else {
        if (info.size < minBytes) return;
        const header = await readGguf(realPath);
        if (!header) return;
        entry.gguf = summarizeGguf(header);
        entry.quant = basename(found.path).match(QUANT)?.[1]?.toUpperCase() ?? null;
      }
    } catch (error) { entry.error = error.message; }
    entry.name ??= hubName(found.path) ?? basename(found.path).replace(/\.gguf$/i, '');
    entry.readableBy = READERS[entry.format] ?? [];
    byRealPath.set(realPath, entry);
  };
  for (const root of roots) {
    let real;
    try { real = await realpath(root.path); } catch { continue; }
    if (seenRoots.has(real)) continue;
    seenRoots.add(real); scanned.push(root.path);
    if (root.source === 'ollama') { for (const found of await ollamaEntries(real)) await add('ollama', found); continue; }
    await walk(root.path, root.depth ?? 6, async (kind, path) => {
      if (kind === 'gguf' && /mmproj/i.test(basename(path))) projectors.push(path);
      else await add(root.source, { kind, path });
    }, { dirs: 20_000 });
  }
  const models = [...byRealPath.values()];
  for (const path of projectors) {
    const siblings = models.filter(m => m.format === 'gguf' && dirname(m.path) === dirname(path));
    const stem = basename(path).split('.mmproj')[0];
    const owner = siblings.find(m => basename(m.path).replace(/\.gguf$/i, '') === stem) ?? (siblings.length === 1 ? siblings[0] : null);
    if (owner && !owner.projector) owner.projector = path;
  }
  return { models: models.sort((a, b) => b.bytes - a.bytes), scannedRoots: scanned };
}

export function parseListeningPorts(lsofOutput) {
  const ports = new Set();
  for (const line of lsofOutput.split('\n')) if (line.startsWith('n')) {
    const port = Number(line.slice(line.lastIndexOf(':') + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Linux listening TCP ports from `/proc/net/tcp` and `/proc/net/tcp6` (state `0A`, port in hex after the
 * last colon). A file read, so it works where `lsof` is missing — slim containers and many servers [run].
 */
export function parseProcNetTcp(text) {
  const ports = new Set();
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[3] !== '0A') continue;
    const port = parseInt(cols[1]?.slice(cols[1].lastIndexOf(':') + 1) ?? '', 16);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Windows `netstat -ano` lines such as `  TCP    [::]:11434   [::]:0   LISTENING   4812`. */
export function parseNetstatListening(text) {
  const ports = new Set();
  for (const [, port] of text.matchAll(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\b/gim)) ports.add(Number(port));
  return [...ports].sort((a, b) => a - b);
}

async function listeningPorts(os) {
  if (os === 'linux') {
    const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(file => readFile(file, 'utf8').catch(() => '')));
    return parseProcNetTcp(tables.join('\n'));
  }
  if (os === 'win32') return parseNetstatListening(await output('netstat', ['-ano']));
  return parseListeningPorts(await output('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn']));
}

function engineKind(body, ownedBy) {
  if (Array.isArray(body.models) && body.data) return 'llama.cpp';
  return { vllm: 'vllm', sglang: 'sglang', llamacpp: 'llama.cpp', organization_owner: 'lm-studio', library: 'ollama' }[ownedBy] ?? 'openai-compatible';
}

/** One GET per port. An answer with a model list is an engine; `url` is the exact `--at` form. */
export async function probeEngines(ports, { host = '127.0.0.1', timeoutMs = 800, fetchImpl = globalThis.fetch } = {}) {
  const probe = async port => {
    const root = `http://${host}:${port}`;
    try {
      const response = await fetchImpl(`${root}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const body = await response.json();
      const rows = Array.isArray(body.data) ? body.data : null;
      if (!rows) return null;
      let kind = engineKind(body, rows[0]?.owned_by);
      if (kind === 'openai-compatible' || kind === 'ollama') {
        const version = await fetchImpl(`${root}/api/version`, { signal: AbortSignal.timeout(timeoutMs) })
          .then(r => (r.ok ? r.json() : null)).catch(() => null);
        if (typeof version?.version === 'string') kind = 'ollama';
      }
      return { kind, port, url: `${root}/v1`, models: rows.map(row => row.id).filter(Boolean) };
    } catch { return null; }
  };
  return (await Promise.all([...new Set(ports)].map(probe))).filter(Boolean);
}

const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/**
 * Grids this computer is joined to, from Grid's own run files rather than the relay: an asleep grid lists
 * no engines, so an agent that read the relay once joined over a live engine [run]. Grid itself refuses a
 * second `--serve` model per grid while its run record exists; an engine whose record is gone is invisible
 * here too, and a join displaces it.
 */
export async function joinedGrids(gridHome, { alive = pidAlive } = {}) {
  const dir = join(gridHome, 'run', 'engines');
  const rows = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const state = await readFile(join(dir, entry.name, 'remote.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (!Number.isInteger(state?.pid) || !alive(state.pid)) continue;
    rows.push({
      gridId: state.grid_id ?? entry.name, grid: null, pid: state.pid, startedAt: state.started_at ?? null,
      models: state.advertise_as?.length ? state.advertise_as : state.models ?? [],
      at: state.engines?.find(engine => engine.endpoint_url)?.endpoint_url ?? state.endpoint_url ?? null,
    });
  }
  return rows;
}

export function parseVmStat(text) {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1] || 4096);
  const pages = label => Number(text.match(new RegExp(`Pages ${label}:\\s+(\\d+)`))?.[1] || 0);
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * pageSize;
}

export function parseSwapUsage(text) {
  const mb = label => Number(text.match(new RegExp(`${label} = ([\\d.]+)M`))?.[1] || 0) * 1024 ** 2;
  return { total: mb('total'), used: mb('used') };
}

export function parseMeminfo(text) {
  const kb = label => Number(text.match(new RegExp(`^${label}:\\s+(\\d+) kB`, 'm'))?.[1] || 0) * 1024;
  return { total: kb('MemTotal'), available: kb('MemAvailable'), swapUsed: kb('SwapTotal') - kb('SwapFree') };
}

/** `llama-server --list-devices`: each accelerator's memory budget as llama.cpp will use it. */
export function parseListDevices(text) {
  return [...text.matchAll(/^\s*(\w+): (.+?) \((\d+) MiB, (\d+) MiB free\)/gm)]
    .filter(([, id, , total]) => Number(total) > 0 && !/^(CPU|BLAS)/.test(id))
    .map(([, id, name, total, free]) => ({ id, name, totalBytes: Number(total) * 1024 ** 2, freeBytes: Number(free) * 1024 ** 2 }));
}

async function output(file, args, timeout = 10_000) {
  try { return (await exec(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout; } catch { return ''; }
}

/** stdout and whether the command itself answered: a present binary that errors is "not active". */
async function probe(file, args, timeout = 10_000) {
  try { const { stdout, stderr } = await exec(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }); return { ran: true, ok: true, out: `${stdout}${stderr}` }; }
  catch (error) { return { ran: error.code !== 'ENOENT', ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message }; }
}

export function parseNvidiaSmi(text) {
  return text.split('\n').map(line => line.split(',').map(cell => cell.trim())).filter(cells => cells.length >= 6 && /^\d+$/.test(cells[0]))
    .map(([index, name, total, used, utilization, driver]) => ({
      vendor: 'nvidia', id: `CUDA${index}`, name, totalBytes: Number(total) * 1024 ** 2, usedBytes: Number(used) * 1024 ** 2,
      utilizationPct: Number(utilization), driver, active: true,
    }));
}

/**
 * The accelerators that actually answer. Apple silicon: llama.cpp's Metal device list. NVIDIA: nvidia-smi
 * must run and list the card; a card that lspci sees while nvidia-smi fails is reported inactive, with why.
 */
async function accelerators(llamaServer, os) {
  let listed = parseListDevices((await probe(llamaServer, ['--list-devices'], 30_000)).out);
  // Seen once on a Mac under memory pressure: an empty list that the next call fills. One retry, then report what is there.
  if (!listed.length && (await stat(llamaServer).catch(() => null))) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    listed = parseListDevices((await probe(llamaServer, ['--list-devices'], 30_000)).out);
  }
  const found = listed
    .map(device => ({ vendor: /^MTL/.test(device.id) ? 'apple' : /^CUDA/.test(device.id) ? 'nvidia' : /^(ROCm|HIP)/i.test(device.id) ? 'amd' : 'other', ...device, active: true, source: 'llama-server --list-devices' }));
  const smi = await probe('nvidia-smi', ['--query-gpu=index,name,memory.total,memory.used,utilization.gpu,driver_version', '--format=csv,noheader,nounits']);
  if (smi.ok) {
    for (const gpu of parseNvidiaSmi(smi.out)) if (!found.some(d => d.vendor === 'nvidia' && d.name === gpu.name)) found.push({ ...gpu, source: 'nvidia-smi' });
  } else if (smi.ran) found.push({ vendor: 'nvidia', active: false, source: 'nvidia-smi', error: smi.out.split('\n')[0].slice(0, 200) });
  const rocm = await probe('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json']);
  if (rocm.ok) found.push({ vendor: 'amd', active: true, source: 'rocm-smi', detail: rocm.out.slice(0, 400) });
  else if (rocm.ran) found.push({ vendor: 'amd', active: false, source: 'rocm-smi', error: rocm.out.split('\n')[0].slice(0, 200) });
  if (os === 'linux' && !found.some(d => d.vendor === 'nvidia')) {
    const pci = (await probe('lspci', [])).out;
    if (/nvidia/i.test(pci)) found.push({ vendor: 'nvidia', active: false, source: 'lspci', error: 'card present, nvidia-smi missing: driver not installed or not loaded' });
  }
  return found;
}

const firstLine = text => text.split('\n').map(line => line.trim()).find(Boolean) ?? null;
// llama.cpp builds since 11000 log `srv llama_server: initializing ...` before `version: …` [run].
const versionLine = text => text.split('\n').map(line => line.trim()).find(line => /^version\b/i.test(line)) ?? firstLine(text);

/** Engines installed here (on PATH or in their standard install place), with the version each reports. */
async function installedEngines(llamaServer, home) {
  const engines = [];
  const add = (kind, path, version, note) => engines.push({ kind, path, version: version || null, ...(note ? { note } : {}) });
  const grid = await probe(llamaServer, ['--version']);
  if (grid.ok) add('llama.cpp', llamaServer, versionLine(grid.out), "Grid's own engine");
  // PATH first, then ~/.grid/envs/<engine>/bin, where the engine skills install Python engines.
  const envs = join(home, '.grid', 'envs');
  const windows = platform() === 'win32';
  const onPath = async name => (windows
    ? (await output('where', [name])).split(/\r?\n/)[0] // Windows has no `sh`; `where` prints each match
    : await output('sh', ['-c', `command -v ${name}`])).trim();
  const inEnv = async (name, env) => {
    if (!env) return null;
    const file = windows ? join(envs, env, 'Scripts', `${name}.exe`) : join(envs, env, 'bin', name); // a venv's layout
    return (await stat(file).catch(() => null)) ? file : null;
  };
  const exists = async file => ((await stat(file).catch(() => null)) ? file : null);
  // An app opened from Finder or the Dock gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the
  // folders Homebrew and the person's own installs use are looked in too: a Homebrew llama-server read as
  // "not installed" moved its models to Grid's engine.
  const standard = windows ? [] : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];
  const inStandard = async name => { for (const dir of standard) if (await exists(join(dir, name))) return join(dir, name); return null; };
  const which = async (name, env) => (await onPath(name)) || (await inEnv(name, env)) || inStandard(name);
  const own = await which('llama-server');
  if (own && own !== llamaServer) {
    const answer = await probe(own, ['--version']);
    add('llama.cpp', own, answer.ok ? versionLine(answer.out) : null, answer.ok ? null : 'on PATH but did not answer --version');
  }
  const ollama = (await which('ollama'))
    || ((await exists('/Applications/Ollama.app')) ? '/Applications/Ollama.app/Contents/Resources/ollama' : null)
    // Windows installs per user under %LOCALAPPDATA%\Programs\Ollama and adds it to PATH [doc: docs.ollama.com/windows].
    || (process.env.LOCALAPPDATA ? await exists(join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')) : null);
  if (ollama) add('ollama', ollama, (await probe(ollama, ['--version'])).out.match(/version is ([\w.-]+)/)?.[1]);
  const lms = (await which('lms')) || (await exists(join(home, '.lmstudio', 'bin', 'lms')))
    || (windows ? await exists(join(home, '.lmstudio', 'bin', 'lms.exe')) : null);
  const studioApp = await stat('/Applications/LM Studio.app').catch(() => null);
  if (lms || studioApp) add('lm-studio', lms ?? '/Applications/LM Studio.app', null, lms ? null : 'app installed; lms appears after its first launch');
  const mlx = await which('mlx_lm.server', 'mlx-lm');
  if (mlx) {
    const python = (await readFile(mlx, 'utf8').catch(() => '')).match(/^#!(\S+)/)?.[1];
    add('mlx-lm', mlx, python ? firstLine((await probe(python, ['-c', 'import mlx_lm; print(mlx_lm.__version__)'])).out) : null);
  }
  const vllm = await which('vllm', 'vllm');
  if (vllm) add('vllm', vllm, firstLine((await probe(vllm, ['--version'], 60_000)).out));
  const sglang = await which('sglang', 'sglang');
  if (sglang) add('sglang', sglang, null);
  return engines;
}

/** Which engines this hardware can run at all, from each engine's documented platforms. */
export function runnableEngines(os, cpu, gpus) {
  const active = vendor => gpus.some(gpu => gpu.vendor === vendor && gpu.active);
  if (os === 'darwin' && cpu === 'arm64') return ['llama.cpp', 'mlx-lm', 'ollama', 'lm-studio'];
  if (os === 'linux' && (active('nvidia') || active('amd'))) return ['llama.cpp', 'ollama', 'vllm', 'sglang'];
  return ['llama.cpp', 'ollama'];
}

export async function machineState({ env = process.env, home = homedir() } = {}) {
  const machine = { platform: platform(), arch: arch(), chip: null, memory: null, accelerators: [], engines: [], canRun: [], listeningPorts: [] };
  machine.chip = (machine.platform === 'darwin'
    ? (await output('sysctl', ['-n', 'machdep.cpu.brand_string'])).trim()
    : (await readFile('/proc/cpuinfo', 'utf8').catch(() => '')).match(/^model name\s*:\s*(.+)$/m)?.[1])
    // ARM Linux has no "model name" line and Windows no /proc; Node's own CPU list covers both — except
    // on ARM Linux, where Node itself answers the word "unknown" [run].
    || [cpus()[0]?.model?.trim()].find(model => model && model !== 'unknown') || null;
  if (machine.platform === 'darwin') {
    const total = Number((await output('sysctl', ['-n', 'hw.memsize'])).trim()) || null;
    const swap = parseSwapUsage(await output('sysctl', ['-n', 'vm.swapusage']));
    machine.memory = { totalBytes: total, availableBytes: parseVmStat(await output('vm_stat', [])), swapUsedBytes: swap.used,
      note: 'available = free + inactive + speculative + purgeable pages; Metal and Grid do not see other apps, this does' };
  } else if (machine.platform === 'linux') {
    const info = parseMeminfo(await readFile('/proc/meminfo', 'utf8').catch(() => ''));
    machine.memory = { totalBytes: info.total, availableBytes: info.available, swapUsedBytes: info.swapUsed };
  }
  if (!machine.memory?.totalBytes) {
    // Windows and anything else: the OS's own figures through Node. Swap is not reported there.
    machine.memory = { totalBytes: totalmem(), availableBytes: freemem(), swapUsedBytes: null, note: 'as the OS reports it' };
  }
  const llamaServer = join(env.GRID_HOME || join(home, '.grid'), 'bin', machine.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  [machine.accelerators, machine.engines] = await Promise.all([accelerators(llamaServer, machine.platform), installedEngines(llamaServer, home)]);
  if (machine.platform === 'darwin' && machine.arch === 'arm64' && !machine.accelerators.some(gpu => gpu.vendor === 'apple')) {
    machine.accelerators.push({ vendor: 'apple', name: machine.chip, active: true, source: 'Apple silicon GPU (built in; budget unknown until llama.cpp is installed)' });
  }
  machine.canRun = runnableEngines(machine.platform, machine.arch, machine.accelerators);
  machine.listeningPorts = await listeningPorts(machine.platform);
  return machine;
}

const gb = bytes => (bytes === null || bytes === undefined ? '—' : `${(bytes / 1e9).toFixed(1)} GB`);

/**
 * One model's identity across formats and publishers: `Qwen3.5-9B-UD-Q4_K_XL` (GGUF) and
 * `mlx-community/Qwen3.5-9B-4bit` (MLX) are both `qwen3.5-9b`. Only the packaging words go —
 * quantization, bit width, the format — so a variant such as `-MTP` or `-Coder` stays its own model.
 */
export function modelFamily(name) {
  return String(name).split('/').pop().toLowerCase()
    .replace(/\.gguf$/, '')
    .split(/[-_.](?=(?:ud|i?q\d[a-z0-9_]*|\d+bit|bf16|f16|f32|fp16|mxfp4|nvfp4|gguf|mlx|awq|gptq)(?:[-_.]|$))/)[0];
}

/**
 * The engine a model on disk starts with: the app whose folder holds it, because that app downloaded it
 * and is known to load it. Grid's engine can be older than the app and refuse a new architecture, so a
 * file is moved to it only when its own app is not installed. `~/.grid/models`, the Hugging Face cache and
 * plain folders have no app of their own: GGUF goes to Grid's engine, MLX to mlx-lm, safetensors to vLLM
 * or SGLang. `running` says whether that app already answers here; `null` engine means nothing here runs it.
 */
export function startWith(model, machine, answering = []) {
  const installed = kind => machine.engines.some(e => e.kind === kind);
  // Installed is enough: `--version` took 10.8s while a llama-server was serving [run], past the probe's
  // deadline, and a slow answer must not turn the person's own llama.cpp into Grid's.
  const yourLlama = machine.engines.find(e => e.kind === 'llama.cpp' && e.note !== "Grid's own engine");
  const up = kind => answering.some(e => e.kind === kind);
  const grid = { engine: 'llama.cpp', label: "Grid's llama.cpp" };
  const byFormat = () => {
    if (model.format === 'gguf') return grid;
    if (model.format === 'mlx') {
      if (!machine.canRun.includes('mlx-lm')) return null;
      return !installed('mlx-lm') && installed('lm-studio') ? { engine: 'lm-studio', label: 'lm-studio', running: up('lm-studio') } : { engine: 'mlx-lm', label: 'mlx-lm' };
    }
    const gpu = ['vllm', 'sglang'].filter(kind => machine.canRun.includes(kind));
    if (!gpu.length) return null;
    const here = gpu.filter(installed);
    return { engine: (here[0] ?? gpu[0]), label: here.length ? here.join(' or ') : `${gpu.join(' or ')} (not installed)` };
  };
  if (model.source === 'ollama' && installed('ollama')) return { engine: 'ollama', label: 'ollama', running: up('ollama') };
  if (model.source === 'lm-studio' && installed('lm-studio')) return { engine: 'lm-studio', label: 'lm-studio', running: up('lm-studio') };
  // llama.cpp's `-hf` downloads: its own cache folder in older builds, the Hugging Face cache since (build
  // 11146 put Qwen3-4B there [run]). Nothing else downloads GGUF files into that cache to run them.
  if (yourLlama && (model.source === 'llama.cpp' || (model.source === 'huggingface' && model.format === 'gguf'))) {
    return { engine: 'llama.cpp', label: 'your llama.cpp', path: yourLlama.path };
  }
  return byFormat();
}

/**
 * The inventory as a short table an agent reads directly, so it never writes its own filter over the
 * JSON (an agent's hand-written `jq` once dropped every MLX model and reported none on disk).
 */
export function summarize({ machine, engines, models, joined = [] }, contextTokens = 65536) {
  const mem = machine.memory ?? {};
  const gpus = machine.accelerators.map(g => `${g.vendor}${g.name ? ` ${g.name}` : ''} ${g.active ? 'active' : `INACTIVE (${g.error ?? 'no answer'})`}${g.totalBytes ? ` ${gb(g.totalBytes)}` : ''}`);
  const lines = [
    `machine   ${machine.chip ?? '?'} · ${machine.platform}/${machine.arch} · memory ${gb(mem.totalBytes)}, available ${gb(mem.availableBytes)}, swap used ${gb(mem.swapUsedBytes)}`,
    `gpu       ${gpus.join(' · ') || 'none'}`,
    `installed ${machine.engines.map(e => `${e.kind}${e.version ? ` ${e.version}` : ''}${e.note ? ` (${e.note})` : ''}`).join(' · ') || 'none'}`,
    `can run   ${machine.canRun.join(', ')}`,
    `answering ${engines.map(e => `${e.kind} ${e.url} [${e.models.slice(0, 3).join(', ')}]`).join(' · ') || 'none'}`,
    `joined    ${joined.map(j => `${j.grid ?? j.gridId} serving [${j.models.join(', ')}]${j.at ? ` at ${j.at}` : ''}`).join(' · ') || 'none'}${joined.length ? ' — a join to that grid adds to what it serves (Grid 0.3.53+)' : ''}`,
    `ports in use ${machine.listeningPorts.join(' ')}`,
    '',
    `FORMAT       SIZE     CONTEXT  CACHE@${contextTokens / 1024}K  TOOLS VISION  START WITH                  MODEL (where)`,
  ];
  // On Apple silicon with an MLX engine installed, a GGUF that also exists as an MLX folder says so on
  // its own row: an agent handed the rule "prefer the MLX copy" still served the GGUF, because nothing
  // told it the two names were one model [run].
  const mlxHere = machine.canRun.includes('mlx-lm') && machine.engines.some(e => e.kind === 'mlx-lm' || e.kind === 'lm-studio');
  const mlxCopies = new Map();
  if (mlxHere) for (const m of models) if (m.format === 'mlx') mlxCopies.set(modelFamily(m.name), m.name);
  for (const m of models) {
    const facts = m.gguf ?? m.config ?? {};
    const kv = facts.kvBytesPerToken;
    const runnable = m.readableBy.some(reader => machine.canRun.includes(reader));
    const mlxCopy = m.format === 'gguf' ? mlxCopies.get(modelFamily(m.name)) : null;
    const note = [runnable ? '' : `no engine this machine can run reads ${m.format}${m.format === 'mlx' ? ' (Apple silicon only)' : ''}`,
      mlxCopy ? `an MLX copy is on disk (${mlxCopy}): serve that one on this Mac unless vision is needed` : '',
      m.gguf?.unsupportedTensorTypes?.length ? `llama.cpp cannot load (tensor type ${m.gguf.unsupportedTensorTypes.join(', ')})` : '',
      facts.contextLength && facts.contextLength < contextTokens ? `context ${facts.contextLength} < ${contextTokens}` : '',
      m.missingFiles ? `download unfinished: ${m.missingFiles} of ${m.weightFiles} weight files missing` : '',
      m.error ?? ''].filter(Boolean).join('; ');
    lines.push([
      m.format.padEnd(11), gb(m.bytes).padStart(8), String(facts.contextLength ?? '—').padStart(8),
      (kv ? gb(kv * contextTokens) : '—').padStart(10), String(facts.toolCalls ?? '?').padEnd(5), (m.projector ? 'yes' : 'no').padEnd(6),
      startLabel(startWith(m, machine, engines)).padEnd(27), `${m.name} (${m.source}${m.alsoAt.length ? `, also ${m.alsoAt.map(a => a.source).join('/')}` : ''})${note ? `  ! ${note}` : ''}`,
    ].join(' '));
  }
  return lines.join('\n');
}

const startLabel = start => (start ? `${start.label}${start.running === undefined ? '' : start.running ? ' (running)' : ' (start it)'}` : '—');

/** The whole picture for one start decision: memory now, engines answering, and models on disk. */
export async function inventory({ extraRoots = [], extraPorts = [], env = process.env, home = homedir() } = {}) {
  const machine = await machineState({ env, home });
  const roots = [...defaultRoots(env, home), ...extraRoots.map(path => ({ source: 'folder', path }))];
  const ports = [...KNOWN_PORTS, ...machine.listeningPorts.filter(port => port >= 1024), ...extraPorts];
  const [engines, disk, joined] = await Promise.all([probeEngines(ports), scanModels({ roots }), joinedGrids(env.GRID_HOME || join(home, '.grid'))]);
  if (joined.length) {
    // Run files carry the grid id; the name the agent uses comes from the CLI's own list.
    let grids = [];
    try { grids = JSON.parse(await output(env.GRID_CLI || 'grid', ['ls', '--json'], 8_000)); } catch {}
    for (const row of joined) row.grid = (Array.isArray(grids) ? grids : []).find(g => g.id === row.gridId)?.grid ?? null;
  }
  return { machine, engines, joined, ...disk, models: disk.models.map(model => ({ ...model, startWith: startWith(model, machine, engines) })) };
}
