/**
 * Which agent wrote a GitHub comment it posted through Harness (anh Dee, 2026-11-10): the merger and GitHub news read the author
 * from here, by comment id, instead of parsing a signature an agent may forget or misspell. Its daemon records each comment right
 * after `gh` answered with its id; a comment nothing recorded (older, or posted outside Harness) is read by its signature as
 * before. A row holds ids only: no words, no URLs, no logins. Each goes 90 days after it was written: the merger and news read
 * the comments of open pull requests and issues, days old.
 */
import type { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { githubRepository } from '../github/repository.js'
import { fail } from './model.js'
import type { SwarmProject } from './projects.js'

export const COMMENT_KINDS = ['issue', 'review', 'review-comment'] as const
export type CommentKind = typeof COMMENT_KINDS[number]
/** Ids one read asks about at most. */
export const MAX_COMMENT_IDS = 100
/** A record is kept this long. */
const COMMENT_EXPIRY_MS = 90 * 24 * 60 * 60_000
/** Records one agent may write in an hour: far above any agent's comments, low enough that a loop cannot fill the collection. */
export const RECORDS_PER_HOUR = 600

const recordLimit = createRateLimiter('github-comment', 60 * 60_000, RECORDS_PER_HOUR)

/** The stored id of a comment: GitHub numbers each kind apart, and a repository's name is any case on GitHub. */
export const commentKey = (repository: string, kind: CommentKind, commentId: string): string => `${repository.toLowerCase()}|${kind}|${commentId}`

/** Whether [project] works on [repository] (`owner/name`, any case). */
export const sameRepository = (project: SwarmProject, repository: string): boolean =>
  githubRepository(project.repository?.repositoryUrl ?? '')?.fullName.toLowerCase() === repository.toLowerCase()

/** Run by the release's schema step before db push (lib/db/schemaRelease.ts), as the operation receipts' expiry is. */
export async function ensureCommentExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabGithubComment', { key: { createdAt: 1 }, name: 'github_comment_expiry', expireAfterSeconds: COMMENT_EXPIRY_MS / 1000 })
}

/** Records that [agentId] wrote the comment. First writer wins: the same record again is no change; another agent's claim on
 *  a comment already recorded is refused. Counted per agent, every pod together. */
export async function recordComment(db: Pick<PrismaClient, 'superTabGithubComment'>, input: { tabId: string; projectId: string; agentId: string;
  repository: string; kind: CommentKind; commentId: string; now: number }): Promise<{ recorded: true }> {
  if (!await recordLimit.allows(`${input.tabId}:${input.agentId}`, input.now)) {
    fail('RATE_LIMITED', `An agent records at most ${RECORDS_PER_HOUR} GitHub comments an hour. Try again later.`, 429)
  }
  const id = commentKey(input.repository, input.kind, input.commentId)
  try {
    await db.superTabGithubComment.create({ data: { id, tabId: input.tabId, projectId: input.projectId, agentId: input.agentId, createdAt: new Date(input.now) } })
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
    const held = await db.superTabGithubComment.findUnique({ where: { id }, select: { tabId: true, agentId: true } })
    if (held?.tabId !== input.tabId || held.agentId !== input.agentId) fail('COMMENT_NOT_YOURS', 'Another agent wrote this comment.', 409)
  }
  return { recorded: true }
}

/** The agents of [tabId] that wrote the comments [ids] (`kind:id`) on [repository], with the project each was recorded for, by
 *  those ids; ids nothing recorded are left out. */
export async function commentAuthors(db: Pick<PrismaClient, 'superTabGithubComment'>, tabId: string, repository: string,
  ids: readonly string[]): Promise<Map<string, { agentId: string; projectId: string }>> {
  const asked = new Map<string, string>()
  for (const id of ids) {
    const at = id.indexOf(':')
    const kind = id.slice(0, at) as CommentKind
    if (at > 0 && COMMENT_KINDS.includes(kind)) asked.set(commentKey(repository, kind, id.slice(at + 1)), id)
  }
  if (!asked.size) return new Map()
  // A plain match on `_id`, its index: Prisma's `in` would reach Mongo as an $expr.
  const rows = await db.superTabGithubComment.aggregateRaw({ pipeline: [{ $match: { _id: { $in: [...asked.keys()] }, tabId } },
    { $project: { _id: 1, agentId: 1, projectId: 1 } }] }) as unknown as Array<{ _id: string; agentId: string; projectId: string }>
  return new Map(rows.map(row => [asked.get(row._id)!, { agentId: row.agentId, projectId: row.projectId }]))
}
