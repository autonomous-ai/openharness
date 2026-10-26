// One protocol session per USB dial, sharing the desktop's event source.
// Voice buffers, decoding, firmware transfers and disconnects remain per dial.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetBoard } from './boardReset.js'
import { DialVerdicts } from './dialPortVerdicts.js'
import { findDialPorts, portInUse, SerialLink, type DialPort } from './serial.js'
import { isUsbConsoleUser } from './usbConsoleUser.js'
import type { CableSession, CableHost, CablePort, DialStatus, PortOpener } from './cableSession.js'
import type { DialLog } from './dialLog.js'

type Surface = Pick<CableSession, keyof CableSession>
type SessionConstructor = new (host: CableHost, log: DialLog, open: PortOpener) => Surface
type Entry = { port: DialPort; session: Surface; attached: boolean; status: DialStatus; faults: number[] }
type OpenPort = (path: string, onData: (chunk: Buffer) => void, onClosed: (why: string) => void) => Promise<CablePort>
/** A known Harness Pro that has been silent since its port opened: being reset, reset and looked at again, or the person told. */
type Unanswered = { port: DialPort; stage: 'resetting' | 'reset' | 'told' }
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
  /** Only the account at the screen may automatically own physical USB (macOS: the console user; Windows: the console session). */
  canUseUsb?: () => boolean
  /** How often a board ruled out is checked for another program working on it. */
  watchEveryMs?: number
  /** `HARNESSD_TEST_FAULTS`: `dial.<serial>` makes every call that dial's session makes into the desk throw,
   *  for the end-to-end suite's proof that one dial failing costs the others nothing. */
  faults?: ReadonlySet<string>
  /** The first wait before a dropped dial's port is looked at again (tests shorten it). */
  dropBackoffMs?: number
  /** Reset a board over its cable; false when it cannot be done here (boardReset.ts). */
  reset?: (path: string) => Promise<boolean>
}

/** Faults within a minute that drop one dial; a hostile stream drops it at once. */
const FAULTS_TO_DROP = 5
/** How long a dropped dial's port is left alone before it is looked at again: from here, doubling to the
 *  most, and back to here once it has stayed up for `DROP_FORGIVEN_MS`. */
const DROP_BACKOFF_MS = 5_000
const DROP_BACKOFF_MAX_MS = 60_000
const DROP_FORGIVEN_MS = 300_000
/** Shown on a silent Harness Pro's row once a reset has not brought it back. */
const UNANSWERED_NOTICE = 'Harness Pro isn\'t answering — unplug it and plug it back in'
/** A Harness Pro's greeting as the daemon writes it into that device's dial log (cableSession.ts, dialLog.ts). */
const PRO_GREETING = /\] dial \S+ (?:back )?on fw \S+ .*\bboard pro\b/

/** The folder of one device's dial logs, under the logs directory. */
const logFolder = (id: string) => `usb-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`

// ponytail: reads the whole of each kept day (at most 7 x 20 MB) once per board per process; a greeting index if that ever shows up.
function greetedAsPro(folder: string): boolean {
  try {
    return readdirSync(folder).filter(name => /^dial-\d{8}\.log$/.test(name)).some(name => PRO_GREETING.test(readFileSync(join(folder, name), 'utf8')))
  } catch { return false }
}

/**
 * Discovery for the end-to-end suite's dials, pseudo-terminals (e2e/harness/fakeDial.ts) named by
 * `HARNESSD_TEST_DIAL_PORT`: they are not on the USB bus that discovery reads, and they are the only ports
 * then looked at. A path is one dial; a `.json` file lists several, `[{ path, serial }]`, read at every scan,
 * so a test can plug and unplug them. Nothing otherwise: a real daemon finds its dials on USB.
 */
