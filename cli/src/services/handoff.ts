/** Change agent's history, redaction and git work live outside the core. Its facts come only through
 * CoreApi, including stopped parents and the core's verified session discovery. */
import { performance } from 'node:perf_hooks'
import { HANDOFF_REQUESTS, type CoreApi, type CorePorts, type ServiceRequests } from '../core/api.js'
import { prepareAgentHandoff, type HandoffDeps } from '../lib/agentHandoff.js'
import { createHandoffRequest } from './handoffRequest.js'

export { HANDOFF_REQUESTS }

export function startHandoff(core: CoreApi, _ports?: CorePorts, prepare = prepareAgentHandoff): ServiceRequests {
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
  }
  return { agent_handoff_prepare: (payload, asker, closed) => {
    const expires = performance.now() + 5_000
    const permit = { requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
      current: (request: { agentId: string; changeId: string; targetEngine: string }) => asker.owner && !closed?.aborted
        && performance.now() <= expires && request.agentId === payload.agentId && request.changeId === payload.changeId && request.targetEngine === payload.targetEngine }
    const answer = createHandoffRequest({ prepare: (request) => prepare({ ...deps, permit,
      publish: (prepared, _permit) => reads.publish(prepared, permit) }, request) })
    return new Promise(reply => answer(payload, asker, reply))
  } }
}
