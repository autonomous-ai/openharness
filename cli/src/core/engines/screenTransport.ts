/** Core's screen port: plain snapshots, a single deadline, and connection-generation fencing. */
import type { ScreenReading } from '../../engines/facets/screen.js'
import { EngineReadError } from '../../engines/worker/protocol.js'
import { screenReading, screenCapture, SCREEN_CAPABILITIES, SCREEN_IN_FLIGHT, SCREEN_QUEUED, SCREEN_READ, SCREEN_REPLY_BYTES,
  SCREEN_VERSION, SCREEN_WAIT_MS } from '../../engines/worker/screenProtocol.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'

export type ScreenTransportDeps = SnapshotTransportDeps

export function createScreenTransport(deps: ScreenTransportDeps) {
  const transport = createSnapshotTransport(deps, { version: SCREEN_VERSION, capabilities: SCREEN_CAPABILITIES, capability: 'screen',
    inFlight: SCREEN_IN_FLIGHT, queued: SCREEN_QUEUED, waitMs: SCREEN_WAIT_MS, replyBytes: SCREEN_REPLY_BYTES })
  return {
    connected: transport.connected,
    disconnected: transport.disconnected,
    async read(engine: string, capture: string): Promise<ScreenReading> {
      if (!screenCapture(capture)) throw new EngineReadError('ENGINE_INVALID_REQUEST')
      return await transport.read(engine, SCREEN_READ, { capture }, screenReading) as ScreenReading
    },
  }
}

export type ScreenTransport = ReturnType<typeof createScreenTransport>
