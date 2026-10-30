import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  desk: vi.fn(), zoo: vi.fn(), machines: vi.fn(), keys: vi.fn(), vault: vi.fn(),
  deskUnsub: vi.fn(), zooUnsub: vi.fn(), machinesUnsub: vi.fn(), keysUnsub: vi.fn(), vaultUnsub: vi.fn(),
  swarms: vi.fn(), swarmsUnsub: vi.fn(),
}))
vi.mock('./swarmClientPushes.js', () => ({ relaySwarmChanges: m.swarms }))
vi.mock('./bus.js', () => ({
  subscribeDeskChanged: m.desk, subscribeZooChanged: m.zoo, subscribeDeviceMachineListChanged: m.machines,
  subscribeDeviceKeysChanged: m.keys, subscribeConnectorsChanged: m.vault,
}))

import { relayAccountPushes } from './adapterAccountPushes.js'

/** The server's daemons switch on (lib/daemonsSwitch.ts); every test below but the last relies on it. */
const on = { zoo: true }

describe('account pushes on a daemon socket', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.desk.mockResolvedValue(m.deskUnsub)
    m.zoo.mockResolvedValue(m.zooUnsub)
    m.machines.mockResolvedValue(m.machinesUnsub)
    m.keys.mockResolvedValue(m.keysUnsub)
    m.vault.mockResolvedValue(m.vaultUnsub)
    m.swarms.mockResolvedValue(m.swarmsUnsub)
  })

  // WS roadmap Phase 2a: the windows read a Swarm when told (lib/swarmClientPushes.ts), through this daemon.
  it('hands the daemon a change to a Swarm the account is in, as a connection-less down frame', async () => {
    const send = vi.fn()
    const stop = await relayAccountPushes('user-1', send, on)
    expect(m.swarms).toHaveBeenCalledWith('user-1', expect.any(Function))
    m.swarms.mock.calls[0][1]({ type: 'swarm_changed', payload: { tabId: 'tab-1', lastChangedAt: 1, parts: ['main'] } })
    expect(send).toHaveBeenCalledWith({ t: 'down', connId: '', frame: { type: 'swarm_changed', payload: { tabId: 'tab-1', lastChangedAt: 1, parts: ['main'] } } })
    stop()
    expect(m.swarmsUnsub).toHaveBeenCalledOnce()
  })

  it('hands the daemon a change to the account\'s sealed connections, for it to re-read and merge', async () => {
    const send = vi.fn()
    const stop = await relayAccountPushes('user-1', send, on)
    expect(m.vault).toHaveBeenCalledWith('user-1', expect.any(Function))
    m.vault.mock.calls[0][1]({ revision: 9 })
    expect(send).toHaveBeenCalledWith({ t: 'down', connId: '', frame: { type: 'connectors_changed', payload: { revision: 9 } } })
    stop()
    expect(m.vaultUnsub).toHaveBeenCalledOnce()
  })

  // A team machine (lib/teamSession.ts) runs for teammates and reads none of the account's desk, zoo, machine list or
  // connections; it keeps only what it trusts its connections by, the device key log.
  it('gives a team machine only the device-key-log change', async () => {
    const send = vi.fn()
    const stop = await relayAccountPushes('user-1', send, { zoo: true, team: true })
    expect(m.keys).toHaveBeenCalledWith('user-1', expect.any(Function))
    for (const other of [m.desk, m.zoo, m.machines, m.vault, m.swarms]) expect(other).not.toHaveBeenCalled()
    m.keys.mock.calls[0][1]({ seq: 2, hash: 'h' })
    expect(send).toHaveBeenCalledWith({ t: 'down', connId: '', frame: { type: 'device_keys_changed', payload: { seq: 2, hash: 'h' } } })
    stop()
    expect(m.keysUnsub).toHaveBeenCalledOnce()
  })

  it('listens on the channels of the account that owns the socket', async () => {
    await relayAccountPushes('user-1', vi.fn(), on)
    expect(m.desk).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.zoo).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.machines).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.keys).toHaveBeenCalledWith('user-1', expect.any(Function))
  })

  it('hands the daemon a device-key-log change with the new head, for the daemon itself to re-read', async () => {
    const send = vi.fn()
    await relayAccountPushes('user-1', send, on)
    m.keys.mock.calls[0][1]({ seq: 4, hash: 'h' })
    expect(send).toHaveBeenCalledWith({ t: 'down', connId: '', frame: { type: 'device_keys_changed', payload: { seq: 4, hash: 'h' } } })
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
    expect(m.keysUnsub).toHaveBeenCalledOnce()
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
