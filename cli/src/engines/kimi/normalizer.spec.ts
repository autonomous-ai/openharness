import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  KimiNormalizer,
  kimiMessagesToEvents,
  kimiRecord,
  kimiToolName,
  lastKimiTurnText,
} from './normalizer.js'

/**
 * Real Kimi Code CLI 2.1.1 sessions (recorded 2026-11-09, macOS): `kimi -p` in a scratch folder —
 * turn 1 wrote hello.txt and ran `ls`; turn 2 is the SAME session resumed with `kimi -S <id> -p`,
 * appended in place. Only the system prompt in profile.bind was redacted.
 */
function lines(): string[] {
  const path = fileURLToPath(new URL('../../lib/__fixtures__/kimi-session.jsonl', import.meta.url))
  return readFileSync(path, 'utf-8').split('\n').filter((line) => line.trim())
}

/** Real session whose turn spawned one `Task` sub-agent. */
function subagentLines(): string[] {
  const path = fileURLToPath(new URL('../../lib/__fixtures__/kimi-session-subagent.jsonl', import.meta.url))
  return readFileSync(path, 'utf-8').split('\n').filter((line) => line.trim())
}

function liveEvents(records: string[] = lines()) {
  const normalizer = new KimiNormalizer()
  return records.flatMap((line) => normalizer.ingest(line))
}

describe('kimi normalizer', () => {
  it('derives exactly one complete turn per recorded turn, including the resumed in-place turn', () => {
    const normalizer = new KimiNormalizer()
    const events = lines().flatMap((line) => normalizer.ingest(line))
    // Two turns: the first prompt and the `-S` resume's prompt, appended to the same wire.
    expect(events.filter((event) => event.type === 'turn_started')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'turn_ended')).toHaveLength(2)
    expect(normalizer.turnOpen).toBe(false)
    expect(events.find((event) => event.type === 'turn_started')).toMatchObject({
      payload: { userMessage: expect.stringContaining('hello.txt') },
    })
  })

  it('opens the turn with the recorded prompt text and streams thinking before text', () => {
    const events = liveEvents()
    const thinking = events.find((event) => event.type === 'thinking_delta')
    const text = events.filter((event) => event.type === 'text_delta')
    expect(thinking).toBeDefined()
    expect(text.length).toBeGreaterThan(0)
    expect(events.findIndex((event) => event.type === 'thinking_delta'))
      .toBeLessThan(events.findIndex((event) => event.type === 'text_delta'))
  })

  it('pairs each tool.call with its tool.result by the recorded uuids', () => {
    const events = liveEvents()
    const starts = events.filter((event) => event.type === 'tool_start')
    const ends = events.filter((event) => event.type === 'tool_end')
    expect(starts.length).toBeGreaterThanOrEqual(2) // Write + Bash in turn 1
    expect(ends).toHaveLength(starts.length)
    for (const end of ends) {
      expect(starts.some((start) => start.payload.id === end.payload.id)).toBe(true)
    }
    const write = starts.find((event) => event.payload.tool === 'Write')
    expect(write).toMatchObject({ payload: { input: { path: 'hello.txt' } } })
  })

  it('maps the Agent sub-agent launcher to the shared Task row and closes it with the result', () => {
    const events = liveEvents(subagentLines())
    const start = events.find((event) => event.type === 'tool_start' && event.payload.tool === 'Task')
    expect(start).toBeDefined()
    const startPayload = (start as { payload: { id: string } }).payload
    const end = events.find((event) => event.type === 'tool_end'
      && (event.payload as { id: string }).id === startPayload.id)
    expect(end).toBeDefined()
    expect(end).toMatchObject({ payload: { isError: false } })
    expect(String((end as { payload: { output: string } }).payload.output)).toContain('hello-from-subagent')
    // The sub-agent has its own agents/agent-0/wire.jsonl; the parent stream carries no extra lifecycle.
    expect(events.filter((event) => event.type === 'subagent_finished')).toHaveLength(0)
  })

  it('replays history as session events and reads the last turn for the recap', () => {
    const history = kimiMessagesToEvents(lines())
    expect(history.at(-1)).toEqual({ type: 'done', payload: { result: 'success' } })
    expect(history.filter((event) => event.type === 'user_message')).toHaveLength(2)
    const last = lastKimiTurnText(lines())
    expect(last).not.toBeNull()
    expect(last!.userMessage).toContain('resumed-ok')
    expect(last!.assistantText).toContain('resumed-ok')
  })

  it('drops malformed lines without opening a turn', () => {
    const normalizer = new KimiNormalizer()
    expect(normalizer.ingest('not json')).toEqual([])
    expect(normalizer.ingest('{"no":"type"}')).toEqual([])
    expect(normalizer.turnOpen).toBe(false)
    expect(kimiRecord('')).toBeNull()
  })

  it('renames only the measured Agent launcher; real tool names pass through', () => {
    expect(kimiToolName('Agent')).toBe('Task')
    expect(kimiToolName('Write')).toBe('Write')
    expect(kimiToolName('')).toBe('Tool')
  })
})
