/**
 * Installing a guest's engine on Windows (docs/superpowers/specs/2026-11-05-windows-guests-design.md): the Windows twin
 * of the macOS helper's `install` (lib/guestAccounts.ts `installGuestEngine`), which runs the engine's installer as the
 * guest so the engine lands in that account's own profile.
 *
 * Only the guest's own host can run a process as the guest, so this asks it to run two short panes: one that asks
 * whether the engine is on that account's PATH (`where claude`), and, when it is not, the package manager itself from
 * the Node runtime the setup task staged for guests. Both are plain argv — no shell text, no prompt, no flag of the
 * person's. The engine then starts in its own pane exactly as an owner's does, with the guest's PATH carrying
 * `%USERPROFILE%\.local` (the setup task writes that into the host's wrapper).
 */
import { ENGINE_WINDOWS_INSTALL } from '../engineInstall.js'
import type { TerminalBackend } from '../terminalBackend.js'
import type { TerminalRuntimeRef } from '../terminalTypes.js'
import { WINDOWS_GUEST_ROOT } from './guestRequests.js'

/** The Node runtime the setup task copies for guests, beside the signed pty (`guestScript.ts`). */
export function guestNodeDir(setupVersion: number): string {
  return `${WINDOWS_GUEST_ROOT}\\bin\\node-${setupVersion}`
}
export function guestNodeExe(setupVersion: number): string {
  return `${guestNodeDir(setupVersion)}\\node.exe`
}
/** npm ships inside Node's Windows distribution, beside `node.exe`. */
export function guestNpmCli(setupVersion: number): string {
  return `${guestNodeDir(setupVersion)}\\node_modules\\npm\\bin\\npm-cli.js`
}

/** The engines a guest's harness may be: the two the subscription relay can spend (lib/guestPaneCommand.ts). */
export const GUEST_INSTALLABLE_ENGINES = ['claude', 'codex'] as const
export type GuestInstallableEngine = (typeof GUEST_INSTALLABLE_ENGINES)[number]

/** Whether [engine] is one this machine may install for a guest. */
export function guestEngineInstallable(engine: string): engine is GuestInstallableEngine {
  return (GUEST_INSTALLABLE_ENGINES as readonly string[]).includes(engine)
}

/** `where <engine>`: the account's PATH answers with where it would run it. */
export function guestEngineProbeArgv(engine: GuestInstallableEngine): string[] {
  return ['cmd.exe', '/d', '/s', '/c', `where ${engine}`]
}

/**
 * The engine's own installer as the guest: npm from the staged Node, into [prefix] — the guest host's own `engines`
 * folder, which the guest may write and the owner may read (so the daemon resolves the shim it wrote, exactly as it
 * resolves one of its own: lib/windows/launch.ts `windowsEngineArgv`).
 */
export function guestEngineInstallArgv(engine: GuestInstallableEngine, prefix: string, setupVersion: number): string[] {
  const install = ENGINE_WINDOWS_INSTALL[engine]
  if (!('npm' in install)) throw new Error(`${engine} has no npm install on Windows`)
  return [guestNodeExe(setupVersion), guestNpmCli(setupVersion), 'install', '--global', '--prefix', prefix,
    '--no-fund', '--no-audit', '--loglevel=error', install.npm]
}

/** What this helper needs of a terminal backend: make a pane, ask what it runs, read it, close it. */
export type GuestEngineBackend = Pick<TerminalBackend, 'create' | 'kill' | 'paneState' | 'capture'>

export interface GuestEngineOptions {
  user: string
  engine: string
  /** The guest's workspace: where both short panes run. */
  cwd: string
  /** The guest host's `engines` folder: where npm installs as the guest, and where the daemon later resolves the engine. */
  prefix: string
  setupVersion: number
  /** The person's language is not needed here: both panes only install and record their status. */
  checkTimeoutMs?: number
  installTimeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

export type GuestEngineResult = { ok: true } | { ok: false; error: 'GUEST_ENGINE_UNSUPPORTED' | 'GUEST_ENGINE_CHECK_FAILED' | 'GUEST_ENGINE_INSTALL_FAILED'; detail: string }

/** The last lines a failed pane said, for the person to read as the reason. */
function tail(text: string, limit = 8): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-limit).join(' ').slice(0, 600)
}

async function waitForExit(backend: GuestEngineBackend, runtime: TerminalRuntimeRef,
  options: { timeoutMs: number; pollMs: number; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<number | null> {
  const deadline = options.now() + options.timeoutMs
  for (;;) {
    const state = await backend.paneState(runtime)
    // A pane that is gone has no exit status to report; unknown is asked again until the deadline.
    if (state === 'gone') return null
    if (state !== 'unknown' && state.dead) return state.exitStatus
    if (options.now() >= deadline) return null
    await options.sleep(options.pollMs)
  }
}

/**
 * Makes sure [engine] is installed for [user], installing it in a pane on the guest's own host when it is not. Answers
 * a failure with the pane's own last words, so the person is told what npm said rather than "it did not work".
 */
export async function ensureGuestEngine(backend: GuestEngineBackend, options: GuestEngineOptions): Promise<GuestEngineResult> {
  if (!guestEngineInstallable(options.engine)) {
    return { ok: false, error: 'GUEST_ENGINE_UNSUPPORTED', detail: 'You can start Claude Code or Codex on this computer.' }
  }
  const engine = options.engine
  const log = options.log ?? (() => {})
  const pollMs = options.pollMs ?? 500
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const wait = { pollMs, sleep, now }

  const asked = await backend.create({ cwd: options.cwd, label: 'guest-engine-check', command: guestEngineProbeArgv(engine) })
  if (asked.state !== 'succeeded') {
    return { ok: false, error: 'GUEST_ENGINE_CHECK_FAILED', detail: asked.reason || 'The guest\'s host could not check for the engine.' }
  }
  const present = await waitForExit(backend, asked.runtime, { ...wait, timeoutMs: options.checkTimeoutMs ?? 30_000 })
  await backend.kill(asked.runtime)
  if (present === 0) return { ok: true }

  log(`install · ${engine} · ${options.user}${present === null ? ' · the check did not answer' : ''}`)
  const installing = await backend.create({ cwd: options.cwd, label: `guest-engine-install-${engine}`,
    command: guestEngineInstallArgv(engine, options.prefix, options.setupVersion) })
  if (installing.state !== 'succeeded') {
    return { ok: false, error: 'GUEST_ENGINE_INSTALL_FAILED', detail: installing.reason || 'The guest\'s host could not start the install.' }
  }
  const status = await waitForExit(backend, installing.runtime, { ...wait, timeoutMs: options.installTimeoutMs ?? 20 * 60_000 })
  const said = await backend.capture(installing.runtime, { historyLines: 60, ansi: false })
  await backend.kill(installing.runtime)
  if (status === 0) {
    log(`install · ${engine} · ${options.user} · done`)
    return { ok: true }
  }
  const words = said.state === 'succeeded' ? tail(said.value) : ''
  return { ok: false, error: 'GUEST_ENGINE_INSTALL_FAILED',
    detail: words || (status === null ? `Installing ${engine} did not finish in time. Try again from this computer.`
      : `Installing ${engine} failed on this computer (${status}).`) }
}
