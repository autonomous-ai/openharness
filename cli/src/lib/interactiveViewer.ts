import { ViewerCapture, viewerTarget } from '../sharing/viewer.js'
import { viewerStreamId } from './viewerFrames.js'

type Payload = Record<string, unknown>
type Command = { method: string; params: Payload }
export type Frame = { width: number; height: number; scale: number; mobile: boolean; touch: boolean
  dark: boolean; reload: boolean; commands: Command[]; copy: 'copy' | 'cut' | null }
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max
const coordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean'
// Editing commands a Mac only gets through CDP when named: ⌘A/⌘Z do nothing as bare key events.
// Clipboard is not here: it travels as `copy`/`cut` events (read back in the reply) and `text` (a paste).
const KEY_COMMANDS = new Set(['selectAll', 'undo', 'redo'])
const TOUCH_EVENTS = ['touchStart', 'touchMove', 'touchEnd', 'touchCancel']
/** About 2560×1640 at scale 1, or a 1440×900 pane at scale 1.8: what one relay hop carries comfortably. */
export const MAX_SURFACE_PIXELS = 4_200_000

/** The client's pixel density, lowered until one frame fits [MAX_SURFACE_PIXELS]. */
export function surfaceScale(width: number, height: number, asked: number): number {
  const fit = Math.sqrt(MAX_SURFACE_PIXELS / (width * height))
  return Math.max(0.5, Math.floor(Math.min(asked, fit) * 100) / 100)
}

/** Viewers can request only navigation. Flutter additionally verifies the owning DSH and active tab. */
export function monitorHostActions(value: unknown): Payload[] {
  if (!Array.isArray(value) || value.length > 8) return []
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 160
  return value.flatMap<Payload>(action => {
    if (!action || typeof action !== 'object') return []
    if (action.action === 'assistant') return [{ action: 'assistant', chooseModel: action.chooseModel === true }]
    if (action.action === 'open' && id(action.machineId) && id(action.agentId)) return [{ action: 'open', machineId: action.machineId, agentId: action.agentId }]
    return []
  })
}

