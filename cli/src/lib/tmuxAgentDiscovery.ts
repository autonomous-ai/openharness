/**
 * The tmux panes this daemon owns, in one bounded read, and the renaming of sessions an older build named.
 * Which engine process owns each pane is decided over this listing, by lib/terminalAgentDiscovery.ts
 * through the tmux backend (lib/tmuxBackend.ts).
 */

import { execFile } from 'node:child_process'
import { patientExec } from './patientExec.js'
import { env } from '../config/env.js'
import {
  buildHarnessSessionLabel, harnessPaneOwner, isLegacyHarnessSession, ownedHere, paneOwnerFormat, paneOwnerOf,
} from './harnessSessionLabel.js'
import { inTmuxRoom } from './tmuxControlGate.js'
import { tmuxFeatures } from './tmuxVersion.js'
import { isNoTmuxServerError, rememberTmuxServer, reviveRemovedTmuxSocket } from './tmux.js'

export interface TmuxPaneSnapshot {
  tmuxPane: string
  rootPid: number
  tmuxSessionName: string
  cwd: string
  /** The daemon that created the pane (`HARNESS_OWNER_OPTION`); empty when no daemon tagged it. */
  owner?: string
}

// The rule for "no server is running", shared with every other tmux read (lib/tmux.ts).
export { isNoTmuxServerError } from './tmux.js'

// A held event loop must not turn a timeout into an empty answer (patientExec.ts).
const run = patientExec(execFile)

function execText(
  command: string,
  args: string[],
  timeout: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    run(command, args, { timeout, ...(env && { env }) }, (err, stdout) => {
      if (err) { resolve({ ok: false, error: err.message }); return }
      resolve({ ok: true, stdout })
    })
  })
}

/** What every pane listing asks tmux for. The owner tag goes last: a folder's path can hold `|`, the tag
 *  never does, so the last `|` is always the one before it. How the tag is read depends on the tmux
 *  (`paneOwnerFormat`): before 3.0 it is not a pane option. */
export function paneFormat(paneOptions: boolean): string {
  return `#{pane_id}|#{pane_pid}|#{session_name}|#{pane_current_path}|${paneOwnerFormat(paneOptions)}`
}

/** The listing on a tmux with pane options. */
export const PANE_FORMAT = paneFormat(true)

export function parsePanes(stdout: string): TmuxPaneSnapshot[] {
  const panes: TmuxPaneSnapshot[] = []
  for (const line of stdout.split('\n')) {
    const first = line.indexOf('|')
    const second = first < 0 ? -1 : line.indexOf('|', first + 1)
    const third = second < 0 ? -1 : line.indexOf('|', second + 1)
    if (first < 0 || second < 0 || third < 0) continue
    const tmuxPane = line.slice(0, first)
    const pidText = line.slice(first + 1, second)
    const rootPid = Number(pidText)
    if (!/^%\d+$/.test(tmuxPane) || !Number.isSafeInteger(rootPid) || rootPid <= 0) continue
    // A listing without the owner field (an older format) is a pane nobody tagged.
    const rest = line.slice(third + 1)
    const tag = rest.lastIndexOf('|')
    panes.push({
      tmuxPane,
      rootPid,
      tmuxSessionName: line.slice(second + 1, third),
      cwd: tag < 0 ? rest : rest.slice(0, tag),
      owner: tag < 0 ? '' : paneOwnerOf(rest.slice(tag + 1)),
    })
  }
  return panes
}

export type TmuxPaneInventory =
  | { ok: true; panes: TmuxPaneSnapshot[] }
  | { ok: false; error: string }

/**
 * One bounded tmux inventory read, shared by discovery and the neutral backend adapter.
 *
 * Only this daemon's panes are returned (`ownedHere`): the ones it tagged, in whatever session the
 * person has since renamed or moved them into, and untagged ones only in sessions Harness named. A
 * session the user opened by hand, or one an agent spawned itself with a nested `tmux new-session`, is
 * invisible to every discovery path (autonomous-harness-desktop#6); so is a pane another daemon on this
 * tmux server created (`HARNESS_OWNER_OPTION`): a dev daemon beside the release one opened an agent for
 * every one of the release daemon's panes, and could stop them (e2e/twodaemons.e2e.ts).
 */
