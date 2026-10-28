/**
 * A Harness OS computer, managed from the owner's phone (`os_device`): whether this computer runs Harness OS,
 * whether an update is ready and starting it, the Wi-Fi networks it sees, and moving it to another one, and
 * the GitHub account its agents use (`github`: a device code entered on the phone, no screen needed here).
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
/** A check asked from the phone: the feeds read, a new hn and CLI downloaded and verified (as the
 *  harness-update.service timer's own check, bounded at 6 minutes there too). */
export const CHECK_TIMEOUT_MS = 6 * 60_000
/** The timer's check, with the OS release asked now instead of from its day-old answer (live_update.py
 *  check_system): every Harness OS since 0.1.7 has check(force_system=). */
export const CHECK_NOW = `import sys; sys.path.insert(0, '/usr/lib/harness-os'); import live_update; live_update.check(force_system=True)`
export const STATUS_TIMEOUT_MS = 15_000
export const NMCLI_TIMEOUT_MS = 10_000
export const SCAN_TIMEOUT_MS = 20_000
/** The disk's key slots are slow to change on purpose (a passphrase is hashed for seconds), twice. */
export const PASSWORD_TIMEOUT_MS = 90_000
/** The GitHub CLI, in the image and a dependency of the harness-os package (os/tools/build-package.py). */
export const GH = '/usr/bin/gh'
export const GH_TIMEOUT_MS = 15_000
/** Putting the GitHub CLI back: a download of some 15 MB, and os/setup.py's own bound with room to answer. */
export const GH_INSTALL_TIMEOUT_MS = 300_000
/** How long a GitHub sign-in waits for its code to be entered: GitHub's device codes last 15 minutes. */
export const GITHUB_SIGN_IN_MS = 15 * 60_000
const ACTIONS = ['update', 'check_update', 'wifi_scan','wifi_join', 'wifi_result', 'sign_out', 'password', 'ssh', 'github']
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
  /** Start `gh auth login`'s device flow (a code to enter at github.com/login/device). */
  githubSignIn?: () => GithubSignIn
  now?: () => number
}

/** A `gh auth login` under way: the code it shows, and it ending once the code was entered (or refused). */
export interface GithubSignIn {
  code: Promise<{ code: string; url: string }>
  done: Promise<void>
  stop: () => void
}

/** The code and the page in `gh auth login --web`'s output: "First copy your one-time code: AB12-CD34", or
 *  "One-time code (AB12-CD34) copied to clipboard" where it found a clipboard. */
export function deviceCodeOf(output: string): { code: string; url: string } | null {
  const code = /one-time code\W*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output)?.[1]
  if (!code) return null
  return { code, url: /https:\/\/\S+\/login\/device/.exec(output)?.[0] ?? 'https://github.com/login/device' }
}

/** The account `gh` uses on github.com, from `gh auth status --json hosts`; null when signed out or its
 *  token no longer works. */
export function githubLoginOf(out: string): string | null {
  const parsed: unknown = JSON.parse(out)
  const hosts = record(parsed) && record(parsed.hosts) ? parsed.hosts : {}
  const accounts = Array.isArray(hosts['github.com']) ? hosts['github.com'] : []
  const active = accounts.find((a: unknown) => record(a) && a.active === true)
  return record(active) && active.state === 'success' && typeof active.login === 'string' ? active.login : null
}

/** `gh auth login`'s device flow, bounded by GITHUB_SIGN_IN_MS. BROWSER=true: the page opens on the phone,
 *  not on this computer's screen; its stdin closed, it asks nothing and prints the code. Without the
 *  screen's display either: the code is the phone's to copy, not this computer's clipboard. */
