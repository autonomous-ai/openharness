import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { forEachLine, lineNormalizer, lineTime, skipPredicate } from './transcript.js'
import { TurnCollector, type IndexedTurn } from './turns.js'

const dirs: string[] = []
function file(content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-search-'))
  dirs.push(dir)
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, content)
  return path
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function lines(path: string, start = 0, skip?: (head: string) => boolean) {
  const seen: Array<[number, string]> = []
  const { end } = await forEachLine(path, start, ({ text, offset }) => { seen.push([offset, text]) }, { skip })
  return { seen, end }
}

/** Turns from a transcript, through the engine's own normalizer — with or without the output skip. */
async function turnsOf(engine: string, path: string, skip: boolean): Promise<IndexedTurn[]> {
  const normalize = lineNormalizer(engine, 'session-1')!
  const collector = new TurnCollector(0)
  await forEachLine(path, 0, ({ text, offset }) => collector.feed(normalize(text), offset, lineTime(text)), {
    skip: skip ? skipPredicate(engine) : null,
  })
  const { closed, open } = collector.finish()
  return open ? [...closed, open] : closed
}

const at = (minute: number) => `2026-09-20T10:${String(minute).padStart(2, '0')}:00.000Z`
const claude = {
  prompt: (text: string, minute: number) => JSON.stringify({ type: 'user', uuid: `u${minute}`, timestamp: at(minute), message: { role: 'user', content: text } }),
  toolUse: (id: string, command: string, minute: number) => JSON.stringify({ type: 'assistant', uuid: `a${minute}`, timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], stop_reason: 'tool_use' } }),
  toolResult: (id: string, output: string, minute: number) => JSON.stringify({ type: 'user', uuid: `r${minute}`, timestamp: at(minute), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: output }] } }),
  answer: (text: string, minute: number) => JSON.stringify({ type: 'assistant', uuid: `b${minute}`, timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }),
}
const codex = {
  line: (minute: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at(minute), type, payload }),
}

describe('forEachLine', () => {
  it('reports each complete line with its byte offset and leaves a partial last line for later', async () => {
    const path = file('first\nsécond\nthird-without-newline')
    const { seen, end } = await lines(path)
    expect(seen).toEqual([[0, 'first'], [6, 'sécond']])
    expect(end).toBe(Buffer.byteLength('first\nsécond\n'))
    expect((await lines(path, end)).seen).toEqual([])
  })

  it('resumes from an offset and reads lines longer than one read chunk', async () => {
    const long = 'x'.repeat(3 * 1024 * 1024)
    const path = file(`a\n${long}\nb\n`)
    const { seen, end } = await lines(path)
    expect(seen.map(([offset, text]) => [offset, text.length])).toEqual([[0, 1], [2, long.length], [long.length + 3, 1]])
    expect((await lines(path, 2)).seen.map(([, text]) => text.length)).toEqual([long.length, 1])
    expect(end).toBe(long.length + 5)
  })

  it('drops a skipped line unread and keeps counting offsets through it', async () => {
    const path = file(`keep 1\nDROP ${'y'.repeat(2 * 1024 * 1024)}\nkeep 2\n`)
    const { seen } = await lines(path, 0, (head) => head.startsWith('DROP'))
    expect(seen.map(([, text]) => text)).toEqual(['keep 1', 'keep 2'])
    expect(seen[1][0]).toBe(7 + 5 + 2 * 1024 * 1024 + 1)
  })
})

describe('lineTime', () => {
  it('reads the record time wherever the field sits', () => {
    expect(lineTime(claude.answer('hi', 3))).toBe(Date.parse(at(3)))
    expect(lineTime('{"type":"x"}')).toBeNull()
  })
})

