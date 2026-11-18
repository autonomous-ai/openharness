/**
 * The agent cleanup in its own process, as the core sees it (services/agentCleanupProcess.ts; in the edge host by
 * default).
 *
 * Stops and accepted person input are shared AgentLife observations (core/agentLife.ts).
 * Joined protection belongs to the cleanup process; core retains no per-agent feature history.
 *
 * One thing the core asks and waits for, for a bounded time: that what a harness being deleted was told is erased
 * (`forgetTold`). The agent ledger is the process's to read and lock, never the core's, and a delete whose erase is
 * not answered is refused.
 *
 * The process asks the core what only the core knows: the live agents (`live`), when one's conversation last moved
 * (`lastActivity`), and to close one (`closeStarted`), which the core does for a harness another agent started and
 * refuses for any other (core/api.ts `closeStarted`). Whatever the process asks, it closes nothing else.
 */
import { answerAgentQuery } from './agentQueries.js'
import type { AgentCleanupPort, CoreApi } from './api.js'

type Payload = Record<string, unknown>

/** How long a delete waits for the cleanup to erase what a harness was told: its wait for the ledger's lock is a
 *  quarter of a second (services/agentCleanup.ts `FORGET_LOCK_WAIT_MS`), the rewrite of two files of 2 MiB at most
 *  comes after, and the edge host may be busy with another service's work. */
export const FORGET_TOLD_MS = 10_000

/** [call]: ask the cleanup's process for an answer (core/serviceLinks.ts `call`, for `agentCleanup`): never rejects. */
export function createAgentCleanupLink(core: Pick<CoreApi, 'agents' | 'usage' | 'count' | 'clients'>,
  call: (type: string, payload: Payload, waitMs: number) => Promise<Payload>) {
  const port: AgentCleanupPort = {
    // Anything but its word that it erased them (the process down or slow, the ledger's lock held, a file it could
    // not write) is not erased, and the delete is refused.
    forgetTold: async (agentId) => (await call('forgetTold', { agentId }, FORGET_TOLD_MS)).ok === true,
    stop: () => {},
  }

  const answer = async (query: string, payload: Payload): Promise<Payload> => {
    if (query !== 'closeStarted' && query !== 'lastActivity') return answerAgentQuery(core, query, payload)
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    if (!agentId) return { error: 'INVALID_REQUEST' }
    if (query === 'lastActivity') return { at: await (core.agents.lastActivity?.(agentId) ?? null) }
    const mode = payload.mode === 'idle' || payload.mode === 'now' ? payload.mode : null
    if (!mode) return { error: 'INVALID_REQUEST' }
    // Past the ceiling only when the process says so in those words: anything else keeps the refusal.
    const closing = payload.pastCeiling === true ? core.agents.closeStarted?.(agentId, mode, true) : core.agents.closeStarted?.(agentId, mode)
    return { ...await (closing ?? { error: 'UNSUPPORTED' }) }
  }

  return { port, answer }
}
