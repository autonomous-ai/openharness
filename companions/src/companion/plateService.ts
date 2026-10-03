/**
 * Individual art (daemons/README.md "Individual art"): harnessd draws each individual's plates on this
 * computer with the generated shader and models, keeps them on disk, and hands them to the apps.
 *
 *   local  `daemon_plate_get { requestId, uid, id, seed, size, version, mood }` over the Unix socket only
 *          (localWsServer.ts) → `daemon_plate { requestId, uid, size, version, mood, frames, frameMs }`
 *   phone  `pair_plate_get` → `pair_plate`, the same fields, sealed both ways (backendSocket.ts,
 *          lib/e2ee/applicationFrames.ts)
 *   either `{ requestId, error, detail? }`: DAEMONS_OFF, BAD_REQUEST, NO_ART (a species with no model),
 *          BUSY (too much already waiting), RENDER_FAILED; and from the transports LOCAL_SOCKET_REQUIRED,
 *          REMOTE_ONLY, E2EE_REQUIRED, UNSUPPORTED.
 *
 * `frames` is one mood's loop at one size and version, each frame `{ rows, mats }` (rows joined by
 * newlines; `mats` the cells' materials: `m` marking, `a` extra, `e` odd eye, `.` the body).
 *
 * How:
 *   - What is drawn is a UNIT: one size and version, every mood (pair/plateRender.ts), because all of a
 *     version's moods share one crop. A request for one mood draws its unit; the other moods come free.
 *   - Drawn in a worker thread (pair/plateWorker.ts): a reveal frame of a busy model takes most of a
 *     second and a unit tens of them, which on the event loop would stall every terminal's keystrokes.
 *     One job at a time, requests before pre-renders, at most `maxQueue` waiting (then BUSY). The worker
 *     is stopped after a minute with nothing to draw.
 *   - Deduplicated: every request for a unit already being drawn (or read) waits on that one.
 *   - Cached on disk, one gzipped file per individual keyed by (PLATE_SOURCE, species, seed):
 *     `<dir>/<PLATE_SOURCE>/<species>-<seed>.json.gz`, 0600 in 0700 folders. A different PLATE_SOURCE (the
 *     models or the shader changed) is a different folder, and the old one is removed. The whole cache is
 *     kept under `maxBytes`, least recently used out first; a few individuals stay decoded in memory.
 *   - Pre-rendered: when a zoo read shows a uid this process has not seen (a hatch), its reveal and
 *     portrait at its version are drawn before anyone asks. The first read after daemons come on is a
 *     baseline: only individuals hatched in the last day are drawn then (a hatch while this machine slept).
 *   - Off (lib/daemonsSwitch.ts): every request answers DAEMONS_OFF, nothing waits, the worker is stopped,
 *     and nothing is read or written.
 */
import { Worker } from 'node:worker_threads'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { gunzip, gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DAEMONS_OFF, DAEMONS_OFF_DETAIL } from './daemonsSwitch.js'
import { isPairDaemonId } from './protocol.js'
import { isSeed, isUid, zooIndividuals, type ZooIndividual } from './individuals.js'
import { hasPlateModel, plateRules, plateSource, renderPlateUnit, type PlateFrame, type PlateJob, type PlateSize, type PlateUnit } from './plateRender.js'

export type { PlateFrame, PlateJob, PlateSize, PlateUnit } from './plateRender.js'

/** The worker bundled at build time (scripts/lib/plateWorker.mjs); absent under tsx and in tests. */
declare const __PLATE_WORKER__: string | undefined

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** The most the cache holds on disk. An individual is about 100-300 KB gzipped with every unit drawn. */
export const PLATE_CACHE_MAX_BYTES = 32 * 1024 * 1024
/** Units waiting to be drawn, beyond which a request answers BUSY and a pre-render is dropped. */
export const PLATE_MAX_QUEUE = 16
/** Individuals kept decoded in memory. */
export const PLATE_MEMORY_ENTRIES = 8
/** The worker is stopped after this long with nothing to draw. */
export const PLATE_WORKER_IDLE_MS = 60_000
/** On the first zoo read, individuals hatched this recently are drawn too. */
export const PLATE_RECENT_HATCH_MS = 24 * 60 * 60_000
/** A cache hit moves its file's time at most this often (least recently used goes first). */
const TOUCH_MS = 60_000

