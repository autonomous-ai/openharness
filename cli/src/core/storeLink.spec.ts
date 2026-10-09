import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { createStoreLink } from './storeLink.js'

describe('the Store in its own process, as the core hears it', () => {
  afterEach(() => vi.useRealTimers())

  it('refreshes the installed index before notifying held launches; readiness never waits', () => {
    const order: string[] = []
    const link = createStoreLink(fakeCore(), () => order.push('installed'))
    const off = link.onReady(() => order.push('ready'))
    link.answer('installed', {})
    expect(order).toEqual(['installed'])
    link.answer('prepared', {})
    expect(order).toEqual(['installed', 'installed', 'ready'])
    off()
    link.answer('prepared', {})
    expect(order).toEqual(['installed', 'installed', 'ready', 'installed'])
    expect(link).not.toHaveProperty('ready')
  })
  it('pushes an install\'s progress to the apps, and reads the installed index again when told it changed', () => {
    const core = fakeCore()
    const installed = vi.fn()
    const link = createStoreLink(core, installed)
    expect(link.answer('installStatus', { status: { id: 'acme/thing', phase: 'setup' } })).toEqual({ said: true })
    expect(core.clients.dshInstallStatus).toHaveBeenCalledWith({ id: 'acme/thing', phase: 'setup' })
    expect(link.answer('installed', {})).toEqual({ read: true })
    expect(installed).toHaveBeenCalledOnce()
  })

  it('pushes nothing that is not a status, and answers nothing else', () => {
    const core = fakeCore()
    const link = createStoreLink(core, vi.fn())
    for (const status of [undefined, 'clone', ['clone'], null]) expect(link.answer('installStatus', { status })).toEqual({ error: 'BAD_STATUS' })
    expect(core.clients.dshInstallStatus).not.toHaveBeenCalled()
    expect(link.answer('credentials', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })
})

describe('checked Store launch replies', () => {
  const request = { dsh: 'test/draw', workspace: '/workspace', engine: 'claude' as const, key: 'agent', account: {} }
  const materialized = { ok: true, created: [], kept: ['existing'], warnings: [] }
  const launched = { ok: true, launch: { env: { HARNESS_DSH: 'test/draw' }, args: ['--context'] } }
  it('round trips valid launches and refusals through the real link', async () => {
    const call = vi.fn().mockResolvedValueOnce(materialized).mockResolvedValueOnce(launched)
    const link = createStoreLink(fakeCore(), vi.fn(), call)
    expect(await link.port.dshMaterialize(request)).toEqual(materialized)
    expect(await link.port.dshLaunch(request)).toEqual(launched)
    expect(call.mock.calls).toEqual([['dshMaterialize', request], ['dshLaunch', request]])
    for (const refused of [
      { ok: false, error: 'DSH_NOT_INSTALLED', detail: 'missing' },
      { ok: false, error: 'DSH_UNAVAILABLE', detail: 'waiting', unavailable: 'store', holdScope: 'workspace', thrown: 'Error: waiting' },
    ]) {
      call.mockResolvedValue(refused)
      expect(await link.port.dshMaterialize(request)).toEqual(refused)
      expect(await link.port.dshLaunch(request)).toEqual(refused)
    }
  })
  it('a down Store or malformed answer cannot become an unprepared launch', async () => {
    const call = vi.fn()
    const link = createStoreLink(fakeCore(), vi.fn(), call)
    const common = [null, [], false, {}, { ok: false }, { ok: false, error: 1 },
      { ok: false, error: 'x', detail: 1 }, { ok: false, error: 'x', detail: 'x', unavailable: 'models' },
      { ok: false, error: 'x', detail: 'x', thrown: 1 }, { ok: false, error: 'x', detail: 'x', holdScope: 'process' }, { error: 'SERVICE_UNAVAILABLE' }]
    for (const bad of [...common, { ok: true }, { ...materialized, created: [1] }, { ...materialized, kept: null }, { ...materialized, warnings: [1] }]) {
      call.mockResolvedValue(bad)
      await expect(link.port.dshMaterialize(request)).rejects.toThrow('the store service is unavailable')
    }
    for (const bad of [...common, { ok: true }, { ok: true, launch: { env: [] } },
      { ok: true, launch: { env: { KEY: 3 }, args: [] } }, { ok: true, launch: { env: {}, args: [1] } }]) {
      call.mockResolvedValue(bad)
      await expect(link.port.dshLaunch(request)).rejects.toThrow('the store service is unavailable')
    }
    await expect(createStoreLink(fakeCore(), vi.fn()).port.dshLaunch(request)).rejects.toThrow('the store service is unavailable')
  })
})
