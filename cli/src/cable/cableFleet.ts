// One protocol session per USB dial, sharing the desktop's event source.
// Voice buffers, decoding, firmware transfers and disconnects remain per dial.
import { join } from 'node:path'
import { DialVerdicts } from './dialPortVerdicts.js'
import { findDialPorts, portInUse, SerialLink, type DialPort } from './serial.js'
import { isUsbConsoleUser } from './usbConsoleUser.js'
import type { CableSession, CableHost, CablePort, DialStatus, PortOpener } from './cableSession.js'
import type { DialLog } from './dialLog.js'

type Surface = Pick<CableSession, keyof CableSession>
type SessionConstructor = new (host: CableHost, log: DialLog, open: PortOpener) => Surface
type Entry = { port: DialPort; session: Surface; attached: boolean; status: DialStatus }
type OpenPort = (path: string, onData: (chunk: Buffer) => void, onClosed: (why: string) => void) => Promise<CablePort>
export interface CableFleetOptions {
  discover?: () => Promise<DialPort[]>
  open?: OpenPort
  /** Optional local selection. An empty list discovers all matching dials. */
  serials?: string[]
  intervalMs?: number
  /** Which boards have already been found not to be dials. In memory only unless it has a file. */
  verdicts?: DialVerdicts
  /** Does another process have this tty open? A port somebody else is using is not looked at. */
  inUse?: (path: string) => Promise<boolean>
  /** Only the foreground macOS account may automatically own physical USB. */
  canUseUsb?: () => boolean
  /** How often a board ruled out is checked for another program working on it. */
  watchEveryMs?: number
}

export class CableFleet {
  private entries = new Map<string, Entry>()
  private timer?: ReturnType<typeof setInterval>
  private scanTask?: Promise<void>
  private stopped = true
  private readonly discover: () => Promise<DialPort[]>
  private readonly open: OpenPort
  private readonly serials: Set<string>
  private readonly verdicts: DialVerdicts
  private readonly inUse: (path: string) => Promise<boolean>
  private readonly canUseUsb: () => boolean
  private waitingForConsole = false
  /** Ports already reported as in use, so the log says it once rather than every scan. */
  private readonly heldNotes = new Set<string>()
  /** For each board ruled out: when it was last checked for another program's use, and whether it was in use. */
  private readonly watched = new Map<string, { at: number; wasBusy: boolean }>()
  private readonly watchEveryMs: number

  constructor(private readonly Session: SessionConstructor, private readonly host: CableHost,
              private readonly logs: string, private readonly Log: typeof DialLog,
              private readonly options: CableFleetOptions = {}) {
    this.discover = options.discover ?? findDialPorts
    this.open = options.open ?? SerialLink.open
    this.serials = new Set((options.serials ?? []).map(s => s.toUpperCase()))
    this.verdicts = options.verdicts ?? new DialVerdicts()
    this.inUse = options.inUse ?? portInUse
    this.canUseUsb = options.canUseUsb ?? isUsbConsoleUser
    this.watchEveryMs = options.watchEveryMs ?? 8_000
  }

