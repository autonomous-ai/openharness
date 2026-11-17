/**
 * The DSH viewers in their own process, as the core sees them (`HARNESSD_SERVICES=viewers`; the
 * process's side is services/viewersProcess.ts).
 *
 * Display fields use the shared publisher (core/frameParts.ts). This link holds forwarding targets only for live
 * harness agents; those targets survive a process disconnect, and are refreshed on each followed observation.
 *
 * A client served a viewer over its connection (core/viewerStreams.ts): each frame of its stream is told
 * to the process as it comes, never held (a stream dies with the process that held it), and refused
 * instead while the process is not reading, so a hung one cannot pile a client's uploads up in the core.
 * What the stream answers comes back as a notice for that connection; one the core cannot deliver ends
 * that stream in the process, as a frame the forwarder could not send ended it in the core's. A rendered
 * frame (`viewer_surface`) is asked of the process (`surface`), and answered unavailable, as a routed
 * request is, if it is down or slower than a client waits.
 *
 * The process runs on demand (core/viewersWake.ts): an agent with a harness attached asks for it, and so does a
 * client's stream that comes before it has ever connected to this core. That stream's frames are held, in order and
 * bounded, until it connects, as a request to a service on demand waits for it (core/serviceLinks.ts `onDemand`), and
 * refused if it has not come within a start's wait. Once it has connected, a stream is refused at once while it is
 * down, as before: a process that went down is the master's to bring back, and a client waits for nobody meanwhile.
 * Held, a stream that woke a process with no viewer yet is refused by the viewers themselves; one that came while a
 * running process reconnects to a core that restarted is served.
 */
import { viewerStreamId } from '../lib/viewerFrames.js'
import { VIEWERS_FOLLOW, VIEWERS_UNAVAILABLE, type CoreApi, type ViewersPort } from './api.js'
import { ON_DEMAND_START_MS, type ServiceFrame } from './serviceLinks.js'
import { NOT_SERVED } from './viewerStreams.js'

/** Tell the viewers' process something (core/serviceLinks.ts `notify`, for `viewers`). */
export type NotifyViewers = (frame: ServiceFrame, opts?: { untilDelivered?: boolean }) => boolean

