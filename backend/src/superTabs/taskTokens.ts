/**
 * What an agent's conversation used on a task (Swarm allocator, package 12, 2026-11-11): no saving can be claimed, and no
 * model or price chosen, without it. Its own daemon counts it, between the task's boundaries as that daemon sees them
 * (taken, its pull request up, each fix; a read's verdict), and writes the totals here when a piece of work stops. The
 * server only keeps them: it knows no task's ends since Swarm v4, where tasks are GitHub issues. The cost record v3 had
 * (#3908) took every session's totals in every machine report, priced them and fed routing; this prices nothing, sums
 * nothing and decides nothing.
 *
 * A row is one agent's work of one kind on one issue or pull request: counts by model, how many rounds, and when it began
 * and last ended. Ids and counts only: no title, no words, no branch, no login. Each goes 90 days after it was first
 * written, long enough for a class of tasks to show what it costs, and a Swarm's go with it. Rows are a Swarm's own.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { metrics } from '../lib/metrics.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { fail } from './model.js'
import { readBy } from './parts/indexed.js'
import { ms } from './parts/light.js'

/** The work a row counts: building a task, fixing its pull request after it was up for reading, or reading another's. */
export const TASK_KINDS = ['build', 'fix', 'read'] as const
export type TaskKind = typeof TASK_KINDS[number]
/** Models one row counts apart, as a session does (cli lib/agentUsageWire.ts MAX_USAGE_MODELS). */
export const MAX_TASK_MODELS = 16
/** Issues and pull requests one read asks about, and the rows it takes back: a pull request and the tasks it closes, each
 *  with a builder's rows and a few readers'. */
export const MAX_TASK_NUMBERS = 20
export const MAX_TASK_ROWS = 200
/** A row is kept this long after it was first written. */
const TASK_TOKENS_EXPIRY_MS = 90 * 24 * 60 * 60_000
/** Writes one agent may make in an hour: its daemon writes when a piece of work stops, a few times a task, so this is far
 *  above any agent's, and low enough that a loop cannot fill the collection. */
export const TOKEN_WRITES_PER_HOUR = 240

/** One model's tokens: uncached input, output (reasoning included), cache reads and cache writes. */
export interface ModelTokens { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
/** What a daemon writes: the totals so far for one number and kind, and when the work began and last ended, by its clock. */
export interface TaskTokens { number: number; kind: TaskKind; tokens: ModelTokens[]; rounds: number; startedAt: number; endedAt: number }

const writeLimit = createRateLimiter('task-tokens', 60 * 60_000, TOKEN_WRITES_PER_HOUR)

/** The stored id of a row in a Swarm: a repository's name is any case on GitHub. */
export const taskTokensKey = (tabId: string, repository: string, number: number, agentId: string, kind: TaskKind): string =>
  `${tabId}|${repository.toLowerCase()}|${number}|${agentId}|${kind}`

/** Run by the release's schema step before db push (lib/db/schemaRelease.ts), as the comment records' expiry is. */
export async function ensureTaskTokensExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabTaskTokens', { key: { createdAt: 1 }, name: 'task_tokens_expiry', expireAfterSeconds: TASK_TOKENS_EXPIRY_MS / 1000 })
}

type Rows = Pick<PrismaClient, 'superTabTaskTokens'>

/** Keeps [agentId]'s totals so far for one number and kind: the same write again changes nothing, a later one replaces the
 *  numbers. Its id holds its agent, so no agent writes another's. Every write counts against the agent's hour, every pod
 *  together. */
export async function recordTaskTokens(db: Rows, input: TaskTokens & { tabId: string; projectId: string; agentId: string; repository: string; now: number }): Promise<{ recorded: true }> {
  if (!await writeLimit.allows(`${input.tabId}:${input.agentId}`, input.now)) {
    metrics.taskTokensWrite('limited')
    fail('RATE_LIMITED', `An agent writes its tasks' tokens at most ${TOKEN_WRITES_PER_HOUR} times an hour. Try again later.`, 429)
  }
  const id = taskTokensKey(input.tabId, input.repository, input.number, input.agentId, input.kind)
  const totals = { tokens: input.tokens as unknown as Prisma.InputJsonValue, rounds: input.rounds, startedAt: new Date(input.startedAt), endedAt: new Date(input.endedAt) }
  try {
    await db.superTabTaskTokens.create({ data: { id, tabId: input.tabId, projectId: input.projectId, agentId: input.agentId, repository: input.repository.toLowerCase(),
      number: input.number, kind: input.kind, ...totals, createdAt: new Date(input.now) } })
    metrics.taskTokensWrite('created')
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
    // The row is there, from an earlier boundary of the same work: its totals move on, and its expiry still counts from its first write.
    await db.superTabTaskTokens.update({ where: { id }, data: totals })
    metrics.taskTokensWrite('updated')
  }
  return { recorded: true }
}

/** A whole number as `aggregateRaw` answers it: plain, or wrapped when Mongo keeps it in 64 bits. */
const whole = (value: unknown): number => typeof value === 'number' ? value
  : Number((value as { $numberLong?: string; $numberInt?: string; $numberDouble?: string }).$numberLong
    ?? (value as { $numberInt?: string }).$numberInt ?? (value as { $numberDouble?: string }).$numberDouble)

/** The rows of [tabId] for the issues and pull requests [numbers] of [repository], each with the project it was written
 *  for and its agent; at most MAX_TASK_ROWS. One read by the Swarm, the repository and the numbers, named. */
export async function taskTokens(db: Rows, tabId: string, repository: string,
  numbers: readonly number[]): Promise<Array<TaskTokens & { projectId: string; agentId: string }>> {
  if (!numbers.length) return []
  const rows = await readBy(db as never, 'SuperTabTaskTokens', 'numbers', [{ $match: { tabId, repository: repository.toLowerCase(), number: { $in: [...numbers] } } },
    { $limit: MAX_TASK_ROWS }, { $project: { _id: 0, projectId: 1, agentId: 1, number: 1, kind: 1, tokens: 1, rounds: 1, startedAt: 1, endedAt: 1 } }])
  metrics.taskTokensRead(rows.length > 0)
  return rows.map(row => ({ projectId: String(row.projectId), agentId: String(row.agentId), number: whole(row.number), kind: row.kind as TaskKind,
    tokens: (row.tokens as Array<Record<string, unknown>>).map(model => ({ model: String(model.model), input: whole(model.input), output: whole(model.output),
      cacheRead: whole(model.cacheRead), cacheWrite: whole(model.cacheWrite) })),
    rounds: whole(row.rounds), startedAt: ms(row.startedAt), endedAt: ms(row.endedAt) }))
}
