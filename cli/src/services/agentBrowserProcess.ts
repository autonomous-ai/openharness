/**
 * The agent browser in its own process (`harness __service agentBrowser`, on demand): the same service as in the core's
 * process (services/agentBrowser.ts). Podman's calls and its event stream, image builds that run for minutes and a
 * setup that waits on a password dialog all cost this process, never the core.
 *
 * The core tells it what happens to agents (`service_event` `attached`, `stopped`, `deleted`, and `moved`: a pane whose
 * agent ended has a new one, decision 19) and reads each browser's state from what this process last told it
 * (`browser_state`, core/agentBrowserLink.ts), so a frame never waits on it.
 * It asks the core for what only the core knows: its agents' ids (`agent_ids`), the agent of a pane and whether it is a
 * guest's, held to the parents of the command that names it (`agent_of_pane`), and to hand on a product counter
 * (`count`). It asks the core to turn an agent's Browser on or off, its person's Start and Stop (`set_browser`), and to
 * move the flag after a browser it moved to a pane's new agent (`move_browser`): the core tells it `attached` or
 * `stopped` before it answers. And it has the core type its two lines into an agent (`deliver`, services/turnsLink.ts),
 * and hears what became of them.
 *
 * A viewer's stream of a browser's screen runs here whole (agentBrowser/streams.ts). The core passes on a viewer's
 * frames as events (`stream`, `stream_route`, `stream_transport_error`, `stream_refused`), its connection's end as every
 * service hears it (`service_connection_closed`), and its bytes
 * as binary frames (a terminal's plain frame, lib/terminalBinary.ts, which names the stream); the stream's answers go
 * back as notices (`stream_frame`) and the screen's bytes as the same binary frames, which the core sends the
 * connection it holds the stream for. It says it takes streams each
 * time it connects (`streams`): a core is told nothing it did not ask to know.
 */
import type { Asker, BrowserRoute, BrowserSwitch, CoreApi, CorePorts } from '../core/api.js'
import { decodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import { startAgentBrowser } from './agentBrowser.js'
import type { BrowserState } from './agentBrowser/browsers.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { isSession, processCoreApi } from './processCoreApi.js'
import { turnsLink } from './turnsLink.js'

type Payload = Record<string, unknown>
type Ask = (query: string, payload: Payload) => Promise<Payload>

// The service's start waits on this before it deletes anything; no answer in time is no answer.
const IDS_TIMEOUT_MS = 10_000
// The core switches in the same turn it is asked: a person's Start or Stop, or a move, it does not answer in this is a
// failed one.
const SWITCH_TIMEOUT_MS = 10_000
// The core reads the pane's process from tmux within 2 s. An agent's command waits on this answer: a core that does not
// give it in time names no agent, and the command is refused rather than left hanging.
const PANE_TIMEOUT_MS = 10_000

export interface AgentBrowserServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests. */
  start?: typeof startAgentBrowser
}

const ROUTES: ReadonlySet<string> = new Set(['direct', 'turn', 'relay'])

const strings = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null)

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`the core did not answer within ${ms} ms`)), ms) })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** The core's answer to a switch, or null for anything else. */
function switchOf(answer: Payload): BrowserSwitch | null {
  if (answer.ok === true && typeof answer.changed === 'boolean') return { ok: true, changed: answer.changed }
  return answer.error === 'NOT_RUNNING' || answer.error === 'NOT_ALLOWED' ? { error: answer.error } : null
}

/** How a stream's answers and bytes reach the core from here: a notice, and a binary frame; false when the core is
 *  not there to take them. */
export interface StreamSinks {
  frame(connId: string, type: string, payload: Payload): boolean
  bytes(frame: Uint8Array): boolean
}

/** The core API the agent browser runs on here: the light services' (processCoreApi.ts), with what it asks the core,
 *  the turns it delivers through it, and where its viewers' streams go. */
export function agentBrowserCoreApi(dataDir: string, ask: Ask, deliveries: ReturnType<typeof turnsLink>, sinks: StreamSinks): CoreApi {
  const api = processCoreApi(dataDir, 'agentBrowser', { deliveries })
  return {
    ...api,
    clients: {
      ...api.clients,
      browserFrame: (connId, type, payload) => sinks.frame(connId, type, payload),
      // Framed by the service already. Taken by the link, or not: what the viewer's transport refuses after it comes back
      // as `stream_refused`.
      browserBytes: (frame) => sinks.bytes(frame),
    },
    agents: {
      ...api.agents,
      ids: async () => {
        const answer = await within(IDS_TIMEOUT_MS, ask('agent_ids', {}))
        const live = strings(answer.live)
        const stopped = strings(answer.stopped)
        if (!live || !stopped) throw new Error('the core gave no answer for its agents')
        return { live, stopped }
      },
      ofPane: async (pane, ancestors) => {
        const answer = await within(PANE_TIMEOUT_MS, ask('agent_of_pane', { pane, ...(ancestors ? { ancestors } : {}) })).catch(() => null)
        // An answer that does not say whose the agent is names none: a command is never run for a guest's on a guess.
        return typeof answer?.agentId === 'string' && typeof answer.guest === 'boolean' ? { agentId: answer.agentId, guest: answer.guest } : null
      },
      setBrowser: async (agentId, on) => {
        const answer = switchOf(await within(SWITCH_TIMEOUT_MS, ask('set_browser', { agentId, on })))
        if (!answer) throw new Error('the core gave no answer for the switch')
        return answer
      },
      moveBrowser: async (from, to) => {
        const answer = switchOf(await within(SWITCH_TIMEOUT_MS, ask('move_browser', { from, to })))
        if (!answer) throw new Error('the core gave no answer for the move')
        return answer
      },
    },
    // A count the core cannot take now is lost: counters are measures, never state.
    count: (metric: ProductUsageMetric) => { void ask('count', { metric }).catch(() => {}) },
  }
}

