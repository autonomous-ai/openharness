/**
 * Removes an old Harness Team account from this computer, once, behind the system's own administrator prompt: macOS's
 * (`osascript … with administrator privileges`), polkit's on Linux (`pkexec`), User Account Control on Windows
 * (lib/windows/elevated.ts). Desktop asks the person when it finds one (`harness __remove-team-account`, run hidden) and
 * shows what this answers.
 *
 * Why: Team accounts went with Swarm v3 (#4221) and their daemons only stopped themselves; the owner asked for them to be
 * removed (anh Dee, 2026-11-10). Root owns what setup made, so only the person's administrator password can take it away.
 *
 * Everything that touches the system goes through [TeamRemovalDeps]; the specs never run osascript, pkexec or PowerShell.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGuestCommand, type GuestRunner } from '../lib/guestAccounts.js'
import { adminAppleScript } from '../lib/guestHelperInstall.js'
import type { RunAdmin } from '../lib/windows/elevated.js'
import { WHOAMI_USER_ARGS, windowsUserSid } from '../lib/windows/whoami.js'
import { readTeamConfig, type TeamConfig } from './config.js'
import { REMOVE_REFUSED, buildLinuxRemoveScript, buildRemoveScript } from './removeScript.js'

export type TeamRemoval =
  /** [removed] false: there was no Team account here. [later]: what Windows removes only at the next restart. */
  | { ok: true; removed: boolean; later?: string }
  /** CANCELLED: the person said no at the prompt. NO_PROMPT: no prompt can be shown here (Linux without a desktop).
   *  KEPT: the system refused to delete the account, and nothing was removed. FAILED: anything else, said by the script. */
  | { ok: false; code: 'CANCELLED' | 'NO_PROMPT' | 'KEPT' | 'FAILED'; message: string }

export interface TeamRemovalDeps {
  platform: NodeJS.Platform
  readConfig: () => TeamConfig | null
  runner: GuestRunner
  /** Windows: the elevated runner (lib/windows/elevated.ts). */
  windowsAdmin: () => Promise<RunAdmin>
  /** Linux: whether polkit's dialog can be shown from this process (pkexec, and a desktop session to show it in). */
  graphical: () => boolean
  makeStage: () => string
  removeStage: (dir: string) => void
}

export const TEAM_REMOVAL_PROMPT = 'Harness wants to remove the old Harness Team account, its home folder and its daemon from this computer.'

const CANCELLED: TeamRemoval = { ok: false, code: 'CANCELLED', message: 'Nothing was removed: the administrator prompt was cancelled.' }

/** What a refusal asks of the person, by system: macOS lets its own settings delete an account it refused the prompt. */
function keptMessage(platform: NodeJS.Platform, config: TeamConfig): string {
  if (platform === 'darwin') {
    return `macOS kept the account. Delete "${config.realName}" in System Settings > Users & Groups, then try again.`
  }
  return 'Something still runs as the account, so nothing was removed. Restart this computer, then try again.'
}

/** The script's own reason, its last `harness:` line, and its exit status: osascript ends that line with ` (N)`, and
 *  hands the script's stderr back with its lines ended by CR, not LF. */
function stopped(stderr: string, code: number | null): { message: string; status: number | null } {
  const last = stderr.trim().split(/[\r\n]+/).pop() ?? ''
  const status = /\((\d+)\)$/.exec(last)?.[1]
  return {
    message: last.replace(/^.*harness: /, '').replace(/\s*\(\d+\)$/, '') || `The removal stopped (exit ${code}).`,
    status: status ? Number(status) : code,
  }
}

/**
 * Whether pkexec's answer is the person's "no". 126 is a dismissed dialog. 127 is a refused authorization only when pkexec
 * says so: it is also no authentication agent to ask with, and a command the script could not find.
 */
function pkexecCancelled(code: number | null, stderr: string): boolean {
  if (code === 126) return true
  return code === 127 && (stderr.includes('Error executing command as another user: Not authorized')
    || stderr.includes('Error executing command as another user: Request dismissed'))
}

type RootRun = { ok: true; stdout: string } | { ok: false; cancelled: true } | { ok: false; cancelled: false; message: string; status: number | null }

