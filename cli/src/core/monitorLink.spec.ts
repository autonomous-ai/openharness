import { describe, expect, it, vi } from 'vitest'
import { createMonitorLink } from './monitorLink.js'
import { ServiceUnavailableError } from './serviceHost.js'

describe('the monitor in its own process, as the core reaches it', () => {
  it('asks it for the readings the list adds, and answers its sample', async () => {
    const snapshot = { agents: [{ agentId: 'a1', memoryBytes: 1 }], sampledAt: '2026-10-06T00:00:00.000Z', shared: [] }
    const call = vi.fn(async () => ({ snapshot }))
    await expect(createMonitorLink(call).resources()).resolves.toEqual(snapshot)
    expect(call).toHaveBeenCalledWith('resources', {})
  })

  it('reads a monitor that is down, slow or failing as no sample: the list\'s rows without readings', async () => {
    for (const answer of [{ error: 'SERVICE_UNAVAILABLE', service: 'monitor', retryable: true }, { error: 'SERVICE_FAILED', service: 'monitor' }, { snapshot: 'not one' }]) {
      await expect(createMonitorLink(async () => answer).resources()).rejects.toBeInstanceOf(ServiceUnavailableError)
    }
  })

  it('asks what each agent\'s workspace and transcript hold, and to forget it after a purge', async () => {
    const call = vi.fn(async (_type: string, payload: Record<string, unknown>) => (payload.invalidate ? {} : { entries: [['a1', { workspaceBytes: 7 }]] }))
    const link = createMonitorLink(call)
    const agents = [{ agentId: 'a1', cwd: '/work/a1' }]
    expect(await link.storage(agents)).toEqual(new Map([['a1', { workspaceBytes: 7 }]]))
    expect(call).toHaveBeenLastCalledWith('storage', { agents, invalidate: false })
    // Nothing back (forgetting, or a monitor that is down): nothing measured.
    expect(await link.storage([], true)).toEqual(new Map())
    expect(call).toHaveBeenLastCalledWith('storage', { agents: [], invalidate: true })
  })
})
