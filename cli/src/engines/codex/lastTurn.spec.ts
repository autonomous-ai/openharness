import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexNormalizer, lastCodexTurnText, selectCodexRecapLine } from './normalizer.js'
import { readLastCodexTurnText } from './lastTurn.js'
import { tailFile } from '../../lib/transcriptTail.js'
import { CommanderMirror, type CommanderFrame } from '../../lib/commander.js'
import { deriveTurnSummary } from '../../lib/deviceRecap.js'

const event = (payload: unknown) => JSON.stringify({ type: 'event_msg', payload })
const ask = (message: string) => event({ type: 'user_message', message })
const answer = (message: string, phase?: string) => event({ type: 'agent_message', message, ...(phase ? { phase } : {}) })
const goal = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
  text: '<codex_internal_context source="goal"><objective>Keep going 📘</objective></codex_internal_context>' }] } })

describe('Codex recap from the latest file turn', () => {
  let directory: string, file: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'codex-recap-')); file = join(directory, 'rollout.jsonl') })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  const cases = [
    [ask('old'), answer('old answer'), ask('latest'), answer('on it', 'commentary'), answer('done', 'final_answer')],
    [ask('old'), answer('old answer'), goal, answer('working', 'commentary')],
    [ask('old'), answer('old answer'), goal, answer('complete', 'final_answer')],
    [ask('old'), answer('old answer'), ask('unfinished'), answer('working', 'commentary')],
    [ask('prompt'), answer('answer'), ask(''), event({ type: 'user_message', message: null })],
    [ask('prompt'), answer('unphased'), answer('working', 'commentary')],
    [ask('prompt'), answer('first'), answer('second'), '{torn'],
    [answer('no prompt')],
    [event({ type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'Text', text: 'new format' }] } }),
      event({ type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'done' }] } })],
    [ask('prompt'), answer('first final', 'final_answer'), answer('second final', 'final_answer')],
    [ask('prompt'), answer('answer'), 'null', '[]', '{}', '{invalid', event({ type: 'task_complete' })],
    [ask('prompt'), answer('answer'), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'A regular response-item message does not reset the existing recap.' }] } })],
    [ask('prompt'), answer('answer'), answer('', 'commentary'), event({ type: 'agent_message', phase: 'final_answer', message: null })],
    [ask('prompt'), answer('answer'), answer('unknown phase', 'future_phase')],
    [ask('prompt'), answer('answer'), JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: ask('embedded prompt') } })],
  ]
  it.each(cases.map((rows, i) => ({ i, rows })))('matches the full-history reader for case $i', async ({ rows }) => {
    writeFileSync(file, rows.join('\n'))
    expect(await readLastCodexTurnText(file)).toEqual(lastCodexTurnText(await tailFile(file, Infinity)))
  })

  it('ignores megabytes of old tool data while retaining a long latest prompt and answer exactly', async () => {
    const prompt = 'é漢字📘'.repeat(20_000), text = 'answer 📘 '.repeat(15_000)
    const rows = [ask('old'), JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(2 * 1024 * 1024) } }),
      answer('old answer'), ask(prompt), answer(text, 'final_answer')]
    writeFileSync(file, rows.join('\n') + '\n')
    expect(await readLastCodexTurnText(file)).toEqual({ userMessage: prompt, assistantText: text })
  })

  it('matches every growing prefix of mixed legacy, current, goal and malformed records', async () => {
    const rows = cases.flat()
    for (let end = 0; end <= rows.length; end++) {
      const prefix = rows.slice(0, end)
      writeFileSync(file, prefix.join('\n') + '\n')
      expect(await readLastCodexTurnText(file), `prefix ${end}`).toEqual(lastCodexTurnText(prefix))
    }
  })

  it('discards tool receipts from a long latest turn before the final parser sees them', async () => {
    const rows = [ask('prompt'), JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(2 * 1024 * 1024) } }),
      event({ type: 'token_count', info: {} }), answer('working', 'commentary'), answer('done', 'final_answer')]
    expect(rows.map(selectCodexRecapLine)).toEqual(['stop', 'skip', 'skip', 'keep', 'keep'])
    writeFileSync(file, rows.join('\n'))
    expect(await readLastCodexTurnText(file)).toEqual({ userMessage: 'prompt', assistantText: 'done' })
  })

  it('returns no recap for a missing file', async () => {
    expect(await readLastCodexTurnText(file)).toBeNull()
  })

  it.each(['legacy', 'wrapped', 'goal'])('delivers and persists the %s file result through the normalizer and Commander', async (format) => {
    const prompt = format === 'goal' ? '/goal Keep going 📘' : 'Latest prompt'
    const user = format === 'goal' ? goal : format === 'legacy' ? ask(prompt)
      : event({ type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'Text', text: prompt }] } })
    const final = format === 'wrapped'
      ? event({ type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'Latest answer.' }] } })
      : answer('Latest answer.', 'final_answer')
    const latest = [event({ type: 'task_started', turn_id: 'turn-latest' }), user, answer('Still working.', 'commentary'), final,
      event({ type: 'task_complete', turn_id: 'turn-latest' })]
    writeFileSync(file, [ask('old'), answer('Old answer.'), ...latest].join('\n'))
    const device: CommanderFrame[] = [], web: Record<string, unknown>[] = []
    const summarize = vi.fn(async (text: string, _signal?: AbortSignal, _prompt?: string) => deriveTurnSummary(text))
    const options = { dataDir: directory, send: (frame: CommanderFrame) => device.push(frame),
      sendWeb: (frame: Record<string, unknown>) => web.push(frame), hasDevice: () => true,
      summarize, summarizeIsLocal: true, readLastTurn: () => readLastCodexTurnText(file) }
    const mirror = new CommanderMirror(options)
    try {
      const normalizer = new CodexNormalizer('live')
      mirror.ingest(latest.flatMap(line => normalizer.ingest(line)), 'session')
      await vi.waitFor(() => expect(web.some(frame => frame.type === 'turn_summary')).toBe(true))
      expect(summarize).toHaveBeenCalledExactlyOnceWith('Latest answer.', expect.any(AbortSignal), prompt, 'session', undefined)
      expect(device.at(-1)?.payload).toMatchObject({ kind: 'summary', notification: { kind: 'done' } })
      expect(mirror.recent('session')[0].fullText).toBe('Latest answer.')
      await vi.waitFor(() => expect(new CommanderMirror(options).recent('session')[0]?.fullText).toBe('Latest answer.'))
    } finally { mirror.deleteHistory('session') }
  })

  it('clears completion without sending a stale recap for an unfinished goal', async () => {
    const latest = [event({ type: 'task_started', turn_id: 'unfinished' }), goal, answer('Still working.', 'commentary'),
      event({ type: 'task_complete', turn_id: 'unfinished' })]
    writeFileSync(file, [ask('old'), answer('Old answer.', 'final_answer'), ...latest].join('\n'))
    const device: CommanderFrame[] = [], web: Record<string, unknown>[] = []
    const summarize = vi.fn(async () => 'Must not appear')
    const mirror = new CommanderMirror({ dataDir: directory, send: frame => device.push(frame), sendWeb: frame => web.push(frame),
      hasDevice: () => true, summarize, readLastTurn: () => readLastCodexTurnText(file) })
    try {
      const normalizer = new CodexNormalizer('live')
      mirror.ingest(latest.flatMap(line => normalizer.ingest(line)), 'session')
      await vi.waitFor(() => expect(device.at(-1)?.payload.kind).toBe('done'))
      expect(summarize).not.toHaveBeenCalled()
      expect(web).toEqual([])
      expect(mirror.recent('session')).toEqual([])
    } finally { mirror.deleteHistory('session') }
  })
})