export const PLATE_SIZES: readonly PlateSize[] = ['reveal', 'portrait']

export type PlatePriority = 'request' | 'prerender'

// ── renderers ──────────────────────────────────────────────────────────────────────────────────────────

export interface PlateRenderer {
  readonly kind: 'worker' | 'inline'
  render(job: PlateJob): Promise<PlateUnit>
  /** Stop: a render under way is abandoned (its promise rejects). */
  close(): void
}

/** Draws in a worker thread started from the bundled source, so the event loop never waits on a frame. */
export class WorkerPlateRenderer implements PlateRenderer {
  readonly kind = 'worker' as const
  private worker: Worker | null = null
  private n = 0
  private readonly pending = new Map<number, { resolve: (unit: PlateUnit) => void; reject: (err: Error) => void }>()
  private idle: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly source: string, private readonly opts: { idleMs?: number } = {}) {}

  render(job: PlateJob): Promise<PlateUnit> {
    const worker = this.ensure()
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    const n = ++this.n
    return new Promise((resolve, reject) => {
      this.pending.set(n, { resolve, reject })
      worker.postMessage({ n, job })
    })
  }

  /** Whether a worker is running right now (tests, and the log). */
  running(): boolean { return this.worker !== null }

  close(): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    const worker = this.worker
    this.worker = null
    this.failAll(new Error('closed'))
    void worker?.terminate().catch(() => {})
  }

  private ensure(): Worker {
    if (this.worker) return this.worker
    // `execArgv: []`: nothing of the parent's flags (an `--input-type`, a loader) applies to this script.
    // The source is CommonJS (scripts/lib/plateWorker.mjs), which is what `eval` runs.
    const worker = new Worker(this.source, { eval: true, execArgv: [], name: 'harness-plates', resourceLimits: { maxOldGenerationSizeMb: 256 } })
    // Never what keeps harnessd (or a test) alive.
    worker.unref()
    worker.on('message', (message: { n?: number; unit?: PlateUnit; error?: string }) => {
      const waiting = typeof message?.n === 'number' ? this.pending.get(message.n) : undefined
      if (!waiting) return
      this.pending.delete(message.n!)
      if (message.unit) waiting.resolve(message.unit)
      else waiting.reject(new Error(message.error ?? 'no plate'))
      if (!this.pending.size) this.armIdle()
    })
    const gone = (err: Error): void => {
      if (this.worker !== worker) return
      this.worker = null
      this.failAll(err)
    }
    worker.on('error', (err) => gone(err instanceof Error ? err : new Error(String(err))))
    worker.on('exit', (code) => gone(new Error(`the plate worker exited (${code})`)))
    this.worker = worker
    return worker
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => { this.idle = null; if (!this.pending.size) this.close() }, this.opts.idleMs ?? PLATE_WORKER_IDLE_MS)
    this.idle.unref?.()
  }

  private failAll(err: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const w of waiting) w.reject(err)
  }
}

/**
 * Draws on the calling thread, one unit at a time after a turn of the event loop. Only where no worker
 * source was built in (`tsx src/cli.ts`, tests): it blocks for as long as a unit takes.
 */
export class InlinePlateRenderer implements PlateRenderer {
  readonly kind = 'inline' as const
  private closed = 0
  async render(job: PlateJob): Promise<PlateUnit> {
    const generation = this.closed
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (generation !== this.closed) throw new Error('closed')
    return renderPlateUnit(job)
  }
  close(): void { this.closed++ }
}

/** Source runs use the development loader inside the worker too: art must never block terminal I/O. */
export function defaultPlateRenderer(): PlateRenderer {
  const source = typeof __PLATE_WORKER__ === 'string' ? __PLATE_WORKER__ : ''
  if (source) return new WorkerPlateRenderer(source)
  const require = createRequire(import.meta.url)
  return new WorkerPlateRenderer(`require(${JSON.stringify(require.resolve('tsx/cjs'))}); require(${JSON.stringify(fileURLToPath(new URL('./plateWorker.ts', import.meta.url)))});`)
}

