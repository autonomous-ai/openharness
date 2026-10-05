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
 * The tmux pane option every pane a daemon creates is tagged with: which daemon on this computer it
 * belongs to. Set in the very tmux call that creates the session, so no scan ever sees the pane untagged.
 *
 * Two daemons can share one tmux server — a dev daemon beside the release one, each with its own data
 * folder — and both name their sessions `harness-…`. Each opened an agent for the other's panes and bound
 * the other's conversations, and an agent stopped in the dev app killed the pane the release daemon was
 * running it in (e2e/twodaemons.e2e.ts, the 2026-10-03 incident).
 *
 * And a pane moves. The person renames its session or joins it into a window of their own (hn's people
 * live in tmux), and a session name stops saying whose it is; a pane option goes with the pane, where a
 * window option stays behind with the window (e2e/tmuxmoves.e2e.ts). Read through the window too, which
 * is how a format resolves a pane option nobody set: a tag a build set on the window still counts.
 *
 * tmux before 3.0 has no pane options, and a `set-option -p` chained into `new-session` failed the whole
 * command list there, so every agent create failed (PR #789's review). There the tag is a window option,
 * and the pane's start command carries it too (`ownerCommand`).
 */
export const HARNESS_OWNER_OPTION = '@harness_daemon'

/**
 * Before tmux 3.0 there are no pane options: the tag can only be a window option, and a window option
 * stays behind with its window when the person moves the pane. What does go with a pane there is the
 * command it was started with, `#{pane_start_command}`. So on such a tmux a daemon starts each pane
 * through `/usr/bin/env HARNESS_DAEMON=<tag>` (`ownerCommand`), which execs the real command at once —
 * the pane's process is the shell, as before — and leaves the tag where tmux keeps it for the pane's
 * life, through any join, break or rename (e2e/tmuxmoves.e2e.ts, run on tmux 2.8).
 */
export const OWNER_COMMAND_ENV = 'HARNESS_DAEMON'
const OWNER_COMMAND_PREFIX = `/usr/bin/env ${OWNER_COMMAND_ENV}=`
/** How long a tag is (`harnessPaneOwner`). */
const OWNER_TAG_LENGTH = 16

/** [command], started so that tmux keeps [owner]'s tag in the pane's start command (see above). */
export function ownerCommand(owner: string, command: readonly string[]): string[] {
  return ['/usr/bin/env', `${OWNER_COMMAND_ENV}=${owner}`, ...command]
}

/**
 * The tmux format for a pane's owner tag, for a pane listing. With pane options (3.0), the option: a
 * format resolves it through the window too. Before 3.0, the tag the pane's start command carries,
 * then the window's. tmux 2.x cannot cut a substring out of a format, so the start command comes back
 * cut to the prefix and a tag's length, and `paneOwnerOf` takes the tag out — never the whole command,
 * which can be long and hold the `|` and newlines a listing is split on.
 */
export function paneOwnerFormat(paneOptions: boolean): string {
  if (paneOptions) return `#{${HARNESS_OWNER_OPTION}}`
  const width = OWNER_COMMAND_PREFIX.length + OWNER_TAG_LENGTH
  // The window's tag only in a session Harness named. Everywhere else it named a pane the person split
  // into an agent's window, or joined into one they had moved into their own session: taken for the
  // agent's, it was restyled, given mouse mode, and counted among Harness's terminals.
  return `#{?#{m:${OWNER_COMMAND_PREFIX}*,#{pane_start_command}},#{=${width}:pane_start_command},`
    + `#{?#{m:${HARNESS_SESSION_PREFIX}*,#{session_name}},#{${HARNESS_OWNER_OPTION}},}}`
}

/** The tag out of a `paneOwnerFormat` field: the field itself, unless it is a start command's prefix. */
export function paneOwnerOf(field: string): string {
  if (!field.startsWith(OWNER_COMMAND_PREFIX)) return field
  return field.slice(OWNER_COMMAND_PREFIX.length).split(' ')[0]
}

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
  return createHash('sha256').update(canonicalPath(dataDir)).digest('hex').slice(0, OWNER_TAG_LENGTH)
}

/**
 * Whether a pane is this daemon's (`self`): one it tagged, in any session, wherever the person moved it;
 * one nobody tagged only in a session Harness named, as before the tag (a build from before it made the
 * pane, and a session the person opened by hand is never taken for an agent: autonomous-harness-desktop#6);
 * one another daemon tagged, never. Never the pane id alone: a new tmux server reuses `%N`, and a stale id
 * can name someone's shell.
 */
export function ownedHere(owner: string, sessionName: string, self: string): boolean {
  return owner ? owner === self : isHarnessSession(sessionName)
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
