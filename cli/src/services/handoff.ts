/** Change agent's history, redaction and git work live outside the core. Its facts come only through
 * CoreApi, including stopped parents and the core's verified session discovery. */
import { performance } from 'node:perf_hooks'
import { HANDOFF_REQUESTS, type CoreApi, type CorePorts, type ServiceRequests } from '../core/api.js'
import { prepareAgentHandoff, type HandoffDeps } from '../lib/agentHandoff.js'
import { HANDOFF_DEADLINE_MS } from '../lib/handoffAuthority.js'
import { createHandoffRequest } from './handoffRequest.js'

export { HANDOFF_REQUESTS }

/** `limits`: longer ones for a test on a loaded machine (testing/handoffLimits.ts); as shipped, HANDOFF_DEADLINE_MS and
 *  lib/agentHandoff.ts's git and discovery limits. */
export function startHandoff(core: CoreApi, _ports?: CorePorts, prepare = prepareAgentHandoff,
  limits: Pick<HandoffDeps, 'deadlineMs' | 'gitTimeoutMs' | 'discoverMs'> = {}): ServiceRequests {
  const reads = core.conversations
  const deps: HandoffDeps = {
    resolve: (id) => reads.resolve(id),
    readHistory: (session) => core.transcripts.databaseHistory(session),
    recentAsks: (id, n) => reads.recentAsks(id, n),
    lastFullText: async (id) => (await reads.lastFullText(id)) ?? undefined,
    recaps: (id, n) => reads.recaps(id, n),
    discoverSession: (session) => reads.discover(session.agentId),
    findTranscript: (engine, id, options) => reads.findTranscript(engine, id, options),
    transcriptOk: (engine, path, home) => reads.transcriptOk(engine, path, home),
    ...limits,
  }
  return { agent_handoff_prepare: (payload, asker, closed) => {
    const expires = performance.now() + (limits.deadlineMs ?? HANDOFF_DEADLINE_MS)
    const permit = { requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
      current: (request: { agentId: string; changeId: string; targetEngine: string }) => asker.owner && !closed?.aborted
        && performance.now() <= expires && request.agentId === payload.agentId && request.changeId === payload.changeId && request.targetEngine === payload.targetEngine }
    const answer = createHandoffRequest({ prepare: (request) => prepare({ ...deps, permit,
      publish: (prepared, _permit) => reads.publish(prepared, permit) }, request) })
    return new Promise(reply => answer(payload, asker, reply))
  }, agent_handoff_complete: async (_payload, asker, closed) => {
    // Desktop's Change agent says the new session runs. Nothing is kept of it since the Swarm, which recorded the replacement
    // for its host, was deleted (2026-11-14); answered as before, so a Desktop that asks reads it as done. Remove the request
    // on or after 2026-12-14, once no Desktop from before then is in use.
    if (!asker.owner) return { error: 'OWNER_REQUIRED' }
    return closed?.aborted ? { error: 'HANDOFF_UNAVAILABLE' } : { ok: true }
  } }
}