/** Deliberately not a general CDP bridge: a browser can only send ordinary viewer input. */
export function surfaceFrame(payload: Payload): Frame | null {
  if (!integer(payload.width, 160, 3840) || !integer(payload.height, 120, 2400)
    || typeof payload.dark !== 'boolean' || !optionalBoolean(payload.reload)
    || !optionalBoolean(payload.mobile) || !optionalBoolean(payload.touch)
    || (payload.scale !== undefined && (typeof payload.scale !== 'number' || !(payload.scale >= 1 && payload.scale <= 3)))) return null
  const width = payload.width, height = payload.height
  const events = payload.events ?? []
  if (!Array.isArray(events) || events.length > 64) return null
  const commands: Command[] = []
  let copy: Frame['copy'] = null
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null
    if (event.type === 'text') {
      if (typeof event.text !== 'string' || !event.text.length || event.text.length > 65_536) return null
      commands.push({ method: 'Input.insertText', params: { text: event.text } })
    } else if (event.type === 'key') {
      if (!['keyDown', 'keyUp'].includes(event.event) || typeof event.key !== 'string'
        || event.key.length < 1 || event.key.length > 64 || typeof event.code !== 'string' || event.code.length > 64
        || !integer(event.keyCode, 0, 255) || !integer(event.modifiers, 0, 15)) return null
      if (event.text !== undefined && (event.event !== 'keyDown' || typeof event.text !== 'string'
        || !event.text.length || event.text.length > 8)) return null
      if (event.commands !== undefined && (!Array.isArray(event.commands) || event.commands.length > 4
        || !event.commands.every((c: unknown) => typeof c === 'string' && KEY_COMMANDS.has(c)))) return null
      const text = event.text ?? (event.event === 'keyDown' && event.key === 'Enter' ? '\r' : undefined)
      commands.push({ method: 'Input.dispatchKeyEvent', params: {
        type: event.event, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode,
        modifiers: event.modifiers, ...(text !== undefined ? { text } : {}),
        ...(event.commands?.length ? { commands: event.commands } : {}),
      } })
    } else if (event.type === 'pointer') {
      if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(event.event)
        || !coordinate(event.x) || !coordinate(event.y) || !integer(event.buttons, 0, 7)
        || !['none', 'left', 'right', 'middle'].includes(event.button) || !integer(event.modifiers, 0, 15)
        || !integer(event.clickCount, 0, 2)) return null
      const params: Payload = { type: event.event, x: event.x * (width - 1), y: event.y * (height - 1),
        buttons: event.buttons, button: event.button, modifiers: event.modifiers, clickCount: event.clickCount }
      if (event.event === 'mouseWheel') {
        if (typeof event.deltaX !== 'number' || !Number.isFinite(event.deltaX) || Math.abs(event.deltaX) > 2000
          || typeof event.deltaY !== 'number' || !Number.isFinite(event.deltaY) || Math.abs(event.deltaY) > 2000) return null
        params.deltaX = event.deltaX; params.deltaY = event.deltaY
      }
      commands.push({ method: 'Input.dispatchMouseEvent', params })
    } else if (event.type === 'touch') {
      if (!TOUCH_EVENTS.includes(event.event) || !integer(event.modifiers, 0, 15)
        || !Array.isArray(event.points) || event.points.length > 5
        // A start or move with no finger is not a touch; an end or cancel names the finger(s) lifted.
        || (!event.points.length && (event.event === 'touchStart' || event.event === 'touchMove'))) return null
      const touchPoints: Payload[] = []
      for (const point of event.points) {
        if (!point || typeof point !== 'object' || !coordinate(point.x) || !coordinate(point.y) || !integer(point.id, 0, 31)) return null
        touchPoints.push({ x: point.x * (width - 1), y: point.y * (height - 1), id: point.id })
      }
      commands.push({ method: 'Input.dispatchTouchEvent', params: { type: event.event, touchPoints, modifiers: event.modifiers } })
    } else if (event.type === 'copy' || event.type === 'cut') {
      copy = event.type
    } else return null
  }
  const scale = surfaceScale(width, height, typeof payload.scale === 'number' ? payload.scale : 1)
  return { width, height, scale, mobile: payload.mobile === true, touch: payload.touch === true,
    dark: payload.dark, reload: payload.reload === true, commands, copy }
}


/** Longest base64 screencast frame one relay reply carries. */
const MAX_FRAME_BASE64 = 2 * 1024 * 1024

export interface Shot { seq: number; data: string }

/** Separate from the read-only observer renderer. No cookies, profile, or app credentials. */
export class InteractiveViewerCapture extends ViewerCapture {
  private geometry = ''
  private size = { width: 1280, height: 800, scale: 1 }
  private dark: boolean | null = null
  private touch = false
  private casting = false
  private latest: Shot | null = null
  private seq = 0
  // seq when the current screencast started: a frame at or below it is from before (a resize leaves the old size's frame in `latest`).
  private castSeq = 0
  // The screencast frame Chrome waits on. Acked only when a surface takes it: Chrome sends the next
  // frame after the ack, so an unwatched page (a three.js scene drawing at 60 fps) costs nothing, and
  // the frame rate follows how fast the client reads.
  private unacked: number | null = null
  private waiters = new Set<() => void>()

  get frameSeq(): number { return this.seq }

  async takeHostActions(target: string): Promise<Payload[]> {
    const origin = JSON.stringify(new URL(target).origin)
    const reply = await this.call('Runtime.evaluate', { expression:
      `location.origin === ${origin} ? (window.harnessEmbedded = true, Array.isArray(window.harnessHostQueue) ? window.harnessHostQueue.splice(0, 8) : []) : []`,
      returnByValue: true })
    const result = reply.result as { value?: unknown } | undefined
    return monitorHostActions(result?.value)
  }

