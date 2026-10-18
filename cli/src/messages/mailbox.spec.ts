import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneInbox } from './inbox.js'
import { ATTEMPT_MS, deliveryKey, FINISHED_KEEP_MS, FYI_REASON, HOOKLESS_MS, HOOKLESS_REASON, Mailbox, MAX_BACKOFF_MS, PARK_MS, PARKED_MAX_MS, PUMP_MS, WITHHELD, type MailboxAgent, type MailboxDeps } from './mailbox.js'
import { NOTICE_TEXT, paneNotice, type DeliveryStatus, type Message } from './model.js'
import { MessageStore } from './store.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mailbox-')) })
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

const message = (id = 'm0000001'): Message => ({
  id, tabId: 'app', text: 'review 3f2a9c1', at: 1,
  from: { machineId: 'm1', agentId: 'lead', name: 'lead', engine: 'codex', machine: 'studio' },
  to: [{ machineId: 'm1', agentId: 'api', name: 'api' }],
})

function setup(over: Partial<MailboxDeps> = {}) {
  let clock = 1_000
  const store = new MessageStore(join(root, 'state'))
  const inbox = new PaneInbox(join(root, 'agent-messages'))
  let agent: MailboxAgent | null = { pane: '%3', session: 's1', available: true }
  const delivered: Array<[string, string, string]> = []
  const statuses: DeliveryStatus[] = []
  let refused: string | null = null
  let held: string | null = null
  let ready = true
  const writable = vi.fn()
  const deps: MailboxDeps = {
    store, inbox, now: () => clock,
    agent: () => agent,
    deliver: (agentId, text, id) => { delivered.push([agentId, text, id]) },
    refused: () => refused,
    held: () => held,
    ready: () => ready,
    text: (_d, m) => `[${m.id}] ${m.text}`,
    changed: (status) => { statuses.push(status) },
    writable,
    ...over,
  }
  const mailbox = new Mailbox(deps)
  const accept = (m = message()) => { store.record(m); return mailbox.accept(m, 'api') }
  const event = (deliveryId: string, state: 'queued' | 'delivered' | 'started' | 'rejected' | 'unknown', reason?: string) =>
    mailbox.observe({ deliveryId, sessionId: 'api', state, ...(reason ? { reason } : {}) })
  return {
    store, inbox, mailbox, delivered, statuses, accept, event, writable,
    tick: (ms: number) => { clock += ms },
    now: () => clock,
    setAgent: (next: MailboxAgent | null) => { agent = next },
    refuse: (why: string | null) => { refused = why },
    hold: (why: string | null) => { held = why },
    setReady: (next: boolean) => { ready = next },
    claim: (pane: string, key: string) => {
      // As the hook does: the rename into claimed/, which it makes.
      mkdirSync(join(root, 'agent-messages', 'claimed'), { recursive: true })
      renameSync(join(root, 'agent-messages', 'inbox', pane.slice(1), `${key}.json`), join(root, 'agent-messages', 'claimed', `${pane.slice(1)}-${key}.json`))
    },
  }
}

