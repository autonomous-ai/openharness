import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { constants, watch, type FSWatcher } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import type { AgentView } from '../../core/api.js'
import type { SessionInputProgress } from '../sessionInput.js'
import { sameProcessIdentity } from '../terminalRuntime.js'
import { boundedJsonBytes } from '../boundedJsonBytes.js'

export const EVIDENCE_CAPTURES = 512
export const EVIDENCE_READS = 4
export const EVIDENCE_BYTES = 16 * 1024 * 1024
export const EVIDENCE_WAIT_MS = 15_000
const IDENTITY_BYTES = 64 * 1024, IDENTITY_TOTAL_BYTES = 4 * 1024 * 1024
const CHUNK = 64 * 1024
type Failure = 'EVIDENCE_UNAVAILABLE' | 'EVIDENCE_BINDING_LOST' | 'EVIDENCE_GAP' | 'EVIDENCE_TOO_LARGE' | 'EVIDENCE_BACKPRESSURE'
type Boundary = { offset: number; device: number; inode: number; digest: string }
type Identity = Pick<AgentView, 'agentId' | 'engine' | 'sessionId' | 'transcriptPath' | 'boundAt' | 'evidenceRevision' |
  'identityHold' | 'interpretationHold' | 'processIdentity' | 'earlierSessionIds'>
interface Capture {
  owner: object
  identity: Identity
  metadataBytes: number
  revision: AgentView['evidenceRevision']
  connection?: object
  deliveries: Set<string>
  boundary?: Boundary
  watch?: FSWatcher
  dirty: boolean
  dispatched: boolean
  retired: boolean
  actual?: Promise<void>
  pending?: Promise<void>
  uncertainHandle?: FileHandle
  kick(): void
}

/** One physical budget for every component construction in the same devices process. A retired
 * capture stays here until its actual file operation, including close, has settled. */
export class DeviceEvidencePool {
  readonly captures = new Set<Capture>()
  active = 0
  bytes = 0
  deliveries = 0
  metadataBytes = 0
  reserve(bytes: number): (() => void) | null {
    if (bytes > EVIDENCE_BYTES || this.bytes + bytes > EVIDENCE_BYTES) return null
    this.bytes += bytes
    return () => { this.bytes -= bytes }
  }
  settled(capture: Capture): void {
    this.active--
    capture.actual = undefined
    if (capture.retired) this.remove(capture)
    // The bounded capture records are the work queue; notifications add no promises or records.
    for (const held of this.captures) held.kick()
  }
  remove(capture: Capture): void {
    if (this.captures.delete(capture)) this.metadataBytes -= capture.metadataBytes
  }
}

export interface DeviceEvidenceOptions {
  pool: DeviceEvidencePool
  resolve(agentId: string): Promise<AgentView | null>
  observe(agentId: string, sessionId: string, engine: string, line: string): void
  gap(agentId: string, code: Failure): void
  needed(agentId: string, sessionId: string, engine: string): boolean
  failed(code: Failure | 'EVIDENCE_DRAIN_PENDING' | 'EVIDENCE_CLOSE_FAILED'): void
}

const selected = (agent: AgentView): { identity: Identity; bytes: number } => {
  const history = agent.earlierSessionIds ?? []
  if (!Array.isArray(history) || history.length > 32 || history.some(id => typeof id !== 'string' || id.length > 256)) throw failure('EVIDENCE_BACKPRESSURE')
  const process = agent.processIdentity
  const identity: Identity = { agentId: agent.agentId, engine: agent.engine, sessionId: agent.sessionId,
    transcriptPath: agent.transcriptPath, boundAt: agent.boundAt, evidenceRevision: agent.evidenceRevision,
    identityHold: agent.identityHold, interpretationHold: agent.interpretationHold,
    processIdentity: process ? { pid: process.pid, executable: process.executable, startMarker: process.startMarker, startTicks: process.startTicks } : null,
    earlierSessionIds: history }
  const bytes = boundedJsonBytes(identity, IDENTITY_BYTES)
  if (bytes === null) throw failure('EVIDENCE_BACKPRESSURE')
  return { identity, bytes }
}
const copy = (identity: Identity): Identity => ({ ...identity,
  processIdentity: identity.processIdentity ? { ...identity.processIdentity } : null,
  earlierSessionIds: [...identity.earlierSessionIds ?? []] })