  protected override onEvent(method: string, params: Payload): void {
    if (method !== 'Page.screencastFrame' || typeof params.sessionId !== 'number') return
    if (typeof params.data !== 'string' || params.data.length > MAX_FRAME_BASE64) {
      // Too large for one reply: skip it, and ack so Chrome keeps sending smaller ones.
      void this.call('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
      return
    }
    this.unacked = params.sessionId
    this.latest = { seq: ++this.seq, data: params.data }
    this.wake()
  }

  async apply(frame: Frame): Promise<void> {
    const geometry = `${frame.width}x${frame.height}@${frame.scale}${frame.mobile ? 'm' : ''}`
    if (geometry !== this.geometry) {
      await this.call('Emulation.setDeviceMetricsOverride', {
        width: frame.width, height: frame.height, deviceScaleFactor: frame.scale, mobile: frame.mobile,
      })
      this.geometry = geometry
      this.size = { width: frame.width, height: frame.height, scale: frame.scale }
      // maxWidth/maxHeight are fixed when a screencast starts: a new size needs a new screencast.
      if (this.casting) await this.cast()
    }
    if (frame.touch !== this.touch) {
      await this.call('Emulation.setTouchEmulationEnabled', { enabled: frame.touch, maxTouchPoints: frame.touch ? 5 : 1 })
      this.touch = frame.touch
    }
    if (frame.reload) await this.call('Page.reload')
    if (frame.dark !== this.dark || frame.reload) {
      await this.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: frame.dark ? 'dark' : 'light' }] })
      this.dark = frame.dark
    }
    for (const command of frame.commands) await this.call(command.method, command.params)
  }

  /** v1: one request, one screenshot — what a client that predates `after` still gets. */
  async frame(frame: Frame): Promise<string> {
    await this.apply(frame)
    return this.capture()
  }

  private async cast(): Promise<void> {
    if (this.casting) {
      await this.call('Page.stopScreencast')
      // Not casting from here: if the start below fails, the next poll must start again instead of freezing on a dead stream.
      this.casting = false
    }
    this.unacked = null
    this.castSeq = this.seq
    await this.call('Page.startScreencast', { format: 'jpeg', quality: 75,
      maxWidth: Math.round(this.size.width * this.size.scale), maxHeight: Math.round(this.size.height * this.size.scale) })
    this.casting = true
  }

  async next(after: number, waitMs: number): Promise<Shot | null> {
    if (!this.casting) await this.cast()
    let woken = false
    if (!this.latest || this.latest.seq <= after) {
      woken = await new Promise<boolean>(resolve => {
        const done = (byWake: boolean) => { clearTimeout(timer); this.waiters.delete(wake); resolve(byWake) }
        const wake = () => done(true)
        const timer = setTimeout(() => done(false), waitMs)
        this.waiters.add(wake)
      })
    }
    // A page that has not painted since the screencast started sends nothing: once the wait runs
    // out (not when a newer poll or a close ended it), show the page as it is.
    // "Nothing yet" also covers a resize on a static page, whose only frame is the old size's.
    const fresh = () => this.latest && this.latest.seq > this.castSeq
    let screenshotted = false
    if (!woken && !fresh()) {
      try {
        const data = await this.capture()
        // A real frame that landed during the screenshot is newer than it: keep that one.
        if (!fresh()) { this.latest = { seq: ++this.seq, data }; screenshotted = true }
      } catch (error) {
        // A refused or oversized screenshot tears the surface down; while a screencast frame exists, show that instead.
        if (!this.latest) throw error
      }
    }
    let shot = this.latest
    if (!shot || shot.seq <= after) return null
    // Chrome's screencast ignores deviceScaleFactor and sends CSS-pixel frames; a screenshot honours it.
    // The screencast stays the change signal and the backpressure; only the pixels come from a screenshot.
    // ponytail: one extra screenshot round trip per frame on dense screens; launch each renderer with --force-device-scale-factor to drop it if latency matters
    if (!screenshotted && this.size.scale > 1) {
      const cast = shot
      try { shot = { seq: cast.seq, data: await this.capture() } } catch { shot = cast }
    }
    if (this.unacked !== null) {
      const sessionId = this.unacked; this.unacked = null
      void this.call('Page.screencastFrameAck', { sessionId }).catch(() => {})
    }
    return shot
  }

  /** A poll waiting on a renderer that is going away should end now, not after its wait. */
  override async stop(): Promise<void> {
    this.wake()
    await super.stop()
  }

  wake(): void {
    for (const done of [...this.waiters]) done()
  }

  private async evaluate(expression: string): Promise<unknown> {
    const reply = await this.call('Runtime.evaluate', { expression, returnByValue: true })
    return (reply.result as { value?: unknown } | undefined)?.value
  }

  async editable(): Promise<boolean> {
    return await this.evaluate(`(() => { const e = document.activeElement; if (!e) return false;
      if (e.isContentEditable || e.tagName === 'TEXTAREA') return true;
      return e.tagName === 'INPUT' && !['button','checkbox','radio','submit','reset','file','image','range','color','hidden'].includes(e.type) })()`) === true
  }

  async selection(): Promise<string> {
    const value = await this.evaluate(`(() => { const e = document.activeElement;
      if (e && typeof e.value === 'string' && typeof e.selectionStart === 'number') return e.value.slice(e.selectionStart, e.selectionEnd);
      return String(getSelection() ?? '') })()`)
    return typeof value === 'string' ? value.slice(0, 1_000_000) : ''
  }

  async deleteSelection(): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) {
      await this.call('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, modifiers: 0 })
    }
  }
}

