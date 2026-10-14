import type {
  SubmitOptions,
  TerminalActionResult,
  TerminalBackendName,
  TerminalCaptureOptions,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalInventoryResult,
  TerminalLogicalKey,
  TerminalProcessExpectation,
  TerminalReadResult,
  TerminalRespawnRequest,
  TerminalRuntimeRef,
  TerminalStreamHandle,
  TerminalStreamSink,
  TerminalStreamSize,
  RuntimeValidation,
  TerminalWrite,
} from './terminalTypes.js'

/** Backend-specific terminal I/O. Process ownership and registry reconciliation deliberately live above it. */
export interface TerminalBackend<Ref extends TerminalRuntimeRef = TerminalRuntimeRef> {
  readonly name: TerminalBackendName
  readonly instanceId: string

  create(request: TerminalCreateRequest): Promise<TerminalCreateResult<Ref>>
  /** Recheck the original Stop permission after backend waits, at command dispatch. */
  kill(runtime: Ref, current?: () => boolean): Promise<TerminalActionResult>
  inventory(): Promise<TerminalInventoryResult>
  /** Current user-visible titles keyed by backend-scoped terminal route key. */
  titles(): Promise<TerminalReadResult<Map<string, string>>>
  validate(runtime: Ref, expected: TerminalProcessExpectation): Promise<RuntimeValidation>
  capture(runtime: Ref, options?: TerminalCaptureOptions): Promise<TerminalReadResult<string>>
  typeLiteral(runtime: Ref, text: string, write?: TerminalWrite): Promise<TerminalActionResult>
  submitText(runtime: Ref, text: string, options?: SubmitOptions): Promise<TerminalActionResult>
  /** Recheck authority at actual dispatch, after any backend queue or wait. */
  sendKey(runtime: Ref, key: TerminalLogicalKey, write?: TerminalWrite): Promise<TerminalActionResult>
  setTitle(runtime: Ref, title: string): Promise<TerminalActionResult>
  notify(runtime: Ref, title: string, body: string): Promise<TerminalActionResult>

  /** Byte streaming is optional per backend. */
  openStream?(
    runtime: Ref,
    expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
    readOnly?: boolean,
  ): Promise<TerminalReadResult<TerminalStreamHandle<Ref>>>

  /** Restart's two primitives. Optional per backend — only tmux (a real multiplexer pane) supports an
   *  in-place process swap; a backend without them makes restart report RESTART_UNSUPPORTED_BACKEND. */
  /** Re-arm a pane's "keep it when the process dies" behavior ahead of killing that process. */
  holdOpen?(runtime: Ref): Promise<TerminalActionResult>
  /** Replace the process occupying an existing pane/session in place, preserving its identity. */
  respawn?(runtime: Ref, request: TerminalRespawnRequest): Promise<TerminalActionResult>
}
