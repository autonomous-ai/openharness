import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OmpNormalizer, lastOmpTurnText, ompMessagesToEvents, ompToolName, windowOmpLines } from './normalizer.js'
import { ompSessionFolder } from '../../lib/sessionRepair.js'

// Recorded with omp 18.12.6 (anthropic/claude-sonnet-5-5) in tmux, lightly redacted: omp's own context
// records (`custom`, `custom_message`) are emptied, the credential pin hash is zeroed, and opaque
// signatures and provider payloads are dropped. Six turns: two bash tool calls each ended by `stop`, a
// plain `stop`, two turns the user cancelled with Escape (`aborted`, "Interrupted by user"), and a last `stop`.
const SESSION = readFileSync(new URL('../../lib/__fixtures__/omp-session.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean)
// Five records from a real session where omp stopped its own stream to inject a rule (`aborted`,
// "TTSR matched rule: …") and carried on to `stop`, plus that session's title and header. Text replaced.
const RULE_ABORT = readFileSync(new URL('../../lib/__fixtures__/omp-session-rule-abort.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean)

function live(lines: string[]) {
  const normalizer = new OmpNormalizer('live')
  return { normalizer, events: lines.flatMap((line) => normalizer.ingest(line)) }
}

const kinds = (lines: string[]) => live(lines).events
  .filter((event) => event.type === 'turn_started' || event.type === 'turn_ended')
  .map((event) => event.type === 'turn_ended' && (event.payload as { aborted?: boolean }).aborted ? 'ended(aborted)' : event.type)

describe('OmpNormalizer: the recorded session, live', () => {
  it('opens and closes every one of the six turns, the two Escapes as aborted', () => {
    const { normalizer } = live(SESSION)
    expect(kinds(SESSION)).toEqual([
      'turn_started', 'turn_ended',
      'turn_started', 'turn_ended',
      'turn_started', 'turn_ended',
      'turn_started', 'ended(aborted)',
      'turn_started', 'ended(aborted)',
      'turn_started', 'turn_ended',
    ])
    expect(normalizer.turnOpen).toBe(false)
  })

  it('streams the first turn as omp wrote it: prompt, bash call, its result, the answer, the end', () => {
    const firstTurn = SESSION.slice(0, 13)
    const { events } = live(firstTurn)
    expect(events.map((event) => event.type)).toEqual(['turn_started', 'tool_start', 'tool_end', 'text_delta', 'turn_ended'])
    expect(events[0]).toMatchObject({ payload: { userMessage: expect.stringContaining('ls -1') } })
    const start = events[1] as { payload: { id: string; tool: string; input: { command?: string } } }
    expect(start.payload.tool).toBe('Bash')
    expect(start.payload.input.command).toContain('ls -1')
    expect(events[2]).toMatchObject({ type: 'tool_end', payload: { id: start.payload.id, tool: 'Bash', isError: false, output: expect.stringContaining('notes.txt') } })
    expect(events[3]).toMatchObject({ type: 'text_delta', payload: { content: expect.stringContaining('3 files') } })
  })

  it('reads thinking from its own `thinking` field', () => {
    const thinking = live(SESSION).events.filter((event) => event.type === 'thinking_delta')
    expect(thinking.length).toBeGreaterThan(0)
    for (const event of thinking) expect((event.payload as { content: string }).content).not.toBe('')
  })

  it('keeps the turn open while a tool runs, and closes it on the user\'s Escape with nothing after', () => {
    expect(live(SESSION.slice(0, 9)).normalizer.turnOpen).toBe(true) // the assistant asked for bash
    const cancelled = SESSION.findIndex((line) => line.includes('"Interrupted by user"'))
    expect(cancelled).toBeGreaterThan(0)
    expect(live(SESSION.slice(0, cancelled)).normalizer.turnOpen).toBe(true)
    expect(live(SESSION.slice(0, cancelled + 1)).normalizer.turnOpen).toBe(false)
  })

  it('ignores omp\'s title, header and own context records', () => {
    const normalizer = new OmpNormalizer('live')
    for (const line of SESSION.slice(0, 6)) expect(normalizer.ingest(line)).toEqual([])
    expect(normalizer.ingest('not json')).toEqual([])
  })
})

describe('OmpNormalizer: omp\'s own rule interruption is not the end of a turn', () => {
  it('stays open through the `aborted` rule injection and closes on the `stop` that follows', () => {
    const aborted = RULE_ABORT.findIndex((line) => line.includes('"TTSR matched rule'))
    expect(aborted).toBeGreaterThan(0)
    expect(live(RULE_ABORT.slice(0, aborted + 1)).normalizer.turnOpen).toBe(true)
    expect(kinds(RULE_ABORT)).toEqual(['turn_started', 'turn_ended'])
    expect(live(RULE_ABORT).normalizer.turnOpen).toBe(false)
  })
})

describe('omp history, recap and paging', () => {
  it('replays a whole session as user messages and tool rows, ending in done', () => {
    const events = ompMessagesToEvents(SESSION)
    expect(events.filter((event) => event.type === 'user_message')).toHaveLength(6)
    expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(2)
    expect(events.map((event): string => event.type).filter((type) => type.startsWith('turn_'))).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'done', payload: { result: 'success' } })
  })

  it('recaps the last prompt and the text that followed it', () => {
    const first = lastOmpTurnText(SESSION.slice(0, 13))
    expect(first).toEqual({ userMessage: expect.stringContaining('ls -1'), assistantText: expect.stringContaining('3 files') })
    expect(lastOmpTurnText(RULE_ABORT)).toEqual({
      userMessage: 'Clean up the scratch folder.',
      assistantText: 'I will remove\n\nI removed the scratch files.',
    })
  })

  it('pages back to a user message, and refuses another engine\'s cursor', () => {
    const page = windowOmpLines(SESSION, { limit: 4 })
    expect(page.hasMore).toBe(true)
    expect(page.oldestCursor).toMatch(/^omp:\d+$/)
    expect(JSON.parse(page.window[0]).message.role).toBe('user')
    expect(windowOmpLines(SESSION, { limit: 4, before: 'pi:3' }).staleCursor).toBe(true)
  })

  it('names the tools that are the same tool as a card, and keeps the rest as omp calls them', () => {
    expect(ompToolName('bash')).toBe('Bash')
    expect(ompToolName('web_search')).toBe('WebSearch')
    expect(ompToolName('eval')).toBe('Eval')
    expect(ompToolName('todo')).toBe('Todo')
  })
})

describe('ompSessionFolder', () => {
  it('names a folder by the path under home, else the absolute path (measured on 34 of 34 folders)', () => {
    expect(ompSessionFolder('/home/me/src/app', '/home/me')).toBe('-src-app')
    expect(ompSessionFolder('/tmp/omp-fixture', '/home/me')).toBe('-tmp-omp-fixture')
    expect(ompSessionFolder('/home/meandyou/x', '/home/me')).toBe('-home-meandyou-x')
  })
})
