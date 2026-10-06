/** Models other apps on this computer already downloaded — Ollama, LM Studio, llama.cpp — offered in the
 * Models picker and started with the app that holds them, the rule the Model Manager reads as START WITH:
 * that app downloaded the file and is known to load it, where Grid's engine can be older and refuse a new
 * architecture. Grid's llama.cpp starts one only when its app is not installed here. */
import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { basename, join } from 'node:path'
import { processExists } from './processLiveness.js'

export type AppEngine = 'ollama' | 'lm-studio' | 'llama.cpp'
export const APP_LABEL: Record<AppEngine, string> = { ollama: 'Ollama', 'lm-studio': 'LM Studio', 'llama.cpp': 'llama.cpp' }
/** What a model Grid's own llama.cpp serves runs in, named like the apps beside it. */
export const GRID_LABEL = 'Grid'
export const MIN_APP_CONTEXT = 64 * 1024
/** The window a model is given when it can hold more: an agent's need, and what the Model Manager gives. */
export const APP_CONTEXT = 128 * 1024

export interface AppModel {
  /** `app:<app>:<what that app calls it>` — stable across reads, so an operation keeps its row. */
  id: string; name: string; app: AppEngine
  /** What starts it: its own app, or Grid's llama.cpp (`grid`) when that app is not installed here. */
  engine: AppEngine | 'grid'
  /** Ollama: `name:tag`. LM Studio: its model key. llama.cpp and `grid`: the weights file. */
  ref: string
  /** The app's own binary (`ollama`, `lms`, `llama-server`); absent for `grid`. */
  binary?: string
  sizeBytes: number; quant?: string; contextLength?: number; kvBytesPerToken?: number
}

/** One engine this daemon started for a picker model, kept on disk so Stop and the list outlive a restart. */
export interface AppEngineRecord {
  spec: 1; modelId: string; grid: string; engine: AppEngine; name: string
  /** What the engine itself calls the model, and the name the grid lists it under. */
  served: string; alias: string
  port: number; binary: string; pid?: number
  /** LM Studio's server was off and this started it, so Stop turns it off again. */
  startedServer?: boolean
}

type Exec = (file: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<{ ok: boolean; stdout: string; stderr: string }>
const exec: Exec = (file, args, options = {}) => new Promise(resolve => {
  execFile(file, args, { env: options.env, timeout: options.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }))
})

const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const rows = (v: unknown): Record<string, any>[] => Array.isArray(v) ? v.map(obj) : []
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
const safe = (v: string): boolean => !!v && !v.startsWith('-') && !/[\x00-\x1f]/.test(v)

/** `org_repo-GGUF_file.gguf`, the name `llama-server -hf` gives a download, read as the file's own name. */
export function cacheName(name: string): string {
  return name.replace(/\.gguf$/i, '').replace(/^[^_]+_.+?-GGUF_/i, '')
}

/**
 * The picker's models from other apps: Ollama's and llama.cpp's from the Model Manager's own scan
 * (`fleet models --json`, whose `startWith` is the rule), LM Studio's from `lms ls`, the only place that
 * names the key `lms load` takes. Only what a coding agent can run: 64K or more, tool calls not ruled out,
 * and a file the engine reads. A scan that fails is no models, never an error over the whole picker.
 */
