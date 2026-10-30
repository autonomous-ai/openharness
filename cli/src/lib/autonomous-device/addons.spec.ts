import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { DEVICE_PROPOSALS_PER_MINUTE, DeviceAddons, DeviceAddonError, HOLDS_MAX_MS, OPEN_PROPOSALS_MAX, PROPOSALS_PER_MINUTE, TOPICS_MAX, VALUE_MAX_BYTES } from './addons.js'
import type { AutonomousDeviceFrame } from './service.js'

function fixture() {
  let clock = 1_000_000
  const sent: Array<{ deviceId: string; frame: AutonomousDeviceFrame }> = []
  const addons = new DeviceAddons({ machineId: 'machine', serverInstanceId: 'instance', now: () => clock, send: (deviceId, frame) => sent.push({ deviceId, frame }) })
  const publish = (deviceId: string, values: Array<Record<string, unknown>>) => addons.request(deviceId, { type: 'addon.publish', requestId: randomUUID(), values })
  const decide = (deviceId: string, proposalId: string, decision: string, reason?: string) =>
    addons.request(deviceId, { type: 'addon.decision', requestId: randomUUID(), proposalId, decision, ...(reason ? { reason } : {}) })
  let keys = 0
  const propose = (fields: Record<string, unknown> = {}) => addons.propose({ addon: 'mood-addon', idempotencyKey: `k${++keys}`, act: 'mood', holdsMs: 10_000, ...fields })
  const code = (run: () => unknown): string => { try { run() } catch (e) { return e instanceof DeviceAddonError ? e.code : `not an add-on error: ${String(e)}` } return 'no error' }
  return { addons, sent, publish, decide, propose, code, tick: (ms: number) => { clock += ms }, now: () => clock }
}

describe('device add-ons: what a device publishes', () => {
  it('keeps the newest value of each topic, and forgets a topic published as null', () => {
    const f = fixture()
    expect(f.publish('lamp', [{ topic: 'mood/state', value: { energy: 0.4 }, at: 5 }, { topic: 'voice/state', value: { state: 'resting' } }])).toEqual({ topics: 2 })
    f.publish('lamp', [{ topic: 'mood/state', value: { energy: 0.6 } }, { topic: 'voice/state', value: null }])
    expect(f.addons.state()).toEqual([{ deviceId: 'lamp', online: true,
      topics: { 'mood/state': { value: { energy: 0.6 }, at: null, receivedAt: f.now() } } }])
  })

  it('refuses a malformed topic, an oversized value or too many topics, and keeps nothing of a refused batch', () => {
    const f = fixture()
    expect(f.code(() => f.publish('lamp', [{ topic: 'Mood State', value: {} }]))).toBe('INVALID_REQUEST')
    expect(f.code(() => f.publish('lamp', [{ topic: 'mood/state', value: { x: 'a'.repeat(VALUE_MAX_BYTES) } }]))).toBe('PAYLOAD_TOO_LARGE')
    expect(f.code(() => f.publish('lamp', [{ topic: 'mood/state', value: {}, extra: 1 }]))).toBe('INVALID_REQUEST')
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ topic: `t/n${from + i}`, value: {} }))
    for (let i = 0; i < TOPICS_MAX; i += 16) f.publish('lamp', many(i, 16))
    expect(f.code(() => f.publish('lamp', [{ topic: 'room/state', value: {} }]))).toBe('BACKPRESSURE')
    // Replacing one and adding one in the same batch stays within the bound.
    expect(f.publish('lamp', [{ topic: 't/n0', value: null }, { topic: 'room/state', value: {} }])).toEqual({ topics: TOPICS_MAX })
  })

  it('clears what a device published at its hello, so a topic it withdrew is gone and counts for nothing', () => {
    const f = fixture()
    f.publish('lamp', [{ topic: 'voice/state', value: { state: 'resting' } }, { topic: 'mood/state', value: {} }])
    for (let i = 0; i < TOPICS_MAX - 2; i += 15) f.publish('lamp', Array.from({ length: Math.min(15, TOPICS_MAX - 2 - i) }, (_, n) => ({ topic: `t/n${i + n}`, value: {} })))
    f.addons.hello('lamp')
    expect(f.addons.state('lamp')).toEqual([])
    // Its new set, without voice/state: nothing of the old one is left, and the bound is the new set's.
    f.publish('lamp', [{ topic: 'mood/state', value: { energy: 0.5 } }, { topic: 'room/presence', value: { someone: true } }])
    expect(Object.keys(f.addons.state('lamp')[0].topics)).toEqual(['mood/state', 'room/presence'])
  })

  it('asks a device to publish again, to that device alone', () => {
    const f = fixture()
    f.addons.republish('lamp')
    expect(f.sent).toEqual([{ deviceId: 'lamp', frame: { type: 'event', serverInstanceId: 'instance', machineId: 'machine', kind: 'addon.republish', payload: {} } }])
  })

  it('marks a device offline when its link closes, and forgets it when it is unpaired', () => {
    const f = fixture()
    f.publish('lamp', [{ topic: 'mood/state', value: {} }])
    f.addons.offline('lamp')
    expect(f.addons.state('lamp')[0].online).toBe(false)
    f.publish('lamp', [{ topic: 'mood/state', value: {} }])
    expect(f.addons.state('lamp')[0].online).toBe(true)
    f.addons.revoke('lamp')
    expect(f.addons.state()).toEqual([])
  })
})

