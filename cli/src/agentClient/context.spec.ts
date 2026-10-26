import { describe, expect, it } from 'vitest'
import { buildContext, formatContext, type ContextInput } from './context.js'

const LIMITS = { livePerHarness: 4, perWindow: 20, windowMs: 600_000, depth: 1 }
const lead = { machineId: 'm', agentId: '94d984ee-1111', name: 'lead', engine: 'claude' }
const input = (over: Partial<ContextInput> = {}): ContextInput => ({
  caller: lead, orphan: false, machine: 'Mac Auto', signedIn: true, switchOn: true, check: null,
  count: { open: 1, starts: 3, depth: 0, oldestStartAt: null }, limits: LIMITS, machines: [], closeStep: 'harness close <name>', ...over,
})
const office = { machineId: 'o', label: 'office', status: 'running', current: false }
const lines = (over: Partial<ContextInput>) => formatContext(buildContext(input(over))).split('\n')

describe('the context block', () => {
  it('an agent that may start: who and where, yes, and its counts', () => {
    const c = buildContext(input({ machines: [office, { machineId: 'm', label: 'Mac Auto', status: 'running', current: true }] }))
    expect(formatContext(c)).toBe([
      'You: Claude Code "lead" (94d984ee), inside Harness, on Mac Auto.',
      'Can start harnesses: yes.',
      'Yours: 1 open of 4 · 3 of 20 starts in the last 10 minutes · other machines: office (running)',
    ].join('\n'))
    expect(c.caller).toEqual({ kind: 'agent', agent: 'Claude Code', name: 'lead', id: '94d984ee-1111', inside: true, machine: 'Mac Auto' })
    expect(c.canStart).toEqual({ ok: true, reason: null, message: '', fix: null, fixBy: null })
    expect(c.quota).toEqual({ open: 1, maxOpen: 4, starts: 3, maxStarts: 20, windowMinutes: 10, depth: 0, maxDepth: 1, nextStartAt: null })
    expect(c.machines).toEqual([{ name: 'office', state: 'running' }])
  })

  it('the switch off: the person turns it on, and how; checked before the limits', () => {
    const c = buildContext(input({ switchOn: false, check: { reason: 'DEPTH', message: 'x' } }))
    // The agent asks them with its own tool, and runs it only after their yes: people do not open a terminal for this.
    expect(formatContext(c).split('\n')[1]).toBe('Can start harnesses: no. The person has not turned on "Agents can start other agents". Ask them, with your tool for asking them (Claude Code: AskUserQuestion; Codex: request_user_input) or in your reply; only after their yes, run: harness settings agents-start-agents on --person-said-yes')
    expect(c.canStart).toMatchObject({ ok: false, reason: 'SWITCH_OFF', fixBy: 'person' })
  })

  it('signed out: sign in first', () => {
    expect(lines({ signedIn: false, switchOn: false })[1]).toBe('Can start harnesses: no. This computer is signed out of Harness, and starting is the account\'s choice. Ask the person to run, in their own terminal: harness login, then harness settings agents-start-agents on')
  })

  it('each limit, in its own words', () => {
    expect(lines({ check: { reason: 'DEPTH', message: 'x' } })[1]).toBe('Can start harnesses: no. An agent started you, and only one level is allowed. Do the work yourself, or say in your answer what else is needed.')
    expect(lines({ check: { reason: 'OPEN_LIMIT', message: 'x' }, count: { open: 4, starts: 4, depth: 0, oldestStartAt: null } })[1])
      .toBe('Can start harnesses: no. You have 4 open, the most. To free a place: harness close <name>')
    expect(lines({ check: { reason: 'MACHINE_LIMIT', message: 'Agents have 40 harnesses running on this machine, the most allowed. Close some first.' } })[1])
      .toBe('Can start harnesses: no. Agents have 40 harnesses running on this machine, the most allowed. Close some first.')
    const rate = buildContext(input({ check: { reason: 'START_RATE', message: 'x' }, count: { open: 0, starts: 20, depth: 0, oldestStartAt: Date.parse('2026-10-15T07:22:00Z') } }))
    expect(formatContext(rate).split('\n')[1]).toMatch(/^Can start harnesses: not until \d\d:\d\d \(20 starts in 10 minutes\)\.$/)
    expect(rate.quota?.nextStartAt).toBe('2026-10-15T07:32:00.000Z')
  })

  it('outside Harness: no pane, nothing can message it', () => {
    const outside = { machineId: 'm', agentId: 'claude-code:abc', name: 'Claude Code', engine: 'claude', outside: true }
    const c = buildContext(input({ caller: outside }))
    expect(formatContext(c).split('\n')[0]).toBe('You: Claude Code, outside Harness, on Mac Auto. Nothing can message you here.')
    expect(c.caller).toMatchObject({ kind: 'agent', agent: 'Claude Code', name: null, id: null, inside: false })
  })

  it('a pane whose harness is gone: may only look', () => {
    expect(lines({ caller: null, orphan: true, count: null })).toEqual([
      'You: an agent in a Harness pane whose harness is gone, on Mac Auto.',
      'Can start harnesses: no. This pane\'s harness is no longer running. Only the person can start or close harnesses here.',
    ])
  })

  it('the person: one line, no limits', () => {
    const c = buildContext(input({ caller: null, count: null }))
    expect(formatContext(c)).toBe('You: the person, on Mac Auto.')
    expect(c).toMatchObject({ caller: { kind: 'person' }, canStart: null, quota: null })
  })

  it('keeps line 1 one line for an odd name, and line 3 short for many machines', () => {
    const odd = { ...lead, name: `a "quoted"\nname ${'x'.repeat(200)}` }
    const first = lines({ caller: odd })[0]
    expect(first).not.toContain('\n')
    expect(first.length).toBeLessThan(120)
    const ten = Array.from({ length: 10 }, (_, i) => ({ machineId: `o${i}`, label: `box${i}`, status: 'running', current: false }))
    expect(lines({ machines: ten })[2]).toBe('Yours: 1 open of 4 · 3 of 20 starts in the last 10 minutes · other machines: box0 (running), box1 (running), box2 (running), box3 (running), +6 more')
  })
})
