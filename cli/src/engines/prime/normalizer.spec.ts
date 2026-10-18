import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiNormalizer } from '../pi/normalizer.js'
import {
  PrimeNormalizer, lastPrimeTurnText, primeMessagesToEvents, primeSessionMeta, primeToolName, windowPrimeLines,
} from './normalizer.js'

// A REAL session (prime-agent 0.9.5, anthropic/claude-opus-5-5), lightly redacted (home path, the startup
// memory digest): "Reply with the single word: ready"; then a prompt that spawns an RLM child with
// `rlm.spawn`; the child's `agent_message` reply, which starts a turn with no user message; and the
// `rlm_child_terminal_notice` after the child was deleted, which starts another.
const LINES = readFileSync(join(import.meta.dirname, '../../lib/__fixtures__/prime-session.jsonl'), 'utf8').split('\n').filter(Boolean)

function live(lines: string[]) {
  const normalizer = new PrimeNormalizer('live')
  return { normalizer, events: lines.flatMap((line) => normalizer.ingest(line)) }
}
const turns = (events: { type: string }[]) => events.filter((e) => e.type === 'turn_started' || e.type === 'turn_ended').map((e) => e.type)
const notice = (customType: string, display = true) => JSON.stringify({
  type: 'custom_message', customType, content: `[${customType}]\n\nsomething happened`, display, details: {}, id: 'c1', parentId: null, timestamp: '2026-10-18T22:52:00.000Z',
})
const reply = (text: string) => JSON.stringify({
  type: 'message', id: 'a1', parentId: 'c1', timestamp: '2026-10-18T22:52:01.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
})

describe('PrimeNormalizer — the recorded session', () => {
  it('opens and closes every turn, including the two no person typed', () => {
    const { normalizer, events } = live(LINES)
    expect(turns(events)).toEqual(['turn_started', 'turn_ended', 'turn_started', 'turn_ended',
      'turn_started', 'turn_ended', 'turn_started', 'turn_ended'])
    const started = events.filter((e) => e.type === 'turn_started').map((e) => (e.payload as { userMessage: string }).userMessage)
    expect(started[0]).toBe('Reply with the single word: ready')
    expect(started[2]).toBe('[agent-message from child:counter]\n\ndone')
    expect(started[3]).toMatch(/^\[child-exited: cancelled child:counter\]/)
    expect(normalizer.turnOpen).toBe(false)
  })

  it('is what Pi’s reader gets wrong on the same file: two turns stream with no turn at all', () => {
    const pi = new PiNormalizer('live')
    const events = LINES.flatMap((line) => pi.ingest(line))
    expect(turns(events)).toEqual(['turn_started', 'turn_ended', 'turn_started', 'turn_ended'])
  })

  it('labels the ipython REPL as Python and keeps its code as the input', () => {
    const { events } = live(LINES)
    const start = events.find((e) => e.type === 'tool_start')
    expect(start).toMatchObject({ payload: { tool: 'Python', input: { code: expect.stringContaining('rlm.spawn(') } } })
    expect(primeToolName('ipython')).toBe('Python')
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(2)
  })

  it('folds a finished conversation closed: nothing is left for a hook to close', () => {
    const { normalizer } = live(LINES)
    expect(normalizer.turnOpen).toBe(false)
    const { normalizer: midTurn } = live(LINES.slice(0, LINES.findIndex((l) => l.includes('"toolCall"')) + 1))
    expect(midTurn.turnOpen).toBe(true)
  })

  it('ignores hidden custom messages (the startup memory digest)', () => {
    const digest = LINES.find((l) => l.includes('"harness_digest"'))!
    expect(new PrimeNormalizer('live').ingest(digest)).toEqual([])
  })
})

describe('PrimeNormalizer — custom messages that are only notices', () => {
  it('does not open a turn on a notice no reply follows', () => {
    const normalizer = new PrimeNormalizer('live')
    expect(normalizer.ingest(notice('refinement_outcome'))).toEqual([])
    expect(normalizer.turnOpen).toBe(false)
  })

  it('opens the turn late when a reply proves the notice was a prompt', () => {
    const normalizer = new PrimeNormalizer('live')
    normalizer.ingest(notice('goal_context'))
    const events = normalizer.ingest(reply('on it'))
    expect(turns(events)).toEqual(['turn_started', 'turn_ended'])
    expect(events[0]).toMatchObject({ payload: { userMessage: '[goal_context]\n\nsomething happened' } })
  })

  it('treats a known prompt arriving mid-turn as part of that turn', () => {
    const { normalizer } = live(LINES.slice(0, LINES.findIndex((l) => l.includes('"toolCall"')) + 1))
    expect(normalizer.ingest(notice('agent_message'))).toEqual([])
    expect(normalizer.turnOpen).toBe(true)
  })
})

describe('Prime history, recap and pages', () => {
  it('replays prompting custom messages as the turn’s opening message', () => {
    const users = primeMessagesToEvents(LINES).filter((e) => e.type === 'user_message').map((e) => (e.payload as { content: string }).content)
    expect(users).toHaveLength(4)
    expect(users[2]).toBe('[agent-message from child:counter]\n\ndone')
  })

  it('recaps the last turn from the custom message that started it', () => {
    const last = lastPrimeTurnText(LINES)
    expect(last?.userMessage).toMatch(/^\[child-exited: cancelled child:counter\]/)
    expect(last?.assistantText).toContain('cancelled')
  })

  it('reads the header for id and cwd', () => {
    expect(primeSessionMeta(LINES)).toEqual({ id: '01a15135-c442-71eb-ab4c-34771f76c342', cwd: '/tmp/prime-probe-ws' })
  })

  it('pages with prime: cursors, snapping back to the message that started a turn', () => {
    const page = windowPrimeLines(LINES, { limit: 2 })
    expect(page.oldestCursor).toMatch(/^prime:\d+$/)
    const first = JSON.parse(page.window[0])
    expect(first.type === 'custom_message' || first.message?.role === 'user').toBe(true)
    expect(windowPrimeLines(LINES, { limit: 2, before: 'pi:3' }).staleCursor).toBe(true)
  })
})