describe('device add-ons: what an agent proposes', () => {
  it('sends a proposal to the one connected device, without the key or the device id in it', () => {
    const f = fixture()
    expect(f.code(() => f.propose())).toBe('MISSING_TARGET')
    f.publish('lamp', [{ topic: 'mood/state', value: {} }])
    const proposal = f.propose({ why: 'music', sure: 0.7, params: { energy: 0.1 }, note: 'Music is on.' })
    expect(proposal).toMatchObject({ deviceId: 'lamp', addon: 'mood-addon', act: 'mood', state: 'sent', expiresAt: f.now() + 10_000 })
    expect(f.sent).toEqual([{ deviceId: 'lamp', frame: { type: 'event', serverInstanceId: 'instance', machineId: 'machine', kind: 'addon.proposal',
      payload: { proposalId: proposal.proposalId, addon: 'mood-addon', act: 'mood', why: 'music', sure: 0.7, holdsMs: 10_000,
        params: { energy: 0.1 }, note: 'Music is on.', expiresAt: f.now() + 10_000 } } }])
  })

  it('needs a device named when several are connected, and refuses one offline or unknown', () => {
    const f = fixture()
    f.publish('a', [{ topic: 'mood/state', value: {} }]); f.publish('b', [{ topic: 'mood/state', value: {} }])
    expect(f.code(() => f.propose())).toBe('MISSING_TARGET')
    expect(f.propose({ deviceId: 'b' }).deviceId).toBe('b')
    f.addons.offline('a')
    expect(f.code(() => f.propose({ deviceId: 'a' }))).toBe('DEVICE_OFFLINE')
    expect(f.code(() => f.propose({ deviceId: 'c' }))).toBe('DEVICE_NOT_FOUND')
    // With a single device still connected, it is the target.
    expect(f.propose().deviceId).toBe('b')
  })

  it('is one proposal per add-on and key, and refuses the key for a different intent', () => {
    const f = fixture()
    f.publish('lamp', [{ topic: 'mood/state', value: {} }])
    const first = f.addons.propose({ addon: 'x', idempotencyKey: 'same', act: 'light', holdsMs: 5000, params: { a: 1, b: 2 } })
    const again = f.addons.propose({ addon: 'x', idempotencyKey: 'same', act: 'light', holdsMs: 5000, params: { b: 2, a: 1 } })
    expect(again.proposalId).toBe(first.proposalId)
    expect(f.sent).toHaveLength(1)
    expect(f.code(() => f.addons.propose({ addon: 'x', idempotencyKey: 'same', act: 'say', holdsMs: 5000 }))).toBe('IDEMPOTENCY_CONFLICT')
    // Another add-on may use the same key.
    expect(f.addons.propose({ addon: 'y', idempotencyKey: 'same', act: 'light', holdsMs: 5000 }).proposalId).not.toBe(first.proposalId)
  })

  it('validates what a proposal carries', () => {
    const f = fixture()
    f.publish('lamp', [{ topic: 'mood/state', value: {} }])
    expect(f.code(() => f.propose({ holdsMs: HOLDS_MAX_MS + 1 }))).toBe('INVALID_REQUEST')
    expect(f.code(() => f.propose({ holdsMs: 999 }))).toBe('INVALID_REQUEST')
    expect(f.code(() => f.propose({ act: 'Mood!' }))).toBe('INVALID_REQUEST')
    expect(f.code(() => f.propose({ sure: 1.5 }))).toBe('INVALID_REQUEST')
    expect(f.code(() => f.propose({ addon: 'has space' }))).toBe('INVALID_REQUEST')
    expect(f.code(() => f.propose({ note: 'a\u0007b' }))).toBe('INVALID_REQUEST')
    expect(f.code(() => f.propose({ note: 'é'.repeat(151) }))).toBe('PAYLOAD_TOO_LARGE')
    expect(f.code(() => f.propose({ params: { x: 'a'.repeat(2048) } }))).toBe('PAYLOAD_TOO_LARGE')
    expect(f.code(() => f.propose({ extra: true }))).toBe('INVALID_REQUEST')
    expect(f.sent).toHaveLength(0)
  })

  it('bounds a device per minute whatever the add-ons call themselves', () => {
    const f = fixture()
    f.publish('lamp', [{ topic: 'mood/state', value: {} }])
    for (let i = 0; i < DEVICE_PROPOSALS_PER_MINUTE; i++) {
      const p = f.propose({ addon: `name-${i}` })
      f.decide('lamp', p.proposalId, 'dropped')
    }
    expect(f.code(() => f.propose({ addon: 'yet-another-name' }))).toBe('RATE_LIMITED')
    f.tick(60_000)
    expect(f.propose({ addon: 'yet-another-name' }).state).toBe('sent')
  })

  it('never drops a proposal the limits still count to make room, and refuses instead', () => {
    const f = fixture()
    // 22 devices, each at its minute's bound: more proposals than are kept, all inside the window.
    let made = 0
    let refused = ''
    for (let d = 0; d < 22 && !refused; d++) {
      f.publish(`d${d}`, [{ topic: 'mood/state', value: {} }])
      for (let i = 0; i < DEVICE_PROPOSALS_PER_MINUTE && !refused; i++) {
        refused = f.code(() => {
          const p = f.propose({ deviceId: `d${d}`, addon: `a${i}` })
          f.decide(`d${d}`, p.proposalId, 'dropped')
          made++
        })
        if (refused === 'no error') refused = ''
      }
    }
    expect(refused).toBe('BACKPRESSURE')
    expect(made).toBe(256)
    // A minute on, the oldest settled ones make room.
    f.tick(60_000)
    expect(f.propose({ deviceId: 'd21', addon: 'later' }).state).toBe('sent')
  })

  it('limits each add-on per minute and each device to a few undecided proposals', () => {
    const f = fixture()
    f.publish('lamp', [{ topic: 'mood/state', value: {} }])
    for (let i = 0; i < OPEN_PROPOSALS_MAX; i++) f.propose({ addon: `a${i}` })
    expect(f.code(() => f.propose({ addon: 'other' }))).toBe('BACKPRESSURE')
    // Lapsed proposals free their places.
    f.tick(10_000)
    expect(f.addons.proposal((f.sent[0].frame.payload as { proposalId: string }).proposalId)?.state).toBe('expired')
    const own = fixture()
    own.publish('lamp', [{ topic: 'mood/state', value: {} }])
    for (let i = 0; i < PROPOSALS_PER_MINUTE; i++) {
      const p = own.propose()
      own.decide('lamp', p.proposalId, 'dropped')
    }
    expect(own.code(() => own.propose())).toBe('RATE_LIMITED')
    own.tick(60_000)
    expect(own.propose().state).toBe('sent')
  })
})

