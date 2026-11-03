import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  desk: vi.fn(), zoo: vi.fn(), machines: vi.fn(), keys: vi.fn(), vault: vi.fn(),
  deskUnsub: vi.fn(), zooUnsub: vi.fn(), machinesUnsub: vi.fn(), keysUnsub: vi.fn(), vaultUnsub: vi.fn(),
  swarms: vi.fn(), swarmsUnsub: vi.fn(), tui: vi.fn(), tuiUnsub: vi.fn(), tuiOpenNow: vi.fn(),
}))
vi.mock('./swarmClientPushes.js', () => ({ relaySwarmChanges: m.swarms }))
vi.mock('./bus.js', () => ({
  subscribeDeskChanged: m.desk, subscribeZooChanged: m.zoo, subscribeDeviceMachineListChanged: m.machines,
  subscribeDeviceKeysChanged: m.keys, subscribeConnectorsChanged: m.vault, subscribeTuiOpen: m.tui, tuiOpenNow: m.tuiOpenNow,
  TUI_OPEN_FOR_MS: 180_000,
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
    m.tui.mockResolvedValue(m.tuiUnsub)
    m.tuiOpenNow.mockResolvedValue(false)
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
    send.mockClear()  // the attach word about terminal apps (change 5)
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

  // Change 5 of docs/plans/2026-10-31-live-events-relay-design.md: events only the terminal app reads are held back while
  // the account has none open; the daemon learns it here.
  const tuiOpen = (forMs: number) => ({ t: 'down', connId: '', frame: { type: '__tui_open', payload: { forMs } } })
  it('tells the daemon at attach whether a terminal app of the account is open, and when one is', async () => {
    m.tuiOpenNow.mockResolvedValue(true)
    let heard: () => void = () => {}
    m.tui.mockImplementation(async (_user: string, cb: () => void) => { heard = cb; return m.tuiUnsub })
    const send = vi.fn()
    const stop = await relayAccountPushes('kim', send, on)
    expect(m.tui).toHaveBeenCalledWith('kim', expect.any(Function))
    expect(send).toHaveBeenCalledWith(tuiOpen(180_000))
    send.mockClear(); heard()
    expect(send).toHaveBeenCalledWith(tuiOpen(180_000))
    stop()
    expect(m.tuiUnsub).toHaveBeenCalled()
  })
  it('says none is open at attach, so the daemon starts holding events back', async () => {
    const send = vi.fn()
    await relayAccountPushes('kim', send, on)
    expect(send).toHaveBeenCalledWith(tuiOpen(0))
  })
  it('says nothing at attach when it cannot read whether one is open, so the daemon relays everything', async () => {
    m.tuiOpenNow.mockResolvedValue(null)
    const send = vi.fn()
    await relayAccountPushes('kim', send, on)
    expect(send.mock.calls.some(([f]) => (f as { frame: { type: string } }).frame.type === '__tui_open')).toBe(false)
  })
  it('tells a team machine nothing about terminal apps', async () => {
    const send = vi.fn()
    await relayAccountPushes('kim', send, { ...on, team: true })
    expect(m.tui).not.toHaveBeenCalled()
    expect(send.mock.calls.some(([f]) => (f as { frame: { type: string } }).frame.type === '__tui_open')).toBe(false)
  })
})
