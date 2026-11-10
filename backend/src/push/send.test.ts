import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ devicesOf: vi.fn(), forget: vi.fn(), sandbox: vi.fn(), count: vi.fn(), warn: vi.fn(), info: vi.fn(),
  muted: vi.fn(async (_db: unknown, n: unknown) => n), unread: vi.fn(async (_db: unknown, n: unknown) => n) }))
vi.mock('./devices.js', () => ({ devicesOf: m.devicesOf, forgetPushDevice: m.forget, markSandbox: m.sandbox }))
vi.mock('../lib/metrics.js', () => ({ metrics: { phonePush: m.count } }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: m.warn, info: m.info, error: m.warn } }))
vi.mock('./muted.js', () => ({ dropMuted: m.muted }))
vi.mock('./unread.js', () => ({ quietUnread: m.unread }))
import { sendPhoneNotices } from './send.js'
import { CHAT_RING_EVERY_MS, localRingMemory, type RingMemory } from './rings.js'
import type { PushDevice } from './devices.js'
import type { PhoneNotice, Sender, SendResult } from './sender.js'

const db = { fixture: 'db' } as never
const notice = (personId: string, key = `reply:tab:${personId}`): PhoneNotice =>
  ({ personId, key, title: 'Mia replied in a thread', subtitle: 'openharness', body: 'Open Harness to read it.', link: 'swarm:tab/c', slot: key })
const phone = (id: string, userId: string, platform: 'ios' | 'android' = 'ios'): PushDevice => ({ id, userId, platform, token: `secret-token-${id}`, sandbox: false })
const answering = (results: Record<string, SendResult>) => {
  const sent: Array<[string, string]> = []
  const sender: Sender = { send: async (device, n) => { sent.push([device.id, n.key]); return results[device.id] ?? { outcome: 'sent' } } }
  return { sender, sent }
}

