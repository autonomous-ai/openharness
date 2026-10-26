/** The Models popover's local lifecycle. Grid remains the hardware, catalog,
 * download and process authority. A click is a durable daemon operation, never a chat task. */
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
import type { GpuProcess } from './gpuProcesses.js'
import { downloadedBytes, removeDownload, unfinishedDownload } from './modelFiles.js'
import { APP_LABEL, AppStartError, GRID_LABEL, appContext, readAppRecords, writeAppRecords, type AppEngine, type AppEngineOps, type AppEngineRecord, type AppModel } from './appModels.js'
import { osToken, type OsToken } from './osToken.js'

// Its own module, so the API launches the core keeps need not load this one (codingContext.ts).
export { MIN_CODING_CONTEXT }

const GiB = 1024 ** 3
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const rows = (v: unknown): Record<string, any>[] => Array.isArray(v) ? v.map(obj) : []
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
const key = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 24)

/** The models a grid's known-models file names, each checked: a malformed row is left out, never forwarded as argv. */
async function readKnown(path: string): Promise<Candidate[]> {
  try {
    return rows(JSON.parse(await readFile(path, 'utf8'))).filter(c =>
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
  } catch { return [] }
}
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

/** Requests a node of this computer's takes at once, through Grid. A harness's model is one conversation in one
 *  slot, so a second request waits in the grid's queue rather than in the engine's. It is Grid's own default for a
 *  node that serves a model of its own, and every join passes the same number: a join that changed it would
 *  restart the node, which reloads every engine Grid runs there. */
export const NODE_CONCURRENCY = 1

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
  /** The names the grid lists it under while its engine runs here — what a harness on it names as its
   *  model. A catalog model is served under its file (`Qwen3.8-27B-UD-Q4_K_M`), not its name
   *  (`Qwen3.8-27B`): matched by name alone, the apps listed it twice, the second time as the grid's,
   *  and could not move a harness onto it from its own row. */
  servedAs?: string[]
  /** Every grid this computer serves it on, with what this computer's engine answered there over the
   *  grid's window (grid's `answered.by_model`, the figures `grid stats` reads). A grid that sleeps, or
   *  whose node is not in its listing yet, is named with no figures. Absent: served on no grid. */
  servedOn?: ServedOn[]
}
/** [servedAs]: the names that grid lists it under — what a harness moves onto it there by, as
 *  [LocalModel.servedAs] is on the own grid. [tokensOut]: what the engine wrote; [tokensIn]: what was sent
 *  to it; [tokensCached]: the part of [tokensIn] its prompt cache served (grid's `read_answered` figures). */
export interface ServedOn { grid: string; servedAs: string[]; requests?: number; tokensOut?: number; tokensIn?: number; tokensCached?: number; windowSeconds?: number }
export interface ModelOperation {
  id: string; modelId: string; action: 'download' | 'start' | 'stop'; phase: 'running' | 'done' | 'failed'
  stage: 'checking' | 'downloading' | 'updating' | 'starting' | 'verifying' | 'stopping'
  progress?: number; error?: string; updatedAt: string
}
export interface LocalModelsSnapshot {
  /** [memoryBytes]: the machine's RAM — on an NVIDIA machine not what a model runs in. */
  models: LocalModel[]; memoryBytes?: number; hardware?: string
  /** What the catalog fits models to ([modelBudget]) and what memory that is: an NVIDIA card's free
   *  VRAM (`vram`), an Apple Silicon Mac's unified memory, or system RAM where there is no usable
   *  GPU. The apps say VRAM, and judge "fits" against it, where a model runs on the card. */
  fitBytes?: number; fitMemory?: 'vram' | 'unified' | 'ram'
  /** An NVIDIA machine's cards' VRAM, all of it (grid's `gpus[].memory_total_mb`). */
  gpuMemoryBytes?: number
  /** A sentence to show BESIDE the list — never `error`. On this protocol an `error` field fails
   * the whole request: the app's RPC layer drops the reply and keeps nothing of it, so a list sent
   * with a warning in `error` arrived as no list at all and the Local tab read 0. */
  notice?: string
  observedAt: string; busy: boolean
  supportsDownload?: boolean
  /** Free space where downloads land, so a download's size can be read against it. */
  freeDiskBytes?: number
  /** The OS grid this computer claims, by grid's own rule ([osToken]); absent for no OS grid. */
  os?: OsToken
  /** The community grid of that OS this account is in (`grid ls`'s `os-community` grid, `Omagrid`):
   *  where a start with `community` runs a model. Absent: in none. */
  osGrid?: string
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
interface Owned { file: string; selector: string; aliases: string[]; nodeId: string; name: string; live: boolean; pidAlive: boolean; dead: boolean; siblings: number }
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
  run?: (args: string[], output?: (chunk: string) => void, timeout?: number, signal?: AbortSignal) => Promise<GridFleetResult>
  /** How long a download's files may stop growing before it is called stalled, and how often they are
   *  looked at ([PULL_STALL_MS], [PULL_WATCH_MS]); a test shortens both. */
  pullStallMs?: number
  pullWatchMs?: number
  request?: typeof fetch
  /** Injected, never a `grid engines` call: that read carries the grid credential, and a signed-in read
   * of a sleeping grid WAKES it — once a tick, for as long as the panel is open. */
  inventory: (grid: string, force: boolean) => Promise<GridInventory>
  /** Another grid's nodes, read the same way without taking it for the own grid (`gridModels.gridServingNodes`):
   *  what this computer serves on the account's other grids. Absent: only the own grid is read. */
  servingNodes?: (grid: string) => Promise<GridInventory>
  /** The OS grid this computer claims ([osToken]); a test names one. */
  os?: () => OsToken | undefined
  /** Told when a start or stop has finished, so the model lists are read again. */
  onChanged?: () => void
  /** Models other apps downloaded here ([scanAppModels]), and the engines that start them. Absent: none. */
  appModels?: () => Promise<AppModel[]>
  appEngines?: AppEngineOps
  /** How long a scan is waited for ([APP_SCAN_MS]); a test shortens it. */
  appScanMs?: number
  /** The processes holding NVIDIA VRAM here ([nvidiaComputeApps]), so the catalog counts what this
   *  picker's own engine holds as the next model's ([LocalModels.withOwnVram]). Absent: not counted. */
  gpuProcesses?: () => Promise<GpuProcess[]>
}

