/**
 * The agent browser in its own process, as the core sees it (services/agentBrowserProcess.ts; on demand).
 *
 * What happens to its agents it hears as every service that follows agents does (core/agentLife.ts), and whose Browser
 * is on is its own: nothing of either is kept here.
 *
 * Display fields use the shared publisher (core/frameParts.ts); this link retains only stream routing and the
 * dated wake adapter below.
 *
 * A viewer's stream of a browser's screen is the process's whole (services/agentBrowser/streams.ts): the core passes a
 * viewer's frames on as events and its bytes as binary frames on this link (a terminal's plain frame,
 * lib/terminalBinary.ts, which names the stream), and hands the process's answers and the screen's bytes to
 * core/browserStreams.ts, which holds each to the connection that opened the stream. A process says once it is connected that it takes streams (`streams`): one from before 2026-11-13 does
 * not, and a viewer's open is then refused at once rather than left unanswered.
 *
 * Whatever else the process asks it asks as any service may (core/agentQueries.ts), and only what it uses: every agent,
 * the agent of a pane, a product counter.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { answerAgentQuery } from './agentQueries.js'
import type { AgentBrowserPort, CoreApi } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'
import { encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'

type Payload = Record<string, unknown>

/** The agent questions this process uses. */
const ANSWERED: ReadonlySet<string> = new Set(['agents', 'agent_of_pane', 'count'])

export function createAgentBrowserLink(deps: {
  core: Pick<CoreApi, 'agents' | 'count' | 'clients' | 'usage'>
  notify: (frame: ServiceFrame) => boolean
  /** Bytes for the process, on its link (core/serviceLinks.ts `notifyBinary`); false when it would not take them. */
  notifyBinary: (bytes: Uint8Array) => boolean
  /** The process went: every stream it held is gone with it (core/browserStreams.ts `gone`). */
  streamsGone: () => void
  /** Ask the master for the process (`coreLink.want`), for an agent whose row still carries the flag from before the
   *  agent browser kept whose Browser is on (lib/registry.ts `browser`), which only that process takes in: a Desktop
   *  from before Browser left New agent still sets it at a create. Delete on or after 2026-12-18, with the flag. */
  want: () => void
}) {
  const { core, notify } = deps
  /** Whether the process is connected now. */
  let up = false
  /** Whether the process connected now takes streams: it says so as it connects. */
  let streams = false
  const event = (payload: Payload) => notify({ type: 'service_event', payload })

  const port: AgentBrowserPort = {
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
    // Said by the process as it connects: it takes viewers' streams.
    if (query === 'streams') {
      streams = true
      return { ok: true }
    }
    // What else it asks it asks as any service may (core/agentQueries.ts), and only what it uses: every agent here (a
    // browser of an agent in neither list is deleted), the agent of a pane, a product counter.
    return ANSWERED.has(query) ? answerAgentQuery(core, query, payload) : { error: 'UNKNOWN_QUERY' }
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
    /** Wake for rows carrying the old Browser flag until its dated migration leaves the core. */
    follow(): () => void {
      return core.agents.follow?.((life) => {
        if (life.kind === 'running') {
          if (life.session.browser && !up) deps.want()
        }
      }) ?? (() => {})
    },
    connected: () => {
      // The process before this one may have gone unseen: a link that is replaced is never said disconnected
      // (core/serviceLinks.ts). Whatever streams it held are gone with it, and this one has said nothing yet.
      up = true
      streams = false
      deps.streamsGone()
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
