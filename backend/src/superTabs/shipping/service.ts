import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { fail } from '../model.js'
import { readBy } from '../parts/indexed.js'
import { partId } from '../parts/write.js'
import { personReadsProject, projectGitHub, type SwarmProject } from '../projects.js'
import type { Person } from '../model.js'
import { machineSwarms } from '../swarmRows.js'
import { membersOf } from './access.js'
import { BACKFILL_WEEKS, FAILURE_FRESH_MS, MAX_LISTED, MAX_RANGE_WEEKS, MAX_REPOSITORIES, MAX_SWARMS, WEEKS_READABLE, type BoardQuery, type ReadFailure, type ReportBody, type ShippingBoard,
  type ShippingReported, type ShippingTargets } from './contract.js'
import { applyReport } from './report.js'
import { pointsStages, rankSums } from './score.js'
import { WEEK_MS, weekStart } from './week.js'

type Raw = Record<string, unknown>
const list = (value: unknown): Raw[] => Array.isArray(value) ? value.filter((item): item is Raw => !!item && typeof item === 'object') : []

/**
 * The Swarm leaderboard's store (docs/plans/2026-11-09-swarm-v4-leaderboard.md): what a daemon is told to read, what it reports,
 * and the board of people ranked by how many of their agents ship. Each is a few reads by index of the rows of one Swarm.
 */
export class Shipping {
  private readonly now: () => number

