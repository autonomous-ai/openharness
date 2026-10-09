/**
 * An engine's own control connection to the server that runs its conversations (Codex's shared app-server),
 * run in the engine's worker. Core decides everything it can from what it holds and the engine's declared
 * contract (facets/launch.ts `SharedServerContract`): the process table, the session's identity and store,
 * whether a client owns its conversation, whether the server runs, whether an unbound chat was never used.
 * The engine speaks its protocol, and only for a conversation core has established is on the server.
 */

/** A conversation core established is on the engine's server: its store, and its id ('' when none was bound). */
export interface NativeConversation {
  home: string
  sessionId: string
}

export type NativeActivity = 'working' | 'idle' | 'unknown'

/** What core lets one stop ask and tell. Every answer is core's; a no revokes the stop. */
export interface NativeStopHost {
  /** Still the same session, and still wanted. */
  current(): Promise<boolean>
  /** About to take a step that must be undone if the stop is cut off before its undo (Codex's archive): core
   *  notes it, to undo it through the next worker if this one is lost. Also asks `current`. */
  pending(): Promise<boolean>
  /** That step is undone or never happened: nothing is left to repair. */
  settled(): Promise<boolean>
}

export interface EngineNativeControl {
  /** What the engine's server says the conversation is doing; unknown whenever it cannot say. */
  activity(conversation: NativeConversation): Promise<NativeActivity>
  /** Unload the conversation from the server before its client is signalled. Throws, with the person's
   *  message, when the client must not be signalled: the work may still be running. */
  stop(conversation: NativeConversation, host: NativeStopHost): Promise<void>
  /** Undo what a stop cut off after `pending` may have left (Codex: return the archived thread's history). */
  recover(conversation: NativeConversation): Promise<void>
  /** Close every connection this control holds. */
  close(): void
}
