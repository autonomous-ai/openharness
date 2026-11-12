/**
 * Which agent wrote a GitHub comment it posted through Harness (anh Dee, 2026-11-10): the merger and GitHub news read the author
 * from here, by comment id, instead of parsing a signature an agent may forget or misspell. Its daemon records each comment right
 * after `gh` answered with its id; a comment nothing recorded (older, or posted outside Harness) is read by its signature as
 * before. A row holds ids only: no words, no URLs, no logins. Each goes 90 days after it was written: the merger and news read
 * the comments of open pull requests and issues, days old. Records are a Swarm's own: another Swarm on the same repository
 * neither sees nor blocks them.
 */
import type { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { metrics } from '../lib/metrics.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { githubRepository } from '../github/repository.js'
import { fail } from './model.js'
import { readBy } from './parts/indexed.js'
import { projectsOf, type SwarmProject } from './projects.js'
import type { SuperTabState } from './model.js'

export const COMMENT_KINDS = ['issue', 'review', 'review-comment'] as const
export type CommentKind = typeof COMMENT_KINDS[number]
/** Ids one read asks about at most. */
export const MAX_COMMENT_IDS = 100
/** A record is kept this long. */
const COMMENT_EXPIRY_MS = 90 * 24 * 60 * 60_000
/** New records one agent may write in an hour: far above any agent's comments, low enough that a loop cannot fill the collection. */
export const RECORDS_PER_HOUR = 600

const recordLimit = createRateLimiter('github-comment', 60 * 60_000, RECORDS_PER_HOUR)

/** The stored id of a comment in a Swarm: GitHub numbers each kind apart, and a repository's name is any case on GitHub. */
export const commentKey = (tabId: string, repository: string, kind: CommentKind, commentId: string): string =>
  `${tabId}|${repository.toLowerCase()}|${kind}|${commentId}`

/** Whether [project] works on [repository] (`owner/name`, any case). */
export const sameRepository = (project: SwarmProject, repository: string): boolean =>
  githubRepository(project.repository?.repositoryUrl ?? '')?.fullName.toLowerCase() === repository.toLowerCase()

/**
 * The project of [repository] in a Swarm: of its projects on it that have a PM, the one that got its address first. A project's
 * repository is set by its owner or lead with no proof of access to it, so a repository has one coordinator in a Swarm, this
 * project's PM (taskOffers.ts): a member who makes or fills a later project on it holds none of its tasks (reviews of #4152).
 * The first MADE was not it: a project with no address yet can get one later, and became the coordinator over the project
 * already working on it. One whose address was set before its time was kept comes first, in the order projects were made; one
 * with no PM (its start not yet joined, its session closed) is passed over, or it would stop every later project on its
 * repository from offering.
 */
export function repositoryProject(state: SuperTabState, repository: string): SwarmProject | undefined {
  const led = new Set(state.conversations.filter(c => c.leadId && state.agents.some(a => a.id === c.leadId)).map(c => c.id))
  return projectsOf(state).filter(project => sameRepository(project, repository) && led.has(project.leadConversationId))
    .sort((a, b) => (a.repository?.addressedAt ?? 0) - (b.repository?.addressedAt ?? 0))[0]
}

/** Run by the release's schema step before db push (lib/db/schemaRelease.ts), as the operation receipts' expiry is. */
export async function ensureCommentExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabGithubComment', { key: { createdAt: 1 }, name: 'github_comment_expiry', expireAfterSeconds: COMMENT_EXPIRY_MS / 1000 })
}

type Comments = Pick<PrismaClient, 'superTabGithubComment'>

/** Answers a comment already recorded: the same agent's again is no change (a daemon's retry costs nothing), another's is refused. */
async function recorded(db: Comments, id: string, agentId: string): Promise<boolean> {
  const held = await db.superTabGithubComment.findUnique({ where: { id }, select: { agentId: true } })
  if (!held) return false
  if (held.agentId !== agentId) {
    metrics.githubCommentRecord('taken')
    fail('COMMENT_NOT_YOURS', 'Another agent wrote this comment.', 409)
  }
  metrics.githubCommentRecord('again')
  return true
}

/** Records that [agentId] wrote the comment. First writer wins. Only a new record counts against the agent's hour, every pod
 *  together. */
export async function recordComment(db: Comments, input: { tabId: string; projectId: string; agentId: string; repository: string;
  kind: CommentKind; commentId: string; now: number }): Promise<{ recorded: true }> {
  const id = commentKey(input.tabId, input.repository, input.kind, input.commentId)
  if (await recorded(db, id, input.agentId)) return { recorded: true }
  if (!await recordLimit.allows(`${input.tabId}:${input.agentId}`, input.now)) {
    metrics.githubCommentRecord('limited')
    fail('RATE_LIMITED', `An agent records at most ${RECORDS_PER_HOUR} GitHub comments an hour. Try again later.`, 429)
  }
  try {
    await db.superTabGithubComment.create({ data: { id, tabId: input.tabId, projectId: input.projectId, agentId: input.agentId, createdAt: new Date(input.now) } })
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
    // Another write of the same comment won the race: its row decides.
    if (!await recorded(db, id, input.agentId)) throw error
    return { recorded: true }
  }
  metrics.githubCommentRecord('recorded')
  return { recorded: true }
}

/** The agents of [tabId] that wrote the comments [ids] (`kind:id`) on [repository], with the project each was recorded for, by
 *  those ids; ids nothing recorded are left out. One read by `_id`, named. */
export async function commentAuthors(db: Comments, tabId: string, repository: string,
  ids: readonly string[]): Promise<Map<string, { agentId: string; projectId: string }>> {
  const asked = new Map<string, string>()
  for (const id of ids) {
    const at = id.indexOf(':')
    const kind = id.slice(0, at) as CommentKind
    if (at > 0 && COMMENT_KINDS.includes(kind)) asked.set(commentKey(tabId, repository, kind, id.slice(at + 1)), id)
  }
  if (!asked.size) return new Map()
  const rows = await readBy(db as never, 'SuperTabGithubComment', 'id', [{ $match: { _id: { $in: [...asked.keys()] } } },
    { $project: { _id: 1, agentId: 1, projectId: 1 } }]) as Array<{ _id: string; agentId: string; projectId: string }>
  metrics.githubCommentRead(asked.size, rows.length)
  return new Map(rows.map(row => [asked.get(row._id)!, { agentId: row.agentId, projectId: row.projectId }]))
}
