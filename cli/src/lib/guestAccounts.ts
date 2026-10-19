/**
 * A guest's OS account on this machine, through the guest helper (cli/assets/guest-helper/guest-helper.sh,
 * docs/plans/2026-10-19-guest-machine-sharing-plan.md): created on first use, and the command a tmux pane
 * runs to start a guest's harness as that account. Every call is `sudo -n <helper> …`, which the
 * owner's one-time install allowed (guestHelperInstall.ts); nothing here asks for a password.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const GUEST_HELPER_PATH = '/usr/local/libexec/harness/guest-helper'

/** Where guests' homes are (the helper's HOME_ROOT): never the owner's own home or `staff`'s reach. */
export function guestHomeRoot(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/Users/Shared/HarnessGuests' : '/home/harness-guests'
}

/** A folder of the owner's shared with every guest (docs/plans/2026-10-19-guest-machine-sharing-plan.md,
 *  "Shared folders"): read, or read and write. */
export interface SharedFolder { path: string; write: boolean }

/** The variables a guest's harness may be given: the helper's GUEST_ENV_KEYS and the sudoers drop-in's
 *  env_keep, which a test keeps equal. `LC_*` is allowed beside them. */
export const GUEST_ENV_KEYS = [
  'TERM', 'COLORTERM', 'LANG', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
  'HARNESS_RELAY_TOKEN', 'HARNESS_HOOK_TOKEN', 'HARNESS_HOOK_URL', 'HARNESS_AGENT_ID', 'CODEX_HOME',
] as const

export type GuestEngine = 'claude' | 'codex' | 'opencode'
export const GUEST_ENGINES: readonly GuestEngine[] = ['claude', 'codex', 'opencode']

export type GuestErrorCode =
  | 'GUEST_HELPER_MISSING' // the helper is not installed: the owner has not turned sharing on here yet
  | 'GUEST_HELPER_NOT_AUTHORIZED' // sudo wants a password: the sudoers drop-in is missing or for another user
  | 'GUEST_INVALID' // the helper refused what it was given (a user, a folder, an email)
  | 'GUEST_ENV_NOT_ALLOWED' // a variable a guest's harness may not be given
  | 'GUEST_HELPER_FAILED' // anything else, in the helper's words

export class GuestHelperError extends Error {
  constructor(readonly code: GuestErrorCode, message: string) {
    super(message)
    this.name = 'GuestHelperError'
  }
}

export interface GuestAccount {
  /** The OS user, `hg_<12 hex>`. */
  user: string
  home: string
  /** Where a guest's harnesses start: `<home>/work`. */
  workspace: string
}

export interface GuestRunResult { code: number | null; stdout: string; stderr: string }
export interface GuestRunOptions {
  timeoutMs?: number
  /** The terminal's own stdin/stdout/stderr: a password prompt (Linux `sudo`) must reach the person. */
  interactive?: boolean
  /** Each line of stdout as it comes (an engine install's progress). */
  onLine?: (line: string) => void
}
export type GuestRunner = (command: string, args: readonly string[], options?: GuestRunOptions) => Promise<GuestRunResult>

/** Runs a command and collects its output; never rejects (a spawn error is `code: null`). */
export const runGuestCommand: GuestRunner = (command, args, options = {}) => new Promise((resolve) => {
  let stdout = '', stderr = '', pending = ''
  const child = spawn(command, [...args], { stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
  const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : null
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    stdout += text
    if (!options.onLine) return
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) options.onLine(line)
  })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  child.on('error', (error) => { if (timer) clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr || error.message }) })
  child.on('close', (code) => {
    if (timer) clearTimeout(timer)
    if (pending && options.onLine) options.onLine(pending)
    resolve({ code, stdout, stderr })
  })
})

const GUEST_USER = /^hg_[0-9a-f]{12}$/

/** The OS user a guest gets: `hg_` and the first 12 hex of sha256(the lower-cased email). The helper
 *  derives the same name itself; a test holds the two equal. */
