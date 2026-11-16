/** Devices DSH tools use the same owned-machine bridge as Desktop. No serial or credential access. */
import { randomUUID } from 'node:crypto'
import { env } from '../config/env.js'
import { localCredentialHeaders } from '../lib/localCredential.js'
import { daemonFetch, openLocalWs } from '../lib/localTransport.js'
import type { ClientSocket } from '../lib/clientSocket.js'
import { deviceSettingsPatchSchema } from '../lib/harnessDevices.js'
import { frontAppId } from '../cable/hosts/frontApp.js'
import { REPLACED_LINE, tabOf, type Tab } from '../cable/hosts/tabs.js'
import { isNotifyMode, type NotifyMode } from '../cable/notifyMode.js'
import { askDevices, streamDevices, tellDevices } from './listenerClient.js'
import { devicesListenerPath } from './listenerPath.js'

export interface DevicesClientDeps {
  port: number
  /** The daemon's data dir, where its local credential is (lib/localCredential.ts). */
  dataDir?: string
  machineId(): Promise<string | null>
  /** A line to the daemon: its private socket's address, or where there can be none its port and [headers]. */
  connect(url: string, headers?: Record<string, string>): ClientSocket
  fetch?: typeof fetch
  request?: (machineId: string, type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>
  delay?: (ms: number) => Promise<void>
  /** How long the other computer has to answer: 12 s unless a request needs longer (an engine probe's login shells). */
  timeoutMs?: number
}

export function deviceRequest(deps: DevicesClientDeps, machineId: string, type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = openLocalWs(deps.dataDir ?? env.ADAPTER_DATA_DIR, deps.port, deps.connect)
    const requestId = randomUUID()
    let settled = false, sent = false
    const finish = (error: Error | null, reply?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      if (error) reject(error); else resolve(reply!)
    }
    const timer = setTimeout(() => finish(new Error('This computer did not answer in time.')), deps.timeoutMs ?? 12_000)
    socket.on('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, tool: true } })))
    socket.on('error', error => finish(error))
    socket.on('close', code => finish(new Error(code === 4404 ? 'Link this computer in Machines first.' : 'The computer disconnected.')))
    socket.on('message', data => {
      let frame: { type?: string; payload?: Record<string, unknown> }
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (frame.type === 'connected' && !sent) {
        sent = true
        socket.send(JSON.stringify({ type, payload: { ...payload, requestId } }))
      }
      if (frame.type === `${type}_result` && frame.payload?.requestId === requestId) {
        const { requestId: _id, ...reply } = frame.payload
        finish(null, reply)
      }
    })
  })
}

export const DEVICES_USAGE = `harness hardware — your Harness hardware across computers
  list [--json]                                      read owned computers and devices
  set --machine ID --device ID --patch JSON [--json]  change only the supplied settings
  watch [--json]                                     one line each time this computer's dial changes
Offline computers never receive queued changes. A write is complete only when confirmed.`

export interface DialWatchDeps extends Pick<DevicesClientDeps, 'port' | 'dataDir' | 'machineId' | 'connect'> {
  /** The Harness Device app writes on it a `{"front":"<bundle id or exe name>"}` line each time the app in front changes,
   *  a `{"tab":{"app","tty"}}` line each time the selected tab of a tab app in front does, a `{"muted":<bool>}` line
   *  each time its Sound item is clicked, and a `{"notify":"full"|"you"}` line each time a Notifications item is. */
  stdin: {
    on(event: 'end' | 'close', listener: () => void): unknown
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
    resume(): unknown
    pause(): unknown
  }
  print(line: string): void
  /** stderr: stdout carries only the app's NDJSON. */
  printError(line: string): void
  /** Tells the devices' own listener which app is in front, or which tab is selected in it: true when it took it.
   *  `tellDevices` by default. */
  tell?: (message: { type: 'front'; app: string } | { type: 'tab'; app: string; tty: string }) => Promise<boolean>
  /** Opens the devices' stream of the tabs a swipe or a tap selects, handing on each chunk until it ends or [signal]
   *  aborts: true when it had opened. One asked with `standby` opens only while no other watch holds it.
   *  `streamDevices` by default. */
  selects?: (message: { type: 'tabs'; standby?: true }, chunk: (data: Buffer) => void, signal: AbortSignal) => Promise<boolean>
  /** Hands the Notifications setting to the devices' listener, which keeps it: its answer, the status of one that is
   *  not a 200, null for none. `askDevices` by default, bounded at NOTIFY_ANSWER_MS. */
  notifyMode?: (mode: NotifyMode) => Promise<Record<string, unknown> | number | null>
}

