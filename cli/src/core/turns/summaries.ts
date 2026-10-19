import { summaryOf } from '../../lib/activitySummary.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { ActivityState } from '../../lib/turnActivity.js'

/**
 * What each of these agents is doing, in one line, for the shared tab's sidebar (shared-tab activity design, ruling T2):
 * the prompt it is running while it works, else the latest recap line, else that prompt. An agent that is not live is
 * left out, and so is one nothing is known about. A recap is read only for an agent that is not working.
 */
export async function summariesOf(
  agentIds: string[],
  deps: {
    live: (agentId: string) => RegisteredSession | undefined
    state: (session: RegisteredSession) => ActivityState | undefined
    /** The prompt of the agent's last turn start, working or not (kept by the funnel). */
    running: (agentId: string) => string | undefined
    /** The one-line recap of its last turn. */
    recap: (agentId: string) => Promise<string | undefined>
  },
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const agentId of agentIds) {
    const session = deps.live(agentId)
    if (!session) continue
    const state = deps.state(session) ?? 'unknown'
    // A recap that cannot be read (the mirror is off, a cloud agent's service is down) is no recap: the prompt stands in.
    const recap = state === 'working' ? undefined : await deps.recap(agentId).catch(() => undefined)
    const summary = summaryOf(state, deps.running(agentId), recap)
    if (!summary) continue
    out[agentId] = summary
  }
  return out
}

/** The core's `agents.summaries`: the agents' kept prompts and the latest recap line of each, read through `summariesOf`.
 *  Built here so that main.ts only hands it what it holds. */
export function summaryReader(deps: {
  live: (agentId: string) => RegisteredSession | undefined
  state: (session: RegisteredSession) => ActivityState | undefined
  prompts: ReadonlyMap<string, string>
  /** The agent's last turns, newest first: a mirror's recaps, or a cloud agent's. */
  recent: (agentId: string) => Array<{ recap?: string }> | Promise<Array<{ recap?: string }>>
}): (agentIds: string[]) => Promise<Record<string, string>> {
  return (agentIds) => summariesOf(agentIds, {
    live: deps.live,
    state: deps.state,
    running: (agentId) => deps.prompts.get(agentId),
    recap: async (agentId) => (await deps.recent(agentId))[0]?.recap,
  })
}
