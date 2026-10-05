/**
 * The tmux session-name convention for agent panes this daemon itself creates via `agent_create`
 * (`createAgentPane.ts`).
 *
 * Discovery uses `isHarnessSession` as a whitelist (`TmuxBackend.inventory()`): a tmux pane whose
 * session isn't named this way is invisible to the daemon, whether it's a session the user opened
 * by hand or one an agent spawned itself with a nested `tmux new-session` — neither went through
 * `agent_create`, so neither should ever appear as a discovered agent (issue autonomous-harness-desktop#6).
 *
 * The name says a pane is Harness's, not WHICH daemon's: see `HARNESS_OWNER_OPTION`.
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const HARNESS_SESSION_PREFIX = 'harness-'

/**
 * The tmux window option every pane a daemon creates is tagged with: which daemon on this computer it
 * belongs to. Two daemons can share one tmux server — a dev daemon beside the release one, each with its
 * own data folder — and both name their sessions `harness-…`. Each opened an agent for the other's panes
 * and bound the other's conversations, and an agent stopped in the dev app killed the pane the release
 * daemon was running it in (e2e/twodaemons.e2e.ts, the 2026-10-03 incident). A window option, set in the
 * very tmux call that creates the session, so no scan ever sees the pane untagged: tmux has had window
 * user options far longer than pane ones, and a Harness session is one window with one pane.
 */
export const HARNESS_OWNER_OPTION = '@harness_daemon'

/** A path with its symlinks resolved, including one whose last parts do not exist yet: the same answer
 *  before a data folder is created as after (macOS's `/var` is `/private/var`). */
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  for (let at = absolute; ; at = dirname(at)) {
    try { return join(realpathSync(at), ...missing.reverse()) } catch { /* not there (yet): look one level up */ }
    if (dirname(at) === at) return absolute
    missing.push(basename(at))
  }
}

/** This daemon's tag: its data folder, which no two daemons share, hashed (a path can hold the `|` the
 *  pane listing splits on, and the tag is all a pane needs to carry). */
export function harnessPaneOwner(dataDir: string): string {
  return createHash('sha256').update(canonicalPath(dataDir)).digest('hex').slice(0, 16)
}

/** Whether a pane tagged `owner` is this daemon's (`self`) to see. A pane with no tag was created by a
 *  build from before the tag, and is anyone's, as every pane used to be. */
export function ownedHere(owner: string, self: string): boolean {
  return !owner || owner === self
}

export function buildHarnessSessionLabel(engine: string, now: number = Date.now()): string {
  return `${HARNESS_SESSION_PREFIX}${engine}-${now}`.replace(/[^A-Za-z0-9_-]/g, '-')
}

export function isHarnessSession(sessionName: string): boolean {
  return sessionName.startsWith(HARNESS_SESSION_PREFIX)
}

/** Whether a harness session was created FOR this engine — `harness-<engine>-<ts>` — rather than another. */
export function isHarnessSessionFor(sessionName: string, engine: string): boolean {
  return sessionName.startsWith(`${HARNESS_SESSION_PREFIX}${engine}-`)
}

/**
 * The label a build before the prefix (2026-08-29, `80a354e4`) gave the very same sessions:
 * `<engine>-<ms>`. A pane under one of these came through `agent_create` like any other, yet is
 * invisible to `isHarnessSession` — the daemon renames it on startup (`adoptLegacyHarnessSessions`)
 * rather than teaching discovery a second convention. The 13-digit millisecond stamp is what keeps
 * a user's own `work` or `claude-notes` session from matching.
 */
export function isLegacyHarnessSession(sessionName: string): boolean {
  return !isHarnessSession(sessionName) && /^[a-z][a-z0-9]*-\d{13}$/.test(sessionName)
}
