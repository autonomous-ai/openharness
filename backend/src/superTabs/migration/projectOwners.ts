/**
 * Gives every project from before ownerGeneration its owner's membership, and passes on each project whose owner already
 * left (task #3073, projects.ts settleOwners). Never run by the server: scripts/swarm-project-owners/migrate.ts runs it, a
 * dry run unless `--apply`, right after the backend that knows ownerGeneration is deployed. Until then such a project's owner
 * matches by id, as before; member.remove and invite.accept settle a Swarm's projects themselves.
 *
 * Rollback: the backend before it ignores ownerGeneration. A handover is not undone: undoing it gives a project back to an
 * owner who left. The report lists each one (Swarm, project, old and new owner id) as its record. A second run finds
 * nothing to do; a Swarm that failed (a command changed it meanwhile) is listed and taken again by the next run.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { clock, guardedWrite, loadAll, reassemble } from '../parts/index.js'
import { swarmTransaction } from '../cache.js'
import type { SuperTabState } from '../model.js'
import { settleOwners, type SwarmProject } from '../projects.js'

type Transaction = Prisma.TransactionClient
const TRANSACTION = { maxWait: 5_000, timeout: 60_000 }

export interface ProjectOwnersReport {
  apply: boolean
  swarms: number
  /** Projects whose owner, still in the Swarm, got their membership. */
  filled: number
  /** Projects that passed on: to a member's or the Swarm owner's id, or '' when nobody owns them now. Ids only, never names. */
  handovers: Array<{ tabId: string; projectId: string; from: string; to: string }>
  skipped: string[]
  failed: Array<{ tabId: string; error: string }>
}

/** What settling [state]'s projects would change, on a copy: [state] is left as it was. A Swarm from before projects has
 *  one, the Swarm owner's, who never leaves: nothing to do. */
export function ownersPlan(state: SuperTabState): { projects: SwarmProject[]; filled: number; handovers: Array<{ projectId: string; from: string; to: string }>; changed: boolean } {
  if (!state.projects) return { projects: [], filled: 0, handovers: [], changed: false }
  const copy = structuredClone(state)
  const unfilled = new Set(copy.projects!.filter(p => p.ownerGeneration === undefined).map(p => p.id))
  const handovers = settleOwners(copy)
  const moved = new Set(handovers.map(h => h.projectId))
  const filled = copy.projects!.filter(p => unfilled.has(p.id) && !moved.has(p.id) && p.ownerGeneration !== undefined).length
  return { projects: copy.projects!, filled, handovers, changed: filled > 0 || handovers.length > 0 }
}

/** Settles one Swarm's projects in [tx], writing its head guarded by the version it read: a command in between wins, and the
 *  Swarm is failed and retried on the next run. A handover moves the visibility epoch, so every reader reloads once. */
async function settleSwarm(tx: Transaction, tabId: string, apply: boolean) {
  const parts = await loadAll(tx, tabId)
  const plan = ownersPlan(reassemble(parts) as SuperTabState)
  if (apply && plan.changed) {
    const projects = plan.projects.map(({ progress: _progress, ...project }) => project)
    await guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen: parts.head.version, data: { ...parts.head.data!, projects },
      head: { groupCounter: parts.groupCounter, visibilityEpoch: parts.visibilityEpoch + (plan.handovers.length ? 1 : 0), sequenceBase: parts.sequenceBase } },
    clock.next())
  }
  return plan
}

export async function migrateProjectOwners(db: PrismaClient, opts: { apply: boolean }): Promise<ProjectOwnersReport> {
  const report: ProjectOwnersReport = { apply: opts.apply, swarms: 0, filled: 0, handovers: [], skipped: [], failed: [] }
  const rows = await db.superTab.findMany({ select: { id: true, format: true }, orderBy: { id: 'asc' } })
  for (const row of rows) {
    if (row.format !== 2) { report.skipped.push(row.id); continue }
    report.swarms++
    try {
      const plan = opts.apply
        ? await swarmTransaction(db, tx => settleSwarm(tx, row.id, true), TRANSACTION)
        : await settleSwarm(db as unknown as Transaction, row.id, false)
      report.filled += plan.filled
      report.handovers.push(...plan.handovers.map(h => ({ tabId: row.id, ...h })))
    } catch (error) {
      report.failed.push({ tabId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}
