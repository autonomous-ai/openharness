/**
 * The records one project's scorecard day is computed from (figures.ts), read from Mongo through named indexes: the
 * project's open groups and those active in the day, each group's rows back to the day's start (and, for a task, its last
 * status before it; for the chat, the ask lookback), the rows people replied to, the asks' deliveries, and the day's starts
 * and route decisions. Every read is bounded: a group stops at its cap and the row says how many did.
 */
import type { Prisma, SuperTabMessage } from '@prisma/client'
import type { Conversation } from '../model.js'
import { groupsBy, readBy } from '../parts/indexed.js'
import { ms } from '../parts/light.js'
import { prismaRow } from '../rawRows.js'
import { messagesPast } from '../pageReads.js'
import { SCORECARD_LIMITS, type ScorecardInput, type ScorecardMessage, type ScorecardTask } from './figures.js'

type Transaction = Prisma.TransactionClient

/** Rows one task's read takes at most, and the project chat's (seven days of a busy chat). */
export const GROUP_ROW_CAP = 5_000
export const CHAT_ROW_CAP = 20_000
const PAGE = 500
const DAY = 24 * 60 * 60_000
/** Route decisions and starts one day reads at most; far above a busy project's day. */
const DAY_ROW_CAP = 10_000

const GROUP_FIELDS = { _id: 0, key: 1, 'data.id': 1, 'data.kind': 1, 'data.number': 1, 'data.reviewOf': 1, 'data.leadId': 1, 'data.ledger.askedAt': 1,
  'data.ledger.shippedAt': 1, 'data.ledger.fixedAfterMergeAt': 1, 'data.ledger.runs.at': 1, 'data.ledger.proposal.messageId': 1,
  'data.cards.line.messageId': 1 }

export interface ScorecardRecords { input: ScorecardInput; capped: number }

const date = (at: number) => ({ $date: new Date(at).toISOString() })
const projectIds = (projectId: string) => projectId === 'lead' ? ['lead', null] : [projectId]

/** The project's groups the day can count: every open one, and the quiet ones active since the day began. */
async function projectGroups(tx: Transaction, tabId: string, projectId: string, start: number): Promise<Conversation[]> {
  const base = { tabId, deleted: false, projectId: { $in: projectIds(projectId) } }
  const rows = [
    ...await groupsBy(tx, 'project', [{ $match: { ...base, dormant: false } }, { $project: GROUP_FIELDS }]),
    ...await groupsBy(tx, 'project', [{ $match: { ...base, dormant: true, lastActivityAt: { $gte: date(start) } } }, { $project: GROUP_FIELDS }]),
  ]
  return rows.map(row => ({ ...row.data as Conversation, id: (row.data as Conversation | undefined)?.id ?? String(row.key) }))
}

const asMessage = (row: SuperTabMessage): ScorecardMessage => {
  const author = row.author as { kind?: string; id?: string } | null
  return { id: row.id, conversationId: row.conversationId, author: { kind: author?.kind === 'person' ? 'person' : 'agent', id: String(author?.id ?? '') },
    source: (row.source ?? null) as Record<string, unknown> | null, text: row.text, replyTo: row.replyTo ?? null, thread: row.thread ?? null,
    createdAt: row.createdAt.getTime() }
}

/** A row that says a task's phase (figures.ts): a status, a loss or a resume. */
const phaseRow = (row: SuperTabMessage) => {
  const source = row.source as { kind?: unknown; status?: unknown } | null
  return (source?.kind === 'system' && typeof source.status === 'string') || source?.kind === 'work-lost' || source?.kind === 'work-resumed'
}

/** One group's rows, newest first, back to `from`; a task's go on to its last phase row before it. Stops at `cap`. */
async function groupRows(tx: Transaction, tabId: string, conversationId: string, from: number, task: boolean, cap: number):
  Promise<{ rows: ScorecardMessage[]; capped: boolean }> {
  const rows: ScorecardMessage[] = []
  let edge: { sequence: number; id: string } | undefined
  for (let read = 0; read < cap;) {
    const page = await messagesPast(tx, { tabId, conversationId }, edge, false, Math.min(PAGE, cap - read))
    read += page.length
    for (const row of page) {
      if (row.deletedAt) continue
      if (row.createdAt.getTime() >= from) { rows.push(asMessage(row)); continue }
      if (!task) return { rows, capped: false }
      if (phaseRow(row)) { rows.push(asMessage(row)); return { rows, capped: false } }
    }
    if (page.length < PAGE) return { rows, capped: false }
    const last = page.at(-1)!
    edge = { sequence: last.sequence, id: last.id }
  }
  return { rows, capped: true }
}