describe('sendPhoneNotices (task #2905)', () => {
  let rings: RingMemory
  beforeEach(() => {
    vi.resetAllMocks()
    rings = localRingMemory()
    m.muted.mockImplementation(async (_db, n) => n)
    m.unread.mockImplementation(async (_db, n) => n)
  })

  // Both are read by key, at once (review of #3811): what a muted chat drops stays dropped, and what is unread goes quiet.
  it('leaves out a muted chat\'s notice and sends an unread chat\'s quiet, reading both from what was given', async () => {
    m.devicesOf.mockResolvedValue([phone('a1', 'a')])
    const seen: PhoneNotice[] = []
    const sender: Sender = { send: async (_device, n) => { seen.push(n); return { outcome: 'sent' } } }
    const [kept, muted, unread] = [notice('a', 'chat:t:kept'), notice('a', 'chat:t:muted'), notice('a', 'chat:t:unread')]
    m.muted.mockImplementation(async (_db, n) => (n as PhoneNotice[]).filter(x => x.key !== muted.key))
    m.unread.mockImplementation(async (_db, n) => (n as PhoneNotice[]).map(x => x.key === unread.key || x.key === muted.key ? { ...x, quiet: true } : x))
    await sendPhoneNotices(db, { ios: sender, android: null }, [kept, muted, unread], rings)
    expect(m.muted).toHaveBeenCalledWith(db, [kept, muted, unread])
    expect(m.unread).toHaveBeenCalledWith(db, [kept, muted, unread])
    expect(seen).toEqual([kept, { ...unread, quiet: true }])
  })

  // Tony, 2026-11-10: three or four agents writing at once rang every time their person read a chat.
  it('sends an agent chat quiet for five minutes once it sounded, read or not, per person and chat; other kinds never wait', async () => {
    m.devicesOf.mockResolvedValue([phone('a1', 'a'), phone('b1', 'b')])
    let at = 1_000_000
    rings = localRingMemory(() => at)
    const seen: PhoneNotice[] = []
    const sender: Sender = { send: async (_device, n) => { seen.push(n); return { outcome: 'sent' } } }
    const send = (...notices: PhoneNotice[]) => sendPhoneNotices(db, { ios: sender, android: null }, notices, rings)
    const [oak, ivy, bobs, reply] = [notice('a', 'chat:t:oak'), notice('a', 'chat:t:ivy'), notice('b', 'chat:t:oak'), notice('a')]
    await send(oak, reply)
    at += CHAT_RING_EVERY_MS - 1
    // The same chat sounds no more, though its person read it since (the unread read says nothing here); a reply still rings.
    await send(oak, ivy, bobs, reply)
    at += 1
    await send(oak)
    expect(seen).toEqual([oak, reply, { ...oak, quiet: true }, ivy, bobs, reply, oak])
  })

  it('starts no chat\'s quiet for a notice already quiet, dropped as muted, or for a person with no phone', async () => {
    m.devicesOf.mockResolvedValue([phone('a1', 'a')])
    const seen: PhoneNotice[] = []
    const sender: Sender = { send: async (_device, n) => { seen.push(n); return { outcome: 'sent' } } }
    const send = (...notices: PhoneNotice[]) => sendPhoneNotices(db, { ios: sender, android: null }, notices, rings)
    const [unread, muted, phoneless] = [notice('a', 'chat:t:unread'), notice('a', 'chat:t:muted'), notice('nobody', 'chat:t:oak')]
    m.unread.mockImplementationOnce(async (_db, n) => (n as PhoneNotice[]).map(x => x.key === unread.key ? { ...x, quiet: true } : x))
    m.muted.mockImplementationOnce(async (_db, n) => (n as PhoneNotice[]).filter(x => x.key !== muted.key))
    await send(unread, muted, phoneless)
    expect(seen).toEqual([{ ...unread, quiet: true }])
    // None of the three claimed its chat: each sounds when it next comes.
    expect(await Promise.all([unread, muted, phoneless].map(n => rings.claim(`${n.personId}:${n.key}`)))).toEqual([true, true, true])
  })

  it('sounds every chat, and says so, when the memory of what sounded cannot be read', async () => {
    m.devicesOf.mockResolvedValue([phone('a1', 'a')])
    const seen: PhoneNotice[] = []
    const sender: Sender = { send: async (_device, n) => { seen.push(n); return { outcome: 'sent' } } }
    const down: RingMemory = { claim: async () => { throw new Error('Redis commands refused') } }
    await sendPhoneNotices(db, { ios: sender, android: null }, [notice('a', 'chat:t:oak')], down)
    expect(seen).toEqual([notice('a', 'chat:t:oak')])
    expect(m.warn).toHaveBeenCalledWith('phone push rings not read', { chats: 1, error: 'Redis commands refused' })
  })

  it('sends each notice as phoneNotices made it, a quiet one quiet: nothing read but the phones (2026-11-09)', async () => {
    m.devicesOf.mockResolvedValue([phone('a1', 'a')])
    const seen: PhoneNotice[] = []
    const sender: Sender = { send: async (_device, n) => { seen.push(n); return { outcome: 'sent' } } }
    const quiet: PhoneNotice = { ...notice('a', 'decision:d2'), quiet: true }
    await sendPhoneNotices(db, { ios: sender, android: null }, [notice('a'), quiet], rings)
    expect(seen).toEqual([notice('a'), quiet])
  })

  it('reads the told people\'s phones once and sends each notice to each of its person\'s phones', async () => {
    m.devicesOf.mockResolvedValue([phone('a1', 'a'), phone('a2', 'a', 'android'), phone('b1', 'b')])
    const ios = answering({}), android = answering({})
    await sendPhoneNotices(db, { ios: ios.sender, android: android.sender }, [notice('a'), notice('b'), notice('a', 'mention:t1')], rings)
    expect(m.devicesOf).toHaveBeenCalledTimes(1)
    expect(m.devicesOf).toHaveBeenCalledWith(db, ['a', 'b'])
    expect(ios.sent.sort()).toEqual([['a1', 'mention:t1'], ['a1', 'reply:tab:a'], ['b1', 'reply:tab:b']])
    expect(android.sent.sort()).toEqual([['a2', 'mention:t1'], ['a2', 'reply:tab:a']])
    // Counted by kind, the key's first word, so each kind's pushes read apart (a chat push's flood shows on its own).
    expect(m.count).toHaveBeenCalledWith('ios', 'sent', 'reply')
    expect(m.count).toHaveBeenCalledWith('ios', 'sent', 'mention')
  })

  it('forgets a dead token, sends a sandbox one there from now on, and logs a failure without the token', async () => {
    m.devicesOf.mockResolvedValue([phone('dead', 'a'), phone('dev', 'a'), phone('down', 'a')])
    const ios = answering({ dead: { outcome: 'gone', reason: 'Unregistered' }, dev: { outcome: 'sandbox' }, down: { outcome: 'failed', reason: 'InternalServerError' } })
    await sendPhoneNotices(db, { ios: ios.sender, android: null }, [notice('a')], rings)
    expect(m.forget).toHaveBeenCalledWith(db, 'dead')
    expect(m.sandbox).toHaveBeenCalledWith(db, 'dev')
    expect(m.count.mock.calls.sort()).toEqual([['ios', 'failed', 'reply'], ['ios', 'gone', 'reply'], ['ios', 'sandbox', 'reply']])
    expect(m.warn).toHaveBeenCalledWith('phone push failed', expect.objectContaining({ platform: 'ios', reason: 'InternalServerError' }))
    expect(JSON.stringify([m.warn.mock.calls, m.info.mock.calls])).not.toContain('secret-token')
  })

  it('keeps a token whose sandbox push was skipped for want of a sandbox key, and logs it without the token', async () => {
    m.devicesOf.mockResolvedValue([phone('dev', 'a')])
    const ios = answering({ dev: { outcome: 'unconfigured', reason: 'no APNs sandbox key' } })
    await sendPhoneNotices(db, { ios: ios.sender, android: null }, [notice('a')], rings)
    expect(m.forget).not.toHaveBeenCalled()
    expect(m.count).toHaveBeenCalledWith('ios', 'unconfigured', 'reply')
    expect(m.warn).toHaveBeenCalledWith('phone push skipped', { platform: 'ios', reason: 'no APNs sandbox key' })
    expect(JSON.stringify(m.warn.mock.calls)).not.toContain('secret-token')
  })

  it('counts and logs a push it cannot send for want of the platform\'s keys', async () => {
    m.devicesOf.mockResolvedValue([phone('a2', 'a', 'android')])
    await sendPhoneNotices(db, { ios: null, android: null }, [notice('a')], rings)
    expect(m.count).toHaveBeenCalledWith('android', 'unconfigured', 'reply')
    expect(m.warn).toHaveBeenCalledWith('phone push off: no keys for this platform', expect.objectContaining({ platform: 'android', skipped: 1 }))
  })

  it('reads nothing when nobody is told, and never throws', async () => {
    await sendPhoneNotices(db, { ios: null, android: null }, [], rings)
    expect(m.devicesOf).not.toHaveBeenCalled()
    m.devicesOf.mockRejectedValue(new Error('db down'))
    await expect(sendPhoneNotices(db, { ios: null, android: null }, [notice('a')], rings)).resolves.toBeUndefined()
    expect(m.warn).toHaveBeenCalledWith('phone push failed', expect.objectContaining({ error: 'db down' }))
  })

  it('sends at most 8 at once', async () => {
    m.devicesOf.mockResolvedValue(Array.from({ length: 30 }, (_, i) => phone(`p${i}`, 'a')))
    let open = 0, most = 0
    const sender: Sender = { send: async () => { open++; most = Math.max(most, open); await Promise.resolve(); await Promise.resolve(); open--; return { outcome: 'sent' } } }
    await sendPhoneNotices(db, { ios: sender, android: null }, [notice('a')], rings)
    expect(most).toBe(8)
  })
})
