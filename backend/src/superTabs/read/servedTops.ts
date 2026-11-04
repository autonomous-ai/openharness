/**
 * The newest main row of each project chat as people are served it (#2742). A chat's stored `lastMainSequence` is set when
 * a row is numbered (parts/commit.ts numberMessages). A `machine-left` line stored before #2742 was numbered for people and
 * is now read by nobody (model.ts NOTICE_READERS), so a chat whose newest main row is one would stay unread: Desktop and the
 * phone count a chat unread while that number is past the reader's mark, and send no read at or below the mark the server
 * holds (Grebe2639's review of #2950). Readers are served instead the newest main row of that chat people read, as the
 * inbox's latest preview finds it (inbox.ts latestIn): in a first load's whole groups, and in the changed groups a poll sends
 * whole from the change feed. A poll's other groups are light (parts/light.ts) and carry no such number.
 *
 * Only project chats are looked at: those lines were written there alone. Which row is the newest people read depends only on
 * the stored rows at or below that number, never on the reader (a project chat is no Buddy chat), and stored rows do not
 * change, so each answer is kept by (Swarm, chat, number) for as long as this server runs, up to KEPT answers; a restarted
 * server looks each chat up once again. A chat whose number moved is looked up once more: a row people read moves it there,
 * so that lookup reads the one row at the number by the (tabId, conversationId, sequence) index and answers the number.
 */
import type { PrismaClient } from '@prisma/client'
import type { Conversation, SuperTabState } from '../model.js'
import { projectsOf } from '../projects.js'
import { latestIn } from './inbox.js'

/** Answers kept; the one kept longest goes first. */
export const KEPT = 20_000

export class ServedTops {
  private readonly kept = new Map<string, number>()

  constructor(private readonly db: PrismaClient, private readonly limit = KEPT) {}

  /** `groups` as readers are served them: each project chat of `state` with the newest main row people read as its
   *  `lastMainSequence`. A first load sends whole groups (its view's); a change read sends the changed ones whole from the
   *  change feed, so a project chat re-sent for a reply in a thread or a reaction is served the same number. */
  async served<G extends { key: string; data?: unknown }>(tabId: string, state: SuperTabState, groups: G[]): Promise<G[]> {
    const chats = new Set(projectsOf(state).map(p => p.leadConversationId))
    const topOf = (g: G) => {
      const data = g.data as Partial<Conversation> | undefined
      return chats.has(g.key) && typeof data?.lastMainSequence === 'number' ? data.lastMainSequence : null
    }
    const asked = groups.filter(g => topOf(g) !== null)
    if (!asked.length) return groups
    const key = (id: string, top: number) => `${tabId}\u0000${id}\u0000${top}`
    const missing = asked.filter(g => !this.kept.has(key(g.key, topOf(g)!)))
    if (missing.length) {
      const chatsAsked = missing.map(g => ({ id: g.key, lastMainSequence: topOf(g)!, lastMessageSequence: (g.data as Conversation).lastMessageSequence }) as Conversation)
      const { latest } = await latestIn(this.db, tabId, state, chatsAsked)
      for (const g of missing) {
        // None read within the rows looked at, or none at all: the stored number stands, as before.
        const top = topOf(g)!, found = latest.get(g.key)?.sequence
        this.keep(key(g.key, top), found !== undefined && found < top ? found : top)
      }
    }
    return groups.map(g => {
      const top = topOf(g)
      const served = top === null ? null : this.kept.get(key(g.key, top)) ?? top
      return served === null || served === top ? g : { ...g, data: { ...(g.data as object), lastMainSequence: served } }
    })
  }

  private keep(key: string, top: number) {
    this.kept.delete(key)
    this.kept.set(key, top)
    while (this.kept.size > this.limit) this.kept.delete(this.kept.keys().next().value!)
  }
}
