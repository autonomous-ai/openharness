import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamsEvent } from './api.js'
import { createTeamsLink, KEPT_BYTES, KEPT_EVENTS, teamsOutOfProcess } from './teamsLink.js'

const TEAM_A = 'a'.repeat(32)
const TEAM_B = 'b'.repeat(32)

function setup(over: Partial<Parameters<typeof createTeamsLink>[0]> = {}) {
  const sent: TeamsEvent[] = []
  let connected = true
  const lines: string[] = []
  let clock = 1_000
  const link = createTeamsLink({
    notify: vi.fn((frame) => { if (connected) sent.push((frame.payload as { event: TeamsEvent }).event); return connected }),
    now: () => clock,
    newId: () => 'core-1',
    log: (line) => lines.push(line),
    ...over,
  })
  return {
    link, scopes: link.scopes, sent, lines,
    down: () => { connected = false },
    up: () => { connected = true },
    tick: (ms: number) => { clock += ms },
    hello: (payload: Record<string, unknown>) => link.answer('hello', payload) as { core: string; reset: boolean; base: number; events: TeamsEvent[] },
    ack: (applied: number, scopes: Record<string, string | null> = {}, core = 'core-1') => link.answer('ack', { core, applied, scopes }),
  }
}

describe('the teams\' prompt scopes in their own process, as the core keeps them', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a write gets its undo at once, never a fault, whether or not the process is there', () => {
    const { scopes, sent, down, hello } = setup()
    down()
    const undo = scopes.prepare('agent-1', 'hello team', 'tab-1', 'team:delivery')
    expect(typeof undo).toBe('function')
    undo()
    expect(sent).toEqual([])
    // Kept for the process all the same: the write and its undo, in order.
    expect(hello({ core: null }).events).toEqual([
      { kind: 'prepare', agentId: 'agent-1', text: 'hello team', tabId: 'tab-1', deliveryId: 'team:delivery', seq: 1, core: 'core-1', at: 1_000 },
      { kind: 'unprepare', agentId: 'agent-1', of: 1, seq: 2, core: 'core-1', at: 1_000 },
    ])
  })

  it('tells the process every change, numbered in order and stamped with when it happened', () => {
    const { scopes, sent, tick } = setup()
    scopes.started('agent-1', 'hello team', 'hook', 'claude')
    tick(5)
    scopes.started('agent-1', 'from the transcript')
    scopes.raw('agent-1', new Uint8Array([104, 105, 13]), 'tab-1')
    scopes.raw('agent-1', new TextEncoder().encode('pasted'), 'tab-1', true)
    scopes.replied('agent-1', TEAM_A, TEAM_B)
    scopes.forget('agent-1')
    expect(sent.map(({ seq, kind, at }) => [seq, kind, at])).toEqual([
      [1, 'started', 1_000], [2, 'started', 1_005], [3, 'raw', 1_005], [4, 'raw', 1_005], [5, 'replied', 1_005], [6, 'forget', 1_005],
    ])
    expect(sent[0]).toMatchObject({ text: 'hello team', source: 'hook', engine: 'claude' })
    expect(sent[1]).toMatchObject({ source: 'transcript' })
    expect(sent[2]).toMatchObject({ bytes: Buffer.from('hi\r').toString('base64'), tabId: 'tab-1', pasted: false })
    expect(sent[3]).toMatchObject({ bytes: Buffer.from('pasted').toString('base64'), pasted: true })
    expect(sent[4]).toMatchObject({ teamId: TEAM_A, questionId: TEAM_B })
  })

  it('answers an agent\'s team as the process reported it, and none while a change to it is on its way', () => {
    const { scopes, ack } = setup()
    expect(scopes.current('agent-1')).toBeNull()
    scopes.prepare('agent-1', 'hello team', 'tab-1')
    scopes.started('agent-1', 'hello team', 'hook')
    // Not yet applied by the process: no team rather than a stale one.
    expect(scopes.current('agent-1')).toBeNull()
    expect(ack(2, { 'agent-1': TEAM_A })).toEqual({ kept: true })
    expect(scopes.current('agent-1')).toBe(TEAM_A)
    // Writes and keys move no team: the answer stands.
    scopes.prepare('agent-1', 'next', 'tab-2')
    scopes.raw('agent-1', new Uint8Array([97]))
    expect(scopes.current('agent-1')).toBe(TEAM_A)
    scopes.started('agent-1', 'next', 'hook')
    expect(scopes.current('agent-1')).toBeNull()
    // A report from before that start is not the agent's team now.
    ack(4, { 'agent-1': TEAM_A })
    expect(scopes.current('agent-1')).toBeNull()
    ack(5, { 'agent-1': TEAM_B })
    expect(scopes.current('agent-1')).toBe(TEAM_B)
  })

  it('forgets an agent the process reports with no team', () => {
    const { scopes, ack } = setup()
    scopes.started('agent-1', 'hello', 'hook')
    ack(1, { 'agent-1': TEAM_A })
    scopes.forget('agent-1')
    ack(2, { 'agent-1': null })
    expect(scopes.current('agent-1')).toBeNull()
  })

  it('takes the report for an agent that was only written to: whatever team it had stands', () => {
    const { scopes, ack } = setup()
    scopes.prepare('agent-2', 'a message', 'tab-1')
    ack(1, { 'agent-2': TEAM_A })
    expect(scopes.current('agent-2')).toBe(TEAM_A)
  })

  it('ignores what another core\'s process acknowledges, and acknowledgements that say nothing', () => {
    const { link, scopes, ack } = setup()
    scopes.started('agent-1', 'hello', 'hook')
    expect(ack(1, { 'agent-1': TEAM_A }, 'core-0')).toEqual({ kept: false })
    expect(link.answer('ack', { core: 'core-1' })).toEqual({ kept: false })
    expect(scopes.current('agent-1')).toBeNull()
    expect(link.answer('ack', { core: 'core-1', applied: 1, scopes: 'nothing' })).toEqual({ kept: true })
    expect(scopes.current('agent-1')).toBeNull()
  })

  it('gives a process that reconnects exactly the events it lacks', () => {
    const { scopes, hello, ack, down, up } = setup()
    scopes.prepare('agent-1', 'one', 'tab-1')
    scopes.started('agent-1', 'one', 'hook')
    ack(1)
    down()
    scopes.prepare('agent-1', 'two', 'tab-1')
    up()
    // It applied the second event before its connection dropped, without saying so yet.
    const answer = hello({ core: 'core-1', applied: 2 })
    expect(answer).toMatchObject({ core: 'core-1', reset: false, base: 2 })
    expect(answer.events.map((event) => event.seq)).toEqual([3])
  })

  it('starts a new process over, with everything this side still holds', () => {
    const { scopes, hello, ack } = setup()
    scopes.started('agent-1', 'one', 'hook')
    ack(1, { 'agent-1': TEAM_A })
    scopes.prepare('agent-2', 'two', 'tab-1')
    expect(scopes.current('agent-1')).toBe(TEAM_A)
    const answer = hello({ core: null, applied: 0 })
    expect(answer).toMatchObject({ reset: true, base: 1 })
    expect(answer.events.map((event) => event.seq)).toEqual([2])
    // What the old process knew went with it: no team, not the one it had.
    expect(scopes.current('agent-1')).toBeNull()
    // With nothing held, it starts after the last event this core numbered.
    ack(2)
    expect(hello({ core: 'core-0', applied: 7 })).toEqual({ core: 'core-1', reset: true, base: 2, events: [] })
  })

  it('starts over a process that claims more than this core said, or missed events this side could not keep', () => {
    const { scopes, hello, lines, down, ack } = setup({ keptEvents: 3 })
    scopes.started('agent-1', 'one', 'hook')
    expect(hello({ core: 'core-1', applied: 5 })).toMatchObject({ reset: true, base: 0 })
    ack(1)
    down()
    for (let n = 0; n < 5; n++) scopes.raw('agent-1', new Uint8Array([97 + n]))
    expect(lines).toEqual(['[teams] kept 3 events or 16777216 bytes for the teams process; it will start over when it is back'])
    const answer = hello({ core: 'core-1', applied: 1 })
    expect(answer).toMatchObject({ reset: true, base: 3 })
    expect(answer.events.map((event) => event.seq)).toEqual([4, 5, 6])
    // Said once an outage: the next one says it again.
    for (let n = 0; n < 4; n++) scopes.raw('agent-1', new Uint8Array([97]))
    expect(lines).toHaveLength(2)
  })

  it('keeps events by size as well as by number, and lets go of what the process has', () => {
    const { scopes, hello, ack, down } = setup({ keptBytes: 2_000 })
    down()
    scopes.prepare('agent-1', 'x'.repeat(1_500), 'tab-1')
    scopes.prepare('agent-1', 'y'.repeat(1_500), 'tab-1')
    expect(hello({ core: null }).events.map((event) => event.seq)).toEqual([2])
    ack(2)
    expect(hello({ core: 'core-1', applied: 2 })).toMatchObject({ reset: false, events: [] })
  })

  it('keeps nothing for a process no one asked for, and everything from the moment teams is on', () => {
    const { link, scopes, sent, hello } = setup({ off: true })
    const undo = scopes.prepare('agent-1', 'typed while teams was off', 'tab-1')
    undo()
    scopes.started('agent-1', 'typed while teams was off', 'hook')
    expect(sent).toEqual([])
    expect(hello({ core: null }).events).toEqual([])
    link.on()
    scopes.forget('agent-1')
    expect(sent.map((event) => [event.seq, event.kind])).toEqual([[1, 'forget']])
  })

  it('says a team\'s delivery may be written only while the process last said so, and not past when it said', () => {
    const { link, scopes, tick } = setup()
    expect(scopes.canWrite('team:d1')).toBe(false)
    expect(link.answer('writable', { deliveries: { 'team:d1': 1_000 + 3_000, 'team:d2': 'soon' } })).toEqual({})
    expect(scopes.canWrite('team:d1')).toBe(true)
    expect(scopes.canWrite('team:d2')).toBe(false)
    tick(3_000)
    expect(scopes.canWrite('team:d1')).toBe(false)
    link.answer('writable', { deliveries: { 'team:d1': 99_999 } })
    expect(scopes.canWrite('team:d1')).toBe(true)
    // A report replaces the last whole.
    link.answer('writable', {})
    expect(scopes.canWrite('team:d1')).toBe(false)
  })

  it('answers the scopes\' own questions, from the apps and from the teams beside them, as it did while they were away', () => {
    const { link, scopes, ack, sent } = setup()
    scopes.prepare('agent-1', 'hello team', 'tab-1')
    scopes.started('agent-1', 'hello team', 'hook')
    ack(2, { 'agent-1': TEAM_A })
    const replies: Array<Record<string, unknown>> = []
    const owner = { owner: true }
    expect(link.route('team_delivery', { action: 'prompt_scope', agentId: 'agent-1' }, owner, (r) => replies.push(r))).toBe(true)
    expect(link.route('team_delivery', { action: 'prompt_replied', agentId: 'agent-1', teamId: TEAM_A, questionId: TEAM_B }, owner, (r) => replies.push(r))).toBe(true)
    expect(link.route('team_delivery', { action: 'prompt_scope', agentId: 'agent-1' }, { owner: false }, (r) => replies.push(r))).toBe(true)
    expect(link.route('team_delivery', { action: 'prompt_scope', agentId: '../x' }, owner, (r) => replies.push(r))).toBe(true)
    expect(link.route('team_delivery', { action: 'prompt_replied', agentId: 'agent-1', teamId: 'nope', questionId: TEAM_B }, owner, (r) => replies.push(r))).toBe(true)
    expect(link.route('team_delivery', { action: 'prompt_replied', agentId: 'agent-1', teamId: TEAM_A }, owner, (r) => replies.push(r))).toBe(true)
    expect(replies).toEqual([
      { teamId: TEAM_A },
      { ok: true },
      { error: 'OWNER_REQUIRED', detail: 'Team communication requires an owner connection.' },
      { error: 'INVALID_REQUEST', detail: 'agentId: Invalid' },
      { error: 'INVALID_REQUEST', detail: 'teamId: Invalid' },
      { error: 'INVALID_REQUEST', detail: 'questionId: Invalid' },
    ])
    expect(sent.at(-1)).toMatchObject({ kind: 'replied', teamId: TEAM_A, questionId: TEAM_B })
    // Every other request goes on to the teams.
    expect(link.route('team_delivery', { action: 'send' }, owner, (r) => replies.push(r))).toBe(false)
    expect(link.route('team', { action: 'prompt_scope' }, owner, (r) => replies.push(r))).toBe(false)
    // The same two, asked by the teams beside the scopes.
    expect(link.answer('team_scope', { agentId: 'agent-2' })).toEqual({ teamId: null })
    expect(link.answer('team_replied', { agentId: 'agent-1', teamId: TEAM_A, questionId: TEAM_B })).toEqual({ ok: true })
  })

  it('refuses a question it does not know', () => {
    expect(setup().link.answer('agents', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })

  it('numbers its events within a life of its own, on the clock, by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const events: TeamsEvent[] = []
    const link = createTeamsLink({ notify: (frame) => { events.push((frame.payload as { event: TeamsEvent }).event); return true }, keptEvents: 1 })
    link.scopes.forget('agent-1')
    link.scopes.forget('agent-2')
    expect(events[0].core).toMatch(/^[0-9a-f-]{36}$/)
    expect(Math.abs(events[0].at - Date.now())).toBeLessThan(5_000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[teams] kept 1 events'))
    expect(KEPT_EVENTS).toBe(10_000)
    expect(KEPT_BYTES).toBe(16 * 1024 * 1024)
  })

  it('runs the scopes and the teams beside them in one process or both in the core\'s, and says so when named apart', () => {
    const log = vi.fn()
    expect(teamsOutOfProcess(new Set(['search', 'teams', 'collaboration']), log)).toBe(true)
    expect(teamsOutOfProcess(new Set(['search']), log)).toBe(false)
    expect(log).not.toHaveBeenCalled()
    const apart = new Set(['search', 'collaboration'])
    expect(teamsOutOfProcess(apart, log)).toBe(false)
    expect([...apart]).toEqual(['search'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('one process or none'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(teamsOutOfProcess(new Set(['teams']))).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })
})