describe('skipping tool output', () => {
  it('leaves Claude turns exactly as the normalizer reads them in full', async () => {
    const path = file([
      claude.prompt('Why does the dial scroll jump?', 0),
      claude.toolUse('t1', 'rg scroll devices/dial', 1),
      claude.toolResult('t1', 'devices/dial/src/ui.c:120 scroll_by(...)\n'.repeat(2000), 2),
      claude.answer('The scroll delta is doubled in ui.c.', 3),
      claude.prompt('fix it', 4),
      claude.answer('Fixed and flashed.', 5),
    ].join('\n') + '\n')
    const full = await turnsOf('claude', path, false)
    expect(await turnsOf('claude', path, true)).toEqual(full)
    expect(full.map((turn) => [turn.ask, turn.answer, turn.tools, turn.at])).toEqual([
      ['Why does the dial scroll jump?', 'The scroll delta is doubled in ui.c.', 'Bash rg scroll devices/dial', Date.parse(at(0))],
      ['fix it', 'Fixed and flashed.', '', Date.parse(at(4))],
    ])
  })

  it('leaves Codex turns exactly as the normalizer reads them in full', async () => {
    const path = file([
      codex.line(0, 'session_meta', { id: 'session-1', cwd: '/work/app' }),
      codex.line(1, 'event_msg', { type: 'task_started' }),
      codex.line(1, 'event_msg', { type: 'user_message', message: 'summarize the retention cohorts' }),
      codex.line(2, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] }),
      codex.line(3, 'response_item', { type: 'function_call', call_id: 'c1', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'python3 cohorts.py'] }) }),
      codex.line(4, 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'row\n'.repeat(5000) }),
      codex.line(5, 'event_msg', { type: 'agent_message', message: 'Day-7 retention is 35%.' }),
      codex.line(5, 'event_msg', { type: 'token_count', info: {} }),
      codex.line(6, 'event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n')
    const full = await turnsOf('codex', path, false)
    expect(await turnsOf('codex', path, true)).toEqual(full)
    expect(full).toHaveLength(1)
    expect(full[0]).toMatchObject({ ask: 'summarize the retention cohorts', answer: 'Day-7 retention is 35%.' })
    expect(full[0].tools).toContain('python3 cohorts.py')
  })

  it('has no normalizer for engines whose history is not a JSONL file', () => {
    for (const engine of ['opencode', 'kilo', 'hermes', 'devin', 'terminal']) expect(lineNormalizer(engine, 's')).toBeNull()
  })
})

describe("the person's words outside Claude's prompt records", () => {
  const queued = (prompt: unknown, minute: number, commandMode = 'prompt', origin = 'human') => JSON.stringify({
    type: 'attachment', uuid: `q${minute}`, timestamp: at(minute),
    attachment: { type: 'queued_command', prompt, commandMode, origin: { kind: origin }, humanTurn: true },
  })
  const meta = (text: string, minute: number) => JSON.stringify({ type: 'user', isMeta: true, uuid: `m${minute}`, timestamp: at(minute), message: { role: 'user', content: text } })

  it('indexes a message typed while the agent worked, and a /goal, as asks', async () => {
    const path = file([
      claude.prompt('cmd p search results are not good', 0),
      claude.answer('Looking at how Cmd-P ranks rows.', 1),
      queued('are we doing keyword search, vector search or embeddings?', 2),
      claude.answer('Keyword search over names only, today.', 3),
      queued([{ type: 'text', text: '[Image #1] this row' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }], 4),
      meta('A session-scoped Stop hook is now active with condition: "build the best search engine across all "the" machines". Briefly acknowledge the goal, then immediately start.', 5),
      claude.answer('On it.', 6),
    ].join('\n') + '\n')
    const turns = await turnsOf('claude', path, true)
    expect(turns.map((turn) => [turn.ask, turn.answer])).toEqual([
      ['cmd p search results are not good', 'Looking at how Cmd-P ranks rows.'],
      ['are we doing keyword search, vector search or embeddings?', 'Keyword search over names only, today.'],
      ['[Image #1] this row', ''],
      ['build the best search engine across all "the" machines', 'On it.'],
    ])
  })

  it('files a hand-back under the agent and leaves task notifications and other bookkeeping out', async () => {
    const path = file([
      claude.prompt('audit the dial', 0),
      queued('<task-notification><task-id>b1</task-id><summary>done</summary></task-notification>', 1, 'task-notification', 'task-notification'),
      queued('<agent-message from="a1">[Subagent hand-back] found 3 scroll bugs</agent-message>', 2, 'prompt', 'peer'),
      queued('Goal set: build the best search engine', 2, 'prompt', 'auto-continuation'),
      meta('Goal check-in: «build the best search engine»', 3),
      meta('Base directory for this skill: /skills/review', 4),
      claude.answer('Fixing the three bugs.', 5),
    ].join('\n') + '\n')
    const turns = await turnsOf('claude', path, true)
    expect(turns.map((turn) => turn.ask)).toEqual(['audit the dial', ''])
    expect(turns[1].answer).toContain('found 3 scroll bugs')
    expect(turns[1].answer).toContain('Fixing the three bugs.')
    const text = JSON.stringify(turns)
    expect(text).not.toContain('task-notification')
    expect(text).not.toContain('Goal check-in')
    expect(text).not.toContain('Goal set')
    expect(text).not.toContain('Base directory')
  })
})
