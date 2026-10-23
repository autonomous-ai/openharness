import type { AgentEngine } from '../engines/types.js'
import type {
  SubmitOptions,
  TerminalActionResult,
  TerminalBackendCapabilities,
  TerminalBackendName,
  TerminalCaptureOptions,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalInventoryResult,
  TerminalLogicalKey,
  TerminalPaneInfo,
  TerminalPaneRead,
  TerminalProcessExpectation,
  TerminalReadResult,
  TerminalRespawnRequest,
  TerminalRuntimeRef,
  TerminalStreamHandle,
  TerminalStreamSink,
  TerminalStreamSize,
  RuntimeValidation,
} from './terminalTypes.js'

/** What `prepare` says: ready, or why not with the error code a create/restore/resume then answers. */
export type TerminalBackendPrepared = { state: 'ready' } | { state: 'unavailable'; reason: string; code: string }

/** Backend-specific terminal I/O. Process ownership and registry reconciliation deliberately live above it. */
export interface TerminalBackend<Ref extends TerminalRuntimeRef = TerminalRuntimeRef> {
  readonly name: TerminalBackendName
  readonly instanceId: string

  /** Ready the backend at daemon start. A failure is a state: the daemon keeps running without it.
   *  [ownedPanes] is the registry's panes (pane id → engine), for a backend that adopts what it finds. */
  prepare(context: { ownedPanes: ReadonlyMap<string, AgentEngine> }): Promise<TerminalBackendPrepared>
  /** What this backend can do for a new pane, asked before a launch that needs it. */
  capabilities(): Promise<TerminalBackendCapabilities>

  create(request: TerminalCreateRequest): Promise<TerminalCreateResult<Ref>>
  /** Recheck the original Stop permission after backend waits, at command dispatch. */
  kill(runtime: Ref, current?: () => boolean): Promise<TerminalActionResult>
  inventory(): Promise<TerminalInventoryResult>
  /** Current user-visible titles keyed by backend-scoped terminal route key. */
  titles(): Promise<TerminalReadResult<Map<string, string>>>
  validate(runtime: Ref, expected: TerminalProcessExpectation): Promise<RuntimeValidation>
  capture(runtime: Ref, options?: TerminalCaptureOptions): Promise<TerminalReadResult<string>>
  typeLiteral(runtime: Ref, text: string): Promise<TerminalActionResult>
  submitText(runtime: Ref, text: string, options?: SubmitOptions): Promise<TerminalActionResult>
  sendKey(runtime: Ref, key: TerminalLogicalKey): Promise<TerminalActionResult>
  /** Raw bytes into the pane, as a stream's input frame writes them, with no stream open: what was typed while
   *  the agent changed host, delivered to the pane it ended on (hostMove/gate.ts). Optional: only the pty host
   *  moves panes. */
  writeInput?(runtime: Ref, bytes: Uint8Array): Promise<TerminalActionResult>
  /** A paste into the pane, as a stream's paste frame makes it (bracketed when the program asked for that),
   *  with no stream open: `writeInput`'s companion for a held paste. */
  pasteInput?(runtime: Ref, text: string): Promise<TerminalActionResult>
  setTitle(runtime: Ref, title: string): Promise<TerminalActionResult>
  notify(runtime: Ref, title: string, body: string): Promise<TerminalActionResult>

  /** Hand a pane back to the backend's default disposal after `create()` kept it when dead. Rechecks
   *  [current] after its own waits, before the command. */
  releaseHold(runtime: Ref, current?: () => boolean): Promise<void>
  /** Pane liveness plus, for a held pane, how its process ended. */
  paneState(runtime: Ref): Promise<TerminalPaneRead>
  /** The pane's foreground command, working directory, pid and tty; null when the pane is unknown. */
  paneInfo(runtime: Ref): Promise<TerminalPaneInfo | null>
  /** The pane's own root process, 'missing' when the backend says the pane does not exist, null when it could not ask. */
  rootProcess(runtime: Ref): Promise<number | 'missing' | null>

  /** Byte streaming is optional per backend. */
  openStream?(
    runtime: Ref,
    expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
    readOnly?: boolean,
  ): Promise<TerminalReadResult<TerminalStreamHandle<Ref>>>

  /** Restart's two primitives, optional per backend: tmux and the pty host swap a pane's process in place. A
   *  backend without them makes restart, retarget and restore report RESTART_UNSUPPORTED_BACKEND (`canRestart`). */
  /** Re-arm a pane's "keep it when the process dies" behavior ahead of killing that process. */
  holdOpen?(runtime: Ref, current?: () => boolean): Promise<TerminalActionResult>
  /** Replace the process occupying an existing pane/session in place, preserving its identity. */
  respawn?(runtime: Ref, request: TerminalRespawnRequest): Promise<TerminalActionResult>
  /** Whether the pane runs the inert held shell under [token] (`nativePaneHold.heldPaneFormat`). Read only: a
   *  respawn with `expectedHeldToken` checks it again where it replaces. 'unknown' when it could not be asked. */
  isHeld?(runtime: Ref, token: string): Promise<boolean | 'unknown'>
  /** Close the pane only while it still runs the held shell under [token]: an adoption cancelled, or rolled back. */
  killHeld?(runtime: Ref, token: string, current: () => boolean): Promise<TerminalActionResult>
  /** Why [respawn] would refuse [request] here (a tmux too old for `-e`), asked before a restart stops anything;
   *  null when it would try. Left out: never refused. */
  respawnRefusal?(request: Pick<TerminalRespawnRequest, 'env'>): Promise<string | null>
  /** Remove [names] from what a respawn in the pane inherits (tmux's session environment). Left out: a respawn
   *  inherits nothing it is not given (the pty host), so there is nothing to clear. */
  clearEnv?(runtime: Ref, names: readonly string[], current?: () => boolean): Promise<TerminalActionResult>
}

