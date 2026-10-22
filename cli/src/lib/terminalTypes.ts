import type { AgentEngine } from '../engines/types.js'

export type TerminalBackendName = 'tmux' | 'ptyhost'

/** PID reuse-safe identity for the process that owns a Harness agent. */
export interface ProcessIdentity {
  pid: number
  executable: string
  startMarker: string
  /**
   * Linux only: when the process started, in clock ticks since boot (`/proc/<pid>/stat` field 22).
   * `startMarker` is `ps lstart`, which Linux derives from the boot time, and the boot time moves
   * every time the wall clock is stepped: a Docker Desktop VM resynced after the Mac slept shifted
   * every process's lstart by hours, and each agent got a new id for the same process (6 panes, 5
   * times in 15 hours, machine-remote-1, 2026-10-07). The ticks never change for a process.
   */
  startTicks?: number
}

export interface TmuxRuntimeRef {
  backend: 'tmux'
  paneId: string
}

export interface PtyRuntimeRef {
  backend: 'ptyhost'
  paneId: string
  /** host instance, e.g. "p3" (protocol 3) */
  instance: string
}

export type TerminalRuntimeRef = TmuxRuntimeRef | PtyRuntimeRef

/** Untrusted route hints from hooks. */
export type HookTerminalHint = { backend: 'tmux'; paneId: string } | { backend: 'ptyhost'; paneId: string; instance: string }

export interface TerminalRootObservation {
  runtime: TerminalRuntimeRef
  rootPid: number
  cwd: string
  /** Route aliases reported by the backend; never treated as process identity. */
  aliases?: readonly string[]
  /** The label the pane was created with, where the backend keeps one (the pty host): a move's new pane is told by
   *  it (hostMove/moveAgent.ts `removeOrphanMovePanes`). */
  label?: string
}

export type TerminalInventoryResult =
  | { state: 'available'; roots: readonly TerminalRootObservation[] }
  | { state: 'unavailable'; reason: string }
  | { state: 'incompatible'; reason: string }

export type RuntimeValidation =
  | { state: 'alive' }
  /** `replaced`: the pane runs this engine, but not the process the row recorded. An engine restarted,
   *  retargeted or resumed in place reads this way until its new identity is recorded. */
  | { state: 'gone'; reason: string; replaced?: true }
  | { state: 'unknown'; reason: string }

/** What a backend knows about a pane right now. */
export interface TerminalPaneState {
  dead: boolean
  /** Exit status once the process is gone; null while it is still running. */
  exitStatus: number | null
  /** Foreground command name, as tmux #{pane_current_command}. */
  command: string
  /** Engine exit status recorded by the launch wrapper; null before. */
  engineExit: number | null
}

/** A pane's state, `'gone'` when the backend says it has no such pane, `'unknown'` when it could not be asked. */
export type TerminalPaneRead = TerminalPaneState | 'gone' | 'unknown'

/** What a pane is running and where (terminal clients' #{pane_current_*}). */
export interface TerminalPaneInfo { command: string; path: string; pid: number | null; tty: string }

export interface TerminalBackendCapabilities {
  /** Per-session environment for new panes (tmux >= TMUX_SESSION_ENV_MIN; always on ptyhost). */
  sessionEnv: boolean
}

/**
 * Result of a PTY side effect. Only `not_started` and a server-confirmed `rejected` result may be
 * retried on another runtime. `possibly_executed` must be observed before any further side effect.
 */
export type TerminalActionResult =
  | { state: 'succeeded'; dispatch: 'executed' }
  | { state: 'failed'; dispatch: 'not_started' | 'rejected'; reason: string }
  | { state: 'unknown'; dispatch: 'possibly_executed'; reason: string }

/** Optional core authority, checked after backend waits immediately before a command is sent. */
export interface TerminalDispatchControl {
  current?: () => boolean
  onDispatch?: () => void
  /** A held adoption may replace only its exact inert shell, checked inside tmux. */
  expectedHeldToken?: string
}

/**
 * What a pane runs once its command exits by itself, in the same pane, with that exit recorded as the pane's
 * `engineExit`: the hand-off a Unix launch script makes itself (lib/engineLaunch.ts `harness_after`), given to the
 * pty host for a Windows engine, which has no script (lib/windows/engineStart.ts). tmux never gets one.
 */
export interface TerminalAfterExit {
  command: string[]
  /** Its own variables, beside the pane's; the host adds `HARNESS_ENGINE_EXIT`, the status. */
  env?: Record<string, string>
}