/** Runs [script] once as root on a Mac or Linux, from a folder only this account can open (mkdtemp is 0700). */
async function runAsRoot(deps: TeamRemovalDeps, script: string): Promise<RootRun> {
  const stage = deps.makeStage()
  try {
    chmodSync(stage, 0o700)
    const path = join(stage, 'remove.sh')
    writeFileSync(path, script, { mode: 0o700 })
    const result = deps.platform === 'darwin'
      ? await deps.runner('osascript', ['-e', adminAppleScript(path, TEAM_REMOVAL_PROMPT)], { timeoutMs: 15 * 60_000 })
      : await deps.runner('pkexec', ['/bin/sh', path], { timeoutMs: 15 * 60_000 })
    if (result.code === 0) return { ok: true, stdout: result.stdout }
    // -128 is the macOS prompt's Cancel.
    if (deps.platform === 'darwin' ? /-128|User canceled/i.test(result.stderr) : pkexecCancelled(result.code, result.stderr)) {
      return { ok: false, cancelled: true }
    }
    return { ok: false, cancelled: false, ...stopped(result.stderr, result.code) }
  } finally {
    deps.removeStage(stage)
  }
}

async function runOnWindows(deps: TeamRemovalDeps, config: TeamConfig): Promise<RootRun> {
  // The owner's SID from this process's own token, for the staging folder's ACL: a bare name could be another account's.
  const who = await deps.runner('whoami', WHOAMI_USER_ARGS, { timeoutMs: 30_000 })
  const ownerSid = who.code === 0 ? windowsUserSid(who.stdout) : null
  if (!ownerSid) return { ok: false, cancelled: false, message: 'Could not read this account\'s SID (whoami /user).', status: null }
  // Loaded only here: the PowerShell builders are Windows' alone.
  const { buildWindowsRemoveScript } = await import('./windowsRemoveScript.js')
  const script = buildWindowsRemoveScript({ user: config.user, home: config.home, owner: config.owner, ownerHome: config.ownerHome })
  const result = await (await deps.windowsAdmin())(script, ownerSid)
  if (result.ok) return { ok: true, stdout: result.stdout }
  if (result.code === 'CANCELLED') return { ok: false, cancelled: true }
  return { ok: false, cancelled: false, message: result.message, status: result.status ?? null }
}

export async function removeTeamAccount(deps: TeamRemovalDeps): Promise<TeamRemoval> {
  const config = deps.readConfig()
  if (!config) return { ok: true, removed: false }
  const { platform } = deps
  let run: RootRun
  try {
    if (platform === 'win32') run = await runOnWindows(deps, config)
    else if (platform === 'darwin') run = await runAsRoot(deps, buildRemoveScript(config))
    else if (platform === 'linux') {
      // Nothing is staged for a prompt that cannot be shown.
      if (!deps.graphical()) return { ok: false, code: 'NO_PROMPT', message: 'No administrator prompt can be shown here: open Harness on this computer\'s desktop.' }
      run = await runAsRoot(deps, buildLinuxRemoveScript(config))
    } else return { ok: true, removed: false }
  } catch (error) {
    // A value in the config no check passes (./layout.ts): nothing ran.
    return { ok: false, code: 'FAILED', message: (error as Error).message }
  }
  if (run.ok) {
    // Windows may hold the profile's registry files until it restarts (./windowsRemoveScript.ts, step 5).
    const later = run.stdout.split('\n').find((line) => line.includes('is removed at the next restart'))
    return { ok: true, removed: true, ...later ? { later: later.replace(/^harness: /, '').trim() } : {} }
  }
  if (run.cancelled) return CANCELLED
  if (run.status === REMOVE_REFUSED) return { ok: false, code: 'KEPT', message: keptMessage(platform, config) }
  return { ok: false, code: 'FAILED', message: run.message }
}

/** The real system: this computer's config, processes, prompt and temporary folder. */
export function teamRemovalDeps(): TeamRemovalDeps {
  return {
    platform: process.platform,
    readConfig: () => readTeamConfig(),
    runner: runGuestCommand,
    windowsAdmin: async () => (await import('../lib/windows/elevated.js')).windowsAdminRunner(),
    graphical: () => existsSync('/usr/bin/pkexec') && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    makeStage: () => mkdtempSync(join(tmpdir(), 'harness-team-remove-')),
    removeStage: (dir) => rmSync(dir, { recursive: true, force: true }),
  }
}