export function runAgentBrowserService(options: AgentBrowserServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  const ask: Ask = (query, payload) => (core ? core.query(query, payload) : Promise.reject(new Error('no core to ask')))
  const link = turnsLink(ask)
  // A line asked of no core never left this process: heard `rejected`, so it is tried again (agentBrowser/notices.ts),
  // not `unknown`, which counts as perhaps typed and is never typed again.
  const deliveries: ReturnType<typeof turnsLink> = { ...link, turns: { ...link.turns, deliver: (agentId, text, deliveryId, opts) => {
    if (core) return link.turns.deliver(agentId, text, deliveryId, opts)
    queueMicrotask(() => link.heard({ kind: 'delivery', event: { deliveryId, sessionId: agentId, state: 'rejected', reason: 'no_core' } }))
  } } }
  const ports: Pick<CorePorts, 'agentBrowser'> = { agentBrowser: null }
  /** What each browser last showed: a new core, or the same one after this link dropped, hears all of it again. */
  const shown = new Map<string, BrowserState>()
  const tell = (agentId: string, state: BrowserState | undefined) => {
    void ask('browser_state', { agentId, ...(state ? { state } : {}) }).catch(() => {})
  }
  /** The connections that asked anything of a stream and are still open. The core that goes forgets every stream it
   *  held (core/browserStreams.ts `gone`), so each is told ended here: an exec left piping a still screen would hold
   *  one of its browser's few viewer places for good. */
  const viewers = new Set<string>()
  const sinks: StreamSinks = {
    frame: (connId, type, payload) => {
      if (!core?.notice) return false
      core.notice('stream_frame', { connId, type, payload })
      return true
    },
    bytes: frame => core?.sendBinary?.(frame) ?? false,
  }
  const requests = (options.start ?? startAgentBrowser)(agentBrowserCoreApi(options.dataDir, ask, deliveries, sinks), ports, {
    told: (agentId, state) => {
      if (state) shown.set(agentId, state)
      else shown.delete(agentId)
      tell(agentId, state)
    },
  })
  const port = ports.agentBrowser!
  const service = (options.run ?? runServiceProcess)({
    name: 'agentBrowser',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests,
    onEvent: (payload) => {
      if (deliveries.heard(payload)) return
      if (payload.kind === 'attached') {
        if (isSession(payload.session)) port.attached(payload.session)
        return
      }
      if (payload.kind === 'moved') {
        const { from, session, on } = payload
        if (typeof from === 'string' && from && isSession(session) && typeof on === 'boolean') port.moved(from, session, on)
        return
      }
      if (payload.kind === 'stream') {
        const { connId, type, asker } = payload
        if (typeof connId !== 'string' || typeof type !== 'string') return
        viewers.add(connId)
        // Who asked comes with an open alone: an ack and a close are the stream's own.
        port.stream(connId, type, payload.payload && typeof payload.payload === 'object' ? payload.payload as Payload : {}, asker && typeof asker === 'object' ? asker as Asker : undefined)
        return
      }
      if (payload.kind === 'stream_route') {
        const { streamId, route } = payload
        if (typeof streamId === 'string' && (route === null || ROUTES.has(route as string))) port.streamRoute(streamId, route as BrowserRoute | null)
        return
      }
      if (payload.kind === 'stream_transport_error') return port.streamTransportError()
      if (payload.kind === 'stream_refused') {
        if (typeof payload.streamId === 'string') port.streamRefused(payload.streamId)
        return
      }
      if (typeof payload.agentId !== 'string' || !payload.agentId) return
      if (payload.kind === 'stopped') port.stopped(payload.agentId)
      else if (payload.kind === 'deleted') port.deleted(payload.agentId)
    },
    // A viewer's keys and mouse, for its stream.
    onBinary: (bytes) => {
      const frame = decodeTerminalLocal(bytes)
      if (frame?.kind === TerminalBinaryKind.browser) port.streamInput(frame.streamId, frame.bytes)
    },
    onConnectionClosed: (connId) => {
      if (viewers.delete(connId)) port.streamClosed(connId)
    },
    onConnected: (connection) => {
      core = connection
      // Said to each core it connects to: it takes viewers' streams (core/agentBrowserLink.ts `streams`).
      void ask('streams', {}).catch(() => {})
      for (const [agentId, state] of shown) tell(agentId, state)
    },
    onDisconnected: () => {
      core = null
      for (const connId of viewers) port.streamClosed(connId)
      viewers.clear()
    },
  })
  return { stop: () => { port.stop(); return service.stop() } }
}
