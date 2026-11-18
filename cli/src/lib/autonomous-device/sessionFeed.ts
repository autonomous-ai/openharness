import { randomUUID } from 'node:crypto'
import { AgentClientError, connectSocket, type ClientSocket, type Connect, type Where } from '../../agentClient/daemon.js'
import { SESSION_EVENT_BYTES, SESSION_EVENT_FRAMES, type SessionEventBatch } from '../sessionEvents.js'

import { devicePeerBudget } from './peerProtocol.js'
import { DESK_WAIT_MS, deskStroke, type DeskPhase } from './deskProtocol.js'

const WRITE_BYTES = 64 * 1024
const WAIT_MS = 15_000
type Frame = Record<string, unknown> & { type: string; payload: Record<string, unknown> }
type Barrier = { at: number; resolve(): void; reject(error: Error): void; release(): void }
type Job = { agentId: string; frames: Frame[]; releases: Array<() => void>; at: number; batch?: SessionEventBatch; barrier?: Barrier; source?: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128

/** Actual retained frame/handler ownership survives a replaced component or connection. */
export class DeviceFeedPool {
  readonly outgoing = devicePeerBudget(WRITE_BYTES, 256)
  bytes = 0
  frames = 0
  active = 0
  barriers = 0
  reserve(bytes: number): (() => void) | null {
    if (this.bytes + bytes > SESSION_EVENT_BYTES || this.frames >= SESSION_EVENT_FRAMES) return null
    this.bytes += bytes; this.frames++
    let held = true
    return () => { if (held) { held = false; this.bytes -= bytes; this.frames-- } }
  }
}
export interface DeviceSessionFeedOptions {
  pool: DeviceFeedPool
  receive(agentId: string, frames: readonly Frame[], current: () => boolean, source?: string): Promise<void>
  unavailable(code: string): void
}

/** One ordinary owner-tool connection; it owns the only component assembly/FIFO for this feed. */
export function observeDeviceSessions(where: Where, options: DeviceSessionFeedOptions, connect: Connect = connectSocket) {
  const { pool } = options, requestId = randomUUID()
  let socket: ClientSocket | undefined, closed = false, selected = false, generation: string | undefined
  let resolve!: () => void, reject!: (error: Error) => void
  const ready = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  const partial = new Map<number, Job>(), queued: Job[] = []
  const barriers = new Map<string, Barrier>()
  const writes = new Set<{ at: number; release(): void }>()
  let deskSupported = false
  let probe: { requestId: string; promise: Promise<boolean>; settle(ok: boolean): void } | undefined
  let active: { job: Job; actual: Promise<void> } | undefined
  let drainDeadline: ReturnType<typeof setTimeout> | undefined
  const release = (job: Job): void => { for (const done of job.releases) done(); job.releases.length = 0 }
  const current = (): boolean => !closed
  const fail = (code: string, notify = true): void => {
    if (closed) return
    closed = true
    deskSupported = false; probe?.settle(false)
    clearTimeout(handshake); clearTimeout(drainDeadline)
    for (const job of partial.values()) release(job)
    partial.clear()
    for (const job of queued.splice(0)) { release(job); job.barrier?.reject(new Error(code)) }
    for (const held of barriers.values()) held.reject(new Error(code))
    if (!generation) reject(new AgentClientError(code, 'Session observation is unavailable.'))
    socket?.close()
    if (notify) options.unavailable(code)
  }
  const deadline = (): void => {
    if (closed) return
    if (!active && !queued.length && !partial.size && !barriers.size && !writes.size) {
      clearTimeout(drainDeadline); drainDeadline = undefined; return
    }
    // An enclosing batch can finish behind a newer nested batch. Keep the earliest
    // timer while work moves between owners; scan the bounded FIFO only when it fires.
    if (drainDeadline) return
    let earliest = active?.job.at ?? Infinity
    for (const job of queued) earliest = Math.min(earliest, job.at)
    for (const job of partial.values()) earliest = Math.min(earliest, job.at)
    for (const held of barriers.values()) earliest = Math.min(earliest, held.at)
    for (const held of writes) earliest = Math.min(earliest, held.at)
    const remaining = earliest + WAIT_MS - Date.now()
    if (remaining <= 0) { fail('SESSION_EVENTS_DRAIN_TIMEOUT'); return }
    drainDeadline = setTimeout(() => { drainDeadline = undefined; deadline() }, remaining)
    drainDeadline.unref?.()
  }
  /** Credit follows actual transport settlement, including a logically revoked socket. */
  const sendDesk = (type: string, payload: Record<string, unknown>): boolean => {
    // Both callers enter synchronously from this feed's current acknowledged generation.
    const connected = socket!
    const buffered = connected.bufferedAmount
    if (!Number.isSafeInteger(buffered) || buffered! < 0) { console.warn('[wifi] DESK_TRANSPORT_UNSUPPORTED'); return false }
    const wire = JSON.stringify({ type, payload }), bytes = Buffer.byteLength(wire)
    if (bytes > 1024 || buffered! > WRITE_BYTES - bytes) { console.warn('[wifi] DESK_BACKPRESSURE'); return false }
    const credit = pool.outgoing.reserve(bytes)
    if (!credit) { console.warn('[wifi] DESK_BACKPRESSURE'); return false }
    const held = { at: Date.now(), release: () => { credit(); writes.delete(held); deadline() } }
    writes.add(held)
    try { connected.send(wire, error => { held.release(); if (error) fail('DESK_WRITE_UNAVAILABLE') }) }
    catch { fail('DESK_WRITE_UNAVAILABLE'); return false }
    deadline()
    return !closed
  }
  const drain = (): void => {
    if (closed || active || !queued.length) return
    while (queued[0]?.barrier) {
      const job = queued.shift()!
      release(job); job.barrier!.resolve()
    }
    if (!queued.length) { deadline(); return }
    if (pool.active >= 4) { fail('SESSION_EVENTS_BACKPRESSURE'); return }
    const job = queued.shift()!
    pool.active++
    const owned = { job, actual: Promise.resolve() }
    active = owned
    owned.actual = Promise.resolve().then(async () => {
      if (current() && !job.batch?.replay) await options.receive(job.agentId, job.frames, current, job.source)
    }).catch(() => fail('SESSION_EVENTS_UNAVAILABLE')).finally(() => {
      release(job); pool.active--; active = undefined
      drain(); deadline()
    })
    deadline()
  }
  const accept = (payload: Record<string, unknown>, bytes: number): void => {
    if (!generation || payload.generation !== generation) return
    const frame = payload.frame
    if (!record(frame) || typeof frame.type !== 'string' || !record(frame.payload)) { fail('SESSION_EVENTS_PROTOCOL'); return }
    const agentId = frame.agentId ?? frame.payload.agentId ?? (record(frame.payload.agent) ? frame.payload.agent.id : undefined)
    if (!id(agentId)) { fail('SESSION_EVENTS_PROTOCOL'); return }
    const batch = payload.batch
    if (payload.source !== undefined && !id(payload.source)) { fail('SESSION_EVENTS_PROTOCOL'); return }
    const source = payload.source as string | undefined
    if (batch !== undefined && (!record(batch) || !Number.isSafeInteger(batch.id) || Number(batch.id) <= 0
      || !Number.isSafeInteger(batch.count) || Number(batch.count) < 1 || Number(batch.count) > SESSION_EVENT_FRAMES
      || !Number.isSafeInteger(batch.index) || Number(batch.index) < 0 || Number(batch.index) >= Number(batch.count)
      || batch.replay !== undefined && batch.replay !== true)) { fail('SESSION_EVENTS_PROTOCOL'); return }
    const release = pool.reserve(bytes)
    if (!release) { fail('SESSION_EVENTS_BACKPRESSURE'); return }
    let job: Job
    if (batch !== undefined) {
      const b = batch as unknown as SessionEventBatch, previous = partial.get(b.id)
      if (previous ? previous.agentId !== agentId || previous.source !== source || previous.batch!.count !== b.count || previous.batch!.replay !== b.replay || previous.frames.length !== b.index
        : b.index !== 0) { release(); fail('SESSION_EVENTS_GAP'); return }
      job = previous ?? { agentId, frames: [], releases: [], at: Date.now(), batch: { ...b }, source }
      job.frames.push(frame as Frame); job.releases.push(release)
      if (job.frames.length < b.count) partial.set(b.id, job)
      else { partial.delete(b.id); queued.push(job) }
    } else {
      if (frame.type !== 'agent_synced' && frame.type !== 'agent_deleted' && frame.type !== 'agent_activity' && frame.type !== 'commander_event') { release(); fail('SESSION_EVENTS_PROTOCOL'); return }
      job = { agentId, frames: [frame as Frame], releases: [release], at: Date.now(), source }
      queued.push(job)
    }
    drain(); deadline()
  }
  const handshake = setTimeout(() => fail('SESSION_EVENTS_TIMEOUT'), WAIT_MS)
  handshake.unref?.()
  void (async () => {
    try {
      const connected = await connect(where)
      if (closed) { connected.close(); return }
      socket = connected
      connected.on('open', () => { if (!closed) connected.send(JSON.stringify({ type: 'machine_select', payload: {
        machineId: where.machineId, localProtocolVersion: 1, tool: true, eventsProtocol: 1, questionProtocol: 1,
      } })) })
      connected.on('error', () => fail('SESSION_EVENTS_UNAVAILABLE'))
      connected.on('close', code => {
        fail(code === 1013 ? 'SESSION_EVENTS_BACKPRESSURE' : 'SESSION_EVENTS_UNAVAILABLE')
        for (const held of barriers.values()) held.release()
        barriers.clear()
        for (const held of writes) held.release()
      })
      connected.on('message', (raw, binary) => {
        if (closed && !barriers.size) return
        if (binary) { fail('SESSION_EVENTS_PROTOCOL'); return }
        if (Buffer.isBuffer(raw) && raw.length > SESSION_EVENT_BYTES) { fail('SESSION_EVENTS_TOO_LARGE'); return }
        const text = raw.toString(), bytes = Buffer.byteLength(text)
        if (bytes > SESSION_EVENT_BYTES) { fail('SESSION_EVENTS_TOO_LARGE'); return }
        try {
          const frame: unknown = JSON.parse(text)
          if (!record(frame) || typeof frame.type !== 'string' || !record(frame.payload)) { fail('SESSION_EVENTS_PROTOCOL'); return }
          const payload = frame.payload
          if (probe && payload.requestId === probe.requestId) {
            probe.settle(frame.type === 'harness_device_step_result' && payload.protocol === 1 && payload.machineId === where.machineId
              && Object.keys(payload).every(key => key === 'requestId' || key === 'protocol' || key === 'machineId'))
          } else if (frame.type === 'agent_recent_result' && typeof payload.requestId === 'string') {
            const held = barriers.get(payload.requestId)
            if (!held) return
            barriers.delete(payload.requestId)
            if (closed) { held.release(); return }
            if (partial.size || typeof payload.error === 'string') {
              held.release(); held.reject(new Error('SESSION_EVENTS_GAP')); fail('SESSION_EVENTS_GAP'); return
            }
            queued.push({ agentId: '', frames: [], releases: [held.release], at: held.at, barrier: held })
            drain(); deadline()
          } else if (closed) return
          else if (!selected && frame.type === 'connected') {
            if (!where.machineId || where.machineId.length > 200 || payload.machineId !== where.machineId || payload.transport !== 'local' || payload.localProtocolVersion !== 1) { fail('SESSION_EVENTS_PROTOCOL'); return }
            if (payload.eventsProtocol !== 1) { fail('SESSION_EVENTS_UNSUPPORTED'); return }
            selected = true
            connected.send(JSON.stringify({ type: 'events_observe', payload: { requestId, scope: 'all' } }))
          } else if (frame.type === 'events_observe_result' && payload.requestId === requestId) {
            if (generation || payload.ok !== true || !id(payload.generation)) { fail('SESSION_EVENTS_PROTOCOL'); return }
            generation = payload.generation; clearTimeout(handshake); resolve()
          } else if (frame.type === 'session_event') accept(payload, bytes)
          else if (frame.type === 'machine_select_error' || frame.type === 'frame_too_large') fail('SESSION_EVENTS_UNAVAILABLE')
        } catch { fail('SESSION_EVENTS_PROTOCOL') }
      })
    } catch { fail('SESSION_EVENTS_UNAVAILABLE') }
  })()
  return {
    ready,
    deskReady(): Promise<boolean> {
      if (closed || !generation) return Promise.resolve(false)
      if (deskSupported) return Promise.resolve(true)
      if (probe) return probe.promise
      const requestId = randomUUID()
      let resolve!: (ok: boolean) => void
      const own = { requestId, promise: new Promise<boolean>(done => { resolve = done }), settle: (ok: boolean) => {
        if (probe !== own) return
        clearTimeout(timer); probe = undefined
        deskSupported = ok && !closed
        resolve(deskSupported)
      } }
      const timer = setTimeout(() => own.settle(false), DESK_WAIT_MS)
      timer.unref?.()
      probe = own
      if (!sendDesk('harness_device_step', { machineId: where.machineId, requestId, probe: true })) own.settle(false)
      return own.promise
    },
    scroll(phase: DeskPhase, dy: number, velocity: number): boolean {
      return deskSupported && deskStroke(phase, dy, velocity)
        && sendDesk('harness_device_scroll', { machineId: where.machineId, phase, dy, velocity })
    },
    barrier(agentId: string): Promise<void> {
      if (closed || !generation || !socket || !id(agentId)) return Promise.reject(new Error('SESSION_EVENTS_UNAVAILABLE'))
      if (pool.barriers >= 4) return Promise.reject(new Error('SESSION_EVENTS_BACKPRESSURE'))
      const requestId = randomUUID(), wire = JSON.stringify({ type: 'agent_recent', payload: { requestId, agentId, n: 1 } })
      const credit = pool.reserve(Buffer.byteLength(wire))
      if (!credit) return Promise.reject(new Error('SESSION_EVENTS_BACKPRESSURE'))
      pool.barriers++
      let released = false
      const promise = new Promise<void>((resolve, reject) => {
        barriers.set(requestId, { at: Date.now(),
          resolve, reject,
          release: () => { if (!released) { released = true; pool.barriers--; credit() } },
        })
      })
      try { socket.send(wire) } catch { fail('SESSION_EVENTS_UNAVAILABLE') }
      deadline()
      return promise
    },
    close: (): void => fail('SESSION_EVENTS_CLOSED', false),
    async stop(): Promise<void> {
      fail('SESSION_EVENTS_CLOSED', false)
      if (!active) return
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([active.actual, new Promise<void>(done => {
        timeout = setTimeout(() => { options.unavailable('SESSION_EVENTS_DRAIN_PENDING'); done() }, 2_000)
        timeout.unref?.()
      })])
      clearTimeout(timeout)
    },
  }
}
export type DeviceSessionFeed = ReturnType<typeof observeDeviceSessions>
