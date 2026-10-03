import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamService, type TeamDependencies } from './service.js'
import { TeamMailbox } from './mailbox.js'
import { Team, type Actor, type Address, type Delivery, type Member, type Receipt } from './model.js'
import { teamDeliveryRequest, teamRequest } from './wire.js'
import { encryptDownFrame, encryptRpcResult } from '../lib/e2ee/applicationFrames.js'

const owner: Actor = { kind: 'owner' }
const TEAM = 'a'.repeat(32), Q = 'b'.repeat(32), Q2 = 'c'.repeat(32)
const fixtures: Array<{ close(): void }> = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'team-contract-'))
  let now = 1_790_000_000_000
  const sent: Array<{ machine: string; agent: string; text: string; id: string }> = []
  const available = new Map([['phone/mobile', true], ['host/daemon', true], ['host/firmware', true]])
  const engines: Record<string, string> = { mobile: 'claude', daemon: 'codex', firmware: 'grok' }
  const mailboxes = new Map<string, TeamMailbox>()
  const makeMailbox = (machine: string) => {
    const box = new TeamMailbox({
      stateDir: join(root, machine), now: () => now,
      runtime: agent => engines[agent] ? { name: agent, engine: engines[agent], available: available.get(`${machine}/${agent}`) ?? false } : null,
      send: (agent, text, id) => {
        sent.push({ machine, agent, text, id })
        box.observe({ sessionId: agent, deliveryId: id, state: 'started' })
      },
      cancel: () => false,
    })
    mailboxes.set(machine, box)
    return box
  }
  const mailbox = (machine: string) => mailboxes.get(machine) ?? makeMailbox(machine)
  const deps: TeamDependencies = {
    stateDir: join(root, 'ledgers'), machineId: 'host', now: () => now,
    command: () => 'harness team',
    runtime: async address => engines[address.agentId] ? { name: address.agentId, engine: engines[address.agentId], available: available.get(`${address.machineId}/${address.agentId}`) ?? false } : null,
    delivery: async (address, action, data) => {
      const result = teamDeliveryRequest(mailbox(address.machineId), { action, delivery: data })
      if (result.error) throw new Error(String(result.error))
      return result.receipt as Receipt | null
    },
  }
  let service = new TeamService(deps)
  const creation = { id: TEAM, name: 'Build Harness', description: 'Mobile, daemon, and firmware peers', members: [
    { name: 'mobile', role: 'Phone app', machineId: 'phone', agentId: 'mobile' },
    { name: 'daemons', role: 'Daemon APIs', machineId: 'host', agentId: 'daemon' },
    { name: 'firmware', role: 'Device firmware', machineId: 'host', agentId: 'firmware' },
  ] }
  const read = () => Team.parse(JSON.parse(readFileSync(join(root, 'ledgers', `${TEAM}.json`), 'utf8')))
  const members = () => read().members
  const actor = (name: string): Actor => ({ kind: 'member', key: members().find(m => m.name === name)!.key })
  const member = (name: string): Member => members().find(m => m.name === name)!
  const tick = async () => { await service.pump(); for (const box of mailboxes.values()) box.pump(); await service.pump() }
  const restart = () => {
    service.stop()
    for (const box of mailboxes.values()) box.stop()
    mailboxes.clear()
    service = new TeamService(deps)
  }
  const f = { root, deps, creation, sent, available, mailbox, read, member, actor, tick, restart,
    get service() { return service }, advance: (ms: number) => { now += ms },
    close: () => { service.stop(); for (const box of mailboxes.values()) box.stop(); rmSync(root, { recursive: true, force: true }) },
  }
  fixtures.push(f)
  return f
}
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks() })

