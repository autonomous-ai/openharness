/**
 * A pane joining a Swarm gets one 1:1 chat with its person, whoever asks, from whichever of their computers, however often
 * (PSW-B review, 2026-11-11): Desktop's Attach asked for a chat under a new random request each time (new_agent.dart), so a
 * retry after a lost answer, an app restart or the person's other computer made a second chat that stayed empty for good.
 * The chat of a session is now named by the session itself (`agent.new` with `harnessId`), and the empty chats already made
 * are archived by the time checks.
 */
import { stableId, type SuperTabState } from './model.js'
import { isAgentChat, projectsOf } from './projects.js'

/** How long an agent's chat may stay empty, with no agent and no message, before the time checks archive it: a join takes
 *  seconds, a server start minutes (p95 4 min, task #4196). */
export const EMPTY_CHAT_MS = 60 * 60_000

/** The 1:1 chat of [person]'s session [harnessId] on [machineId], at their membership: the same on every computer of theirs. */
export const paneChatId = (person: { id: string; generation: string }, machineId: string, harnessId: string): string =>
  stableId('agent-chat', person.id, person.generation, 'pane', machineId, harnessId)

/** Archives the agents' chats of [state] that hold no agent and never had a message for EMPTY_CHAT_MS since they opened or were
 *  opened again, as an archive by hand does (it leaves the active set): not one a PM or a start is coming to. The number archived.
 *  It clears what Desktops before Attach sent `harnessId` made: it goes, with its call in store.ts runTimeChecks, on or after
 *  2026-12-12, 30 days after the Desktop that sends it (due 2026-11-12). */
export function archiveEmptyChats(state: SuperTabState, now: number): number {
  const awaited = new Set([...projectsOf(state).flatMap(p => p.pmChat ? [p.pmChat.id] : []),
    ...(state.starts ?? []).filter(s => !s.harnessId && !s.error).map(s => s.request.conversationId)])
  let archived = 0
  for (const chat of state.conversations) {
    if (!isAgentChat(chat) || chat.archived || chat.dormant || chat.agentIds.length || chat.lastMessageSequence || awaited.has(chat.id)) continue
    if (!(now - Date.parse(chat.lastActivityAt ?? '') >= EMPTY_CHAT_MS)) continue
    chat.archived = true
    chat.dormant = true
    archived++
  }
  return archived
}
