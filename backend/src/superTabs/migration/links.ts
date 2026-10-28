import type { Prisma } from '@prisma/client'
import { appendPullRequestUrls, type SuperTabState } from '../model.js'

/** Groups from before link lists have none. The migration rebuilds theirs once from the work's stored history: every
 *  attempt's check evidence and result (moved from store.ts, where every read did it: reads never write once Swarms are in
 *  parts, design R8). A message only mentioning a pull request never links it (#558). */
export async function restorePullRequestUrls(tx: Prisma.TransactionClient, tabId: string, state: SuperTabState): Promise<void> {
  const missing = state.conversations.filter(group => group.pullRequestUrls === undefined)
  if (!missing.length) return
  const conversationIds = missing.map(group => group.id)
  const attempts = await tx.superTabAttempt.findMany({ where: { tabId, conversationId: { in: conversationIds } },
    select: { conversationId: true, snapshot: true }, orderBy: { createdAt: 'asc' } })
  for (const group of missing) {
    const prior = attempts.filter(attempt => attempt.conversationId === group.id)
      .map(attempt => attempt.snapshot as unknown as { checks?: Array<{ evidence?: string | null }>; assignment?: { result?: string | null } })
    appendPullRequestUrls(group, [
      ...prior.flatMap(attempt => [...(attempt.checks ?? []).map(check => check.evidence), attempt.assignment?.result]),
      ...group.checks.map(check => check.evidence), group.assignment?.result,
    ])
  }
}
