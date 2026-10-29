/**
 * Today's Swarms into Workspaces, and back (docs/plans/2026-10-27-swarm-workspaces.md, Migration and rollback). Never run by the
 * server: `scripts/swarm-workspaces/migrate.ts` runs it, a dry run unless `--apply`, and on production only with the owner's go.
 *
 * Each owner's Swarms go into one Workspace of theirs (the id their next new Swarm would make, workspaceStore.ts personalWorkspaceId),
 * named after their first Swarm. The owner owns it; everyone else in those Swarms becomes a guest, so nobody reads more
 * than before. Only Swarms in parts and without a Workspace are touched; a second run finds nothing to do.
 *
 * The undo takes every Workspace away: the rows' and heads' Workspace, and the Workspace collections. Swarm people stay as they are,
 * so each Swarm reads by its own membership again, as the previous release does.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { clock, guardedWrite, PartConflict } from '../parts/index.js'
import { swarmTransaction } from '../cache.js'
import { addMember, personalWorkspaceId } from '../workspaceStore.js'
import type { Person } from '../model.js'

type Transaction = Prisma.TransactionClient
const TRANSACTION = { maxWait: 5_000, timeout: 60_000 }

export interface WorkspaceMigrationReport {
  apply: boolean
  /** Swarms put (or, in a dry run, to be put) into a Workspace. */
  swarms: number
  workspacesCreated: number
  guestsAdded: number
  /** Swarms not in parts yet: left alone, they get their Workspace when they are opened and migrated, then rerun. */
  skipped: string[]
  failed: Array<{ tabId: string; error: string }>
  anomalies: {
    /** A Swarm whose owner is not among its people. */
    ownerMissing: string[]
    /** People in Swarms of several owners: a guest of each Workspace, which shows nothing new. */
    peopleInSeveralWorkspaces: Array<{ userId: string; workspaceCount: number }>
    /** Machines contributed to Swarms of two owners: afterwards their Harness Team account takes teammates' work in neither. */
    machinesInTwoWorkspaces: Array<{ machineId: string; tabIds: string[] }>
  }
}

interface Pending { id: string; autonomousEnv: string; ownerId: string; createdAt: Date; name: string; people: Person[]; headVersion: number;
  head: Prisma.JsonObject; headFields: { groupCounter: number; visibilityEpoch: number; sequenceBase: number } }

async function pendingSwarms(db: PrismaClient, report: WorkspaceMigrationReport): Promise<Pending[]> {
  const rows = (await db.superTab.findMany({ select: { id: true, autonomousEnv: true, ownerId: true, createdAt: true, format: true, workspaceId: true } }))
    .filter(r => !r.workspaceId)
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

/** Writes the Workspace on a Swarm's head (a guarded write, so a command in between wins and the Swarm is retried) and row. */
async function stampSwarm(tx: Transaction, tabId: string, seen: number, head: Prisma.JsonObject, headFields: Pending['headFields'], workspaceId: string | null) {
  const { workspaceId: _old, workspaceVisibility: _visibility, ...rest } = head
  await guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen, data: (workspaceId ? { ...rest, workspaceId } : rest) as never, head: headFields }, clock.next())
  const row = await tx.superTab.findUniqueOrThrow({ where: { id: tabId } })
  const updated = await tx.superTab.updateMany({ where: { id: tabId, revision: row.revision }, data: { revision: row.revision + 1, workspaceId } })
  if (!updated.count) throw new PartConflict('head', 'index')
}

