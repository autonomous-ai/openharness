/**
 * The one-off approval of the repositories Swarm projects use now (task #1694, option B, 2026-11-03). Until then a Swarm
 * without the team account switch got Harness GitHub App tokens for any repository its project named; from then every Swarm
 * needs someone who can push to it to approve it (github/approvals.ts). So that nothing working stops, each live Swarm
 * project on a github.com repository with no approval yet is approved once, for that project alone.
 *
 * Only a repository the app is installed on now is approved: elsewhere the project gets no token today, so nothing working
 * needs it, and an approval there would hand it tokens the day that repository's owner installs the app (security reviews 1
 * and 2 of #2748). Those pairs, and the ones GitHub could not answer for, are listed apart and approved by nobody.
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
import { githubRepository, type GitHubRepository } from './repository.js'

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
  /** Pairs with no approval on a repository the app is installed on: approved by this run with `apply`, else to be. */
  pairs: CurrentPair[]
  /** Pairs with no approval on a repository the app is not installed on: never approved here. */
  notInstalled: CurrentPair[]
  /** Pairs GitHub could not answer for, with the error's code: not approved; run again. */
  unknown: Array<CurrentPair & { error: string }>
  /** GitHub projects already approved, for themselves or for their whole Swarm (also by a person during this run). */
  alreadyApproved: number
  /** Rows written (0 in a dry run). */
  written: number
  /** Swarms not read: still kept in one row (format 1), or with no head part. */
  skipped: string[]
  failed: Array<{ tabId: string; error: string }>
}

interface HeadProjects {
  tabId: string
  projects?: Array<{ id?: unknown; repositoryUrl?: unknown }> | null
  /** A Swarm from before projects: its one project, `lead` (projects.ts projectsOf). */
  repositoryUrl?: unknown
}

/** An error's code alone, never its message: a database or GitHub message may name an address. */
const codeOf = (error: unknown) => typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'ERROR'

/** [installed]: whether the Harness GitHub App is installed on a repository now (GitHubApp.resolve not null); throwing
 *  means GitHub could not say. */
export async function approveCurrentPairs(db: PrismaClient, opts: { apply: boolean; installed: (repository: GitHubRepository) => Promise<boolean> }):
  Promise<CurrentApprovalsReport> {
  const report: CurrentApprovalsReport = { apply: opts.apply, swarms: 0, pairs: [], notInstalled: [], unknown: [], alreadyApproved: 0, written: 0,
    skipped: [], failed: [] }
  const rows = await db.superTab.findMany({ select: { id: true, autonomousEnv: true, format: true, deletedAt: true }, orderBy: { id: 'asc' } })
  const live = new Map<string, string>()
  for (const row of rows) {
    if (row.deletedAt) continue
    if (row.format !== 2) { report.skipped.push(row.id); continue }
    live.set(row.id, row.autonomousEnv)
  }
  if (!live.size) return report
  // `$ne: true`: a head stored before the field existed has none (parts/load.ts).
  const heads = await db.swarmHead.aggregateRaw({ pipeline: [
    { $match: { key: 'head', deleted: { $ne: true }, tabId: { $in: [...live.keys()] } } },
    { $project: { _id: 0, tabId: 1, projects: { $map: { input: { $ifNull: ['$data.projects', []] }, as: 'p',
      in: { id: '$$p.id', repositoryUrl: '$$p.repository.repositoryUrl' } } },
      hasProjects: { $isArray: '$data.projects' }, repositoryUrl: '$data.project.repositoryUrl' } }] }) as unknown as Array<HeadProjects & { hasProjects: boolean }>
  // A live Swarm with no head is listed, never passed over: after the release its teammates would get no tokens.
  const read = new Set(heads.map(h => h.tabId))
  for (const tabId of live.keys()) if (!read.has(tabId)) report.skipped.push(tabId)
  report.swarms = read.size
  const used: Array<CurrentPair & { named: GitHubRepository }> = []
  for (const head of heads) {
    const autonomousEnv = live.get(head.tabId)!
    const projects = head.hasProjects ? head.projects ?? [] : [{ id: 'lead', repositoryUrl: head.repositoryUrl }]
    for (const project of projects) {
      if (typeof project.id !== 'string' || !project.id || typeof project.repositoryUrl !== 'string') continue
      const repository = githubRepository(project.repositoryUrl)
      if (repository) used.push({ autonomousEnv, tabId: head.tabId, projectId: project.id, repository: repository.fullName.toLowerCase(), named: repository })
    }
  }
  const approvals = await db.gitHubRepositoryApproval.findMany({ where: { tabId: { in: [...new Set(used.map(p => p.tabId))] } },
    select: { autonomousEnv: true, tabId: true, projectId: true, repository: true } })
  const covered = new Set(approvals.map(a => `${a.autonomousEnv}\n${a.tabId}\n${a.projectId}\n${a.repository}`))
  // Asked once per repository, as the project names it (resolve follows a rename; the approval keeps the name).
  const answers = new Map<string, Promise<boolean | string>>()
  for (const { named, ...pair } of used) {
    const key = (projectId: string) => `${pair.autonomousEnv}\n${pair.tabId}\n${projectId}\n${pair.repository}`
    if (covered.has(key(pair.projectId)) || covered.has(key(WHOLE_SWARM))) { report.alreadyApproved++; continue }
    if (!answers.has(pair.repository)) answers.set(pair.repository, opts.installed(named).catch(codeOf))
    const installed = await answers.get(pair.repository)!
    if (typeof installed === 'string') report.unknown.push({ ...pair, error: installed })
    else (installed ? report.pairs : report.notInstalled).push(pair)
  }
  const order = (a: CurrentPair, b: CurrentPair) => `${a.tabId}\n${a.projectId}` < `${b.tabId}\n${b.projectId}` ? -1 : 1
  report.pairs.sort(order); report.notInstalled.sort(order); report.unknown.sort(order)
  if (!opts.apply) return report
  for (const pair of report.pairs) {
    try {
      await db.gitHubRepositoryApproval.create({ data: { id: randomUUID(), ...pair, approvedBy: GRANDFATHERED_BY, githubLogin: '' } })
      report.written++
    } catch (error) {
      // A person approved it after the read (the unique index): their row stays as it is.
      if (codeOf(error) === 'P2002') report.alreadyApproved++
      else report.failed.push({ tabId: pair.tabId, error: codeOf(error) })
    }
  }
  return report
}
