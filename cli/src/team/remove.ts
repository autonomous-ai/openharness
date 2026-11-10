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
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { runGuestCommand, type GuestRunner } from '../lib/guestAccounts.js'
import type { RunAdmin } from '../lib/windows/elevated.js'
import { WHOAMI_USER_ARGS, windowsUserSid } from '../lib/windows/whoami.js'
import { readTeamConfig, teamConfigFile } from './config.js'
import { REMOVE_REFUSED, buildLinuxRemoveScript, buildRemoveScript, type RemoveScriptInput } from './removeScript.js'

export type TeamRemoval =
  /** [removed] false: there was no Team account here. [left]: what the removal could not take now (Windows' profile
   *  registry, removed at the next restart; a task the account registered), in the script's words. */
  | { ok: true; removed: boolean; left?: string }
  /** CANCELLED: the person said no at the prompt. NO_PROMPT: no prompt can be shown here (Linux without a desktop).
   *  KEPT: the system refused to delete the account, and nothing was removed. FAILED: anything else, said by the script. */
  | { ok: false; code: 'CANCELLED' | 'NO_PROMPT' | 'KEPT' | 'FAILED'; message: string }

/** What the removal needs of the root-owned config (./config.ts), and the name Users & Groups shows. */
export type TeamRemovalTarget = RemoveScriptInput & { realName: string }

export interface TeamRemovalDeps {
  platform: NodeJS.Platform
  /** The account to remove, or null when there is none here. */
  target: () => TeamRemovalTarget | null
  runner: GuestRunner
  /** Windows: the elevated runner (lib/windows/elevated.ts). */
  windowsAdmin: () => Promise<RunAdmin>
  /** Linux: whether polkit's dialog can be shown from this process (pkexec, and a desktop session to show it in). */
  graphical: () => boolean
}

export const TEAM_REMOVAL_PROMPT = 'Harness wants to remove the old Harness Team account, its home folder and its daemon from this computer.'

/** The names setup always gave the account, for a config that is there but not one every check passes: the scripts
 *  themselves refuse an account or a home that is not the Team account's. */
const SETUP_HOMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Users/harnessteam', linux: '/home/harnessteam', win32: 'C:\\Users\\harnessteam',
}

/** This computer's Team account, from its config; setup's own names when the config is there but unreadable. */
export function teamRemovalTarget(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync,
  read = () => readTeamConfig(teamConfigFile(platform), undefined, platform),
  owner = () => ({ user: userInfo().username, home: homedir() })): TeamRemovalTarget | null {
  const config = read()
  if (config) return { user: config.user, home: config.home, owner: config.owner, ownerHome: config.ownerHome, realName: config.realName }
  const home = SETUP_HOMES[platform]
  if (!home || !exists(teamConfigFile(platform))) return null
  const { user, home: ownerHome } = owner()
  return { user: 'harnessteam', home, owner: user, ownerHome, realName: 'Harness Team' }
}

const CANCELLED: TeamRemoval = { ok: false, code: 'CANCELLED', message: 'Nothing was removed: the administrator prompt was cancelled.' }

/** What a refusal asks of the person, by system: macOS lets its own settings delete an account it refused the prompt. */
function keptMessage(platform: NodeJS.Platform, target: TeamRemovalTarget): string {
  if (platform === 'darwin') return `macOS kept the account. Delete "${target.realName}" in System Settings > Users & Groups, then try again.`
  return 'Something still runs as the account, so nothing was removed. Restart this computer, then try again.'
}

/** The script's own reason: its last `harness:` line. */
const reason = (stderr: string, code: number | null): string =>
  (stderr.trim().split(/[\r\n]+/).pop() ?? '').replace(/^.*harness: /, '') || `The removal stopped (exit ${code}).`

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

/**
 * The shell line root runs: the script itself, carried in the line as base64 and decoded by root. Never a file: one
 * written in this account's folders could be swapped by any process of this account between the prompt and root
 * reading it, and run as root on the person's password.
 */
export function rootLine(script: string): string {
  return `/bin/sh -c "$(printf %s ${Buffer.from(script, 'utf8').toString('base64')} | /usr/bin/base64 --decode)"`
}

/** AppleScript's string quotes, for the line `do shell script` runs. */
const appleQuote = (text: string): string => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

