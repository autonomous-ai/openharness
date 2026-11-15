/** Runtime interpretation uses the same bounded snapshot transport as screens and submission readings. */
import type { RuntimeContext } from '../../engines/facets/runtime.js'
import { EngineReadError, workerEngine } from '../../engines/worker/protocol.js'
import { runtimeAnswer, runtimeContext, runtimeOperation, RUNTIME_CAPABILITIES, RUNTIME_IN_FLIGHT, RUNTIME_READ,
  RUNTIME_REPLY_BYTES, RUNTIME_REQUEST_BYTES, RUNTIME_VERSION, RUNTIME_WAIT_MS, type RuntimeAnswer, type RuntimeOperation } from '../../engines/worker/runtimeProtocol.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'

export type RuntimeTransportDeps = SnapshotTransportDeps
export function createRuntimeTransport(deps: RuntimeTransportDeps) {
  const transport = createSnapshotTransport(deps, { version: RUNTIME_VERSION, capabilities: RUNTIME_CAPABILITIES,
    capability: 'runtime', inFlight: RUNTIME_IN_FLIGHT, queued: 0, waitMs: RUNTIME_WAIT_MS, replyBytes: RUNTIME_REPLY_BYTES })
  return {
    connected: transport.connected,
    disconnected: transport.disconnected,
    async read(engine: string, context: RuntimeContext, operation: RuntimeOperation): Promise<RuntimeAnswer> {
      if (!workerEngine(engine) || !runtimeContext(context, engine) || !runtimeOperation(operation)
        || Buffer.byteLength(JSON.stringify({ context, operation })) > RUNTIME_REQUEST_BYTES - 1024) throw new EngineReadError('ENGINE_INVALID_REQUEST')
      return await transport.read(engine, RUNTIME_READ, { context, operation }, answer => runtimeAnswer(answer, context, operation)) as RuntimeAnswer
    },
  }
}
export type RuntimeTransport = ReturnType<typeof createRuntimeTransport>
