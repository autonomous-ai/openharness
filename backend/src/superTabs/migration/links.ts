import type { Prisma } from '@prisma/client'
import { appendPullRequestUrls, type SuperTabState } from '../model.js'
import { groupRepositoryUrl } from '../projects.js'

/** Groups from before link lists have none. The migration rebuilds theirs once from complete stored history (moved from
 *  store.ts, where every read did it: reads never write once Swarms are in parts, design R8). */
export async function restorePullRequestUrls(tx: Prisma.TransactionClient, tabId: string, state: SuperTabState): Promise<void> {
  const missing = state.conversations.filter(group => group.pullRequestUrls === undefined)
  if (!missing.length) return
  const conversationIds = missing.map(group => group.id)
  const messages = await tx.superTabMessage.findMany({ where: { tabId, conversationId: { in: conversationIds }, text: { contains: 'https://github.com/' } },
    select: { conversationId: true, text: true }, orderBy: { sequence: 'asc' } })
  for (const group of missing) {
    appendPullRequestUrls(group, [
      ...messages.filter(message => message.conversationId === group.id).map(message => message.text),
      ...group.checks.map(check => check.evidence), group.assignment?.result,
    ], groupRepositoryUrl(state, group))
  }
}
