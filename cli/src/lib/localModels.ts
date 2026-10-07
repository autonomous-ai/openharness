/** The Models popover's local lifecycle. Grid remains the hardware, catalog,
 * download and process authority. A click is a durable daemon operation, never a chat task. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat, mkdir, rename, writeFile, statfs, symlink, lstat, readlink } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { GridFleetRpc, type GridFleetResult } from './gridFleetRpc.js'
import { gridCredentialsPath } from './gridCredentials.js'
import { binaryOnPath } from './binaryOnPath.js'
import { processExists } from './processLiveness.js'
import type { LocalRecord, PictureState } from './gridPicture.js'
import { displayModelName } from './gridReader.js'
import { readEnvExports } from './gridWake.js'
import { MIN_CODING_CONTEXT } from './codingContext.js'
import { APP_LABEL, AppStartError, GRID_LABEL, appContext, readAppRecords, writeAppRecords, type AppEngine, type AppEngineOps, type AppEngineRecord, type AppModel } from './appModels.js'

// Its own module, so the API launches the core keeps need not load this one (codingContext.ts).
export { MIN_CODING_CONTEXT }

const GiB = 1024 ** 3
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const rows = (v: unknown): Record<string, any>[] => Array.isArray(v) ? v.map(obj) : []
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
const key = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 24)
const cleanName = (v: string): string => basename(v).replace(/\.gguf$/i, '').replace(/-GGUF$/i, '')
// Grid advertises a GGUF filename as a lowercase model name without its extension.
const modelKey = (v: string): string => v.toLowerCase().replace(/\.gguf$/, '')
const validArg = (v: string): boolean => !!v && !v.startsWith('-') && !/[\x00-\x1f]/.test(v)
/** `grid info` statuses of a grid that is not up. Grid refuses `engines` and `join` on one, and
 * names `grid start` as the way back. Anything else unknown stays unknown rather than "down". */
const DOWN = new Set(['stopped', 'asleep'])
/** Where a start begins for a file whose header could not be read: the size a 64 GB Mac was seen
 * to hold for a 35B model, one step above the floor. */
const UNREAD_CONTEXT = 128 * 1024

/**
 * Jev (System One) decision models this harness can get and run here: they answer typed questions at
 * `/v1/systemone` and never run a harness, so they are listed apart and never moved onto. Hand-duplicated
 * with autonomous-grid's catalog (`shared/models/catalog.py`, its `kind="decision"` rows); `size` is the
 * file's own, which is how a finished download is told from a partial one.
 */
/** One file a Jev model is published as. */
export interface JevQuant { quant: string; file: string; size: number }
/** A Jev (System One) model: ggml-org's official GGUF for llama.cpp's `/v1/systemone`, which reads the model's
 *  decision type (Laya, Kev, Lev, Nimble, Clef) from the file. [quants] best first — Q8_0, and Q4_K_M for a
 *  computer that has no room for it. */
export interface JevModel {
  id: string; name: string; repo: string; quants: ReadonlyArray<JevQuant>
  /** The first llama.cpp build that runs it, when that is later than [MIN_JEV_BUILD]'s. */
  minBuild?: number
}
export const JEV_MODELS: ReadonlyArray<JevModel> = [
  { id: 'jev:ggml-org/Laya-GGUF', name: 'laya-english', repo: 'ggml-org/Laya-GGUF',
    quants: [{ quant: 'Q8_0', file: 'Laya-Q8_0.gguf', size: 449_397_600 }] },
  { id: 'jev:ggml-org/Kev-0.8B-GGUF', name: 'kev-0.8b', repo: 'ggml-org/Kev-0.8B-GGUF',
    quants: [{ quant: 'Q8_0', file: 'Kev-0.8B-Q8_0.gguf', size: 812_406_304 }] },
  { id: 'jev:ggml-org/Kev-4B-GGUF', name: 'kev-4b', repo: 'ggml-org/Kev-4B-GGUF', quants: [
    { quant: 'Q8_0', file: 'Kev-4B-Q8_0.gguf', size: 4_483_801_504 }, { quant: 'Q4_K_M', file: 'Kev-4B-Q4_K_M.gguf', size: 3_033_489_824 }] },
  { id: 'jev:ggml-org/lev-GGUF', name: 'lev', repo: 'ggml-org/lev-GGUF', quants: [
    { quant: 'Q8_0', file: 'lev-Q8_0.gguf', size: 4_482_405_280 }, { quant: 'Q4_K_M', file: 'lev-Q4_K_M.gguf', size: 3_011_777_440 }] },
  { id: 'jev:ggml-org/Kev-9B-GGUF', name: 'kev-9b', repo: 'ggml-org/Kev-9B-GGUF', quants: [
    { quant: 'Q8_0', file: 'Kev-9B-Q8_0.gguf', size: 9_529_735_648 }, { quant: 'Q4_K_M', file: 'Kev-9B-Q4_K_M.gguf', size: 6_358_923_744 }] },
  { id: 'jev:ggml-org/Bespoke-Nimble-9B-v3-GGUF', name: 'nimble-9b', repo: 'ggml-org/Bespoke-Nimble-9B-v3-GGUF', quants: [
    { quant: 'Q8_0', file: 'Bespoke-Nimble-9B-v3-Q8_0.gguf', size: 9_527_503_392 },
    { quant: 'Q4_K_M', file: 'Bespoke-Nimble-9B-v3-Q4_K_M.gguf', size: 6_324_185_632 }] },
  // Clef's own architecture came after `/v1/systemone` itself (ggml-org/llama.cpp#29831, b11371).
  { id: 'jev:ggml-org/Clef-Flash-GGUF', name: 'clef-flash', repo: 'ggml-org/Clef-Flash-GGUF', minBuild: 11371, quants: [
    { quant: 'Q8_0', file: 'Clef-Flash-Q8_0.gguf', size: 9_657_260_192 }, { quant: 'Q4_K_M', file: 'Clef-Flash-Q4_K_M.gguf', size: 6_486_448_288 }] },
  { id: 'jev:ggml-org/Clef-GGUF', name: 'clef', repo: 'ggml-org/Clef-GGUF', minBuild: 11371, quants: [
    { quant: 'Q8_0', file: 'Clef-Q8_0.gguf', size: 28_732_215_360 }, { quant: 'Q4_K_M', file: 'Clef-Q4_K_M.gguf', size: 19_232_219_200 }] },
]
/** The memory a Jev model of [size] bytes takes to start: its weights, the window its slots share and
 *  llama.cpp's working buffers — 15% over the file, and a GiB. */
export const jevMemory = (size: number): number => Math.ceil(size * 1.15) + GiB
const isJev = (id: string): boolean => id.startsWith('jev:')
const concurrencyArgs = (limit: number | undefined): string[] => limit === undefined ? [] : ['--max-concurrency', String(limit)]
/** The first llama.cpp build that serves `/v1/systemone` (ggml-org/llama.cpp#29818). An older one
 * cannot even load a decision GGUF, so Get updates Grid's engine below it — and Grid itself refuses. */
export const MIN_JEV_BUILD = 11361
/** A decision model's window: its state and options, never a conversation. */
const JEV_CONTEXT = 8192
/** Questions a Jev engine answers at once. Each question of a request is its own task in llama.cpp, so a
 *  request's questions are answered side by side: 8 took 0.11 s on 4 slots against 0.17 s on 1 (Laya, M-series). */
export const JEV_SLOTS = 4
/** Requests a node of this computer's takes at once, through Grid: its chat model's one, and a Jev model's slots. */
export const NODE_CONCURRENCY = 1 + JEV_SLOTS

/** The build a llama-server reports (`version: 0.5.0 (build 11146, …)`, or `version: 10369 (…)` before
 * llama.cpp's semver releases); undefined when it is missing or does not say. 30 s: a binary macOS has
 * not run lately took 10.7 s to answer its first `--version` [run]. */
