import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  desk: vi.fn(), machines: vi.fn(),
  deskUnsub: vi.fn(), machinesUnsub: vi.fn(),
}))
vi.mock('./bus.js', () => ({ subscribeDeskChanged: m.desk, subscribeDeviceMachineListChanged: m.machines }))

import { relayAccountPushes } from './adapterAccountPushes.js'

describe('account pushes on a daemon socket', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.desk.mockResolvedValue(m.deskUnsub)
    m.machines.mockResolvedValue(m.machinesUnsub)
  })

  it('listens on the channels of the account that owns the socket', async () => {
    await relayAccountPushes('user-1', vi.fn())
    expect(m.desk).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.machines).toHaveBeenCalledWith('user-1', expect.any(Function))
  })

  it('hands the daemon a desk change as a connection-less down frame carrying the revision', async () => {
    const send = vi.fn()
    await relayAccountPushes('user-1', send)
    m.desk.mock.calls[0][1]({ revision: 7 })
    expect(send).toHaveBeenCalledWith({ t: 'down', connId: '', frame: { type: 'desk_changed', payload: { revision: 7 } } })
  })

  it('hands the daemon a machine-list change, so the app re-reads instead of polling', async () => {
    const send = vi.fn()
    await relayAccountPushes('user-1', send)
    m.machines.mock.calls[0][1]({ reason: 'renamed' })
    expect(send).toHaveBeenCalledWith({ t: 'down', connId: '', frame: { type: 'machines_changed', payload: { reason: 'renamed' } } })
  })

  it('stops listening on both channels when the socket goes away', async () => {
    const stop = await relayAccountPushes('user-1', vi.fn())
    stop()
    expect(m.deskUnsub).toHaveBeenCalledOnce()
    expect(m.machinesUnsub).toHaveBeenCalledOnce()
  })

  it('does not leave the desk subscription behind when the second subscribe fails', async () => {
    m.machines.mockRejectedValue(new Error('redis unreachable'))
    await expect(relayAccountPushes('user-1', vi.fn())).rejects.toThrow('redis unreachable')
    expect(m.deskUnsub).toHaveBeenCalledOnce()
  })
})
