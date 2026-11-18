import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { createStoreLink } from './storeLink.js'
import { dshThrough } from './agents/dshThrough.js'

describe('the Store in its own process, as the core hears it', () => {
  afterEach(() => vi.useRealTimers())

  it('notifies held launches without keeping an installed index; readiness never waits', () => {
    const order: string[] = []
    const link = createStoreLink(fakeCore())
    const off = link.onReady(() => order.push('ready'))
    link.answer('installed', {})
    expect(order).toEqual([])
    link.answer('prepared', {})
    expect(order).toEqual(['ready'])
    off()
    link.answer('prepared', {})
    expect(order).toEqual(['ready'])
    expect(link).not.toHaveProperty('ready')
  })
  it('pushes an install\'s progress and acknowledges the legacy installed notice', () => {
    const core = fakeCore()
    const link = createStoreLink(core)
    expect(link.answer('installStatus', { status: { id: 'acme/thing', phase: 'setup' } })).toEqual({ said: true })
    expect(core.clients.dshInstallStatus).toHaveBeenCalledWith({ id: 'acme/thing', phase: 'setup' })
    expect(link.answer('installed', {})).toEqual({ read: true })
  })

  it('pushes nothing that is not a status, and answers nothing else', () => {
    const core = fakeCore()
    const link = createStoreLink(core)
    for (const status of [undefined, 'clone', ['clone'], null]) expect(link.answer('installStatus', { status })).toEqual({ error: 'BAD_STATUS' })
    expect(core.clients.dshInstallStatus).not.toHaveBeenCalled()
    expect(link.answer('credentials', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })
})

describe('checked Store launch replies', () => {
  const request = { dsh: 'test/draw', workspace: '/workspace', engine: 'claude' as const, key: 'agent', account: {} }
  const materialized = { ok: true, created: [], kept: ['existing'], warnings: [] }
  const launched = { ok: true, launch: { env: { HARNESS_DSH: 'test/draw' }, args: ['--context'] } }
  it('detaches bounded account context and refuses malformed or missing context', async () => {
    const source = { privateGrid: 'private', extra: 'discarded' }
    const call = vi.fn(async () => ({ ok: true, account: source }))
    const link = createStoreLink(fakeCore(), call)
    link.port.stop()
    const through = dshThrough({ store: () => link.port, nameOf: () => 'Draw', account: () => ({}) })
    const context = await through.context(request)
    source.privateGrid = 'changed'
    expect(context).toEqual({ ok: true, account: { privateGrid: 'private' } })
    expect(call).toHaveBeenCalledWith('dshContext', request)
    for (const account of [{}, { privateGrid: null }, { privateGrid: '' }, { privateGrid: 'x'.repeat(4096) }]) {
      call.mockResolvedValueOnce({ ok: true, account } as never)
      expect(await through.context(request)).toEqual({ ok: true, account })
    }
    for (const bad of [null, [], {}, { ok: true }, { ok: true, account: [] },
      { ok: true, account: { privateGrid: 1 } }, { ok: true, account: { privateGrid: 'é'.repeat(2049) } },
      { ok: true, account: { privateGrid: 'x\0y' } }]) {
      call.mockResolvedValueOnce(bad as never)
      expect(await through.context(request)).toMatchObject({ ok: false, unavailable: 'store' })
    }
    const refused = { ok: false, error: 'DSH_NOT_INSTALLED', detail: 'gone' }
    call.mockResolvedValueOnce(refused as never)
    expect(await through.context(request)).toEqual(refused)
    const inline = dshThrough({ store: () => ({ ...link.port, dshContext: async () => ({}) as never }), nameOf: () => 'Draw', account: () => ({}) })
    expect(await inline.context(request)).toMatchObject({ ok: false, unavailable: 'store' })
  })
  it('reads bounded package facts across the link and drops manifest data', async () => {
    const facts = { ok: true, id: 'test/draw', name: 'Draw', permissionMode: null, refusal: null }
    const call = vi.fn(async () => ({ ...facts, manifest: { secret: 'not retained' } }))
    const link = createStoreLink(fakeCore(), call)
    expect(await link.port.dshDescribe(request)).toEqual(facts)
    expect(call).toHaveBeenCalledWith('dshDescribe', request)
    for (const change of [{ permissionMode: 'auto', refusal: 'Not compatible' }, { name: 'x'.repeat(4096) }]) {
      call.mockResolvedValueOnce({ ...facts, ...change } as never)
      expect(await link.port.dshDescribe(request)).toEqual({ ...facts, ...change })
    }
    const refused = { ok: false, error: 'INVALID_DSH', detail: 'missing' }
    call.mockResolvedValueOnce(refused as never)
    expect(await link.port.dshDescribe(request)).toEqual(refused)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of [null, [], {}, { error: 'UNKNOWN_QUERY' }, ...[
      { id: 1 }, { id: 'invalid' }, { name: '' }, { name: 'x'.repeat(4097) }, { name: 'é'.repeat(2049) },
      { permissionMode: false }, { refusal: [] }, { name: 'a\0b' },
    ].map(over => ({ ...facts, ...over }))]) {
      call.mockResolvedValueOnce(bad as never)
      await expect(link.port.dshDescribe(request)).rejects.toThrow('the store service is unavailable')
    }
  })
  it('round trips valid launches and refusals through the real link', async () => {
    const call = vi.fn().mockResolvedValueOnce(materialized).mockResolvedValueOnce(launched)
    const link = createStoreLink(fakeCore(), call)
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
    const link = createStoreLink(fakeCore(), call)
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
      expect(await dshThrough({ store: () => link.port, nameOf: () => undefined, account: () => ({}) }).launch(request))
        .toMatchObject({ ok: false, error: 'DSH_UNAVAILABLE' })
    }
    expect(await dshThrough({ store: () => createStoreLink(fakeCore()).port, nameOf: () => undefined, account: () => ({}) }).launch(request))
      .toMatchObject({ ok: false, error: 'DSH_UNAVAILABLE' })
  })
})