/** A download whose files have not grown in this long has stalled ([LocalModels.perform]): long enough for a
 *  slow mirror's pauses, short of the 30 minutes a command may run. Looked at every [PULL_WATCH_MS]. */
const PULL_STALL_MS = 3 * 60_000
const PULL_WATCH_MS = 10_000

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

/** What the catalog fits to on [device] and what memory that is ([LocalModelsSnapshot.fitBytes]). */
export function fitOf(device: Record<string, any>): Pick<LocalModelsSnapshot, 'fitBytes' | 'fitMemory' | 'gpuMemoryBytes'> {
  const fit = modelBudget(device)
  const backend = str(device.backend)
  const fitMemory = backend === 'cuda' ? 'vram' as const : backend === 'metal' ? 'unified' as const : backend ? 'ram' as const : undefined
  const cards = backend === 'cuda' && Array.isArray(device.gpus) ? device.gpus : []
  const gpuMemoryBytes = cards.reduce((sum: number, gpu: unknown) => sum + (num(obj(gpu).memory_total_mb) ?? 0), 0) * 1024 ** 2
  return { ...(fit === undefined ? {} : { fitBytes: fit }), ...(fitMemory ? { fitMemory } : {}), ...(gpuMemoryBytes > 0 ? { gpuMemoryBytes } : {}) }
}

/** An engine record of a Jev decision model's (`jev:` ids — ggml-org's Kev and Laya, Ollama's tev1),
 *  from before #1141 removed them: [LocalModels.records] forgets it. */