// ── requests ───────────────────────────────────────────────────────────────────────────────────────────

export interface PlateRequest extends PlateJob { uid: string | null; mood: string }

export interface PlateAnswer {
  uid: string | null
  size: PlateSize
  version: string
  mood: string
  frames: PlateFrame[]
  frameMs: number
}

export type PlateRefusal = { error: string; detail?: string }

class PlateError extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(code) }
}

/** A request's fields, checked; or why not. */
export function parsePlateRequest(payload: Record<string, unknown>): PlateRequest | PlateRefusal {
  const rules = plateRules()
  const bad = (detail: string): PlateRefusal => ({ error: 'BAD_REQUEST', detail })
  if (payload.uid !== undefined && payload.uid !== null && !isUid(payload.uid)) return bad('uid is 1-64 letters, digits, - or _')
  if (!isPairDaemonId(payload.id)) return bad('id is a species id')
  if (!isSeed(payload.seed)) return bad('seed is a whole number from 0 to 4294967295')
  const size = payload.size
  if (size !== 'portrait' && size !== 'reveal') return bad('size is portrait or reveal')
  if (typeof payload.version !== 'string' || !(rules.versions as readonly string[]).includes(payload.version)) return bad(`version is one of ${rules.versions.join(', ')}`)
  if (typeof payload.mood !== 'string' || !(rules.moods as readonly string[]).includes(payload.mood)) return bad(`mood is one of ${rules.moods.join(', ')}`)
  if (!hasPlateModel(payload.id)) return { error: 'NO_ART', detail: `${payload.id} has no model to draw: show its species art.` }
  return { uid: isUid(payload.uid) ? payload.uid : null, id: payload.id, seed: payload.seed, size, version: payload.version, mood: payload.mood }
}

// ── the service ────────────────────────────────────────────────────────────────────────────────────────

export interface PlateServiceDeps {
  /** The cache's folder: `ADAPTER_DATA_DIR/pair/plates`. Created only once something is drawn. */
  dir: string
  renderer?: PlateRenderer
  maxBytes?: number
  maxQueue?: number
  memoryEntries?: number
  /** What the plates are drawn from (PLATE_SOURCE); tests pass their own. */
  source?: string
  now?: () => number
  log?: (line: string) => void
}

interface Entry { source: string; id: string; seed: number; units: Record<string, PlateUnit> }

interface Flight { promise: Promise<PlateUnit>; priority: PlatePriority }

interface Queued { key: string; job: PlateJob; flight: Flight; resolve: (unit: PlateUnit) => void; reject: (err: Error) => void }

export interface PlateStats { renders: number; hits: number; misses: number; evicted: number; waiting: number; drawing: boolean; renderer: 'worker' | 'inline' }

const unitKey = (job: Pick<PlateJob, 'size' | 'version'>): string => `${job.size} ${job.version}`
const fileKey = (job: Pick<PlateJob, 'id' | 'seed'>): string => `${job.id}-${job.seed}`

export class PlateService {
  private on = false
  /** Bumped when daemons go off: work begun before it is not kept. */
  private generation = 0
  private readonly renderer: PlateRenderer
  private readonly source: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly inflight = new Map<string, Flight>()
  private readonly queue: Queued[] = []
  private drawing = false
  private readonly memory = new Map<string, Entry>()
  private readonly loading = new Map<string, Promise<Entry>>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly touched = new Map<string, number>()
  private evicting: Promise<void> | null = null
  private evictAgain = false
  private seen: Set<string> | null = null
  private lastZoo: ZooIndividual[] | null = null
  private counts = { renders: 0, hits: 0, misses: 0, evicted: 0 }