const NOT_RUNNING = 'Harness is not running on this computer. Run: harness start'
const CLOSED = 'The connection to Harness on this computer closed.'
const DIAL_FIELDS = ['fw', 'hw', 'board', 'updating', 'problem'] as const
// The app cuts the value to 128 characters, under 1 KiB as a JSON line even escaped: a longer line is no front line. A
// tab line is under 140 bytes.
const FRONT_LINE_MAX = 1024
// The devices' listener takes ten fronts and ten tabs in any second on a connection, and the tells share one kept alive.
// Counted from each answer, the listener has heard the tell before by then: a burst of changes (focus following the
// mouse) stays within its ten, and the newest is not the one refused.
const TELL_GAP_MS = 100
// tellDevices' own bound, held by the watch too, so an app that quits waits no longer on a listener that does not answer.
const QUIT_TELL_MS = 2_000
// A select on the devices' stream is `{"app","tty"}`, and a tap's `"raise":true` too, under 70 bytes: a longer line is none.
const SELECT_LINE_MAX = 96
// A stream that ends or does not open is opened again 1 s later, the wait doubling to 30 s while it does not open: a
// devices process that is gone is not asked once a second.
const STREAM_RETRY_MS = 1_000
const STREAM_RETRY_MAX_MS = 30_000
// deviceRequest's bound: a Sound change a hung devices process never answers frees its slot, so the next click is sent.
const SOUND_ANSWER_MS = 12_000
// The same bound on a Notifications change: a hung devices process frees its slot, so the next click is sent.
const NOTIFY_ANSWER_MS = 12_000
// All of a refused Sound or Notifications change that goes on stderr, and from there into the app's log: a code, never
// the daemon's words.
const SOUND_CODE = /^[A-Z][A-Z0-9_]{0,31}$/

/** One call per line of at most [max] bytes; a longer line is dropped whole, its start included. */
function lines(max: number, line: (text: string) => void): (chunk: Buffer | string) => void {
  let pending = Buffer.alloc(0), dropping = false
  return chunk => {
    let rest = Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
    for (let end = rest.indexOf('\n'); end !== -1; end = rest.indexOf('\n')) {
      if (!dropping && end <= max) line(rest.subarray(0, end).toString())
      dropping = false
      rest = rest.subarray(end + 1)
    }
    dropping ||= rest.length > max
    pending = dropping ? Buffer.alloc(0) : rest
  }
}

/**
 * A dial_status reduced to what the menu-bar app shows, so a change of any setting but `muted` and `notify` prints
 * nothing. `muted` only for a dial with an id, the one a Sound change can name; read from the primary's flat fields,
 * never `devices`. `notify`, the Notifications setting, only with a dial attached: it is this computer's, kept by the
 * devices' listener, and the status carries it beside the dial's own settings.
 */
export function dialWatchLine(payload: unknown): string {
  const status = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  const line: Record<string, unknown> = { attached: status.attached === true }
  for (const field of DIAL_FIELDS) if (typeof status[field] === 'string') line[field] = status[field]
  const settings = status.settings
  if (typeof status.id === 'string' && status.id !== '' && typeof settings === 'object' && settings !== null
    && typeof (settings as Record<string, unknown>).muted === 'boolean') line.muted = (settings as Record<string, unknown>).muted
  if (line.attached === true && isNotifyMode(status.notify)) line.notify = status.notify
  return JSON.stringify(line)
}

/**
 * Not runDevicesCommand, which turns every error into 1: the app reads these codes as its probe of the daemon.
 * 3 the daemon cannot be reached (before or after `connected`) or sends no `connected` in 10 s, 4 it has no dial-watch, 0 stdin closed, 1 the usage.
 */
