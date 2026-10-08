/** Core's screen port: plain snapshots, a single deadline, and connection-generation fencing. */
import type { ScreenReading } from '../../engines/facets/screen.js'
import { EngineReadError, readerEngine, READER_ERRORS, READER_SERVICES, type ReaderEngine } from '../../engines/worker/protocol.js'
import { screenReading, screenCapture, SCREEN_CAPABILITIES, SCREEN_IN_FLIGHT, SCREEN_QUEUED, SCREEN_READ, SCREEN_REPLY_BYTES,
  SCREEN_VERSION, SCREEN_WAIT_MS } from '../../engines/worker/screenProtocol.js'

export interface ScreenTransportDeps {
  call(service: string, method: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
}

export function createScreenTransport(deps: ScreenTransportDeps) {
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
    async read(engine: string, capture: string): Promise<ScreenReading> {
      if (!readerEngine(engine) || !screenCapture(capture)) fail('ENGINE_INVALID_REQUEST')
      const service = READER_SERVICES[engine as ReaderEngine], state = states.get(service)!
      const generation = state.generation + (state.connected ? 0 : 1)
      const deadline = performance.now() + SCREEN_WAIT_MS
      // A poll tick can capture dozens of panes together. Refusing every read
      // after the first eight starves the same later sessions on every tick.
      // FIFO admission is bounded, and spends the caller's original deadline.
      // Earlier active reads have the same hard budget and release their slots
      // even on a hung link; expired queued reads send nothing and release next.
      if (state.pending >= SCREEN_IN_FLIGHT) {
        if (state.waiting.length >= SCREEN_QUEUED) fail('ENGINE_BUSY')
        await new Promise<void>(resolve => { state.waiting.push(resolve) })
      } else state.pending++
      const call = async (method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const remaining = Math.ceil(deadline - performance.now())
        if (remaining <= 0) fail('ENGINE_UNAVAILABLE')
        // Service startup has its own wait. Enforce one wall-clock budget here,
        // including a worker that never answers or a link that loses its timer.
        let timer: ReturnType<typeof setTimeout> | undefined
        let reply: Record<string, unknown>
        try {
          reply = await Promise.race([deps.call(service, method, { version: SCREEN_VERSION, ...payload }, remaining),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EngineReadError('ENGINE_UNAVAILABLE')), remaining) })])
        } finally { clearTimeout(timer) }
        if (performance.now() > deadline) fail('ENGINE_UNAVAILABLE')
        if (reply.error === 'SERVICE_FAILED' || reply.error === 'SERVICE_UNAVAILABLE') fail('ENGINE_UNAVAILABLE')
        if (state.generation !== generation) fail('ENGINE_STALE_REPLY')
        if (reply.version !== SCREEN_VERSION) fail('ENGINE_INVALID_REPLY')
        if (reply.error !== undefined) fail(READER_ERRORS.includes(reply.error as EngineReadError['code']) ? reply.error as EngineReadError['code'] : 'ENGINE_INVALID_REPLY')
        return reply
      }
      try {
        if (!state.capable) {
          const capability = await call(SCREEN_CAPABILITIES, {})
          if (capability.screen !== SCREEN_VERSION || capability.engine !== engine) fail('ENGINE_INVALID_REPLY')
          state.capable = true
        }
        const reply = await call(SCREEN_READ, { capture })
        if (Buffer.byteLength(JSON.stringify(reply)) > SCREEN_REPLY_BYTES || !screenReading(reply.answer)) fail('ENGINE_INVALID_REPLY')
        return reply.answer as ScreenReading
      } catch (error) { throw error instanceof EngineReadError ? error : new EngineReadError('ENGINE_UNAVAILABLE') }
      finally {
        const next = state.waiting.shift()
        if (next) next()
        else state.pending--
      }
    },
  }
}

export type ScreenTransport = ReturnType<typeof createScreenTransport>
