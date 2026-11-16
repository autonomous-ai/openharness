/**
 * The agent browser in its own process, as the core sees it (services/agentBrowserProcess.ts; on demand).
 *
 * The core tells the process what happens to agents and goes on: one whose Browser is on is here (`service_event attached`),
 * one stopped, one was purged, and a pane whose agent ended has a new one (`moved`, decision 19). A stop or a purge it
 * missed would leave a browser running, or a login on disk, and a move it missed would leave the pane's logins with the
 * agent that ended, so those are held until the process hears them. An attach is not: it is said on every look at an
 * agent, and the core says every one again each time the process connects, which a process that restarted needs anyway.
 * An attach, and a move of a browser that is on, also ask for the process, which runs only once a browser is wanted
 * here, or as the core starts when its state file is there.
 *
 * An agent's frame reads its browser in line, and cannot wait on another process: the process tells the core each
 * browser's state as it changes (`browser_state`), and the port answers from the last of them. The core keeps them
 * only for the agents it attached and has not since stopped or deleted, so a late word never brings a browser back.
 *
 * A viewer's stream of a browser's screen is the process's whole (services/agentBrowser/streams.ts): the core passes a
 * viewer's frames on as events and its bytes as binary frames on this link (a terminal's plain frame,
 * lib/terminalBinary.ts, which names the stream), and hands the process's answers and the screen's bytes to
 * core/browserStreams.ts, which holds each to the connection that opened the stream. A process says once it is connected that it takes streams (`streams`): one from before 2026-11-13 does
 * not, and a viewer's open is then refused at once rather than left unanswered.
 *
 * The process asks the core what only the core knows: its agents' ids (`agent_ids`), the agent of a pane and whether it
 * is a guest's, held to the parents of the command that names it (`agent_of_pane`), and to hand on one of its own
 * product counters (`count`), none other. And it asks the core to
 * turn an agent's Browser on or off (`set_browser`), its person's Start and Stop: the core sets the row's flag and
 * tells this port `attached` or `stopped` before it answers; and, once it moved a pane's browser to its new agent, to
 * move the flag (`move_browser`), which attaches that agent the same way.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentBrowserFrame } from '../lib/agentFrame.js'
import { PRODUCT_USAGE_AGENT_BROWSER_METRICS, type ProductUsageMetric } from '../lib/productUsageContract.js'
import type { AgentBrowserPort, CoreApi } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'
import { encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'

type Payload = Record<string, unknown>

const STATES: ReadonlySet<string> = new Set(['setup', 'starting', 'ready', 'failed'])
const METRICS: ReadonlySet<string> = new Set(PRODUCT_USAGE_AGENT_BROWSER_METRICS)
const INVALID = { error: 'INVALID_REQUEST' }

/** Only the shape the frame carries, so the process can put nothing else on it. */
function browserState(value: unknown): AgentBrowserFrame | null {
  if (!value || typeof value !== 'object') return null
  const { state, step, error } = value as Payload
  if (typeof state !== 'string' || !STATES.has(state)) return null
  if ((step !== undefined && typeof step !== 'string') || (error !== undefined && typeof error !== 'string')) return null
  return { state: state as AgentBrowserFrame['state'], ...(step !== undefined ? { step } : {}), ...(error !== undefined ? { error } : {}) }
}

/** A command's parents' pids, as `harness browser` sends them; null for anything else. */
function pidsOf(value: unknown): number[] | null {
  return Array.isArray(value) && value.every(pid => Number.isSafeInteger(pid) && pid > 0) ? value as number[] : null
}