export function isJevRecord(record: Pick<AppEngineRecord, 'modelId'>): boolean {
  return record.modelId.startsWith('jev:')
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
  private readonly pullStallMs: number
  private readonly pullWatchMs: number
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
  private active?: { grid: string; operation: ModelOperation; done: Promise<void>; pull: AbortController; cancelled: boolean }
  private receipt?: Receipt
  private receiptScope?: string
  private knownByGrid = new Map<string, Candidate[]>()
  private blockers = new Map<string, string>()
  private appsRead?: { at: number; value: AppModel[] }
  private appsPending?: Promise<AppModel[]>
  /** Read once: a computer does not change its OS while the daemon runs. */
  private osRead?: { value: OsToken | undefined }
  /** The last operation finished, and its grid: a list of another grid (the own one, after a start on the
   *  community grid) still says how it ended. */
  private elsewhere?: { grid: string; operation: ModelOperation }

  constructor(private readonly options: Options) {
    this.processEnv = options.processEnv ?? process.env
    this.home = dirname(gridCredentialsPath(this.processEnv))
    const rpc = new GridFleetRpc(this.processEnv)
    this.run = options.run ?? ((args, output, timeout = 30_000, signal) => {
      const id = randomUUID()
      signal?.addEventListener('abort', () => rpc.cancel('local-models', id), { once: true })
      return rpc.run('local-models', id, { args, timeoutMs: timeout, thinking: false }, output, 4 * 1024 * 1024)
    })
    this.request = options.request ?? fetch
    this.pullStallMs = options.pullStallMs ?? PULL_STALL_MS
    this.pullWatchMs = options.pullWatchMs ?? PULL_WATCH_MS
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
        this.device = await this.withOwnVram(obj(await this.json(['device-info', '--json'])))
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

  /** An NVIDIA card's `usable_bytes` is the VRAM free on it now: less what the model this picker runs
   *  holds. One local model runs at a time and a start stops the running one first, so that VRAM is the
   *  next model's too, and it is counted back in. Left out, the catalog was fitted to what was left
   *  beside our own model (2.9 GB of a 24 GB card running a 27B): it offered nothing to get, and the
   *  running model fell out of it, so its row came back under its file name (`Qwen3.8-27B-UD-Q4_K_M`)
   *  and the Use that had started it lost the row and never moved the harness. Grid's engine is known by
   *  its binary; an app's engine this picker started by its record. Everyone else's VRAM (a desktop, a
   *  browser, a llama-server of the person's own) stays taken. */
  private async withOwnVram(device: Record<string, any>): Promise<Record<string, any>> {
    const usable = num(device.usable_bytes)
    if (device.backend !== 'cuda' || usable === undefined || !this.options.gpuProcesses) return device
    const records = await this.records()
    const engines = new Set([join(this.home, 'bin', 'llama-server'), ...records.map(record => record.binary)])
    const pids = new Set(records.map(record => record.pid))
    const ours = (await this.options.gpuProcesses()).filter(p => engines.has(p.name) || pids.has(p.pid)).reduce((sum, p) => sum + p.bytes, 0)
    if (!ours) return device
    const cards = fitOf(device).gpuMemoryBytes
    return { ...device, usable_bytes: cards ? Math.min(usable + ours, cards) : usable + ours }
  }

  private async downloaded(candidate: Candidate): Promise<boolean> {
    if (candidate.appPath) return stat(candidate.appPath).then(s => s.isFile() && s.size === candidate.size, () => false)
    // A `.part` beside it is a download that did not finish — its projector, say, while its weights did.
    // Read as downloaded, it could not be got again, and the rest of it was never fetched.
    if (await unfinishedDownload(join(this.home, 'models'), candidate.file)) return false
    const sizes = await Promise.all(candidate.files.map(file => stat(join(this.home, 'models', file)).then(s => s.isFile() ? s.size : 0).catch(() => 0)))
    return sizes.every(size => size > 0) && sizes.reduce((sum, size) => sum + size, 0) === candidate.size
  }

  /** The run records whose process is gone ([Owned.dead]), left: grid's leave of a dead engine tears its
   *  identity down, so the join a start makes next is a fresh one, not a union respawned with a model
   *  nobody asked for. Best effort — the start goes on either way, the record read as nothing. */
  private async clearDead(grid: string): Promise<void> {
    for (const dead of (await this.owned(grid)).filter(instance => instance.dead)) {
      await this.run(['--remote', 'leave', grid, '--engine', dead.selector], undefined, 60_000)
    }
  }

  /** Grid's non-secret run records distinguish locally owned --serve processes
   * from external endpoints. Stop delegates identity checks and teardown to Grid. */
  private async owned(grid: string, grids?: Record<string, any>[]): Promise<Owned[]> {
    this.blockers.delete(grid)
    if (!validArg(grid)) return []
    grids ??= rows(await this.json(['--remote', 'ls', '--json']))
    const gridId = str(grids.find(g => g.grid === grid)?.id)
    const { owned, blocker } = await this.engineRecords(gridId)
    // An app's engine this daemon joined there is named, as the list names it: read again before a start, the grid's
    // record alone said only to open Model Manager, with llama3.2:3b from Ollama running for a Swarm (2026-10-24).
    const app = blocker ? (await this.records()).find(record => record.grid === grid) : undefined
    if (blocker) this.blockers.set(grid, app ? `Stop ${cleanName(app.name)} first to start another local model.` : blocker)
    return owned
  }

  /** The engines this computer runs on the grid [gridId] (`grid ls`'s `id`), from Grid's run records,
   * and why another local model cannot start beside them (the last record's reason). */
  private async engineRecords(gridId: string): Promise<{ owned: Owned[]; blocker?: string }> {
    if (!gridId || basename(gridId) !== gridId) return { owned: [] }
    const folder = join(this.home, 'run', 'engines', gridId)
    const names = await readdir(folder).catch(() => [])
    const result: Owned[] = []
    let blocker: string | undefined
    for (const name of names.filter(n => n.endsWith('.json'))) {
      let record: Record<string, any>
      try { record = obj(JSON.parse(await readFile(join(folder, name), 'utf8'))) } catch { continue }
      const heartbeat = await stat(join(folder, name.replace(/\.json$/, '.heartbeat'))).catch(() => null)
      const live = heartbeat !== null && Date.now() - heartbeat.mtimeMs < 90_000
      const specs = rows(record.engines)
      // A record whose process is gone serves nothing: the computer restarted, or the engine died, and grid
      // keeps the record (run/engines survives a reboot) until something leaves it. Read as an engine, it
      // held its model forever — not startable ("It cannot start now. Try again in a moment.", after an NVIDIA
      // machine restarted), and every other model behind "Stop … first". A start clears it ([clearDead]).
      const pid = recordPid(record)
      const pidAlive = pid !== null && processExists(pid)
      const dead = pid !== null && !pidAlive
      // An API a Swarm shares (`swarmApiShares.ts`) is joined as an engine too, but runs nothing here: it never stands in
      // a local model's way (owner, 2026-10-23: two shared APIs kept a model from running for the same Swarm).
      const sharedApis = specs.length > 0 && !record.media && specs.every(spec => SWARM_API_SHARE.test(str(spec.endpoint_url)))
      if ((specs.length || record.media) && !dead && !sharedApis) blocker = 'Open Model Manager to add a model alongside those already running.'
      for (const spec of specs) {
        if (spec.endpoint_url || spec.api_kind || !Array.isArray(spec.models) || spec.models.length !== 1) continue
        const file = str(spec.models[0])
        if (!validArg(file) || !file.toLowerCase().endsWith('.gguf')) continue
        // Grid's `spec_aliases`: the engine's own names (ADR 0045) — or the record's flat list, which only ever
        // named a sole engine. With another engine joined beside it, the flat list was ignored and the engine was
        // looked for by its file name, which the grid does not list: a running model read as only downloaded.
        const named = 'advertise_as' in spec ? spec.advertise_as : specs.length === 1 ? record.advertise_as : undefined
        const advertised = Array.isArray(named) ? named.filter((v: unknown) => typeof v === 'string' && v.length > 0) : []
        const aliases: string[] = advertised.length ? advertised : [file]
        result.push({ file: basename(file), selector: file, aliases, nodeId: str(record.node_id), name: str(record.meta_name), live,
          // An API a Swarm shares is a spec of the same engine process but runs nothing here, and a leave by this
          // file's selector leaves it serving: it is no sibling (2026-10-26: Stop for Swarm on Qwen3.6 was refused,
          // "Other models share its engine", beside a shared DeepSeek).
          pidAlive, dead, siblings: specs.filter(s => !SWARM_API_SHARE.test(str(s.endpoint_url))).length + (record.media ? 1 : 0) })
        if (!dead) blocker = `Stop ${cleanName(aliases[0])} first to start another local model.`
      }
    }
    return { owned: result, blocker }
  }

  /** Keep models imported from an existing Grid setup after Stop removes its
   * run record. Only completed local files that this computer already served
   * become restartable; arbitrary downloaded GGUFs are not assumed compatible. */
  private async known(grid: string, owned: Owned[], apps: Candidate[] = []): Promise<Candidate[]> {
    const path = join(this.options.stateDir, `${key(grid)}.known.json`)
    let known = this.knownByGrid.get(grid)
    if (!known) {
      known = await readKnown(path)
      // A file this computer served on another grid is as restartable here: each Swarm has a grid of its own, and a
      // model run for one was missing from the next one's list, offered again as a download (2026-10-24).
      const others = await readdir(this.options.stateDir).catch(() => [] as string[])
      for (const name of others.filter(n => n.endsWith('.known.json') && join(this.options.stateDir, n) !== path).sort()) {
        for (const candidate of await readKnown(join(this.options.stateDir, name))) {
          if (!known.some(c => c.file === candidate.file)) known.push(candidate)
        }
      }
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
        str(a.id).startsWith('app:') && str(a.name) && ['ollama', 'lm-studio', 'llama.cpp'].includes(a.app) &&
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

  /** The engines this daemon started — less any left by the Jev decision models Harness no longer has
   *  (#1141). Their records name models no list knows, and as engine records each one blocked every
   *  chat model's start ("Stop laya-english first to start another local model."), its engine long
   *  gone or not, and listed itself as a model to use that cannot chat. Each is forgotten the first
   *  time it is read, its engine stopped and taken off its grid first should it still run. */
  private async records(): Promise<AppEngineRecord[]> {
    const all = await readAppRecords(this.appRecordsFile)
    const left = all.filter(isJevRecord)
    if (!left.length) return all
    const kept = all.filter(record => !isJevRecord(record))
    await writeAppRecords(this.appRecordsFile, kept)
    for (const record of left) void this.retire(record)
    return kept
  }

  /** The names this computer's app engines are joined to [grid] under (`swarmHeal.ts` compares them with what the grid
   *  lists). An engine whose process is gone is not served by anything here. */
  async servedApps(grid: string): Promise<string[]> {
    const served: string[] = []
    for (const record of (await this.records()).filter(r => r.grid === grid)) {
      if (await this.options.appEngines?.alive(record).catch(() => false)) served.push(record.alias)
    }
    return served
  }

  /** Joins this computer's first live app engine on [grid] again, as it was started: grid restarts its one engine
   *  process for the grid with every model this computer joined there, so this also brings back an API shared beside it
   *  (2026-10-24: after a daemon restart the grid listed nothing this Mac served). Whether grid took it. */
  async rejoinApp(grid: string): Promise<boolean> {
    for (const record of (await this.records()).filter(r => r.grid === grid)) {
      if (!await this.options.appEngines?.alive(record).catch(() => false)) continue
      const named = this.options.machineName?.()?.trim()
      return (await this.run(['--remote', 'join', grid, '--at', `http://127.0.0.1:${record.port}/v1`, '-m', record.served,
        '--advertise-as', record.alias, '--max-concurrency', String(NODE_CONCURRENCY),
        ...(named && validArg(named) ? ['--name', named] : [])], undefined, 10 * 60_000)).ok
    }
    return false
  }

  /** A Jev engine still running: stopped, and off its grid (best effort — its record is already gone). */
  private async retire(record: AppEngineRecord): Promise<void> {
    try {
      if (!await this.options.appEngines?.alive(record)) return
      await this.options.appEngines?.stop(record)
      await this.run(['--remote', 'leave', record.grid, '--engine', record.alias], undefined, 60_000)
    } catch { /* forgotten either way */ }
  }

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
    // `grid ls` once: the own grid's records, and every other grid this computer may serve on.
    let grids: Record<string, any>[] = [], listed = false
    const ownedHere = async () => {
      const answer = validArg(grid) ? await this.json(['--remote', 'ls', '--json']) : null
      listed = Array.isArray(answer)
      grids = rows(answer)
      return this.owned(grid, grids)
    }
    try {
      let inventory: GridInventory
      [owned, inventory] = await Promise.all([ownedHere(), this.options.inventory(grid, force)])
      // A grid that is down — its owner status says stopped or asleep (DOWN) — runs nothing: an answer,
      // not a gap, so Start stays enabled (and brings it back up). Asleep says so even to a member, in
      // the grid's own answer. Only a read that failed some other way is "could not be checked".
      // A grid this account does not have yet runs nothing either: the CLI makes the account's own grid only when
      // something needs it, and a Swarm's models run on the Swarm's grid. Read as unchecked, every Start went dark,
      // Run for Swarm too, for a new account whose Swarm grid was ready (2026-10-26). `grid ls` answered, without it.
      const missing = listed && !grids.some(row => row.grid === grid)
      if (inventory.state === 'unknown' && !DOWN.has(inventory.status ?? '') && !missing) throw new Error('unanswered')
      asleep = inventory.state === 'asleep' || inventory.status === 'asleep'
      nodes = inventory.state === 'awake' ? rows(inventory.nodes) : []
    } catch { inventoryError = 'Running models could not be checked. Try again.' }
    // (A dead engine's record holds nothing: its model reads as downloaded, and starts.)
    owned = owned.filter(instance => !instance.dead)
    // The operation under way, on whichever grid (a model started on the community grid shows its progress
    // here too), else the last one finished when that was on another grid — the latest there is — else
    // this grid's receipt.
    const elsewhere = this.elsewhere?.grid !== grid ? this.elsewhere?.operation : undefined
    const operation = this.active?.operation ?? elsewhere ?? (this.receipt?.grid === grid ? this.receipt.operation : undefined)
    const apps = await this.apps(force)
    const allRecords = await this.records()
    const records = allRecords.filter(record => record.grid === grid)
    // An app's engine this daemon started on another grid — a Swarm's (docs/plans/2026-10-23-swarm-local-models.md):
    // its model is served there, so the row says so and cannot start a second engine beside it.
    const away = allRecords.filter(record => record.grid !== grid)
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
    const servingNode = (instance?: Owned) => nodeServing(nodes, instance)
    // A parked engine: its grid sleeps, so the grid lists nothing, but the process that serves it is alive
    // here and rejoins the moment the grid wakes. Liveness is the record's pid — never the heartbeat
    // sidecar, which goes stale while a healthy provider is parked.
    const parked = (instance?: Owned): boolean => asleep && !!instance?.pidAlive
    // Every grid each file is served on here, given to the one row its engine is attributed to (as [owners]).
    const served = await this.servedOn(grid, grids, inventoryError ? undefined : { owned, nodes, asleep })
    const fileOwner = (file: string) => choices.find((candidate, index) => candidate.file === file && downloaded[index])
      ?? choices.find(candidate => candidate.file === file)
    const servedOn = (file: string): Partial<LocalModel> => served.has(file) ? { servedOn: served.get(file) } : {}
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
        ...(instance ? { servedAs: instance.aliases.map(displayModelName) } : {}),
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
        ...(running || available ? { app: GRID_LABEL } : {}),
        ...(fileOwner(candidate.file) === candidate ? servedOn(candidate.file) : {}) }
    })
    for (const instance of owned.filter(o => !choices.some(c => c.file === o.file))) {
      const serving = !!servingNode(instance)
      models.push({ id: `local:${instance.file}`, name: cleanName(instance.aliases[0]), servedAs: instance.aliases.map(displayModelName),
        state: serving || parked(instance) ? 'running' : 'available', canStart: false, canStop: !inventoryError,
        operation: operation?.modelId === `local:${instance.file}` ? operation : undefined,
        ...(!serving && parked(instance) ? { gridAsleep: true } : {}), app: GRID_LABEL, ...servedOn(instance.file) })
    }
    // Models in their own apps, started there: running when that engine is up and the grid lists it (or
    // the grid sleeps — parked, as above). A record whose model has since gone keeps a row to stop it by.
    const listedHere = (alias: string) => nodes.some(n => n.online === true && (Array.isArray(n.models) ? n.models : [])
      .some((m: unknown) => modelKey(str(typeof m === 'string' ? m : obj(m).model)) === modelKey(alias)))
    const appRow = async (id: string, name: string, app: AppEngine, record: AppEngineRecord | undefined, extra: Partial<LocalModel>): Promise<LocalModel> => {
      const alive = record && this.options.appEngines ? await this.options.appEngines.alive(record) : false
      const listed = !!record && listedHere(record.alias)
      const running = alive && (listed || asleep)
      const elsewhere: ServedOn[] = []
      for (const there of away.filter(r => r.modelId === id)) {
        if (this.options.appEngines && await this.options.appEngines.alive(there)) elsewhere.push({ grid: there.grid, servedAs: [there.alias] })
      }
      return { id, name, app: APP_LABEL[app], state: running ? 'running' : 'downloaded', ...extra, ...(record ? { servedAs: [record.alias] } : {}),
        ...(elsewhere.length ? { servedOn: [...(running && record ? [{ grid, servedAs: [record.alias] }] : []), ...elsewhere] } : {}),
        canStart: !inventoryError && !record && !elsewhere.length, canStop: !inventoryError && !!record,
        operation: operation?.modelId === id ? operation : undefined, ...(running && !listed ? { gridAsleep: true } : {}) }
    }
    for (const app of apps.filter(a => a.engine !== 'grid' || recorded(a.id))) {
      models.push(await appRow(app.id, app.name, app.app, records.find(r => r.modelId === app.id),
        { sizeBytes: app.sizeBytes, ...(app.quant ? { quant: app.quant } : {}) }))
    }
    for (const record of records.filter(r => !apps.some(a => a.id === r.modelId))) {
      models.push({ ...await appRow(record.modelId, record.name, record.engine, record, {}), canStart: false })
    }
    const freeDiskBytes = await statfs(join(this.home, 'models')).catch(() => statfs(this.home))
      .then(disk => disk.bavail * disk.bsize, () => undefined)
    const value: LocalModelsSnapshot = { models: withoutCopiesOfOwned(models), memoryBytes: num(obj(this.device.memory).total_gb) === undefined ? undefined : this.device.memory.total_gb * GiB,
      ...fitOf(this.device),
      hardware: str(obj(this.device.machine).model || obj(this.device.cpu).brand), notice: inventoryError || this.catalogError,
      observedAt: new Date().toISOString(), busy: !!this.active, supportsDownload: true,
      ...(freeDiskBytes === undefined ? {} : { freeDiskBytes }), ...this.osField(), ...communityOf(grids) }
    this.cached = { grid, at: Date.now(), value }
    this.runningAtLastRead.set(grid, new Set(models.filter(model => model.state === 'running').map(model => model.id)))
    return value
  }

  /** Every grid this computer serves each file on (by file), with what its engine answered there: the own
   * grid [grid] from what [readList] already read ([own]; absent when that read failed), every other grid
   * in `grid ls` with a run record here from [Options.servingNodes]. A node that is not listed while its
   * grid sleeps is named with no figures; a record with no node and no sleep is not serving. On another
   * grid, an engine whose process is alive is named with no figures too, its grid's read or not: before
   * that grid lists it, or while its read fails, it still serves there — and a second engine of the same
   * model must not start on the own grid for want of seeing it (review, 2026-10-13). */
  private async servedOn(grid: string, grids: Record<string, any>[],
    own: { owned: Owned[]; nodes: Record<string, any>[]; asleep: boolean } | undefined): Promise<Map<string, ServedOn[]>> {
    const served = new Map<string, ServedOn[]>()
    const add = (name: string, owned: Owned[], nodes: Record<string, any>[], asleep: boolean, elsewhere = false) => {
      for (const instance of owned) {
        const node = nodeServing(nodes, instance)
        if (!node && !((asleep || elsewhere) && instance.pidAlive)) continue
        const answered = obj(node?.answered)
        const perModel = rows(answered.by_model).find(a => instance.aliases.some(alias => modelKey(alias) === modelKey(str(a.model))))
        const figures = node ? { requests: num(perModel?.requests), tokensOut: num(perModel?.tokens_out), tokensIn: num(perModel?.tokens_in),
          tokensCached: num(perModel?.tokens_cached), windowSeconds: num(answered.window_seconds) } : {}
        const entry: ServedOn = { grid: name, servedAs: instance.aliases.map(displayModelName),
          ...Object.fromEntries(Object.entries(figures).filter(([, v]) => v !== undefined)) }
        served.set(instance.file, [...(served.get(instance.file) ?? []), entry])
      }
    }
    if (own) add(grid, own.owned, own.nodes, own.asleep)
    const read = this.options.servingNodes
    if (!read) return served
    for (const row of grids) {
      const name = str(row.grid)
      if (!validArg(name) || name === grid) continue
      const { owned } = await this.engineRecords(str(row.id))
      if (!owned.length) continue
      const inventory = await read(name).catch(() => undefined)
      add(name, owned, inventory?.state === 'awake' ? rows(inventory.nodes) : [], inventory?.state === 'asleep' || inventory?.status === 'asleep', true)
    }
    return served
  }

  private osField(): { os?: OsToken } {
    this.osRead ??= { value: (this.options.os ?? osToken)() }
    return this.osRead.value ? { os: this.osRead.value } : {}
  }

  /** The community grid of this computer's OS that the account is in (`grid ls`), for a start or stop
   *  with `community`; null in none. */
  async communityGrid(): Promise<string | null> {
    return communityOf(rows(await this.json(['--remote', 'ls', '--json']))).osGrid ?? null
  }

  /** What `grid info` says of [grid]: `running`, `stopped`, `asleep`. */
  private async gridStatus(grid: string): Promise<string> {
    return str(obj(await this.json(['--remote', 'info', grid, '--json'])).status)
  }

  /** A repeated click or lost RPC acknowledgement joins the same operation.
   * A different model waits: starts/stops must not race on the machine's budget. */
  async act(grid: string | null, modelId: unknown, action: 'download' | 'start' | 'stop'): Promise<{ operation?: ModelOperation; error?: string }> {
    if (!grid || typeof modelId !== 'string') return { error: 'The model is unavailable. Refresh and try again.' }
    // Stop on a model that is downloading cancels the download, and what it downloaded goes ([perform]).
    // Without it, a download that hung (its connection stalled after the disk filled) held the view on
    // "Downloading 36%" with nothing to press but Wait.
    const running = this.active
    if (action === 'stop' && running?.grid === grid && running.operation.modelId === modelId && running.operation.stage === 'downloading') {
      running.cancelled = true
      running.pull.abort()
      return { operation: running.operation }
    }
    if (this.active) return this.active.grid === grid && this.active.operation.modelId === modelId && this.active.operation.action === action
      ? { operation: this.active.operation } : { error: 'Wait for the current model operation to finish.' }
    const operation: ModelOperation = { id: randomUUID(), modelId, action, stage: action === 'stop' ? 'stopping' : 'checking', phase: 'running', updatedAt: new Date().toISOString() }
    // Reserve before any await; independent RPCs may arrive on separate connections.
    const active = { grid, operation, done: Promise.resolve(), pull: new AbortController(), cancelled: false }
    this.active = active
    try { await this.save(grid, operation) } catch { this.active = undefined; return { error: 'Setup could not be saved. Try again.' } }
    active.done = this.perform(grid, operation).catch(async error => {
      operation.phase = 'failed'
      operation.error = error instanceof ModelError ? error.message : 'The model could not finish. Start again to retry.'
      await this.save(grid, operation).catch(() => {})
    }).finally(() => { this.active = undefined; this.elsewhere = { grid, operation }; this.cached = undefined; this.options.onChanged?.() })
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
    const must = async (args: string[], message: string, output?: (chunk: string) => void, signal?: AbortSignal) => {
      if (!(await this.run(args, output, 30 * 60_000, signal)).ok) throw new ModelError(message)
    }
    if (operation.action !== 'stop') await this.loadCatalog()
    if (operation.action === 'start') {
      // Leaving the last engine removes Grid's local registration. Restore the
      // account's existing grids before resolving ownership or joining again.
      await must(['--remote', 'sync'], 'Models could not be checked. Try again.')
      await this.clearDead(grid)
    }
    // The last scan has every model a person could have clicked; a model it lacks waits for a new one.
    let apps = operation.modelId.startsWith('app:') ? await this.apps() : []
    if (operation.modelId.startsWith('app:') && !apps.some(a => a.id === operation.modelId)) apps = await this.scanApps()
    const app = apps.find(a => a.id === operation.modelId)
    // An engine this daemon started is stopped the way it was started, whatever its id: a record left by a kind of
    // model the picker no longer offers keeps a row (and holds the next start), so its Stop must take it down.
    const started = (await this.records()).some(r => r.modelId === operation.modelId && r.grid === grid)
    if (started || (operation.modelId.startsWith('app:') && app?.engine !== 'grid')) {
      return this.performApp(grid, operation, app?.engine === 'grid' ? undefined : app)
    }
    const owned = (await this.owned(grid)).filter(instance => !instance.dead)
    const appServed = this.appCandidates(apps)
    // A model this computer knows from another grid's list too: a file imported on the own grid starts on the
    // community grid by the same id (each grid keeps its own `known`).
    const elsewhere = [...this.knownByGrid].filter(([other]) => other !== grid).flatMap(([, known]) => known)
    const candidate = [...this.candidates, ...await this.known(grid, owned, appServed), ...appServed, ...elsewhere].find(c => c.id === operation.modelId)
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
          // The pull is watched by what it writes: grid reads its download with no read timeout, so a
          // connection that stops sending holds it forever — after a full disk on an NVIDIA machine, 30
          // minutes at 36% with nothing to press. Files that stop growing for [PULL_STALL_MS] end it.
          const active = this.active!, pull = active.pull
          let size = -1, grewAt = Date.now(), stalled = false
          const watch = setInterval(() => void downloadedBytes(join(this.home, 'models'), candidate.file).then(bytes => {
            if (bytes !== size) { size = bytes; grewAt = Date.now() } else if (Date.now() - grewAt >= this.pullStallMs) { stalled = true; pull.abort() }
          }), this.pullWatchMs)
          try {
            await must(['pull', candidate.pull], 'The download stopped. Start again to resume.', chunk => {
              const matches = [...chunk.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
              const percent = matches.length ? Number(matches.at(-1)![1]) : NaN
              if (Number.isFinite(percent) && percent >= 0 && percent <= 100 && Date.now() - last > 500) {
                last = Date.now(); operation.progress = percent / 100
                progressWrites = progressWrites.then(() => this.save(grid, operation)).catch(() => {})
              }
            }, pull.signal)
          } catch (error) {
            if (active.cancelled) {
              await progressWrites
              // (The model was not on this computer before: a download starts only for one [downloaded] says
              // is not, so what goes is only what this download wrote.)
              await removeDownload(join(this.home, 'models'), candidate.file)
              // A cancel is a stop that finished, not a failure: the row goes back to Get.
              operation.action = 'stop'; operation.stage = 'stopping'; operation.phase = 'done'; delete operation.progress
              await this.save(grid, operation)
              return
            }
            throw stalled ? new ModelError('The download stalled. Start again to resume.') : error
          } finally { clearInterval(watch) }
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
            '--max-concurrency', String(NODE_CONCURRENCY), '--parallel', '1',
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
    const records = await this.records()
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
      const running = records.find(r => r.grid === grid && r.modelId !== app.id)
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
        await writeAppRecords(this.appRecordsFile, (await this.records()).filter(r => !(r.modelId === app.id && r.grid === grid)))
        throw new ModelError(message)
      }
      const named = this.options.machineName?.()?.trim()
      const joined = await this.run(['--remote', 'join', grid, '--at', `http://127.0.0.1:${started.port}/v1`, '-m', started.served,
        '--advertise-as', started.alias, '--max-concurrency', String(NODE_CONCURRENCY),
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

  private async verify(grid: string, model: string): Promise<void> {
    const info = await this.run(['--remote', 'info', grid, '--env'])
    const { baseUrl, apiKey } = readEnvExports(info.stdout)
    if (!info.ok || !baseUrl || !apiKey) throw new ModelError('The model is starting, but could not be checked. Try again shortly.')
    const deadline = Date.now() + 180_000
    let maxTokens = 8
    do {
      try {
        const response = await this.request(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: maxTokens }),
          signal: AbortSignal.timeout(maxTokens === THINKING_TEST_TOKENS ? 90_000 : 30_000), redirect: 'error',
        })
        const body = response.ok ? obj(await response.json()) : {}
        const message = obj(rows(body.choices)[0]?.message)
        if (/^\s*ok[.!]?\s*$/i.test(str(message.content))) return
        // A model that thinks first spends a reply this short thinking: Muse-Glimmer-30B (which thinks
        // whatever --reasoning-budget says) put all 8 tokens in its reasoning, its content stayed empty,
        // and every start of it failed after 3 minutes of "Testing" while it answered each try. Asked
        // again with room to finish thinking, it says ok. A real reply is still what passes.
        if (!str(message.content).trim() && str(message.reasoning_content || message.reasoning).trim()) maxTokens = THINKING_TEST_TOKENS
      } catch { /* registration and first warmup take time; status remains verifying */ }
      await new Promise(resolve => setTimeout(resolve, 1500))
    } while (Date.now() < deadline)
    throw new ModelError('The model did not answer. Stop it, then start again.')
  }
}
class ModelError extends Error {}