export function llamaBuild(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<number | undefined> {
  return new Promise(resolve => {
    execFile(binary, ['--version'], { env, timeout: 30_000 }, (_error, stdout, stderr) => {
      const text = `${stdout}${stderr}`
      const build = /\(build (\d+)/.exec(text)?.[1] ?? /version:\s*(\d+)\b/.exec(text)?.[1]
      resolve(build ? Number(build) : undefined)
    })
  })
}

/** The context sizes a start tries, largest first: [first], then halved, ending on the 64K floor.
 * 256K → 128K → 64K. Empty when even [first] is under the floor. */
export function contextLadder(first: number): number[] {
  const sizes: number[] = []
  for (let ctx = Math.floor(first); ctx >= MIN_CODING_CONTEXT; ctx = Math.floor(ctx / 2)) sizes.push(ctx)
  if (sizes.length && sizes.at(-1)! > MIN_CODING_CONTEXT) sizes.push(MIN_CODING_CONTEXT)
  return sizes
}

/** A port nothing on this machine is listening on, for the engine to take. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** The longest a scan of other apps' models is waited for (`fleet models` alone has a 60s deadline). */
export const APP_SCAN_MS = 90_000
/** What llama.cpp answers once its GPU backend has failed an allocation — every request after. */
const OUT_OF_MEMORY = /compute error|out of memory|insufficient memory|failed to allocate/i

export interface LocalModel {
  id: string; name: string; state: 'available' | 'downloaded' | 'running'
  sizeBytes?: number; quant?: string; recommended?: boolean; canStart: boolean; canStop: boolean
  tokensPerSecond?: number; requests?: number; windowSeconds?: number
  /** `decision`: a Jev (System One) model — Get and Stop, never Use (additive; an older app ignores it). */
  kind?: 'decision'
  /** What the catalog says of this model on THIS machine, for choosing between models before any
   * download: the window it will be given, its estimated speed, and its size in billions of
   * parameters. Absent for a model found on disk, which the catalog never sized. */
  contextWindow?: number; estTokS?: number; paramsB?: number
  operation?: ModelOperation
  /** Running here, parked while its grid sleeps (additive: an older desktop reads plain `running`). */
  gridAsleep?: boolean
  /** What it runs in: `Grid` for a model Grid's llama.cpp serves, or the app whose folder holds it
   *  (`Ollama`, `LM Studio`, `llama.cpp`, [AppModel]). Absent for a catalog model not downloaded yet. */
  app?: string
}
export interface ModelOperation {
  id: string; modelId: string; action: 'download' | 'start' | 'stop'; phase: 'running' | 'done' | 'failed'
  stage: 'checking' | 'downloading' | 'updating' | 'starting' | 'verifying' | 'stopping'
  progress?: number; error?: string; updatedAt: string
}
export interface LocalModelsSnapshot {
  models: LocalModel[]; memoryBytes?: number; hardware?: string
  /** A sentence to show BESIDE the list — never `error`. On this protocol an `error` field fails
   * the whole request: the app's RPC layer drops the reply and keeps nothing of it, so a list sent
   * with a warning in `error` arrived as no list at all and the Local tab read 0. */
  notice?: string
  observedAt: string; busy: boolean
  supportsDownload?: boolean
  /** Free space where downloads land, so a download's size can be read against it. */
  freeDiskBytes?: number
}
export interface Candidate {
  id: string; name: string; pull: string; file: string; files: string[]; size: number; quant: string
  /** The window to pin at start: the catalog's fit for this machine, which is the largest it can
   * hold. Absent for a model found on disk, which the catalog never sized — the engine then measures
   * free memory at load and takes the largest window that fits (`grid join` without `--ctx-size`). */
  context?: number
  aliases?: string[]
  /** The catalog's estimate for this machine, and the model's size in billions of parameters. */
  estTokS?: number; paramsB?: number
  /** A file another app downloaded, served by Grid's llama.cpp because that app is not installed here:
   *  `file` is the link to it in Grid's models folder, made at Start. */
  appPath?: string
}
/** `live`: its heartbeat sidecar is fresh (the grid is hearing from it). `pidAlive`: the process its run
 *  record names exists — the only liveness that holds while the grid sleeps and the sidecar goes stale. */
/** `slotted`: it launches with a slot count of its own (`--parallel`). Grid gives a built-in engine without one a
 *  slot per request its node takes, each with the engine's whole window. */
interface Owned { file: string; selector: string; aliases: string[]; nodeId: string; name: string; live: boolean; pidAlive: boolean; siblings: number; slotted: boolean }
interface Receipt { spec: 1; grid: string; operation?: ModelOperation }
/** What the grid says is running on it, read WITHOUT waking it (`gridModels.gridInventory`): the
 * overview's node objects while it is awake, nothing while it sleeps — and its owner status (`running`,
 * `stopped`, `asleep`; null for a member or when it could not be read), remembered rather than asked on
 * every tick. */
export interface GridInventory { state: PictureState; nodes: Record<string, unknown>[]; status: string | null }
interface Options {
  stateDir: string; processEnv?: NodeJS.ProcessEnv
  /** This machine's name as Harness shows it. Grid labels an engine with its `--name`, and without
   * one it takes the host name — so a model started here read `mac.lan` under "On your machines"
   * while Machines called the same computer `M2`. */
  machineName?: () => string | null | undefined
  run?: (args: string[], output?: (chunk: string) => void, timeout?: number) => Promise<GridFleetResult>
  request?: typeof fetch
  /** Injected, never a `grid engines` call: that read carries the grid credential, and a signed-in read
   * of a sleeping grid WAKES it — once a tick, for as long as the panel is open. */
  inventory: (grid: string, force: boolean) => Promise<GridInventory>
  /** Told when a start or stop has finished, so the model lists are read again. */
  onChanged?: () => void
  /** Models other apps downloaded here ([scanAppModels]), and the engines that start them. Absent: none. */
  appModels?: () => Promise<AppModel[]>
  appEngines?: AppEngineOps
  /** How long a scan is waited for ([APP_SCAN_MS]); a test shortens it. */
  appScanMs?: number
}

/** One concrete, machine-fitted version per model. Non-chat and unprobed offline
 * catalog rows are never called compatible. Split GGUF files stay one model.
 *
 * ⚠️ A model whose fit on this machine is under [MIN_CODING_CONTEXT] is not offered at all. It used
 * to be, pinned at 16K — a model that loads, answers "ok", and then cannot hold a coding agent's
 * first prompt. The context pinned is the whole fit, not a slice of it: the fit is already the
 * largest window this machine can hold beside the weights. */
export function compatibleModels(raw: unknown): Candidate[] {
  const seen = new Set<string>()
  return rows(obj(raw).models).flatMap(row => {
    const fit = obj(row.fit)
    if (row.runnable !== true || !['text-generation', 'image-text-to-text'].includes(row.task) || row.format !== 'GGUF') return []
    const version = rows(row.versions).find(v => v.version === fit.version)
    const pull = str(version?.pull_spec), size = num(version?.size_bytes)
    const id = str(row.repo_id), split = pull.indexOf(':')
    const fitted = Math.floor(Math.min(num(fit.ctx) ?? 0, num(fit.max_ctx) ?? Infinity))
    if (!id || seen.has(id) || !validArg(pull) || split < 1 || !size || fitted < MIN_CODING_CONTEXT) return []
    const file = basename(pull.slice(split + 1))
    if (!file.toLowerCase().endsWith('.gguf')) return []
    const files = (Array.isArray(version?.urls) ? version.urls : []).flatMap((url: unknown) => {
      try { return [basename(decodeURIComponent(new URL(str(url)).pathname))] } catch { return [] }
    })
    seen.add(id)
    const estTokS = num(fit.est_tok_s), paramsB = num(row.params_b)
    return [{ id, name: cleanName(id), pull, file, files: files.length ? files : [file], size,
      quant: str(fit.version), context: fitted,
      ...(estTokS ? { estTokS } : {}), ...(paramsB ? { paramsB } : {}) }]
  })
}

/** One model, whatever its quantization: `Qwen3.6-35B-A3B`, `Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf` and
 * `unsloth/Qwen3.6-35B-A3B-GGUF` are the same model. */
export function modelFamily(name: string): string {
  return cleanName(name).toLowerCase()
    .replace(/[-_.](?:ud[-_])?(?:iq\d\w*|q\d\w*|mxfp\d\w*|bf16|fp16|f16)$/, '')
}

/** A catalog download is not offered for a model this machine already has in another quantization:
 * running Qwen3.6-35B-A3B at Q5_K_XL, the catalog's Q4_K_M of it is a second copy, 20 GB of it, of
 * the same model. A download already under way stays listed, so its progress has a row. */
export function withoutCopiesOfOwned(models: LocalModel[]): LocalModel[] {
  const owned = new Set(models.filter(model => model.state !== 'available').map(model => modelFamily(model.name)))
  return models.filter(model => model.state !== 'available' || model.canStop || model.operation?.phase === 'running' ||
    !owned.has(modelFamily(model.name)))
}

/** The speed a coding agent can work at: an agent waits on every token it writes, and below this the
 * catalog's estimate for this machine reads as a model that crawls. On a bandwidth-bound Mac this is
 * what separates an MoE (35-80 tok/s on an M1 Max) from a dense model of its size (9-17). */
export const USABLE_TOK_S = 20

/** The share of a machine's memory one model may fill — weights, a coding agent's context and the
 * engine's overhead together, as the catalog fits them. The rest stays for everything else the person
 * runs: on a 64 GB Mac, a 45 GB model with its context left the editor, the browser and the agents
 * themselves fighting over what remained. */
export const MODEL_MEMORY_SHARE = 0.5

/** The budget the catalog fits models to: what the machine can spare ([MODEL_MEMORY_SHARE] of its
 * memory), never more than grid says it has free. Undefined when grid reports neither.
 *
 * Only where a model shares its memory with everything else — an Apple Silicon Mac's unified memory,
 * or system RAM on a machine with no usable GPU. An NVIDIA card's VRAM is the model's own: grid
 * reports what is free on it now (total less what is already in use, the desktop's share included),
 * and all of that goes to the catalog, whose fit keeps its own 10% margin. Capping it at half the
 * system RAM would have held a 24 GB card in a 32 GB PC to 16 GB. */
export function modelBudget(device: Record<string, any>): number | undefined {
  const usable = num(device.usable_bytes), total = num(obj(device.memory).total_gb)
  if (usable === undefined) return undefined
  if (device.backend === 'cuda' || total === undefined) return usable
  return Math.min(usable, Math.floor(total * GiB * MODEL_MEMORY_SHARE))
}

/** Catalog models that are not for running an agent on: safety classifiers such as gpt-oss-safeguard
 * or Llama Guard, which answer "safe"/"unsafe" rather than code. */
const NOT_FOR_AGENTS = /(?:^|[-_/])(?:safeguard|guard|shieldgemma)(?:[-_.]|$)/i

/** Roughly how many bits a weight takes at [quant]: Q4 about 4.8, IQ4 about 4.3, MXFP4 4.25. */
function bitsPerWeight(quant: string): number {
  const q = quant.toUpperCase()
  if (/MXFP4/.test(q)) return 4.25
  if (/BF16|FP16|F16/.test(q)) return 16
  const digit = /(IQ|Q)(\d)/.exec(q)
  return digit ? Number(digit[2]) + (digit[1] === 'IQ' ? 0.3 : 0.8) : 4.8
}

/** A model's size in billions of parameters: the catalog's count, else read off its weights and quant. */
function paramsOf(candidate: Candidate): number {
  return candidate.paramsB ?? candidate.size * 8 / bitsPerWeight(candidate.quant) / 1e9
}

/** A model and its variants — MTP, QAT, REAP-pruned, instruct/thinking/`-it` — as one base model:
 * `Qwen3.6-35B-A3B-MTP` and `Qwen3.6-35B-A3B`, `gemma-4-E4B-it-qat` and `gemma-4-E4B-it`. A fine-tune
 * under its own name (`Qwen-AgentWorld-35B-A3B`) is a model of its own. */
export function baseModel(name: string): string {
  let base = modelFamily(name)
  for (;;) {
    const next = base.replace(/[-_](?:mtp|qat|reap(?:-\d+b)?(?:-a\d+b)?|instruct|thinking|it)$/, '')
    if (next === base) return base
    base = next
  }
}

/** A quant under this many bits per weight (Q2, IQ2, IQ1) trades too much of the model away: a
 * 2-bit 122B is not the better model than a 4-bit 35B beside it. */
const MIN_FAITHFUL_BITS = 3

/** The shape a model's name gives an MoE, `35B-A3B` — shared by its fine-tunes under other names
 * (`Qwen-AgentWorld-35B-A3B` is Qwen3.6-35B-A3B retrained). Null for a name that gives none. */
function moeShape(name: string): string | null {
  const shape = /(?:^|[-_])(\d+(?:\.\d+)?)B-A(\d+(?:\.\d+)?)B(?:[-_.]|$)/i.exec(name)
  return shape ? `${shape[1]}b-a${shape[2]}b` : null
}

/** Two catalog rows with the same parameter count, the same file size and the same speed estimate are
 * one architecture: the estimate is the machine's bandwidth over the bytes a token reads, which only
 * the same geometry at the same quant repeats. That is how a fine-tune under a name of its own
 * (Ornith-1.0-35B beside Qwen3.6-35B-A3B: 20.6 GB, 78.2 tok/s both) reads as the model it is. */
function sameArchitecture(a: Candidate, b: Candidate): boolean {
  return Math.round(paramsOf(a)) === Math.round(paramsOf(b)) && Math.abs(a.size - b.size) <= 0.03 * b.size &&
    !!a.estTokS && !!b.estTokS && Math.abs(a.estTokS - b.estTokS) <= 0.02 * b.estTokS
}

/** The order the Get list offers a machine's downloads in. Every candidate already fits the machine
 * with a coding agent's context, within its [MODEL_MEMORY_SHARE] ([compatibleModels]); among them:
 *  1. a faithful quant first — under [MIN_FAITHFUL_BITS] a model goes after every model at one;
 *  2. fast enough to work with first — the catalog's estimate for this machine at [USABLE_TOK_S] or
 *     more. That is what preferring MoE models on a bandwidth-bound Mac comes to, read per machine, and
 *     it lets dense models in on a machine fast enough for them;
 *  3. then bigger first, the better model;
 *  4. then the catalog's own order, which is popularity among what fits.
 * And one version of each model before any second one, so its MTP, QAT and pruned variants
 * ([baseModel]), its fine-tunes sharing its MoE shape ([moeShape]) or its architecture
 * ([sameArchitecture]) never fill the top of the list: they follow every other model, in this order. */
export function rankForCoding<T extends Candidate>(candidates: T[]): T[] {
  const faithful = (candidate: Candidate): number => bitsPerWeight(candidate.quant) >= MIN_FAITHFUL_BITS ? 1 : 0
  const fast = (candidate: Candidate): number => (candidate.estTokS ?? 0) >= USABLE_TOK_S ? 1 : 0
  const sorted = candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) =>
    faithful(b.candidate) - faithful(a.candidate) ||
    fast(b.candidate) - fast(a.candidate) ||
    Math.round(paramsOf(b.candidate)) - Math.round(paramsOf(a.candidate)) ||
    a.index - b.index).map(({ candidate }) => candidate)
  const seen = new Set<string>(), first: T[] = [], again: T[] = []
  for (const candidate of sorted) {
    const names = [baseModel(candidate.name), moeShape(candidate.name)].filter((name): name is string => !!name)
    const repeat = names.some(name => seen.has(name)) || first.some(leader => sameArchitecture(candidate, leader))
    ;(repeat ? again : first).push(candidate)
    for (const name of names) seen.add(name)
  }
  return [...first, ...again]
}

