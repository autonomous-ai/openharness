/** The Models popover's local lifecycle. Grid remains the hardware, catalog,
 * download and process authority. A click is a durable daemon operation, never a chat task. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat, mkdir, rename, writeFile, statfs } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { GridFleetRpc, type GridFleetResult } from './gridFleetRpc.js'
import { gridCredentialsPath } from './gridCredentials.js'
import { binaryOnPath } from './binaryOnPath.js'
import { processExists } from './processLiveness.js'
import type { LocalRecord, PictureState } from './gridPicture.js'
import { displayModelName } from './gridReader.js'

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
/** The smallest context a coding agent can work in. Codex, Claude Code and OpenCode each open a
 * session with a system prompt and tool list of several thousand tokens and grow from there; Ollama's
 * own guides for all three put the floor at 64K, and below it a session survives a few turns and then
 * fails. Every model offered here is one this machine can give at least this much. */
export const MIN_CODING_CONTEXT = 64 * 1024
/** Where a start begins for a file whose header could not be read: the size a 64 GB Mac was seen
 * to hold for a 35B model, one step above the floor. */
const UNREAD_CONTEXT = 128 * 1024

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
/** What llama.cpp answers once its GPU backend has failed an allocation — every request after. */
const OUT_OF_MEMORY = /compute error|out of memory|insufficient memory|failed to allocate/i

export interface LocalModel {
  id: string; name: string; state: 'available' | 'downloaded' | 'running'
  sizeBytes?: number; quant?: string; recommended?: boolean; canStart: boolean; canStop: boolean
  tokensPerSecond?: number; requests?: number; windowSeconds?: number
  operation?: ModelOperation
  /** Running here, parked while its grid sleeps (additive: an older desktop reads plain `running`). */
  gridAsleep?: boolean
}
export interface ModelOperation {
  id: string; modelId: string; action: 'start' | 'stop'; phase: 'running' | 'done' | 'failed'
  stage: 'checking' | 'downloading' | 'starting' | 'verifying' | 'stopping'
  progress?: number; error?: string; updatedAt: string
}
export interface LocalModelsSnapshot {
  models: LocalModel[]; memoryBytes?: number; hardware?: string
  /** A sentence to show BESIDE the list — never `error`. On this protocol an `error` field fails
   * the whole request: the app's RPC layer drops the reply and keeps nothing of it, so a list sent
   * with a warning in `error` arrived as no list at all and the Local tab read 0. */
  notice?: string
  observedAt: string; busy: boolean
}
interface Candidate {
  id: string; name: string; pull: string; file: string; files: string[]; size: number; quant: string
  /** The window to pin at start: the catalog's fit for this machine, which is the largest it can
   * hold. Absent for a model found on disk, which the catalog never sized — the engine then measures
   * free memory at load and takes the largest window that fits (`grid join` without `--ctx-size`). */
  context?: number
  aliases?: string[]
}
/** `live`: its heartbeat sidecar is fresh (the grid is hearing from it). `pidAlive`: the process its run
 *  record names exists — the only liveness that holds while the grid sleeps and the sidecar goes stale. */