/** Runs [script] once as root on a Mac or Linux. */
async function runAsRoot(deps: TeamRemovalDeps, script: string): Promise<RootRun> {
  if (deps.platform === 'darwin') {
    const line = `do shell script ${appleQuote(rootLine(script))} with prompt ${appleQuote(TEAM_REMOVAL_PROMPT)} with administrator privileges`
    const result = await deps.runner('osascript', ['-e', line], { timeoutMs: 15 * 60_000 })
    if (result.code === 0) return { ok: true, stdout: result.stdout }
    // `do shell script` ends its error with the status in parentheses: the prompt's Cancel is -128, the script's own exit N.
    // It hands the script's stderr back with its lines ended by CR, not LF.
    const last = result.stderr.trim().split(/[\r\n]+/).pop() ?? ''
    const status = /\((-?\d+)\)$/.exec(last)?.[1]
    if (status === '-128') return { ok: false, cancelled: true }
    return { ok: false, cancelled: false, message: reason(last.replace(/\s*\(-?\d+\)$/, ''), result.code), status: status ? Number(status) : null }
  }
  const result = await deps.runner('pkexec', ['/bin/sh', '-c', rootLine(script)], { timeoutMs: 15 * 60_000 })
  if (result.code === 0) return { ok: true, stdout: result.stdout }
  if (pkexecCancelled(result.code, result.stderr)) return { ok: false, cancelled: true }
  return { ok: false, cancelled: false, message: reason(result.stderr, result.code), status: result.code }
}

async function runOnWindows(deps: TeamRemovalDeps, target: TeamRemovalTarget): Promise<RootRun> {
  // The owner's SID from this process's own token, for the staging folder's ACL: a bare name could be another account's.
  const who = await deps.runner('whoami', WHOAMI_USER_ARGS, { timeoutMs: 30_000 })
  const ownerSid = who.code === 0 ? windowsUserSid(who.stdout) : null
  if (!ownerSid) return { ok: false, cancelled: false, message: 'Could not read this account\'s SID (whoami /user).', status: null }
  // Loaded only here: the PowerShell builders are Windows' alone.
  const { buildWindowsRemoveScript } = await import('./windowsRemoveScript.js')
  const result = await (await deps.windowsAdmin())(buildWindowsRemoveScript(target), ownerSid)
  if (result.ok) return { ok: true, stdout: result.stdout }
  if (result.code === 'CANCELLED') return { ok: false, cancelled: true }
  return { ok: false, cancelled: false, message: result.message, status: result.status ?? null }
}

/** The script's lines about what it could not take now: Windows' held profile registry, a task the account registered. */
const LEFT = /is removed at the next restart|^harness: could not remove/

export async function removeTeamAccount(deps: TeamRemovalDeps): Promise<TeamRemoval> {
  const target = deps.target()
  if (!target) return { ok: true, removed: false }
  const { platform } = deps
  let run: RootRun
  try {
    if (platform === 'win32') run = await runOnWindows(deps, target)
    else if (platform === 'darwin') run = await runAsRoot(deps, buildRemoveScript(target))
    else if (platform === 'linux') {
      if (!deps.graphical()) return { ok: false, code: 'NO_PROMPT', message: 'No administrator prompt can be shown here: open Harness on this computer\'s desktop.' }
      run = await runAsRoot(deps, buildLinuxRemoveScript(target))
    } else return { ok: true, removed: false }
  } catch (error) {
    // A value no check passes (./layout.ts): nothing ran.
    return { ok: false, code: 'FAILED', message: (error as Error).message }
  }
  if (run.ok) {
    const left = run.stdout.split('\n').filter((line) => LEFT.test(line)).map((line) => line.replace(/^harness: /, '').trim())
    return { ok: true, removed: true, ...left.length ? { left: left.join('. ') } : {} }
  }
  if (run.cancelled) return CANCELLED
  if (run.status === REMOVE_REFUSED) return { ok: false, code: 'KEPT', message: keptMessage(platform, target) }
  return { ok: false, code: 'FAILED', message: run.message }
}

/** The real system: this computer's config, processes and prompt. */
export function teamRemovalDeps(): TeamRemovalDeps {
  return {
    platform: process.platform,
    target: () => teamRemovalTarget(),
    runner: runGuestCommand,
    windowsAdmin: async () => (await import('../lib/windows/elevated.js')).windowsAdminRunner(),
    graphical: () => existsSync('/usr/bin/pkexec') && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
  }
}
