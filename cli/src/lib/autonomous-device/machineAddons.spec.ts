import { describe, expect, it } from 'vitest'
import type { Asker } from '../../core/api.js'
import { INBOX_MAX, MachineAddons } from './machineAddons.js'

const LAMP = 'm_lamp'
const OFFICE: Asker = { local: false, owner: true, accountOwner: true, machine: { machineId: 'm_office', label: 'office' } }
const LAPTOP: Asker = { local: false, owner: true, accountOwner: true, machine: { machineId: 'm_laptop', label: 'laptop' } }

function fixture() {
  let clock = 1_000_000
  const addons = new MachineAddons({ machineId: () => LAMP, now: () => clock })
  let keys = 0
  const propose = (asker: Asker, fields: Record<string, unknown> = {}) =>
    addons.request({ op: 'propose', input: { addon: 'slack-summary', idempotencyKey: `k${++keys}`, act: 'say', holdsMs: 10_000, note: 'Three new in #team.', ...fields } }, asker)
  return { addons, propose, tick: (ms: number) => { clock += ms } }
}

describe('machine add-ons: a device that is this Harness machine', () => {
  it('serves what its own service published to the owner\'s machines, and clears it at the service\'s hello', () => {
    const f = fixture()
    expect(f.addons.publish([{ topic: 'voice/state', value: { state: 'listening' } }])).toEqual({ topics: 1, instance: f.addons.instance })
    expect(f.addons.request({ op: 'state' }, OFFICE)).toEqual({ result: { devices: [{ deviceId: LAMP, online: true,
      topics: { 'voice/state': { value: { state: 'listening' }, at: null, receivedAt: 1_000_000 } } }] } })
    f.addons.hello()
    expect(f.addons.request({ op: 'state' }, OFFICE)).toEqual({ result: { devices: [] } })
  })

  it('stamps a proposal with the machine the link proved, never one the payload names, and targets this machine', async () => {
    const f = fixture()
    f.addons.publish([{ topic: 'voice/state', value: { state: 'resting' } }])
    const answer = f.propose(OFFICE, { deviceId: 'someone-else' }) as { result: { proposal: Record<string, unknown> } }
    expect(answer.result.proposal).toMatchObject({ deviceId: LAMP, addon: 'slack-summary', state: 'sent', from: { machineId: 'm_office', label: 'office' } })
    expect(f.addons.request({ op: 'propose', input: { addon: 'x', idempotencyKey: 'k', act: 'say', holdsMs: 5000, from: { machineId: 'm_x' } } }, OFFICE))
      .toMatchObject({ error: { code: 'INVALID_REQUEST' } })
    const { proposals, next } = await f.addons.proposals(0)
    expect(next).toBe(1)
    expect(proposals).toEqual([{ seq: 1, proposal: expect.objectContaining({ proposalId: answer.result.proposal.proposalId, note: 'Three new in #team.',
      from: { machineId: 'm_office', label: 'office' } }) }])
  })

  it('lets the owner\'s machines alone in, and needs a proven machine to propose', () => {
    const f = fixture()
    f.addons.publish([{ topic: 'voice/state', value: {} }])
    for (const asker of [{ local: false, owner: false }, { local: false, owner: true, accountOwner: false },
      { local: false, owner: false, guest: 'kim@acme.io', accountOwner: false, machine: { machineId: 'm_kim', label: null } }] as Asker[]) {
      expect(f.addons.request({ op: 'state' }, asker)).toMatchObject({ error: { code: 'OWNER_REQUIRED' } })
    }
    // The owner's phone or browser: may read, but a proposal says which computer it came from, and this one is none.
    expect(f.addons.request({ op: 'state' }, { local: false, owner: true, accountOwner: true })).toHaveProperty('result')
    expect(f.propose({ local: false, owner: true, accountOwner: true })).toMatchObject({ error: { code: 'MACHINE_REQUIRED' } })
    // An agent on the device itself: this machine.
    expect(f.propose({ local: true, owner: true })).toMatchObject({ result: { proposal: { from: { machineId: LAMP, label: null } } } })
  })

  it('reads a proposal back to the machine that made it alone, with the decision the device\'s service gave', () => {
    const f = fixture()
    f.addons.publish([{ topic: 'voice/state', value: {} }])
    const id = ((f.propose(OFFICE) as { result: { proposal: { proposalId: string } } }).result.proposal.proposalId)
    expect(f.addons.decide({ proposalId: id, decision: 'kept', reason: 'quiet, at the desk' })).toEqual({ proposalId: id, state: 'kept' })
    expect(f.addons.request({ op: 'proposal', input: { proposalId: id } }, OFFICE)).toMatchObject({ result: { proposal: { state: 'kept', reason: 'quiet, at the desk' } } })
    expect(f.addons.request({ op: 'proposal', input: { proposalId: id } }, LAPTOP)).toMatchObject({ error: { code: 'PROPOSAL_UNKNOWN' } })
    expect(() => f.addons.decide({ proposalId: id, decision: 'dropped' })).toThrow('already kept')
  })

  it('keeps v1\'s bounds: no device to propose to until the service publishes, and the same rates', () => {
    const f = fixture()
    expect(f.propose(OFFICE)).toMatchObject({ error: { code: 'DEVICE_NOT_FOUND' } })
    f.addons.publish([{ topic: 'voice/state', value: {} }])
    expect(f.propose(OFFICE, { note: 'x'.repeat(301) })).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(f.addons.request({ op: 'unknown' }, OFFICE)).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
  })

  it('wakes a waiting take at the next proposal, keeps a short inbox, and says when the cursor is ahead of it', async () => {
    const f = fixture()
    f.addons.publish([{ topic: 'voice/state', value: {} }])
    const waiting = f.addons.proposals(0, 5_000)
    f.propose(OFFICE)
    expect((await waiting).proposals).toHaveLength(1)
    expect(await f.addons.proposals(1)).toEqual({ proposals: [], next: 1, instance: f.addons.instance })
    expect(await f.addons.proposals(7)).toMatchObject({ reset: true, next: 1, proposals: [{ seq: 1 }] })
    for (let i = 0; i < INBOX_MAX + 3; i++) {
      f.tick(60_000)
      const answer = f.propose(OFFICE) as { result?: unknown; error?: unknown }
      expect(answer).toHaveProperty('result')
      const sent = await f.addons.proposals(0)
      f.addons.decide({ proposalId: (sent.proposals.at(-1)!.proposal as { proposalId: string }).proposalId, decision: 'dropped' })
    }
    const all = await f.addons.proposals(0)
    expect(all.proposals).toHaveLength(INBOX_MAX)
    expect(all.proposals[0].seq).toBe(all.next - INBOX_MAX + 1)
  })

  it('takes publishes and decisions over `machine_addon` from a process on this machine alone', async () => {
    const f = fixture()
    expect(await f.addons.request({ op: 'publish', input: { values: [{ topic: 'voice/state', value: {} }] } }, OFFICE)).toMatchObject({ error: { code: 'LOCAL_ONLY' } })
    expect(await f.addons.request({ op: 'publish', input: { values: [{ topic: 'voice/state', value: {} }] } }, { local: true, owner: true })).toMatchObject({ result: { topics: 1 } })
    const id = ((f.propose(OFFICE) as { result: { proposal: { proposalId: string } } }).result.proposal.proposalId)
    expect(await f.addons.request({ op: 'proposals', input: { after: 0 } }, { local: true, owner: true })).toMatchObject({ result: { next: 1, proposals: [{ seq: 1 }] } })
    expect(await f.addons.request({ op: 'decision', input: { proposalId: id, decision: 'maybe' } }, { local: true, owner: true })).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
    expect(await f.addons.request({ op: 'decision', input: { proposalId: id, decision: 'dropped' } }, { local: true, owner: true })).toEqual({ result: { proposalId: id, state: 'dropped' } })
    expect(await f.addons.request({ op: 'hello' }, { local: true, owner: true })).toMatchObject({ result: { topics: 0 } })
  })

  it('tells the device\'s service that the store it published to is gone: another instance, or a cursor ahead of it', async () => {
    const before = fixture()
    before.addons.publish([{ topic: 'voice/state', value: {} }])
    const old = before.addons.instance
    // The daemon or its process restarted: a new store, empty, at cursor 0.
    const after = fixture()
    expect(after.addons.instance).not.toBe(old)
    expect(await after.addons.proposals(0, 0, old)).toEqual({ proposals: [], next: 0, instance: after.addons.instance, reset: true })
    expect(after.propose(OFFICE)).toMatchObject({ error: { code: 'DEVICE_NOT_FOUND' } })
    // A restarted store already past the old cursor reads from its start, so nothing new is skipped.
    after.addons.publish([{ topic: 'voice/state', value: {} }])
    for (let i = 0; i < 3; i++) { after.propose(OFFICE); after.tick(1) }
    expect(await after.addons.proposals(2, 0, old)).toMatchObject({ reset: true, next: 3, proposals: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] })
    expect(await after.addons.proposals(2, 0, after.addons.instance)).toEqual({ proposals: [expect.objectContaining({ seq: 3 })], next: 3, instance: after.addons.instance })
  })

  it('says when proposals after the cursor were dropped from the inbox', async () => {
    const f = fixture()
    f.addons.publish([{ topic: 'voice/state', value: {} }])
    for (let i = 0; i < INBOX_MAX + 8; i++) {
      f.tick(60_000)
      f.propose(OFFICE)
      const last = (await f.addons.proposals(f.addons['seq'] - 1)).proposals.at(-1)!
      f.addons.decide({ proposalId: (last.proposal as { proposalId: string }).proposalId, decision: 'dropped' })
    }
    expect(await f.addons.proposals(0)).toMatchObject({ gap: true, proposals: { length: INBOX_MAX } })
    expect(await f.addons.proposals(8)).not.toHaveProperty('gap')
    expect(await f.addons.proposals(INBOX_MAX + 8)).not.toHaveProperty('gap')
  })

  it('keeps each machine\'s idempotency keys its own: the same key from another machine is another proposal', () => {
    const f = fixture()
    f.addons.publish([{ topic: 'voice/state', value: {} }])
    const input = { addon: 'slack-summary', idempotencyKey: 'same', act: 'say', holdsMs: 10_000, note: 'one' }
    const a = f.addons.request({ op: 'propose', input }, OFFICE) as { result: { proposal: { proposalId: string } } }
    const b = f.addons.request({ op: 'propose', input: { ...input, note: 'two' } }, LAPTOP) as { result: { proposal: { proposalId: string } } }
    expect(b.result.proposal.proposalId).not.toBe(a.result.proposal.proposalId)
    expect((f.addons.request({ op: 'propose', input }, OFFICE) as typeof a).result.proposal.proposalId).toBe(a.result.proposal.proposalId)
    expect(f.addons.request({ op: 'propose', input: { ...input, note: 'changed' } }, OFFICE)).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } })
  })
})