/** Where a pushed surface's frames and answers go: frames over the client's viewer channel, answers over the relay. */
export interface PushSink {
  /** false: the channel cannot take it (closed, or never opened), so pushing must stop. */
  frame(connId: string, surfaceId: string, shot: { seq: number; jpeg: Buffer; width: number; height: number; scale: number }): boolean
  state(connId: string, payload: Payload): void   // surface_state / surface_error to the client
}

interface Push {
  sink: PushSink
  surfaceId: string
  open: string             // the client's id for this open, echoed on everything said about it: answers about a push it replaced are not its
  sent: number[]           // seqs pushed and not yet acked; two at most
  after: number
  looping: boolean
  ready: boolean           // start and the open's apply are done: before that, next() would race them or fail on a renderer still launching
  timer?: NodeJS.Timeout   // armed while out of credit
}

/** At most this many frames un-acked per pushed surface: a slow client slows Chrome instead of queueing JPEGs. */
const PUSH_CREDIT = 2
/** The gateway drops a frame silently when the viewer channel closes or stays full this long, so no ack ever
 *  comes for it: after this much silence with no credit left, the outstanding frames count as lost. */
const ACK_TIMEOUT_MS = 5_000
/** Push surfaces become binary streamIds (`surfaceStreamId`): only the 32-hex ids clients mint qualify. */
const PUSH_SURFACE_ID = /^[0-9a-f]{32}$/
/** The open id a client frame names, echoed on its answer when it is one a client could have minted. The
 *  core's rule (`viewerStreamId`), so an id the machine echoes is one the core would echo too. */
const openOf = ({ open }: Payload): Payload => (viewerStreamId(open) ? { open } : {})

interface Surface {
  connId: string
  agentId: string
  target: string
  capture: InteractiveViewerCapture
  starting: Promise<void> | null
  busy: boolean            // a v1 frame is in flight: v1 clients pull one frame at a time
  chain: Promise<unknown>  // every CDP command for this surface, in order
  queued: number           // input events waiting on the chain
  poll: number             // the newest frame poll; an older one answers `unchanged`
  actionsAt: number
  timer: NodeJS.Timeout
  size: { width: number; height: number; scale: number }  // the geometry last asked for, sent with pushed frames
  push?: Push              // the client takes frames pushed over its viewer channel instead of long-polling
}

/** Owner-only, bounded renderers. One frame in flight per surface, so a slow client cannot accumulate JPEGs. */
export class InteractiveViewers {
  private readonly surfaces = new Map<string, Surface>()
  constructor(private readonly target: (agentId: string) => string | null,
    private readonly create = () => new InteractiveViewerCapture()) {}