/** The rest of the link to the viewers' process (core/serviceLinks.ts `call` and `buffered`, for `viewers`). */
export interface ViewersChannel {
  call(type: string, payload: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>>
  buffered(): number
}

/** Past this many bytes waiting on the socket to the viewers' process, it is not reading: a stream's frame
 *  is refused rather than kept. A client sends at most a viewer window (128 KiB) per stream unacknowledged
 *  (lib/viewerWire.ts), so a process that reads keeps far less than this waiting. */
export const VIEWERS_BUFFER_LIMIT = 4 * 1024 * 1024

/** How long a client's rendered frame may wait on the viewers: under the 25 s the desktop gives the
 *  request, so it hears why rather than timing out. Starting a headless browser takes a few seconds. */
export const SURFACE_WAIT_MS = 20_000

const CLOSED: ViewersChannel = { call: async () => VIEWERS_UNAVAILABLE, buffered: () => 0 }

/** The viewers' process on demand: how the link asks for it, and how long a stream waits for it to connect. */
export interface ViewersDemand {
  /** Ask for the process (core/viewersWake.ts `ask`); `why` is what the log says. */
  wake(why: string): void
  /** How long a stream's frames are held for a process that has not connected yet (`ON_DEMAND_START_MS`). */
  startWaitMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** A client's stream frame held until the process connects. */
interface Held {
  connId: string
  type: string
  frame: Record<string, unknown>
  bytes: number
}

/** What the viewers last said of one agent. */
interface Known {
  forwardingUrl: string | null
}

export function createViewersLink(core: Pick<CoreApi, 'agents' | 'clients'>, notify: NotifyViewers, channel: ViewersChannel = CLOSED, demand?: ViewersDemand) {
  const attached = new Set<string>()
  const known = new Map<string, Known>()
  const setTimer = demand?.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = demand?.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  /** Connected to this core at least once, or run by the master from the start (no `demand`): a stream is told or
   *  refused at once from then on. */
  let seen = !demand
  /** Asked for by a stream and not connected within a start's wait: its streams are refused at once, as a request
   *  to a service on demand that did not start is (core/serviceLinks.ts `unstarted`), until it connects. */
  let unstarted = false
  let held: Held[] = []
  let heldBytes = 0
  let startTimer: unknown = null

  const tell = (connId: string, type: string, frame: Record<string, unknown>): boolean =>
    channel.buffered() <= VIEWERS_BUFFER_LIMIT && notify({ type: 'service_event', payload: { kind: 'stream', connId, type, frame } })
  /** A stream's frame nobody will take ends that stream on the client's side; a close needs no answer. */
  const refuse = (connId: string, type: string, frame: Record<string, unknown>): void => {
    if (type !== 'viewer_close' && viewerStreamId(frame.streamId)) core.clients.viewerFrame(connId, 'viewer_close', { streamId: frame.streamId, error: NOT_SERVED })
  }
  const release = (): Held[] => {
    const frames = held
    held = []
    heldBytes = 0
    if (startTimer !== null) clearTimer(startTimer)
    startTimer = null
    return frames
  }
  /** Held for a process not yet connected, within the bound a hung process's socket gets: past it, refused. */
  const hold = (connId: string, type: string, frame: Record<string, unknown>): boolean => {
    const bytes = JSON.stringify(frame).length
    if (heldBytes + bytes > VIEWERS_BUFFER_LIMIT) return false
    held.push({ connId, type, frame, bytes })
    heldBytes += bytes
    if (startTimer === null) {
      demand!.wake('a viewer stream')
      startTimer = setTimer(() => {
        startTimer = null
        unstarted = true
        for (const each of release()) refuse(each.connId, each.type, each.frame)
      }, demand!.startWaitMs ?? ON_DEMAND_START_MS)
    }
    return true
  }

  const port: ViewersPort = {
    forwardingUrl: (agentId) => known.get(agentId)?.forwardingUrl ?? null,
    // The viewers are the process's: a core restarting or stopping leaves them running for the next core,
    // and the master stops the process itself when the daemon stops.
    stop: async () => {},
    stream: (connId, type, frame) => seen || unstarted ? tell(connId, type, frame) : hold(connId, type, frame),
    surface: (connId, payload) => channel.call('surface', { ...payload, connId }, SURFACE_WAIT_MS),
    closed: (connId) => {
      // What it held for the connection goes with it: nobody is left to read the answer.
      held = held.filter((each) => connId !== undefined && each.connId !== connId)
      heldBytes = held.reduce((sum, each) => sum + each.bytes, 0)
      notify({ type: 'service_event', payload: { kind: 'closed', ...(connId === undefined ? {} : { connId }) } })
    },
  }

  /** What the process tells the core without asking: a stream's frame for one client's connection. */
  const notice = (payload: Record<string, unknown>): void => {
    if (payload.kind !== 'viewer' || typeof payload.connId !== 'string' || typeof payload.type !== 'string') return
    const frame = payload.payload && typeof payload.payload === 'object' ? payload.payload as Record<string, unknown> : {}
    if (core.clients.viewerFrame(payload.connId, payload.type, frame)) return
    // Not delivered: the stream ends in the process too, without another word to a client it cannot reach.
    if (payload.type !== 'viewer_close' && viewerStreamId(frame.streamId)) {
      port.stream(payload.connId, 'viewer_close', { streamId: frame.streamId, error: 'Viewer connection closed' })
    }
  }

  /** The process reports only the current forwarding target for a live harness. */
  const heard = (payload: Record<string, unknown>): Record<string, unknown> => {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    if (!attached.has(agentId)) return { kept: false }
    const next: Known = {
      forwardingUrl: typeof payload.forwardingUrl === 'string' ? payload.forwardingUrl : null,
    }
    const before = known.get(agentId)
    if (JSON.stringify(before) === JSON.stringify(next)) return { kept: true }
    known.set(agentId, next)
    return { kept: true }
  }

  return {
    port,
    notice,
    /** Follow the agents with a harness (core/agentLife.ts): the ones the core keeps the process's word on, and a look
     *  at one asks for the process, which runs only once there is one. Only while the viewers run in their own
     *  process: in the core's, the service follows them itself. */
    follow(): () => void {
      return core.agents.follow?.((event) => {
        if (event.kind === 'running') {
          attached.add(event.session.agentId)
          demand?.wake('a harness here')
        } else if (event.kind === 'ended') {
          attached.delete(event.agentId)
          known.delete(event.agentId)
        }
      }, VIEWERS_FOLLOW) ?? (() => {})
    },
    /** The process connected: the streams held for it go to it, in the order they came. */
    connected(): void {
      seen = true
      unstarted = false
      for (const each of release()) if (!tell(each.connId, each.type, each.frame)) refuse(each.connId, each.type, each.frame)
    },
    /** The core's answers to the viewers' questions (core/serviceLinks.ts `answer`, for `viewers`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      if (query === 'viewer_target') return heard(payload)
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}

export type ViewersLink = ReturnType<typeof createViewersLink>
