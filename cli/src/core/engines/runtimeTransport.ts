/** Core's runtime port: plain snapshots, a single deadline, and connection-generation fencing. */
import type { RuntimeContext } from '../../engines/facets/runtime.js'
import { EngineReadError, readerEngine, READER_ERRORS, READER_SERVICES, type ReaderEngine } from '../../engines/worker/protocol.js'
import { runtimeAnswer, RUNTIME_CAPABILITIES, RUNTIME_IN_FLIGHT, RUNTIME_READ, RUNTIME_REPLY_BYTES,
  RUNTIME_VERSION, RUNTIME_WAIT_MS, type RuntimeAnswer, type RuntimeOperation } from '../../engines/worker/runtimeProtocol.js'

export interface RuntimeTransportDeps {
  call(service: string, method: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
}

export function createRuntimeTransport(deps: RuntimeTransportDeps) {
  const states = new Map(Object.values(READER_SERVICES).map(service => [service as string,
    { generation: 0, connected: false, capable: false, pending: 0 }]))
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
    async read(engine: string, context: RuntimeContext, operation: RuntimeOperation): Promise<RuntimeAnswer> {
      if (!readerEngine(engine) || context.session.engine !== engine) fail('ENGINE_INVALID_REQUEST')
      const service = READER_SERVICES[engine as ReaderEngine], state = states.get(service)!
      if (state.pending >= RUNTIME_IN_FLIGHT) fail('ENGINE_BUSY')
      const generation = state.generation + (state.connected ? 0 : 1)
      const deadline = performance.now() + RUNTIME_WAIT_MS
      state.pending++
      const call = async (method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const remaining = Math.ceil(deadline - performance.now())
        if (remaining <= 0) fail('ENGINE_UNAVAILABLE')
        const reply = await deps.call(service, method, { version: RUNTIME_VERSION, ...payload }, remaining)
        if (performance.now() > deadline) fail('ENGINE_UNAVAILABLE')
        if (reply.error === 'SERVICE_FAILED' || reply.error === 'SERVICE_UNAVAILABLE') fail('ENGINE_UNAVAILABLE')
        if (state.generation !== generation) fail('ENGINE_STALE_REPLY')
        if (reply.version !== RUNTIME_VERSION) fail('ENGINE_INVALID_REPLY')
        if (reply.error !== undefined) fail(READER_ERRORS.includes(reply.error as EngineReadError['code']) ? reply.error as EngineReadError['code'] : 'ENGINE_INVALID_REPLY')
        return reply
      }
      try {
        if (!state.capable) {
          const capability = await call(RUNTIME_CAPABILITIES, {})
          if (capability.runtime !== RUNTIME_VERSION || capability.engine !== engine) fail('ENGINE_INVALID_REPLY')
          state.capable = true
        }
        const reply = await call(RUNTIME_READ, { context, operation })
        if (Buffer.byteLength(JSON.stringify(reply)) > RUNTIME_REPLY_BYTES || !runtimeAnswer(reply.answer, context, operation)) fail('ENGINE_INVALID_REPLY')
        return reply.answer as RuntimeAnswer
      } catch (error) { throw error instanceof EngineReadError ? error : new EngineReadError('ENGINE_UNAVAILABLE') }
      finally { state.pending-- }
    },
  }
}

export type RuntimeTransport = ReturnType<typeof createRuntimeTransport>