export function githubDeviceSignIn(): GithubSignIn {
  const { WAYLAND_DISPLAY: _wayland, DISPLAY: _x11, ...env } = process.env
  const child = spawn(GH, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, BROWSER: 'true', GH_PROMPT_DISABLED: '1' } })
  let output = ''
  let shown: (value: { code: string; url: string }) => void
  let failed: (error: Error) => void
  const code = new Promise<{ code: string; url: string }>((resolve, reject) => { shown = resolve; failed = reject })
  const read = (chunk: Buffer): void => {
    if (output.length < MAX_OUTPUT) output += chunk.toString('utf8')
    const found = deviceCodeOf(output)
    if (found) shown(found)
  }
  child.stdout!.on('data', read)
  child.stderr!.on('data', read)
  const timer = setTimeout(() => child.kill('SIGKILL'), GITHUB_SIGN_IN_MS)
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => { clearTimeout(timer); failed(error); reject(error) })
    child.on('close', (status) => {
      clearTimeout(timer)
      const error = new Error(output.trim().split('\n').pop()?.slice(0, 200) || `gh auth login exited ${status}`)
      failed(error)
      if (status === 0) resolve(); else reject(error)
    })
  })
  // Each read on its own: a code never shown, or a sign-in nobody waits on, is not an unhandled rejection.
  code.catch(() => {})
  done.catch(() => {})
  return { code, done, stop: () => { clearTimeout(timer); child.kill('SIGKILL') } }
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
  const startSignIn = deps.githubSignIn ?? githubDeviceSignIn
  const now = deps.now ?? Date.now
  let updateStartedAt: number | null = null
  /** The GitHub sign-in waiting for its code, and why the last one ended without signing in. */
  let signingIn: { run: GithubSignIn; code: string; url: string } | null = null
  let signInError: string | null = null
  /** A sign-in started and not yet showing its code. */
  let starting: Promise<void> | null = null
  /** The GitHub CLI being put back, for a sign-in. */
  let installing: Promise<void> | null = null
  /** A check for updates asked from the phone, and why the last one did not finish. */
  let checking: Promise<void> | null = null
  let checkError: string | null = null

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
      }).catch((error: unknown): Payload => ({ available: false, error: short(error) })),
      currentSsid(),
      // The open Wi-Fi it hosts while locked or not set up: where a phone finds it after a restart.
      exec(PYTHON, [SETUP, 'name'], { timeout: NMCLI_TIMEOUT_MS }).then((out) => out.trim() || null).catch(() => null),
      read(CMDLINE).catch(() => ''),
    ])
    if (checking) update.checking = true
    else if (checkError !== null) update.checkError = checkError
    // Encrypted, it waits for its password at every start (installer.py: rd.luks.name=).
    // features: what this daemon does for a phone beyond the update and the Wi-Fi.
    return {
      harnessOs: true, update, wifi: { ssid }, hotspot, encrypted: /(^|\s)rd\.luks\.name=/.test(cmdline),
      features: ['sign_out', 'password', 'ssh', 'github', 'check_update'],
    }
  }

  /** Check for updates now, as the timer does every 15 minutes, the OS release too: answered at once,
   *  `update.checking` in the status until it is done, for the phone to follow. One at a time. */
  const checkUpdate = (): Payload => {
    checkError = null
    checking ??= exec(PYTHON, ['-c', CHECK_NOW], { timeout: CHECK_TIMEOUT_MS })
      .then(() => { console.log('[os-device] checked for updates') })
      .catch((error: unknown) => {
        console.error('[os-device] check for updates failed:', short(error))
        checkError = 'Could not check for updates. Check its internet, then try again.'
      })
      .finally(() => { checking = null })
    return { started: true }
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

  /** The GitHub account this computer's `gh` (and git, through it) uses, for the agents to clone, push and
   *  open pull requests with. `{ login }`, with the code to enter while a sign-in waits for it. */
  const githubStatus = async (): Promise<Payload> => {
    const failed = signInError && !signingIn ? { signInError } : {}
    // Gone (removed by hand, say): signed in to nothing, and put back by the next Sign in.
    if (!exists(GH)) return { login: null, ...(installing ? { installing: true } : { missing: true, ...failed }) }
    const login = githubLoginOf(await exec(GH, ['auth', 'status', '--json', 'hosts'], { timeout: GH_TIMEOUT_MS }))
    return {
      login,
      ...(signingIn && !login ? { signingIn: { code: signingIn.code, url: signingIn.url } } : {}),
      ...(!login ? failed : {}),
    }
  }

  /** A device sign-in started, and answered with its code once `gh` shows it; the one already waiting
   *  answered again. Signed in, git is set up to use the account (`gh auth setup-git`). Without `gh`, it is
   *  installed first, then the sign-in starts: answered at once `{ installing }`, for the phone to follow. */
  const githubSignIn = async (): Promise<Payload> => {
    if (!exists(GH)) {
      installing ??= installGh().finally(() => { installing = null })
      return githubStatus()
    }
    // A second ask while the first waits for its code (a phone asking again): the same sign-in, not another.
    if (!signingIn) {
      starting ??= startGithubSignIn().finally(() => { starting = null })
      await starting
    }
    return githubStatus()
  }

  /** The GitHub CLI put back from Harness OS's own repositories (os/setup.py install-gh), then the sign-in
   *  it was installed for started. Longer than a phone waits on one answer, so never awaited by one. */
  const installGh = async (): Promise<void> => {
    signInError = null
    console.log('[os-device] github: installing the GitHub CLI')
    try {
      const parsed: unknown = JSON.parse(await exec('sudo', ['-n', PYTHON, SETUP, 'install-gh'], { timeout: GH_INSTALL_TIMEOUT_MS }))
      if (!record(parsed) || parsed.installed !== true) {
        signInError = record(parsed) && typeof parsed.message === 'string' ? parsed.message : 'The GitHub CLI could not be installed.'
        return
      }
    } catch (error) {
      // An OS from before install-gh: sudo refuses it.
      console.error('[os-device] github: install-gh failed:', short(error))
      signInError = 'The GitHub CLI could not be installed here: update this computer, then try again.'
      return
    }
    // Removing the package left its sign-in (~/.config/gh): back, it may be signed in already.
    if ((await githubStatus().catch(() => ({ login: null }))).login) return
    starting ??= startGithubSignIn().finally(() => { starting = null })
    await starting.catch((error: unknown) => { signInError = short(error) })
  }

  /** `gh auth login` started and kept once it shows its code; failed when it shows none in GH_TIMEOUT_MS. */
  const startGithubSignIn = async (): Promise<void> => {
    const run = startSignIn()
    signInError = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const shown = await Promise.race([run.code, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), GH_TIMEOUT_MS) })])
      .finally(() => clearTimeout(timer))
    if (!shown) {
      run.stop()
      throw new Error('gh auth login did not show a code')
    }
    console.log('[os-device] github sign-in started')
    signingIn = { run, ...shown }
    run.done.then(async () => {
      await exec(GH, ['auth', 'setup-git', '--hostname', 'github.com'], { timeout: GH_TIMEOUT_MS })
        .catch((error: unknown) => console.error('[os-device] gh auth setup-git failed:', short(error)))
      console.log('[os-device] github signed in')
    }, (error: unknown) => {
      if (signingIn?.run === run) signInError = short(error)
    }).finally(() => { if (signingIn?.run === run) signingIn = null })
  }

  /** Signed out of GitHub here: the account's token taken off this computer, a sign-in waiting stopped. */
  const githubSignOut = async (): Promise<Payload> => {
    if (signingIn) { signingIn.run.stop(); signingIn = null }
    signInError = null
    const status = await githubStatus()
    if (typeof status.login === 'string') {
      console.log('[os-device] github sign-out')
      await exec(GH, ['auth', 'logout', '--hostname', 'github.com', '--user', status.login], { timeout: GH_TIMEOUT_MS })
    }
    return githubStatus()
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
        if (action === 'check_update') return checkUpdate()
        if (action === 'wifi_scan') return await scan()
        if (action === 'wifi_join') return join(payload)
        if (action === 'sign_out') return signOut()
        if (action === 'password') return await password(payload)
        if (action === 'ssh') return await ssh(payload)
        if (action === 'github') {
          if (payload.state === 'sign_in') return await githubSignIn()
          if (payload.state === 'sign_out') return await githubSignOut()
          return await githubStatus()
        }
        return await result()
      } catch (error) {
        // Never the payload: it may hold a Wi-Fi password.
        console.error(`[os-device] ${action} failed:`, short(error))
        return { error: 'FAILED', message: short(error) }
      }
    },
  }
}
