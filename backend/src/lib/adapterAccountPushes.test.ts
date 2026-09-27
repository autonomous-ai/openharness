import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  desk: vi.fn(), zoo: vi.fn(), machines: vi.fn(),
  deskUnsub: vi.fn(), zooUnsub: vi.fn(), machinesUnsub: vi.fn(),
}))
vi.mock('./bus.js', () => ({ subscribeDeskChanged: m.desk, subscribeZooChanged: m.zoo, subscribeDeviceMachineListChanged: m.machines }))

import { relayAccountPushes } from './adapterAccountPushes.js'

/** The server's daemons switch on (lib/daemonsSwitch.ts); every test below but the last relies on it. */
const on = { zoo: true }

describe('account pushes on a daemon socket', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.desk.mockResolvedValue(m.deskUnsub)
    m.zoo.mockResolvedValue(m.zooUnsub)
    m.machines.mockResolvedValue(m.machinesUnsub)
  })

  it('listens on the channels of the account that owns the socket', async () => {
    await relayAccountPushes('user-1', vi.fn(), on)
    expect(m.desk).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.zoo).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.machines).toHaveBeenCalledWith('user-1', expect.any(Function))
  })

  it('hands the daemon a desk change as a connection-less down frame carrying the revision', async () => {
    const send = vi.fn()
    await relayAccountPushes('user-1', send, on)
    m.desk.mock.calls[0][1]({ revision: 7 })
    expect(send).toHaveBeenCalledWith({ t: 'down', connId: '', frame: { type: 'desk_changed', payload: { revision: 7 } } })
  })

  it('hands the daemon a zoo change the same way, as its own frame', async () => {
    const send = vi.fn()
    await relayAccountPushes('user-1', send, on)
    m.zoo.mock.calls[0][1]({ revision: 3 })
    expect(send).toHaveBeenCalledWith({ t: 'down', connId: '', frame: { type: 'zoo_changed', payload: { revision: 3 } } })
    expect(send).toHaveBeenCalledOnce()
  })

  it('hands the daemon a machine-list change, so the app re-reads instead of polling', async () => {
    const send = vi.fn()
    await relayAccountPushes('user-1', send, on)
    m.machines.mock.calls[0][1]({ reason: 'renamed' })
    expect(send).toHaveBeenCalledWith({ t: 'down', connId: '', frame: { type: 'machines_changed', payload: { reason: 'renamed' } } })
  })

  it('stops listening on every channel when the socket goes away', async () => {
    const stop = await relayAccountPushes('user-1', vi.fn(), on)
    stop()
    expect(m.deskUnsub).toHaveBeenCalledOnce()
    expect(m.zooUnsub).toHaveBeenCalledOnce()
    expect(m.machinesUnsub).toHaveBeenCalledOnce()
  })

  it('does not leave the earlier subscriptions behind when a later subscribe fails', async () => {
    m.machines.mockRejectedValue(new Error('redis unreachable'))
    await expect(relayAccountPushes('user-1', vi.fn(), on)).rejects.toThrow('redis unreachable')
    expect(m.deskUnsub).toHaveBeenCalledOnce()
    expect(m.zooUnsub).toHaveBeenCalledOnce()
  })

  it('never listens on the zoo channel while the server has daemons off', async () => {
    const send = vi.fn()
    const stop = await relayAccountPushes('user-1', send, { zoo: false })
    expect(m.zoo).not.toHaveBeenCalled()
    expect(m.desk).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.machines).toHaveBeenCalledWith('user-1', expect.any(Function))
    stop()
    expect(m.deskUnsub).toHaveBeenCalledOnce()
    expect(m.zooUnsub).not.toHaveBeenCalled()
  })
})