const binding = (agent: Identity): string => JSON.stringify([agent.agentId, agent.engine, agent.sessionId,
  agent.transcriptPath, agent.boundAt, agent.identityHold, agent.interpretationHold, agent.earlierSessionIds ?? []])
const usable = (agent: Identity): boolean => !!agent.processIdentity && Number.isSafeInteger(agent.processIdentity.pid)
  && agent.processIdentity.pid > 0 && !!agent.processIdentity.startMarker && !agent.identityHold && !agent.interpretationHold
const failure = (code: Failure): Error => new Error(code)

/** Component-owned evidence only. It never chooses an input target, writes input, or guesses a path. */
export function createDeviceEvidence(options: DeviceEvidenceOptions) {
  const { pool } = options
  const owner = {}
  const agents = new Map<string, Capture>()
  let stopped = false
  let connection: object | null = {}
  const owned = (held: Capture): boolean => !stopped && !held.retired && agents.get(held.identity.agentId) === held
  const current = (held: Capture): boolean => owned(held) && connection !== null && (!held.actual || held.connection === connection)
  const retire = (held: Capture): void => {
    held.retired = true; held.dirty = false
    pool.deliveries -= held.deliveries.size; held.deliveries.clear()
    held.watch?.close(); held.watch = undefined
    if (agents.get(held.identity.agentId) === held) agents.delete(held.identity.agentId)
    if (!held.actual) pool.remove(held)
  }
  const lost = (held: Capture, code: Failure): void => {
    if (!current(held)) return
    retire(held)
    options.failed(code)
    options.gap(held.identity.agentId, code)
  }
  const check = (held: Capture): void => { if (!current(held)) throw failure('EVIDENCE_BINDING_LOST') }
  const authority = async (held: Capture): Promise<Identity> => {
    const latest = await options.resolve(held.identity.agentId)
    check(held)
    if (!latest || latest.active === false || !usable(latest) || latest.agentId !== held.identity.agentId ||
      latest.engine !== held.identity.engine || !sameProcessIdentity(latest.processIdentity, held.identity.processIdentity)) throw failure('EVIDENCE_BINDING_LOST')
    const candidate = selected(latest)
    if (!held.identity.sessionId && latest.sessionId) {
      if (JSON.stringify(candidate.identity.earlierSessionIds) !== JSON.stringify(held.identity.earlierSessionIds)) throw failure('EVIDENCE_BINDING_LOST')
      if (pool.metadataBytes - held.metadataBytes + candidate.bytes > IDENTITY_TOTAL_BYTES) throw failure('EVIDENCE_BACKPRESSURE')
      pool.metadataBytes += candidate.bytes - held.metadataBytes; held.metadataBytes = candidate.bytes
      held.identity = copy(candidate.identity)
      held.revision = undefined
    } else if (binding(candidate.identity) !== binding(held.identity)
      || held.revision !== undefined && latest.evidenceRevision !== held.revision) throw failure('EVIDENCE_BINDING_LOST')
    return copy(candidate.identity)
  }
  const openFile = async (held: Capture): Promise<FileHandle> => {
    if (!held.identity.transcriptPath) throw failure('EVIDENCE_UNAVAILABLE')
    const handle = await open(held.identity.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    return handle
  }
  const closeFile = async (held: Capture, handle: FileHandle | undefined): Promise<void> => {
    if (!handle) return
    try { await handle.close() } catch {
      // A rejected close does not prove descriptor release. Keep the handle itself alive,
      // never retry its possibly-reused number, and require process exit to release custody.
      held.uncertainHandle = handle
      options.failed('EVIDENCE_CLOSE_FAILED')
      throw failure('EVIDENCE_UNAVAILABLE')
    }
  }
  const boundary = async (held: Capture, handle: FileHandle, at: number, expected?: Boundary): Promise<Boundary> => {
    const before = await handle.stat()
    check(held)
    if (!before.isFile() || before.size < at || !Number.isSafeInteger(at) || at < 0) throw failure('EVIDENCE_GAP')
    const length = Math.min(at, 512), scratch = Buffer.alloc(length * 2)
    const first = await handle.read(scratch, 0, length, 0)
    const last = await handle.read(scratch, length, length, at - length)
    const actual = await handle.stat(), path = await lstat(held.identity.transcriptPath!)
    check(held)
    if (first.bytesRead !== length || last.bytesRead !== length || (at && scratch[length * 2 - 1] !== 10)
      || !actual.isFile() || actual.size < at || path.isSymbolicLink() || path.dev !== actual.dev || path.ino !== actual.ino
      || before.dev !== actual.dev || before.ino !== actual.ino) throw failure('EVIDENCE_GAP')
    const found = { offset: at, device: actual.dev, inode: actual.ino, digest: createHash('sha256').update(scratch).digest('hex') }
    if (expected && (found.device !== expected.device || found.inode !== expected.inode || found.digest !== expected.digest)) throw failure('EVIDENCE_GAP')
    return found
  }
  const watchFile = (held: Capture): void => {
    if (held.watch || !held.identity.transcriptPath) return
    held.watch = watch(held.identity.transcriptPath, { persistent: false }, () => { held.dirty = true; held.kick() })
    held.watch.on('error', () => lost(held, 'EVIDENCE_UNAVAILABLE'))
  }
  const capture = async (held: Capture): Promise<void> => {
    if (!held.identity.sessionId) return
    watchFile(held)
    let handle: FileHandle | undefined, release: (() => void) | null = null
    try {
      handle = await openFile(held)
      const stat = await handle.stat()
      check(held)
      if (!stat.isFile()) throw failure('EVIDENCE_GAP')
      let offset = stat.size
      // Preserve the complete unfinished record when input arrives while an engine is appending it.
      if (offset) {
        release = pool.reserve(Math.min(CHUNK, offset))
        if (!release) throw failure('EVIDENCE_BACKPRESSURE')
        const scratch = Buffer.alloc(Math.min(CHUNK, offset))
        let examined = 0
        while (offset) {
          const bytes = Math.min(scratch.length, offset)
          const read = await handle.read(scratch, 0, bytes, offset - bytes)
          check(held)
          if (read.bytesRead !== bytes) throw failure('EVIDENCE_GAP')
          const lf = scratch.lastIndexOf(10, bytes - 1)
          if (lf >= 0) { offset = offset - bytes + lf + 1; break }
          offset -= bytes; examined += bytes
          if (examined >= EVIDENCE_BYTES && offset) throw failure('EVIDENCE_TOO_LARGE')
        }
      }
      held.boundary = await boundary(held, handle, offset)
      await authority(held)
    } finally { try { await closeFile(held, handle) } finally { release?.() } }
  }
  const drain = async (held: Capture): Promise<void> => {
    const proof = await authority(held)
    if (!held.identity.sessionId || !held.identity.transcriptPath) throw failure('EVIDENCE_BINDING_LOST')
    watchFile(held)
    let handle: FileHandle | undefined, release: (() => void) | null = null
    try {
      handle = await openFile(held)
      const start = held.boundary?.offset ?? 0
      const original = await boundary(held, handle, start, held.boundary)
      const end = (await handle.stat()).size, bytes = end - start
      check(held)
      if (bytes < 0) throw failure('EVIDENCE_GAP')
      if (bytes > EVIDENCE_BYTES) throw failure('EVIDENCE_TOO_LARGE')
      release = pool.reserve(bytes)
      if (!release) throw failure('EVIDENCE_BACKPRESSURE')
      const buffer = Buffer.alloc(bytes)
      let digest: string | undefined
      // The old cursor alone cannot detect an in-place rewrite of newly read bytes. Verify the same
      // bounded window again in its existing buffer before allowing any row to become evidence.
      for (let pass = 0; pass < 2; pass++) {
        for (let read = 0; read < bytes;) {
          const count = Math.min(CHUNK, bytes - read)
          const got = await handle.read(buffer, read, count, start + read)
          check(held)
          if (got.bytesRead !== count) throw failure('EVIDENCE_GAP')
          read += count
        }
        const next = createHash('sha256').update(buffer).digest('hex')
        if (digest !== undefined && next !== digest) throw failure('EVIDENCE_GAP')
        digest = next
      }
      await boundary(held, handle, start, original)
      const complete = buffer.lastIndexOf(10) + 1
      if (!isUtf8(buffer.subarray(0, complete))) throw failure('EVIDENCE_GAP')
      const next = await boundary(held, handle, start + complete)
      const latest = await authority(held)
      check(held)
      if (binding(latest) !== binding(proof) || latest.evidenceRevision !== proof.evidenceRevision
        || !sameProcessIdentity(latest.processIdentity, proof.processIdentity)) throw failure('EVIDENCE_BINDING_LOST')
      // A boot's revision is accepted only after the original file boundary and a fresh read agree.
      held.revision = latest.evidenceRevision
      let offset = 0
      while (offset < complete) {
        check(held)
        const lf = buffer.indexOf(10, offset)
        const line = buffer.toString('utf8', offset, lf)
        if (line.trim()) options.observe(held.identity.agentId, held.identity.sessionId, held.identity.engine, line)
        offset = lf + 1
      }
      held.boundary = next
      if (!options.needed(held.identity.agentId, held.identity.sessionId, held.identity.engine)) retire(held)
    } finally { try { await closeFile(held, handle) } finally { release?.() } }
  }
  const drainDirty = async (held: Capture): Promise<void> => {
    // A boundary arriving during a read belongs to this same bounded operation. Its
    // existing deadline covers all passes; no watcher or caller adds another job.
    while (held.dirty && owned(held)) {
      check(held)
      held.dirty = false
      await drain(held)
    }
  }
  const run = (held: Capture, work: () => Promise<void>): Promise<void> => {
    if (held.actual) return held.pending!
    if (pool.active >= EVIDENCE_READS) return Promise.reject(failure('EVIDENCE_BACKPRESSURE'))
    held.connection = connection ?? undefined
    pool.active++
    let done!: () => void, reject!: (error: Error) => void
    const pending = new Promise<void>((resolve, fail) => { done = resolve; reject = fail })
    held.pending = pending
    const deadline = setTimeout(() => {
      lost(held, 'EVIDENCE_UNAVAILABLE')
      reject(failure('EVIDENCE_UNAVAILABLE'))
    }, EVIDENCE_WAIT_MS)
    deadline.unref?.()
    let refused: Error | undefined
    held.actual = Promise.resolve().then(work).catch(error => {
      const code = error instanceof Error && /^EVIDENCE_(UNAVAILABLE|BINDING_LOST|GAP|TOO_LARGE|BACKPRESSURE)$/.test(error.message)
        ? error.message as Failure : 'EVIDENCE_UNAVAILABLE'
      lost(held, code); refused = failure(code)
    }).finally(() => {
      clearTimeout(deadline)
      if (held.uncertainHandle) {
        reject(failure('EVIDENCE_UNAVAILABLE'))
        return new Promise<void>(() => {})
      }
      held.pending = undefined; pool.settled(held)
      if (refused) reject(refused); else done()
    })
    return pending
  }
  const make = (candidate: ReturnType<typeof selected>, deliveryId: string): Capture => {
    if (pool.captures.size >= EVIDENCE_CAPTURES || pool.deliveries >= EVIDENCE_CAPTURES) throw failure('EVIDENCE_BACKPRESSURE')
    if (pool.metadataBytes + candidate.bytes > IDENTITY_TOTAL_BYTES) throw failure('EVIDENCE_BACKPRESSURE')
    const held: Capture = { owner, identity: copy(candidate.identity), metadataBytes: candidate.bytes, revision: candidate.identity.evidenceRevision,
      deliveries: new Set([deliveryId]), dirty: false, dispatched: false, retired: false,
      kick: () => {
        if (!owned(held) || !connection || !held.dispatched || !held.dirty || held.actual || pool.active >= EVIDENCE_READS) return
        void run(held, () => drainDirty(held)).catch(() => {})
      } }
    agents.set(candidate.identity.agentId, held); pool.captures.add(held); pool.deliveries++; pool.metadataBytes += held.metadataBytes
    return held
  }
  return {
    async arm(agent: AgentView, deliveryId: string): Promise<void> {
      if (agent.engine !== 'claude' && agent.engine !== 'codex') return
      if (stopped || !connection || agent.active === false || !usable(agent)) throw failure('EVIDENCE_BINDING_LOST')
      let candidate: ReturnType<typeof selected>
      try { candidate = selected(agent) } catch (error) { options.failed('EVIDENCE_BACKPRESSURE'); throw error }
      const old = agents.get(agent.agentId)
      if (old) {
        if (binding(old.identity) !== binding(candidate.identity) || old.revision !== agent.evidenceRevision
          || !sameProcessIdentity(old.identity.processIdentity, agent.processIdentity)) throw failure('EVIDENCE_BINDING_LOST')
        if (old.deliveries.has(deliveryId)) return
        if (pool.deliveries >= EVIDENCE_CAPTURES) { options.failed('EVIDENCE_BACKPRESSURE'); throw failure('EVIDENCE_BACKPRESSURE') }
        if (old.pending) await old.pending
        check(old); old.deliveries.add(deliveryId); pool.deliveries++
        return
      }
      let held: Capture
      try { held = make(candidate, deliveryId) }
      catch (error) { options.failed('EVIDENCE_BACKPRESSURE'); throw error }
      try { await run(held, () => capture(held)) } catch (error) { retire(held); throw error }
    },
    input(event: SessionInputProgress): void {
      const held = agents.get(event.agentId)
      if (!held || event.phase !== 'dispatching' || !event.deliveryId || !held.deliveries.has(event.deliveryId)) return
      held.deliveries.delete(event.deliveryId); pool.deliveries--
      if (held.identity.sessionId && event.sessionId && held.identity.sessionId !== event.sessionId) { lost(held, 'EVIDENCE_BINDING_LOST'); return }
      held.dispatched = true; held.dirty = true; held.kick()
    },
    async flush(agentId: string): Promise<void> {
      const held = agents.get(agentId)
      const generation = connection
      if (!held || !held.dispatched || !generation) return
      held.dirty = true
      try {
        if (held.pending) {
          const previous = held.connection
          try { await held.pending } catch (error) { if (previous === generation) throw error }
        }
        if (connection !== generation || !owned(held)) return
        // Settling an old connection can immediately start this connection's dirty
        // read. Its pending promise, rather than the old one, owns this boundary.
        if (held.pending) await held.pending
        else if (held.dirty) await run(held, () => drainDirty(held))
      } catch { if (connection === generation) lost(held, 'EVIDENCE_BACKPRESSURE') }
    },
    changed(agentId: string): void { const held = agents.get(agentId); if (held) { held.dirty = true; held.kick() } },
    forget(agentId: string): void { const held = agents.get(agentId); if (held) retire(held) },
    settled(agentId: string, deliveryId: string): void {
      const held = agents.get(agentId)
      if (!held) return
      if (held.deliveries.delete(deliveryId)) pool.deliveries--
      if (!held.deliveries.size && !options.needed(agentId, held.identity.sessionId, held.identity.engine)) retire(held)
    },
    disconnected(): void {
      connection = null
      for (const held of agents.values()) {
        held.watch?.close(); held.watch = undefined
        held.revision = undefined; held.dirty = true
        pool.deliveries -= held.deliveries.size; held.deliveries.clear()
        if (!held.dispatched) retire(held)
      }
    },
    connected(): void {
      if (stopped || connection) return
      connection = {}
      for (const held of agents.values()) held.kick()
    },
    async stop(): Promise<void> {
      stopped = true
      const outstanding: Promise<void>[] = []
      for (const held of pool.captures) if (held.owner === owner) { retire(held); if (held.actual) outstanding.push(held.actual) }
      if (!outstanding.length) return
      let deadline: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.all(outstanding), new Promise<void>(resolve => {
        deadline = setTimeout(() => { options.failed('EVIDENCE_DRAIN_PENDING'); resolve() }, 2_000)
        deadline.unref?.()
      })])
      clearTimeout(deadline)
    },
  }
}
export type DeviceEvidenceReader = ReturnType<typeof createDeviceEvidence>
