/**
 * A Harness OS computer, managed from the owner's phone (`os_device`): whether this computer runs Harness OS,
 * whether an update is ready and starting it, the Wi-Fi networks it sees, and moving it to another one.
 *
 * Owner only. Everything it runs is bounded in time and output, and what must outlive this daemon runs
 * detached in a process group of its own: the update restarts the daemon, and joining another Wi-Fi drops the
 * connection the request came over, so both are started and answered `{ started: true }` at once. The join's
 * result is read afterwards (`wifi_result`), from the file Harness OS's setup writes.
 *
 * A Wi-Fi password goes to the setup only on its stdin: never in an argv, a log or an error message.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { CoreApi, ServiceRequests } from '../core/api.js'

/** The requests this service answers for the apps, declared in core/api.ts for the core to route. */
export { OS_DEVICE_REQUESTS } from '../core/api.js'

/** Harness OS's own update tool: present on Harness OS alone. */
export const LIVE_UPDATE = '/usr/lib/harness-os/live_update.py'
/** Harness OS's setup, which joins a Wi-Fi network from the JSON on its stdin. */
export const SETUP = '/usr/lib/harness-os/setup.py'
/** Where the setup writes what became of its last join. */
export const SETUP_RESULT = '/var/lib/harness-os/setup-result.json'
export const PYTHON = '/usr/bin/python3'
export const CMDLINE = '/proc/cmdline'
export const HARNESS = '/usr/bin/harness'
export const NMCLI = 'nmcli'
/** How long an update counts as started: a second one inside it is refused BUSY. */
export const UPDATE_BUSY_MS = 10 * 60_000
export const STATUS_TIMEOUT_MS = 15_000
export const NMCLI_TIMEOUT_MS = 10_000
export const SCAN_TIMEOUT_MS = 20_000
/** The disk's key slots are slow to change on purpose (a passphrase is hashed for seconds), twice. */
export const PASSWORD_TIMEOUT_MS = 90_000
const ACTIONS = ['update', 'wifi_scan', 'wifi_join', 'wifi_result', 'sign_out', 'password', 'ssh']
/** The most output a command run here may print before it is stopped. */
export const MAX_OUTPUT = 1024 * 1024

type Payload = Record<string, unknown>

export interface ExecOptions { timeout: number; input?: string }

export interface OsDeviceDeps {
  env?: Record<string, string | undefined>
  exists?: (path: string) => boolean
  readFile?: (path: string) => Promise<string>
  /** Run [file] with [args], bounded by [options.timeout] and MAX_OUTPUT; its stdout, or a rejection. */
  exec?: (file: string, args: readonly string[], options: ExecOptions) => Promise<string>
  /** Start [file] detached from this daemon (its own process group, no output), [input] written to its stdin. */
  spawnDetached?: (file: string, args: readonly string[], input?: string) => void
  now?: () => number
}

/** Run a command, bounded in time and output (core/AGENTS.md rule 4). */
export function execBounded(file: string, args: readonly string[], options: ExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, [...args], { timeout: options.timeout, maxBuffer: MAX_OUTPUT, killSignal: 'SIGKILL', encoding: 'utf8' },
      (error, stdout) => { if (error) reject(error); else resolve(stdout) })
    child.stdin!.on('error', () => { /* a command that exits before reading its input */ })
    child.stdin!.end(options.input)
  })
}

/** Start a command that outlives this daemon: its own process group, its output dropped, never waited on. */
export function spawnDetached(file: string, args: readonly string[], input?: string): void {
  const child = spawn(file, [...args], { detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] })
  // Its argv only: the input may hold a Wi-Fi password.
  child.on('error', (error) => console.error(`[os-device] could not start ${file}:`, short(error)))
  if (input !== undefined) {
    child.stdin!.on('error', () => { /* the command exited before reading it */ })
    child.stdin!.end(input)
  }
  child.unref()
}

/** One `nmcli -t -e yes` row's fields: split on an unescaped `:`, with `\:` and `\\` read as `:` and `\`. */
export function nmcliFields(line: string): string[] {
  const fields: string[] = []
  let field = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) field += line[++i]
    else if (c === ':') { fields.push(field); field = '' } else field += c
  }
  fields.push(field)
  return fields
}

const rows = (out: string): string[][] => out.split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean).map(nmcliFields)

/** The network this computer is on, from `nmcli -t -e yes -f ACTIVE,SSID device wifi`; null when none. */
export function activeSsid(out: string): string | null {
  return rows(out).find(([active, ssid]) => active === 'yes' && !!ssid)?.[1] ?? null
}

export interface WifiNetwork { ssid: string; signal: number; security: string; active: boolean }