export function createAgentBrowserLink(deps: {
  core: Pick<CoreApi, 'agents' | 'count' | 'clients'>
  notify: (frame: ServiceFrame, opts?: { untilDelivered?: boolean }) => boolean
  /** Bytes for the process, on its link (core/serviceLinks.ts `notifyBinary`); false when it would not take them. */
  notifyBinary: (bytes: Uint8Array) => boolean
  /** Ask the master for the process (`coreLink.want`). */
  want: () => void
  /** The process went: every stream it held is gone with it (core/browserStreams.ts `gone`). */
  streamsGone: () => void
}) {
  const { core, notify } = deps
  const attached = new Set<string>()
  const states = new Map<string, AgentBrowserFrame>()
  let up = false
  /** Whether the process connected now takes streams: it says so as it connects. */
  let streams = false
  const event = (payload: Payload, opts?: { untilDelivered?: boolean }) => notify({ type: 'service_event', payload }, opts)
  // A stop or a purge sends the agent's frame without its browser, whether or not the process is there to hear it:
  // what the process says of it from now on is not kept, and a panel whose frame was not sent again went on showing
  // the browser ready or starting (CLI 0.6.40, 2026-11-12). Its viewers' streams end in the process, which is told.
  const forget = (agentId: string) => {
    attached.delete(agentId)
    states.delete(agentId)
    const session = core.agents.byAgent(agentId)
    if (session) core.agents.sync(session)
  }

  const port: AgentBrowserPort = {
    attached: (session) => {
      if (!session.browser) return
      attached.add(session.agentId)
      if (!up) deps.want()
      event({ kind: 'attached', session })
    },
    stopped: (agentId) => {
      forget(agentId)
      event({ kind: 'stopped', agentId }, { untilDelivered: true })
    },
    deleted: (agentId) => {
      forget(agentId)
      event({ kind: 'deleted', agentId }, { untilDelivered: true })
    },
    moved: (from, session, on) => {
      forget(from)
      if (on && !up) deps.want()
      event({ kind: 'moved', from, session, on }, { untilDelivered: true })
    },
    frameContext: agentId => states.get(agentId),
    // Never held for a process that is down: a viewer's frame told late would open a stream nobody waits for.
    stream: (connId, type, payload, asker) => streams && event({ kind: 'stream', connId, type, payload, ...(asker ? { asker } : {}) }),
    streamInput: (streamId, bytes) => {
      const frame = streams ? encodeTerminalLocal({ kind: TerminalBinaryKind.browser, streamId, seq: 0, bytes, compressed: false }) : null
      return !!frame && deps.notifyBinary(frame)
    },
    // The process hears every connection's end from the core's service links itself (`service_connection_closed`,
    // core/serviceLinks.ts), as every service does.
    streamClosed: () => {},
    streamRoute: (streamId, route) => { if (streams) event({ kind: 'stream_route', streamId, route }) },
    streamTransportError: () => { if (streams) event({ kind: 'stream_transport_error' }) },
    streamRefused: (streamId) => { if (streams) event({ kind: 'stream_refused', streamId }) },
    stop: () => {},
  }

  const answer = async (query: string, payload: Payload): Promise<Payload> => {
    if (query === 'browser_state') {
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
      const state = payload.state === undefined ? undefined : browserState(payload.state)
      // The exec into a ready browser, which a process still names for a core from before 2026-11-13, is not read: this
      // core starts no command for the browser.
      if (!agentId || state === null) return INVALID
      if (!attached.has(agentId)) return { ok: true }
      if (state) states.set(agentId, state)
      else states.delete(agentId)
      const session = core.agents.byAgent(agentId)
      if (session) core.agents.sync(session)
      return { ok: true }
    }
    // Said by the process as it connects: it takes viewers' streams.
    if (query === 'streams') {
      streams = true
      return { ok: true }
    }
    if (query === 'agent_ids') return core.agents.ids ? { ...await core.agents.ids() } : { error: 'UNSUPPORTED' }
    if (query === 'agent_of_pane') {
      // No parents: an older relay's `agent_browser_state` (core/api.ts `ofPane`).
      const ancestors = payload.ancestors === undefined ? undefined : pidsOf(payload.ancestors)
      if (typeof payload.pane !== 'string' || ancestors === null) return INVALID
      const agent = await core.agents.ofPane?.(payload.pane, ancestors)
      return agent ? { ...agent } : { agentId: null }
    }
    if (query === 'set_browser') {
      if (typeof payload.agentId !== 'string' || typeof payload.on !== 'boolean') return INVALID
      return core.agents.setBrowser ? { ...await core.agents.setBrowser(payload.agentId, payload.on) } : { error: 'UNSUPPORTED' }
    }
    if (query === 'move_browser') {
      const { from, to } = payload
      if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) return INVALID
      return core.agents.moveBrowser ? { ...await core.agents.moveBrowser(from, to) } : { error: 'UNSUPPORTED' }
    }
    if (query === 'count') {
      if (typeof payload.metric !== 'string' || !METRICS.has(payload.metric)) return INVALID
      core.count?.(payload.metric as ProductUsageMetric)
      return { ok: true }
    }
    return { error: 'UNKNOWN_QUERY' }
  }

  return {
    port,
    answer,
    /** What the process tells the core without asking: a stream's answer for one viewer's connection. One the core
     *  does not pass on (not that connection's, or it is gone) needs no word back: a connection that closed was told. */
    notice: (payload: Payload): void => {
      if (payload.kind !== 'stream_frame' || typeof payload.connId !== 'string' || typeof payload.type !== 'string') return
      core.clients.browserFrame?.(payload.connId, payload.type, payload.payload && typeof payload.payload === 'object' ? payload.payload as Payload : {})
    },
    /** A stream's screen bytes, from the process: a terminal's plain frame (lib/terminalBinary.ts), as a window is sent.
     *  It names its stream and no connection: whose the stream is, is the core's to say (core/browserStreams.ts, which
     *  reads it and sends it on as it came). */
    binary: (bytes: Uint8Array): void => { core.clients.browserBytes?.(bytes) },
    connected: () => {
      // The process before this one may have gone unseen: a link that is replaced is never said disconnected
      // (core/serviceLinks.ts). Whatever streams it held are gone with it, and this one has said nothing yet.
      streams = false
      deps.streamsGone()
      up = true
      for (const session of core.agents.live()) if (session.browser) event({ kind: 'attached', session })
    },
    disconnected: () => {
      up = false
      streams = false
      deps.streamsGone()
    },
  }
}

/** As the core starts: the process is asked for when it runs out here and a browser was wanted before. */
export function wakeAgentBrowser(deps: { outOfProcess: ReadonlySet<string>; dataDir: string; want: (service: string) => void }): void {
  if (deps.outOfProcess.has('agentBrowser') && existsSync(join(deps.dataDir, 'agent-browser.json'))) deps.want('agentBrowser')
}