export async function scanAppModels({ node, packageDir, env, run = exec }: {
  node: string; packageDir: string | null; env: NodeJS.ProcessEnv; run?: Exec
}): Promise<AppModel[]> {
  if (!packageDir) return []
  const scan = await run(node, [join(packageDir, 'toolchain', 'fleet.mjs'), 'models', '--json'], { env, timeout: 60_000 })
  if (!scan.ok) return []
  let found: Record<string, any>
  try { found = obj(JSON.parse(scan.stdout)) } catch { return [] }
  const engines = rows(obj(found.machine).engines)
  const installed = (kind: string) => engines.find(e => e.kind === kind && str(e.path))
  const lms = str(installed('lm-studio')?.path)
  const lmsUsable = !!lms && !lms.endsWith('.app')
  const result: AppModel[] = []

  for (const m of rows(found.models)) {
    const gguf = obj(m.gguf), start = obj(m.startWith)
    // A GGUF in the Hugging Face cache is llama.cpp's own download in its newer builds: listed as llama.cpp's
    // when the person has llama.cpp to start it with, and not at all otherwise (not an app's folder then).
    const app = (m.source === 'huggingface' && start.label === 'your llama.cpp' ? 'llama.cpp' : str(m.source)) as AppEngine
    if (!(app === 'ollama' || app === 'llama.cpp' || (app === 'lm-studio' && !lmsUsable))) continue
    if (m.format !== 'gguf' || m.missingFiles || m.error || !str(start.engine)) continue
    const context = num(gguf.contextLength)
    if ((context !== undefined && context < MIN_APP_CONTEXT) || gguf.toolCalls === false) continue
    let engine: AppModel['engine'] | null = null, binary: string | undefined
    if (app === 'ollama' && start.engine === 'ollama') { engine = 'ollama'; binary = str(installed('ollama')?.path) }
    else if (app === 'llama.cpp' && start.label === 'your llama.cpp' && str(start.path)) { engine = 'llama.cpp'; binary = str(start.path) }
    else if (start.engine === 'llama.cpp' && !(Array.isArray(gguf.unsupportedTensorTypes) && gguf.unsupportedTensorTypes.length)) engine = 'grid'
    if (!engine || (engine !== 'grid' && !binary)) continue
    const file = str(m.realPath) || str(m.path)
    const name = app === 'llama.cpp' ? cacheName(basename(str(m.path))) : str(m.name)
    const ref = app === 'ollama' && engine === 'ollama' ? str(m.name) : file
    if (!safe(name) || !safe(ref)) continue
    result.push({ id: `app:${app}:${app === 'ollama' ? str(m.name) : basename(str(m.path))}`, name, app, engine, ref,
      ...(binary ? { binary } : {}), sizeBytes: num(m.bytes) ?? 0, ...(str(m.quant) ? { quant: str(m.quant) } : {}),
      ...(context ? { contextLength: context } : {}), ...(num(gguf.kvBytesPerToken) ? { kvBytesPerToken: num(gguf.kvBytesPerToken) } : {}) })
  }

  if (lmsUsable) {
    const listed = await run(lms, ['ls', '--json'], { env, timeout: 30_000 })
    let models: Record<string, any>[] = []
    try { models = listed.ok ? rows(JSON.parse(listed.stdout)) : [] } catch { /* none */ }
    const canRun = Array.isArray(obj(found.machine).canRun) ? obj(found.machine).canRun as string[] : []
    for (const m of models) {
      const modelKey = str(m.modelKey)
      if (m.type !== 'llm' || !safe(modelKey) || m.trainedForToolUse === false) continue
      if (!(m.format === 'gguf' || (m.format === 'mlx' && canRun.includes('lm-studio')))) continue
      const context = num(m.maxContextLength)
      if (context !== undefined && context < MIN_APP_CONTEXT) continue
      // The key's last part is what the grid lists it as: an API name, where the display name has spaces.
      const name = modelKey.split('/').pop()!
      result.push({ id: `app:lm-studio:${modelKey}`, name, app: 'lm-studio', engine: 'lm-studio', ref: modelKey, binary: lms,
        sizeBytes: num(m.sizeBytes) ?? 0, ...(context ? { contextLength: context } : {}) })
    }
  }
  return result
}

/** The window to start [model] with: [APP_CONTEXT] when it holds that, else 64K, within [budget] bytes of
 *  memory when the model's cache per token is known. Null when not even 64K fits. */