export class LocalModels {
  private readonly processEnv: NodeJS.ProcessEnv
  private readonly home: string
  private readonly run: NonNullable<Options['run']>
  private readonly request: typeof fetch
  private candidates: Candidate[] = []
  private device: Record<string, any> = {}
  private catalogAt = 0
  private catalogError: string | undefined
  private catalogPending?: Promise<void>
  private listPending?: Promise<LocalModelsSnapshot>
  private listGrid?: string
  private cached?: { at: number; grid: string; value: LocalModelsSnapshot }
  /** The models the last read of each grid found running — kept past `cached`, which any save clears. */
  private readonly runningAtLastRead = new Map<string, Set<string>>()
  private active?: { grid: string; operation: ModelOperation; done: Promise<void> }
  private receipt?: Receipt
  private receiptScope?: string
  private knownByGrid = new Map<string, Candidate[]>()
  private blockers = new Map<string, string>()
  private appsRead?: { at: number; value: AppModel[] }
  private appsPending?: Promise<AppModel[]>

  constructor(private readonly options: Options) {
    this.processEnv = options.processEnv ?? process.env
    this.home = dirname(gridCredentialsPath(this.processEnv))
    const rpc = new GridFleetRpc(this.processEnv)
    this.run = options.run ?? ((args, output, timeout = 30_000) =>
      rpc.run('local-models', randomUUID(), { args, timeoutMs: timeout, thinking: false }, output, 4 * 1024 * 1024))
    this.request = options.request ?? fetch
  }

  private async json(args: string[]): Promise<any> {
    const result = await this.run(args)
    if (!result.ok) throw new Error('Models could not be checked. Try again.')
    try { return JSON.parse(result.stdout) } catch { throw new Error('Models could not be checked. Try again.') }
  }

