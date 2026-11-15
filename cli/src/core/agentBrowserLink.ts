/**
 * The agent browser in its own process, as the core sees it (services/agentBrowserProcess.ts; on demand).
 *
 * What happens to its agents it hears as every service that follows agents does (core/agentLife.ts), and whose Browser
 * is on is its own: nothing of either is kept here.
 *
 * An agent's frame reads its browser in line, and cannot wait on another process: the process tells the core each
 * browser's state as it changes (`browser_state`), and the port answers from the last of them. The core keeps them only
 * for the agents it was told run and not since told ended (it follows them here as a service does), so a late word
 * never brings a browser back; an agent that ends has its frame sent without its browser at once, whether or not the
 * process is there to hear it.
 *
 * A viewer's stream of a browser's screen is the process's whole (services/agentBrowser/streams.ts): the core passes a
 * viewer's frames on as events and its bytes as binary frames on this link (a terminal's plain frame,
 * lib/terminalBinary.ts, which names the stream), and hands the process's answers and the screen's bytes to
 * core/browserStreams.ts, which holds each to the connection that opened the stream. A process says once it is connected that it takes streams (`streams`): one from before 2026-11-13 does
 * not, and a viewer's open is then refused at once rather than left unanswered.
 *
 * Whatever else the process asks it asks as any service may (core/agentQueries.ts): every agent, the agent of a pane,
 * a product counter.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentBrowserFrame } from '../lib/agentFrame.js'
import { answerAgentQuery } from './agentQueries.js'
import type { AgentBrowserPort, CoreApi } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'
import { encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'

type Payload = Record<string, unknown>

const STATES: ReadonlySet<string> = new Set(['setup', 'starting', 'ready', 'failed'])
const INVALID = { error: 'INVALID_REQUEST' }

/** Only the shape the frame carries, so the process can put nothing else on it. */
function browserState(value: unknown): AgentBrowserFrame | null {
  if (!value || typeof value !== 'object') return null
  const { state, step, error } = value as Payload
  if (typeof state !== 'string' || !STATES.has(state)) return null
  if ((step !== undefined && typeof step !== 'string') || (error !== undefined && typeof error !== 'string')) return null
  return { state: state as AgentBrowserFrame['state'], ...(step !== undefined ? { step } : {}), ...(error !== undefined ? { error } : {}) }
}

export function createAgentBrowserLink(deps: {
  core: Pick<CoreApi, 'agents' | 'count' | 'clients' | 'usage'>
  notify: (frame: ServiceFrame) => boolean
  /** Bytes for the process, on its link (core/serviceLinks.ts `notifyBinary`); false when it would not take them. */
  notifyBinary: (bytes: Uint8Array) => boolean
  /** The process went: every stream it held is gone with it (core/browserStreams.ts `gone`). */
  streamsGone: () => void
}) {
  const { core, notify } = deps
  /** The agents told running here and not since told ended: the only ones a browser's state is kept for. */
  const live = new Set<string>()
  const states = new Map<string, AgentBrowserFrame>()
  /** Whether the process connected now takes streams: it says so as it connects. */
  let streams = false
  const event = (payload: Payload) => notify({ type: 'service_event', payload })

  const port: AgentBrowserPort = {
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
      if (!live.has(agentId)) return { ok: true }
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
    return answerAgentQuery(core, query, payload)
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
    /** Follow the agents (core/agentLife.ts): the ones whose browser's state is kept. One that ends has its frame sent
     *  without its browser, whether or not the process is there to hear it: a panel whose frame was not sent again went
     *  on showing the browser ready or starting (CLI 0.6.40, 2026-11-12). Its viewers' streams end in the process,
     *  which hears it too. Only while the agent browser runs in its own process: in the core's, the port is its own. */
    follow(): () => void {
      return core.agents.follow?.((life) => {
        if (life.kind === 'running') live.add(life.session.agentId)
        else if (life.kind === 'ended') {
          live.delete(life.agentId)
          if (!states.delete(life.agentId)) return
          const session = core.agents.byAgent(life.agentId)
          if (session) core.agents.sync(session)
        }
      }) ?? (() => {})
    },
    connected: () => {
      // The process before this one may have gone unseen: a link that is replaced is never said disconnected
      // (core/serviceLinks.ts). Whatever streams it held are gone with it, and this one has said nothing yet.
      streams = false
      deps.streamsGone()
    },
    disconnected: () => {
      streams = false
      deps.streamsGone()
    },
  }
}

/** As the core starts: the process is asked for when it runs out here and a browser was wanted before. */
export function wakeAgentBrowser(deps: { outOfProcess: ReadonlySet<string>; dataDir: string; want: (service: string) => void }): void {
  if (deps.outOfProcess.has('agentBrowser') && existsSync(join(deps.dataDir, 'agent-browser.json'))) deps.want('agentBrowser')
}
