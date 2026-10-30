import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { CoreApi } from '../core/api.js'
import { builtinSqlite } from '../lib/sqliteBuiltin.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from '../lib/secureState.js'
import { creationObservation, type CreationObservation } from '../lib/creationObservation.js'
import { readMachineResources } from '../lib/machineResources.js'
import { createHarnessResourcesReader } from '../lib/harnessResources.js'
import { readCapacityDisk } from './disk.js'
import { gibibytes, memoryShort } from './capacity.js'
import { object } from './wire.js'

type Json = Record<string, unknown>
interface Statement {
  all(...args: unknown[]): Json[]
  get(...args: unknown[]): Json | undefined
  run(...args: unknown[]): unknown
}
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
type DatabaseConstructor = new (path: string) => Database
interface Reservation {
  creation_id: string; fingerprint: string; memory_bytes: number; disk_bytes: number
  volume: string; harness_id: string | null; released: number; created_at: number
}
export interface ReservationBook {
  reserve(input: Json, closed?: AbortSignal): Promise<Json>
  observe(creationId: unknown, closed?: AbortSignal): Promise<Json>
  creationOf(harnessId: string): string | null
  stop(): void
}
interface Dependencies {
  resources: typeof readMachineResources
  disk: typeof readCapacityDisk
  sqlite: () => DatabaseConstructor | null
  now?: () => number
  /** Each live agent's measured memory, by harness id. */
  agentMemory?: () => Promise<Map<string, number>>
}
const MAX_ACTIVE = 256
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MARKER = 'super-tab-capacity-v1\n'
const creationIdValid = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(v)
const bytes = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const unavailable = (detail: string): Json => ({ error: 'CAPACITY_UNAVAILABLE', detail })
/** How long a launched agent's reservation still counts. Free memory (vm_stat) already counts what a running agent uses,
 *  so a reservation held past its start counted the agent twice: on Ken's MacBook Pro (2026-10-28) three settled builders
 *  using about 0.4 GiB held 6 GiB, and a start was refused with 7.85 GiB free. The window covers an agent still loading. */
export const START_WINDOW_MS = 5 * 60_000
const memoryOf = (core: CoreApi) => {
  const read = createHarnessResourcesReader(() => core.agents.live())
  return async () => new Map((await read()).agents.flatMap(row => row.memoryBytes === null ? [] : [[row.agentId, row.memoryBytes] as const]))
}

/** All Super Tabs on this host share one ledger. SQLite serializes admission
 * across service restarts/overlap; no asynchronous work runs inside its write
 * transaction. Unknown native outcomes keep their budget, without a timeout. */
export class CapacityReservations implements ReservationBook {
  private readonly db: Database
  private readonly file: string
  private readonly identity: { dev: number; ino: number }
  private stopped = false
  private readonly now: () => number
  private readonly agentMemory: () => Promise<Map<string, number>>