export function appContext(model: Pick<AppModel, 'contextLength' | 'kvBytesPerToken' | 'sizeBytes'>, budget: number | undefined): number | null {
  const most = Math.min(model.contextLength ?? APP_CONTEXT, APP_CONTEXT)
  for (const ctx of [...new Set([most, MIN_APP_CONTEXT])].filter(c => c >= MIN_APP_CONTEXT)) {
    const cache = model.kvBytesPerToken ? model.kvBytesPerToken * ctx : 0
    if (budget === undefined || model.sizeBytes * 1.1 + cache + 2 * 1024 ** 3 <= budget) return ctx
  }
  return null
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** llama-server's arguments for [model] on loopback [port]. Several slots share one window (`--kv-unified`),
 *  as llama-server's own default does, so any one request can still use all of it. */
export function llamaServerArgs(model: Pick<AppModel, 'ref' | 'name'>, ctx: number, port: number, slots = 1): string[] {
  return ['-m', model.ref, '--alias', model.name, '--ctx-size', String(ctx), '--parallel', String(slots),
    ...(slots > 1 ? ['--kv-unified'] : []), '-ngl', '999', '--host', '127.0.0.1', '--port', String(port)]
}

/** Starting, checking and stopping the engines, injected so the lifecycle can be tested without them. */
export interface AppEngineOps {
  /** `slots`: how many requests the engine works on at once. A harness's model has one, so its whole window
   *  is one conversation's; a Jev model's questions are short and many, and each is its own request. */
  start(model: AppModel, ctx: number, logDir: string, slots?: number): Promise<Omit<AppEngineRecord, 'spec' | 'modelId' | 'grid' | 'name'>>
  alive(record: AppEngineRecord): Promise<boolean>
  /** The window the engine says it loaded, after a first request; undefined when it does not say. */
  loadedContext(record: AppEngineRecord): Promise<number | undefined>
  stop(record: AppEngineRecord): Promise<void>
}

export class AppStartError extends Error {}

export function appEngineOps(env: NodeJS.ProcessEnv, request: typeof fetch = fetch, run: Exec = exec): AppEngineOps {
  const get = async (url: string): Promise<{ status: number; body: Record<string, any> }> => {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' })
      return { status: response.status, body: obj(await response.json().catch(() => ({}))) }
    } catch { return { status: 0, body: {} } }
  }
  /** Up when [url] answers 200; a 503 is a model still loading. Gives up early if the process exits. */
  const ready = async (url: string, ms: number, pid?: number): Promise<boolean> => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(500)) {
      if ((await get(url)).status === 200) return true
      if (pid !== undefined && !processExists(pid)) return false
    }
    return false
  }
  const background = async (binary: string, args: string[], extra: NodeJS.ProcessEnv, logDir: string, logName: string): Promise<number> => {
    await mkdir(logDir, { recursive: true, mode: 0o700 })
    const log = openSync(join(logDir, logName), 'a', 0o600)
    try {
      // Its own process group, so it outlives this daemon and Stop ends it with whatever it started.
      const child = spawn(binary, args, { env: { ...env, ...extra }, detached: true, stdio: ['ignore', log, log] })
      child.unref()
      if (!child.pid) throw new AppStartError('The model could not start. Try again.')
      return child.pid
    } finally { closeSync(log) }
  }
  const lmsJson = async (binary: string, args: string[], timeout = 30_000): Promise<Record<string, any>> => {
    const result = await run(binary, args, { env, timeout })
    try { return obj(JSON.parse(result.stdout)) } catch { return {} }
  }
  /** The command a pid runs now, so a pid the system reused is never stopped as ours. */
  const ours = async (record: AppEngineRecord): Promise<boolean> => {
    if (!record.pid || !processExists(record.pid)) return false
    const command = await run('ps', ['-o', 'command=', '-p', String(record.pid)], { timeout: 5_000 })
    return command.ok && command.stdout.includes(basename(record.binary))
  }

  return {
    async start(model, ctx, logDir, slots = 1) {
      const binary = model.binary!
      if (model.engine === 'ollama') {
        // Its own server beside the person's Ollama app, never on the app's 11434: the window is a server
        // setting, and theirs ran every model at 16K [run]. Same model store, so nothing is copied.
        const port = await freePort()
        const pid = await background(binary, ['serve'], { OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_CONTEXT_LENGTH: String(ctx),
          OLLAMA_NUM_PARALLEL: String(slots), OLLAMA_KEEP_ALIVE: '-1' }, logDir, `ollama-${port}.log`)
        if (!await ready(`http://127.0.0.1:${port}/api/version`, 60_000, pid)) throw new AppStartError('Ollama could not start. Try again.')
        return { engine: 'ollama', served: model.ref, alias: model.name, port, binary, pid }
      }
      if (model.engine === 'llama.cpp') {
        const port = await freePort()
        const pid = await background(binary, llamaServerArgs(model, ctx, port, slots), {}, logDir, `llama-${port}.log`)
        if (!await ready(`http://127.0.0.1:${port}/health`, 10 * 60_000, pid)) {
          try { process.kill(-pid, 'SIGTERM') } catch { /* gone */ }
          throw new AppStartError('llama.cpp could not load the model. Try again.')
        }
        return { engine: 'llama.cpp', served: model.name, alias: model.name, port, binary, pid }
      }
      // LM Studio: its own background server, started when it is off, and the model loaded with the window
      // given here — a model it loads on demand gets 8K [run].
      let status = await lmsJson(binary, ['server', 'status', '--json'])
      let startedServer = false
      if (status.running !== true) {
        await run(binary, ['server', 'start'], { env, timeout: 60_000 })
        status = await lmsJson(binary, ['server', 'status', '--json'])
        startedServer = status.running === true
      }
      const port = typeof status.port === 'number' ? status.port : 0
      if (!port) throw new AppStartError('LM Studio could not start its server. Open LM Studio and try again.')
      const loaded = await run(binary, ['load', model.ref, '--context-length', String(ctx), '--gpu', 'max', '--parallel', String(slots),
        '--identifier', model.name, '-y'], { env, timeout: 10 * 60_000 })
      if (!loaded.ok) {
        if (startedServer) await run(binary, ['server', 'stop'], { env, timeout: 30_000 })
        throw new AppStartError('LM Studio could not load the model. Close some apps, or choose a smaller model.')
      }
      return { engine: 'lm-studio', served: model.name, alias: model.name, port, binary, startedServer }
    },

    async alive(record) {
      if (record.engine !== 'lm-studio') return ours(record)
      const loaded = rows((await get(`http://127.0.0.1:${record.port}/api/v0/models`)).body.data)
      return loaded.some(m => m.id === record.served && m.state === 'loaded')
    },

    async loadedContext(record) {
      const base = `http://127.0.0.1:${record.port}`
      if (record.engine === 'ollama') {
        const tagged = (name: string) => name.includes(':') ? name : `${name}:latest`
        const model = rows((await get(`${base}/api/ps`)).body.models).find(m => [m.name, m.model].some(n => tagged(str(n)) === tagged(record.served)))
        return num(model?.context_length)
      }
      if (record.engine === 'lm-studio') return num(rows((await get(`${base}/api/v0/models`)).body.data).find(m => m.id === record.served)?.loaded_context_length)
      return num(obj((await get(`${base}/props`)).body.default_generation_settings).n_ctx)
    },

    async stop(record) {
      if (record.engine === 'lm-studio') {
        await run(record.binary, ['unload', record.served], { env, timeout: 60_000 })
        if (record.startedServer) await run(record.binary, ['server', 'stop'], { env, timeout: 30_000 })
        return
      }
      if (!await ours(record)) return
      try { process.kill(-record.pid!, 'SIGTERM') } catch { /* gone */ }
      for (let i = 0; i < 20 && processExists(record.pid!); i++) await sleep(500)
      if (processExists(record.pid!)) { try { process.kill(-record.pid!, 'SIGKILL') } catch { /* gone */ } }
    },
  }
}

/** The engines this daemon started, by model id. */
export async function readAppRecords(file: string): Promise<AppEngineRecord[]> {
  try {
    return rows(JSON.parse(await readFile(file, 'utf8'))).filter(r => r.spec === 1 && str(r.modelId) && str(r.grid) &&
      ['ollama', 'lm-studio', 'llama.cpp'].includes(r.engine) && typeof r.port === 'number' && safe(str(r.alias))) as AppEngineRecord[]
  } catch { return [] }
}

export async function writeAppRecords(file: string, records: AppEngineRecord[]): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, JSON.stringify(records), { mode: 0o600 })
  await rename(temp, file)
}
