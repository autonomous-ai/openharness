import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ desk: vi.fn(), zoo: vi.fn(), keys: vi.fn(), deskUnsub: vi.fn(), zooUnsub: vi.fn(), keysUnsub: vi.fn(),
  swarms: vi.fn(), swarmsUnsub: vi.fn() }))
vi.mock('./bus.js', () => ({ subscribeDeskChanged: m.desk, subscribeZooChanged: m.zoo, subscribeDeviceKeysChanged: m.keys }))
vi.mock('./swarmClientPushes.js', () => ({ relaySwarmChanges: m.swarms }))

import { relayWebDocumentPushes } from './webAccountPushes.js'

/** The server's daemons switch on (lib/daemonsSwitch.ts); every test below but the last relies on it. */
const on = { zoo: true }

describe('account documents on a web or phone socket', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.desk.mockResolvedValue(m.deskUnsub)
    m.zoo.mockResolvedValue(m.zooUnsub)
    m.keys.mockResolvedValue(m.keysUnsub)
    m.swarms.mockResolvedValue(m.swarmsUnsub)
  })

  // WS roadmap Phase 2a: the browser and the phone read a Swarm when told (lib/swarmClientPushes.ts).
  it('hands the client a change to a Swarm the account is in, as a plain frame, and stops with the socket', async () => {
    const send = vi.fn()
    const stop = await relayWebDocumentPushes('user-1', send, on)
    expect(m.swarms).toHaveBeenCalledWith('user-1', expect.any(Function))
    m.swarms.mock.calls[0][1]({ type: 'swarm_changed', payload: { tabId: 'tab-1', lastChangedAt: 1, parts: ['main'] } })
    expect(send).toHaveBeenCalledWith({ type: 'swarm_changed', payload: { tabId: 'tab-1', lastChangedAt: 1, parts: ['main'] } })
    stop()
    expect(m.swarmsUnsub).toHaveBeenCalledOnce()
  })

  it('listens on the desk, zoo and device key channels of the account that owns the socket', async () => {
    await relayWebDocumentPushes('user-1', vi.fn(), on)
    expect(m.desk).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.zoo).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.keys).toHaveBeenCalledWith('user-1', expect.any(Function))
  })

  it('hands the client each change as its own plain frame carrying the revision', async () => {
    const send = vi.fn()
    await relayWebDocumentPushes('user-1', send, on)
    m.desk.mock.calls[0][1]({ revision: 7 })
    m.zoo.mock.calls[0][1]({ revision: 3 })
    m.keys.mock.calls[0][1]({ seq: 4, hash: 'h' })
    expect(send.mock.calls).toEqual([
      [{ type: 'desk_changed', payload: { revision: 7 } }],
      [{ type: 'zoo_changed', payload: { revision: 3 } }],
      [{ type: 'device_keys_changed', payload: { seq: 4, hash: 'h' } }],
    ])
  })

  it('stops listening on all of them when the socket goes away', async () => {
    const stop = await relayWebDocumentPushes('user-1', vi.fn(), on)
    stop()
    stop()
    expect(m.deskUnsub).toHaveBeenCalledOnce()
    expect(m.zooUnsub).toHaveBeenCalledOnce()
    expect(m.keysUnsub).toHaveBeenCalledOnce()
  })

  it('does not leave the desk subscription behind when the zoo subscribe fails', async () => {
    m.zoo.mockRejectedValue(new Error('redis unreachable'))
    await expect(relayWebDocumentPushes('user-1', vi.fn(), on)).rejects.toThrow('redis unreachable')
    expect(m.deskUnsub).toHaveBeenCalledOnce()
  })

  it('leaves the zoo out while the server has daemons off', async () => {
    const send = vi.fn()
    const stop = await relayWebDocumentPushes('user-1', send, { zoo: false })
    expect(m.zoo).not.toHaveBeenCalled()
    m.desk.mock.calls[0][1]({ revision: 7 })
    expect(send.mock.calls).toEqual([[{ type: 'desk_changed', payload: { revision: 7 } }]])
    stop()
    expect(m.deskUnsub).toHaveBeenCalledOnce()
  })
})