export function runDialWatch(argv: string[], deps: DialWatchDeps): Promise<number> {
  if (argv.some(word => word !== '--json')) {
    deps.print(DEVICES_USAGE)
    return Promise.resolve(1)
  }
  return new Promise(resolve => {
    let socket: ClientSocket | undefined
    let settled = false, exited = false, last: string | undefined
    // The app in front as an app id (the raw name stops in this process), the last one the devices' listener took, and
    // whether the current one is owed to it whatever it took before: a dial that attaches may come with a new devices process.
    let front: string | undefined, told: string | undefined, owed = false, telling = false
    // The tell under way, and whether any app (not none) was ever sent: only then do the devices have one to forget.
    let under: Promise<boolean> | undefined, sentApp = false
    let gap: ReturnType<typeof setTimeout> | undefined
    const dataDir = deps.dataDir ?? env.ADAPTER_DATA_DIR
    const tell = deps.tell ?? (message => tellDevices(dataDir, message))
    // One tell at a time, so the listener hears them in order and the newest last; the ones between are skipped. Each is
    // followed by a gap, and what came in it is told as it ends.
    const tellFront = (): void => {
      if (settled || telling || gap || front === undefined || (front === told && !owed)) return
      const app = front
      telling = true
      owed = false
      sentApp ||= app !== 'none'
      under = tell({ type: 'front', app })
      void under.then(taken => {
        telling = false
        // A watch that has ended waits on nothing.
        if (settled) return
        if (taken) told = app
        gap = setTimeout(() => {
          gap = undefined
          // A tell not taken is not tried again by itself: only a newer app in front, or the dial attaching, is told.
          if (front !== app || owed) tellFront()
        }, TELL_GAP_MS)
      })
    }
    // The selected tab not yet told. Its tells have a slot of their own, so a front tell under way holds none back: one
    // at a time with a gap after each, the newest last. One not taken is not tried again: the next report is newer.
    let tab: Tab | undefined, tabTelling = false
    let tabGap: ReturnType<typeof setTimeout> | undefined
    const tellTab = (): void => {
      if (settled || tabTelling || tabGap || !tab) return
      const { app, tty } = tab
      tab = undefined
      tabTelling = true
      void tell({ type: 'tab', app, tty }).then(() => {
        tabTelling = false
        if (settled) return
        tabGap = setTimeout(() => {
          tabGap = undefined
          tellTab()
        }, TELL_GAP_MS)
      })
    }
    // The devices' stream of selects, open or opening, and when it is opened again. Without a listener path there is
    // nothing to open, and nothing is retried.
    let stream: AbortController | undefined, reopen: ReturnType<typeof setTimeout> | undefined
    let streamWait = STREAM_RETRY_MS
    // Whether a newer watch took the stream, such as a second Harness Device's: this one then only stands by, taken while
    // no stream is open, so the two do not take it from each other once a second.
    let replaced = false
    const listening = devicesListenerPath(dataDir) !== null
    const selects = deps.selects ?? ((message, chunk, signal) => streamDevices(dataDir, message, chunk, { signal }))
    // A select as Harness Device reads it: the tab, and `"raise":true` for a tap's. Nothing else of the line goes on.
    const printSelect = (line: string): void => {
      if (settled) return
      let value: unknown
      try { value = JSON.parse(line) } catch { return }
      const selected = tabOf(value)
      if (!selected) return
      const { raise } = value as { raise?: unknown }
      if (raise !== undefined && typeof raise !== 'boolean') return
      deps.print(JSON.stringify({ select: raise ? { ...selected, raise } : selected }))
    }
    const openStream = (): void => {
      if (settled || stream || !listening) return
      clearTimeout(reopen)
      stream = new AbortController()
      let taken = false
      // Lines of its own: the start of a line an ended stream left never joins the next stream's first.
      const read = lines(SELECT_LINE_MAX, line => { if (line === REPLACED_LINE) taken = true; else printSelect(line) })
      void selects(replaced ? { type: 'tabs', standby: true } : { type: 'tabs' }, read, stream.signal).then(hadOpened => {
        stream = undefined
        if (settled) return
        if (hadOpened) {
          streamWait = STREAM_RETRY_MS
          // A stream of its own had opened, standing by or not: replaced only if it ended on that line, said once each.
          replaced = taken
          if (replaced) deps.printError('tabs stream replaced')
        }
        reopen = setTimeout(openStream, streamWait)
        streamWait = Math.min(streamWait * 2, STREAM_RETRY_MAX_MS)
      })
    }
    // Whether the daemon answered with dial-watch: before that, only machine_select goes on the socket.
    let answered = false
    // The dial the last status named, the one a Sound line changes; the change on the socket, and the newest line read
    // meanwhile, kept with the dial it was read for. Fast clicks never queue up, and a dial that became the primary
    // since is never changed by a click made for another.
    let dialId: string | undefined
    let sounding: { requestId: string; timer: ReturnType<typeof setTimeout> } | undefined
    let waiting: { id: string; muted: boolean } | undefined
    const sendSound = (id: string, muted: boolean): void => {
      const requestId = randomUUID()
      sounding = { requestId, timer: setTimeout(() => soundDone('NO_ANSWER'), SOUND_ANSWER_MS) }
      socket!.send(JSON.stringify({ type: 'harness_device_settings', payload: { id, patch: { muted }, requestId } }))
    }
    // The change on the socket answered, or not in time: a failure is one line, and what waited is sent.
    const soundDone = (failure?: string): void => {
      clearTimeout(sounding?.timer)
      sounding = undefined
      if (failure) deps.printError(`sound: ${failure}`)
      const next = waiting
      waiting = undefined
      if (next) sendSound(next.id, next.muted)
    }
    const sound = (muted: boolean): void => {
      if (!answered) return deps.printError('sound: NOT_CONNECTED')
      if (!dialId) return deps.printError('sound: NO_DIAL')
      if (sounding) waiting = { id: dialId, muted }
      else sendSound(dialId, muted)
    }
    // Whether the last status said a dial is attached: the menu offers Notifications only then, though the setting is
    // this computer's. A change goes to the devices' listener, which keeps it, one at a time; the newest line read
    // meanwhile waits. The line moves only with the dial_status the devices send once they have kept it.
    let attached = false, notifying = false
    let notifyWaiting: NotifyMode | undefined
    const notifyMode = deps.notifyMode ?? (mode => askDevices(dataDir, { type: 'notify', mode }, { timeoutMs: NOTIFY_ANSWER_MS }))
    const sendNotify = (mode: NotifyMode): void => {
      notifying = true
      void notifyMode(mode).then(reply => {
        // A watch that has ended says nothing and sends nothing.
        if (settled) return
        notifying = false
        // No answer at all (no listener, an older daemon's, its rate, none in 12 s) is told apart from a refusal, whose
        // code alone reaches stderr, never the listener's words.
        if (reply === null || typeof reply === 'number') deps.printError('notify: NO_ANSWER')
        else if (reply.mode !== mode) deps.printError(`notify: ${typeof reply.error === 'string' && SOUND_CODE.test(reply.error) ? reply.error : 'FAILED'}`)
        const next = notifyWaiting
        notifyWaiting = undefined
        if (next) sendNotify(next)
      })
    }
    const notify = (mode: NotifyMode): void => {
      if (!answered) return deps.printError('notify: NOT_CONNECTED')
      if (!attached) return deps.printError('notify: NO_DIAL')
      if (notifying) notifyWaiting = mode
      else sendNotify(mode)
    }
    const finish = (code: number, why?: string, last?: Promise<unknown>): void => {
      if (settled) return
      settled = true
      if (why) deps.printError(why)
      clearTimeout(deadline)
      clearTimeout(gap)
      clearTimeout(tabGap)
      clearTimeout(reopen)
      clearTimeout(sounding?.timer)
      stream?.abort()
      deps.stdin.pause()
      try { socket?.close() } catch { /* already closed */ }
      if (!last) return resolve(code)
      let bound: ReturnType<typeof setTimeout> | undefined
      void Promise.race([last, new Promise(done => { bound = setTimeout(done, QUIT_TELL_MS) })]).then(() => {
        clearTimeout(bound)
        exited = true
        resolve(code)
      })
    }
    // The Device app quit: the devices would otherwise go on following the last app it saw in front. One try, after the
    // tell under way so the listener hears none last, and none once the bound has passed: it would hold the process on.
    const quit = (): void => {
      if (settled || !sentApp) return finish(0)
      const none = async (): Promise<void> => { if (!exited) await tell({ type: 'front', app: 'none' }) }
      finish(0, undefined, telling && under ? under.then(none) : none())
    }
    // A daemon that takes the socket and never answers would otherwise keep the app's probe waiting for ever.
    const deadline = setTimeout(() => finish(3, CLOSED), 10_000)
    // The app spawns this with a stdin pipe, so a killed app never leaves a tool connection open for ever.
    deps.stdin.on('end', quit)
    deps.stdin.on('close', quit)
    deps.stdin.on('data', lines(FRONT_LINE_MAX, line => {
      if (settled) return
      let value: { front?: unknown; tab?: unknown; muted?: unknown; notify?: unknown } | null
      try { value = JSON.parse(line) } catch { return }
      // The Sound item's click: exactly one boolean `muted`, so no other line, nor a key beside it, changes the dial.
      if (typeof value?.muted === 'boolean' && Object.keys(value).length === 1) return sound(value.muted)
      // A Notifications item's click, held to the same: exactly one known mode, alone.
      if (isNotifyMode(value?.notify) && Object.keys(value).length === 1) return notify(value.notify)
      if (typeof value?.front === 'string') {
        front = frontAppId(value.front)
        return tellFront()
      }
      const reported = tabOf(value?.tab)
      if (!reported) return
      tab = reported
      tellTab()
    }))
    deps.stdin.resume()
    deps.machineId().then(machineId => {
      if (settled) return
      if (!machineId) return finish(3, NOT_RUNNING)
      socket = openLocalWs(deps.dataDir ?? env.ADAPTER_DATA_DIR, deps.port, deps.connect)
      socket.on('open', () => socket!.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, tool: true, watch: ['dial'] } })))
      socket.on('error', () => finish(3, NOT_RUNNING))
      // Any close, 4403 included: the machine id changes during `harness login`, and the app starts a new watch.
      socket.on('close', () => finish(3, CLOSED))
      socket.on('message', data => {
        if (settled) return
        let frame: { type?: unknown; payload?: unknown } | null
        try { frame = JSON.parse(data.toString()) } catch { return }
        if (frame?.type === 'connected') {
          clearTimeout(deadline)
          const features = (frame.payload as { features?: unknown } | undefined)?.features
          if (Array.isArray(features) && features.includes('dial-watch')) {
            answered = true
            return openStream()
          }
          deps.print(JSON.stringify({ error: 'The Harness daemon on this computer is older than this command. Run: harness start --restart' }))
          return finish(4)
        }
        if (frame?.type === 'harness_device_settings_result') {
          const reply = frame.payload as { requestId?: unknown; ok?: unknown; error?: unknown } | null | undefined
          // Another request's answer, or one that came after its 12 s: it frees no slot.
          if (!sounding || reply?.requestId !== sounding.requestId) return
          if (reply.ok === true) return soundDone()
          // The daemon's own words (a path, a newline) never reach stderr: only a code does.
          return soundDone(typeof reply.error === 'string' && SOUND_CODE.test(reply.error) ? reply.error : 'FAILED')
        }
        if (frame?.type !== 'dial_status' || typeof frame.payload !== 'object' || frame.payload === null) return
        // The devices process usually starts with the dial, after this watch: it hears the app in front as the dial attaches.
        // Told on every status that says attached, a repeat too: a devices process restarted under a dial still attached
        // sends one that reads as the last, and the filter takes the same app again as nothing new.
        attached = (frame.payload as { attached?: unknown }).attached === true
        if (attached) {
          owed = true
          tellFront()
          // A new devices process may come with the dial: its stream is opened now, not after the wait.
          streamWait = STREAM_RETRY_MS
          openStream()
        }
        // Read before the dedupe: another dial can become the primary under the same line, and a status with no dial
        // takes the id away.
        const { id } = frame.payload as { id?: unknown }
        dialId = typeof id === 'string' && id !== '' ? id : undefined
        const line = dialWatchLine(frame.payload)
        if (line === last) return
        last = line
        deps.print(line)
      })
    }).catch(() => finish(3, NOT_RUNNING))
  })
}

