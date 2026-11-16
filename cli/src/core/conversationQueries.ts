import { HandoffError, type PreparedHandoff } from '../lib/handoffAuthority.js'
import type { ServiceQueryAuthority } from './serviceLinks.js'
/** The handoff's read-only queries. The core owns these facts; all file rendering and git work stays
 * in the edge host (quiet-machine QA, handoff extraction). No service receives the registry itself. */
import { ENGINES, type AgentEngine } from '../engines/types.js'
import type { HandoffDeps } from '../lib/agentHandoff.js'
import type { HandoffWiring } from '../lib/handoffDiscovery.js'
import { CONVERSATIONS_OFF, type ConversationReads, type CoreApi } from './api.js'

/** The optional deadline is the existing publication fixture budget; production keeps its default. */
export function conversationReads(wiring: HandoffWiring, directory: string, deadlineMs?: number): ConversationReads {
  let dependencies: Promise<HandoffDeps> | undefined
  // Discovery and publication must share witnesses across requests (#1145), including concurrent first use.
  const load = () => dependencies ??= import('./handoffDependencies.js')
    .then(({ createHandoffDependencies }) => createHandoffDependencies(wiring, directory, deadlineMs))
    .catch(() => {
      dependencies = undefined
      console.error('[handoff] initialization failed: HANDOFF_UNAVAILABLE')
      throw new HandoffError('HANDOFF_UNAVAILABLE')
    })
  return {
    publish: async (prepared, permit) => {
      const deps = await load()
      if (!deps.publish) throw new HandoffError('HANDOFF_UNAVAILABLE')
      return deps.publish(prepared, permit)
    },
    resolve: async (id) => (await (await load()).resolve(id)) ?? null,
    recentAsks: async (id, n) => (await load()).recentAsks(id, n),
    lastFullText: async (id) => (await (await load()).lastFullText(id)) ?? null,
    recaps: async (id, n) => (await (await load()).recaps?.(id, n)) ?? [],
    discover: async (id) => {
      const deps = await load()
      const session = await deps.resolve(id)
      const found = session && await deps.discoverSession?.(session)
      return found ? { engine: found.engine as AgentEngine, sessionId: found.sessionId, transcriptPath: found.transcriptPath ?? null } : null
    },
    findTranscript: async (engine, id, options) => ((await load()).findTranscript ?? CONVERSATIONS_OFF.findTranscript)(engine, id, options),
    transcriptOk: async (engine, path, home) => (await (await load()).transcriptOk?.(engine, path, home)) ?? false,
  }
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 20

export async function answerConversationQuery(core: Pick<CoreApi, 'conversations'>, query: string, payload: Record<string, unknown>, authority?: ServiceQueryAuthority): Promise<Record<string, unknown>> {
  const reads = core.conversations
  if (query === 'publish') {
    const prepared = payload.prepared as PreparedHandoff
    const requestId = payload.originRequestId
    if (!prepared || !text(requestId) || !authority) return { error: 'HANDOFF_UNAVAILABLE', held: true, retryable: true }
    try {
      return { value: await reads.publish(prepared, { requestId,
        current: request => authority.ownsRequest(requestId, 'agent_handoff_prepare', { ...request }) }) }
    } catch (error) {
      return { error: error instanceof HandoffError ? error.code : 'HANDOFF_UNAVAILABLE', held: true, retryable: true }
    }
  }
  const id = payload.id
  if (query === 'resolve' || query === 'discover' || query === 'lastFullText') {
    if (!text(id)) return { error: 'BAD_QUERY' }
    return { value: await reads[query](id) }
  }
  if (query === 'recentAsks' || query === 'recaps') {
    if (!text(id) || !count(payload.n)) return { error: 'BAD_QUERY' }
    return { value: await reads[query](id, payload.n) }
  }
  if (query === 'findTranscript' || query === 'transcriptOk') {
    if (!text(payload.engine) || !(ENGINES as readonly string[]).includes(payload.engine)
      || (payload.codexHome !== undefined && payload.codexHome !== null && !text(payload.codexHome))) return { error: 'BAD_QUERY' }
    const engine = payload.engine as AgentEngine
    if (query === 'findTranscript') {
      if (!text(id)) return { error: 'BAD_QUERY' }
      return { value: await reads.findTranscript(engine, id, { codexHome: typeof payload.codexHome === 'string' ? payload.codexHome : undefined }) }
    }
    if (!text(payload.path)) return { error: 'BAD_QUERY' }
    return { value: await reads.transcriptOk(engine, payload.path, typeof payload.codexHome === 'string' ? payload.codexHome : null) }
  }
  return { error: 'UNKNOWN_QUERY' }
}
