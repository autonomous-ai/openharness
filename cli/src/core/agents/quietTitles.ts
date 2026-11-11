/**
 * A title an engine gives its conversation from a line typed for the agent alone never names the agent.
 *
 * Claude Code and Codex title a conversation from its prompts: Claude Code's terminal title from the first and from a later one it
 * reads as a new topic, Codex's thread name from the first. A quiet delivery (core/api.ts `DeliveryOptions.quiet`: the browser's
 * ready and stopped lines) is for the agent only, never shown to its person (decision 15,
 * docs/superpowers/specs/2026-11-11-browser-from-chat-design.md). By hand, 2026-11-11: typed before the person's first message, the
 * ready line was the conversation's first prompt, and the agents were called "Harness browser setup" and "Run harness browser --help".
 *
 * An agent is in a quiet stretch from the start of a turn a quiet delivery started (core/deliveries.ts `quietStarted`) to the start
 * of its next turn (core/turns/funnel.ts), or to its end (core/main.ts `agentEnded`). A title first read in it is the quiet line's: never taken, then or later
 * (lib/registry.ts `updateTitle`, `quietTitle`). The title sync reads every 5 s, and an engine titles a prompt seconds after it, so
 * each edge waits for one more read: a title that came before the edge is judged by the stretch it came in. None is from the
 * turn that moved the edge: an engine titles a prompt with a model call, which takes longer than the read.
 */

/** The most stretches kept: one is left by its agent's next turn or its end, and an end no path tells would keep it for good. */
export const QUIET_STRETCHES_KEPT = 1_000

export interface QuietTitlesDeps {
  /** Read every agent's engine title now, each judged by `quiet` (the title sync, core/main.ts). */
  read: () => Promise<void>
  log: (line: string) => void
}

export function createQuietTitles(deps: QuietTitlesDeps) {
  /** The agents whose last turn a quiet delivery started, as their turns say, the latest last. */
  const said = new Set<string>()
  /** The same as the title sync judges titles: an agent joins or leaves it once a read made after its edge is done. */
  const quiet = new Set<string>()
  /** Read the titles, then move [agentId]'s edge to what its turns say then; never inside the turn's start that called it. */
  const settle = (agentId: string): void => {
    void Promise.resolve().then(deps.read)
      .catch((error: unknown) => { deps.log(`[terminal-title] read at a quiet edge failed · ${error instanceof Error ? error.message : String(error)}`) })
      .then(() => { if (said.has(agentId)) quiet.add(agentId); else quiet.delete(agentId) })
  }
  /** [agentId]'s stretch ends, if it is in one. */
  const end = (agentId: string): void => { if (said.delete(agentId)) settle(agentId) }
  return {
    /** A turn a quiet delivery started is open in [agentId]. */
    started(agentId: string): void {
      said.delete(agentId)
      said.add(agentId)
      if (said.size > QUIET_STRETCHES_KEPT) {
        const oldest = said.values().next().value!
        said.delete(oldest)
        quiet.delete(oldest)
      }
      settle(agentId)
    },
    /** A live turn started in [agentId]: a stretch there ends with it. Told before the input can say a quiet delivery started it. */
    turnStarted: end,
    /** [agentId] stopped running here: resumed, its engine shows its conversation's titles again before any turn, and one it
     *  had before the quiet line is its own. */
    ended: end,
    /** Whether a title [agentId]'s engine shows now came from a line typed for it alone. */
    quiet: (agentId: string): boolean => quiet.has(agentId),
  }
}

export type QuietTitles = ReturnType<typeof createQuietTitles>
