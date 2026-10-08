/**
 * An engine whose CLI can leave work on a server of its own, shared per store (Codex's app-server). Declared
 * data: core decides from it, with no worker, whether a client's conversation lives on that server at all,
 * and the server's protocol is the engine worker's (facets/nativeControl.ts). Copied from the former
 * lib/codexSessionLifecycle.ts, which read these facts in core before the move.
 */
export interface SharedServerContract {
  /** Harness puts this first among the options of a client that owns its conversation in its own process. */
  ownedFlag: string
  /** A client given this option (or `<flag>=…`) works on a remote server, which no local stop reaches. */
  remoteFlag: string
  /** The script's basenames when an interpreter (node) runs the CLI: its options start after the script. */
  scripts: readonly string[]
  /** Where, in the store, the server records its process, as JSON `{ pid, processStartTime }`. */
  pidFile: string
  /** What the person is told when the stop cannot go on, in the engine's own words. */
  messages: { unverified: string; remote: string; unidentified: string }
}

/** Literal argv contracts copied from the existing launch paths. No engine version behavior changes. */
export interface EngineLaunch {
  permissionModes: Readonly<Record<string, readonly string[]>>
  bypassPermission: string[]
  firstPromptArgs: readonly string[]
  resumeArgs: string[]
  forkArgs: { lead: string[]; after?: string[] }
  instructionFiles: readonly string[]
  contextArgs?: (contextFile: string) => string[]
  envArgs?: (env: Record<string, string>) => string[]
  sharedServer?: SharedServerContract
}