export interface TerminalCreateRequest extends TerminalDispatchControl {
  cwd?: string
  label?: string
  /** argv (binary first) to run instead of the backend's default shell, e.g. an engine CLI launch. */
  command?: string[]
  /**
   * Extra environment for the created terminal, layered over whatever it would otherwise inherit.
   *
   * Deliberately not part of `command`: these values are credentials (a grid relay key, see
   * `gridLaunch.ts`), and argv is world-readable through `ps` for as long as the process lives.
   */
  env?: Record<string, string>
  /** What the pane runs when `command` exits by itself (`TerminalAfterExit`); the pty host's alone. */
  afterExit?: TerminalAfterExit
  /** Scrollback the new pane starts with (hostMove/seed.ts); the pty host's alone, and only one that lists the `seed`
   *  feature: the tmux backend ignores it. */
  seed?: string
  /** Names this process, and its `afterExit` shell, do not get from the backend's own environment (a grid launch's
   *  provider keys, on Windows: lib/windows/engineStart.ts); the pty host's alone, whose panes inherit the host's
   *  environment. Per launch: the next respawn sends its own. */
  clearInherited?: readonly string[]
}

/**
 * Re-exec an EXISTING terminal's process, keeping the terminal itself.
 *
 * The pane, its id and its scrollback survive, which is the whole point: moving a running agent to a
 * grid must not look to the user like the agent was replaced. Only the process is replaced, because
 * its environment is the thing being changed and a process's environment cannot be edited in place.
 */
export interface TerminalRespawnRequest extends TerminalDispatchControl {
  cwd?: string
  command: string[]
  /** This child's own variables, on top of what the pane was created with (tmux's session environment, the pty
   *  host's stored create env), which a respawn inherits. */
  env?: Record<string, string>
  /** Names taken out of what the pane was created with, for this child and every later one. The pty host does it
   *  in the respawn; a backend with `clearEnv()` (tmux) is cleared through that instead, before the respawn. */
  clearEnv?: readonly string[]
  /** `TerminalCreateRequest.clearInherited`, for the new process alone, in place of the last launch's: never the same
   *  list as `clearEnv`, which takes names out of what the pane was created with. */
  clearInherited?: readonly string[]
  /** The new process's hand-off (`TerminalAfterExit`), replacing any the pane had; the pty host's alone. */
  afterExit?: TerminalAfterExit
}

export type TerminalCreateResult<Ref extends TerminalRuntimeRef = TerminalRuntimeRef> =
  | { state: 'succeeded'; dispatch: 'executed'; runtime: Ref }
  | { state: 'failed'; dispatch: 'not_started' | 'rejected'; reason: string }
  | { state: 'unknown'; dispatch: 'possibly_executed'; reason: string }

export type TerminalReadResult<T> =
  | { state: 'succeeded'; value: T }
  | { state: 'failed'; reason: string }

export type TerminalLogicalKey =
  | 'enter'
  | 'escape'
  | 'tab'
  | 'backtab'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'backspace'
  | 'delete'
  | 'pageup'
  | 'pagedown'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-u'
  | 'ctrl-w'
  | 'space'
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'

export type TerminalCaptureMode = 'recent_unwrapped' | 'visible' | 'detection'

export interface TerminalCaptureOptions {
  mode?: TerminalCaptureMode
  historyLines?: number
  ansi?: boolean
}

export interface TerminalProcessExpectation {
  engine: AgentEngine
  processIdentity?: ProcessIdentity
}

export interface TerminalStreamSize {
  cols: number
  rows: number
}

export interface TerminalStreamSnapshot {
  bytes: Uint8Array
  cols: number
  rows: number
}

export interface TerminalStreamSink {
  onData: (bytes: Uint8Array) => void
  onClose: (reason: string) => void
}