/** The networks in `nmcli -t -e yes -f SSID,SIGNAL,SECURITY,IN-USE device wifi list`: one per name (its
 *  strongest), hidden ones left out, the one in use first and then the strongest. */
export function wifiNetworks(out: string): WifiNetwork[] {
  const byName = new Map<string, WifiNetwork>()
  for (const [ssid, signalText, security = '', inUse = ''] of rows(out)) {
    if (!ssid) continue
    const signal = Number.parseInt(signalText ?? '', 10)
    const row: WifiNetwork = { ssid, signal: Number.isFinite(signal) ? signal : 0, security: security === '--' ? '' : security, active: inUse.trim() === '*' }
    const known = byName.get(ssid)
    if (!known) { byName.set(ssid, row); continue }
    const active = known.active || row.active
    byName.set(ssid, { ...(row.signal > known.signal ? row : known), active })
  }
  return [...byName.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.signal - a.signal || a.ssid.localeCompare(b.ssid))
}

const short = (error: unknown): string => String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 200)
const record = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value)

/** What the phone shows of `live_update.py status`: whether an update is ready, the version running and the new one. */
export function updateOf(status: Payload): Payload {
  const runtime = typeof status.runtime === 'string' ? status.runtime : null
  const ready = typeof status.ready === 'string' ? status.ready : null
  const system = record(status.system) ? status.system : {}
  const versions = record(status.versions) ? status.versions : {}
  const runtimeReady = ready !== null && ready !== runtime
  const update: Payload = {
    available: system.available === true || runtimeReady,
    runtime: typeof versions.cli === 'string' ? versions.cli : runtime === null ? null : basename(runtime),
  }
  const version = system.available === true && typeof system.version === 'string' ? system.version : runtimeReady ? basename(ready) : undefined
  if (version !== undefined) update.version = version
  if (status.restart_required === true) update.restartRequired = true
  // Each part on its own, for the phone's Version page: what runs, and what is waiting. hn and the CLI come
  // as one runtime; the OS package alone needs the computer restarted.
  const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null
  const waiting = record(status.ready_versions) ? status.ready_versions : {}
  update.parts = {
    os: { running: text(status.os), available: system.available === true, next: system.available === true ? text(system.version) : null },
    hn: { running: text(versions.hn), available: runtimeReady, next: runtimeReady ? text(waiting.hn) : null },
    cli: { running: text(versions.cli), available: runtimeReady, next: runtimeReady ? text(waiting.cli) : null },
  }
  return update
}

/** The Wi-Fi join's request, checked: a name of 1 to 32 bytes, and no password (an open network) or one of 8 to 63
 *  characters on one line. The reason it is refused otherwise, for a person to read. */
export function joinRequest(payload: Payload): { ssid: string; password: string } | { message: string } {
  const { ssid, password } = payload
  if (typeof ssid !== 'string' || ssid.length === 0) return { message: 'Choose a Wi-Fi network.' }
  if (Buffer.byteLength(ssid, 'utf8') > 32) return { message: 'That network name is too long.' }
  if (password === undefined || password === null || password === '') return { ssid, password: '' }
  if (typeof password !== 'string') return { message: 'The password must be text.' }
  if (password.length < 8 || password.length > 63) return { message: 'A Wi-Fi password has 8 to 63 characters.' }
  if (/[\r\n]/.test(password)) return { message: 'A Wi-Fi password cannot contain a line break.' }
  return { ssid, password }
}