  /** The owner's ids, checked the same way for the WS long-poll and for push. null: invalid or another agent's. */
  private find(connId: string, payload: Payload): { key: string; surface?: Surface } | null {
    const { surfaceId, agentId } = payload
    if (typeof surfaceId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(surfaceId)
      || typeof agentId !== 'string' || !agentId.length || agentId.length > 160
      || (payload.after !== undefined && !integer(payload.after, 0, Number.MAX_SAFE_INTEGER))) return null
    const key = `${connId}/${surfaceId}`
    const surface = this.surfaces.get(key)
    return surface && surface.agentId !== agentId ? null : { key, surface }
  }

  /** The surface a frame or input lands on: created or reused under the same limits, its idle timer refreshed. */
  private acquire(connId: string, key: string, surface: Surface | undefined, payload: Payload,
    agentId: string): { live: Surface; frame: Frame } | { error: string; detail?: string } {
    const frame = surfaceFrame(payload)
    if (!frame) return { error: 'INVALID_VIEWER_REQUEST' }
    const target = viewerTarget(this.target(agentId))
    if (!target) { this.remove(key); return { error: 'VIEWER_UNAVAILABLE', detail: 'This harness has no live viewer yet.' } }
    if (surface && surface.target !== target) { this.remove(key); surface = undefined }
    if (!surface) {
      if (this.surfaces.size >= 8 || [...this.surfaces.values()].filter(s => s.connId === connId).length >= 4) {
        return { error: 'VIEWER_LIMIT', detail: 'Close another viewer to open this one.' }
      }
      surface = { connId, agentId, target, capture: this.create(), starting: null, busy: false,
        chain: Promise.resolve(), queued: 0, poll: 0, actionsAt: 0, timer: setTimeout(() => this.remove(key), 30_000),
        size: { width: frame.width, height: frame.height, scale: frame.scale } }
      surface.timer.unref()
      this.surfaces.set(key, surface)
    }
    surface.timer.refresh()
    surface.size = { width: frame.width, height: frame.height, scale: frame.scale }
    return { live: surface, frame }
  }

  // Through the chain: input and a frame's viewport change must reach Chrome in arrival order.
  private run<T>(live: Surface, work: () => Promise<T>): Promise<T> {
    const result = live.chain.then(work)
    live.chain = result.catch(() => {})
    return result
  }

  /** Base64 bytes of frames served to WS long-poll clients, in all (`viewerWsBytes`) and per connection; the counterpart of the gateway's `viewerP2pBytes`. */
  viewerWsBytes = 0
  private readonly connBytes = new Map<string, number>()

  async request(connId: string, payload: Payload): Promise<Payload> {
    const reply = await this.serve(connId, payload)
    if (payload.op === 'frame' && typeof reply.data === 'string') {
      this.viewerWsBytes += reply.data.length
      this.connBytes.set(connId, (this.connBytes.get(connId) ?? 0) + reply.data.length)
    }
    return reply
  }