  /** The same authenticated catalog Grid uses, paged until every compatible row
   * is included. Credentials never enter RPC replies, receipts, arguments or logs. */
  private async catalog(device: Record<string, any>): Promise<unknown> {
    const top = (await readFile(gridCredentialsPath(this.processEnv), 'utf8')).split(/^\s*\[/m)[0]
    const value = (name: string): string => {
      const match = new RegExp(`^\\s*${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*$`, 'm').exec(top)
      if (!match) return ''
      try { return match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1) } catch { return '' }
    }
    const token = value('session_token')
    if (!token) throw new Error('Sign in to find models for this computer.')
    const base = value('api_url') || this.processEnv.GRID_CONTROL_PLANE_URL || 'https://api-grid.autonomous.ai'
    const url = new URL(`${base.replace(/\/$/, '')}/v1/grid/catalog`)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('The model catalog address is unavailable.')
    }
    // Match `grid catalog`/`list` (cli/models.py `_fetch_pullable`): browse the
    // catalog service's first page of ranked "popular" models for this device,
    // not every compatible row across all pages — the picker shows one page.
    // ⚠️ The machine's measured memory bandwidth and compute go too: the service estimates speed
    // from them (grid_cli/catalog/ranking.py) and, without them, assumes 150 GB/s and 4 TFLOPS for
    // any Mac — an M1 Max's 400 GB/s read as 2.7x slower than it is, and the models whose prompt it
    // then judged too slow to process were not offered at all.
    const bandwidth = num(device.mem_bandwidth_gbps), compute = num(device.compute_gflops)
    const budget = modelBudget(device)
    const response = await this.request(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ browse: true, page: 1, page_size: 50, device: {
        device_class: device.device_class, usable_bytes: budget ?? device.usable_bytes, backend: device.backend,
        ...(bandwidth ? { mem_bandwidth_gbps: bandwidth } : {}), ...(compute ? { compute_gflops: compute } : {}),
      } }), signal: AbortSignal.timeout(20_000), redirect: 'error',
    })
    if (!response.ok) throw new Error('Compatible models are unavailable. Try again.')
    const body = obj(await response.json())
    if (!Array.isArray(body.models)) throw new Error('Compatible models are unavailable. Try again.')
    return { models: body.models }
  }

  private async loadCatalog(force = false): Promise<void> {
    if (!force && this.catalogAt && Date.now() - this.catalogAt < 5 * 60_000) return
    return this.catalogPending ??= (async () => {
      try {
        this.device = obj(await this.json(['device-info', '--json']))
        const catalog = obj(await this.catalog(this.device))
        this.candidates = rankForCoding(compatibleModels(catalog).filter(candidate => !NOT_FOR_AGENTS.test(candidate.id)))
        // Prefer an already downloaded fitting quant rather than downloading
        // the catalog's default version of the same model again.
        for (let i = 0; i < this.candidates.length; i++) {
          const chosen = this.candidates[i]
          if (await this.downloaded(chosen)) continue
          const source = rows(catalog.models).find(m => m.repo_id === chosen.id)
          for (const version of rows(source?.versions)) {
            if ((num(version.size_bytes) ?? Infinity) > chosen.size) continue
            const alternate = compatibleModels({ models: [{ ...source, fit: { ...source?.fit, version: version.version } }] })[0]
            if (alternate && await this.downloaded(alternate)) { this.candidates[i] = alternate; break }
          }
        }
        this.catalogError = undefined
        this.catalogAt = Date.now()
      } catch (error) {
        this.catalogError = error instanceof Error && /^(Sign in|The model catalog)/.test(error.message)
          ? error.message : 'Compatible models are unavailable. Try again.'
      }
    })().finally(() => { this.catalogPending = undefined })
  }

  /** This computer's profile now — the memory free on an NVIDIA card moves — or the last one read when grid
   *  does not answer. */
  private async readDevice(): Promise<Record<string, any>> {
    try { this.device = obj(await this.json(['device-info', '--json'])) } catch { /* the last read stands */ }
    return this.device
  }

  private async fileComplete(file: string, size: number): Promise<boolean> {
    return stat(join(this.home, 'models', file)).then(s => s.isFile() && s.size === size, () => false)
  }

  /** The file of [jev] this computer has or would get: one already here — whole, or a download to resume —
   *  else the best that fits [budget] ([modelBudget]: an NVIDIA card's free VRAM, half of an Apple Silicon
   *  Mac's unified memory). Undefined when none fits, or the budget is unknown: only a model that can start
   *  is offered. */
  private async jevQuant(jev: JevModel, budget: number | undefined): Promise<JevQuant | undefined> {
    for (const quant of jev.quants) if (await this.fileComplete(quant.file, quant.size)) return quant
    for (const quant of jev.quants) {
      if (await stat(join(this.home, 'models', `${quant.file}.part`)).then(s => s.isFile(), () => false)) return quant
    }
    return budget === undefined ? undefined : jev.quants.find(quant => jevMemory(quant.size) <= budget)
  }

  private async downloaded(candidate: Candidate): Promise<boolean> {
    if (candidate.appPath) return stat(candidate.appPath).then(s => s.isFile() && s.size === candidate.size, () => false)
    const sizes = await Promise.all(candidate.files.map(file => stat(join(this.home, 'models', file)).then(s => s.isFile() ? s.size : 0).catch(() => 0)))
    return sizes.every(size => size > 0) && sizes.reduce((sum, size) => sum + size, 0) === candidate.size
  }

  /** Grid's non-secret run records distinguish locally owned --serve processes
   * from external endpoints. Stop delegates identity checks and teardown to Grid. */
  private async owned(grid: string): Promise<Owned[]> {
    this.blockers.delete(grid)
    if (!validArg(grid)) return []
    const grids = rows(await this.json(['--remote', 'ls', '--json']))
    const gridId = str(grids.find(g => g.grid === grid)?.id)
    if (!gridId || basename(gridId) !== gridId) return []
    const folder = join(this.home, 'run', 'engines', gridId)
    const names = await readdir(folder).catch(() => [])
    const result: Owned[] = []
    for (const name of names.filter(n => n.endsWith('.json'))) {
      let record: Record<string, any>
      try { record = obj(JSON.parse(await readFile(join(folder, name), 'utf8'))) } catch { continue }
      const heartbeat = await stat(join(folder, name.replace(/\.json$/, '.heartbeat'))).catch(() => null)
      const live = heartbeat !== null && Date.now() - heartbeat.mtimeMs < 90_000
      const specs = rows(record.engines)
      if (specs.length || record.media) this.blockers.set(grid, 'Open Model Manager to add a model alongside those already running.')
      for (const spec of specs) {
        if (spec.endpoint_url || spec.api_kind || !Array.isArray(spec.models) || spec.models.length !== 1) continue
        const file = str(spec.models[0])
        if (!validArg(file) || !file.toLowerCase().endsWith('.gguf')) continue
        // Grid's `spec_aliases`: the engine's own names (ADR 0045) — or the record's flat list, which only ever
        // named a sole engine. With a Jev model joined beside it, the flat list was ignored and the engine was
        // looked for by its file name, which the grid does not list: a running model read as only downloaded.
        const named = 'advertise_as' in spec ? spec.advertise_as : specs.length === 1 ? record.advertise_as : undefined
        const advertised = Array.isArray(named) ? named.filter((v: unknown) => typeof v === 'string' && v.length > 0) : []
        const aliases: string[] = advertised.length ? advertised : [file]
        const pid = recordPid(record)
        // Grid's `builtin_launch`: the spec's own launch settings, or a record written before specs had them.
        const launch = spec.launch && typeof spec.launch === 'object' ? spec.launch : record
        result.push({ file: basename(file), selector: file, aliases, nodeId: str(record.node_id), name: str(record.meta_name), live,
          pidAlive: pid !== null && processExists(pid), siblings: specs.length + (record.media ? 1 : 0), slotted: (num(launch.parallel) ?? 0) > 0 })
        this.blockers.set(grid, `Stop ${cleanName(aliases[0])} first to start another local model.`)
      }
    }
    return result
  }

  /** The `--max-concurrency` to join [grid]'s node with, or undefined to leave its limit as it is. Grid's limit is
   *  the node's, shared by every engine on it: [NODE_CONCURRENCY], at one a decision waited for a chat model's whole
   *  reply. It is one number, the same for every join, because a join that changes it restarts the node, and a
   *  restart relaunches every engine Grid runs itself — starting a 0.8 GB Kev beside a running Qwen reloaded all
   *  25 GB of it. So a join that launches none of Grid's ([launches] false: an app's engine, a Jev model) leaves the
   *  limit alone wherever one of Grid's runs; a launch restarts the node anyway, and sets it. It is one while an engine
   *  of Grid's without its own slot count runs there: that one takes a slot per request, each its whole window. */
  private async gridConcurrency(grid: string, launches: boolean): Promise<number | undefined> {
    const engines = await this.owned(grid)
    if (!launches && engines.length) return undefined
    return engines.some(engine => !engine.slotted) ? 1 : NODE_CONCURRENCY
  }

  /** Keep models imported from an existing Grid setup after Stop removes its
   * run record. Only completed local files that this computer already served
   * become restartable; arbitrary downloaded GGUFs are not assumed compatible. */
  private async known(grid: string, owned: Owned[], apps: Candidate[] = []): Promise<Candidate[]> {
    const path = join(this.options.stateDir, `${key(grid)}.known.json`)
    let known = this.knownByGrid.get(grid)
    if (!known) {
      try {
        known = rows(JSON.parse(await readFile(path, 'utf8'))).filter(c =>
          c.id === `local:${c.file}` && basename(str(c.file)) === c.file && validArg(c.file) &&
          c.pull === '' && typeof c.name === 'string' && c.name.length < 256 && num(c.size) &&
          Array.isArray(c.files) && c.files.length === 1 && c.files[0] === c.file).map(({ context: _pinned, ...c }) => ({
            // A saved `context` is dropped, not carried: older receipts pinned 16K, and a model
            // restarted from one would come back too small for a coding agent. The engine sizes it.
            ...c,
            // Older receipts kept only the displayed alias. Preserve that name
            // when upgrading, and never forward malformed saved argv values.
            aliases: (Array.isArray(c.aliases) ? c.aliases : [c.name])
              .filter((alias: unknown): alias is string => typeof alias === 'string' && validArg(alias)),
          })) as Candidate[]
      } catch { known = [] }
      this.knownByGrid.set(grid, known)
    }
    let changed = false
    for (const instance of owned) {
      if ([...this.candidates, ...apps].some(c => c.file === instance.file) || known.some(c => c.file === instance.file)) continue
      const file = await stat(join(this.home, 'models', instance.file)).catch(() => null)
      if (!file?.isFile() || !file.size) continue
      known.push({ id: `local:${instance.file}`, name: cleanName(instance.aliases[0]),
        file: instance.file, files: [instance.file], pull: '', size: file.size, quant: '',
        aliases: instance.aliases.filter(validArg) })
      changed = true
    }
    if (changed) {
      await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
      const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify(known), { mode: 0o600 }); await rename(temp, path)
    }
    const existing = await Promise.all(known.map(async candidate =>
      await this.downloaded(candidate) && !await this.tooSmallToCode(candidate.file) ? candidate : null))
    return existing.filter((c): c is Candidate => c !== null)
  }

  /** The window each file was trained for, read once from its header (`grid ctx`). */
  private trained = new Map<string, number | null>()

  private async trainedWindow(file: string): Promise<number | null> {
    if (!this.trained.has(file)) {
      const window = await this.json(['ctx', file, '--json']).then(v => num(obj(v).context_length) ?? null, () => null)
      this.trained.set(file, window)
    }
    return this.trained.get(file) ?? null
  }

  /** Whether [file] can never give a coding agent [MIN_CODING_CONTEXT], however much memory there
   * is. Only a file the catalog did not size needs asking; unknown is not "too small". */
  private async tooSmallToCode(file: string): Promise<boolean> {
    const window = await this.trainedWindow(file)
    return window != null && window < MIN_CODING_CONTEXT
  }

  /** Whether the engine just started on [port] can actually compute, asked of the engine itself.
   *
   * ⚠️ Not through the relay. An engine whose GPU ran out of memory answers every request with
   * "Compute error." at once — but it reports that to the relay, and those reports timed out, so the
   * relay check waited its whole three minutes and said only "did not answer". Asked directly, the
   * failure is a second away and says what it is.
   *
   * `unknown` when there is nothing to ask (no engine listening on this machine, or no answer in
   * time): the relay check that follows is then the judge, as it always was. */
  private async probeEngine(port: number): Promise<'ok' | 'out-of-memory' | 'unknown'> {
    const base = `http://127.0.0.1:${port}`
    // `grid join` returns once the engine has loaded, so it is listening by now; 503 is a load still
    // finishing, and the only answer worth waiting on. Nothing listening, twice, is not an engine
    // this can reach; anything else is not a question this probe can answer.
    const deadline = Date.now() + 10 * 60_000
    for (let refused = 0; ;) {
      const status = await this.request(`${base}/health`, { signal: AbortSignal.timeout(5_000), redirect: 'error' }).then(r => r.status, () => 0)
      if (status === 200) break
      if (status === 0 ? ++refused >= 2 : status !== 503) return 'unknown'
      if (Date.now() > deadline) return 'unknown'
      await sleep(500)
    }
    try {
      const response = await this.request(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 8 }),
        // Long: the engine's one slot may be busy with Grid's own first probe of the new engine.
        signal: AbortSignal.timeout(5 * 60_000), redirect: 'error',
      })
      if (response.ok) return 'ok'
      return OUT_OF_MEMORY.test(await response.text().catch(() => '')) ? 'out-of-memory' : 'unknown'
    } catch { return 'unknown' }
  }

  /** The window the engine serving [model] on [grid] actually took, or undefined when Grid does not
   * report one. Read after a start because a window left to the engine is decided at load. */
  private async servedWindow(grid: string, model: string, nodeId: string): Promise<number | undefined> {
    const nodes = rows(await this.json(['--remote', 'engines', grid, '--json']).catch(() => []))
    const node = nodes.find(n => str(n.node_id || n.id) === nodeId) ?? (nodes.length === 1 ? nodes[0] : undefined)
    const capabilities = obj(node?.model_capabilities)
    const entry = Object.entries(capabilities).find(([name]) => modelKey(name) === modelKey(model))
    return num(obj(entry?.[1]).context_length)
  }

  private receiptPath(grid: string): string { return join(this.options.stateDir, `${key(grid)}.json`) }
  private async readReceipt(grid: string): Promise<void> {
    if (this.receiptScope === grid) return
    this.receiptScope = grid
    this.receipt = undefined
    try {
      const value = JSON.parse(await readFile(this.receiptPath(grid), 'utf8')) as Receipt
      if (value.spec === 1 && value.grid === grid) {
        this.receipt = value
        if (value.operation?.phase === 'running' && this.active?.operation.id !== value.operation.id) {
          value.operation.phase = 'failed'
          value.operation.error = 'Setup was interrupted. Start again to continue.'
        }
      }
    } catch { /* no prior operation */ }
  }
  private async save(grid: string, operation: ModelOperation): Promise<void> {
    const value: Receipt = { spec: 1, grid, operation: { ...operation, updatedAt: new Date().toISOString() } }
    this.receipt = value; this.receiptScope = grid; this.cached = undefined
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
    const file = this.receiptPath(grid), temp = `${file}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await rename(temp, file)
  }

  /**
   * Models other apps downloaded here, from the last scan: a scan walks their folders and asks every
   * engine its version, which a llama-server busy serving answered in 11s [run], so nothing waits on
   * one but the very first. Past 30s, or [force]d, a new scan starts and the list after it has it.
   */
  private async apps(force = false): Promise<AppModel[]> {
    if (!this.options.appModels) return []
    // A daemon just started answers from the scan it saved last time: a first scan while a llama-server
    // was busy kept the picker without these models, and held a Stop two minutes [run].
    if (!this.appsRead) this.appsRead = await this.savedApps()
    if (force || !this.appsRead || Date.now() - this.appsRead.at >= 30_000) { void this.scanApps() }
    return this.appsRead?.value ?? this.scanApps()
  }

  /** One scan at a time, and never one without an end: a scan that does not answer in [APP_SCAN_MS] is
   *  given up and the last answer kept, so the next read starts afresh rather than waiting on it forever. */
  private scanApps(): Promise<AppModel[]> {
    return this.appsPending ??= Promise.race([this.options.appModels!(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('scan timed out')), this.options.appScanMs ?? APP_SCAN_MS).unref())])
      .then(async value => {
        this.appsRead = { at: Date.now(), value }
        await this.saveApps(value).catch(() => {})
        return value
      }, () => this.appsRead?.value ?? [])
      .finally(() => { this.appsPending = undefined })
  }

  private get appsFile(): string { return join(this.options.stateDir, 'app-models.json') }

  /** The last scan, as saved: read as stale, so the next read scans again. */
  private async savedApps(): Promise<{ at: number; value: AppModel[] } | undefined> {
    try {
      const value = rows(JSON.parse(await readFile(this.appsFile, 'utf8'))).filter(a =>
        (str(a.id).startsWith('app:') || str(a.id).startsWith('jev:ollama:')) && str(a.name) && ['ollama', 'lm-studio', 'llama.cpp'].includes(a.app) &&
        ['ollama', 'lm-studio', 'llama.cpp', 'grid'].includes(a.engine) && str(a.ref)) as AppModel[]
      return { at: 0, value }
    } catch { return undefined }
  }

  private async saveApps(value: AppModel[]): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 })
    const temp = `${this.appsFile}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await rename(temp, this.appsFile)
  }

  /** An app's model that Grid's llama.cpp serves (its app is not installed here), as a candidate whose
   *  file is the link Start makes to it in Grid's models folder. */
  private appCandidates(apps: AppModel[]): Candidate[] {
    return apps.filter(app => app.engine === 'grid').map(app => {
      const file = `${app.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.gguf`
      return { id: app.id, name: app.name, pull: '', file, files: [file], size: app.sizeBytes, quant: app.quant ?? '',
        aliases: [app.name], appPath: app.ref }
    })
  }

  private get appRecordsFile(): string { return join(this.options.stateDir, 'app-engines.json') }

  async list(grid: string | null, force = false): Promise<LocalModelsSnapshot> {
    if (!grid) return { models: [], notice: 'Sign in to find models for this computer.', observedAt: new Date().toISOString(), busy: false }
    if (!force && this.cached?.grid === grid && Date.now() - this.cached.at < 2500) return this.cached.value
    if (this.listPending) {
      if (this.listGrid === grid) return this.listPending
      await this.listPending; return this.list(grid, force)
    }
    this.listGrid = grid
    this.listPending = this.readList(grid, force)
    try { return await this.listPending } finally { this.listPending = undefined }
  }
  private async readList(grid: string, force: boolean): Promise<LocalModelsSnapshot> {
    await Promise.all([this.loadCatalog(force), this.readReceipt(grid)])
    let owned: Owned[] = [], nodes: Record<string, any>[] = [], inventoryError: string | undefined, asleep = false
    try {
      let inventory: GridInventory
      [owned, inventory] = await Promise.all([this.owned(grid), this.options.inventory(grid, force)])
      // A grid that is down — its owner status says stopped or asleep (DOWN) — runs nothing: an answer,
      // not a gap, so Start stays enabled (and brings it back up). Asleep says so even to a member, in
      // the grid's own answer. Only a read that failed some other way is "could not be checked".
      if (inventory.state === 'unknown' && !DOWN.has(inventory.status ?? '')) throw new Error('unanswered')
      asleep = inventory.state === 'asleep' || inventory.status === 'asleep'
      nodes = inventory.state === 'awake' ? rows(inventory.nodes) : []
    } catch { inventoryError = 'Running models could not be checked. Try again.' }
    const operation = this.active?.grid === grid ? this.active.operation : this.receipt?.grid === grid ? this.receipt.operation : undefined
    const apps = await this.apps(force)
    const allRecords = (await readAppRecords(this.appRecordsFile)).filter(record => record.grid === grid)
    // A Jev engine is tiny and joins beside the rest: it neither blocks a chat model nor is blocked by one.
    const jevRecords = allRecords.filter(record => isJev(record.modelId))
    const records = allRecords.filter(record => !isJev(record.modelId))
    // An engine this daemon started is read from its record, whatever a later scan makes of the model: a
    // scan that missed the person's llama-server (busy serving, it answered `--version` late) once listed
    // a running engine as Grid's, and Stop then had nothing to stop.
    const recorded = (id: string) => records.some(record => record.modelId === id)
    const appServed = this.appCandidates(apps.filter(app => !recorded(app.id)))
    // One engine of this picker's at a time, as for Grid's own: an app's engine started here blocks the next.
    for (const record of records) this.blockers.set(grid, `Stop ${cleanName(record.name)} first to start another local model.`)
    const knownHere = (await this.known(grid, owned, appServed)).filter(k => !this.candidates.some(c => c.file === k.file))
    const choices = [...this.candidates, ...knownHere,
      ...appServed.filter(app => ![...this.candidates, ...knownHere].some(c => c.file === app.file))]
    const downloaded = await Promise.all(choices.map(candidate => this.downloaded(candidate)))
    // Different repositories can use the same filename for different weights.
    // Attribute the one local engine to the complete file that is actually here.
    // Keep a fallback so an engine can still be stopped if its file was removed.
    const owners = new Map(owned.map(instance => [instance.file,
      choices.find((candidate, index) => candidate.file === instance.file && downloaded[index])
        ?? choices.find(candidate => candidate.file === instance.file)]))
    const servingNode = (instance?: Owned): Record<string, any> | undefined => {
      const matches = instance?.live ? nodes.filter(n => n.online === true &&
        (str(n.node_id || n.id) ? str(n.node_id || n.id) === instance.nodeId :
          !!instance.name && str(n.name) === instance.name) &&
        instance.aliases.every(alias => (Array.isArray(n.models) ? n.models : []).some((m: unknown) =>
          modelKey(str(typeof m === 'string' ? m : obj(m).model)) === modelKey(alias)))) : []
      return matches.length === 1 ? matches[0] : undefined
    }
    // A parked engine: its grid sleeps, so the grid lists nothing, but the process that serves it is alive
    // here and rejoins the moment the grid wakes. Liveness is the record's pid — never the heartbeat
    // sidecar, which goes stale while a healthy provider is parked.
    const parked = (instance?: Owned): boolean => asleep && !!instance?.pidAlive
    const models = choices.map((candidate, index): LocalModel => {
      const instance = owned.find(o => owners.get(o.file) === candidate)
      const node = servingNode(instance)
      const running = !!node || parked(instance)
      const available = downloaded[index]
      const answered = obj(node?.answered)
      const perModel = rows(answered.by_model).find(a => instance?.aliases.some(alias => modelKey(alias) === modelKey(str(a.model))))
      const single = Array.isArray(node?.models) && node.models.length === 1
      return { id: candidate.id, name: candidate.name, state: running ? 'running' : available ? 'downloaded' : 'available',
        sizeBytes: candidate.size, quant: candidate.quant, recommended: index === 0,
        ...(candidate.context ? { contextWindow: candidate.context } : {}),
        ...(candidate.estTokS ? { estTokS: candidate.estTokS } : {}),
        ...(candidate.paramsB ? { paramsB: candidate.paramsB } : {}),
        canStart: !inventoryError && (!this.catalogError || !candidate.pull) && !instance, canStop: !inventoryError && !!instance,
        // Device memory is deliberately not presented as this model's memory.
        tokensPerSecond: single && running ? num(node?.throughput_tok_s) : undefined,
        requests: running ? num(perModel?.requests) : undefined,
        windowSeconds: running ? num(answered.window_seconds) : undefined,
        operation: operation?.modelId === candidate.id ? operation : undefined,
        ...(!node && parked(instance) ? { gridAsleep: true } : {}),
        // Grid serves it — its own download, or another app's file linked in because that app is not here.
        ...(running || available ? { app: GRID_LABEL } : {}) }
    })
    for (const instance of owned.filter(o => !choices.some(c => c.file === o.file))) {
      const serving = !!servingNode(instance)
      models.push({ id: `local:${instance.file}`, name: cleanName(instance.aliases[0]),
        state: serving || parked(instance) ? 'running' : 'available', canStart: false, canStop: !inventoryError,
        operation: operation?.modelId === `local:${instance.file}` ? operation : undefined,
        ...(!serving && parked(instance) ? { gridAsleep: true } : {}), app: GRID_LABEL })
    }
    // Models in their own apps, started there: running when that engine is up and the grid lists it (or
    // the grid sleeps — parked, as above). A record whose model has since gone keeps a row to stop it by.
    const listedHere = (alias: string) => nodes.some(n => n.online === true && (Array.isArray(n.models) ? n.models : [])
      .some((m: unknown) => modelKey(str(typeof m === 'string' ? m : obj(m).model)) === modelKey(alias)))
    const appRow = async (id: string, name: string, app: AppEngine, record: AppEngineRecord | undefined, extra: Partial<LocalModel>): Promise<LocalModel> => {
      const alive = record && this.options.appEngines ? await this.options.appEngines.alive(record) : false
      const listed = !!record && listedHere(record.alias)
      const running = alive && (listed || asleep)
      return { id, name, app: APP_LABEL[app], state: running ? 'running' : 'downloaded', ...extra,
        canStart: !inventoryError && !record, canStop: !inventoryError && !!record,
        operation: operation?.modelId === id ? operation : undefined, ...(running && !listed ? { gridAsleep: true } : {}) }
    }
    for (const app of apps.filter(a => a.kind !== 'decision' && (a.engine !== 'grid' || recorded(a.id)))) {
      models.push(await appRow(app.id, app.name, app.app, records.find(r => r.modelId === app.id),
        { sizeBytes: app.sizeBytes, ...(app.quant ? { quant: app.quant } : {}) }))
    }
    for (const record of records.filter(r => !apps.some(a => a.id === r.modelId))) {
      models.push({ ...await appRow(record.modelId, record.name, record.engine, record, {}), canStart: false })
    }
    // Jev models: Get downloads one, brings Grid's llama.cpp up to a build that serves it, and runs it on
    // the grid beside whatever else is there; it is listed `running` once the grid lists it. Offered only
    // where this daemon can start an engine of its own, which is how one runs.
    // Only those that can start here are offered: one this computer has no memory for is listed only once it
    // is here — running, downloaded, or part way.
    const jevBudget = modelBudget(this.device)
    // An engine of ours the grid does not list is started again: the Grid app's `grid leave` took Kev off its grid
    // while its llama-server ran on, and the row, neither serving nor startable, said only "Downloaded" [run].
    const restartable = (row: LocalModel, record?: AppEngineRecord): Partial<LocalModel> =>
      record && row.state !== 'running' && !inventoryError ? { canStart: true } : {}
    for (const jev of this.options.appEngines ? JEV_MODELS : []) {
      const record = jevRecords.find(r => r.modelId === jev.id)
      const quant = await this.jevQuant(jev, jevBudget)
      if (!quant && !record && operation?.modelId !== jev.id) continue
      const shown = quant ?? jev.quants[0]!
      const have = await this.fileComplete(shown.file, shown.size)
      const row = await appRow(jev.id, jev.name, 'llama.cpp', record, { sizeBytes: shown.size, quant: shown.quant, kind: 'decision' })
      models.push({ ...row, app: GRID_LABEL, state: row.state === 'running' ? 'running' : have ? 'downloaded' : 'available', ...restartable(row, record) })
    }
    // Decision models another app downloaded (Ollama's tev1): listed whatever their size, since they are here —
    // Start is what says when there is no memory for one. A record whose model has since gone keeps a row to stop it by.
    for (const app of this.options.appEngines ? apps.filter(a => a.kind === 'decision') : []) {
      const record = jevRecords.find(r => r.modelId === app.id)
      const row = await appRow(app.id, app.name, app.app, record, { sizeBytes: app.sizeBytes, ...(app.quant ? { quant: app.quant } : {}), kind: 'decision' })
      models.push({ ...row, ...restartable(row, record) })
    }
    for (const record of jevRecords.filter(r => !JEV_MODELS.some(j => j.id === r.modelId) && !apps.some(a => a.id === r.modelId))) {
      models.push({ ...await appRow(record.modelId, record.name, record.engine, record, { kind: 'decision' }), canStart: false })
    }
    const freeDiskBytes = await statfs(join(this.home, 'models')).catch(() => statfs(this.home))
      .then(disk => disk.bavail * disk.bsize, () => undefined)
    const value: LocalModelsSnapshot = { models: withoutCopiesOfOwned(models), memoryBytes: num(obj(this.device.memory).total_gb) === undefined ? undefined : this.device.memory.total_gb * GiB,
      hardware: str(obj(this.device.machine).model || obj(this.device.cpu).brand), notice: inventoryError || this.catalogError,
      observedAt: new Date().toISOString(), busy: !!this.active, supportsDownload: true,
      ...(freeDiskBytes === undefined ? {} : { freeDiskBytes }) }
    this.cached = { grid, at: Date.now(), value }
    this.runningAtLastRead.set(grid, new Set(models.filter(model => model.state === 'running').map(model => model.id)))
    return value
  }

  /** What `grid info` says of [grid]: `running`, `stopped`, `asleep`. */
  private async gridStatus(grid: string): Promise<string> {
    return str(obj(await this.json(['--remote', 'info', grid, '--json'])).status)
  }

  /** A repeated click or lost RPC acknowledgement joins the same operation.
   * A different model waits: starts/stops must not race on the machine's budget. */
  async act(grid: string | null, modelId: unknown, action: 'download' | 'start' | 'stop'): Promise<{ operation?: ModelOperation; error?: string }> {
    if (!grid || typeof modelId !== 'string') return { error: 'The model is unavailable. Refresh and try again.' }
    if (this.active) return this.active.grid === grid && this.active.operation.modelId === modelId && this.active.operation.action === action
      ? { operation: this.active.operation } : { error: 'Wait for the current model operation to finish.' }
    const operation: ModelOperation = { id: randomUUID(), modelId, action, stage: action === 'stop' ? 'stopping' : 'checking', phase: 'running', updatedAt: new Date().toISOString() }
    // Reserve before any await; independent RPCs may arrive on separate connections.
    const active = { grid, operation, done: Promise.resolve() }
    this.active = active
    try { await this.save(grid, operation) } catch { this.active = undefined; return { error: 'Setup could not be saved. Try again.' } }
    active.done = this.perform(grid, operation).catch(async error => {
      operation.phase = 'failed'
      operation.error = error instanceof ModelError ? error.message : 'The model could not finish. Start again to retry.'
      await this.save(grid, operation).catch(() => {})
    }).finally(() => { this.active = undefined; this.cached = undefined; this.options.onChanged?.() })
    return { operation }
  }

  async settled(): Promise<void> {
    // Found by QA on a quiet machine: a background app scan was still saving after fixture teardown began.
    await this.active?.done
    await this.listPending
    await this.appsPending
  }

  private async perform(grid: string, operation: ModelOperation): Promise<void> {
    const change = async (stage: ModelOperation['stage']) => {
      operation.stage = stage; delete operation.progress; await this.save(grid, operation)
    }
    const must = async (args: string[], message: string, output?: (chunk: string) => void) => {
      if (!(await this.run(args, output, 30 * 60_000)).ok) throw new ModelError(message)
    }
    if (isJev(operation.modelId)) return this.performJev(grid, operation, change, must)
    if (operation.action !== 'stop') await this.loadCatalog()
    if (operation.action === 'start') {
      // Leaving the last engine removes Grid's local registration. Restore the
      // account's existing grids before resolving ownership or joining again.
      await must(['--remote', 'sync'], 'Models could not be checked. Try again.')
    }
    // The last scan has every model a person could have clicked; a model it lacks waits for a new one.
    let apps = operation.modelId.startsWith('app:') ? await this.apps() : []
    if (operation.modelId.startsWith('app:') && !apps.some(a => a.id === operation.modelId)) apps = await this.scanApps()
    const app = apps.find(a => a.id === operation.modelId)
    const started = (await readAppRecords(this.appRecordsFile)).some(r => r.modelId === operation.modelId && r.grid === grid)
    if (operation.modelId.startsWith('app:') && (started || app?.engine !== 'grid')) {
      return this.performApp(grid, operation, app?.engine === 'grid' ? undefined : app)
    }
    const owned = await this.owned(grid)
    const appServed = this.appCandidates(apps)
    const candidate = [...this.candidates, ...await this.known(grid, owned, appServed), ...appServed].find(c => c.id === operation.modelId)
    if (candidate?.appPath && operation.action === 'start') await this.linkApp(candidate)
    const instance = owned.find(o => candidate ? o.file === candidate.file : operation.modelId === `local:${o.file}`)
    if (operation.action === 'stop') {
      if (instance) {
        if (instance.siblings > 1) throw new ModelError('Open Model Manager to stop this model. Other models share its engine.')
        await must(['--remote', 'leave', grid, '--engine', instance.selector], 'The model could not stop. Try again.')
        if ((await this.owned(grid)).some(o => o.file === instance.file)) throw new ModelError('The model is still stopping. Check again in a moment.')
      }
    } else {
      if (!candidate || (this.catalogError && candidate.pull)) throw new ModelError('This model could not be checked. Refresh and try again.')
      if (!instance) {
        // The pinned Grid runtime respawns its union when adding --serve.
        // Do not interrupt existing engines as a side effect of a simple Start.
        if (operation.action === 'start') {
          if (this.blockers.has(grid)) throw new ModelError(this.blockers.get(grid)!)
          // Recheck the machine immediately before downloading or allocating.
          const currentDevice = obj(await this.json(['device-info', '--json']))
          const budget = num(currentDevice.usable_bytes) ?? 0
          if (candidate.pull) {
            const current = compatibleModels(await this.catalog({ ...currentDevice, usable_bytes: Math.max(0, budget) })).find(c => c.id === candidate.id)
            if (!current || current.size < candidate.size) throw new ModelError('Stop a running model to make room, then try again.')
            candidate.context = Math.min(candidate.context!, current.context!)
          } else if (candidate.size * 1.25 + 2 * GiB > budget) {
            throw new ModelError('Stop a running model to make room, then try again.')
          }
        }
        if (!await this.downloaded(candidate)) {
          if (!candidate.pull) throw new ModelError('The downloaded file is no longer available. Open Model Manager to restore it.')
          await mkdir(join(this.home, 'models'), { recursive: true })
          const disk = await statfs(join(this.home, 'models'))
          if (disk.bavail * disk.bsize < candidate.size + GiB) throw new ModelError('Free up disk space, then start again.')
          await change('downloading')
          let last = 0, progressWrites = Promise.resolve()
          await must(['pull', candidate.pull], 'The download stopped. Start again to resume.', chunk => {
            const matches = [...chunk.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
            const percent = matches.length ? Number(matches.at(-1)![1]) : NaN
            if (Number.isFinite(percent) && percent >= 0 && percent <= 100 && Date.now() - last > 500) {
              last = Date.now(); operation.progress = percent / 100
              progressWrites = progressWrites.then(() => this.save(grid, operation)).catch(() => {})
            }
          })
          await progressWrites
          if (!await this.downloaded(candidate)) throw new ModelError('The download is incomplete. Start again to resume.')
        }
        // A download only stores the weights. It must never start/wake a grid,
        // install an engine, allocate model memory, or send a test message.
        if (operation.action === 'download') {
          operation.phase = 'done'
          delete operation.progress
          await this.save(grid, operation)
          return
        }
        await change('starting')
        // A grid that is down refuses a join outright ("The model could not start"), and `sync`
        // above restores its registration, not its process. Bring it up the way its own refusal
        // says to. A grid already running is left alone: `start` is only for one that is not. An
        // unreadable status blocks nothing — it is the join's refusal, not this read, that says a
        // grid cannot take the model, and a Grid too old to answer `info --json` joined fine before.
        if (DOWN.has(await this.gridStatus(grid).catch(() => ''))) await must(['--remote', 'start', grid], 'Your grid could not start. Try again.')
        const override = this.processEnv.LLAMA_SERVER
        const installed = override ? binaryOnPath(override, this.processEnv)
          : binaryOnPath(join(this.home, 'bin', 'llama-server'), this.processEnv) || binaryOnPath('llama-server', this.processEnv)
        if (!installed) {
          if (override) throw new ModelError('The local engine needs attention. Open Model Manager.')
          await must(['engine', 'install', 'llama.cpp'], 'The model engine could not start. Try again.')
        }
        // ⚠️ ALWAYS pinned, and stepped down when it does not run. Left to the engine, the window
        // was the model's whole trained 256K on a 64 GB Mac whose GPU could hold 128K: it loaded, ran
        // out of memory on its first request, and failed every request after. The catalog's fit is
        // optimistic the same way. So the most the model is sized for is tried first, and each size
        // that cannot compute is taken back down and halved — to the 64K floor, never below it.
        const first = candidate.context ?? await this.trainedWindow(candidate.file) ?? UNREAD_CONTEXT
        const named = this.options.machineName?.()?.trim()
        const machineName = named && validArg(named) ? named : undefined
        let started = false, outOfMemory = false
        for (const ctx of contextLadder(first)) {
          const port = await freePort()
          const joined = await this.run(['--remote', 'join', grid, '--serve', candidate.file,
            ...(machineName ? ['--name', machineName] : []),
            // One slot, its whole window: a harness's model is one conversation, whatever the node's concurrency.
            ...concurrencyArgs(await this.gridConcurrency(grid, true)), '--parallel', '1',
            '--ctx-size', String(ctx), '--endpoint-port', String(port),
            '--reasoning-budget', '0',
            ...(candidate.aliases ?? []).flatMap(alias => ['--advertise-as', alias])], undefined, 30 * 60_000)
          // A join that fails at a size is also stepped down from: an allocation that fails at load
          // takes the engine down before Grid can register it.
          const probe = joined.ok ? await this.probeEngine(port) : 'failed'
          if (probe === 'ok' || probe === 'unknown') { started = true; break }
          outOfMemory ||= probe === 'out-of-memory'
          // Down before the next size. The last engine leaving drops Grid's local registration, which
          // the next join needs back — the same restore a start begins with.
          await this.run(['--remote', 'leave', grid, '--engine', candidate.file], undefined, 30 * 60_000)
          await this.run(['--remote', 'sync'], undefined, 30 * 60_000)
          if (DOWN.has(await this.gridStatus(grid).catch(() => ''))) await this.run(['--remote', 'start', grid], undefined, 30 * 60_000)
        }
        if (!started) {
          throw new ModelError(outOfMemory
            ? `This computer does not have the memory to run ${candidate.name} with a 64K context. Close some apps, or choose a smaller model.`
            : 'The model could not start. Try again.')
        }
      } else if (operation.action === 'download' || this.runningAtLastRead.get(grid)?.has(operation.modelId)) {
        // Already serving when last read, and nothing was started: nothing to check. The reply test is an
        // inference THROUGH the grid (so is the served-window read) — on a sleeping grid it would start it,
        // and the platform then holds it up for hours, for a stray click (grid-reads-without-waking 03).
        operation.phase = 'done'
        await this.save(grid, operation)
        return
      }
      await change('verifying')
      const model = instance?.aliases[0] || candidate.aliases?.[0] || candidate.file
      await this.verify(grid, model)
      // The floor, checked against what was actually served rather than what was asked: a window
      // left to the engine is decided by the memory free at load, and can come in under it. A model
      // that answers but cannot hold a coding agent's prompt is worse than one that did not start.
      const serving = instance ?? (await this.owned(grid)).find(o => o.file === candidate.file)
      const window = serving ? await this.servedWindow(grid, model, serving.nodeId) : undefined
      if (serving && window !== undefined && window < MIN_CODING_CONTEXT) {
        await this.run(['--remote', 'leave', grid, '--engine', serving.selector], undefined, 30 * 60_000)
        throw new ModelError(`${candidate.name} could only get a ${Math.floor(window / 1024)}K context here. Coding agents need at least 64K. Close some apps, or choose a smaller model.`)
      }
    }
    operation.phase = 'done'
    await this.save(grid, operation)
  }

  /** Grid's models folder gets a link to an app's file, never a copy. A different file under the name is
   *  never served in its place. */
  private async linkApp(candidate: Candidate): Promise<void> {
    const link = join(this.home, 'models', candidate.file)
    const there = await lstat(link).catch(() => null)
    if (there) {
      if (there.isSymbolicLink() && await readlink(link).catch(() => '') === candidate.appPath) return
      throw new ModelError('A different file has this name in Grid\'s models folder. Open Model Manager to start this model.')
    }
    await mkdir(join(this.home, 'models'), { recursive: true })
    await symlink(candidate.appPath!, link)
  }

  /** Start or stop a model in its own app ([AppModel]): the app's engine, joined to [grid] at its own
   *  address, answered through the grid, and held to the 64K floor by what the engine says it loaded. */
  private async performApp(grid: string, operation: ModelOperation, app: AppModel | undefined): Promise<void> {
    const ops = this.options.appEngines
    const records = await readAppRecords(this.appRecordsFile)
    const record = records.find(r => r.modelId === operation.modelId && r.grid === grid)
    const without = (gone: AppEngineRecord) => writeAppRecords(this.appRecordsFile, records.filter(r => r !== gone))
    const takeDown = async (started: AppEngineRecord) => {
      await this.run(['--remote', 'leave', grid, '--engine', started.alias], undefined, 5 * 60_000)
      await ops?.stop(started)
    }
    if (operation.action === 'stop') {
      if (record) { await takeDown(record); await without(record) }
    } else if (operation.action === 'start' && !record) {
      if (!app || !ops) throw new ModelError('This model could not be checked. Refresh and try again.')
      // Asked now, not taken from the last list: Use stops the model running and starts this one at
      // once, and the list read before that stop still named it.
      await this.owned(grid)
      const running = records.find(r => r.grid === grid && r.modelId !== app.id && !isJev(r.modelId))
      if (running) throw new ModelError(`Stop ${cleanName(running.name)} first to start another local model.`)
      if (this.blockers.has(grid)) throw new ModelError(this.blockers.get(grid)!)
      const device = obj(await this.json(['device-info', '--json']))
      const ctx = appContext(app, num(device.usable_bytes))
      if (!ctx) throw new ModelError(`This computer does not have the memory to run ${app.name} with a 64K context. Close some apps, or choose a smaller model.`)
      operation.stage = 'starting'; await this.save(grid, operation)
      if (DOWN.has(await this.gridStatus(grid).catch(() => ''))) {
        if (!(await this.run(['--remote', 'start', grid], undefined, 30 * 60_000)).ok) throw new ModelError('Your grid could not start. Try again.')
      }
      let started: AppEngineRecord
      try {
        started = { spec: 1, modelId: app.id, grid, name: app.name, ...await ops.start(app, ctx, join(this.options.stateDir, 'logs')) }
      } catch (error) {
        throw new ModelError(error instanceof AppStartError ? error.message : 'The model could not start. Try again.')
      }
      await writeAppRecords(this.appRecordsFile, [...records.filter(r => !(r.modelId === app.id && r.grid === grid)), started])
      const failed = async (message: string): Promise<never> => {
        await takeDown(started)
        await writeAppRecords(this.appRecordsFile, (await readAppRecords(this.appRecordsFile)).filter(r => !(r.modelId === app.id && r.grid === grid)))
        throw new ModelError(message)
      }
      const named = this.options.machineName?.()?.trim()
      const joined = await this.run(['--remote', 'join', grid, '--at', `http://127.0.0.1:${started.port}/v1`, '-m', started.served,
        '--advertise-as', started.alias, ...concurrencyArgs(await this.gridConcurrency(grid, false)),
          ...(named && validArg(named) ? ['--name', named] : [])], undefined, 10 * 60_000)
      if (!joined.ok) await failed('The model could not join your grid. Try again.')
      operation.stage = 'verifying'; await this.save(grid, operation)
      try { await this.verify(grid, started.alias) } catch (error) {
        await failed(error instanceof ModelError ? error.message : 'The model did not answer. Try again.')
      }
      const window = await ops.loadedContext(started)
      if (window !== undefined && window < MIN_CODING_CONTEXT) {
        await failed(`${app.name} could only get a ${Math.floor(window / 1024)}K context in ${APP_LABEL[app.engine as AppEngine]}. Coding agents need at least 64K. Close some apps, or choose a smaller model.`)
      }
    }
    operation.phase = 'done'
    await this.save(grid, operation)
  }

  /**
   * A decision model's Get, Start and Stop. For a Jev model Get is the whole of it: the weights, an engine that
   * can serve them, and the model on the grid — so a person never meets "too old" for an engine they did not
   * choose. Another app's decision model (Ollama's tev1) is here already, so Start is all there is to it.
   *
   * ⚠️ Grid's own llama.cpp is updated in place (`grid engine install llama.cpp`) when it is older than
   * [MIN_JEV_BUILD], exactly as a missing one is installed for a chat model: nothing else upgrades the engine
   * a machine already has when Grid's pin moves. The model runs in that engine on its own loopback port and
   * joins `--at`, so the grid adds it beside the models already there without restarting them.
   */
  private async performJev(grid: string, operation: ModelOperation,
    change: (stage: ModelOperation['stage']) => Promise<void>,
    must: (args: string[], message: string, output?: (chunk: string) => void) => Promise<void>): Promise<void> {
    if (!this.options.appEngines) throw new ModelError('This model could not be checked. Refresh and try again.')
    let record = (await readAppRecords(this.appRecordsFile)).find(r => r.modelId === operation.modelId && r.grid === grid)
    // Start on one the grid does not serve takes its engine down first, and starts it again: its process may
    // have gone with it, and a fresh start is the one path that checks every step.
    if (record && operation.action === 'start' && !await this.decisionServing(grid, record)) {
      await this.stopDecision(grid, record)
      record = undefined
    }
    if (operation.action === 'stop') {
      if (record) await this.stopDecision(grid, record)
    } else if (!record) {
      const jev = JEV_MODELS.find(m => m.id === operation.modelId)
      const model = jev ? await this.getJev(grid, jev, operation, change, must) : await this.appDecision(operation.modelId)
      await this.startIfAsked(grid, model, operation, change, must)
    }
    operation.phase = 'done'
    delete operation.progress
    await this.save(grid, operation)
  }

  /** [jev]'s weights, downloaded when they are not here; for a start, the model as Grid's llama.cpp runs it. */
  /** Starts [model] when the operation is a Start. Its own function: in line after the awaits above, which throw
   *  for a model this computer cannot run, v8 counted the branch as taken -33 times and the coverage gate read it
   *  as never taken. */
  private async startIfAsked(grid: string, model: AppModel | undefined, operation: ModelOperation,
    change: (stage: ModelOperation['stage']) => Promise<void>,
    must: (args: string[], message: string, output?: (chunk: string) => void) => Promise<void>): Promise<void> {
    if (model && operation.action === 'start') await this.startDecision(grid, model, change, must)
  }

  private async getJev(grid: string, jev: JevModel, operation: ModelOperation,
    change: (stage: ModelOperation['stage']) => Promise<void>,
    must: (args: string[], message: string, output?: (chunk: string) => void) => Promise<void>): Promise<AppModel | undefined> {
    const quant = await this.jevQuant(jev, modelBudget(await this.readDevice()))
    if (!quant) throw new ModelError(`This computer does not have the memory to run ${jev.name}. Close some apps, or choose a smaller model.`)
    if (!await this.fileComplete(quant.file, quant.size)) {
      await mkdir(join(this.home, 'models'), { recursive: true })
      const disk = await statfs(join(this.home, 'models'))
      if (disk.bavail * disk.bsize < quant.size + GiB) throw new ModelError('Free up disk space, then start again.')
      await change('downloading')
      let last = 0, progressWrites = Promise.resolve()
      await must(['pull', `${jev.repo}:${quant.file}`], 'The download stopped. Start again to resume.', chunk => {
        const matches = [...chunk.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
        const percent = matches.length ? Number(matches.at(-1)![1]) : NaN
        if (Number.isFinite(percent) && percent >= 0 && percent <= 100 && Date.now() - last > 500) {
          last = Date.now(); operation.progress = percent / 100
          progressWrites = progressWrites.then(() => this.save(grid, operation)).catch(() => {})
        }
      })
      await progressWrites
      if (!await this.fileComplete(quant.file, quant.size)) throw new ModelError('The download is incomplete. Start again to resume.')
    }
    if (operation.action !== 'start') return undefined
    return { id: jev.id, name: jev.name, app: 'llama.cpp', engine: 'llama.cpp', ref: join(this.home, 'models', quant.file),
      binary: await this.jevEngine(jev, change, must), sizeBytes: quant.size }
  }

  /** Another app's decision model, from the last scan — or a new one, when the model clicked is not in it — once
   *  its app is new enough and this computer has the memory for it. */
  private async appDecision(modelId: string): Promise<AppModel> {
    let apps = await this.apps()
    if (!apps.some(a => a.id === modelId)) apps = await this.scanApps()
    const app = apps.find(a => a.id === modelId && a.kind === 'decision')
    if (!app) throw new ModelError('This model could not be checked. Refresh and try again.')
    const label = APP_LABEL[app.app]
    if (app.needs) throw new ModelError(`${app.name} needs ${label} ${app.needs} or newer. Update ${label}, then start again.`)
    const budget = modelBudget(await this.readDevice())
    if (budget !== undefined && jevMemory(app.sizeBytes) > budget) {
      throw new ModelError(`This computer does not have the memory to run ${app.name}. Close some apps, or choose a smaller model.`)
    }
    return app
  }

  /** Runs decision [model] on its own loopback port with [JEV_SLOTS] slots and joins it to [grid] `--at`, beside
   *  whatever runs there; up once a decision through the grid is answered, and taken down when it is not. */
  private async startDecision(grid: string, model: AppModel,
    change: (stage: ModelOperation['stage']) => Promise<void>,
    must: (args: string[], message: string) => Promise<void>): Promise<void> {
    await change('starting')
    if (DOWN.has(await this.gridStatus(grid).catch(() => ''))) await must(['--remote', 'start', grid], 'Your grid could not start. Try again.')
    let started: AppEngineRecord
    try {
      started = { spec: 1, modelId: model.id, grid, name: model.name,
        ...await this.options.appEngines!.start(model, JEV_CONTEXT, join(this.options.stateDir, 'logs'), JEV_SLOTS) }
    } catch (error) {
      throw new ModelError(error instanceof AppStartError ? error.message : 'The model could not start. Try again.')
    }
    await writeAppRecords(this.appRecordsFile, [...(await readAppRecords(this.appRecordsFile)).filter(r => !(r.modelId === model.id && r.grid === grid)), started])
    const named = this.options.machineName?.()?.trim()
    const joined = await this.run(['--remote', 'join', grid, '--at', `http://127.0.0.1:${started.port}/v1`, '-m', started.served,
      '--advertise-as', started.alias, ...concurrencyArgs(await this.gridConcurrency(grid, false)),
      ...(named && validArg(named) ? ['--name', named] : [])], undefined, 10 * 60_000)
    if (!joined.ok) { await this.stopDecision(grid, started); throw new ModelError('The model could not join your grid. Try again.') }
    await change('verifying')
    try { await this.verifyDecision(grid, started.alias) } catch (error) {
      await this.stopDecision(grid, started)
      throw error instanceof ModelError ? error : new ModelError('The model did not answer. Try again.')
    }
  }

  /** Whether [record]'s engine is up and [grid] lists it — or the grid sleeps, which lists nothing, and it is parked. */
  private async decisionServing(grid: string, record: AppEngineRecord): Promise<boolean> {
    if (!await this.options.appEngines!.alive(record)) return false
    const inventory = await this.options.inventory(grid, true).catch(() => null)
    // Unread is not "not served": an engine that may be serving is never taken down on a guess.
    if (!inventory || (inventory.state === 'unknown' && !DOWN.has(inventory.status ?? ''))) return true
    if (inventory.state === 'asleep' || inventory.status === 'asleep') return true
    return rows(inventory.nodes).some(n => n.online === true && (Array.isArray(n.models) ? n.models : [])
      .some((m: unknown) => modelKey(str(typeof m === 'string' ? m : obj(m).model)) === modelKey(record.alias)))
  }

  /** A decision engine off [grid], stopped, and its record gone. */
  private async stopDecision(grid: string, started: AppEngineRecord): Promise<void> {
    await this.run(['--remote', 'leave', grid, '--engine', started.alias], undefined, 5 * 60_000)
    await this.options.appEngines?.stop(started)
    await writeAppRecords(this.appRecordsFile, (await readAppRecords(this.appRecordsFile)).filter(r => !(r.modelId === started.modelId && r.grid === grid)))
  }

  /** Grid's llama-server, brought up to a build that runs [jev] first when it is older (or missing). */
  private async jevEngine(jev: JevModel, change: (stage: ModelOperation['stage']) => Promise<void>,
    must: (args: string[], message: string) => Promise<void>): Promise<string> {
    const needed = Math.max(MIN_JEV_BUILD, jev.minBuild ?? 0)
    const override = this.processEnv.LLAMA_SERVER
    if (override) {
      const build = await llamaBuild(override, this.processEnv)
      if (build !== undefined && build < needed) throw new ModelError(`LLAMA_SERVER is llama.cpp build ${build}; ${jev.name} needs build ${needed} or newer.`)
      return override
    }
    const managed = join(this.home, 'bin', 'llama-server')
    const build = binaryOnPath(managed, this.processEnv) ? await llamaBuild(managed, this.processEnv) : undefined
    if (build !== undefined && build >= needed) return managed
    await change('updating')
    await must(['engine', 'install', 'llama.cpp'], 'The model engine could not be updated. Try again.')
    const updated = await llamaBuild(managed, this.processEnv)
    if (updated === undefined || updated < needed) {
      throw new ModelError(`Grid's model engine is still too old for ${jev.name} (build ${updated ?? 'unknown'}; it needs ${needed} or newer). Update Grid, then try again.`)
    }
    return managed
  }

  /** One decision through the grid, as a caller would ask: the model is up when it answers one. */
  private async verifyDecision(grid: string, model: string): Promise<void> {
    const info = await this.run(['--remote', 'info', grid, '--env'])
    const { baseUrl, apiKey } = readEnvExports(info.stdout)
    if (!info.ok || !baseUrl || !apiKey) throw new ModelError('The model is starting, but could not be checked. Try again shortly.')
    const deadline = Date.now() + 180_000
    do {
      try {
        const response = await this.request(`${baseUrl.replace(/\/$/, '')}/systemone`, {
          method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, state: 'I was charged twice. Please refund the duplicate.',
            questions: { refund: { type: 'noul', instructions: 'Is a refund requested?' } } }),
          signal: AbortSignal.timeout(30_000), redirect: 'error',
        })
        const answer = obj(obj(response.ok ? await response.json() : {}).answers).refund
        if (typeof obj(answer).noul === 'number') return
      } catch { /* registration takes time; status remains verifying */ }
      await new Promise(resolve => setTimeout(resolve, 1500))
    } while (Date.now() < deadline)
    throw new ModelError('The model did not answer. Stop it, then start again.')
  }

  private async verify(grid: string, model: string): Promise<void> {
    const info = await this.run(['--remote', 'info', grid, '--env'])
    const { baseUrl, apiKey } = readEnvExports(info.stdout)
    if (!info.ok || !baseUrl || !apiKey) throw new ModelError('The model is starting, but could not be checked. Try again shortly.')
    const deadline = Date.now() + 180_000
    do {
      try {
        const response = await this.request(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 8 }),
          signal: AbortSignal.timeout(30_000), redirect: 'error',
        })
        const body = response.ok ? obj(await response.json()) : {}
        if (/^\s*ok[.!]?\s*$/i.test(str(obj(rows(body.choices)[0]?.message).content))) return
      } catch { /* registration and first warmup take time; status remains verifying */ }
      await new Promise(resolve => setTimeout(resolve, 1500))
    } while (Date.now() < deadline)
    throw new ModelError('The model did not answer. Stop it, then start again.')
  }
}
class ModelError extends Error {}

