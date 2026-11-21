/** Explicit inline debugging and Harness OS only; the normal core imports none of these implementations. */
import { AGENT_BROWSER_REQUESTS, VIEWERS_FALLBACKS, type CoreApi, type PortFallbacks } from '../core/api.js'
import { CLIENT_STREAMS, type ClientStreamEndpoint, type ClientStreamSink } from '../lib/clientStreamContract.js'
import { startAgentBrowser } from './agentBrowser.js'
import { browserStreamEndpoint, type BrowserRuntimeSlot } from './agentBrowserRuntime.js'
import { createServiceClientStreams } from './clientStreams.js'
import type { ServiceHost } from './inlineHost.js'
import { startViewers, viewerStreamEndpoint, type ViewersRuntimeSlot } from './viewers.js'

const FALLBACKS: PortFallbacks<ClientStreamEndpoint> = {
  frame: false, binary: false, closed: undefined, control: undefined, refused: undefined,
}

export function startInlineClientStreams(deps: {
  host: ServiceHost
  outOfProcess: ReadonlySet<string>
  scope(service: string): CoreApi
  register(service: string, endpoint: ClientStreamEndpoint): ClientStreamSink
  gone(service: string): void
}): () => void {
  const stops: Array<() => void> = []
  for (const spec of CLIENT_STREAMS) {
    const service = spec.service
    if (deps.outOfProcess.has(service)) continue
    let endpoint: ClientStreamEndpoint | null = null
    let stop = (): void => {}
    const bridge = createServiceClientStreams(spec, () => endpoint)
    const base = deps.scope(service)
    const core: CoreApi = { ...base, clients: { ...base.clients, streamFrame: bridge.frame, streamBytes: bridge.bytes } }
    if (service === 'viewers') {
      deps.host.start('viewers', (_core, ports) => {
        const slot: ViewersRuntimeSlot = { viewers: null }
        startViewers(core, slot)
        const runtime = slot.viewers!
        endpoint = viewerStreamEndpoint(runtime)
        ports.viewers = { forwardingUrl: runtime.forwardingUrl, surface: runtime.surface, stop: runtime.stop }
      }, core, VIEWERS_FALLBACKS)
    } else {
      deps.host.serve(service, () => {
        const slot: BrowserRuntimeSlot = { agentBrowser: null }
        const requests = startAgentBrowser(core, slot)
        const runtime = slot.agentBrowser!
        endpoint = browserStreamEndpoint(runtime)
        stop = () => runtime.stop()
        return requests
      }, core, AGENT_BROWSER_REQUESTS)
    }
    if (deps.host.isOff(service) || !endpoint) continue
    endpoint = deps.host.guard<ClientStreamEndpoint>(service, endpoint, FALLBACKS)
    const sink = deps.register(service, {
      frame: event => bridge.event({ kind: 'client_stream', ...event }),
      binary: bridge.binary,
      closed: bridge.closed,
      control: (grant, payload) => { bridge.event({ kind: 'client_stream_control', grant, payload }) },
      refused: (grant, streamId) => { bridge.event({ kind: 'client_stream_refused', grant, streamId }) },
    })
    bridge.connected({
      query: async () => ({ ok: true }),
      notice: (_kind, payload) => { sink.frame(payload!.grant as string, payload!.type as string, payload!.payload as Record<string, unknown>) },
      sendBinary: sink.binary,
    })
    let closed = false
    const close = (): void => { if (closed) return; closed = true; deps.gone(service); bridge.disconnected(); stop() }
    deps.host.onOff(service, close)
    stops.push(close)
  }
  return () => { for (const stop of stops) stop() }
}
