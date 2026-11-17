import type { ClientStreamEndpoint } from '../lib/clientStreamContract.js'
import { clientStreamLocalFrame, TerminalBinaryKind } from '../lib/terminalBinary.js'
import type { Asker } from '../core/api.js'
import type { StreamRoute } from './agentBrowser/streams.js'

/** Internal Browser runtime, used only inside the Browser process or its explicit inline debugging adapter. */
export interface BrowserRuntime {
  stream(connection: string, type: string, payload: Record<string, unknown>, asker?: Asker): boolean
  streamInput(streamId: string, bytes: Uint8Array): boolean
  streamClosed(connection?: string): void
  streamRoute(streamId: string, route: StreamRoute | null): void
  streamTransportError(): void
  streamRefused(streamId: string): void
  stop(): void
}

export interface BrowserRuntimeSlot { agentBrowser: BrowserRuntime | null }

/** Browser holds the person's logins; a machine-share owner is not the account's own person. */
export function mayOpenBrowser(asker: Asker): boolean {
  return (asker.local || asker.accountOwner === true) && !asker.guest
}

export function browserStreamEndpoint(port: BrowserRuntime): ClientStreamEndpoint {
  return {
    frame: event => port.stream(event.connection, event.type, event.payload, event.asker),
    binary: bytes => {
      const frame = clientStreamLocalFrame(bytes)
      return frame?.kind === TerminalBinaryKind.browser ? port.streamInput(frame.streamId, frame.bytes) : false
    },
    closed: connection => port.streamClosed(connection),
    control: (_grant, payload) => {
      const { streamId, route } = payload
      if (payload.kind === 'transport_error') port.streamTransportError()
      else if (typeof streamId === 'string' && (route === null || route === 'direct' || route === 'turn' || route === 'relay')) port.streamRoute(streamId, route)
    },
    refused: (_grant, streamId) => { if (streamId) port.streamRefused(streamId) },
  }
}
