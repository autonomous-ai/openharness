/**
 * The newest main row of each project chat as people are served it (#2742). A chat's stored `lastMainSequence` is set when
 * a row is numbered (parts/commit.ts numberMessages). A `machine-left` line stored before #2742 was numbered for people and
 * is now read by nobody (model.ts NOTICE_READERS), so a chat whose newest main row is one would stay unread: Desktop and the
 * phone count a chat unread while that number is past the reader's mark, and send no read at or below the mark the server
 * holds (Grebe2639's review of #2950). Readers are served instead the newest main row of that chat people read, as the
 * inbox's latest preview finds it (inbox.ts latestIn).
 *
 * Only project chats are looked at: those lines were written there alone. Which row is the newest people read depends only on
 * the stored rows at or below that number, never on the reader (a project chat is no Buddy chat), and stored rows do not
 * change, so each answer is kept by (Swarm, chat, number) for as long as this server runs, up to KEPT answers. A chat whose
 * number moved is looked up once more: a row people read moves it there, so the answer is the number itself.
 */
import type { PrismaClient } from '@prisma/client'
import type { Conversation } from '../model.js'
import { projectsOf } from '../projects.js'
import type { ReaderView } from './views.js'
import { latestIn } from './inbox.js'

/** Answers kept; the one kept longest goes first. */
export const KEPT = 20_000

export class ServedTops {
  private readonly kept = new Map<string, number>()

  constructor(private readonly db: PrismaClient, private readonly limit = KEPT) {}

  /** Serves each project chat of `view` with the newest main row people read as its `lastMainSequence`. */
  async apply(tabId: string, view: ReaderView): Promise<void> {
    const chats = new Set(projectsOf(view.state).map(p => p.leadConversationId))
    const groups = view.parts.groups.filter(g => chats.has(g.key) && typeof g.data.lastMainSequence === 'number')
    if (!groups.length) return
    const key = (id: string, top: number) => `${tabId}\u0000${id}\u0000${top}`
    const missing = groups.filter(g => !this.kept.has(key(g.key, g.data.lastMainSequence!)))
    if (missing.length) {
      const asked = missing.map(g => ({ id: g.key, lastMainSequence: g.data.lastMainSequence, lastMessageSequence: g.data.lastMessageSequence }) as Conversation)
      const { latest } = await latestIn(this.db, tabId, view.state, asked)
      for (const g of missing) {
        // None read within the rows looked at, or none at all: the stored number stands, as before.
        const top = g.data.lastMainSequence!, found = latest.get(g.key)?.sequence
        this.keep(key(g.key, top), found !== undefined && found < top ? found : top)
      }
    }
    view.parts.groups = view.parts.groups.map(g => {
      const top = g.data.lastMainSequence
      if (!chats.has(g.key) || typeof top !== 'number') return g
      const served = this.kept.get(key(g.key, top)) ?? top
      return served === top ? g : { ...g, data: { ...g.data, lastMainSequence: served } }
    })
  }

  private keep(key: string, top: number) {
    this.kept.delete(key)
    this.kept.set(key, top)
    while (this.kept.size > this.limit) this.kept.delete(this.kept.keys().next().value!)
  }
}