export function startOsDevice(_core: CoreApi, deps: OsDeviceDeps = {}): ServiceRequests {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const read = deps.readFile ?? ((path: string) => readFile(path, 'utf8'))
  const exec = deps.exec ?? execBounded
  const detached = deps.spawnDetached ?? spawnDetached
  const now = deps.now ?? Date.now
  let updateStartedAt: number | null = null

  const harnessOs = (): boolean => env.HARNESS_OS === '1' || exists(LIVE_UPDATE)

  const currentSsid = async (): Promise<string | null> =>
    activeSsid(await exec(NMCLI, ['-t', '-e', 'yes', '-f', 'ACTIVE,SSID', 'device', 'wifi'], { timeout: NMCLI_TIMEOUT_MS }).catch(() => ''))

  const status = async (): Promise<Payload> => {
    if (!harnessOs()) return { harnessOs: false }
    const [update, ssid, hotspot, cmdline] = await Promise.all([
      exec(PYTHON, [LIVE_UPDATE, 'status'], { timeout: STATUS_TIMEOUT_MS }).then((out) => {
        const parsed: unknown = JSON.parse(out)
        if (!record(parsed)) throw new Error('live_update.py status did not answer an object')
        return updateOf(parsed)
      }).catch((error: unknown) => ({ available: false, error: short(error) })),
      currentSsid(),
      // The open Wi-Fi it hosts while locked or not set up: where a phone finds it after a restart.
      exec(PYTHON, [SETUP, 'name'], { timeout: NMCLI_TIMEOUT_MS }).then((out) => out.trim() || null).catch(() => null),
      read(CMDLINE).catch(() => ''),
    ])
    // Encrypted, it waits for its password at every start (installer.py: rd.luks.name=).
    // features: what this daemon does for a phone beyond the update and the Wi-Fi.
    return { harnessOs: true, update, wifi: { ssid }, hotspot, encrypted: /(^|\s)rd\.luks\.name=/.test(cmdline), features: ['sign_out', 'password', 'ssh'] }
  }

  const update = (payload: Payload): Payload => {
    if (updateStartedAt !== null && now() - updateStartedAt < UPDATE_BUSY_MS) return { error: 'BUSY' }
    // From a phone the person agreed to the restart there: a system update restarts the computer at once.
    const args = payload.reboot === true ? ['update', '--reboot'] : ['update']
    console.log(`[os-device] harness ${args.join(' ')}`)
    detached(HARNESS, args)
    updateStartedAt = now()
    return { started: true }
  }

  const scan = async (): Promise<Payload> => {
    const out = await exec(NMCLI, ['-t', '-e', 'yes', '-f', 'SSID,SIGNAL,SECURITY,IN-USE', 'device', 'wifi', 'list', '--rescan', 'auto'], { timeout: SCAN_TIMEOUT_MS })
      .catch((error: unknown) => { throw new Error(`Could not list Wi-Fi networks: ${short(error)}`) })
    return { networks: wifiNetworks(out) }
  }

  const join = (payload: Payload): Payload => {
    const request = joinRequest(payload)
    if ('message' in request) return { error: 'BAD_REQUEST', message: request.message }
    // The reply goes out before the computer leaves its network; the password only on the setup's stdin.
    detached('sudo', ['-n', PYTHON, SETUP, 'join'], JSON.stringify({ ssid: request.ssid, password: request.password }))
    return { started: true }
  }

  const result = async (): Promise<Payload> => {
    try {
      const parsed: unknown = JSON.parse(await read(SETUP_RESULT))
      return { result: record(parsed) ? parsed : null }
    } catch { return { result: null } }
  }

  /** Signed out for another account: its harnesses and projects stay, its Wi-Fi goes and its hotspot
   *  opens, for a phone on the other account to set it up. Out of reach right after: the reply first. */
  const signOut = (): Payload => {
    console.log('[os-device] sign-out')
    detached('sudo', ['-n', PYTHON, SETUP, 'sign-out'])
    return { started: true }
  }

  /** The computer's one password — the disk's where it is encrypted and the account's — changed, the
   *  current one checked first. Both only on the helper's stdin, never in argv or a log. */
  const password = async (payload: Payload): Promise<Payload> => {
    const { current, next } = payload
    if (typeof current !== 'string' || typeof next !== 'string' || !next) return { error: 'BAD_REQUEST', message: 'Enter the current password and a new one.' }
    const out = await exec('sudo', ['-n', PYTHON, SETUP, 'password'], { timeout: PASSWORD_TIMEOUT_MS, input: JSON.stringify({ current, new: next }) })
    const parsed: unknown = JSON.parse(out)
    if (!record(parsed)) throw new Error('setup.py password did not answer an object')
    return parsed
  }

  /** SSH on, off, or how it is, with the private addresses it answers on. */
  const ssh = async (payload: Payload): Promise<Payload> => {
    const state = payload.state === 'on' || payload.state === 'off' ? payload.state : 'status'
    if (state !== 'status') console.log(`[os-device] ssh ${state}`)
    const parsed: unknown = JSON.parse(await exec('sudo', ['-n', PYTHON, SETUP, 'ssh', state], { timeout: NMCLI_TIMEOUT_MS * 3 }))
    if (!record(parsed)) throw new Error('setup.py ssh did not answer an object')
    return parsed
  }

  return {
    os_device: async (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      const action = payload.action
      if (action === 'status') return status()
      if (typeof action !== 'string' || !ACTIONS.includes(action)) return { error: 'BAD_REQUEST' }
      if (!harnessOs()) return { error: 'UNSUPPORTED_OS' }
      try {
        if (action === 'update') return update(payload)
        if (action === 'wifi_scan') return await scan()
        if (action === 'wifi_join') return join(payload)
        if (action === 'sign_out') return signOut()
        if (action === 'password') return await password(payload)
        if (action === 'ssh') return await ssh(payload)
        return await result()
      } catch (error) {
        // Never the payload: it may hold a Wi-Fi password.
        console.error(`[os-device] ${action} failed:`, short(error))
        return { error: 'FAILED', message: short(error) }
      }
    },
  }
}