export function guestUserFor(email: string): string {
  return `hg_${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)}`
}

/** Where a guest's harnesses start unless it picks a shared folder: `<home>/work`, as the helper makes it. */
export function guestWorkspaceFor(email: string, platform: NodeJS.Platform = process.platform): string {
  return `${guestHomeRoot(platform)}/${guestUserFor(email)}/work`
}

export function isGuestUser(user: string): boolean {
  return GUEST_USER.test(user)
}

export function guestEnvAllowed(key: string): boolean {
  return (GUEST_ENV_KEYS as readonly string[]).includes(key) || /^LC_[A-Z_]+$/.test(key)
}

/**
 * What a tmux pane runs to start [argv] as the guest [user], in [cwd] (inside the guest's home), with
 * [env]: `argv` for the pane, `env` to set on it (`tmux new-session -e`). The values travel in the
 * environment and the helper takes them over with `--pass` (kept by the sudoers drop-in): a token on a
 * command line is readable by every account on the machine in `ps`.
 *
 * ⚠️ The pane's own working directory (tmux `-c`) must be one the owner can enter — the guest's home is
 * 0700 with an owner read ACL — and is not where the harness runs: the helper changes to [cwd] as the guest.
 */
export function guestRunCommand(
  user: string, cwd: string, env: Readonly<Record<string, string>>, argv: readonly string[], helperPath = GUEST_HELPER_PATH,
): { argv: string[]; env: Record<string, string> } {
  if (!isGuestUser(user)) throw new GuestHelperError('GUEST_INVALID', `not a guest user: ${user}`)
  if (!isAbsolute(cwd)) throw new GuestHelperError('GUEST_INVALID', `not an absolute folder: ${cwd}`)
  if (argv.length === 0) throw new GuestHelperError('GUEST_INVALID', 'nothing to run')
  const pass: string[] = []
  const paneEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!guestEnvAllowed(key)) throw new GuestHelperError('GUEST_ENV_NOT_ALLOWED', `not allowed for a guest: ${key}`)
    pass.push('--pass', key)
    paneEnv[key] = value
  }
  return { argv: ['sudo', '-n', helperPath, 'run', user, '--cwd', cwd, ...pass, '--', ...argv], env: paneEnv }
}

/** The helper's answer as a GuestHelperError, by what sudo and the helper say. */
export function guestHelperFailure(result: GuestRunResult): GuestHelperError {
  const said = result.stderr.trim() || result.stdout.trim()
  if (/a password is required|a terminal is required|not allowed to execute|may not run sudo|no tty present/i.test(said)) {
    return new GuestHelperError('GUEST_HELPER_NOT_AUTHORIZED', 'This computer has not allowed Harness to run guests yet. Turn sharing on again to allow it.')
  }
  if (result.code === null || /command not found|No such file or directory/.test(said)) {
    return new GuestHelperError('GUEST_HELPER_MISSING', 'The guest helper is not installed on this computer.')
  }
  const message = said.replace(/^guest-helper: /, '') || `The guest helper failed (${result.code}).`
  // The helper exits 2 for a refused argument and 3 for a guest that does not exist.
  return new GuestHelperError(result.code === 2 || result.code === 3 ? 'GUEST_INVALID' : 'GUEST_HELPER_FAILED', message)
}

export interface GuestAccountsDeps {
  runner?: GuestRunner
  helperPath?: string
  /** Whether the helper is installed (a file check; no sudo). */
  installed?: (path: string) => boolean
  /** The names in the guests' home root (it is 0755: no sudo). */
  homes?: () => string[]
}

