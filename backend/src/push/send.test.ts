import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ devicesOf: vi.fn(), forget: vi.fn(), sandbox: vi.fn(), count: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('./devices.js', () => ({ devicesOf: m.devicesOf, forgetPushDevice: m.forget, markSandbox: m.sandbox }))
vi.mock('../lib/metrics.js', () => ({ metrics: { phonePush: m.count } }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: m.warn, info: m.info, error: m.warn } }))
import { sendPhoneNotices } from './send.js'
import type { PushDevice } from './devices.js'
import type { PhoneNotice, Sender, SendResult } from './sender.js'

const db = { fixture: 'db' } as never
const notice = (personId: string, key = `reply:tab:${personId}`): PhoneNotice =>
  ({ personId, key, title: 'Mia replied in a thread', subtitle: 'openharness', body: 'Open Harness to read it.', link: 'swarm:tab/c' })
const phone = (id: string, userId: string, platform: 'ios' | 'android' = 'ios'): PushDevice => ({ id, userId, platform, token: `secret-token-${id}`, sandbox: false })
const answering = (results: Record<string, SendResult>) => {
  const sent: Array<[string, string]> = []
  const sender: Sender = { send: async (device, n) => { sent.push([device.id, n.key]); return results[device.id] ?? { outcome: 'sent' } } }
  return { sender, sent }
}

describe('sendPhoneNotices (task #2905)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('reads the told people\'s phones once and sends each notice to each of its person\'s phones', async () => {
    m.devicesOf.mockResolvedValue([phone('a1', 'a'), phone('a2', 'a', 'android'), phone('b1', 'b')])
    const ios = answering({}), android = answering({})
    await sendPhoneNotices(db, { ios: ios.sender, android: android.sender }, [notice('a'), notice('b'), notice('a', 'mention:t1')])
    expect(m.devicesOf).toHaveBeenCalledTimes(1)
    expect(m.devicesOf).toHaveBeenCalledWith(db, ['a', 'b'])
    expect(ios.sent.sort()).toEqual([['a1', 'mention:t1'], ['a1', 'reply:tab:a'], ['b1', 'reply:tab:b']])
    expect(android.sent.sort()).toEqual([['a2', 'mention:t1'], ['a2', 'reply:tab:a']])
    expect(m.count).toHaveBeenCalledWith('ios', 'sent')
  })

  it('forgets a dead token, sends a sandbox one there from now on, and logs a failure without the token', async () => {
    m.devicesOf.mockResolvedValue([phone('dead', 'a'), phone('dev', 'a'), phone('down', 'a')])
    const ios = answering({ dead: { outcome: 'gone', reason: 'Unregistered' }, dev: { outcome: 'sandbox' }, down: { outcome: 'failed', reason: 'InternalServerError' } })
    await sendPhoneNotices(db, { ios: ios.sender, android: null }, [notice('a')])
    expect(m.forget).toHaveBeenCalledWith(db, 'dead')
    expect(m.sandbox).toHaveBeenCalledWith(db, 'dev')
    expect(m.count.mock.calls.sort()).toEqual([['ios', 'failed'], ['ios', 'gone'], ['ios', 'sandbox']])
    expect(m.warn).toHaveBeenCalledWith('phone push failed', expect.objectContaining({ platform: 'ios', reason: 'InternalServerError' }))
    expect(JSON.stringify([m.warn.mock.calls, m.info.mock.calls])).not.toContain('secret-token')
  })

  it('keeps a token whose sandbox push was skipped for want of a sandbox key, and logs it without the token', async () => {
    m.devicesOf.mockResolvedValue([phone('dev', 'a')])
    const ios = answering({ dev: { outcome: 'unconfigured', reason: 'no APNs sandbox key' } })
    await sendPhoneNotices(db, { ios: ios.sender, android: null }, [notice('a')])
    expect(m.forget).not.toHaveBeenCalled()
    expect(m.count).toHaveBeenCalledWith('ios', 'unconfigured')
    expect(m.warn).toHaveBeenCalledWith('phone push skipped', { platform: 'ios', reason: 'no APNs sandbox key' })
    expect(JSON.stringify(m.warn.mock.calls)).not.toContain('secret-token')
  })

  it('counts and logs a push it cannot send for want of the platform\'s keys', async () => {
    m.devicesOf.mockResolvedValue([phone('a2', 'a', 'android')])
    await sendPhoneNotices(db, { ios: null, android: null }, [notice('a')])
    expect(m.count).toHaveBeenCalledWith('android', 'unconfigured')
    expect(m.warn).toHaveBeenCalledWith('phone push off: no keys for this platform', expect.objectContaining({ platform: 'android', skipped: 1 }))
  })

  it('reads nothing when nobody is told, and never throws', async () => {
    await sendPhoneNotices(db, { ios: null, android: null }, [])
    expect(m.devicesOf).not.toHaveBeenCalled()
    m.devicesOf.mockRejectedValue(new Error('db down'))
    await expect(sendPhoneNotices(db, { ios: null, android: null }, [notice('a')])).resolves.toBeUndefined()
    expect(m.warn).toHaveBeenCalledWith('phone push failed', expect.objectContaining({ error: 'db down' }))
  })

  it('sends at most 8 at once', async () => {
    m.devicesOf.mockResolvedValue(Array.from({ length: 30 }, (_, i) => phone(`p${i}`, 'a')))
    let open = 0, most = 0
    const sender: Sender = { send: async () => { open++; most = Math.max(most, open); await Promise.resolve(); await Promise.resolve(); open--; return { outcome: 'sent' } } }
    await sendPhoneNotices(db, { ios: sender, android: null }, [notice('a')])
    expect(most).toBe(8)
  })
})