  private async serve(connId: string, payload: Payload): Promise<Payload> {
    const { op } = payload
    const found = this.find(connId, payload)
    if (!found || !['frame', 'input', 'close'].includes(String(op))) return { error: 'INVALID_VIEWER_REQUEST' }
    const { key } = found
    if (op === 'close') { this.remove(key, true); return { closed: true } }
    const acquired = this.acquire(connId, key, found.surface, payload, String(payload.agentId))
    if ('error' in acquired) return acquired
    const { live, frame } = acquired
    const target = live.target
    const gone = () => this.surfaces.get(key) !== live
    // A frame request means the client now pulls over WS, typically because its viewer channel died, which the
    // machine is never told: pushing on would only feed a dead sink. Input stays, since surface_input comes this way.
    if (op === 'frame') this.stopPush(live)
    try {
      if (op === 'input') {
        if (live.queued + frame.commands.length > 256) return { error: 'VIEWER_BUSY' }
        live.queued += frame.commands.length
        try {
          await (live.starting ??= live.capture.start(target))
          const reply = await this.run(live, async () => {
            await live.capture.apply(frame)
            const clipboard = frame.copy ? await live.capture.selection() : ''
            const editable = await live.capture.editable()
            // ⌘C/⌘X with nothing selected must not wipe the client's clipboard, and a Delete
            // with no selection would eat the character after the caret.
            if (frame.copy === 'cut' && editable && clipboard) await live.capture.deleteSelection()
            return { ok: true, seq: live.capture.frameSeq, editable, ...(clipboard ? { clipboard } : {}) }
          })
          return gone() ? { error: 'VIEWER_CLOSED' } : reply
        } finally { live.queued -= frame.commands.length }
      }
      if (payload.after === undefined) {
        // v1: the client predates long-polling and pulls one frame at a time.
        if (live.busy) return { error: 'VIEWER_BUSY' }
        live.busy = true
        try {
          await (live.starting ??= live.capture.start(target))
          if (gone()) return { error: 'VIEWER_CLOSED' }
          const data = await this.run(live, () => live.capture.frame(frame))
          const hostActions = await live.capture.takeHostActions(target)
          if (gone()) return { error: 'VIEWER_CLOSED' }
          return { data, mime: 'image/jpeg', width: frame.width, height: frame.height, scale: frame.scale, seq: live.capture.frameSeq, hostActions }
        } finally { live.busy = false }
      }
      const poll = ++live.poll
      live.capture.wake()
      await (live.starting ??= live.capture.start(target))
      await this.run(live, () => live.capture.apply(frame))
      // A newer poll took over while this one waited to start or apply: it would only wait out its second for nothing.
      if (gone()) return { error: 'VIEWER_CLOSED' }
      if (poll !== live.poll) return { seq: live.capture.frameSeq, unchanged: true }
      // A recreated surface restarts at seq 0 while the client still holds its old one; waiting for a frame
      // "after" a number the capture never reaches would leave Chrome unacked and the view frozen.
      const shot = await live.capture.next(Math.min(Number(payload.after), live.capture.frameSeq), 1000)
      if (gone()) return { error: 'VIEWER_CLOSED' }
      // The host queue is the Monitor's navigation; twice a second is plenty, and each read is a CDP round trip.
      // It is read on an unchanged reply too: a static page sends no frames, and its navigation must not stall.
      let hostActions: Payload[] = []
      if (poll === live.poll && Date.now() - live.actionsAt >= 500) {
        live.actionsAt = Date.now(); hostActions = await live.capture.takeHostActions(target)
        if (gone()) return { error: 'VIEWER_CLOSED' }
      }
      if (poll !== live.poll || !shot) {
        return { seq: live.capture.frameSeq, unchanged: true, ...(hostActions.length ? { hostActions } : {}) }
      }
      return { data: shot.data, mime: 'image/jpeg', width: frame.width, height: frame.height, scale: frame.scale, seq: shot.seq, hostActions }
    } catch (error) {
      // Closing the surface stops its capture, which fails whatever was in flight: that is a close, not a fault.
      if (gone()) return { error: 'VIEWER_CLOSED' }
      this.remove(key)
      return { error: 'VIEWER_UNAVAILABLE', detail: error instanceof Error ? error.message : 'The viewer could not start.' }
    }
  }