/** One project's records for the local day [start, end). */
export async function scorecardRecords(tx: Transaction, at: { tabId: string; projectId: string; chatId: string; start: number; end: number }):
  Promise<ScorecardRecords> {
  const { tabId, projectId, chatId, start, end } = at
  const groups = await projectGroups(tx, tabId, projectId, start)
  const chat = groups.find(g => g.id === chatId)
  const ids = new Set(groups.map(g => g.id))
  let capped = 0
  const messages: ScorecardMessage[] = []
  for (const group of groups) {
    const isChat = group.id === chatId
    // A Buddy chat is a person's own, not the project's work.
    if (group.kind && !isChat) continue
    const from = isChat ? end - SCORECARD_LIMITS.askLookbackDays * DAY : start
    const read = await groupRows(tx, tabId, group.id, from, !isChat, isChat ? CHAT_ROW_CAP : GROUP_ROW_CAP)
    if (read.capped) capped++
    messages.push(...read.rows)
  }
  // The rows people replied to in the day, wherever they are: whether a PM wrote them. Matched by id alone (pageReads.ts).
  const have = new Set(messages.map(m => m.id))
  const wanted = [...new Set(messages.filter(m => m.author.kind === 'person' && m.replyTo && !have.has(m.replyTo) && m.createdAt >= start && m.createdAt < end)
    .map(m => m.replyTo!))]
  for (let i = 0; i < wanted.length; i += PAGE) {
    const found = await readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: wanted.slice(i, i + PAGE) } } }])
    messages.push(...found.map(row => prismaRow<SuperTabMessage>('SuperTabMessage', row)).filter(row => row.tabId === tabId).map(asMessage))
  }
  const asks = messages.filter(m => m.conversationId === chatId && m.author.kind === 'person' && !m.source).map(m => m.id)
  const answeredDeliveries: ScorecardInput['answeredDeliveries'] = []
  for (let i = 0; i < asks.length; i += PAGE) {
    const found = await readBy(tx, 'SuperTabDelivery', 'byMessage', [{ $match: { tabId, messageId: { $in: asks.slice(i, i + PAGE) }, answeredAt: { $ne: null } } },
      { $project: { messageId: 1, answeredAt: 1 } }])
    answeredDeliveries.push(...found.flatMap(row => row.answeredAt ? [{ messageId: String(row.messageId), answeredAt: ms(row.answeredAt) }] : []))
  }
  const starts = (await readBy(tx, 'SwarmStart', 'changes', [{ $match: { tabId, changedAt: { $gte: date(start) } } }, { $limit: DAY_ROW_CAP },
    { $project: { conversationId: 1, 'data.requestedAt': 1, 'data.error': 1 } }]))
    .flatMap(row => {
      const data = row.data as { requestedAt?: unknown; error?: unknown } | undefined
      return ids.has(String(row.conversationId)) && typeof data?.requestedAt === 'number'
        ? [{ conversationId: String(row.conversationId), requestedAt: data.requestedAt, failed: data.error != null }] : []
    })
  const routeDecisions = (await readBy(tx, 'SuperTabRouteDecision', 'recent', [{ $match: { tabId, createdAt: { $gte: date(start), $lt: date(end) } } },
    { $limit: DAY_ROW_CAP }, { $project: { conversationId: 1, createdAt: 1 } }]))
    .flatMap(row => ids.has(String(row.conversationId)) ? [{ conversationId: String(row.conversationId), createdAt: ms(row.createdAt) }] : [])
  const tasks: ScorecardTask[] = groups.filter(g => g.id !== chatId && !g.kind).map(g => ({ id: g.id,
    ...g.number !== undefined ? { number: g.number } : {}, ...g.reviewOf ? { reviewOf: g.reviewOf } : {},
    ...g.ledger?.askedAt !== undefined ? { askedAt: g.ledger.askedAt } : {}, ...g.ledger?.shippedAt !== undefined ? { shippedAt: g.ledger.shippedAt } : {},
    ...g.ledger?.fixedAfterMergeAt !== undefined ? { fixedAfterMergeAt: g.ledger.fixedAfterMergeAt } : {},
    runs: (g.ledger?.runs ?? []).map(r => r.at).filter(at => typeof at === 'number'),
    requestMessageIds: [g.cards?.line?.messageId, g.ledger?.proposal?.messageId].filter((id): id is string => typeof id === 'string') }))
  return { capped, input: { start, end, chatId, pmAgentIds: chat?.leadId ? [chat.leadId] : [], tasks, messages, answeredDeliveries, starts, routeDecisions } }
}