/** A live byte-oriented terminal stream. Implementations must preserve input/output order. */
export interface TerminalStreamHandle<Ref extends TerminalRuntimeRef = TerminalRuntimeRef> {
  readonly runtime: Ref
  /** Gate live output before taking an ordered snapshot. */
  beginSnapshot(): void
  /** Capture only the authoritative visible viewport. Terminal scrollback can
   * contain prior full-screen TUI repaint frames and must never be replayed as
   * part of a keyframe.
   *
   * `tuiOwnsScrollback` is for a full-screen TUI that paints in tmux's *normal*
   * buffer (Grok). Its tmux history is prior repaint frames, not a shell
   * transcript, and must not be seeded; the snapshot is labelled as the
   * alternate screen so the receiver routes the wheel to the program.
   *
   * `conversationHistory` is for an engine that keeps its conversation in the
   * scrollback (facets/launch.ts `ScreenContract`): the seeded history is all
   * tmux keeps rather than its last screens, within the keyframe's size, and it
   * is re-wrapped by word for the pane's width (historyRewrap.ts), the visible
   * grid never.
   *
   * `repaint` is how the engine answers a resize by printing its screen again
   * (facets/launch.ts `ScreenContract.resizeRepaint`): a snapshot taken right
   * after the pane was resized waits for that print, so it holds what follows
   * the clear rather than what preceded it; `cleared`, when the clear has come
   * already, as live output, so only the print's end is waited for. A print
   * that began before the capture's cut and had not ended there, whenever it
   * began, has the snapshot taken again once it ends. */
  snapshot(options?: {
    tuiOwnsScrollback?: boolean
    conversationHistory?: boolean
    repaint?: { clears: string; ends: string; withinMs: number; cleared?: boolean }
  }): Promise<TerminalReadResult<TerminalStreamSnapshot>>
  /** Release output produced strictly after the snapshot cut. The sink may
   * begin the next snapshot from it: what is left is then held behind that one. */
  endSnapshot(): void
  writeRaw(bytes: Uint8Array): Promise<TerminalActionResult>
  /** A clipboard paste, delivered as one atomic unit rather than chunked like `writeRaw` — see
   *  `pasteRawIntoTmux` for why a paste needs its own path instead of reusing the keystroke one.
   *  `allowed` is asked again just before the paste lands: a paste takes two tmux processes, and the
   *  stream it was sent on may be closed or taken over meanwhile. */
  pasteRaw(text: string, allowed?: () => boolean): Promise<TerminalActionResult>
  resize(size: TerminalStreamSize): Promise<TerminalActionResult>
  /** Scroll a full-screen TUI that owns mouse-tracking but mishandles SGR wheel
   *  reports (confirmed live for Grok: it echoes the raw escape bytes into its
   *  own prompt). The tmux backend sends PageUp/PageDown into the pty — Grok
   *  scrolls its conversation with those keys even while the prompt is focused.
   *  Do not use tmux copy-mode: alt-screen history is prior TUI repaint frames.
   *  Backends with no such concept (anything not tmux-backed) may no-op. */
  scroll(direction: 'up' | 'down', lines: number): Promise<TerminalActionResult>
  pauseOutput(): Promise<TerminalActionResult>
  resumeOutput(): Promise<TerminalActionResult>
  close(): Promise<void>
}

/** The largest keyframe sent: a larger one closes its stream (terminalStreamManager.ts). A snapshot that can
 *  build its keyframe more than one way keeps under it itself (tmuxStream.ts, the re-wrapped history). */
export const KEYFRAME_MAX_BYTES = 480 * 1024

export const TERMINAL_ACTION_SUCCEEDED: TerminalActionResult = {
  state: 'succeeded',
  dispatch: 'executed',
}

/** The reason a write is refused when the pane's control lease cannot be taken: the agent's process is
 *  not the one the registry holds (just relaunched, not yet confirmed) or another writer holds it. */
export const TERMINAL_LEASE_REFUSED = 'terminal control lease is unavailable or changed'

export function terminalActionNotStarted(reason: string): {
  state: 'failed'; dispatch: 'not_started'; reason: string
} {
  return { state: 'failed', dispatch: 'not_started', reason }
}

export function terminalActionRejected(reason: string): {
  state: 'failed'; dispatch: 'rejected'; reason: string
} {
  return { state: 'failed', dispatch: 'rejected', reason }
}

/**
 * What a submit checks right before its Enter, the text already typed: a reason not to press it. The
 * engine can open a dialog between a paste and its Enter (a long or multi-line one waits up to 1.5 s for
 * the engine to take it in, tmux.ts), and that Enter would answer the dialog.
 */
export interface SubmitOptions {
  beforeEnter?: () => Promise<string | null>
  /** Synchronous authority fence, checked immediately before paste/Enter dispatch, including queues. */
  allowed?: () => boolean
}

/** The text was typed and its Enter not pressed, for `reason`: it waits in the composer, unsent. */
export function terminalEnterWithheld(reason: string): { state: 'unknown'; dispatch: 'possibly_executed'; reason: string } {
  return { state: 'unknown', dispatch: 'possibly_executed', reason: `enter_withheld:${reason}` }
}

/** Why a submit's Enter was not pressed, or null when it was, or the submit did not get that far. */
export function enterWithheldReason(result: boolean | TerminalActionResult): string | null {
  return typeof result !== 'boolean' && result.state === 'unknown' && result.reason.startsWith('enter_withheld:')
    ? result.reason.slice('enter_withheld:'.length) : null
}

export function terminalActionPossiblyExecuted(reason: string): {
  state: 'unknown'; dispatch: 'possibly_executed'; reason: string
} {
  return { state: 'unknown', dispatch: 'possibly_executed', reason }
}
