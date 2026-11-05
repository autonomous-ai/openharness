import type { Author, Conversation, SuperTabState } from './model.js'
import type { ThreadReply } from './pageReads.js'
import { canReadGroup } from './projects.js'

/** What a page says about one thread: the line under its root, and who it marks unread for. */
export interface ThreadSummary {
  id: string
  replies: number
  lastSequence: number
  lastAt: Date
  /** The newest distinct reply authors, up to three. */
  authors: Author[]
  /** People who wrote in the thread or were tagged in it, in order of first appearance. */
  people: string[]
  /** A Buddy's proposal nobody has answered yet: the row's tag in the chat (Dee, 2026-11-04). A task's state is no tag: its
   *  agent reacts 👀 and ✅ on the row instead (taskLine.ts; Dee, 11-04, 'bot messages'). */
  ask?: 'proposal'
}

/** A Buddy's proposal is an ask until the PM has answered it, or a task took it (any task mark, taskLine.ts). */
function askOf(group: Conversation, root: string, thread: ThreadReply[]): ThreadSummary['ask'] {
  if (thread.some(row => row.ask)) return undefined
  const asked = thread.some(row => row.id === root && row.kind === 'buddy-proposal')
  return asked && !thread.some(row => row.id !== root && row.author.kind === 'agent' && row.author.id === group.leadId) ? 'proposal' : undefined
}

/** Summaries of the threads in `rows` (pageThreads, oldest first), roots with no reply left out; a row counts as `count`
 *  replies. Only people who can read the conversation now are named, as an author or among `people`: someone who left keeps
 *  their replies but is no longer listed. */
export function threadSummaries(state: SuperTabState, group: Conversation, rows: ThreadReply[]): ThreadSummary[] {
  const reads = new Map<string, boolean>()
  const readable = (author: Pick<Author, 'kind' | 'id'>) => author.kind !== 'person' || (reads.get(author.id)
    ?? reads.set(author.id, canReadGroup(state, { kind: 'person', userId: author.id, email: '' }, group)).get(author.id)!)
  const threads = new Map<string, ThreadReply[]>()
  for (const row of rows) {
    if (row.agentOnly) continue
    const thread = threads.get(row.thread)
    if (thread) thread.push(row)
    else threads.set(row.thread, [row])
  }
  return [...threads].flatMap(([id, thread]) => {
    const replies = thread.filter(row => row.id !== id)
    const last = replies.at(-1)
    if (!last) return []
    const people = [...new Set(thread.flatMap(row => [...row.author.kind === 'person' ? [row.author.id] : [], ...row.mentions]))]
      .filter(person => readable({ kind: 'person', id: person }))
    const authors = [...new Map(replies.toReversed().map(row => [`${row.author.kind}:${row.author.id}`, row.author])).values()]
      .filter(readable).slice(0, 3)
    const ask = askOf(group, id, thread)
    return [{ id, replies: replies.reduce((sum, row) => sum + (row.count ?? 1), 0), lastSequence: last.sequence, lastAt: last.createdAt, authors, people,
      ...(ask ? { ask } : {}) }]
  })
}
