/**
 * Today's Swarms into Teams, and back (docs/plans/2026-10-27-swarm-teams.md, Migration and rollback). Never run by the
 * server: `scripts/swarm-orgs/migrate.ts` runs it, a dry run unless `--apply`, and on production only with the owner's go.
 *
 * Each owner's Swarms go into one Team of theirs (the id their next new Swarm would make, orgStore.ts personalOrgId),
 * named after their first Swarm. The owner owns it; everyone else in those Swarms becomes a guest, so nobody reads more
 * than before. Only Swarms in parts and without a Team are touched; a second run finds nothing to do.
 *
 * The undo takes every Team away: the rows' and heads' Team, and the Team collections. Swarm people stay as they are,
 * so each Swarm reads by its own membership again, as the previous release does.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { clock, guardedWrite, PartConflict } from '../parts/index.js'
import { addMember, personalOrgId } from '../orgStore.js'
import type { Person } from '../model.js'

type Transaction = Prisma.TransactionClient
const TRANSACTION = { maxWait: 5_000, timeout: 60_000 }

export interface OrgMigrationReport {
  apply: boolean
  /** Swarms put (or, in a dry run, to be put) into a Team. */
  swarms: number
  orgsCreated: number
  guestsAdded: number
  /** Swarms not in parts yet: left alone, they get their Team when they are opened and migrated, then rerun. */
  skipped: string[]
  failed: Array<{ tabId: string; error: string }>
  anomalies: {
    /** A Swarm whose owner is not among its people. */
    ownerMissing: string[]
    /** People in Swarms of several owners: a guest of each Team, which shows nothing new. */
    peopleInSeveralTeams: Array<{ userId: string; orgCount: number }>
    /** Machines contributed to Swarms of two owners: afterwards their Harness Team account takes teammates' work in neither. */
    machinesInTwoTeams: Array<{ machineId: string; tabIds: string[] }>
  }
}

interface Pending { id: string; autonomousEnv: string; ownerId: string; createdAt: Date; name: string; people: Person[]; headVersion: number;
  head: Prisma.JsonObject; headFields: { groupCounter: number; visibilityEpoch: number; sequenceBase: number } }

async function pendingSwarms(db: PrismaClient, report: OrgMigrationReport): Promise<Pending[]> {
  const rows = (await db.superTab.findMany({ select: { id: true, autonomousEnv: true, ownerId: true, createdAt: true, format: true, orgId: true } }))
    .filter(r => !r.orgId)
  report.skipped = rows.filter(r => r.format !== 2).map(r => r.id)
  const split = rows.filter(r => r.format === 2)
  const heads = new Map((await db.swarmHead.findMany({ where: { id: { in: split.map(r => `${r.id}:head`) } } })).map(h => [h.tabId, h]))
  const members = await db.swarmMember.findMany({ where: { tabId: { in: split.map(r => r.id) }, deleted: false } })
  return split.flatMap(row => {
    const head = heads.get(row.id)
    if (!head) { report.failed.push({ tabId: row.id, error: 'it has no head part' }); return [] }
    const people = members.filter(m => m.tabId === row.id).map(m => m.data as unknown as Person)
    if (!people.some(p => p.id === row.ownerId)) report.anomalies.ownerMissing.push(row.id)
    const data = head.data as Prisma.JsonObject
    return [{ id: row.id, autonomousEnv: row.autonomousEnv, ownerId: row.ownerId, createdAt: row.createdAt, name: String(data.name ?? ''), people,
      headVersion: head.version, head: data, headFields: { groupCounter: head.groupCounter, visibilityEpoch: head.visibilityEpoch, sequenceBase: head.sequenceBase } }]
  })
}

/** Writes the Team on a Swarm's head (a guarded write, so a command in between wins and the Swarm is retried) and row. */
async function stampSwarm(tx: Transaction, tabId: string, seen: number, head: Prisma.JsonObject, headFields: Pending['headFields'], orgId: string | null) {
  const { orgId: _old, orgVisibility: _visibility, ...rest } = head
  await guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen, data: (orgId ? { ...rest, orgId } : rest) as never, head: headFields }, clock.next())
  const row = await tx.superTab.findUniqueOrThrow({ where: { id: tabId } })
  const updated = await tx.superTab.updateMany({ where: { id: tabId, revision: row.revision }, data: { revision: row.revision + 1, orgId } })
  if (!updated.count) throw new PartConflict('head', 'index')
}

