import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { recordingDb, sendsEmptyIn, type Query } from '../lib/queryRecorder.test-support.js'
import { GrantReads, SuperTabStore } from './store.js'
import { HostReads } from './read/host.js'

describe('reads of machines, users and SuperTab with nothing to look up', () => {
  it('asks for no machine when the Swarm has no pending machine cleanup', async () => {
    const queries: Query[] = []
    const store = new SuperTabStore(recordingDb(queries) as PrismaClient)

    expect(await store['deletedMachines'](recordingDb(queries) as never, { machineCleanups: [], environment: 'prod' } as never)).toEqual([])
    expect(queries).toEqual([])
  })

  it('still asks which cleanup machines are alive when there are some', async () => {
    const queries: Query[] = []
    const tx = recordingDb(queries, { 'machine.findMany': [{ machineId: 'm1' }] })

    const gone = await new SuperTabStore(recordingDb([]) as PrismaClient)['deletedMachines'](tx as never,
      { machineCleanups: [{ machineId: 'm1' }, { machineId: 'm2' }], environment: 'prod' } as never)

    expect(gone).toEqual(['m2'])
    expect(queries).toHaveLength(1)
  })

  it('asks for no account when a Swarm lists no people for a host', async () => {
    const queries: Query[] = []
    const reads = new HostReads(new SuperTabStore(recordingDb([]) as PrismaClient))

    const lookups = await reads['lookups'](recordingDb(queries) as never, { id: 't1', people: [], agents: [], environment: 'prod' } as never, new GrantReads({} as never))

    expect(lookups.people).toEqual([])
    expect(queries.filter(q => q.model === 'user')).toEqual([])
    expect(queries.filter(sendsEmptyIn)).toEqual([])
  })

  it('asks for nothing when a host has no Swarm to look for changes in', async () => {
    const queries: Query[] = []
    const reads = new HostReads(new SuperTabStore(recordingDb([]) as PrismaClient))

    expect(await reads['woken'](recordingDb(queries) as never, [], 'host-1', 0)).toEqual(new Set())
    expect(queries).toEqual([])
  })
})
