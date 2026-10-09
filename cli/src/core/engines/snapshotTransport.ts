/**
 * Core's side of an engine worker's stateless readings (screens, submissions): plain snapshots out, a single
 * deadline, FIFO admission and connection-generation fencing. Nothing is cached across calls; a timeout, a
 * malformed reply or a replaced connection supplies no evidence.
 */
import { EngineReadError, readerEngine, READER_ERRORS, READER_SERVICES, type ReaderEngine } from '../../engines/worker/protocol.js'

export interface SnapshotTransportDeps {
  call(service: string, method: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
}

export interface SnapshotKind {
  version: number
  capabilities: string
  /** The capability reply's field naming this reader's version. */
  capability: string
  inFlight: number
  queued: number
  waitMs: number
  replyBytes: number
}

export function createSnapshotTransport(deps: SnapshotTransportDeps, kind: SnapshotKind) {
  const states = new Map(Object.values(READER_SERVICES).map(service => [service as string,
    { generation: 0, connected: false, capable: false, pending: 0, waiting: [] as Array<() => void> }]))
  const fail = (code: EngineReadError['code']): never => { throw new EngineReadError(code) }
  return {
    connected(service: string): void {
      const state = states.get(service)
      if (state) { state.generation++; state.connected = true; state.capable = false }
    },
    disconnected(service: string): void {
      const state = states.get(service)
      if (state) { state.generation++; state.connected = false; state.capable = false }
    },
    /** The reply's `answer`, once `valid` and within the reply bound; otherwise an EngineReadError. */
    async read(engine: string, method: string, payload: Record<string, unknown>, valid: (answer: unknown) => boolean): Promise<unknown> {
      if (!readerEngine(engine)) fail('ENGINE_INVALID_REQUEST')
      const service = READER_SERVICES[engine as ReaderEngine], state = states.get(service)!
      const generation = state.generation + (state.connected ? 0 : 1)
      const deadline = performance.now() + kind.waitMs
      // A poll tick can capture dozens of panes together. Refusing every read
      // after the first eight starves the same later sessions on every tick.
      // FIFO admission is bounded, and spends the caller's original deadline.
      // Earlier active reads have the same hard budget and release their slots
      // even on a hung link; expired queued reads send nothing and release next.
      if (state.pending >= kind.inFlight) {
        if (state.waiting.length >= kind.queued) fail('ENGINE_BUSY')
        await new Promise<void>(resolve => { state.waiting.push(resolve) })
      } else state.pending++
      const call = async (name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const remaining = Math.ceil(deadline - performance.now())
        if (remaining <= 0) fail('ENGINE_UNAVAILABLE')
        // Service startup has its own wait. Enforce one wall-clock budget here,
        // including a worker that never answers or a link that loses its timer.
        let timer: ReturnType<typeof setTimeout> | undefined
        let reply: Record<string, unknown>
        try {
          reply = await Promise.race([deps.call(service, name, { version: kind.version, ...body }, remaining),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EngineReadError('ENGINE_UNAVAILABLE')), remaining) })])
        } finally { clearTimeout(timer) }
        if (performance.now() > deadline) fail('ENGINE_UNAVAILABLE')
        if (reply.error === 'SERVICE_FAILED' || reply.error === 'SERVICE_UNAVAILABLE') fail('ENGINE_UNAVAILABLE')
        if (state.generation !== generation) fail('ENGINE_STALE_REPLY')
        if (reply.version !== kind.version) fail('ENGINE_INVALID_REPLY')
        if (reply.error !== undefined) fail(READER_ERRORS.includes(reply.error as EngineReadError['code']) ? reply.error as EngineReadError['code'] : 'ENGINE_INVALID_REPLY')
        return reply
      }
      try {
        if (!state.capable) {
          const capability = await call(kind.capabilities, {})
          if (capability[kind.capability] !== kind.version || capability.engine !== engine) fail('ENGINE_INVALID_REPLY')
          state.capable = true
        }
        const reply = await call(method, payload)
        if (Buffer.byteLength(JSON.stringify(reply)) > kind.replyBytes || !valid(reply.answer)) fail('ENGINE_INVALID_REPLY')
        return reply.answer
      } catch (error) { throw error instanceof EngineReadError ? error : new EngineReadError('ENGINE_UNAVAILABLE') }
      finally {
        const next = state.waiting.shift()
        if (next) next()
        else state.pending--
      }
    },
  }
}

export type SnapshotTransport = ReturnType<typeof createSnapshotTransport>
