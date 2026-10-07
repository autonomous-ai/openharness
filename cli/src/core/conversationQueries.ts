/** The handoff's read-only queries. The core owns these facts; all file rendering and git work stays
 * in the edge host (quiet-machine QA, handoff extraction). No service receives the registry itself. */
import { ENGINES, type AgentEngine } from '../engines/types.js'
import type { HandoffDeps } from '../lib/agentHandoff.js'
import { CONVERSATIONS_OFF, type ConversationReads, type CoreApi } from './api.js'

export function conversationReads(deps: HandoffDeps): ConversationReads {
  return {
    resolve: async (id) => (await deps.resolve(id)) ?? null,
    recentAsks: async (id, n) => deps.recentAsks(id, n),
    lastFullText: async (id) => (await deps.lastFullText(id)) ?? null,
    recaps: async (id, n) => (await deps.recaps?.(id, n)) ?? [],
    discover: async (id) => {
      const session = await deps.resolve(id)
      const found = session && await deps.discoverSession?.(session)
      return found ? { engine: found.engine as AgentEngine, sessionId: found.sessionId, transcriptPath: found.transcriptPath ?? null } : null
    },
    findTranscript: deps.findTranscript ?? CONVERSATIONS_OFF.findTranscript,
    transcriptOk: async (engine, path, home) => (await deps.transcriptOk?.(engine, path, home)) ?? false,
  }
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 20

export async function answerConversationQuery(core: Pick<CoreApi, 'conversations'>, query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reads = core.conversations
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
