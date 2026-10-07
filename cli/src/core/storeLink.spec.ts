import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { createStoreLink } from './storeLink.js'

describe('the Store in its own process, as the core hears it', () => {
  afterEach(() => vi.useRealTimers())

  it('waits for preparation, refreshes the index first and remembers it for restore', async () => {
    vi.useFakeTimers()
    const installed = vi.fn()
    const link = createStoreLink(fakeCore(), installed)
    const first = link.ready()
    const second = link.ready()
    expect(link.answer('prepared', {})).toEqual({ read: true })
    expect(installed).toHaveBeenCalledOnce()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(await link.ready()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets ordinary agents restore when the Store is unavailable, and accepts a late preparation', async () => {
    vi.useFakeTimers()
    const link = createStoreLink(fakeCore(), vi.fn())
    const waiting = link.ready(50)
    link.answer('installed', {})
    await vi.advanceTimersByTimeAsync(50)
    expect(await waiting).toBe(false)
    link.answer('prepared', {})
    expect(await link.ready()).toBe(true)
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