export async function migrateWorkspaces(db: PrismaClient, opts: { apply: boolean }): Promise<WorkspaceMigrationReport> {
  const report: WorkspaceMigrationReport = { apply: opts.apply, swarms: 0, workspacesCreated: 0, guestsAdded: 0, skipped: [], failed: [],
    anomalies: { ownerMissing: [], peopleInSeveralWorkspaces: [], machinesInTwoWorkspaces: [] } }
  const pending = await pendingSwarms(db, report)
  const owners = new Map<string, Pending[]>()
  for (const swarm of pending.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = personalWorkspaceId(swarm.autonomousEnv, swarm.ownerId)
    owners.set(key, [...owners.get(key) ?? [], swarm])
  }

  // What the migration would make: each owner's Workspace, read against the Workspaces that already exist.
  const workspacesOf = new Map<string, Set<string>>()
  for (const [workspaceId, swarms] of owners) for (const p of swarms.flatMap(s => s.people)) workspacesOf.set(p.id, (workspacesOf.get(p.id) ?? new Set()).add(workspaceId))
  report.anomalies.peopleInSeveralWorkspaces = [...workspacesOf].filter(([, workspaces]) => workspaces.size > 1).map(([userId, workspaces]) => ({ userId, workspaceCount: workspaces.size }))
  report.anomalies.machinesInTwoWorkspaces = await machinesInTwoWorkspaces(db, owners)

  for (const [workspaceId, swarms] of owners) {
    const first = swarms[0]!
    const exists = !!await db.swarmWorkspace.findUnique({ where: { id: workspaceId } })
    if (!exists) report.workspacesCreated++
    const guests = new Map(swarms.flatMap(s => s.people).filter(p => p.id !== first.ownerId).map(p => [p.id, p]))
    for (const guest of guests.values()) {
      const current = await db.swarmWorkspaceMember.findUnique({ where: { id: `${workspaceId}:${guest.id}` } })
      if (!current || current.removedAt) report.guestsAdded++
    }
    report.swarms += swarms.length
    if (!opts.apply) continue
    try {
      await swarmTransaction(db, async tx => {
        if (!await tx.swarmWorkspace.findUnique({ where: { id: workspaceId } })) {
          await tx.swarmWorkspace.create({ data: { id: workspaceId, autonomousEnv: first.autonomousEnv, name: first.name || 'Workspace', ownerId: first.ownerId, deletedAt: null, purgeAt: null } })
        }
        const ownerEmail = first.people.find(p => p.id === first.ownerId)?.email
          ?? (await tx.user.findUnique({ where: { id: first.ownerId }, select: { email: true } }))?.email ?? ''
        await addMember(tx, workspaceId, { id: first.ownerId, email: ownerEmail }, 'owner', first.ownerId, `migration:${workspaceId}`)
        for (const guest of guests.values()) await addMember(tx, workspaceId, guest, 'guest', first.ownerId, `migration:${workspaceId}:${guest.id}`)
      }, TRANSACTION)
    } catch (error) {
      for (const swarm of swarms) report.failed.push({ tabId: swarm.id, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    for (const swarm of swarms) {
      try {
        await swarmTransaction(db, tx => stampSwarm(tx, swarm.id, swarm.headVersion, swarm.head, swarm.headFields, workspaceId), TRANSACTION)
      } catch (error) {
        report.failed.push({ tabId: swarm.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return report
}

/** Machines contributed to Swarms that will be in different Workspaces, with the Workspaces that exist already taken into account. */
async function machinesInTwoWorkspaces(db: PrismaClient, owners: Map<string, Pending[]>): Promise<WorkspaceMigrationReport['anomalies']['machinesInTwoWorkspaces']> {
  const pools = await db.swarmMachine.findMany({ where: { deleted: false, contributed: true }, select: { tabId: true, machineId: true } })
  const workspaceOf = new Map<string, string>()
  for (const [workspaceId, swarms] of owners) for (const swarm of swarms) workspaceOf.set(swarm.id, workspaceId)
  for (const row of pools.length ? await db.superTab.findMany({ where: { id: { in: pools.map(p => p.tabId) } }, select: { id: true, workspaceId: true } }) : []) {
    if (row.workspaceId) workspaceOf.set(row.id, row.workspaceId)
  }
  const byMachine = new Map<string, string[]>()
  for (const pool of pools) byMachine.set(pool.machineId, [...byMachine.get(pool.machineId) ?? [], pool.tabId])
  return [...byMachine].filter(([, tabIds]) => new Set(tabIds.map(t => workspaceOf.get(t)).filter(Boolean)).size > 1)
    .map(([machineId, tabIds]) => ({ machineId, tabIds: [...tabIds].sort() }))
}

export interface WorkspaceRollbackReport { apply: boolean; swarms: number; workspaces: number; failed: Array<{ tabId: string; error: string }> }

/** Takes every Workspace away (see the top of this file). A dry run only counts. */
export async function rollbackWorkspaces(db: PrismaClient, opts: { apply: boolean }): Promise<WorkspaceRollbackReport> {
  const rows = await db.superTab.findMany({ where: { workspaceId: { not: null } }, select: { id: true } })
  const report: WorkspaceRollbackReport = { apply: opts.apply, swarms: rows.length, workspaces: await db.swarmWorkspace.count(), failed: [] }
  if (!opts.apply) return report
  for (const row of rows) {
    try {
      await swarmTransaction(db, async tx => {
        const head = await tx.swarmHead.findUniqueOrThrow({ where: { id: `${row.id}:head` } })
        await stampSwarm(tx, row.id, head.version, head.data as Prisma.JsonObject,
          { groupCounter: head.groupCounter, visibilityEpoch: head.visibilityEpoch, sequenceBase: head.sequenceBase }, null)
      }, TRANSACTION)
    } catch (error) {
      report.failed.push({ tabId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // The Workspaces go only once no Swarm names one, so a failed Swarm keeps the Workspace it still points at; rerun to finish.
  if (!report.failed.length) {
    await db.swarmWorkspaceInvitation.deleteMany({})
    await db.swarmWorkspaceRemoval.deleteMany({})
    await db.swarmWorkspaceMember.deleteMany({})
    await db.swarmWorkspace.deleteMany({})
  }
  return report
}