interface Owned { file: string; selector: string; aliases: string[]; nodeId: string; name: string; live: boolean; pidAlive: boolean; siblings: number }
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
    return [{ id, name: cleanName(id), pull, file, files: files.length ? files : [file], size,
      quant: str(fit.version), context: fitted }]
  })
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
  private active?: { grid: string; operation: ModelOperation; done: Promise<void> }
  private receipt?: Receipt
  private receiptScope?: string
  private knownByGrid = new Map<string, Candidate[]>()
  private blockers = new Map<string, string>()

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
    const all: any[] = []
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(url, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ browse: true, page, page_size: 50, device: {
          device_class: device.device_class, usable_bytes: device.usable_bytes, backend: device.backend,
        } }), signal: AbortSignal.timeout(20_000), redirect: 'error',
      })
      if (!response.ok) throw new Error('Compatible models are unavailable. Try again.')
      const body = obj(await response.json())
      if (!Array.isArray(body.models)) throw new Error('Compatible models are unavailable. Try again.')
      all.push(...body.models)
      const totalPages = num(obj(body.pagination).total_pages) ?? 1
      if (page >= totalPages || (num(body.runnable_total) !== undefined && all.filter(m => m.runnable === true).length >= body.runnable_total)) return { models: all }
      if (!body.models.length || obj(body.pagination).page !== page) throw new Error('The model catalog is incomplete. Try again.')
    }
    throw new Error('The model catalog is incomplete. Try again.')
  }

  private async loadCatalog(force = false): Promise<void> {
    if (!force && this.catalogAt && Date.now() - this.catalogAt < 5 * 60_000) return
    return this.catalogPending ??= (async () => {
      try {
        this.device = obj(await this.json(['device-info', '--json']))
        const catalog = obj(await this.catalog(this.device))
        this.candidates = compatibleModels(catalog)
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
        // A useful small download makes the first reply arrive sooner. Keep
        // the catalog's relevance order within that group, and show all others.
        const suggested = this.candidates.findIndex(c => c.size <= 8 * GiB && c.size >= GiB)
        if (suggested > 0) this.candidates.unshift(...this.candidates.splice(suggested, 1))
        this.catalogError = undefined
        this.catalogAt = Date.now()
      } catch (error) {
        this.catalogError = error instanceof Error && /^(Sign in|The model catalog)/.test(error.message)
          ? error.message : 'Compatible models are unavailable. Try again.'
      }
    })().finally(() => { this.catalogPending = undefined })
  }

  private async downloaded(candidate: Candidate): Promise<boolean> {
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
        const advertised = Array.isArray(record.advertise_as) && specs.length === 1
          ? record.advertise_as.filter((v: unknown) => typeof v === 'string' && v.length > 0) : []
        const aliases: string[] = advertised.length ? advertised : [file]
        const pid = recordPid(record)
        result.push({ file: basename(file), selector: file, aliases, nodeId: str(record.node_id), name: str(record.meta_name), live, pidAlive: pid !== null && processExists(pid), siblings: specs.length + (record.media ? 1 : 0) })
        this.blockers.set(grid, `Stop ${cleanName(aliases[0])} first to start another local model.`)
      }
    }
    return result
  }

  /** Keep models imported from an existing Grid setup after Stop removes its
   * run record. Only completed local files that this computer already served
   * become restartable; arbitrary downloaded GGUFs are not assumed compatible. */
  private async known(grid: string, owned: Owned[]): Promise<Candidate[]> {
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
      if (this.candidates.some(c => c.file === instance.file) || known.some(c => c.file === instance.file)) continue
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
    const choices = [...this.candidates, ...(await this.known(grid, owned)).filter(k => !this.candidates.some(c => c.file === k.file))]
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
        canStart: !inventoryError && (!this.catalogError || !candidate.pull) && !instance, canStop: !inventoryError && !!instance,
        // Device memory is deliberately not presented as this model's memory.
        tokensPerSecond: single && running ? num(node?.throughput_tok_s) : undefined,
        requests: running ? num(perModel?.requests) : undefined,
        windowSeconds: running ? num(answered.window_seconds) : undefined,
        operation: operation?.modelId === candidate.id ? operation : undefined,
        ...(!node && parked(instance) ? { gridAsleep: true } : {}) }
    })
    for (const instance of owned.filter(o => !choices.some(c => c.file === o.file))) {
      const serving = !!servingNode(instance)
      models.push({ id: `local:${instance.file}`, name: cleanName(instance.aliases[0]),
        state: serving || parked(instance) ? 'running' : 'available', canStart: false, canStop: !inventoryError,
        operation: operation?.modelId === `local:${instance.file}` ? operation : undefined,
        ...(!serving && parked(instance) ? { gridAsleep: true } : {}) })
    }
    const value: LocalModelsSnapshot = { models, memoryBytes: num(obj(this.device.memory).total_gb) === undefined ? undefined : this.device.memory.total_gb * GiB,
      hardware: str(obj(this.device.machine).model || obj(this.device.cpu).brand), notice: inventoryError || this.catalogError,
      observedAt: new Date().toISOString(), busy: !!this.active }
    this.cached = { grid, at: Date.now(), value }
    return value
  }

  /** What `grid info` says of [grid]: `running`, `stopped`, `asleep`. */
  private async gridStatus(grid: string): Promise<string> {
    return str(obj(await this.json(['--remote', 'info', grid, '--json'])).status)
  }

  /** A repeated click or lost RPC acknowledgement joins the same operation.
   * A different model waits: starts/stops must not race on the machine's budget. */
  async act(grid: string | null, modelId: unknown, action: 'start' | 'stop'): Promise<{ operation?: ModelOperation; error?: string }> {
    if (!grid || typeof modelId !== 'string') return { error: 'The model is unavailable. Refresh and try again.' }
    if (this.active) return this.active.grid === grid && this.active.operation.modelId === modelId && this.active.operation.action === action
      ? { operation: this.active.operation } : { error: 'Wait for the current model to finish starting or stopping.' }
    const operation: ModelOperation = { id: randomUUID(), modelId, action, stage: action === 'start' ? 'checking' : 'stopping', phase: 'running', updatedAt: new Date().toISOString() }
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

  async settled(): Promise<void> { await this.active?.done }

  private async perform(grid: string, operation: ModelOperation): Promise<void> {
    const change = async (stage: ModelOperation['stage']) => {
      operation.stage = stage; delete operation.progress; await this.save(grid, operation)
    }
    const must = async (args: string[], message: string, output?: (chunk: string) => void) => {
      if (!(await this.run(args, output, 30 * 60_000)).ok) throw new ModelError(message)
    }
    if (operation.action === 'start') {
      await this.loadCatalog()
      // Leaving the last engine removes Grid's local registration. Restore the
      // account's existing grids before resolving ownership or joining again.
      await must(['--remote', 'sync'], 'Models could not be checked. Try again.')
    }
    const owned = await this.owned(grid)
    const candidate = [...this.candidates, ...await this.known(grid, owned)].find(c => c.id === operation.modelId)
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
        if (this.blockers.has(grid)) throw new ModelError(this.blockers.get(grid)!)
        // Recheck the machine immediately before downloading or allocating.
        const currentDevice = obj(await this.json(['device-info', '--json']))
        const budget = num(currentDevice.usable_bytes) ?? 0
        if (candidate.pull) {
          const current = compatibleModels(await this.catalog({ ...currentDevice, usable_bytes: Math.max(0, budget) })).find(c => c.id === candidate.id)
          if (!current || current.size < candidate.size) throw new ModelError('Stop a running model to make room, then try again.')
          candidate.context = Math.min(candidate.context ?? Infinity, current.context ?? Infinity)
        } else if (candidate.size * 1.25 + 2 * GiB > budget) {
          throw new ModelError('Stop a running model to make room, then try again.')
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
            '--max-concurrency', '1', '--ctx-size', String(ctx), '--endpoint-port', String(port),
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

  private async verify(grid: string, model: string): Promise<void> {
    const info = await this.run(['--remote', 'info', grid, '--env'])
    const exports: Record<string, string> = {}
    for (const match of info.stdout.matchAll(/^export\s+(OPENAI_BASE_URL|OPENAI_API_KEY)=(.*)$/gm)) exports[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    if (!info.ok || !exports.OPENAI_BASE_URL || !exports.OPENAI_API_KEY) throw new ModelError('The model is starting, but could not be checked. Try again shortly.')
    const deadline = Date.now() + 180_000
    do {
      try {
        const response = await this.request(`${exports.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', headers: { authorization: `Bearer ${exports.OPENAI_API_KEY}`, 'content-type': 'application/json' },
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
    result.push({ name: str(record.meta_name), ids, pid, alive: pid !== null && processExists(pid) })
  }
  return result
}