export interface GuestAccounts {
  /** The guest's account, created on first use; one call per email at a time. */
  ensureGuest(email: string): Promise<GuestAccount>
  /** Installs an engine into the guest's home, as the guest; [onLine] hears its progress. */
  installGuestEngine(user: string, engine: GuestEngine, onLine?: (line: string) => void): Promise<void>
  /** Deletes the guest's account, processes and files: sharing with them has ended. */
  removeGuest(user: string): Promise<void>
  /** Gives the guest exactly these of the owner's folders. The helper changes only what changed, so asking
   *  again with the same folders costs one `sudo -n`. */
  shareFolders(user: string, folders: readonly SharedFolder[]): Promise<void>
  /** The guests that have an account here, by user. */
  guests(): string[]
  runCommand: typeof guestRunCommand
}

export function createGuestAccounts(deps: GuestAccountsDeps = {}): GuestAccounts {
  const runner = deps.runner ?? runGuestCommand
  const helperPath = deps.helperPath ?? GUEST_HELPER_PATH
  const installed = deps.installed ?? existsSync
  const homes = deps.homes ?? (() => { try { return readdirSync(guestHomeRoot()) } catch { return [] } })
  const accounts = new Map<string, Promise<GuestAccount>>()

  const helper = async (args: string[], options?: GuestRunOptions): Promise<string> => {
    if (!installed(helperPath)) throw new GuestHelperError('GUEST_HELPER_MISSING', 'The guest helper is not installed on this computer.')
    const result = await runner('sudo', ['-n', helperPath, ...args], options)
    if (result.code !== 0) throw guestHelperFailure(result)
    return result.stdout
  }

  const ensure = async (email: string): Promise<GuestAccount> => {
    const out = await helper(['ensure', email], { timeoutMs: 60_000 })
    let parsed: unknown
    try {
      parsed = JSON.parse(out.trim().split('\n').pop() ?? '')
    } catch {
      throw new GuestHelperError('GUEST_HELPER_FAILED', 'The guest helper answered something unexpected.')
    }
    const account = parsed as Partial<GuestAccount>
    if (typeof account.user !== 'string' || typeof account.home !== 'string' || typeof account.workspace !== 'string'
      || account.user !== guestUserFor(email) || !account.workspace.startsWith(`${account.home}/`)) {
      throw new GuestHelperError('GUEST_HELPER_FAILED', 'The guest helper answered something unexpected.')
    }
    return { user: account.user, home: account.home, workspace: account.workspace }
  }

  return {
    ensureGuest(email) {
      const key = email.trim().toLowerCase()
      const known = accounts.get(key)
      if (known) return known
      const pending = ensure(key)
      accounts.set(key, pending)
      // A failure is not remembered: the next call asks again (the helper may be installed by then).
      pending.catch(() => { if (accounts.get(key) === pending) accounts.delete(key) })
      return pending
    },
    async installGuestEngine(user, engine, onLine) {
      if (!isGuestUser(user)) throw new GuestHelperError('GUEST_INVALID', `not a guest user: ${user}`)
      if (!GUEST_ENGINES.includes(engine)) throw new GuestHelperError('GUEST_INVALID', `not an engine a guest can install: ${engine}`)
      await helper(['install', user, engine], { timeoutMs: 10 * 60_000, ...(onLine ? { onLine } : {}) })
    },
    async removeGuest(user) {
      if (!isGuestUser(user)) throw new GuestHelperError('GUEST_INVALID', `not a guest user: ${user}`)
      for (const [email, pending] of accounts) {
        const account = await pending.catch(() => null)
        if (account?.user === user) accounts.delete(email)
      }
      await helper(['remove', user], { timeoutMs: 60_000 })
    },
    async shareFolders(user, folders) {
      if (!isGuestUser(user)) throw new GuestHelperError('GUEST_INVALID', `not a guest user: ${user}`)
      // A first share of a large folder sets an entry on everything in it: minutes, not seconds.
      await helper(['share', user, ...folders.flatMap((f) => [f.write ? '--write' : '--read', f.path])], { timeoutMs: 10 * 60_000 })
    },
    guests: () => homes().filter(isGuestUser).sort(),
    runCommand: (user, cwd, env, argv) => guestRunCommand(user, cwd, env, argv, helperPath),
  }
}