/** The reply a model that thinks first is given to finish thinking and answer the start's test in
 *  ([LocalModels.verify]): Muse-Glimmer-30B needed under 200. */
const THINKING_TEST_TOKENS = 512

/** More names than any one engine advertises: a record past it is cut, never trusted to be small. */
const MAX_RECORD_IDS = 64

/** The `os-community` grid among [grids] (`grid ls`): the one grid of this computer's OS the account is in
 * (grid admits a machine to its own OS's grid alone, ADR 0039). */
function communityOf(grids: Record<string, any>[]): { osGrid?: string } {
  const name = str(grids.find(g => g.type === 'os-community' && validArg(str(g.grid)))?.grid)
  return name ? { osGrid: name } : {}
}

/** The one online node in [nodes] that is [instance]'s engine — its record's node id (or, with no ids,
 * its name) and every name it serves under; none while its heartbeat is stale or two nodes would match. */
/** The endpoint a Swarm's shared API is joined at (`swarmApiShares.ts`): this computer, a port, and its secret path. */
const SWARM_API_SHARE = /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{36}\/v1\/?$/

function nodeServing(nodes: Record<string, any>[], instance?: Owned): Record<string, any> | undefined {
  const matches = instance?.live ? nodes.filter(n => n.online === true &&
    (str(n.node_id || n.id) ? str(n.node_id || n.id) === instance.nodeId :
      !!instance.name && str(n.name) === instance.name) &&
    instance.aliases.every(alias => (Array.isArray(n.models) ? n.models : []).some((m: unknown) =>
      modelKey(str(typeof m === 'string' ? m : obj(m).model)) === modelKey(alias)))) : []
  return matches.length === 1 ? matches[0] : undefined
}

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
