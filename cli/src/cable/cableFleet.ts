// One protocol session per USB dial, sharing the desktop's event source.
// Voice buffers, decoding, firmware transfers and disconnects remain per dial.
import { join } from 'node:path'
import { findDialPorts, SerialLink, type DialPort } from './serial.js'
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
}

export class CableFleet {
  private entries = new Map<string, Entry>()
  private timer?: ReturnType<typeof setInterval>
  private scanTask?: Promise<void>
  private stopped = true
  private readonly discover: () => Promise<DialPort[]>
  private readonly open: OpenPort
  private readonly serials: Set<string>

  constructor(private readonly Session: SessionConstructor, private readonly host: CableHost,
              private readonly logs: string, private readonly Log: typeof DialLog,
              private readonly options: CableFleetOptions = {}) {
    this.discover = options.discover ?? findDialPorts
    this.open = options.open ?? SerialLink.open
    this.serials = new Set((options.serials ?? []).map(s => s.toUpperCase()))
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

  private async reconcile(): Promise<void> {
    const ports = await this.discover()
    if (this.stopped) return
    const present = new Map<string, DialPort>()
    for (const port of ports) {
      const serial = port.serialNumber?.toUpperCase()
      if (this.serials.size && (!serial || !this.serials.has(serial))) continue
      present.set(serial || port.path, port)
    }
    for (const [id, entry] of this.entries) {
      if (present.get(id)?.path === entry.port.path) continue
      await entry.session.stop()
      this.entries.delete(id)
    }
    if (this.stopped) return
    for (const [id, port] of present) {
      if (this.entries.has(id)) continue
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
        entry.status = { attached: false }
        if (![...this.entries.values()].some(e => e.attached)) this.host.onDialGone?.()
      }
      // Bind ordinary host methods to the shared desktop. Only connection life
      // cycle and status are aggregated: losing one dial cannot tear down the
      // remaining dial's cloud lane, selection or active voice context.
      const host = new Proxy(this.host, {
        get: (target, key) => {
          if (key === 'onDialAttached') return attached
          if (key === 'onDialGone') return gone
          if (key === 'onDialStatus') return (status: DialStatus) => {
            entry.status = status
            const live = [...this.entries.values()].filter(e => e.status.attached)
            const current = live.find(e => e.status.updating) ?? live[0]
            this.host.onDialStatus?.(current ? current.status : { attached: false })
          }
          if (key === 'log') return (line: string) => this.host.log(`${line} [usb ${id}]`)
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const opener: PortOpener = async (onData, onClosed) => {
        if (this.stopped || this.entries.get(id) !== entry) return null
        const opened = await this.open(port.path, onData, onClosed)
        if (this.stopped || this.entries.get(id) !== entry) {
          await opened.close('USB dial removed while opening')
          return null
        }
        return opened
      }
      entry.session = new this.Session(host, new this.Log(join(this.logs, `usb-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`)), opener)
      this.entries.set(id, entry)
      entry.session.start()
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
  syncCompanion() { return this.send('syncCompanion') }
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