  /** The viewer-channel path: `surface_*` frames from the owner's client; answers go to the sink, never as a reply. */
  push(connId: string, type: 'surface_open' | 'surface_input' | 'surface_ack' | 'surface_close', payload: Payload, sink: PushSink): void {
    const { surfaceId } = payload
    const fail = (error: Payload) => sink.state(connId, { type: 'surface_error', surfaceId, ...error, ...openOf(payload) })
    // The push this ack or input was for is gone (the sink refused, the viewers restarted, the surface expired): the
    // client hears it, or its keepalive would go unanswered and its view stay frozen on the last frame.
    const closed = (extra: Payload = {}) => fail({ error: 'VIEWER_CLOSED', detail: 'The viewer stopped sending frames.', ...extra })
    if (typeof surfaceId !== 'string' || !PUSH_SURFACE_ID.test(surfaceId)) return fail({ error: 'INVALID_VIEWER_REQUEST' })
    const key = `${connId}/${surfaceId}`
    if (type === 'surface_close') return this.remove(key, true)
    if (type === 'surface_ack') {
      if (!integer(payload.seq, 0, Number.MAX_SAFE_INTEGER)) return fail({ error: 'INVALID_VIEWER_REQUEST' })
      const live = this.surfaces.get(key), push = live?.push
      if (!live || !push) return closed()
      // The keepalive is the client's: it repeats its last ack every 10 s while the surface is on screen. The
      // machine never keeps a pushed surface alive by itself, so a hidden or backgrounded client lets it expire
      // after 30 s instead of costing Chrome two frames every 5 s for hours.
      live.timer.refresh()
      // Cumulative: frames ride one ordered channel, so a frame acked after an older one means the older one was dropped.
      const outstanding = push.sent.length
      push.sent = push.sent.filter(seq => seq > Number(payload.seq))
      // A repeated or stale ack frees nothing: it must not postpone the ack timeout's recovery of lost frames.
      if (push.sent.length === outstanding) return
      clearTimeout(push.timer); push.timer = undefined
      if (push.ready) void this.pump(key, live, push)
      return
    }
    if (type === 'surface_input') {
      const { input } = payload
      // The core's rule for ids it echoes, so an input the machine answers is one the core would name too.
      if (!viewerStreamId(input)) return fail({ error: 'INVALID_VIEWER_REQUEST' })
      // Input rides the channel only while it pushes; another agent's ids fall through to be refused as invalid.
      // Refused before request() runs, so nothing reached Chrome: `unapplied` lets the client send it again over
      // WS. A VIEWER_CLOSED from request() itself never says so, as its commands may already have been applied.
      const found = this.find(connId, payload)
      if (found && !found.surface?.push) return closed({ input, unapplied: true })
      // The same path as the long-poll's input: copy/cut rules, the CDP chain, the queue cap.
      void this.request(connId, { ...payload, op: 'input' }).then(({ ok: _, ...reply }) =>
        sink.state(connId, { type: 'error' in reply ? 'surface_error' : 'surface_state', surfaceId, input, ...reply, ...openOf(payload) }))
        .catch(() => {})  // a sink that cannot deliver has nobody to tell
      return
    }
    if (type !== 'surface_open') return fail({ error: 'INVALID_VIEWER_REQUEST' })
    const found = this.find(connId, payload)
    // Validated before the old push is dropped: a malformed reopen must not stop a stream that works.
    const { open } = openOf(payload)
    if (!found || !surfaceFrame(payload) || typeof open !== 'string') return fail({ error: 'INVALID_VIEWER_REQUEST' })
    // A reopen (after lost frames, or back from the WS long-poll) replaces the push: full credit, from where the
    // client is. Dropped first, so a surface recreated for a new target does not tell this same client it closed.
    if (found.surface) this.stopPush(found.surface)
    const acquired = this.acquire(connId, key, found.surface, payload, String(payload.agentId))
    if ('error' in acquired) return fail(acquired)
    const { live, frame } = acquired
    // Clamped like the long-poll: a recreated surface restarts at seq 0 while the client still holds its old one.
    const push: Push = live.push = { sink, surfaceId, open, sent: [], looping: false, ready: false,
      after: Math.min(Number(payload.after ?? 0), live.capture.frameSeq) }
    void (async () => {
      try {
        await (live.starting ??= live.capture.start(live.target))
        await this.run(live, () => live.capture.apply(frame))
      } catch (error) { return this.broken(key, live, push, error) }
      push.ready = true
      await this.pump(key, live, push)
    })()
  }