  constructor(private readonly core: CoreApi, private readonly machineId: string,
    private readonly deps: Dependencies = { resources: readMachineResources, disk: readCapacityDisk,
      sqlite: () => builtinSqlite() as unknown as DatabaseConstructor | null }) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(machineId)) throw new Error('The execution host has no confirmed machine identity.')
    const Database = deps.sqlite()
    if (!Database) throw new Error('Update the Harness CLI runtime on this machine to reserve capacity for Super Tab agents.')
    secureStateDirectory(core.dataDir)
    const directory = join(core.dataDir, 'super-tabs')
    secureStateDirectory(directory)
    this.file = join(directory, 'capacity.sqlite')
    const marker = `${this.file}.ready`
    const initialized = existsSync(marker)
    if (initialized && readPrivateStateFile(marker, 128) !== MARKER) throw new Error('The capacity ledger marker is unreadable.')
    if (!hardenPrivateStateFileIfPresent(this.file, MAX_FILE_BYTES)) {
      if (initialized) throw new Error('The capacity ledger is missing. Restore it before starting more agents.')
      try {
        const fd = openSync(this.file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try { fsyncSync(fd) } finally { closeSync(fd) }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      hardenPrivateStateFileIfPresent(this.file, MAX_FILE_BYTES)
    }
    this.now = deps.now ?? Date.now
    this.agentMemory = deps.agentMemory ?? memoryOf(core)
    this.identity = lstatSync(this.file)
    this.db = new Database(this.file)
    try {
      this.db.exec('PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;')
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get()?.user_version
        if (version === 0 && !initialized) {
          if (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").get()) throw new Error('Unrecognized capacity ledger.')
          this.db.exec(`CREATE TABLE reservations (
            creation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
            memory_bytes INTEGER NOT NULL CHECK(memory_bytes >= 0), disk_bytes INTEGER NOT NULL CHECK(disk_bytes >= 0),
            volume TEXT NOT NULL, harness_id TEXT, released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0, 1)),
            created_at INTEGER NOT NULL
          ); PRAGMA user_version = 1;`)
        } else if (version !== 1) throw new Error('The capacity ledger version is unavailable. Restore it or update Harness.')
        this.rows()
      })
      if (!initialized) {
        try { writeFileSync(marker, MARKER, { flag: 'wx', mode: 0o600, flush: true }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        if (readPrivateStateFile(marker, 128) !== MARKER) throw new Error('The capacity ledger marker is unreadable.')
      }
    } catch (error) { this.db.close(); throw error }
  }

  stop(): void { if (!this.stopped) { this.stopped = true; this.db.close() } }

  private check(closed?: AbortSignal): void {
    if (this.stopped || closed?.aborted || this.core.daemon.machineId() !== this.machineId) throw new Error('The execution host disconnected. Resume this start after reconnecting.')
    const current = lstatSync(this.file)
    if (!current.isFile() || current.dev !== this.identity.dev || current.ino !== this.identity.ino || current.size > MAX_FILE_BYTES) {
      throw new Error('The capacity ledger changed on disk. Restore it before starting more agents.')
    }
  }

  private transaction<T>(work: () => T, closed?: AbortSignal): T {
    this.check(closed)
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = work(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private rows(): Reservation[] {
    const rows = this.db.prepare('SELECT * FROM reservations WHERE released = 0 LIMIT ?').all(MAX_ACTIVE + 1)
    if (rows.length > MAX_ACTIVE || rows.some(row => !creationIdValid(row.creation_id)
      || typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint)
      || !bytes(row.memory_bytes) || !bytes(row.disk_bytes) || typeof row.volume !== 'string'
      || (row.harness_id !== null && (typeof row.harness_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(row.harness_id))))) {
      throw new Error('The capacity ledger is unreadable. Restore it before starting more agents.')
    }
    return rows as unknown as Reservation[]
  }

  private async native(id: string): Promise<CreationObservation | null> {
    return creationObservation(id, await this.core.agents.creationStatus?.(id).catch(() => null))
  }

  private async reconcile(rows: Reservation[], closed?: AbortSignal): Promise<void> {
    for (let index = 0; index < rows.length; index += 8) {
      const observations = await Promise.all(rows.slice(index, index + 8).map(async row => {
        const observation = await this.native(row.creation_id)
        const harnessId = observation?.state === 'created' ? observation.agentId : row.harness_id
        if (row.harness_id && harnessId !== row.harness_id) throw new Error('The native creation identity changed. Inspect this machine before starting more agents.')
        // A stopped agent keeps its record; one the person closed by hand does not, and neither is running.
        const released = observation?.state === 'failed' || observation?.state === 'cancelled'
          || (!!harnessId && await this.core.agents.stopped?.(harnessId).catch(() => false) === true)
          || (observation?.state === 'created' && await this.core.agents.gone?.(harnessId!).catch(() => false) === true)
        return { row, harnessId, released }
      }))
      this.transaction(() => {
        for (const { row, harnessId, released } of observations) {
          // A later reconciliation may already have learned the native ID.
          // Missing/unavailable observations never erase that durable identity.
          this.db.prepare(`UPDATE reservations SET harness_id = COALESCE(harness_id, ?), released = ?
            WHERE creation_id = ? AND fingerprint = ? AND released = 0`).run(harnessId, released ? 1 : 0, row.creation_id, row.fingerprint)
        }
      }, closed)
    }
  }

  /** Whether a reservation is still in its start window: until its agent launched, then START_WINDOW_MS. A launched agent
   *  the core no longer lists is timed from its reservation. */
  private starting(row: Reservation, now: number): boolean {
    if (!row.harness_id) return true
    const started = this.core.agents.byAgent(row.harness_id)?.registeredAt
    return now - (finite(started) ? started : row.created_at) < START_WINDOW_MS
  }

  /** What a reservation still holds of memory: all of it in its start window, unless the agent already measures as much itself. */
  private held(row: Reservation, measured: Map<string, number> | null, now: number): number {
    if (!this.starting(row, now)) return 0
    return row.harness_id && (measured?.get(row.harness_id) ?? 0) >= row.memory_bytes ? 0 : row.memory_bytes
  }

  async observe(creationId: unknown, closed?: AbortSignal): Promise<Json> {
    if (!creationIdValid(creationId)) return { error: 'INVALID_REQUEST' }
    this.check(closed)
    const rows = this.rows().filter(row => row.creation_id === creationId)
    await this.reconcile(rows, closed)
    this.check(closed)
    const row = this.db.prepare('SELECT harness_id, released FROM reservations WHERE creation_id = ?').get(creationId)
    return row ? { ok: true, reservationId: creationId, harnessId: row.harness_id, released: row.released === 1 }
      : { error: 'CAPACITY_RECEIPT_MISSING', detail: 'This start has no capacity receipt. Inspect the machine before starting another agent.' }
  }

  /** The Swarm start that created this harness: every start confirms the harness its native receipt names before it
   *  reports success, and a stopped one keeps its row. The core still checks the receipt itself. */
  creationOf(harnessId: string): string | null {
    this.check()
    const row = this.db.prepare('SELECT creation_id FROM reservations WHERE harness_id = ? ORDER BY created_at DESC LIMIT 1').get(harnessId)
    return typeof row?.creation_id === 'string' ? row.creation_id : null
  }

  async reserve(input: Json, closed?: AbortSignal): Promise<Json> {
    const { creationId, cwd } = input, request = object(input.requirements)
    const memory = request.memoryBytes ?? 0, disk = request.diskBytes ?? 0, cpu = request.maxCpuPercent ?? 100
    if (!creationIdValid(creationId) || typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd)
      || (input.worktree !== undefined && typeof input.worktree !== 'boolean') || !bytes(memory) || !bytes(disk)
      || !finite(cpu) || cpu < 0 || cpu > 100) return { error: 'INVALID_REQUEST', detail: 'Use a native creation ID, absolute project path and nonnegative resource requirements.' }
    const fingerprint = createHash('sha256').update(JSON.stringify([cwd, input.worktree === true, memory, disk, cpu])).digest('hex')
    this.check(closed)
    const prior = this.db.prepare('SELECT fingerprint FROM reservations WHERE creation_id = ?').get(creationId)
    if (prior && prior.fingerprint !== fingerprint) return { error: 'CAPACITY_RECEIPT_CONFLICT', detail: 'This start already reserved different resources. Keep its original settings.' }
    await this.reconcile(this.rows(), closed)
    this.check(closed)
    const existing = this.db.prepare('SELECT released, volume FROM reservations WHERE creation_id = ?').get(creationId)
    if (existing?.released === 1) return { error: 'START_FINISHED', detail: 'This native start has ended. Create a new start request.' }
    const [native, resources, destination, measured] = await Promise.all([
      this.native(creationId), this.deps.resources().catch(() => null), this.deps.disk(cwd, input.worktree === true).catch(() => null),
      memory > 0 ? this.agentMemory().catch(() => null) : null,
    ])
    this.check(closed)
    if (!destination || !bytes(destination.freeBytes) || !destination.volume) return unavailable('The destination disk capacity could not be verified.')
    if (existing) {
      if (existing.volume !== destination.volume) return unavailable('The destination filesystem changed after this start reserved capacity. Inspect the machine before retrying this start.')
      // Re-read under the same lock as new admissions: another request may have
      // recorded a stop while this one was sampling the destination.
      return this.transaction(() => this.db.prepare('SELECT released FROM reservations WHERE creation_id = ?').get(creationId)?.released === 0
        ? { ok: true, reservationId: creationId }
        : { error: 'START_FINISHED', detail: 'This native start has ended. Create a new start request.' }, closed)
    }
    if (native?.state !== 'missing') return unavailable('The machine could not confirm that this start is new. Resume its existing receipt before starting another agent.')
    const freeMemory = bytes(resources?.memoryTotalBytes) && bytes(resources?.memoryUsedBytes) && resources.memoryUsedBytes <= resources.memoryTotalBytes
      ? resources.memoryTotalBytes - resources.memoryUsedBytes : null
    if (resources?.memoryPressure === 'critical') return unavailable('The machine reports critical memory pressure.')
    if ((!finite(resources?.cpuPercent) && cpu < 100) || (finite(resources?.cpuPercent) && resources.cpuPercent > cpu)) return unavailable('The machine does not have the requested CPU headroom.')
    return this.transaction(() => {
      const duplicate = this.db.prepare('SELECT fingerprint, released, volume FROM reservations WHERE creation_id = ?').get(creationId)
      if (duplicate) return duplicate.fingerprint === fingerprint && duplicate.released === 0 && duplicate.volume === destination.volume ? { ok: true, reservationId: creationId }
        : { error: 'CAPACITY_RECEIPT_CONFLICT', detail: 'This native start already has a different or finished capacity reservation.' }
      const active = this.rows()
      if (active.length >= MAX_ACTIVE) return unavailable('Reconcile pending starts on this machine before starting more agents.')
      const now = this.now(), memoryHeld = active.reduce((sum, row) => sum + this.held(row, measured, now), 0)
      // Free disk is measured too, so it already counts a settled agent's worktree. On Diego's Mac (2026-10-28) 15 settled
      // agents held 150 GiB against 140 GiB free and every start was refused; only starts still in their window hold disk.
      const diskHeld = active.filter(row => row.volume === destination.volume && this.starting(row, now)).reduce((sum, row) => sum + row.disk_bytes, 0)
      if (memory > 0 && !finite(freeMemory)) return unavailable('The free memory on this machine could not be read.')
      if (memory > 0 && memory > freeMemory! - memoryHeld) return unavailable(memoryShort(freeMemory! - memoryHeld, memory)
        + (memoryHeld > 0 ? ` ${gibibytes(memoryHeld)} more is set aside for agents still starting.` : ''))
      if (disk > destination.freeBytes - diskHeld) return unavailable('Destination disk space is already in use or reserved for other agents. Choose another machine or free space before retrying.')
      this.db.prepare(`INSERT INTO reservations (creation_id, fingerprint, memory_bytes, disk_bytes, volume, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(creationId, fingerprint, memory, disk, destination.volume, now)
      return { ok: true, reservationId: creationId }
    }, closed)
  }
}