  constructor(private readonly deps: PlateServiceDeps) {
    this.renderer = deps.renderer ?? defaultPlateRenderer()
    this.source = deps.source ?? plateSource()
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(line))
  }

  /** Daemons came on or went off (lib/daemonsSwitch.ts). Off drops everything waiting and stops the worker. */
  setOn(on: boolean): void {
    if (on === this.on) return
    this.on = on
    if (on) {
      this.seen = null
      this.prerenderNew()
      return
    }
    this.generation++
    const waiting = this.queue.splice(0)
    for (const q of waiting) q.reject(new PlateError(DAEMONS_OFF, DAEMONS_OFF_DETAIL))
    this.renderer.close()
    this.inflight.clear()
    this.loading.clear()
    this.memory.clear()
    this.touched.clear()
    this.seen = null
  }

  isOn(): boolean { return this.on }

  stats(): PlateStats {
    return { ...this.counts, waiting: this.queue.length, drawing: this.drawing, renderer: this.renderer.kind }
  }

  /** `daemon_plate_get` / `pair_plate_get`: the answer's fields (the transport adds `requestId`). */
  async get(payload: Record<string, unknown>): Promise<PlateAnswer | PlateRefusal> {
    if (!this.on) return { error: DAEMONS_OFF, detail: DAEMONS_OFF_DETAIL }
    const generation = this.generation
    const req = parsePlateRequest(payload)
    if ('error' in req) return req
    try {
      const unit = await this.unit(req, 'request')
      if (!this.on || generation !== this.generation) throw new PlateError(DAEMONS_OFF, DAEMONS_OFF_DETAIL)
      const frames = unit[req.mood]
      if (!Array.isArray(frames) || !frames.length) return { error: 'RENDER_FAILED', detail: `no ${req.mood} loop was drawn` }
      return { uid: req.uid, size: req.size, version: req.version, mood: req.mood, frames, frameMs: plateRules().plate.frameMs }
    } catch (err) {
      if (err instanceof PlateError) return { error: err.code, ...(err.detail ? { detail: err.detail } : {}) }
      this.log(`[plates] drawing ${fileKey(req)} ${unitKey(req)} failed: ${err instanceof Error ? err.message : String(err)}`)
      return { error: 'RENDER_FAILED' }
    }
  }

  /**
   * The account's zoo was read (`GET /api/zoo`, re-read on `zoo_changed`). A uid not seen before is a
   * hatch: its reveal and portrait at its version are drawn now, behind anything a window asked for.
   */
  observeZoo(zoo: unknown): void {
    this.lastZoo = zooIndividuals(zoo)
    if (this.on) this.prerenderNew()
  }

  /** One unit, from memory, disk or the renderer; everyone asking for it at once shares one. */
  unit(job: PlateJob, priority: PlatePriority): Promise<PlateUnit> {
    if (!this.on) return Promise.reject(new PlateError(DAEMONS_OFF, DAEMONS_OFF_DETAIL))
    const key = `${fileKey(job)}/${unitKey(job)}`
    const flying = this.inflight.get(key)
    if (flying) {
      if (priority === 'request') flying.priority = 'request'
      return flying.promise
    }
    const held = this.memory.get(fileKey(job))?.units[unitKey(job)]
    if (held) {
      this.counts.hits++
      this.remember(fileKey(job))
      this.touch(fileKey(job))
      return Promise.resolve(held)
    }
    const flight: Flight = { priority, promise: Promise.resolve({}) }
    flight.promise = this.fetch(job, key, flight).finally(() => { if (this.inflight.get(key) === flight) this.inflight.delete(key) })
    this.inflight.set(key, flight)
    return flight.promise
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────

  private async fetch(job: PlateJob, key: string, flight: Flight): Promise<PlateUnit> {
    const generation = this.generation
    const entry = await this.load(job)
    if (generation !== this.generation || !this.on) throw new PlateError(DAEMONS_OFF, DAEMONS_OFF_DETAIL)
    const cached = entry.units[unitKey(job)]
    if (cached) {
      this.counts.hits++
      this.touch(fileKey(job))
      return cached
    }
    if (generation !== this.generation || !this.on) throw new PlateError(DAEMONS_OFF, DAEMONS_OFF_DETAIL)
    this.counts.misses++
    const unit = await this.enqueue(job, key, flight)
    if (generation !== this.generation || !this.on) throw new PlateError(DAEMONS_OFF, DAEMONS_OFF_DETAIL)
    await this.persist(job, unit, generation).catch((err) => this.log(`[plates] could not keep ${fileKey(job)}: ${err instanceof Error ? err.message : String(err)}`))
    return unit
  }

  private enqueue(job: PlateJob, key: string, flight: Flight): Promise<PlateUnit> {
    if (this.queue.length >= (this.deps.maxQueue ?? PLATE_MAX_QUEUE)) {
      return Promise.reject(new PlateError('BUSY', 'Too many plates are waiting to be drawn. Ask again in a moment.'))
    }
    return new Promise<PlateUnit>((resolve, reject) => {
      this.queue.push({ key, job, flight, resolve, reject })
      this.pump()
    })
  }

  private pump(): void {
    if (this.drawing || !this.queue.length) return
    // Anything a window or a phone is waiting for goes before a pre-render, oldest first.
    let at = this.queue.findIndex((q) => q.flight.priority === 'request')
    if (at < 0) at = 0
    const [next] = this.queue.splice(at, 1)
    this.drawing = true
    const started = performance.now()
    const generation = this.generation
    Promise.resolve().then(() => this.renderer.render(next.job)).then(
      (unit) => {
        this.counts.renders++
        const seconds = ((performance.now() - started) / 1000).toFixed(1)
        this.log(`[plates] drew ${next.job.id} #${next.job.seed} ${next.job.size} ${next.job.version} in ${seconds}s (${this.renderer.kind}${next.flight.priority === 'prerender' ? ', ahead of time' : ''})`)
        next.resolve(unit)
      },
      (err: unknown) => {
        next.reject(generation !== this.generation ? new PlateError(DAEMONS_OFF, DAEMONS_OFF_DETAIL) : err instanceof Error ? err : new Error(String(err)))
      },
    ).finally(() => {
      this.drawing = false
      this.pump()
    })
  }

  private prerenderNew(): void {
    if (this.lastZoo === null) return
    const first = this.seen === null
    const seen = (this.seen ??= new Set())
    const now = this.now()
    for (const d of this.lastZoo) {
      if (!d.uid || seen.has(d.uid)) continue
      seen.add(d.uid)
      // The first read is a baseline: what hatched before it is drawn when someone asks, unless it is new.
      if (first && !(d.hatched !== null && now >= d.hatched && now - d.hatched < PLATE_RECENT_HATCH_MS)) continue
      if (!hasPlateModel(d.id) || !d.version || !(plateRules().versions as readonly string[]).includes(d.version)) continue
      for (const size of PLATE_SIZES) {
        this.unit({ id: d.id, seed: d.seed, size, version: d.version }, 'prerender').catch(() => {})
      }
    }
  }

  // ── the cache ───────────────────────────────────────────────────────────────────────────────────────

  private folder(): string { return join(this.deps.dir, this.source) }
  private file(key: string): string { return join(this.folder(), `${key}.json.gz`) }

  /** The individual's entry: in memory, else from disk, else empty. One read per individual at a time. */
  private load(job: Pick<PlateJob, 'id' | 'seed'>): Promise<Entry> {
    const key = fileKey(job)
    const held = this.memory.get(key)
    if (held) { this.remember(key); return Promise.resolve(held) }
    const reading = this.loading.get(key)
    if (reading) return reading
    const generation = this.generation
    const read = this.readEntry(job).then((entry) => {
      if (generation !== this.generation || !this.on) return entry
      const again = this.memory.get(key)
      if (again) return again
      this.keep(key, entry)
      return entry
    }).finally(() => { if (this.loading.get(key) === read) this.loading.delete(key) })
    this.loading.set(key, read)
    return read
  }

  private async readEntry(job: Pick<PlateJob, 'id' | 'seed'>): Promise<Entry> {
    const empty: Entry = { source: this.source, id: job.id, seed: job.seed, units: {} }
    try {
      const raw = await readFile(this.file(fileKey(job)))
      const parsed = JSON.parse((await gunzipAsync(raw)).toString('utf8')) as Partial<Entry>
      if (parsed.source !== this.source || parsed.id !== job.id || parsed.seed !== job.seed || !parsed.units || typeof parsed.units !== 'object') return empty
      const units: Record<string, PlateUnit> = {}
      for (const [k, unit] of Object.entries(parsed.units)) if (isUnit(unit)) units[k] = unit
      return { ...empty, units }
    } catch {
      return empty
    }
  }

  /** Add a drawn unit to its individual's file. Writes to one file run one after another. */
  private persist(job: PlateJob, unit: PlateUnit, generation: number): Promise<void> {
    const key = fileKey(job)
    const current = () => this.on && this.generation === generation
    const previous = this.writes.get(key) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(async () => {
      if (!current()) return
      const entry = await this.load(job)
      if (!current()) return
      entry.units[unitKey(job)] = unit
      this.keep(key, entry)
      await mkdir(this.folder(), { recursive: true, mode: 0o700 })
      const body = await gzipAsync(Buffer.from(JSON.stringify(entry)))
      if (!current()) return
      const tmp = `${this.file(key)}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, body, { mode: 0o600 })
      if (!current()) { await unlink(tmp).catch(() => {}); return }
      await rename(tmp, this.file(key)).catch(async (err) => { await unlink(tmp).catch(() => {}); throw err })
      this.touched.set(key, this.now())
    })
    const settled = write.catch(() => {}).finally(() => { if (this.writes.get(key) === settled) this.writes.delete(key) })
    this.writes.set(key, settled)
    return write.then(() => current() ? this.evictSoon() : undefined)
  }

  private keep(key: string, entry: Entry): void {
    this.memory.delete(key)
    this.memory.set(key, entry)
    const max = this.deps.memoryEntries ?? PLATE_MEMORY_ENTRIES
    while (this.memory.size > max) this.memory.delete(this.memory.keys().next().value!)
  }

  private remember(key: string): void {
    const entry = this.memory.get(key)
    if (entry) { this.memory.delete(key); this.memory.set(key, entry) }
  }

  /** A hit: the file becomes the most recently used (at most once a minute per file). */
  private touch(key: string): void {
    const now = this.now()
    if (now - (this.touched.get(key) ?? 0) < TOUCH_MS) return
    this.touched.set(key, now)
    const at = new Date(now)
    void utimes(this.file(key), at, at).catch(() => {})
  }

  private evictSoon(): Promise<void> {
    if (this.evicting) { this.evictAgain = true; return this.evicting }
    this.evicting = this.evict().catch(() => {}).finally(() => {
      this.evicting = null
      if (this.evictAgain) { this.evictAgain = false; void this.evictSoon() }
    })
    return this.evicting
  }

  /** Other sources' folders go; then the least recently used individuals until the cache fits. */
  private async evict(): Promise<void> {
    let names: string[]
    try { names = await readdir(this.deps.dir) } catch { return }
    for (const name of names) {
      if (name !== this.source && /^[0-9a-f]{16,64}$/.test(name)) await rm(join(this.deps.dir, name), { recursive: true, force: true })
    }
    let files: string[]
    try { files = await readdir(this.folder()) } catch { return }
    const sized: Array<{ key: string; size: number; at: number }> = []
    for (const name of files) {
      const path = join(this.folder(), name)
      try {
        const s = await stat(path)
        // A write that never finished (harnessd stopped in the middle), once it is old.
        if (name.endsWith('.tmp')) { if (this.now() - s.mtimeMs > 10 * 60_000) await unlink(path).catch(() => {}); continue }
        if (name.endsWith('.json.gz')) sized.push({ key: name.slice(0, -'.json.gz'.length), size: s.size, at: s.mtimeMs })
      } catch { /* gone meanwhile */ }
    }
    const max = this.deps.maxBytes ?? PLATE_CACHE_MAX_BYTES
    let total = sized.reduce((sum, f) => sum + f.size, 0)
    if (total <= max) return
    sized.sort((a, b) => a.at - b.at)
    for (const f of sized) {
      if (total <= max) break
      await unlink(this.file(f.key)).catch(() => {})
      total -= f.size
      this.memory.delete(f.key)
      this.touched.delete(f.key)
      this.counts.evicted++
    }
  }
}

function isUnit(value: unknown): value is PlateUnit {
  if (!value || typeof value !== 'object') return false
  return Object.values(value).every((frames) => Array.isArray(frames)
    && frames.every((f) => f && typeof (f as PlateFrame).rows === 'string' && typeof (f as PlateFrame).mats === 'string'))
}