describe('device add-ons: the device decides', () => {
  it('records the decision of the device it was sent to, once', () => {
    const f = fixture()
    f.publish('lamp', [{ topic: 'mood/state', value: {} }]); f.publish('other', [{ topic: 'mood/state', value: {} }])
    const p = f.propose({ deviceId: 'lamp' })
    expect(f.code(() => f.decide('other', p.proposalId, 'kept'))).toBe('PROPOSAL_UNKNOWN')
    expect(f.decide('lamp', p.proposalId, 'kept', 'quiet room')).toEqual({ proposalId: p.proposalId, state: 'kept' })
    expect(f.decide('lamp', p.proposalId, 'kept')).toEqual({ proposalId: p.proposalId, state: 'kept' })
    expect(f.code(() => f.decide('lamp', p.proposalId, 'dropped'))).toBe('IDEMPOTENCY_CONFLICT')
    expect(f.addons.proposal(p.proposalId)).toMatchObject({ state: 'kept', reason: 'quiet room', decidedAt: f.now() })
    expect(f.code(() => f.decide('lamp', randomUUID(), 'kept'))).toBe('PROPOSAL_UNKNOWN')
    expect(f.code(() => f.decide('lamp', p.proposalId, 'maybe'))).toBe('INVALID_REQUEST')
  })

  it('takes a decision that arrives after the proposal lapsed here, and forgets settled ones after ten minutes', () => {
    const f = fixture()
    f.publish('lamp', [{ topic: 'mood/state', value: {} }])
    const p = f.propose()
    f.tick(11_000)
    expect(f.addons.proposal(p.proposalId)?.state).toBe('expired')
    expect(f.decide('lamp', p.proposalId, 'dropped')).toMatchObject({ state: 'dropped' })
    f.tick(10 * 60_000 + 1)
    expect(f.addons.proposal(p.proposalId)).toBeNull()
  })

  it('forgets the proposals of an unpaired device', () => {
    const f = fixture()
    f.publish('lamp', [{ topic: 'mood/state', value: {} }])
    const p = f.propose()
    f.addons.revoke('lamp')
    expect(f.addons.proposal(p.proposalId)).toBeNull()
  })
})