interface Host { machineId: string; name: string; online: boolean }
async function ownedHosts(deps: DevicesClientDeps): Promise<Host[]> {
  const localId = await deps.machineId()
  if (!localId) throw new Error('Start Harness on this computer first.')
  const dataDir = deps.dataDir ?? env.ADAPTER_DATA_DIR
  const response = await (deps.fetch ?? daemonFetch(dataDir, deps.port))(`http://127.0.0.1:${deps.port}/api/machines`, {
    headers: { 'x-adapter-local': '1', ...localCredentialHeaders(dataDir) }, signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('Could not read the account’s computers. Sign in and try again.')
  const body = await response.json() as { data?: { machines?: Record<string, unknown>[] }; machines?: Record<string, unknown>[] }
  const rows = body.data?.machines ?? body.machines
  if (!Array.isArray(rows)) throw new Error('Harness returned an invalid computer list.')
  const hosts = rows.filter(row => typeof row.machineId === 'string' && !row.isShared).map(row => ({
    machineId: row.machineId as string,
    name: String(row.name || row.hostname || row.machineId),
    online: row.machineId === localId || row.status === 'running',
  }))
  if (!hosts.some(host => host.machineId === localId)) hosts.unshift({ machineId: localId, name: 'This computer', online: true })
  return hosts
}

function observed(reply: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  const status = reply.status as { devices?: Record<string, unknown>[]; id?: string } | undefined
  return (status?.devices ?? (status ? [status] : [])).find(device => device.id === id)
}

/** Separate from printing so the exact routing and confirmation path is testable. */
export async function devicesCommand(argv: string[], deps: DevicesClientDeps): Promise<Record<string, unknown>> {
  const words = argv.filter(word => word !== '--json')
  const command = words.shift() ?? 'list'
  if (command === 'help' || command === '--help') return { help: DEVICES_USAGE }
  if (command !== 'list' && command !== 'set') throw new Error(DEVICES_USAGE)
  const options: Record<string, string> = {}
  if (command === 'list' && words.length) throw new Error(DEVICES_USAGE)
  for (let i = 0; i < words.length; i += 2) {
    const key = words[i]!
    if (!['--machine', '--device', '--patch'].includes(key) || !words[i + 1] || key in options) throw new Error(DEVICES_USAGE)
    options[key] = words[i + 1]!
  }
  let patch: Record<string, unknown> | undefined
  if (command === 'set') {
    if (!options['--machine'] || !options['--device'] || !options['--patch']) throw new Error(DEVICES_USAGE)
    patch = deviceSettingsPatchSchema.parse(JSON.parse(options['--patch']))
  }
  const hosts = await ownedHosts(deps)
  const request = deps.request ?? ((id, type, payload) => deviceRequest(deps, id, type, payload))
  if (command === 'list') {
    return { hosts: await Promise.all(hosts.map(async host => {
      if (!host.online) return { ...host, available: false }
      try {
        const reply = await request(host.machineId, 'harness_devices_list')
        return { ...host, available: !reply.error, ...reply }
      } catch (error) { return { ...host, available: false, error: error instanceof Error ? error.message : 'Unavailable' } }
    })) }
  }
  const host = hosts.find(host => host.machineId === options['--machine'])
  if (!host) throw new Error('That computer is not owned by this account.')
  if (!host.online) throw new Error('That computer is offline. No change was sent.')
  const id = options['--device']!
  let reply = await request(host.machineId, 'harness_device_settings', { id, patch })
  if (reply.error || reply.ok !== true) return { ...reply, confirmed: false }
  const delay = deps.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < 13; attempt++) {
    const device = observed(reply, id)
    const values = device?.settings as Record<string, unknown> | undefined
    if (device?.attached === true && !device.updating && values && Object.entries(patch!).every(([key, value]) => values[key] === value)) {
      return { ok: true, confirmed: true, machineId: host.machineId, id, settings: values }
    }
    if (reply.error || device?.attached === false || device?.updating || attempt === 12) break
    await delay(500)
    reply = await request(host.machineId, 'harness_devices_list')
  }
  return { ok: false, accepted: true, confirmed: false, machineId: host.machineId, id,
    error: 'The device has not confirmed the change. Refresh Devices before trying again.' }
}

export async function runDevicesCommand(argv: string[], deps: DevicesClientDeps): Promise<number> {
  try {
    const result = await devicesCommand(argv, deps)
    console.log(result.help ?? JSON.stringify(result, null, argv.includes('--json') ? undefined : 2))
    return result.error ? 1 : 0
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'Device request failed.', confirmed: false }))
    return 1
  }
}
