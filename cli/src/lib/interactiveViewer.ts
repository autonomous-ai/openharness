import { ViewerCapture, viewerTarget } from '../sharing/viewer.js'

type Payload = Record<string, unknown>
type Command = { method: string; params: Payload }
type Frame = { width: number; height: number; dark: boolean; reload: boolean; commands: Command[] }
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max
const coordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

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
  if (!integer(payload.width, 160, 1920) || !integer(payload.height, 120, 1200)
    || typeof payload.dark !== 'boolean' || (payload.reload !== undefined && typeof payload.reload !== 'boolean')) return null
  const events = payload.events ?? []
  if (!Array.isArray(events) || events.length > 64) return null
  const commands: Command[] = []
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null
    if (event.type === 'text') {
      if (typeof event.text !== 'string' || !event.text.length || event.text.length > 4096) return null
      commands.push({ method: 'Input.insertText', params: { text: event.text } })
    } else if (event.type === 'key') {
      if (!['keyDown', 'keyUp'].includes(event.event) || typeof event.key !== 'string'
        || event.key.length < 1 || event.key.length > 64 || typeof event.code !== 'string' || event.code.length > 64
        || !integer(event.keyCode, 0, 255) || !integer(event.modifiers, 0, 15)) return null
      commands.push({ method: 'Input.dispatchKeyEvent', params: {
        type: event.event, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode,
        modifiers: event.modifiers, ...(event.event === 'keyDown' && event.key === 'Enter' ? { text: '\r' } : {}),
      } })
    } else if (event.type === 'pointer') {
      if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(event.event)
        || !coordinate(event.x) || !coordinate(event.y) || !integer(event.buttons, 0, 7)
        || !['none', 'left', 'right', 'middle'].includes(event.button) || !integer(event.modifiers, 0, 15)
        || !integer(event.clickCount, 0, 2)) return null
      const params: Payload = { type: event.event, x: event.x * (payload.width - 1), y: event.y * (payload.height - 1),
        buttons: event.buttons, button: event.button, modifiers: event.modifiers, clickCount: event.clickCount }
      if (event.event === 'mouseWheel') {
        if (typeof event.deltaX !== 'number' || !Number.isFinite(event.deltaX) || Math.abs(event.deltaX) > 2000
          || typeof event.deltaY !== 'number' || !Number.isFinite(event.deltaY) || Math.abs(event.deltaY) > 2000) return null
        params.deltaX = event.deltaX; params.deltaY = event.deltaY
      }
      commands.push({ method: 'Input.dispatchMouseEvent', params })
    } else return null
  }
  return { width: payload.width, height: payload.height, dark: payload.dark, reload: payload.reload === true, commands }
}

/** Separate from the read-only observer renderer. No cookies, profile, or app credentials. */
export class InteractiveViewerCapture extends ViewerCapture {
  private geometry = ''
  private dark: boolean | null = null
  async takeHostActions(target: string): Promise<Payload[]> {
    const origin = JSON.stringify(new URL(target).origin)
    const reply = await this.call('Runtime.evaluate', { expression:
      `location.origin === ${origin} ? (window.harnessEmbedded = true, Array.isArray(window.harnessHostQueue) ? window.harnessHostQueue.splice(0, 8) : []) : []`,
      returnByValue: true })
    const result = reply.result as { value?: unknown } | undefined
    return monitorHostActions(result?.value)
  }
  async frame(frame: Frame): Promise<string> {
    const geometry = `${frame.width}x${frame.height}`
    if (geometry !== this.geometry) {
      await this.call('Emulation.setDeviceMetricsOverride', {
        width: frame.width, height: frame.height, deviceScaleFactor: 1, mobile: false,
      })
      this.geometry = geometry
    }
    if (frame.reload) await this.call('Page.reload')
    if (frame.dark !== this.dark || frame.reload) {
      await this.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: frame.dark ? 'dark' : 'light' }] })
      this.dark = frame.dark
    }
    for (const command of frame.commands) await this.call(command.method, command.params)
    return this.capture()
  }
}

interface Surface {
  connId: string
  agentId: string
  target: string
  capture: InteractiveViewerCapture
  started: boolean
  busy: boolean
  timer: NodeJS.Timeout
}

/** Owner-only, bounded renderers. Frames are pulled, so a slow client cannot accumulate JPEGs. */
export class InteractiveViewers {
  private readonly surfaces = new Map<string, Surface>()
  constructor(private readonly target: (agentId: string) => string | null,
    private readonly create = () => new InteractiveViewerCapture()) {}

  async request(connId: string, payload: Payload): Promise<Payload> {
    const { surfaceId, agentId, op } = payload
    if (typeof surfaceId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(surfaceId)
      || typeof agentId !== 'string' || !agentId.length || agentId.length > 160
      || !['frame', 'close'].includes(String(op))) return { error: 'INVALID_VIEWER_REQUEST' }
    const key = `${connId}/${surfaceId}`
    let surface = this.surfaces.get(key)
    if (surface && surface.agentId !== agentId) return { error: 'INVALID_VIEWER_REQUEST' }
    if (op === 'close') { this.remove(key); return { closed: true } }
    const frame = surfaceFrame(payload)
    if (!frame) return { error: 'INVALID_VIEWER_REQUEST' }
    const target = viewerTarget(this.target(agentId))
    if (!target) { this.remove(key); return { error: 'VIEWER_UNAVAILABLE', detail: 'This harness has no live viewer yet.' } }
    if (surface && surface.target !== target) { this.remove(key); surface = undefined }
    if (!surface) {
      if (this.surfaces.size >= 8 || [...this.surfaces.values()].filter(s => s.connId === connId).length >= 4) {
        return { error: 'VIEWER_LIMIT', detail: 'Close another viewer to open this one.' }
      }
      surface = { connId, agentId, target, capture: this.create(), started: false, busy: false,
        timer: setTimeout(() => this.remove(key), 30_000) }
      surface.timer.unref()
      this.surfaces.set(key, surface)
    }
    if (surface.busy) return { error: 'VIEWER_BUSY' }
    surface.timer.refresh()
    surface.busy = true
    try {
      if (!surface.started) { await surface.capture.start(target); surface.started = true }
      if (this.surfaces.get(key) !== surface) return { error: 'VIEWER_CLOSED' }
      const data = await surface.capture.frame(frame)
      const hostActions = await surface.capture.takeHostActions(target)
      if (this.surfaces.get(key) !== surface) return { error: 'VIEWER_CLOSED' }
      return { data, mime: 'image/jpeg', width: frame.width, height: frame.height, hostActions }
    } catch (error) {
      if (this.surfaces.get(key) === surface) this.remove(key)
      return { error: 'VIEWER_UNAVAILABLE', detail: error instanceof Error ? error.message : 'The viewer could not start.' }
    } finally { surface.busy = false }
  }

  private remove(key: string): void {
    const surface = this.surfaces.get(key)
    if (!surface) return
    this.surfaces.delete(key); clearTimeout(surface.timer)
    void surface.capture.stop().catch(() => {})
  }
  refresh(agentId: string): void {
    const target = viewerTarget(this.target(agentId))
    for (const [key, surface] of this.surfaces) {
      if (surface.agentId === agentId && surface.target !== target) this.remove(key)
    }
  }
  closeConnection(connId: string): void {
    for (const [key, surface] of this.surfaces) if (surface.connId === connId) this.remove(key)
  }
  closeAll(): void { for (const key of this.surfaces.keys()) this.remove(key) }
}
