/**
 * Unblocked's facts (docs/swarms.md, Leaderboard): every answer a person gave, and every wait an answer ended, from needs-human
 * answers in the group ledgers and from answered decisions (v2 C). One ask is credited once: a needs-human that asked a
 * decision shares its "Needs a human" row's id with the decision's batch, and the decision wins. A point per answered
 * question, the asker's wait once per ask (Lead's ruling, 2026-10-27). An answer saved before that link was recorded is the
 * same item when its wait began exactly when a decision in that group was asked: both take the asking command's time.
 */
import type { Conversation } from '../model.js'

/** An answered decision as the board reads it (decisions.ts): who answered, where and when, never the question. */
export interface AnsweredDecision { batchId: string; conversationId: string; personId: string; createdAt: number; answeredAt: number }
/** A wait a decision answered: its batch, which a needs-human that asked it shares as its row's id. */
export interface ResolvedWait { batchId: string; conversationId: string }
export interface Answer { personId: string; at: number }
export interface Wait { personId: string; at: number; waitedMs: number }

/** The answers and waits of [shared] groups, only those the reader may read. */
export function unblockedFacts(shared: Conversation[], decisions: AnsweredDecision[]): { answers: Answer[]; waits: Wait[]; decided: Set<string> } {
  const readable = new Set(shared.map(g => g.id))
  const kept = decisions.filter(d => readable.has(d.conversationId))
  const decided = new Set(kept.map(d => d.batchId))
  const asks = new Map<string, AnsweredDecision[]>()
  for (const d of kept) asks.set(d.batchId, [...asks.get(d.batchId) ?? [], d])
  const askedAt = new Set([...asks.values()].map(q => `${q[0]!.conversationId}\n${Math.min(...q.map(d => d.createdAt))}`))
  const ledger = shared.flatMap(g => (g.ledger?.unblocks ?? []).filter(u => u.waitId ? !decided.has(u.waitId) : !askedAt.has(`${g.id}\n${u.at - u.waitedMs}`)))
  const askWaits = [...asks.values()].map(questions => {
    const last = questions.reduce((a, b) => b.answeredAt > a.answeredAt ? b : a)
    return { personId: last.personId, at: last.answeredAt, waitedMs: Math.max(0, last.answeredAt - Math.min(...questions.map(q => q.createdAt))) }
  })
  return {
    answers: [...ledger.map(u => ({ personId: u.personId, at: u.at })), ...kept.map(d => ({ personId: d.personId, at: d.answeredAt }))],
    waits: [...ledger, ...askWaits],
    decided,
  }
}