export async function listTmuxPanes(owner: string = harnessPaneOwner(env.ADAPTER_DATA_DIR)): Promise<TmuxPaneInventory> {
  // Printable delimiters survive tmux's POSIX-locale output sanitiser (see PANE_FORMAT).
  const format = paneFormat((await tmuxFeatures()).paneOptions)
  const read = () => execText('tmux', ['list-panes', '-a', '-F', format], 2_000)
  let result = await read()
  // A server whose socket was removed still runs its panes: asked back, it is read again, once.
  if (!result.ok && isNoTmuxServerError(result.error) && await reviveRemovedTmuxSocket()) result = await read()
  if (result.ok) await rememberTmuxServer()
  if (!result.ok) {
    // A server does not exist until the first Harness agent (or a user) opens
    // a tmux session. Treating this as unavailable made a clean WSL install
    // look broken even though create() can start that server normally.
    if (isNoTmuxServerError(result.error)) return { ok: true, panes: [] }
    return result
  }
  // A running server has a pane at the least (it exits with its last session): a listing with no bytes
  // in it is one that was lost, and read as an answer it says every agent's pane is gone.
  if (!result.stdout) return { ok: false, error: 'tmux listed no panes' }
  return {
    ok: true,
    panes: parsePanes(result.stdout).filter((pane) => ownedHere(pane.owner ?? '', pane.tmuxSessionName, owner)),
  }
}

export interface AdoptedLegacySession { from: string; to: string; paneId: string }

/**
 * Bring the sessions an older build created — `<engine>-<ts>`, from before the `harness-` prefix —
 * under the current convention, so the whitelist above sees them again. Only for panes the registry
 * owns (`ownedPanes`: pane id → the row's engine): a stray session that merely looks legacy is left
 * alone. One rename per session, whichever of its panes is met first.
 *
 * Measured on machine-remote-1: six agents from before the prefix sat dormant for ten days after the
 * whitelist landed — never re-observed, so their process identity was never refreshed and every hook
 * bind that followed was released on the spot ("process changed under tmux pane"). Each was on screen,
 * answering, and had no session to fork.
 */
export async function adoptLegacyHarnessSessions(
  ownedPanes: ReadonlyMap<string, string>,
  now: number = Date.now(),
): Promise<AdoptedLegacySession[]> {
  if (!ownedPanes.size) return []
  const result = await execText('tmux', ['list-panes', '-a', '-F', PANE_FORMAT], 2_000)
  if (!result.ok) return []
  const adopted: AdoptedLegacySession[] = []
  const seen = new Set<string>()
  for (const pane of parsePanes(result.stdout)) {
    const engine = ownedPanes.get(pane.tmuxPane)
    if (!engine || seen.has(pane.tmuxSessionName) || !isLegacyHarnessSession(pane.tmuxSessionName)) continue
    seen.add(pane.tmuxSessionName)
    // `now + n`: two sessions of one engine renamed in the same millisecond would otherwise collide.
    // Counted by session met, not by rename that succeeded, so a failed rename never hands its label
    // to the next one.
    const to = buildHarnessSessionLabel(engine, now + seen.size - 1)
    // `=name` is tmux's exact match; a bare name may also be read as a prefix or a pane target.
    // A session renamed is a notification to every control client: on a tmux before 3.7, not while one
    // attaches (tmuxControlGate.ts).
    const renamed = await inTmuxRoom('notify', () => execText('tmux', ['rename-session', '-t', `=${pane.tmuxSessionName}`, to], 2_000))
    if (renamed.ok) adopted.push({ from: pane.tmuxSessionName, to, paneId: pane.tmuxPane })
  }
  return adopted
}