  /** Sends frames while the client has credit, then waits for an ack (or the ack timeout) to go on. */
  private async pump(key: string, live: Surface, push: Push): Promise<void> {
    if (push.looping) return
    push.looping = true
    const active = () => this.surfaces.get(key) === live && live.push === push
    try {
      while (active() && push.sent.length < PUSH_CREDIT) {
        const shot = await live.capture.next(push.after, 1000)
        if (!active()) return
        // As on the long-poll: the Monitor's navigation at most twice a second, read on an empty wait too,
        // since a static page sends no frames and its navigation must not stall.
        if (Date.now() - live.actionsAt >= 500) {
          live.actionsAt = Date.now()
          const hostActions = await live.capture.takeHostActions(live.target)
          if (!active()) return
          if (hostActions.length) push.sink.state(live.connId, { type: 'surface_state', surfaceId: push.surfaceId, seq: live.capture.frameSeq, hostActions, open: push.open })
        }
        if (!shot) continue
        push.after = shot.seq; push.sent.push(shot.seq)
        if (!push.sink.frame(live.connId, push.surfaceId, { seq: shot.seq, jpeg: Buffer.from(shot.data, 'base64'), ...live.size })) {
          // The channel cannot take it: stop, and say so over the relay (best effort), since the client may wait
          // on this frame. It long-polls this same surface over WS, then reopens.
          live.push = undefined
          push.sink.state(live.connId, { type: 'surface_error', surfaceId: push.surfaceId, error: 'VIEWER_CLOSED',
            detail: 'The viewer channel did not take a frame.', open: push.open })
          return
        }
      }
      if (active()) {
        clearTimeout(push.timer)  // one timeout per push, whatever restarted the loop
        push.timer = setTimeout(() => { push.timer = undefined; push.sent = []; void this.pump(key, live, push) }, ACK_TIMEOUT_MS)
        push.timer.unref()
      }
    } catch (error) {
      this.broken(key, live, push, error)
    } finally { push.looping = false }
  }

  /** A capture failed under a pushed surface: release it and say why, since no request is waiting to hear it. */
  private broken(key: string, live: Surface, push: Push, error: unknown): void {
    // Closing the surface stops its capture, which fails whatever was in flight: that is a close, not a fault.
    if (this.surfaces.get(key) !== live || live.push !== push) return
    this.remove(key, true)
    push.sink.state(live.connId, { type: 'surface_error', surfaceId: push.surfaceId, error: 'VIEWER_UNAVAILABLE',
      detail: error instanceof Error ? error.message : 'The viewer could not start.', open: push.open })
  }

  private stopPush(live: Surface): void {
    if (!live.push) return
    clearTimeout(live.push.timer); live.push = undefined
    // Its loop may be waiting on a frame: end that wait now (the loop then sees it is no longer the push).
    live.capture.wake()
  }

  /** quiet: the client closed it or is gone; otherwise a pushing client hears VIEWER_CLOSED, as it has no poll to answer. */
  private remove(key: string, quiet = false): void {
    const surface = this.surfaces.get(key)
    if (!surface) return
    this.surfaces.delete(key); clearTimeout(surface.timer); clearTimeout(surface.push?.timer)
    if (surface.push && !quiet) surface.push.sink.state(surface.connId, { type: 'surface_error', surfaceId: surface.push.surfaceId, error: 'VIEWER_CLOSED', open: surface.push.open })
    surface.capture.wake()
    void surface.capture.stop().catch(() => {})
  }
  refresh(agentId: string): void {
    const target = viewerTarget(this.target(agentId))
    for (const [key, surface] of this.surfaces) {
      if (surface.agentId === agentId && surface.target !== target) this.remove(key)
    }
  }
  closeConnection(connId: string): void {
    for (const [key, surface] of this.surfaces) if (surface.connId === connId) this.remove(key, true)
    const bytes = this.connBytes.get(connId)
    if (bytes !== undefined) console.warn(`[viewer-ws] ${connId.slice(0, 8)} closed bytes=${bytes} total=${this.viewerWsBytes}`)
    this.connBytes.delete(connId)
  }
  closeAll(): void { for (const key of this.surfaces.keys()) this.remove(key, true) }
}
