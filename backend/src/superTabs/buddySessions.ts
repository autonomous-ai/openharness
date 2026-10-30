/** Buddy thread sessions (docs/superpowers/specs/2026-10-30-buddy-thread-sessions-design.md; Scholes, 10-30): by the person's
 *  choice, a thread in their Buddy chat gets its own Buddy session, a second Buddy agent on the same machine, so a long
 *  question there never holds a quick one in the main chat. A session hears and answers only its thread, reads the main chat
 *  only up to where it started (a short excerpt), and ends when its person ends it, when it has been idle for 30 minutes
 *  (its host says so), or with its main Buddy. The main Buddy reads none of its thread. */
import { isBuddy, isBuddyChat } from './buddies.js'
import { fail, stableId, type Agent, type AgentStart, type Author, type BuddySessionEntry, type Conversation, type MessageDraft, type SuperTabState } from './model.js'

/** At most this many live or starting sessions per Buddy chat, the main Buddy not counted. */
export const MAX_BUDDY_SESSIONS = 3
/** At most this many of the person's messages wait for a session that is still starting. */
export const MAX_SESSION_WAITING = 20
/** What a machine's host reports (`capabilities`) when it can run thread sessions. */
export const BUDDY_SESSION_CAPABILITY = 'buddySessions'
/** The main-chat excerpt a session starts from: the last CONTEXT_MESSAGES before it started, each cut to CONTEXT_CHARS, at
 *  most CONTEXT_BYTES in all. */
export const CONTEXT_MESSAGES = 10
export const CONTEXT_CHARS = 500
export const CONTEXT_BYTES = 6 * 1024
/** The quiet line a session's end leaves in its thread. */
export const SESSION_ENDED_KIND = 'buddy-session-ended'
export type SessionEndReason = 'ended' | 'idle' | 'stopped' | 'failed' | 'removed' | 'maintenance'

export const isThreadSession = (agent: Pick<Agent, 'buddySession'> | undefined): boolean => !!agent?.buddySession
/** The chat's main Buddy: the Buddy in it that is not a thread session. */
export function mainBuddyOf(state: SuperTabState, chat: Conversation): Agent | undefined {
  return state.agents.find(a => chat.agentIds.includes(a.id) && isBuddy(a) && !a.buddySession)
}
/** The thread sessions running in [chat]. */
export const sessionAgentsOf = (state: SuperTabState, chat: Conversation): Agent[] =>
  state.agents.filter(a => chat.agentIds.includes(a.id) && isBuddy(a) && !!a.buddySession)

/**
 * [chat]'s live and starting sessions, its record pruned of any that ended without saying (its agent gone, its start failed
 * or gone): a removal path that missed the record never holds a slot. Changes [chat] only when something is pruned.
 */
export function liveSessions(state: SuperTabState, chat: Conversation): BuddySessionEntry[] {
  const entries = chat.buddySessions ?? []
  const live = entries.filter(entry => entry.agentId
    ? state.agents.some(a => a.id === entry.agentId && chat.agentIds.includes(a.id))
    : state.starts?.some(s => s.id === entry.startId && !s.error && !s.harnessId) === true)
  if (live.length !== entries.length) setSessions(chat, live)
  return live
}
export function setSessions(chat: Conversation, entries: BuddySessionEntry[]): void {
  if (entries.length) chat.buddySessions = entries
  else delete chat.buddySessions
}

/** The live or starting session of [thread] in [chat]. */
export const sessionOf = (state: SuperTabState, chat: Conversation, thread: string | null | undefined): BuddySessionEntry | undefined =>
  thread ? liveSessions(state, chat).find(e => e.thread === thread) : undefined

/** The person whose Buddy chat [chat] is, at the membership it was opened in. */
export const chatOwner = (chat: Conversation): { id: string; generation: string } | undefined => chat.audience?.people[0]

