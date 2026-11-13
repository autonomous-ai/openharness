/**
 * An agent browser's screen, to the panels open on it: the core's side. The stream itself is the agent browser's
 * (services/agentBrowser/streams.ts): the exec into the browser's container, the reading of the viewer's VNC bytes,
 * the credit and the pacing all run in its process. Until the audit of 2026-11-12 they ran here, in the process that
 * types into every terminal.
 *
 * The socket hands every frame of a stream here after its gates, and nothing here waits: a frame is passed on as it
 * comes (`AgentBrowserPort.stream`), and the service's answers and the screen's bytes go back to the one connection
 * that opened the stream (`frame`, `bytes`). What the core keeps is who may open one, and whose each stream is:
 *
 * - **Who may open.** A window on this computer, or another of the owner's own apps and computers
 *   (`mayOpenBrowser`): refused here, before the service hears of it, and the service is told who asked.
 * - **Whose a stream is.** An open's answer is passed on only to the connection that asked, under the request it asked
 *   with, and names the stream that connection now holds. The screen's bytes go to that connection, which the service
 *   never names; a close reaches it and no other, and a viewer's bytes reach the service only from it. An answer the
 *   core does not pass on that named a stream is a stream started for nobody: the service is told to end it.
 * - **Its own bounds.** An open the service has not answered in `BROWSER_OPEN_WAIT_MS` is refused (`NOT_READY`). The
 *   agent browser holds each stream's credit, a window of what its viewer has not drawn, and the core does not lean on
 *   it: a stream whose viewer has more than `BROWSER_UNACKED_MAX` unread, or whose send its transport refused, ends
 *   here (`backlog`), and so does one whose viewer's bytes could not reach the service (`agent`), which would leave
 *   VNC reading the rest of its stream wrong. Its viewer is told, and the service ends its side. A window's send has
 *   no limit of its own, so a service that stopped counting would otherwise grow the core's buffers for good.
 * - **What it knows already.** An agent with no browser, or one whose browser is not ready, is answered in line from
 *   the state the core keeps for the agent's frame (`NO_BROWSER`, `NOT_READY`), with nobody asked.
 * - **Nobody serving.** While the agent browser is not connected an open is refused at once (`NOT_READY`), and when its
 *   process goes every stream it held is told closed (`agent`), so a panel reconnects instead of showing a still
 *   screen. Until the audit a stream outlived that process, as the core's own child; now it ends with it.
 */
import { mayOpenBrowser, type AgentBrowserPort, type Asker, type BrowserRoute } from './api.js'
import { browserLocalFrame } from '../lib/terminalBinary.js'

type Payload = Record<string, unknown>

/** The opens one connection may have unanswered: a panel asks one at a time. */
export const BROWSER_OPENS_PENDING_MAX = 8
/** How long an open waits for the agent browser's answer. It starts its exec and answers in the same turn: one that
 *  has not answered in this never will, and the panel is told so instead of waiting for good. */
export const BROWSER_OPEN_WAIT_MS = 10_000
/** What one stream's viewer may have been sent and not acked before the core ends it: four times the agent browser's
 *  own window (services/agentBrowser/streams.ts `BROWSER_WINDOW`, which pauses at 256 KiB), so a service that counts
 *  right never meets it. */
export const BROWSER_UNACKED_MAX = 1024 * 1024
/** As a stream's frames name it (lib/terminalBinary.ts): a UUID, in lower case. */
const STREAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface BrowserStreams {
  /** A client's `agent_browser_open`. */
  open(connId: string, payload: Payload): void
  /** A client's `agent_browser_ack`. */
  ack(connId: string, payload: Payload): void
  /** A client's `agent_browser_close`. */
  close(connId: string, payload: Payload): void
  /** A viewer's bytes for its stream. */
  input(connId: string, streamId: string, bytes: Uint8Array): void
  /** A client's connection ended. */
  closeConnection(connId: string): void
  /** The gateway's word on the route a remote stream opened on, and that a route went away. */
  route(streamId: string, route: BrowserRoute): void
  routeLost(streamId: string): void
  /** The backend refused one of this machine's relayed browser frames. */
  transportError(): void
  /** The service's frame for a connection (`agent_browser_open_result`, `agent_browser_close`): false when it is not that
   *  connection's to hear, or could not reach it. */
  frame(connId: string, type: string, payload: Payload): boolean
  /** A stream's screen frame from the service (`browserLocalFrame`), sent as it came to the connection that holds the
   *  stream: false when none does, when it is no such frame, or when that connection's transport refused it. */
  bytes(frame: Uint8Array): boolean
  /** The agent browser went (its process disconnected, or another took its place): every stream it held is closed. */
  gone(): void
}