describe('continuing teams across engines and machines', () => {
  it('connects existing peers, asks across machines, records an explicit answer, and continues the original agent', async () => {
    const f = fixture()
    const snapshot = await f.service.create(f.creation, owner)
    expect(JSON.stringify(snapshot)).not.toContain('"key"')
    await f.tick()
    expect(f.sent.map(s => s.agent)).toEqual(['mobile', 'daemon', 'firmware'])
    expect(f.sent[0].text).toContain('harness team --machine')
    const from = f.member('mobile'), to = f.member('daemons')
    const question = f.service.ask(TEAM, { id: Q, from: from.id, to: 'daemons', text: 'Which endpoint exposes daemon state?' }, f.actor('mobile'))
    expect(question.origin).toBe('agent')
    await f.tick()
    expect(f.sent.at(-1)).toMatchObject({ machine: 'host', agent: 'daemon' })
    expect(f.sent.at(-1)!.text).toContain(`reply ${Q}`)
    // A started terminal turn is still only delivery, never an answer.
    expect(f.service.status(TEAM, Q, owner)).toMatchObject({ state: 'pending', delivery: { state: 'started' } })
    f.service.reply(TEAM, Q, 'Use GET /api/daemons.', ['routes/daemons.ts:24'], f.actor('daemons'))
    await f.tick()
    expect(f.sent.at(-1)).toMatchObject({ machine: 'phone', agent: 'mobile' })
    expect(f.sent.at(-1)!.text).toContain('Use GET /api/daemons.')
    expect(f.service.status(TEAM, Q, owner)).toMatchObject({ state: 'answered', answer: { author: to.id, late: false }, continuation: { state: 'started' } })
    expect(statSync(join(f.root, 'ledgers', `${TEAM}.json`)).mode & 0o777).toBe(0o600)
    f.restart()
    await f.tick()
    expect(f.sent).toHaveLength(5)
    expect(f.service.status(TEAM, Q, owner).answer!.text).toBe('Use GET /api/daemons.')
  })

  it('deduplicates lost create, ask, and reply acknowledgements; rejects conflicting reuse', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([f.service.create(f.creation, owner), f.service.create(f.creation, owner)])
    expect(a).toEqual(b)
    const input = { id: Q, from: f.member('mobile').id, to: 'firmware', text: 'What is the device protocol?' }
    expect(f.service.ask(TEAM, input, f.actor('mobile'))).toEqual(f.service.ask(TEAM, input, f.actor('mobile')))
    expect(() => f.service.ask(TEAM, { ...input, text: 'Changed request' }, f.actor('mobile'))).toThrow('different content')
    f.service.reply(TEAM, Q, 'v3', [], f.actor('firmware'))
    expect(f.service.reply(TEAM, Q, 'v3', [], f.actor('firmware')).answer!.text).toBe('v3')
    expect(() => f.service.reply(TEAM, Q, 'v4', [], f.actor('firmware'))).toThrow('already recorded')
    await f.tick()
    expect(f.sent.filter(s => s.id.endsWith(':answer'))).toHaveLength(1)
  })

  it('requires the addressed member to answer and rejects cross-team or removed capabilities', async () => {
    const f = fixture(); await f.service.create(f.creation, owner)
    f.service.ask(TEAM, { id: Q, from: f.member('mobile').id, to: 'daemons', text: 'Need the schema.' }, f.actor('mobile'))
    expect(() => f.service.reply(TEAM, Q, 'pretend answer', [], f.actor('firmware'))).toThrow('addressed teammate')
    expect(() => f.service.ask(TEAM, { id: Q2, from: f.member('daemons').id, to: 'firmware', text: 'spoof' }, f.actor('mobile'))).toThrow('only act as itself')
    expect(() => f.service.setState(TEAM, 'paused', f.actor('mobile'))).toThrow('Only the user')
    const priorActor = f.actor('daemons')
    f.service.updateMember(TEAM, { ...f.member('daemons'), enabled: false }, owner)
    expect(() => f.service.reply(TEAM, Q, 'old capability', [], priorActor)).toThrow('membership')
    expect(f.service.status(TEAM, Q, owner).state).toBe('cancelled')
    await expect(f.service.snapshot(TEAM, { kind: 'member', key: '0'.repeat(64) })).rejects.toThrow('membership')
  })

  it('lets a busy peer consume its inbox, answers it, and suppresses duplicate terminal notices', async () => {
    const f = fixture(); await f.service.create(f.creation, owner)
    f.available.set('host/daemon', false)
    f.service.ask(TEAM, { id: Q, from: f.member('mobile').id, to: 'daemons', text: 'Quick question' }, f.actor('mobile'))
    await f.tick()
    const inbox = await f.service.inbox(TEAM, f.actor('daemons'))
    expect((inbox.questions as any[])[0].id).toBe(Q)
    f.service.reply(TEAM, Q, 'Here is the answer', [], f.actor('daemons'))
    // Caller reads its answer through a tool before any continuation can be typed.
    const result = await f.service.inbox(TEAM, f.actor('mobile'))
    expect((result.answers as any[])[0].answer.text).toBe('Here is the answer')
    f.available.set('host/daemon', true)
    await f.tick()
    expect(f.sent.filter(s => s.id.endsWith(':question') || s.id.endsWith(':answer'))).toHaveLength(0)
  })

  it('preserves pending work while offline; cancellation and deadlines suppress late continuations', async () => {
    const f = fixture(); await f.service.create(f.creation, owner)
    f.available.set('host/daemon', false)
    f.service.ask(TEAM, { id: Q, from: f.member('mobile').id, to: 'daemons', text: 'Will expire', ttlMs: 10_000 }, f.actor('mobile'))
    await f.tick()
    f.advance(10_001)
    await f.tick()
    expect(f.service.status(TEAM, Q, owner).state).toBe('expired')
    f.service.reply(TEAM, Q, 'Late answer, retained', [], f.actor('daemons'))
    expect(f.service.status(TEAM, Q, owner)).toMatchObject({ state: 'expired', answer: { late: true } })
    expect(f.service.status(TEAM, Q, owner).continuation).toBeUndefined()
    f.service.ask(TEAM, { id: Q2, from: f.member('mobile').id, to: 'daemons', text: 'Cancel me' }, f.actor('mobile'))
    f.service.cancel(TEAM, Q2, f.actor('mobile'))
    f.available.set('host/daemon', true)
    await f.tick()
    expect(f.sent.filter(s => s.id.endsWith(':question'))).toHaveLength(0)
  })

  it('pauses unsent notices and resumes them once without interrupting existing work', async () => {
    const f = fixture(); await f.service.create(f.creation, owner)
    f.service.ask(TEAM, { id: Q, from: f.member('mobile').id, to: 'firmware', text: 'Device facts' }, f.actor('mobile'))
    f.service.setState(TEAM, 'paused', owner)
    await f.tick()
    expect(f.sent).toHaveLength(0)
    expect(() => f.service.ask(TEAM, { id: Q2, from: f.member('mobile').id, to: 'firmware', text: 'new' }, f.actor('mobile'))).toThrow('paused')
    f.service.setState(TEAM, 'active', owner)
    await f.tick(); await f.tick()
    expect(f.sent.filter(s => s.id.endsWith(':question'))).toHaveLength(1)
    expect(f.sent.filter(s => s.id.endsWith(':intro'))).toHaveLength(3)
  })

  it('limits pending questions and rejects self-messages and duplicate aliases', async () => {
    const f = fixture()
    await expect(f.service.create({ ...f.creation, members: f.creation.members.map(m => ({ ...m, name: 'same' })) }, owner)).rejects.toThrow('unique name')
    await f.service.create(f.creation, owner)
    const from = f.member('mobile').id
    expect(() => f.service.ask(TEAM, { id: Q, from, to: 'mobile', text: 'self' }, f.actor('mobile'))).toThrow('another teammate')
    for (let n = 0; n < 8; n++) f.service.ask(TEAM, { id: n.toString(16).padStart(32, '0'), from, to: 'firmware', text: `question ${n}` }, f.actor('mobile'))
    expect(() => f.service.ask(TEAM, { id: Q, from, to: 'firmware', text: 'too many' }, f.actor('mobile'))).toThrow('eight unanswered')
  })

  it('preserves corrupt records and reports them instead of replacing them with a new team', async () => {
    const f = fixture(); await f.service.create(f.creation, owner)
    const path = join(f.root, 'ledgers', `${TEAM}.json`)
    writeFileSync(path, 'broken', { mode: 0o600 })
    f.restart()
    expect(f.service.list(owner).errors).toEqual([{ id: TEAM, error: 'CORRUPT_STATE', detail: expect.any(String) }])
    await expect(f.service.create(f.creation, owner)).rejects.toThrow('preserved unreadable')
    expect(readFileSync(path, 'utf8')).toBe('broken')
  })

  it('reconciles original creation after edits and gives rejoined sessions a fresh capability', async () => {
    const f = fixture(); await f.service.create(f.creation, owner)
    const old = f.member('daemons'), oldActor = f.actor('daemons')
    f.service.updateMember(TEAM, { ...old, role: 'Updated role', enabled: false }, owner)
    await f.service.create(f.creation, owner)
    const addition = { id: Q2, name: 'daemons', role: 'Updated role', machineId: 'host', agentId: 'daemon' }
    await Promise.all([f.service.addMember(TEAM, addition, owner), f.service.addMember(TEAM, addition, owner)])
    expect(f.read().members).toHaveLength(4)
    expect(() => f.service.memberId(TEAM, oldActor)).toThrow('membership')
    const question = f.service.ask(TEAM, { id: Q, from: f.member('mobile').id, to: 'daemons', text: 'New membership?' }, f.actor('mobile'))
    expect(question.to).toBe(Q2)
    await f.tick()
    expect(f.sent.filter(s => s.agent === 'daemon' && s.id.endsWith(':intro'))).toHaveLength(1)
  })

  it('keeps full Unicode answers while bounding terminal notices in bytes and preserving retrieval commands', async () => {
    const f = fixture(); await f.service.create(f.creation, owner)
    const text = '界'.repeat(7999)
    f.service.ask(TEAM, { id: Q, from: f.member('mobile').id, to: 'daemons', text, context: text }, f.actor('mobile'))
    await f.tick()
    const question = f.sent.find(s => s.id.endsWith(':question'))!
    expect(Buffer.byteLength(question.text)).toBeLessThan(24000)
    expect(question.text).toContain(`status ${Q}`)
    const answer = '答'.repeat(15999)
    f.service.reply(TEAM, Q, answer, Array(16).fill('ref/'.repeat(250)), f.actor('daemons'))
    await f.tick()
    const notice = f.sent.find(s => s.id.endsWith(':answer'))!
    expect(Buffer.byteLength(notice.text)).toBeLessThan(24000)
    expect(notice.text).toContain(`status ${Q}`)
    expect(f.service.status(TEAM, Q, owner).answer!.text).toBe(answer)
  })

  it('does not attribute a user-supplied answer to the agent', async () => {
    const f = fixture(); await f.service.create(f.creation, owner)
    f.service.ask(TEAM, { id: Q, from: f.member('mobile').id, to: 'daemons', text: 'Human correction' }, owner)
    const result = f.service.reply(TEAM, Q, 'User supplied this answer', [], owner, f.member('daemons').id)
    expect(result.answer!.origin).toBe('owner')
    expect(() => f.service.reply(TEAM, Q, 'User supplied this answer', [], f.actor('daemons'))).toThrow('already recorded')
    await f.tick()
    expect(f.sent.find(s => s.id.endsWith(':answer'))!.text).toContain('The user supplied an answer')
  })
})

