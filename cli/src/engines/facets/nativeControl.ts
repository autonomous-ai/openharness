/**
 * An engine's own control connection to the server that runs its conversations (Codex's shared app-server),
 * run in the engine's worker. Core identifies the conversation and keeps every decision about the session:
 * whether a stop is still wanted, which processes are running, whether a chat was never used, and the
 * SIGTERM that follows. The engine speaks its protocol and reports what its server says.
 */

/** A conversation core identified: the engine's store for it, its id ('' when none was bound), and the
 *  argv of the engine process core matched to the session by its identity (null when none runs). */
export interface NativeConversation {
  home: string
  sessionId: string
  owner: string[] | null
}

export type NativeActivity = 'working' | 'idle' | 'unknown'

/** What core lets one stop ask. Every answer is core's; a false `current` revokes the stop. */
export interface NativeStopHost {
  /** Still the same session, and still wanted. */
  current(): Promise<boolean>
  /** A process with this pid and start time is running, as core reads the process table. */
  running(pid: number, startedAt: string): Promise<boolean>
  /** Fresh proof that an unbound chat never started and its composer is empty (a Close supplies it). */
  unused(): Promise<boolean>
}

export interface EngineNativeControl {
  /** What the engine's server says the conversation is doing; unknown whenever it cannot say. */
  activity(conversation: NativeConversation): Promise<NativeActivity>
  /** Unload the conversation from the engine's server before its client is signalled. Throws, with the
   *  person's message, when it must not be signalled: the work may still be running. */
  stop(conversation: NativeConversation, host: NativeStopHost): Promise<void>
  /** Close every connection this control holds. */
  close(): void
}