export function createBrowserStreams(deps: {
  /** The agent browser's port as it is now: null while it is off. */
  port: () => Pick<AgentBrowserPort, 'frameContext' | 'stream' | 'streamInput' | 'streamClosed' | 'streamRoute' | 'streamTransportError' | 'streamRefused'> | null
  asker: (connId: string) => Asker
  /** A frame to one connection, on the terminals' transport. */
  send: (connId: string, type: string, payload: Payload) => boolean
  /** A screen frame as the agent browser framed it, to one connection: as it is to a window here. */
  sendBinary: (connId: string, frame: Uint8Array) => boolean
  log?: (line: string) => void
}): BrowserStreams {
  const log = deps.log ?? ((line: string) => console.warn(line))
  /** Each open asked and not yet answered, by connection and request: the timer that gives it up. */
  const pending = new Map<string, Map<string, NodeJS.Timeout>>()
  /** Each stream's connection, from the answer to its open until its close, and what its viewer has not acked. */
  const streams = new Map<string, { connId: string; unacked: number }>()
  /** A screen frame the core cannot read is said once each time the agent browser connects, not once a frame. */
  let saidUnreadable = false

  const refuse = (connId: string, requestId: string, error: string): void => { deps.send(connId, 'agent_browser_open_result', { requestId, error }) }
  /** The open [requestId] of [connId] is answered or given up: false when it was not waited for. */
  const settle = (connId: string, requestId: string): boolean => {
    const asked = pending.get(connId)
    const timer = asked?.get(requestId)
    if (!asked || timer === undefined) return false
    clearTimeout(timer)
    asked.delete(requestId)
    if (!asked.size) pending.delete(connId)
    return true
  }
  const heldBy = (connId: string, streamId: unknown) => {
    const stream = typeof streamId === 'string' ? streams.get(streamId) : undefined
    return stream?.connId === connId ? stream : undefined
  }
  /** The core ends a stream itself: its viewer is told why, and the service ends its side (`streamRefused`). */
  const endHere = (streamId: string, connId: string, reason: 'backlog' | 'agent'): void => {
    streams.delete(streamId)
    deps.send(connId, 'agent_browser_close', { streamId, reason })
    deps.port()?.streamRefused(streamId)
  }
  /** An answer not passed on that named a stream: started for nobody, and its exec holds one of its browser's few
   *  viewer places until it is ended. */
  const unwanted = (streamId: unknown): void => {
    if (typeof streamId === 'string' && STREAM_ID.test(streamId)) deps.port()?.streamRefused(streamId)
  }

  return {
    open: (connId, payload) => {
      const requestId = payload.requestId
      if (typeof requestId !== 'string') return
      // Asked again while the first is unanswered: that one's answer is the answer, and the service starts one exec.
      if (pending.get(connId)?.has(requestId)) return
      const asker = deps.asker(connId)
      if (!mayOpenBrowser(asker)) return refuse(connId, requestId, 'NOT_OWNER')
      const port = deps.port()
      // What the agent's frame shows of its browser, read in line: an agent with none never costs its service a look.
      const shown = typeof payload.agentId === 'string' ? port?.frameContext(payload.agentId) : undefined
      if (!shown) return refuse(connId, requestId, 'NO_BROWSER')
      if (shown.state !== 'ready') return refuse(connId, requestId, 'NOT_READY')
      const asked = pending.get(connId) ?? new Map<string, NodeJS.Timeout>()
      if (asked.size >= BROWSER_OPENS_PENDING_MAX) return refuse(connId, requestId, 'VIEWER_LIMIT')
      // Every way an open ends clears this: when it fires, the open is still waited for.
      const timer = setTimeout(() => {
        settle(connId, requestId)
        log(`[agent-browser] the agent browser did not answer a viewer's open in ${BROWSER_OPEN_WAIT_MS / 1000} s: refused`)
        refuse(connId, requestId, 'NOT_READY')
      }, BROWSER_OPEN_WAIT_MS)
      timer.unref?.()
      asked.set(requestId, timer)
      pending.set(connId, asked)
      if (port!.stream(connId, 'agent_browser_open', payload, asker)) return
      // Nobody took it: its process is not there. The panel shows the browser as not ready, and asks again. One that
      // answered before it failed was answered.
      if (settle(connId, requestId)) refuse(connId, requestId, 'NOT_READY')
    },
    ack: (connId, payload) => {
      const stream = heldBy(connId, payload.streamId)
      if (!stream) return
      const bytes = payload.bytes
      if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) stream.unacked = Math.max(0, stream.unacked - bytes)
      deps.port()?.stream(connId, 'agent_browser_ack', payload)
    },
    close: (connId, payload) => { if (heldBy(connId, payload.streamId)) deps.port()?.stream(connId, 'agent_browser_close', payload) },
    input: (connId, streamId, bytes) => {
      if (heldBy(connId, streamId) && !deps.port()?.streamInput(streamId, bytes)) endHere(streamId, connId, 'agent')
    },
    closeConnection: (connId) => {
      for (const timer of pending.get(connId)?.values() ?? []) clearTimeout(timer)
      pending.delete(connId)
      for (const [streamId, stream] of streams) if (stream.connId === connId) streams.delete(streamId)
      deps.port()?.streamClosed(connId)
    },
    route: (streamId, route) => { if (streams.has(streamId)) deps.port()?.streamRoute(streamId, route) },
    routeLost: (streamId) => { if (streams.has(streamId)) deps.port()?.streamRoute(streamId, null) },
    transportError: () => { deps.port()?.streamTransportError() },
    frame: (connId, type, payload) => {
      if (type === 'agent_browser_open_result') {
        const requestId = payload.requestId
        const streamId = payload.streamId
        // Not an open this connection waits for: answered already, given up, or never asked.
        if (typeof requestId !== 'string' || !settle(connId, requestId)) { unwanted(streamId); return false }
        if (streamId !== undefined) {
          if (typeof streamId !== 'string' || !STREAM_ID.test(streamId)) { refuse(connId, requestId, 'NOT_READY'); return false }
          // A stream is named once. A second answer that names one already held is a broken service: the screen would
          // follow it to this connection, so both end.
          const held = streams.get(streamId)
          if (held) {
            endHere(streamId, held.connId, 'agent')
            refuse(connId, requestId, 'NOT_READY')
            return false
          }
          streams.set(streamId, { connId, unacked: 0 })
        }
        return deps.send(connId, type, payload)
      }
      if (type !== 'agent_browser_close' || !heldBy(connId, payload.streamId)) return false
      streams.delete(payload.streamId as string)
      return deps.send(connId, type, payload)
    },
    bytes: (frame) => {
      const read = browserLocalFrame(frame)
      if (!read) {
        if (!saidUnreadable) log(`[agent-browser] a screen frame the core cannot read (${frame.length} bytes) was dropped; the next are dropped without a word until the agent browser connects again`)
        saidUnreadable = true
        return false
      }
      // One for a stream nobody holds is the tail of one that ended, whose service was told then.
      const stream = streams.get(read.streamId)
      if (!stream) return false
      stream.unacked += read.bytes.length
      if (stream.unacked <= BROWSER_UNACKED_MAX && deps.sendBinary(stream.connId, frame)) return true
      // A hole in the screen, or more than a viewer that draws as it should ever has unread.
      endHere(read.streamId, stream.connId, 'backlog')
      return false
    },
    gone: () => {
      for (const [streamId, { connId }] of streams) deps.send(connId, 'agent_browser_close', { streamId, reason: 'agent' })
      streams.clear()
      for (const [connId, asked] of pending) {
        for (const [requestId, timer] of asked) {
          clearTimeout(timer)
          refuse(connId, requestId, 'NOT_READY')
        }
      }
      pending.clear()
      saidUnreadable = false
    },
  }
}