describe('destination delivery evidence', () => {
  const delivery = (expiresAt = 1_790_000_100_000): Delivery => ({ id: `team:${TEAM}:${Q}:question`, agentId: 'daemon', text: 'a question', expiresAt })

  it('suppresses reserved writes at the final boundary after pause, cancellation, consumption, or expiry', () => {
    const f = fixture(), box = f.mailbox('host'), d = delivery()
    box.accept(d)
    expect(box.canWrite(d.id)).toBe(true)
    box.hold(d.id, true)
    expect(box.canWrite(d.id)).toBe(false)
    box.hold(d.id, false)
    expect(box.canWrite(d.id)).toBe(true)
    box.cancel(d.id)
    expect(box.canWrite(d.id)).toBe(false)
    const next = { ...d, id: `team:${TEAM}:${Q2}:answer` }
    box.accept(next)
    box.cancel(next.id, true)
    expect(box.canWrite(next.id)).toBe(false)
    const expired = { ...d, id: `team:${TEAM}:${Q2}:intro`, expiresAt: 1 }
    box.accept(expired)
    expect(box.canWrite(expired.id)).toBe(false)
  })

  it('a cancel arriving before send leaves a durable tombstone', () => {
    const f = fixture(), box = f.mailbox('host'), d = delivery()
    expect(box.cancel(d.id).state).toBe('cancelled')
    expect(box.accept(d).state).toBe('cancelled')
    box.pump()
    f.restart()
    const next = f.mailbox('host')
    expect(next.accept(d).state).toBe('cancelled')
    next.pump()
    expect(f.sent).toHaveLength(0)
  })

  it('never repeats a terminal write after the destination restarts during submission', () => {
    const f = fixture(), box = f.mailbox('host'), d = delivery()
    box.accept(d)
    // Represent the concrete point after paste but before a transcript start.
    box.pump()
    box.observe({ deliveryId: d.id, sessionId: d.agentId, state: 'delivered' })
    f.restart()
    const next = f.mailbox('host')
    expect(next.status(d.id)).toMatchObject({ state: 'unknown' })
    next.accept(d); next.pump()
    expect(f.sent).toHaveLength(1)
  })

  it('a preflight draft refusal retries later, while an ambiguous dispatch never retries', () => {
    const f = fixture(), box = f.mailbox('host'), d = delivery()
    box.accept(d); box.pump()
    box.observe({ deliveryId: d.id, sessionId: d.agentId, state: 'rejected', reason: 'team_waiting_draft' })
    expect(box.status(d.id)).toMatchObject({ state: 'queued', reason: 'team_waiting_draft' })
    box.pump()
    expect(f.sent).toHaveLength(2)
    box.observe({ deliveryId: d.id, sessionId: d.agentId, state: 'unknown', reason: 'dispatch_ambiguous' })
    box.pump()
    expect(f.sent).toHaveLength(2)
  })

  it('rejects conflicting content without additional effects', () => {
    const f = fixture(), box = f.mailbox('host'), d = delivery()
    box.accept(d)
    expect(() => box.accept({ ...d, text: 'mutated' })).toThrow('different content')
    box.pump()
    expect(f.sent).toHaveLength(1)
  })

  it.each(['queue_full', 'queue_expired', 'agent_gone', 'runtime_gone_pre_paste'])('retries a proven unsent %s refusal only before its deadline', reason => {
    const f = fixture(), box = f.mailbox('host'), d = delivery()
    box.accept(d); box.pump()
    box.observe({ deliveryId: d.id, sessionId: d.agentId, state: 'rejected', reason })
    expect(box.status(d.id)?.state).toBe('queued')
    box.pump()
    expect(f.sent).toHaveLength(2)
    box.observe({ deliveryId: d.id, sessionId: d.agentId, state: 'rejected', reason })
    f.advance(100_001)
    box.pump()
    expect(box.status(d.id)?.state).toBe('cancelled')
    expect(f.sent).toHaveLength(2)
  })
})

describe('wire isolation and validation', () => {
  it('encrypts every team request and response on the existing relay', () => {
    for (const type of ['team', 'team_delivery']) {
      expect(encryptDownFrame(type)).toBe(true)
      expect(encryptRpcResult(`${type}_result`)).toBe(true)
    }
  })
  it('rejects invalid actions, paths and owner operations made with a member key', async () => {
    const f = fixture(); await f.service.create(f.creation, owner)
    expect(await teamRequest(f.service, { action: 'get', teamId: '../../state' })).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(await teamRequest(f.service, { action: 'launch_anything' })).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(await teamRequest(f.service, { action: 'archive', teamId: TEAM, memberKey: (f.actor('mobile') as { key: string }).key })).toMatchObject({ error: 'OWNER_REQUIRED' })
    expect(teamDeliveryRequest(f.mailbox('host'), { action: 'cancel', delivery: { id: '../../x' } })).toMatchObject({ error: 'INVALID_REQUEST' })
  })
})
