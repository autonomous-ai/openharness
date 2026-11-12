/**
 * A conversation moved between a grid and the own login: the engine forks it, starting with instructions that fit its new
 * provider (engines/codex/providerMove.ts). The engine's worker runs it; core decides when and resumes the fork (#4145).
 */

/** What core asks: the session, the destination, and the launch it is about to relaunch with. */
export interface ProviderMoveAsk {
  sessionId: string
  toGrid: boolean
  /** The launch's own arguments: its `-c` pairs select the provider, its `-m` the model. */
  args: string[]
  /** The engine's executable, as the launch runs it. */
  command: string
  env: Record<string, string>
  cwd?: string
}

/** The fork's id, ready to resume, or why the engine refused the move. */
export type ProviderMoved = { threadId: string } | { refused: string }

export type MoveProvider = (ask: ProviderMoveAsk) => Promise<ProviderMoved>

/** Core's move, as a retarget calls it: the fork's id, or a thrown Error with the engine's reason. */
export type MoveConversation = (engine: string, ask: Omit<ProviderMoveAsk, 'env'> & { env: NodeJS.ProcessEnv }) => Promise<string>