/** More names than any one engine advertises: a record past it is cut, never trusted to be small. */
const MAX_RECORD_IDS = 64

/** A run record's pid while a process holds it; null while a join is mid-spawn (`grid join` writes 0). */
function recordPid(record: Record<string, any>): number | null {
  return Number.isSafeInteger(record.pid) && record.pid > 0 ? record.pid : null
}

/**
 * This computer's own run records for one grid, as `servedHere` reads them (`gridPicture.ts`): the node
 * name each registers under, what it advertises, and whether a process still holds it.
 *
 * ⚠️ The keys are the ones `grid join` writes (autonomous-grid `remote_provider._build_record`), and that
 * repository's `tests/test_grid_reads_lockstep.py` pins every `record.<key>` read in THIS file against
 * them — which is why this lives here rather than in a module of its own. A key `grid join` stopped
 * writing is a model this computer silently stops recognising as its own: stale, never a wrong hide.
 */
export async function readRunRecords(home: string, gridId: string): Promise<LocalRecord[]> {
  if (!gridId || basename(gridId) !== gridId) return []
  const folder = join(home, 'run', 'engines', gridId)
  const names = await readdir(folder).catch(() => [])
  const result: LocalRecord[] = []
  for (const name of names.filter(n => n.endsWith('.json'))) {
    let record: Record<string, any>
    try { record = obj(JSON.parse(await readFile(join(folder, name), 'utf8'))) } catch { continue }
    const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : []
    // What the grid lists it as: the alias it advertises when it has one, else its model under the
    // master's display rule (a trailing .gguf removed, case kept).
    const advertised = strings(record.advertise_as)
    const ids = (advertised.length ? advertised : strings(record.models).map(displayModelName)).slice(0, MAX_RECORD_IDS)
    const pid = recordPid(record)
    result.push({ name: str(record.meta_name), ids, pid, alive: pid !== null && processExists(pid), advertised: advertised.length > 0 })
  }
  return result
}