/** A backend that swaps a pane's process in place: restart, retarget and restore run on it. */
export type RestartableBackend = TerminalBackend & Required<Pick<TerminalBackend, 'holdOpen' | 'respawn'>>

/** The gate for every restart-shaped path: the two primitives, never the backend's name. */
export function canRestart(backend: TerminalBackend | null | undefined): backend is RestartableBackend {
  return !!backend?.holdOpen && !!backend.respawn
}

/** Where a row restarts: one of its own runtimes, on a backend that can. */
export interface RestartTarget {
  backend: RestartableBackend
  runtime: TerminalRuntimeRef
}

/**
 * The runtime [session] restarts in place, and its backend: its tmux runtime first, as before any other backend
 * could restart, then the rest in row order. Never the bare `tmuxPane`, which is the primary runtime's pane on
 * whatever backend. Undefined when none of its runtimes is on a backend that can restart.
 */
export function restartTargetOf(
  session: { readonly runtimes: readonly TerminalRuntimeRef[] },
  backendFor: (runtime: TerminalRuntimeRef) => TerminalBackend | undefined,
): RestartTarget | undefined {
  for (const runtime of tmuxFirst(session.runtimes)) {
    const backend = backendFor(runtime)
    if (canRestart(backend)) return { backend, runtime }
  }
  return undefined
}

/**
 * Whether [session]'s pane runs the held shell under [token], asked of the backend it is on (`isHeld`): its tmux
 * runtime first, as before, then the rest in row order. False when none is on a backend that can say.
 */
export function heldIn(
  session: { readonly runtimes: readonly TerminalRuntimeRef[] },
  token: string,
  backendFor: (runtime: TerminalRuntimeRef) => TerminalBackend | undefined,
): Promise<boolean | 'unknown'> {
  for (const runtime of tmuxFirst(session.runtimes)) {
    const backend = backendFor(runtime)
    if (backend?.isHeld) return backend.isHeld(runtime, token)
  }
  return Promise.resolve(false)
}

/** Where a row's pane is reached, and the backend that holds it. */
export interface TerminalTarget<B = TerminalBackend> {
  backend: B
  runtime: TerminalRuntimeRef
}

/**
 * The runtime [session]'s pane is asked about and closed through, and its backend: its tmux runtime first, as before
 * any other backend could resume, then the rest in row order. Undefined when none of its runtimes is on a backend this
 * daemon has (`missingBackendCode` names which).
 */
export function terminalTargetOf<B>(
  session: { readonly runtimes: readonly TerminalRuntimeRef[] },
  backendFor: (runtime: TerminalRuntimeRef) => B | undefined,
): TerminalTarget<B> | undefined {
  for (const runtime of tmuxFirst(session.runtimes)) {
    const backend = backendFor(runtime)
    if (backend) return { backend, runtime }
  }
  return undefined
}

/** The code a backend that is not there answers creates, restores and resumes with. */
export const TERMINAL_UNAVAILABLE_CODE: Record<TerminalBackendName, string> = { tmux: 'TMUX_UNAVAILABLE', ptyhost: 'PTY_HOST_UNAVAILABLE' }

/**
 * What a row none of whose runtimes is on a backend here answers (`terminalTargetOf` undefined): the backend it would
 * have been asked of, tmux first. A tmux row keeps the `TMUX_UNAVAILABLE` it always had.
 */
export function missingBackendCode(session: { readonly runtimes: readonly TerminalRuntimeRef[] }): string {
  return TERMINAL_UNAVAILABLE_CODE[tmuxFirst(session.runtimes)[0]?.backend ?? 'tmux']
}

/**
 * What a create, fork or resume answers when no backend could be readied to make its pane on: the code of the backend
 * new panes are made on, the first configured one (main.ts `createBackend`). Tmux keeps the `TMUX_UNAVAILABLE` it
 * always had; a Windows daemon, whose only backend is the pty host, names it (`PTY_HOST_UNAVAILABLE`) rather than a
 * tmux it never had.
 */
export function noBackendCode(configured: readonly TerminalBackendName[]): string {
  return TERMINAL_UNAVAILABLE_CODE[configured[0] ?? 'tmux']
}

/** [runtimes] with their tmux ones first, the rest in row order. */
function tmuxFirst(runtimes: readonly TerminalRuntimeRef[]): TerminalRuntimeRef[] {
  return [...runtimes].sort((a, b) => Number(b.backend === 'tmux') - Number(a.backend === 'tmux'))
}