  get isConnected(): boolean { return [...this.entries.values()].some(e => e.session.isConnected) }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setInterval(() => void this.scan(), this.options.intervalMs ?? 2000)
    void this.scan()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    await this.scanTask
    await Promise.allSettled([...this.entries.values()].map(e => e.session.stop()))
    this.entries.clear()
  }

  private scan(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.scanTask) return this.scanTask
    this.scanTask = this.reconcile().catch(error => {
      this.host.log(`cable: USB discovery failed: ${String(error)}`)
    }).finally(() => { this.scanTask = undefined })
    return this.scanTask
  }

  /**
   * Has a program had this ruled-out board open and let go since it was ruled out?
   *
   * That is how a board becomes a dial: someone flashes it, with esptool or `idf.py`, and neither a
   * reset nor a reflash changes what USB says about it, so the flash itself is the only sign there is.
   * When the port goes from held to free the verdict is forgotten and the board is looked at once more.
   * Checked every few seconds, not every scan: `lsof` is a process, and the answer changes slowly.
   */
  private async workedOn(port: DialPort): Promise<boolean> {
    const key = (port.serialNumber ?? port.path).toUpperCase()
    const watch = this.watched.get(key) ?? { at: 0, wasBusy: false }
    this.watched.set(key, watch)
    if (Date.now() - watch.at < this.watchEveryMs) return false
    watch.at = Date.now()
    if (await this.inUse(port.path)) { watch.wasBusy = true; return false }
    if (!watch.wasBusy) return false
    watch.wasBusy = false
    this.verdicts.clear(port)
    this.host.log(`cable: ${port.path} was in use and is free again — looking at it once more`)
    return true
  }

  private async reconcile(): Promise<void> {
    if (!this.canUseUsb()) {
      if (!this.waitingForConsole) this.host.log('cable: USB belongs to the active macOS account — releasing this connection')
      this.waitingForConsole = true
      await Promise.allSettled([...this.entries.values()].map(entry => entry.session.stop()))
      if (this.entries.size) { this.entries.clear(); this.publish() }
      return
    }
    this.waitingForConsole = false
    const ports = await this.discover()
    if (this.stopped) return
    const present = new Map<string, DialPort>()
    for (const port of ports) {
      const serial = port.serialNumber?.toUpperCase()
      if (this.serials.size && (!serial || !this.serials.has(serial))) continue
      // Found not to be a dial already, and nobody seen working on it since: nothing to look at.
      if (this.verdicts.isForeign(port) && !(await this.workedOn(port))) continue
      present.set(serial || port.path, port)
    }
    let removed = false
    for (const [id, entry] of this.entries) {
      if (present.get(id)?.path === entry.port.path) continue
      await entry.session.stop()
      this.entries.delete(id)
      removed = true
    }
    // After the deletes, not inside them: a publish mid-loop would name a device this computer has
    // already stopped talking to.
    if (removed) this.publish()
    if (this.stopped) return
    for (const [id, port] of present) {
      if (this.entries.has(id)) continue
      // A board somebody else has open is somebody's work in progress (a flash, a monitor, a console).
      // Two readers on one tty interleave bytes, so it is not opened, and looked at again next scan.
      if (await this.inUse(port.path)) {
        if (!this.heldNotes.has(port.path)) this.host.log(`cable: ${port.path} is in use by another program — leaving it alone`)
        this.heldNotes.add(port.path)
        continue
      }
      this.heldNotes.delete(port.path)
      if (this.stopped) return
      const entry: Entry = { port, attached: false, status: { attached: false }, session: undefined! }
      const attached = () => {
        if (entry.attached) return
        const first = ![...this.entries.values()].some(e => e.attached)
        entry.attached = true
        if (first) this.host.onDialAttached?.()
      }
      const gone = () => {
        if (!entry.attached) return
        entry.attached = false
        // The session's own {attached:false} carried the mac and the last settings; keep them so the
        // pane can show this device's rows read-only instead of dropping it off the desk.
        entry.status = { ...entry.status, id, attached: false, fw: undefined, updating: undefined }
        if (![...this.entries.values()].some(e => e.attached)) this.host.onDialGone?.()
        this.publish()
      }
      // Bind ordinary host methods to the shared desktop. Only connection life
      // cycle and status are aggregated: losing one dial cannot tear down the
      // remaining dial's cloud lane, selection or active voice context.
      const host = new Proxy(this.host, {
        get: (target, key) => {
          if (key === 'onDialAttached') return attached
          if (key === 'onDialGone') return gone
          if (key === 'onForeignPort') return (path: string, why: string) => {
            this.verdicts.markForeign(port)
            this.host.log(`cable: ${path} is not a Harness dial (${why}) — leaving it alone until it is unplugged or reset [usb ${id}]`)
            // Off this call stack: the session is in the middle of deciding this, and stop() waits on it.
            setTimeout(() => {
              if (this.entries.get(id) !== entry) return
              this.entries.delete(id)
              void entry.session.stop()
            }, 0)
          }
          if (key === 'onDialStatus') return (status: DialStatus) => {
            entry.status = { ...status, id }
            this.publish()
          }
          if (key === 'log') return (line: string) => this.host.log(`${line} [usb ${id}]`)
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const opener: PortOpener = async (onData, onClosed) => {
        if (this.stopped || this.entries.get(id) !== entry || !this.canUseUsb()) return null
        const opened = await this.open(port.path, onData, onClosed)
        if (this.stopped || this.entries.get(id) !== entry || !this.canUseUsb()) {
          await opened.close('USB dial ownership changed while opening')
          return null
        }
        return opened
      }
      entry.session = new this.Session(host, new this.Log(join(this.logs, `usb-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`)), opener)
      this.entries.set(id, entry)
      entry.session.start()
    }
  }

  /**
   * One status out, carrying every device.
   *
   * The flat fields name the device a single-device window would have been shown anyway — the one
   * taking an update if there is one, otherwise the first attached. `devices` is the whole desk, which
   * is what a settings pane needs: it has to say WHICH robot it is changing, and until this existed the
   * fleet picked one row and discarded the rest.
   */
  private publish(): void {
    const devices = [...this.entries.values()].map(e => e.status).filter(s => s.attached || s.settings)
    const live = devices.filter(s => s.attached)
    const primary = live.find(s => s.updating) ?? live[0]
    this.host.onDialStatus?.({ ...(primary ?? { attached: false }), devices })
  }

  /** Every device this computer can see, newest reading. Ordered as they were discovered. */
  devices(): DialStatus[] {
    return [...this.entries.values()].map(e => e.status).filter(s => s.attached || s.settings)
  }

  /**
   * Change one device's settings. Addressed, not broadcast: every other method here reaches every
   * device on purpose — they all show the same desktop — but a preference belongs to the glass it is
   * set on, and sending it to the whole desk would change a robot nobody was looking at.
   */
  async setSettings(id: string, patch: Parameters<Surface['setSettings']>[0]): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, error: 'That device is not plugged into this computer.' }
    if (!entry.status.attached) return { ok: false, error: 'That device is unplugged.' }
    try {
      if (!await entry.session.setSettings(patch)) return { ok: false, error: 'The device did not take the change.' }
      return { ok: true }
    } catch (error) {
      this.host.log(`cable: ${entry.port.path} settings: ${String(error)}`)
      return { ok: false, error: 'The device did not take the change.' }
    }
  }

  private async send<K extends keyof Surface>(name: K, ...args: Surface[K] extends (...args: infer A) => unknown ? A : never): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map(async entry => {
      try {
        const method = entry.session[name] as (...args: unknown[]) => Promise<void>
        await method.apply(entry.session, args)
      } catch (error) { this.host.log(`cable: ${entry.port.path} ${name}: ${String(error)}`) }
    }))
  }
  syncAgents(...args: Parameters<Surface['syncAgents']>) { return this.send('syncAgents', ...args) }
  syncSwarms(...args: Parameters<Surface['syncSwarms']>) { return this.send('syncSwarms', ...args) }
  syncMachines(...args: Parameters<Surface['syncMachines']>) { return this.send('syncMachines', ...args) }
  followApp(...args: Parameters<Surface['followApp']>) { return this.send('followApp', ...args) }
  replaceNotifications(...args: Parameters<Surface['replaceNotifications']>) { return this.send('replaceNotifications', ...args) }
  agentSeen(...args: Parameters<Surface['agentSeen']>) { return this.send('agentSeen', ...args) }
  question(...args: Parameters<Surface['question']>) { return this.send('question', ...args) }
  questionClose(...args: Parameters<Surface['questionClose']>) { return this.send('questionClose', ...args) }
  turnStarted(...args: Parameters<Surface['turnStarted']>) { return this.send('turnStarted', ...args) }
  turnDone(...args: Parameters<Surface['turnDone']>) { return this.send('turnDone', ...args) }
  summary(...args: Parameters<Surface['summary']>) { return this.send('summary', ...args) }
  turnError(...args: Parameters<Surface['turnError']>) { return this.send('turnError', ...args) }
}
