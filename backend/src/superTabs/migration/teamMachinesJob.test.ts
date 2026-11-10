import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { SuperTabState } from '../model.js'
import { deleteTeamMachineRows, PAGE, takeOutTeamMachinesOnce, teamMachineIds } from './teamMachinesJob.js'

type Stage = { $match?: Record<string, unknown> & { _id?: { $gt: string }; machineId?: { $gt: string } }; $limit?: number }
/** Swarms and Team account rows by id, as the job pages them: those after the cursor, in order, at most `$limit`. A row's
 *  update deletes it, so it is matched no more. */
function database(swarmIds: string[], teamRows: string[]) {
  const live = new Set(teamRows), updates: string[] = []
  const page = (ids: string[], after: string | undefined, limit: number) => ids.filter(id => !after || id > after).slice(0, limit)
  const db = {
    superTab: { aggregateRaw: async ({ pipeline }: { pipeline: Stage[] }) =>
      page(swarmIds, pipeline[0]!.$match!._id?.$gt, pipeline.find(s => s.$limit)!.$limit!).map(id => ({ _id: id })) },
    machine: {
      aggregateRaw: async ({ pipeline }: { pipeline: Stage[] }) =>
        page([...live].sort(), pipeline[0]!.$match!.machineId?.$gt, pipeline.find(s => s.$limit)!.$limit!).map(machineId => ({ machineId })),
      updateMany: async ({ where }: { where: { machineId: string } }) => {
        updates.push(where.machineId)
        return { count: live.delete(where.machineId) ? 1 : 0 }
      },
    },
  } as unknown as PrismaClient
  return { db, updates }
}

describe('what a Swarm still records of a Harness Team account\'s machine', () => {
  it('is a pool that names its Mac or was read from a Team session, or an agent that joined on one; each machine once', () => {
    const state = {
      machines: [{ machineId: 'mac' }, { machineId: 'mac-team', hostMachineId: 'mac' }, { machineId: 'box', observation: { sessionKind: 'team' } },
        { machineId: 'laptop', observation: { sessionKind: 'computer' } }],
      agents: [{ id: 'a', machineId: 'mac' }, { id: 'b', machineId: 'mac-team', teamAccount: true }, { id: 'c', machineId: 'gone', teamAccount: true }],
    } as unknown as SuperTabState
    expect(teamMachineIds(state)).toEqual(['mac-team', 'box', 'gone'])
    expect(teamMachineIds({ machines: [{ machineId: 'mac' }], agents: [] } as unknown as SuperTabState)).toEqual([])
  })
})

describe('the one-time pass that takes Harness Team accounts\' machines out', () => {
  it('deletes every Team account row a page at a time, then visits every Swarm once, counting what it took out and what failed', async () => {
    const swarms = Array.from({ length: PAGE + 2 }, (_, i) => `tab-${String(i).padStart(4, '0')}`)
    const rows = Array.from({ length: PAGE + 1 }, (_, i) => `team-${String(i).padStart(4, '0')}`)
    const { db, updates } = database(swarms, rows)
    const seen: string[] = []
    const store = { takeOutTeamMachines: async (id: string) => {
      seen.push(id)
      if (id === swarms[1]) throw new Error('busy')
      if (id === swarms[2]) return 'gone' as const
      return id === swarms[0] ? 2 : 0
    } }
    let pauses = 0
    expect(await takeOutTeamMachinesOnce(db, store, { pause: async () => { pauses++ } }))
      .toEqual({ swarms: PAGE + 1, machines: 2, rows: PAGE + 1, failed: 1 })
    expect(pauses).toBe(1)
    expect(seen).toEqual(swarms)
    expect(updates).toEqual(rows)
    // Again: nothing left, so the job stops.
    expect(await takeOutTeamMachinesOnce(db, { takeOutTeamMachines: async () => 0 })).toEqual({ swarms: PAGE + 2, machines: 0, rows: 0, failed: 0 })
  })

  it('counts only the rows it deleted itself, when another runner deleted them between its read and its update', async () => {
    const { db } = database([], ['team-a', 'team-b'])
    const raced = { ...db, machine: { ...db.machine, updateMany: async () => ({ count: 0 }) } } as unknown as PrismaClient
    expect(await deleteTeamMachineRows(raced)).toBe(0)
    expect(await deleteTeamMachineRows(db)).toBe(2)
  })

  it('stops at once when asked to', async () => {
    const control = new AbortController()
    const { db } = database(['a', 'b', 'c'], [])
    const seen: string[] = []
    await takeOutTeamMachinesOnce(db, { takeOutTeamMachines: async (id: string) => { seen.push(id); control.abort(); return 0 } }, { signal: control.signal })
    expect(seen).toEqual(['a'])
  })
})