export function testDialDiscovery(path: string | undefined, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): Pick<CableFleetOptions, 'discover'> {
  if (!path) return {}
  const dial = (at: string, serialNumber: string): DialPort => ({ path: at, vendorId: 0x303a, productId: 0x1001, serialNumber })
  if (!path.endsWith('.json')) return { discover: async () => [dial(path, 'E2E-DIAL')] }
  return {
    discover: async () => {
      let listed: unknown
      try { listed = JSON.parse(read(path)) } catch { return [] }
      return (Array.isArray(listed) ? listed : [])
        .filter((row): row is { path: string; serial: string } => typeof row?.path === 'string' && typeof row?.serial === 'string')
        .map((row) => dial(row.path, row.serial))
    },
  }
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
  /** Dials dropped for their faults, by id: when their port is looked at again, and the wait after that. */
  private readonly dropped = new Map<string, { until: number; backoffMs: number; at: number }>()
  private readonly reset: (path: string) => Promise<boolean>
  /** Known Harness Pros silent since their port opened, by id, for as long as that USB attachment lasts. */
  private readonly unanswered = new Map<string, Unanswered>()
  /** Whether a board's own dial logs show it greeting as a Harness Pro, read once per board. */
  private readonly proInLogs = new Map<string, boolean>()

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
    this.reset = options.reset ?? resetBoard
  }

  get isConnected(): boolean { return [...this.entries.values()].some(e => e.session.isConnected) }

  /** Is any connected dial asking for `turn.stats`? */
  wantsStats(): boolean { return [...this.entries.values()].some(e => e.session.wantsStats) }

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
      if (!this.waitingForConsole) this.host.log('cable: USB belongs to the account at this computer\'s screen — releasing this connection')
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
      if (this.verdicts.isForeign(port) && !this.knownPro(port) && !(await this.workedOn(port))) continue
      present.set(serial || port.path, port)
    }
    let removed = false
    for (const [id, entry] of this.entries) {
      if (present.get(id)?.path === entry.port.path) continue
      await entry.session.stop()
      this.entries.delete(id)
      removed = true
    }
    // A silent Pro is left alone for as long as its USB attachment lasts: unplugged, or plugged back in, it is
    // a new attachment and looked at afresh.
    for (const [id, held] of this.unanswered) {
      const now = present.get(id)
      if (now?.path === held.port.path && now.session === held.port.session) continue
      this.unanswered.delete(id)
      removed = true
    }
    // After the deletes, not inside them: a publish mid-loop would name a device this computer has
    // already stopped talking to.
    if (removed) this.publish()
    if (this.stopped) return
    for (const [id, port] of present) {
      if (this.entries.has(id)) continue
      // Being reset, or the person has been asked to replug it: not opened. Once reset, it is looked at again.
      if (this.unanswered.has(id) && this.unanswered.get(id)?.stage !== 'reset') continue
      // Dropped for its faults a moment ago: its port is left alone until its wait is over.
      if ((this.dropped.get(id)?.until ?? 0) > Date.now()) continue
      // A board somebody else has open is somebody's work in progress (a flash, a monitor, a console).
      // Two readers on one tty interleave bytes, so it is not opened, and looked at again next scan.
      if (await this.inUse(port.path)) {
        if (!this.heldNotes.has(port.path)) this.host.log(`cable: ${port.path} is in use by another program — leaving it alone`)
        this.heldNotes.add(port.path)
        continue
      }
      this.heldNotes.delete(port.path)
      if (this.stopped) return
      const entry: Entry = { port, attached: false, status: { attached: false }, session: undefined!, faults: [] }
      const attached = () => {
        this.verdicts.markDial(port, entry.status.board)
        this.unanswered.delete(id)
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
            if (why === 'silent' && this.knownPro(port)) return this.silentPro(id, entry)
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
          if (key === 'onFault') return (error: unknown, hostile?: boolean) => this.faulted(id, entry, error, hostile === true)
          const value = Reflect.get(target, key, target)
          if (typeof value !== 'function') return value
          if (this.options.faults?.has(`dial.${id}`)) return () => { throw new Error(`injected fault: dial.${id}`) }
          return value.bind(target)
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
      entry.session = new this.Session(host, new this.Log(join(this.logs, logFolder(id))), opener)
      this.entries.set(id, entry)
      entry.session.start()
    }
  }

  /**
   * Did this board greet as a Harness Pro? Its port record says so, or, for a Pro that last greeted a daemon older
   * than the record's board (a user's Pro, 20-26 Oct), its own dial log does; that is then recorded. Nothing else is
   * ever reset: every ESP32 shares one USB id, and its serial is only the chip's MAC.
   */
  private knownPro(port: DialPort): boolean {
    if (this.verdicts.isPro(port)) return true
    const id = port.serialNumber?.toUpperCase() || port.path
    if (!this.proInLogs.has(id)) this.proInLogs.set(id, greetedAsPro(join(this.logs, logFolder(id))))
    if (!this.proInLogs.get(id)) return false
    this.verdicts.markDial(port, 'pro')
    return true
  }

  /**
   * A known Harness Pro silent since its port opened. Measured on a user's Pro started beside a booting Mac: nothing
   * came out at all, a reopen did not help and a replug did. So it is reset over the cable once and looked at again
   * by a fresh session; silent again, or where it cannot be reset, the person is asked to replug it, on its row, and
   * the port is left alone until they do. Never written off as foreign: a 6 h verdict is what stranded that Pro.
   */
  private silentPro(id: string, entry: Entry): void {
    const again = this.unanswered.get(id)?.stage === 'reset'
    const held: Unanswered = { port: entry.port, stage: again ? 'told' : 'resetting' }
    this.unanswered.set(id, held)
    // Off this call stack, as onForeignPort's own stop: the session is in the middle of deciding this.
    setTimeout(() => void (async () => {
      if (this.entries.get(id) !== entry) return
      this.entries.delete(id)
      await entry.session.stop()
      if (this.unanswered.get(id) !== held) return
      if (!again && await this.reset(entry.port.path)) {
        this.host.log(`cable: Harness Pro on ${entry.port.path} is silent — reset it over the cable, looking again [usb ${id}]`)
        if (this.unanswered.get(id) === held) held.stage = 'reset'
        return
      }
      this.host.log(`cable: Harness Pro on ${entry.port.path} is still silent${again ? ' after a reset' : ' and cannot be reset here'} — asking for a replug [usb ${id}]`)
      if (this.unanswered.get(id) !== held) return
      held.stage = 'told'
      this.publish()
    })(), 0)
  }

  /**
   * One dial's session failed, or its far end is flooding the port. The dial alone is dropped — its
   * session stopped and its port let go — once it has failed five times in a minute, or at once for a
   * flood, and its port is looked at again after a wait that doubles while it keeps failing. Every other
   * dial goes on: a fault in one device is that device's, and the process they share must not end for it.
   */
  private faulted(id: string, entry: Entry, error: unknown, hostile: boolean): void {
    const now = Date.now()
    entry.faults = [...entry.faults.filter((at) => now - at < 60_000), now]
    if (!hostile && entry.faults.length < FAULTS_TO_DROP) return
    if (this.entries.get(id) !== entry) return
    const last = this.dropped.get(id)
    const first = this.options.dropBackoffMs ?? DROP_BACKOFF_MS
    const backoffMs = !last || now - last.at > DROP_FORGIVEN_MS ? first : Math.min(last.backoffMs * 2, DROP_BACKOFF_MAX_MS)
    this.dropped.set(id, { until: now + backoffMs, backoffMs, at: now })
    this.host.log(`cable: ${entry.port.path} dropped (${hostile ? 'flooding the port' : `${entry.faults.length} faults in a minute`}: ${String(error instanceof Error ? error.message : error)}) — this dial alone; its port is looked at again in ${Math.round(backoffMs / 1000)} s [usb ${id}]`)
    // Off this call stack: the session is in the middle of the call that failed, and stop() waits on it.
    setTimeout(() => {
      if (this.entries.get(id) !== entry) return
      this.entries.delete(id)
      void entry.session.stop().finally(() => this.publish())
    }, 0)
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
    const devices = this.devices()
    const live = devices.filter(s => s.attached)
    const primary = live.find(s => s.updating) ?? live[0]
    this.host.onDialStatus?.({ ...(primary ?? { attached: false }), devices })
  }

  /** Every device this computer can see, newest reading. Ordered as they were discovered. */
  devices(): DialStatus[] {
    const told = [...this.unanswered].filter(([, held]) => held.stage === 'told')
      .map(([id]): DialStatus => ({ id, attached: false, board: 'pro', problem: UNANSWERED_NOTICE }))
    return [...[...this.entries.values()].map(e => e.status).filter(s => s.attached || s.settings), ...told]
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
  syncSwarmCards(...args: Parameters<Surface['syncSwarmCards']>) { return this.send('syncSwarmCards', ...args) }
  swarmCardRecap(...args: Parameters<Surface['swarmCardRecap']>) { return this.send('swarmCardRecap', ...args) }
  followApp(...args: Parameters<Surface['followApp']>) { return this.send('followApp', ...args) }
  replaceNotifications(...args: Parameters<Surface['replaceNotifications']>) { return this.send('replaceNotifications', ...args) }
  agentSeen(...args: Parameters<Surface['agentSeen']>) { return this.send('agentSeen', ...args) }
  question(...args: Parameters<Surface['question']>) { return this.send('question', ...args) }
  questionClose(...args: Parameters<Surface['questionClose']>) { return this.send('questionClose', ...args) }
  turnStarted(...args: Parameters<Surface['turnStarted']>) { return this.send('turnStarted', ...args) }
  turnStep(...args: Parameters<Surface['turnStep']>) { return this.send('turnStep', ...args) }
  turnReply(...args: Parameters<Surface['turnReply']>) { return this.send('turnReply', ...args) }
  turnStats(...args: Parameters<Surface['turnStats']>) { return this.send('turnStats', ...args) }
  turnDone(...args: Parameters<Surface['turnDone']>) { return this.send('turnDone', ...args) }
  summary(...args: Parameters<Surface['summary']>) { return this.send('summary', ...args) }
  turnError(...args: Parameters<Surface['turnError']>) { return this.send('turnError', ...args) }
  /** The pet mapping changed: every live dial is brought in line, each on its own link. */
  petsChanged() { return this.send('petsChanged') }
  /**
   * The Devices tab shows ONE pet state. With several dials attached it is the first attached one (discovery
   * order), the same choice `publish` makes for the flat status; a pull-down per dial is a later concern.
   */
  petDial(): ReturnType<Surface['petDial']> {
    for (const entry of this.entries.values()) {
      if (entry.attached && entry.session.petDial) return entry.session.petDial()
    }
    return { supported: false, held: [], sending: null, errors: {} }
  }
}
