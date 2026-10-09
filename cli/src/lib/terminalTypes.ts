import type { AgentEngine } from '../engines/types.js'

export type TerminalBackendName = 'tmux'

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

export type TerminalRuntimeRef = TmuxRuntimeRef

/** Untrusted route hints from hooks. */
export type HookTerminalHint = { backend: 'tmux'; paneId: string }

export interface TerminalRootObservation {
  runtime: TerminalRuntimeRef
  rootPid: number
  cwd: string
  /** Route aliases reported by the backend; never treated as process identity. */
  aliases?: readonly string[]
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
  env?: Record<string, string>
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
   * alternate screen so the receiver routes the wheel to the program. */
  snapshot(options?: { tuiOwnsScrollback?: boolean }): Promise<TerminalReadResult<TerminalStreamSnapshot>>
  /** Release output produced strictly after the snapshot cut. */
  endSnapshot(): void
  writeRaw(bytes: Uint8Array): Promise<TerminalActionResult>
  /** A clipboard paste, delivered as one atomic unit rather than chunked like `writeRaw` — see
   *  `pasteRawIntoTmux` for why a paste needs its own path instead of reusing the keystroke one. */
  pasteRaw(text: string): Promise<TerminalActionResult>
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
