/**
 * Once, after the release that removed Harness Team accounts' machines from Swarms (anh Dee, 2026-11-10: "remove all team
 * accounts, clean up v1/2/3 entirely"). Their sign-ins went first (#3837): no Team daemon connects any more, so what a Swarm
 * still records of one is a machine nobody can host. This takes every such machine out of every Swarm, with its agents
 * (store.ts takeOutTeamMachines, the store-only machine.teamGone), and soft-deletes the account rows Team sessions served
 * (`Machine.sessionKind` `team`), a page at a time. It runs in the singleton worker; logs only counts; tries again an hour after
 * a pass that failed somewhere and stops once a pass changed nothing and failed nowhere. A worker that starts again walks once
 * more (one read per Swarm, no write when it holds no Team machine). Two runners do no harm: each Swarm is read again in its own
 * transaction, a machine already gone is no write, and a row already deleted is matched by neither. Goes, with the command, the
 * row filters in MachineService/DeviceService and adapterWs.ts's take-over, on or after 2026-12-10.
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import type { Agent, SuperTabState } from '../model.js'
import { SuperTabError } from '../model.js'
import type { ContributedMachine } from '../machines.js'
import type { SuperTabStore } from '../store.js'
import { sleeper, START_DELAY_MS } from './dropLegacyJob.js'

export const PAGE = 100
export const PAUSE_MS = 200
export const RETRY_MS = 3_600_000

/** What older releases stored of a Harness Team account's machine, which the types no longer name: a pool that names its Mac
 *  (`hostMachineId`) or was last read from a Team session (`observation.sessionKind`), and an agent that joined on one
 *  (`teamAccount`). */
type StoredPool = ContributedMachine & { hostMachineId?: string; observation?: { sessionKind?: string } }
type StoredAgent = Agent & { teamAccount?: true }

/** The machines [state] still records as a Harness Team account's, each once. */
export function teamMachineIds(state: Pick<SuperTabState, 'machines' | 'agents'>): string[] {
  const pools = (state.machines ?? []) as StoredPool[]
  return [...new Set([...pools.filter(p => !!p.hostMachineId || p.observation?.sessionKind === 'team').map(p => p.machineId),
    ...(state.agents as StoredAgent[]).filter(a => a.teamAccount).map(a => a.machineId)])]
}

export interface TeamMachinesPass { swarms: number; machines: number; rows: number; failed: number }

/** Soft-deletes the account rows Team sessions served, a page at a time, in machine id order (its unique index; `sessionKind`
 *  has none, and a few Team rows are worth no index for a job that runs once); how many. A raw match: Prisma's `deletedAt:
 *  null` misses a row that never had the field. */
export async function deleteTeamMachineRows(db: PrismaClient, now: () => Date = () => new Date(), signal?: AbortSignal): Promise<number> {
  let deleted = 0, after: string | undefined
  while (!signal?.aborted) {
    const rows = await db.machine.aggregateRaw({ pipeline: [
      { $match: { sessionKind: 'team', $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }], ...after ? { machineId: { $gt: after } } : {} } },
      { $sort: { machineId: 1 } }, { $limit: PAGE }, { $project: { _id: 0, machineId: 1 } }] }) as unknown as Array<{ machineId: string }>
    // One update per row: an `in` would reach Mongo as $expr. Only a row still a Team session's and still live.
    for (const { machineId } of rows) {
      deleted += (await db.machine.updateMany({ where: { machineId, sessionKind: 'team', OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
        data: { deletedAt: now() } })).count
    }
    if (rows.length < PAGE) break
    after = rows.at(-1)!.machineId
  }
  return deleted
}

/** One pass: the account rows, then every live Swarm in parts, in id order. */
export async function takeOutTeamMachinesOnce(db: PrismaClient, store: Pick<SuperTabStore, 'takeOutTeamMachines'>,
  { pause = async () => {}, signal }: { pause?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<TeamMachinesPass> {
  const pass: TeamMachinesPass = { swarms: 0, machines: 0, rows: await deleteTeamMachineRows(db, undefined, signal), failed: 0 }
  let after: string | undefined
  while (!signal?.aborted) {
    const rows = await db.superTab.aggregateRaw({ pipeline: [{ $match: { format: 2, deletedAt: null, ...after ? { _id: { $gt: after } } : {} } },
      { $sort: { _id: 1 } }, { $limit: PAGE }, { $project: { _id: 1 } }] }) as unknown as Array<{ _id: string }>
    for (const { _id: id } of rows) {
      if (signal?.aborted) break
      try {
        const taken = await store.takeOutTeamMachines(id)
        pass.swarms++
        if (typeof taken === 'number' && taken > 0) {
          pass.machines += taken
          await pause()
        }
      } catch (error) {
        pass.failed++
        logger.warn('[team-machines] a Swarm kept its Team machines', { tabId: id, code: error instanceof SuperTabError ? error.code : 'unknown' })
      }
    }
    if (rows.length < PAGE) break
    after = rows.at(-1)!._id
  }
  return pass
}

/** Starts the pass in the background, again each hour until one changed nothing and failed nowhere; the returned function stops it. */
export function startTeamMachines(db: PrismaClient, store: Pick<SuperTabStore, 'takeOutTeamMachines'>, delayMs = START_DELAY_MS): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void (async () => {
    await wait(delayMs)
    while (!control.signal.aborted) {
      try {
        const pass = await takeOutTeamMachinesOnce(db, store, { pause: () => wait(PAUSE_MS), signal: control.signal })
        if (pass.failed) logger.error('[team-machines] pass: some Swarms still hold Team machines nobody can host; it tries again in an hour', { ...pass })
        else logger.info('[team-machines] pass', { ...pass })
        if (!pass.machines && !pass.rows && !pass.failed) return
      } catch (error) {
        logger.error('[team-machines] failed: Team machines stay in Swarms until the next try, in an hour', { error: error instanceof Error ? error.name : 'unknown' })
      }
      await wait(RETRY_MS)
    }
  })()
  return () => control.abort()
}