  constructor(private readonly db: PrismaClient, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /** For a machine's daemon: in each Swarm of the machine where the signed-in person has agents and a project has a GitHub
   *  repository the person reads, the repositories, and each agent's name with where its reading starts. */
  async targets(user: AuthUser, machineId: string): Promise<ShippingTargets> {
    const current = weekStart(this.now())
    const tabIds = await machineSwarms(this.db, user.autonomousEnv, machineId, MAX_SWARMS)
    if (!tabIds.length) return { swarms: [] }
    // A deleted Swarm lists nobody, so it is not one of the person's.
    const mine = new Set((await readBy(this.db, 'SuperTab', 'id', [{ $match: { _id: { $in: tabIds }, memberIds: user.sub } }, { $project: { _id: 1 } }])).map(row => String(row._id)))
    const agents = new Map<string, Array<{ id: string; name: string }>>()
    for (const row of await this.db.swarmAgent.aggregateRaw({ pipeline: [{ $match: { machineId, machineOwnerId: user.sub, deleted: false } },
      { $project: { tabId: 1, key: 1, 'data.displayName': 1, 'data.name': 1 } }] }) as unknown as Raw[]) {
      const tabId = String(row.tabId), data = (row.data ?? {}) as Raw
      const name = [data.displayName, data.name].find((value): value is string => typeof value === 'string' && value.trim() !== '')?.trim()
      if (mine.has(tabId) && name) agents.set(tabId, [...agents.get(tabId) ?? [], { id: String(row.key), name }])
    }
    const named = tabIds.filter(tabId => agents.has(tabId))
    if (!named.length) return { swarms: [] }
    const [heads, totals, memberships] = await Promise.all([
      this.db.swarmHead.aggregateRaw({ pipeline: [{ $match: { tabId: { $in: named }, key: 'head' } }, { $project: { tabId: 1, 'data.projects.visibility': 1,
        'data.projects.ownerId': 1, 'data.projects.ownerGeneration': 1, 'data.projects.members.id': 1, 'data.projects.members.generation': 1, 'data.projects.repository.repositoryUrl': 1, 'data.projects.githubRepository': 1 } }] }) as unknown as Promise<Raw[]>,
      this.db.swarmShipping.aggregateRaw({ pipeline: [{ $match: { tabId: { $in: named }, week: 0, personId: user.sub } }, { $project: { tabId: 1, agentId: 1, settled: 1 } }] }) as unknown as Promise<Raw[]>,
      // The person's membership in each, which says what of an earlier membership is no longer theirs.
      readBy(this.db, 'SwarmMember', 'id', [{ $match: { _id: { $in: named.map(tabId => partId(tabId, user.sub)) }, deleted: false } }, { $project: { tabId: 1, 'data.generation': 1 } }])])
    const membership = new Map(memberships.map(member => [String(member.tabId), { id: user.sub, generation: (member.data as Raw | undefined)?.generation } as Pick<Person, 'id' | 'generation'>]))
    const repositories = new Map(heads.map(head => [String(head.tabId), [...new Set(list((head.data as Raw | undefined)?.projects)
      // Only a project the person reads, as the Swarm decides it (projects.ts personReadsProject): never one they read or owned at an
      // earlier membership (removed and invited back), and none without a member row.
      .filter(project => { const member = membership.get(String(head.tabId)); return !!member && personReadsProject(member, project as unknown as SwarmProject) })
      // In lower case, as GitHub reads a name: a name given in another case than another project's address is one repository, read once.
      .flatMap(project => projectGitHub(project as unknown as SwarmProject)?.fullName.toLowerCase() ?? []))].sort().slice(0, MAX_REPOSITORIES)]))
    const settled = new Map(totals.map(total => [`${total.tabId}:${total.agentId}`, Number(total.settled ?? 0)]))
    const earliest = current - MAX_RANGE_WEEKS * WEEK_MS
    return { swarms: named.flatMap(tabId => repositories.get(tabId)?.length ? [{ tabId, repositories: repositories.get(tabId)!,
      agents: agents.get(tabId)!.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .map(agent => ({ ...agent, from: Math.max(settled.get(`${tabId}:${agent.id}`) || current - BACKFILL_WEEKS * WEEK_MS, earliest) })) }] : []) }
  }

  /** A daemon's report for one Swarm (report.ts). */
  report(user: AuthUser, machineId: string, body: ReportBody): Promise<ShippingReported> {
    return applyReport(this.db, user, machineId, body, this.now())
  }

  /** The Swarm's people ranked for a week (this one or one of the three before it) or for all time, with the reader's own failed
   *  readings. For the Swarm's people only; a person who left is no longer listed. The sums are made in the database, one row per
   *  person, and the first MAX_LISTED people come back with the reader if they rank lower. */
  async board(user: AuthUser, tabId: string, query: BoardQuery): Promise<ShippingBoard> {
    const now = this.now(), current = weekStart(now)
    const week = query.all ? 0 : query.week ?? current
    if (!query.all && (weekStart(week) !== week || week > current || week <= current - WEEKS_READABLE * WEEK_MS)) {
      fail('INVALID_WEEK', `Ask for this week or one of the ${WEEKS_READABLE - 1} before it, by its Monday 00:00 UTC.`, 400)
    }
    const members = await membersOf(this.db, user, tabId)
    const [sums, own] = await Promise.all([
      this.db.swarmShipping.aggregateRaw({ pipeline: [{ $match: { tabId, week } }, ...pointsStages()] }) as unknown as Promise<Raw[]>,
      this.db.swarmShipping.findMany({ where: { tabId, week: 0, personId: user.sub }, select: { failed: true, failedMachineId: true, failedAt: true } })])
    const standings = rankSums(sums.filter(row => members.has(String(row._id))).map(row => ({ personId: String(row._id), sum: Number(row.sum), shipping: Number(row.shipping) })))
    const listed = standings.slice(0, MAX_LISTED)
    const reader = standings.find(person => person.personId === user.sub)
    if (reader && !listed.includes(reader)) listed.push(reader)
    const named = listed.length ? await this.db.swarmMember.aggregateRaw({ pipeline: [{ $match: { tabId, deleted: false, key: { $in: listed.map(person => person.personId) } } },
      { $project: { key: 1, 'data.name': 1, 'data.username': 1, 'data.email': 1 } }] }) as unknown as Raw[] : []
    const names = new Map(named.map(member => {
      // What the Swarm shows (personNames.ts shownNameOf): the name they set, else their username, else what a default one is made
      // from, the start of their address. A default's number for two of one name needs every person and agent read: left out.
      const person = (member.data ?? {}) as Raw
      const shown = [person.name, person.username].find((value): value is string => typeof value === 'string' && value.trim() !== '')?.trim()
      return [String(member.key), shown || String(person.email ?? '').split('@')[0] || String(member.key)]
    }))
    // A failure is shown while it is reported: one nobody repeats (a deleted agent, a stopped daemon) goes after FAILURE_FRESH_MS.
    const failures = [...new Map(own.flatMap(row => row.failed && row.failedMachineId && (row.failedAt ?? 0) >= now - FAILURE_FRESH_MS ? [[`${row.failedMachineId}:${row.failed}`,
      { machineId: row.failedMachineId, code: row.failed as ReadFailure }] as const] : [])).values()]
      .sort((a, b) => a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
    return { week: query.all ? null : week, people: listed.map(person => ({ ...person, displayName: names.get(person.personId) ?? person.personId })), failures }
  }
}
