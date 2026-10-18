import { describe, expect, it, vi } from 'vitest'
import { answerSharedMachinesQuery } from './sharedMachinesQueries.js'

describe('what the shared-machines service may ask of the core', () => {
  const account = {
    backend: vi.fn(async (method: string, path: string) => ({ status: 200, body: { method, path } })),
    machineId: () => 'ab'.repeat(16),
    trust: vi.fn(async () => ({ pins: 0, keys: 0 })),
  }

  it('answers shared_machines for the shared-machines service alone', async () => {
    expect(await answerSharedMachinesQuery(account, 'sharedMachines', 'shared_machines', { op: 'shared' }))
      .toEqual({ status: 200, body: { method: 'GET', path: '/api/machine-shares' } })
    expect(await answerSharedMachinesQuery(account, 'connectors', 'shared_machines', { op: 'shared' })).toBeNull()
    expect(await answerSharedMachinesQuery(account, 'sharedMachines', 'backend', { op: 'shared' })).toBeNull()
  })
})
