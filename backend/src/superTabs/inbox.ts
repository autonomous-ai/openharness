/**
 * The PM's inbox (task #3403, anh Dee's Swarm redesign, 11-05): its digest starts with what it owes people (pulse.ts owed
 * asks), oldest first, each with who asked, how long ago and where, so it answers each once, in its place (answers.ts). A
 * person is named by username, never by email.
 */
import type { SuperTabState } from './model.js'
import type { SwarmProject } from './projects.js'
import { swarmUsernames } from './usernames.js'

/** The asks one inbox names; the board lists them all. */
export const OWED_LINES_MAX = 10
const MINUTE = 60_000

/** [project]'s owed asks as the inbox's first lines: a header, then one line each, oldest first. None when nothing is owed. */
export function owedLines(state: SuperTabState, project: SwarmProject, now: number): string[] {
  const asks = state.conversations.filter(c => !c.archived && c.owed && (c.projectId ?? 'lead') === project.id)
    .flatMap(c => c.owed!.map(ask => ({ ...ask, conversationId: c.id }))).sort((a, b) => a.at - b.at)
  if (!asks.length) return []
  const names = swarmUsernames(state)
  const ago = (at: number) => `${Math.max(0, Math.round((now - at) / MINUTE))}m`
  return [`Owed asks (${asks.length}, oldest ${ago(asks[0]!.at)}). Answer each once, in its place: harness super-tab answer GROUP MESSAGE_ID TEXT OPERATION_ID.`,
    ...asks.slice(0, OWED_LINES_MAX).map(a => `- from ${names.get(a.personId) ?? 'a person'}, ${ago(a.at)} ago (message ${a.id} in ${a.conversationId})`),
    ...asks.length > OWED_LINES_MAX ? [`And ${asks.length - OWED_LINES_MAX} more owed: the board lists them all.`] : []]
}