export async function migrateOrgs(db: PrismaClient, opts: { apply: boolean }): Promise<OrgMigrationReport> {
  const report: OrgMigrationReport = { apply: opts.apply, swarms: 0, orgsCreated: 0, guestsAdded: 0, skipped: [], failed: [],
    anomalies: { ownerMissing: [], peopleInSeveralTeams: [], machinesInTwoTeams: [] } }
  const pending = await pendingSwarms(db, report)
  const owners = new Map<string, Pending[]>()
  for (const swarm of pending.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = personalOrgId(swarm.autonomousEnv, swarm.ownerId)
    owners.set(key, [...owners.get(key) ?? [], swarm])
  }

  // What the migration would make: each owner's Team, read against the Teams that already exist.
  const teamsOf = new Map<string, Set<string>>()
  for (const [orgId, swarms] of owners) for (const p of swarms.flatMap(s => s.people)) teamsOf.set(p.id, (teamsOf.get(p.id) ?? new Set()).add(orgId))
  report.anomalies.peopleInSeveralTeams = [...teamsOf].filter(([, orgs]) => orgs.size > 1).map(([userId, orgs]) => ({ userId, orgCount: orgs.size }))
  report.anomalies.machinesInTwoTeams = await machinesInTwoTeams(db, owners)

  for (const [orgId, swarms] of owners) {
    const first = swarms[0]!
    const exists = !!await db.swarmOrg.findUnique({ where: { id: orgId } })
    if (!exists) report.orgsCreated++
    const guests = new Map(swarms.flatMap(s => s.people).filter(p => p.id !== first.ownerId).map(p => [p.id, p]))
    for (const guest of guests.values()) {
      const current = await db.swarmOrgMember.findUnique({ where: { id: `${orgId}:${guest.id}` } })
      if (!current || current.removedAt) report.guestsAdded++
    }
    report.swarms += swarms.length
    if (!opts.apply) continue
    try {
      await db.$transaction(async tx => {
        if (!await tx.swarmOrg.findUnique({ where: { id: orgId } })) {
          await tx.swarmOrg.create({ data: { id: orgId, autonomousEnv: first.autonomousEnv, name: first.name || 'Team', ownerId: first.ownerId, deletedAt: null, purgeAt: null } })
        }
        const ownerEmail = first.people.find(p => p.id === first.ownerId)?.email
          ?? (await tx.user.findUnique({ where: { id: first.ownerId }, select: { email: true } }))?.email ?? ''
        await addMember(tx, orgId, { id: first.ownerId, email: ownerEmail }, 'owner', first.ownerId, `migration:${orgId}`)
        for (const guest of guests.values()) await addMember(tx, orgId, guest, 'guest', first.ownerId, `migration:${orgId}:${guest.id}`)
      }, TRANSACTION)
    } catch (error) {
      for (const swarm of swarms) report.failed.push({ tabId: swarm.id, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    for (const swarm of swarms) {
      try {
        await db.$transaction(tx => stampSwarm(tx, swarm.id, swarm.headVersion, swarm.head, swarm.headFields, orgId), TRANSACTION)
      } catch (error) {
        report.failed.push({ tabId: swarm.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return report
}

/** Machines contributed to Swarms that will be in different Teams, with the Teams that exist already taken into account. */
async function machinesInTwoTeams(db: PrismaClient, owners: Map<string, Pending[]>): Promise<OrgMigrationReport['anomalies']['machinesInTwoTeams']> {
  const pools = await db.swarmMachine.findMany({ where: { deleted: false, contributed: true }, select: { tabId: true, machineId: true } })
  const teamOf = new Map<string, string>()
  for (const [orgId, swarms] of owners) for (const swarm of swarms) teamOf.set(swarm.id, orgId)
  for (const row of await db.superTab.findMany({ where: { id: { in: pools.map(p => p.tabId) } }, select: { id: true, orgId: true } })) {
    if (row.orgId) teamOf.set(row.id, row.orgId)
  }
  const byMachine = new Map<string, string[]>()
  for (const pool of pools) byMachine.set(pool.machineId, [...byMachine.get(pool.machineId) ?? [], pool.tabId])
  return [...byMachine].filter(([, tabIds]) => new Set(tabIds.map(t => teamOf.get(t)).filter(Boolean)).size > 1)
    .map(([machineId, tabIds]) => ({ machineId, tabIds: [...tabIds].sort() }))
}

export interface OrgRollbackReport { apply: boolean; swarms: number; orgs: number; failed: Array<{ tabId: string; error: string }> }

/** Takes every Team away (see the top of this file). A dry run only counts. */
export async function rollbackOrgs(db: PrismaClient, opts: { apply: boolean }): Promise<OrgRollbackReport> {
  const rows = await db.superTab.findMany({ where: { orgId: { not: null } }, select: { id: true } })
  const report: OrgRollbackReport = { apply: opts.apply, swarms: rows.length, orgs: await db.swarmOrg.count(), failed: [] }
  if (!opts.apply) return report
  for (const row of rows) {
    try {
      await db.$transaction(async tx => {
        const head = await tx.swarmHead.findUniqueOrThrow({ where: { id: `${row.id}:head` } })
        await stampSwarm(tx, row.id, head.version, head.data as Prisma.JsonObject,
          { groupCounter: head.groupCounter, visibilityEpoch: head.visibilityEpoch, sequenceBase: head.sequenceBase }, null)
      }, TRANSACTION)
    } catch (error) {
      report.failed.push({ tabId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // The Teams go only once no Swarm names one, so a failed Swarm keeps the Team it still points at; rerun to finish.
  if (!report.failed.length) {
    await db.swarmOrgInvitation.deleteMany({})
    await db.swarmOrgMember.deleteMany({})
    await db.swarmOrg.deleteMany({})
  }
  return report
}