describe('Agent Messages\' mailbox', () => {
  it('types a message at once into an idle agent, taken back from the hook while it is typed', () => {
    const t = setup()
    const delivery = t.accept()
    expect(delivery.key).toBe(deliveryKey('m0000001', 'api'))
    const id = `team:msg:${delivery.key}:1`
    expect(t.delivered).toEqual([['api', '[m0000001] review 3f2a9c1', id]])
    expect(delivery).toMatchObject({ pane: '%3', session: 's1' })
    expect(t.inbox.waiting('%3', delivery.key)).toBe(false)
    expect(t.mailbox.canWrite(id)).toBe(true)
    expect(t.mailbox.canWrite('team:msg:other')).toBe(false)
    t.event(id, 'queued')
    expect(delivery.attempt!.queuedAt).toBe(t.now())
    t.event(id, 'started')
    expect(delivery).toMatchObject({ state: 'delivered', via: 'prompt' })
    expect(t.statuses.at(-1)).toMatchObject({ messageId: 'm0000001', agentId: 'api', state: 'delivered', via: 'prompt' })
    expect(t.mailbox.canWrite(id)).toBe(false)
    expect(t.inbox.reclaimed()).toEqual([])
    // Accepted again (a retried handover): the same delivery.
    expect(t.mailbox.accept(message(), 'api')).toBe(delivery)
    // A stranger's delivery, or one of a finished delivery, changes nothing.
    t.event('team:other', 'started')
    t.event(id, 'rejected', 'team_waiting_idle')
    expect(delivery.state).toBe('delivered')
  })

  it('gives a message back to the hook while the agent works, and the hook delivers it at its next tool call', () => {
    const t = setup()
    const delivery = t.accept()
    t.event(delivery.attempt!.id, 'rejected', 'team_waiting_idle')
    expect(t.inbox.waiting('%3', delivery.key)).toBe(true)
    expect(t.statuses.at(-1)).toMatchObject({ state: 'queued', reason: 'working: arrives at its next tool call' })
    t.mailbox.pump()
    expect(t.delivered).toHaveLength(1)
    t.claim('%3', delivery.key)
    t.mailbox.pump()
    expect(delivery).toMatchObject({ state: 'delivered', via: 'hook' })
    expect(t.delivered).toHaveLength(1)
  })

  it('stops promising the next tool call once a working agent has taken nothing for a long while', () => {
    // A Codex lead running since before Agent Messages never ran the hook: every message to it read "arrives at its
    // next tool call" for an hour while it read them with `harness send` (2026-10-12).
    const t = setup()
    const delivery = t.accept()
    t.event(delivery.attempt!.id, 'rejected', 'team_waiting_idle')
    expect(t.statuses.at(-1)).toMatchObject({ reason: 'working: arrives at its next tool call' })
    t.tick(HOOKLESS_MS - 1)
    t.mailbox.pump()
    expect(t.statuses.at(-1)).toMatchObject({ reason: 'working: arrives at its next tool call' })
    t.tick(1)
    t.mailbox.pump()
    expect(t.statuses.at(-1)).toMatchObject({ state: 'queued', reason: HOOKLESS_REASON })
    // And a later refusal while it works says the same, never the promise again.
    t.event(delivery.attempt!.id, 'rejected', 'team_waiting_idle')
    expect(delivery.reason).toBe(HOOKLESS_REASON)
  })

  it('delivers what the agent read itself, withdrawing the hook\'s copy, but never under a typed attempt in flight', () => {
    const t = setup()
    const parked = t.accept()
    t.event(parked.attempt!.id, 'rejected', 'team_waiting_idle')
    const typing = t.accept(message('m0000002'))
    expect(typing.attempt).toBeDefined()
    expect(t.mailbox.read('api', ['m0000001', 'm0000002', 'm0000009'])).toEqual(['m0000001'])
    expect(parked).toMatchObject({ state: 'delivered', via: 'read' })
    expect(t.inbox.waiting('%3', parked.key)).toBe(false)
    expect(t.statuses.at(-1)).toMatchObject({ messageId: 'm0000001', state: 'delivered', via: 'read' })
    expect(typing.state).toBe('queued')
    // Read once: a second look marks nothing, and another agent's messages are never its.
    expect(t.mailbox.read('api', ['m0000001'])).toEqual([])
    expect(t.mailbox.read('web', ['m0000002'])).toEqual([])
    t.mailbox.pump()
    expect(t.delivered.filter(([, , id]) => id.includes(parked.key))).toHaveLength(1)
  })

  it('leaves the person a line in the pane for each message the hook gives the model', () => {
    // A tab's agents traded messages at their tool calls while their panes showed nothing (owner, 2026-10-12).
    const t = setup()
    const delivery = t.accept({ ...message(), fyi: true })
    const item = JSON.parse(readFileSync(join(root, 'agent-messages', 'inbox', '3', `${delivery.key}.json`), 'utf8'))
    expect(item.notice).toBe('← lead · FYI: review 3f2a9c1')
    expect(item.text).toContain('review 3f2a9c1')
    // Its first line that says something, on one line, cut short.
    expect(paneNotice({ ...message(), text: '\n  \nQuiet window   starts now\nuntil 06:16Z' })).toBe('← lead: Quiet window starts now')
    const long = paneNotice({ ...message(), text: 'x'.repeat(500) })
    expect(long).toBe(`← lead: ${'x'.repeat(NOTICE_TEXT - 1)}…`)
    expect(paneNotice({ ...message(), text: 'short' })).toBe('← lead: short')
    // The text may be another account's: no control or format character reaches the person's pane (review of B2).
    expect(paneNotice({ ...message(), text: '\u0007\u001b[2J\u001b]0;pwn\u0007a\tb\u202ec' })).toBe('← lead: [2J]0;pwna bc')
    expect(paneNotice({ ...message(), text: '' })).toBe('← lead: ')
  })

  it('never types news into an idle agent: it waits for its next tool call, or for the agent to read it', () => {
    // Six quiet-window notices in 45 minutes each woke an idle teammate for a turn that said only "noted" (2026-10-12).
    const t = setup()
    const news = t.accept({ ...message(), fyi: true })
    t.tick(PUMP_MS * 10)
    t.mailbox.pump()
    expect(t.delivered).toEqual([])
    expect(news).toMatchObject({ state: 'queued', reason: FYI_REASON })
    expect(t.inbox.waiting('%3', news.key)).toBe(true)
    t.claim('%3', news.key)
    t.mailbox.pump()
    expect(news).toMatchObject({ state: 'delivered', via: 'hook' })
    const read = t.accept({ ...message('m0000002'), fyi: true })
    expect(t.mailbox.read('api', ['m0000002'])).toEqual(['m0000002'])
    expect(read).toMatchObject({ state: 'delivered', via: 'read' })
    expect(t.delivered).toEqual([])
  })

  it('waits longer between typed attempts at an agent that keeps refusing, up to a limit, and says why', () => {
    const t = setup()
    const delivery = t.accept()
    const waits: number[] = []
    const reasons = ['team_waiting_draft', 'team_waiting_user', 'queue_full', 'permission_open', 'team_waiting_draft', 'team_waiting_draft', 'team_waiting_draft']
    for (const reason of reasons) {
      t.event(delivery.attempt!.id, 'rejected', reason)
      waits.push(delivery.nextTryAt - t.now())
      t.tick(delivery.nextTryAt - t.now())
      t.mailbox.pump()
    }
    expect(waits).toEqual([4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000])
    expect(t.statuses.map((s) => s.reason)).toEqual(expect.arrayContaining(['someone is typing in its pane', 'a dialog is open in its pane', 'queue_full', 'permission_open']))
    expect(MAX_BACKOFF_MS).toBe(30_000)
  })

  it('ends a delivery a refusal may have typed, never giving it to the hook as well', () => {
    const t = setup()
    const withheld = t.accept()
    t.event(withheld.attempt!.id, 'rejected', 'enter_withheld')
    // Left in its input box unsent: failed, never delivered, and the person is told how to send it.
    expect(withheld).toMatchObject({ state: 'failed', reason: WITHHELD })
    expect(t.statuses.at(-1)).toMatchObject({ state: 'failed', reason: WITHHELD })
    expect(t.inbox.waiting('%3', withheld.key)).toBe(false)
    for (const [id, state, reason] of [['m0000002', 'rejected', 'paste_failed'], ['m0000003', 'rejected', undefined], ['m0000004', 'unknown', undefined]] as const) {
      const delivery = t.accept(message(id))
      t.event(delivery.attempt!.id, state, reason)
      expect(delivery).toMatchObject({ state: 'delivered', reason: 'unconfirmed: inspect its pane' })
      expect(t.inbox.waiting('%3', delivery.key)).toBe(false)
    }
  })

  it('takes back an attempt the core never acknowledged, and gives it to the hook', () => {
    const t = setup()
    const delivery = t.accept()
    t.tick(ATTEMPT_MS)
    t.mailbox.pump()
    expect(delivery.attempt).toBeDefined()
    t.tick(1)
    t.mailbox.pump()
    expect(delivery.attempt).toBeUndefined()
    expect(delivery.state).toBe('queued')
    expect(t.inbox.waiting('%3', delivery.key)).toBe(true)
    expect(t.writable).toHaveBeenCalled()
  })

  it('parks an attempt the core holds behind a running turn, gives it to the hook, and types it once the turn ends', () => {
    const t = setup()
    const delivery = t.accept()
    const first = delivery.attempt!.id
    t.event(first, 'queued')
    t.tick(PARK_MS - 1)
    t.mailbox.pump()
    expect(t.mailbox.canWrite(first)).toBe(true)
    t.tick(1)
    t.mailbox.pump()
    expect(delivery.attempt).toMatchObject({ parked: true, parkedAt: t.now() })
    expect(t.mailbox.canWrite(first)).toBe(false)
    expect(t.writable).toHaveBeenCalledOnce()
    expect(t.inbox.waiting('%3', delivery.key)).toBe(true)
    expect(t.statuses.at(-1)).toMatchObject({ reason: 'working: arrives at its next tool call' })
    t.tick(PARKED_MAX_MS - 1)
    t.mailbox.pump()
    expect(delivery.attempt?.parked).toBe(true)
    // The turn ended with no tool call: the core asks, is refused, and the next attempt types it at once.
    t.event(first, 'rejected', 'team_waiting_control')
    expect(delivery.attempt).toBeUndefined()
    expect(t.inbox.waiting('%3', delivery.key)).toBe(true)
    t.mailbox.pump()
    expect(t.delivered.map(([, , id]) => id)).toEqual([first, `team:msg:${delivery.key}:2`])
  })

  it('forgets an attempt parked too long, and the core is refused if it still asks', () => {
    const t = setup()
    const delivery = t.accept()
    const first = delivery.attempt!.id
    t.event(first, 'queued')
    t.tick(PARK_MS)
    t.mailbox.pump()
    t.tick(PARKED_MAX_MS + 1)
    t.mailbox.pump()
    expect(delivery.attempt).toBeUndefined()
    expect(t.mailbox.canWrite(first)).toBe(false)
    expect(t.inbox.waiting('%3', delivery.key)).toBe(true)
  })

  it('takes a parked attempt the hook took as delivered through it, and one the core wrote anyway as typed, withdrawing the other copy', () => {
    const t = setup()
    const hooked = t.accept()
    t.event(hooked.attempt!.id, 'queued')
    t.tick(PARK_MS)
    t.mailbox.pump()
    t.claim('%3', hooked.key)
    t.mailbox.pump()
    expect(hooked).toMatchObject({ state: 'delivered', via: 'hook' })
    const written = t.accept(message('m0000002'))
    t.event(written.attempt!.id, 'queued')
    t.tick(PARK_MS)
    t.mailbox.pump()
    expect(t.inbox.waiting('%3', written.key)).toBe(true)
    t.event(written.attempt!.id, 'delivered')
    expect(written).toMatchObject({ state: 'delivered', via: 'prompt' })
    expect(t.inbox.waiting('%3', written.key)).toBe(false)
  })

  it('holds a delivery its tab does not carry for now: out of the hook\'s reach, given to no one, put back after', () => {
    // A tab turned off by a slip of the mouse failed the message waiting in it (2026-10-12).
    const t = setup()
    const waiting = t.accept({ ...message(), fyi: true })
    expect(t.inbox.waiting('%3', waiting.key)).toBe(true)
    t.hold('off for now')
    t.mailbox.refuseAll()
    expect(waiting).toMatchObject({ state: 'queued', reason: 'off for now' })
    expect(t.inbox.waiting('%3', waiting.key)).toBe(false)
    t.mailbox.pump()
    expect(t.inbox.waiting('%3', waiting.key)).toBe(false)
    t.hold(null)
    t.mailbox.pump()
    expect(t.inbox.waiting('%3', waiting.key)).toBe(true)
    expect(waiting.reason).toBe(FYI_REASON)
    // A parked attempt is back with the hook: held, it leaves the hook's reach too, and is typed again after.
    const typed = t.accept(message('m0000002'))
    t.event(typed.attempt!.id, 'queued')
    t.tick(PARK_MS)
    t.mailbox.pump()
    expect(typed.attempt?.parked).toBe(true)
    expect(t.inbox.waiting('%3', typed.key)).toBe(true)
    t.hold('off for now')
    t.mailbox.pump()
    expect(typed).toMatchObject({ state: 'queued', reason: 'off for now', attempt: undefined })
    expect(t.inbox.waiting('%3', typed.key)).toBe(false)
    t.hold(null)
    t.mailbox.pump()
    expect(t.delivered.filter(([, , id]) => id.includes(typed.key))).toHaveLength(2)
    // Refused for good, a parked one fails like any other.
    t.event(typed.attempt!.id, 'queued')
    t.tick(PARK_MS)
    t.mailbox.pump()
    t.refuse('gone')
    t.mailbox.refuseAll()
    expect(typed).toMatchObject({ state: 'failed', reason: 'gone' })
    expect(t.inbox.waiting('%3', typed.key)).toBe(false)
  })

  it('fails a delivery the directory refuses, withdrawing it from the hook; nothing moves before the directory is read', () => {
    const t = setup()
    t.setReady(false)
    const early = t.accept()
    expect(t.delivered).toHaveLength(0)
    expect(t.inbox.waiting('%3', early.key)).toBe(false)
    t.refuse('Agent Messages were turned off in this tab')
    t.mailbox.refuseAll()
    expect(early.state).toBe('queued')
    t.setReady(true)
    t.refuse(null)
    t.mailbox.pump()
    t.event(early.attempt!.id, 'rejected', 'team_waiting_idle')
    t.refuse('Agent Messages were turned off in this tab')
    t.mailbox.refuseAll()
    expect(early).toMatchObject({ state: 'failed', reason: 'Agent Messages were turned off in this tab' })
    expect(t.inbox.waiting('%3', early.key)).toBe(false)
    // In the middle of a typed attempt: left to finish, and refused at the next look.
    t.refuse(null)
    const next = t.accept(message('m0000002'))
    t.refuse('it is no longer in a tab with the sender')
    t.mailbox.refuseAll()
    expect(next.state).toBe('queued')
    t.event(next.attempt!.id, 'rejected', 'team_waiting_idle')
    t.tick(MAX_BACKOFF_MS)
    t.mailbox.pump()
    expect(next.state).toBe('failed')
  })

  it('withdraws a waiting message while its harness is stopped, and follows it into another pane or conversation', () => {
    const t = setup()
    t.setAgent(null)
    const delivery = t.accept()
    expect(delivery.pane).toBe('')
    expect(t.statuses.at(-1)).toMatchObject({ reason: 'its harness is stopped' })
    t.setAgent({ pane: '%9', session: 's2', available: true })
    t.mailbox.pump()
    expect(delivery).toMatchObject({ pane: '%9', session: 's2' })
    t.event(delivery.attempt!.id, 'rejected', 'team_waiting_idle')
    expect(t.inbox.waiting('%9', delivery.key)).toBe(true)
    // Stopped while it waits for the hook: withdrawn, as its pane number may be another's by the time it is back.
    t.setAgent({ pane: '%9', session: 's2', available: false })
    t.mailbox.pump()
    expect(t.inbox.waiting('%9', delivery.key)).toBe(false)
    expect(delivery.pane).toBe('')
    t.setAgent({ pane: '%4', session: 's2', available: true })
    t.tick(MAX_BACKOFF_MS)
    t.mailbox.pump()
    t.event(delivery.attempt!.id, 'rejected', 'team_waiting_idle')
    expect(t.inbox.waiting('%4', delivery.key)).toBe(true)
    // Another conversation in the same pane (/clear, a resume): put again, naming it.
    t.setAgent({ pane: '%4', session: 's3', available: true })
    t.mailbox.pump()
    expect(delivery.session).toBe('s3')
    expect(t.inbox.waiting('%4', delivery.key)).toBe(true)
    // Another pane: the file moves with it.
    t.setAgent({ pane: '%5', session: 's3', available: true })
    t.mailbox.pump()
    expect(t.inbox.waiting('%4', delivery.key)).toBe(false)
    expect(t.inbox.waiting('%5', delivery.key)).toBe(true)
  })

  it('fails a delivery whose message is no longer kept', () => {
    const t = setup()
    const delivery = t.accept()
    t.event(delivery.attempt!.id, 'rejected', 'team_waiting_idle')
    t.store.state.history = []
    t.tick(MAX_BACKOFF_MS)
    t.mailbox.pump()
    expect(delivery).toMatchObject({ state: 'failed', reason: 'the message is no longer kept' })
  })

  it('on start and on a new core: every attempt in flight goes back to the hook; finished deliveries are kept a day', () => {
    const t = setup()
    const inFlight = t.accept()
    const parked = t.accept(message('m0000003'))
    t.event(parked.attempt!.id, 'queued')
    t.tick(PARK_MS)
    t.mailbox.pump()
    const done = t.accept(message('m0000002'))
    t.event(done.attempt!.id, 'started')
    const old = t.accept(message('m0000004'))
    t.event(old.attempt!.id, 'started')
    old.at -= FINISHED_KEEP_MS
    t.inbox.put('%3', 'stale', { session: '', text: 'x' })
    t.inbox.reclaim('%3', 'stale')
    t.store.save()
    const restarted = new Mailbox({ store: new MessageStore(join(root, 'state')), inbox: t.inbox, agent: () => null, deliver: () => {}, refused: () => null, ready: () => true, text: () => '', changed: () => {}, now: t.now })
    restarted.start()
    restarted.start()
    restarted.stop()
    const state = new MessageStore(join(root, 'state')).state.local
    expect(state.find((d) => d.key === inFlight.key)).toMatchObject({ state: 'queued' })
    expect(state.find((d) => d.key === inFlight.key)!.attempt).toBeUndefined()
    expect(state.find((d) => d.key === parked.key)!.attempt).toBeUndefined()
    expect(state.find((d) => d.key === done.key)).toMatchObject({ state: 'delivered' })
    expect(state.find((d) => d.key === old.key)).toBeUndefined()
    expect(t.inbox.waiting('%3', inFlight.key)).toBe(true)
    expect(t.inbox.reclaimed()).toEqual([])
    // A new core: the same, in a running mailbox.
    const again = t.accept(message('m0000005'))
    expect(again.attempt).toBeDefined()
    t.mailbox.takeBackAttempts()
    expect(again.attempt).toBeUndefined()
    expect(t.inbox.waiting('%3', again.key)).toBe(true)
    t.writable.mockClear()
    t.mailbox.takeBackAttempts()
    expect(t.writable).not.toHaveBeenCalled()
  })

  it('on start, fails what may never be delivered before the directory is read and before anything goes back to a hook', () => {
    const t = setup()
    const never = t.accept(message('m0000006'))
    const fine = t.accept(message('m0000007'))
    expect(never.attempt).toBeDefined()
    t.store.save()
    const statuses: DeliveryStatus[] = []
    // The directory is not read yet (signed out, the backend down): nothing else is refused.
    const restarted = new Mailbox({ store: new MessageStore(join(root, 'state')), inbox: t.inbox, agent: () => null, deliver: () => {}, refused: () => 'refused', ready: () => false,
      forbidden: (d) => (d.messageId === 'm0000006' ? 'it was sent outside any tab' : null), text: () => '', changed: (s) => { statuses.push(s) }, now: t.now })
    restarted.start()
    restarted.stop()
    const state = new MessageStore(join(root, 'state')).state.local
    expect(state.find((d) => d.key === never.key)).toMatchObject({ state: 'failed', reason: 'it was sent outside any tab' })
    expect(statuses).toEqual([expect.objectContaining({ messageId: 'm0000006', state: 'failed' })])
    // Its attempt in flight did not go back to the hook; the other one's did.
    expect(t.inbox.waiting('%3', never.key)).toBe(false)
    expect(state.find((d) => d.key === fine.key)).toMatchObject({ state: 'queued' })
    expect(t.inbox.waiting('%3', fine.key)).toBe(true)
  })

  it('pumps on its own every few seconds once started, and stops', () => {
    vi.useFakeTimers()
    const t = setup()
    t.mailbox.start()
    const pump = vi.spyOn(t.mailbox, 'pump')
    vi.advanceTimersByTime(PUMP_MS)
    expect(pump).toHaveBeenCalledOnce()
    pump.mockImplementation(() => { throw new Error('a bad look') })
    vi.advanceTimersByTime(PUMP_MS)
    t.mailbox.stop()
    t.mailbox.stop()
    vi.advanceTimersByTime(PUMP_MS * 3)
    expect(pump).toHaveBeenCalledTimes(2)
  })

  it('asleep, looks only until nothing waits, then stops by itself; paused, looks at nothing until resumed', () => {
    // Off costs nothing: Agent Messages run in the edge host on every computer, and a look every two seconds at a
    // mailbox with nothing in it was a timer for nothing (2026-10-12).
    vi.useFakeTimers()
    let asleep = false
    const t = setup({ asleep: () => asleep })
    t.mailbox.resume()
    const pump = vi.spyOn(t.mailbox, 'pump')
    vi.advanceTimersByTime(PUMP_MS * 2)
    expect(pump, 'not started: nothing to look at').not.toHaveBeenCalled()
    t.mailbox.start()
    t.mailbox.resume()
    t.setAgent(null)
    const delivery = t.accept()
    pump.mockClear()
    asleep = true
    expect(t.mailbox.waiting()).toBe(true)
    vi.advanceTimersByTime(PUMP_MS * 2)
    expect(pump).toHaveBeenCalledTimes(2)
    // What waited has settled: one more look, and none after it.
    t.refuse('Agent Messages were turned off on its computer')
    vi.advanceTimersByTime(PUMP_MS)
    expect(delivery.state).toBe('failed')
    expect(t.mailbox.waiting()).toBe(false)
    vi.advanceTimersByTime(PUMP_MS * 5)
    expect(pump).toHaveBeenCalledTimes(3)
    // Awake, it looks with nothing waiting too; paused, not at all.
    asleep = false
    t.mailbox.resume()
    vi.advanceTimersByTime(PUMP_MS * 2)
    expect(pump).toHaveBeenCalledTimes(5)
    t.mailbox.pause()
    t.mailbox.pause()
    vi.advanceTimersByTime(PUMP_MS * 2)
    expect(pump).toHaveBeenCalledTimes(5)
  })

  it('keeps going when the inbox cannot be written or the store saved', () => {
    const t = setup()
    vi.spyOn(t.inbox, 'put').mockImplementation(() => { throw new Error('disk full') })
    vi.spyOn(t.store, 'save').mockImplementation(() => { throw new Error('disk full') })
    const delivery = t.accept()
    expect(delivery.state).toBe('queued')
    t.mailbox.pump()
  })
})
