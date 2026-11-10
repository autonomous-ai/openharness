/** What Buddy thread sessions (docs/superpowers/specs/2026-10-30-buddy-thread-sessions-design.md) left in Buddy chats, read by
 *  these rules until every Buddy is an ordinary agent (buddyConversion.ts, which ends the sessions): a session reads only its
 *  thread and the main chat up to where it started, the main Buddy none of its thread, and nobody a lost project's rows. Nothing
 *  starts a session now (2026-11-10). */
import { isBuddy, isBuddyChat, isSwarmBuddyChat } from './buddies.js'
import { canReadProject, isAgentChat, projectsOf } from './projects.js'
import type { Agent, Conversation, SuperTabState } from './model.js'

/** The main-chat excerpt a session starts from: the last CONTEXT_MESSAGES before it started, each cut to CONTEXT_CHARS, at
 *  most CONTEXT_BYTES in all. */
export const CONTEXT_MESSAGES = 10
export const CONTEXT_CHARS = 500
export const CONTEXT_BYTES = 6 * 1024
/** The quiet line a session's end left in its thread. */
export const SESSION_ENDED_KIND = 'buddy-session-ended'

/** The chat's main Buddy: the Buddy in it that is not a thread session. */
export function mainBuddyOf(state: SuperTabState, chat: Conversation): Agent | undefined {
  return state.agents.find(a => chat.agentIds.includes(a.id) && isBuddy(a) && !a.buddySession)
}
/** The person whose Buddy chat [chat] is, at the membership it was opened in. */
const chatOwner = (chat: Conversation): { id: string; generation: string } | undefined => chat.audience?.people[0]

/** A message row as the session read check needs it: its author and source too, for a person's one Buddy chat. */
export interface SessionRow { id: string; thread?: string | null; buddySession?: boolean | null; author?: unknown; source?: unknown; buddyProject?: string | null }

/**
 * Whether a Buddy [reader] reads [row] of its own Buddy chat (spec: Security, "No session reads another's thread"). A thread
 * session reads its own thread alone (its root and replies); the main Buddy reads every row but a session thread's replies.
 * Anyone else, and any other conversation, reads as before. The one predicate every agent read of a Buddy chat applies.
 *
 * In a person's one Buddy chat (Dee, 10-31; spec: Guard and Access), with [state]: a project session reads in its thread only
 * its person's own words, its own and the line that ends it, never a main-Buddy row it was started from; and nobody, the person
 * included, reads a row of a project they no longer read (its PM's lines, its sessions' threads).
 */
export function sessionReadsRow(reader: Pick<Agent, 'id' | 'buddyOf' | 'buddySession'> | undefined, group: Pick<Conversation, 'kind' | 'audience'>,
  state?: SuperTabState): (row: SessionRow) => boolean {
  // A converted one (buddyConversion.ts) keeps hiding them: its rows are as they were.
  const lost = state && (isSwarmBuddyChat(group) || isAgentChat(group)) ? lostProjectRow(state, group) : () => false
  if (!reader?.buddyOf || !isBuddyChat(group)) return row => !lost(row)
  const own = reader.buddySession
  if (own?.projectId) {
    const owner = chatOwner(group as Conversation)
    return row => (row.id === own.thread || row.thread === own.thread) && !lost(row) && (ownWords(row, owner?.id, reader.id)
      || (row.source as { kind?: unknown } | null | undefined)?.kind === SESSION_ENDED_KIND
      || earlierSessionOf(row, own.projectId!))
  }
  if (own) return row => (row.id === own.thread || row.thread === own.thread) && !lost(row)
  return row => !row.buddySession && !lost(row)
}

/** Whether [row] was written by the chat's person [personId] or by the session [selfId] itself. */
function ownWords(row: SessionRow, personId: string | undefined, selfId: string): boolean {
  const author = row.author as { kind?: unknown; id?: unknown } | null | undefined
  return !!author && ((author.kind === 'person' && author.id === personId) || (author.kind === 'agent' && author.id === selfId))
}

/** Whether [row] is an agent's row of a session of [projectId] in this thread, so one reopened there has its history (Scholes,
 *  11-02). The server sets the mark on the row: a main Buddy's rows and another project's session's never carry it. */
function earlierSessionOf(row: SessionRow, projectId: string): boolean {
  return (row.author as { kind?: unknown } | null | undefined)?.kind === 'agent' && row.buddySession === true && row.buddyProject === projectId
}

/** In a person's one Buddy chat, the rows of a project its person no longer reads, or that is gone: each row of a project
 *  session's thread and each PM's private line carries its project (MessageDraft.buddyProject), and an older PM line its
 *  source's. On the row itself, so hiding has no limit (security review 2 of #2435). */
export function lostProjectRow(state: SuperTabState, group: Pick<Conversation, 'audience'>): (row: SessionRow) => boolean {
  const owner = group.audience?.people[0]
  const member = owner && state.people.find(p => p.id === owner.id && p.generation === owner.generation)
  const reads = new Map<string, boolean>()
  const readable = (projectId: string) => {
    if (!reads.has(projectId)) {
      const project = projectsOf(state).find(p => p.id === projectId)
      reads.set(projectId, !!member && !!project && canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project))
    }
    return reads.get(projectId)!
  }
  return row => {
    const marked = row.buddyProject ?? (row.source as { projectId?: unknown } | null | undefined)?.projectId
    return typeof marked === 'string' && !readable(marked)
  }
}

/** A main-chat row as the excerpt reads it. */
export interface ContextRow { id: string; sequence: number; text: string; author: { kind: string; name?: string; displayName?: string }; createdAt: Date }

/**
 * The main-chat excerpt a session starts from: [rows] (main-stream rows of its chat at or before its `from`, newest first,
 * as read), the newest CONTEXT_MESSAGES, oldest first, each cut to CONTEXT_CHARS, dropping the oldest until CONTEXT_BYTES fit.
 */
export function sessionContext(rows: readonly ContextRow[]): Array<{ id: string; sequence: number; author: string; text: string; createdAt: Date }> {
  const picked = rows.slice(0, CONTEXT_MESSAGES).map(row => ({ id: row.id, sequence: row.sequence, createdAt: row.createdAt,
    author: row.author.displayName ?? row.author.name ?? row.author.kind,
    text: [...row.text].length > CONTEXT_CHARS ? `${[...row.text].slice(0, CONTEXT_CHARS).join('')}…` : row.text })).reverse()
  const size = (list: typeof picked) => Buffer.byteLength(JSON.stringify(list.map(r => [r.author, r.text])))
  while (picked.length && size(picked) > CONTEXT_BYTES) picked.shift()
  return picked
}