/** Refuses anyone but [chat]'s own person, at their current membership, with words that never say whose chat it is. */
export function requireChatOwner(state: SuperTabState, chat: Conversation, userId: string): { id: string; generation: string } {
  const owner = chatOwner(chat)
  const me = state.people.find(p => p.id === userId)
  if (!isBuddyChat(chat) || !owner || !me || owner.id !== me.id || owner.generation !== me.generation) {
    fail('BUDDY_SESSION_CHAT', 'Start or end a session in a thread of your own Buddy chat.', 403)
  }
  return owner
}

/** The words a session's end leaves in its thread, for its person. */
export function endedText(reason: SessionEndReason, detail?: string): string {
  switch (reason) {
    case 'ended': return 'Session ended: you ended it.'
    case 'idle': return 'Session ended: idle for 30 minutes.'
    case 'stopped': return 'Session ended: it stopped unexpectedly.'
    case 'failed': return `Session ended: it couldn't start${detail ? `: ${detail.slice(0, 300)}` : '.'}`
    case 'removed': return 'Session ended: its Buddy was removed or replaced.'
    case 'maintenance': return 'Session ended: Harness was updated. Start a new session to continue.'
  }
}

/**
 * The one way a session's end is recorded, for every path (commands, the start timeouts in liveness.ts): its entry leaves
 * [chat]'s record and a quiet line in its thread says why, to nobody (a reply to the thread's root, tagged as the session's,
 * so the main Buddy never reads it). Said by the session's agent when it ran, else by the chat's person. Closing the agent
 * itself is the caller's: only a command can (commands.ts removeAgent). Nothing when the entry is already gone.
 */
export function endSessionEntry(state: SuperTabState, chat: Conversation, entry: BuddySessionEntry, reason: SessionEndReason, detail?: string): MessageDraft[] {
  if (!(chat.buddySessions ?? []).some(e => e.startId === entry.startId)) return []
  setSessions(chat, (chat.buddySessions ?? []).filter(e => e.startId !== entry.startId))
  const agent = entry.agentId ? state.agents.find(a => a.id === entry.agentId) : undefined
  const owner = chatOwner(chat), person = owner && state.people.find(p => p.id === owner.id && p.generation === owner.generation)
  const author: Author | undefined = agent ? { kind: 'agent', id: agent.id, name: agent.name, displayName: agent.displayName ?? agent.name,
    membershipGeneration: agent.membershipGeneration } : person ? { kind: 'person', id: person.id, name: person.email, membershipGeneration: person.generation } : undefined
  if (!author) return []
  return [{ id: stableId(SESSION_ENDED_KIND, chat.id, entry.startId), conversationId: chat.id, author, text: endedText(reason, detail),
    replyTo: entry.thread, recipients: [], thread: entry.thread, buddySession: true, source: { kind: SESSION_ENDED_KIND, reason, thread: entry.thread } }]
}

/** A thread session's start that failed outside a command (liveness.ts timeouts): ended through its own path, never as its
 *  main Buddy's start, so the main chat says nothing and the thread says why. */
export function failedSessionStart(state: SuperTabState, start: AgentStart): MessageDraft[] {
  const chat = start.request.buddySession && state.conversations.find(c => c.id === start.request.conversationId)
  const entry = chat ? (chat.buddySessions ?? []).find(e => e.startId === start.id) : undefined
  return chat && entry ? endSessionEntry(state, chat, entry, 'failed', start.error ?? undefined) : []
}

/** A message row as the session read check needs it. */
export interface SessionRow { id: string; thread?: string | null; buddySession?: boolean | null }

/**
 * Whether a Buddy [reader] reads [row] of its own Buddy chat (spec: Security, "No session reads another's thread"). A thread
 * session reads its own thread alone (its root and replies); the main Buddy reads every row but a session thread's replies.
 * Anyone else, and any other conversation, reads as before. The one predicate every agent read of a Buddy chat applies.
 */
export function sessionReadsRow(reader: Pick<Agent, 'buddyOf' | 'buddySession'> | undefined, group: Pick<Conversation, 'kind'>): (row: SessionRow) => boolean {
  if (!reader?.buddyOf || !isBuddyChat(group)) return () => true
  const own = reader.buddySession
  if (own) return row => row.id === own.thread || row.thread === own.thread
  return row => !row.buddySession
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
