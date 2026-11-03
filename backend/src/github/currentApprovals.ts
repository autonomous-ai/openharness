/**
 * The one-off approval of the repositories Swarm projects use now (task #1694, option B, 2026-11-03). Until then a Swarm
 * without the team account switch got Harness GitHub App tokens for any repository its project named; from then every Swarm
 * needs someone who can push to it to approve it (github/approvals.ts). So that nothing working stops, each live Swarm
 * project on a github.com repository with no approval yet is approved once, for that project alone.
 *
 * Never run by the server: scripts/swarm-github-approvals/approve-current.ts runs it, a dry run unless `--apply`. Production
 * only with the owner's go, after a dry run there was read. It reads each Swarm's head part (its projects), never a whole
 * Swarm, and writes only approval rows, each marked [GRANDFATHERED_BY] rather than a person, so the app never tells anyone
 * "You can push" from one (approvals.ts `reader`). A person's approval is never changed; a second run writes nothing.
 * Undo: delete the rows whose `approvedBy` is [GRANDFATHERED_BY].
 */
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { WHOLE_SWARM } from './approvals.js'
import { githubRepository } from './repository.js'

/** Who approved a pair this migration approved: no person. */
export const GRANDFATHERED_BY = 'system:grandfathered-2026-11-03'

export interface CurrentPair {
  autonomousEnv: string
  tabId: string
  projectId: string
  /** owner/name, lower case. */
  repository: string
}

export interface CurrentApprovalsReport {
  apply: boolean
  /** Live Swarms in parts that were read. */
  swarms: number
  /** Pairs with no approval: approved by this run with `apply`, else to be. */
  pairs: CurrentPair[]
  /** GitHub projects already approved, for themselves or for their whole Swarm. */
  alreadyApproved: number
  /** Rows written (0 in a dry run). */
  written: number
  /** Swarms still kept in one row (format 1): not read. */
  skipped: string[]
  failed: Array<{ tabId: string; error: string }>
}

interface HeadProjects {
  tabId: string
  projects?: Array<{ id?: unknown; repositoryUrl?: unknown }> | null
  /** A Swarm from before projects: its one project, `lead` (projects.ts projectsOf). */
  repositoryUrl?: unknown
}

export async function approveCurrentPairs(db: PrismaClient, opts: { apply: boolean }): Promise<CurrentApprovalsReport> {
  const report: CurrentApprovalsReport = { apply: opts.apply, swarms: 0, pairs: [], alreadyApproved: 0, written: 0, skipped: [], failed: [] }
  const rows = await db.superTab.findMany({ select: { id: true, autonomousEnv: true, format: true, deletedAt: true }, orderBy: { id: 'asc' } })
  const live = new Map<string, string>()
  for (const row of rows) {
    if (row.deletedAt) continue
    if (row.format !== 2) { report.skipped.push(row.id); continue }
    live.set(row.id, row.autonomousEnv)
  }
  report.swarms = live.size
  if (!live.size) return report
  const heads = await db.swarmHead.aggregateRaw({ pipeline: [
    { $match: { key: 'head', deleted: false, tabId: { $in: [...live.keys()] } } },
    { $project: { _id: 0, tabId: 1, projects: { $map: { input: { $ifNull: ['$data.projects', []] }, as: 'p',
      in: { id: '$$p.id', repositoryUrl: '$$p.repository.repositoryUrl' } } },
      hasProjects: { $isArray: '$data.projects' }, repositoryUrl: '$data.project.repositoryUrl' } }] }) as unknown as Array<HeadProjects & { hasProjects: boolean }>
  const used: CurrentPair[] = []
  for (const head of heads) {
    const autonomousEnv = live.get(head.tabId)!
    const projects = head.hasProjects ? head.projects ?? [] : [{ id: 'lead', repositoryUrl: head.repositoryUrl }]
    for (const project of projects) {
      if (typeof project.id !== 'string' || !project.id || typeof project.repositoryUrl !== 'string') continue
      const repository = githubRepository(project.repositoryUrl)
      if (repository) used.push({ autonomousEnv, tabId: head.tabId, projectId: project.id, repository: repository.fullName.toLowerCase() })
    }
  }
  const approvals = await db.gitHubRepositoryApproval.findMany({ where: { tabId: { in: [...new Set(used.map(p => p.tabId))] } },
    select: { autonomousEnv: true, tabId: true, projectId: true, repository: true } })
  const covered = new Set(approvals.map(a => `${a.autonomousEnv}\n${a.tabId}\n${a.projectId}\n${a.repository}`))
  for (const pair of used) {
    const key = (projectId: string) => `${pair.autonomousEnv}\n${pair.tabId}\n${projectId}\n${pair.repository}`
    if (covered.has(key(pair.projectId)) || covered.has(key(WHOLE_SWARM))) report.alreadyApproved++
    else report.pairs.push(pair)
  }
  report.pairs.sort((a, b) => `${a.tabId}\n${a.projectId}` < `${b.tabId}\n${b.projectId}` ? -1 : 1)
  if (!opts.apply) return report
  for (const pair of report.pairs) {
    try {
      // `update: {}`: a person who approved it meanwhile keeps their row as it is.
      await db.gitHubRepositoryApproval.upsert({ where: { autonomousEnv_tabId_repository_projectId: pair }, update: {},
        create: { id: randomUUID(), ...pair, approvedBy: GRANDFATHERED_BY, githubLogin: '' } })
      report.written++
    } catch (error) {
      report.failed.push({ tabId: pair.tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}
