import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ desk: vi.fn(), zoo: vi.fn(), deskUnsub: vi.fn(), zooUnsub: vi.fn() }))
vi.mock('./bus.js', () => ({ subscribeDeskChanged: m.desk, subscribeZooChanged: m.zoo }))

import { relayWebDocumentPushes } from './webAccountPushes.js'

/** The server's daemons switch on (lib/daemonsSwitch.ts); every test below but the last relies on it. */
const on = { zoo: true }

describe('account documents on a web or phone socket', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.desk.mockResolvedValue(m.deskUnsub)
    m.zoo.mockResolvedValue(m.zooUnsub)
  })

  it('listens on the desk and zoo channels of the account that owns the socket', async () => {
    await relayWebDocumentPushes('user-1', vi.fn(), on)
    expect(m.desk).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(m.zoo).toHaveBeenCalledWith('user-1', expect.any(Function))
  })

  it('hands the client each change as its own plain frame carrying the revision', async () => {
    const send = vi.fn()
    await relayWebDocumentPushes('user-1', send, on)
    m.desk.mock.calls[0][1]({ revision: 7 })
    m.zoo.mock.calls[0][1]({ revision: 3 })
    expect(send.mock.calls).toEqual([
      [{ type: 'desk_changed', payload: { revision: 7 } }],
      [{ type: 'zoo_changed', payload: { revision: 3 } }],
    ])
  })

  it('stops listening on both when the socket goes away', async () => {
    const stop = await relayWebDocumentPushes('user-1', vi.fn(), on)
    stop()
    stop()
    expect(m.deskUnsub).toHaveBeenCalledOnce()
    expect(m.zooUnsub).toHaveBeenCalledOnce()
  })

  it('does not leave the desk subscription behind when the zoo subscribe fails', async () => {
    m.zoo.mockRejectedValue(new Error('redis unreachable'))
    await expect(relayWebDocumentPushes('user-1', vi.fn(), on)).rejects.toThrow('redis unreachable')
    expect(m.deskUnsub).toHaveBeenCalledOnce()
  })

  it('listens on the desk alone while the server has daemons off', async () => {
    const send = vi.fn()
    const stop = await relayWebDocumentPushes('user-1', send, { zoo: false })
    expect(m.zoo).not.toHaveBeenCalled()
    m.desk.mock.calls[0][1]({ revision: 7 })
    expect(send.mock.calls).toEqual([[{ type: 'desk_changed', payload: { revision: 7 } }]])
    stop()
    expect(m.deskUnsub).toHaveBeenCalledOnce()
  })
})
