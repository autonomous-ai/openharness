import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { CommanderMirror, type CommanderFrame } from './commander.js'
import { lineToEvents, newTurnState, type LiveEvent } from './normalize.js'

/**
 * One REAL claude turn that spawned three ASYNC sub-agents ("Chạy 3 sub-agent SONG SONG…"), replayed
 * through the same two stages the daemon uses: `lineToEvents` → `CommanderMirror.ingest`.
 *
 * What made this worth a fixture: claude answers the `Agent` tool_use in ~4ms with "Async agent launched
 * successfully." and then ENDS the turn — the three sub-agents are still working. Taking either of those
 * at face value showed the user a finished tile and a recap of the launch message ("đã spawn 3 sub-agent"),
 * while the answer they actually asked for landed minutes later with nothing left on screen to show it.
 */
function transcript(): string[] {
  const p = fileURLToPath(new URL('./__fixtures__/transcript-async-subagents.jsonl', import.meta.url))
  return readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim())
}

function events(): LiveEvent[] {
  const state = newTurnState()
  return transcript().flatMap((line) => lineToEvents(line, state))
}

let dataDir = ''

describe('async sub-agents (real claude transcript)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-subagent-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('turns each task-notification into one subagent_finished keyed by its tool-use id', () => {
    const finished = events().filter((e) => e.type === 'subagent_finished')
    expect(finished).toHaveLength(3)
    const spawned = events().filter((e) => e.type === 'tool_start' && e.payload.tool === 'Agent')
    expect(spawned).toHaveLength(3)
    // Ids must PAIR with the spawning tool_use — that is what lets the list tick off the right row.
    expect(new Set(finished.map((e) => (e as { payload: { id: string } }).payload.id)))
      .toEqual(new Set(spawned.map((e) => (e as { payload: { id: string } }).payload.id)))
    for (const e of finished) expect((e as { payload: { status: string } }).payload.status).toBe('completed')
  })

  it('a task-notification is not a prompt: exactly one turn, and it is the user\'s', () => {
    const starts = events().filter((e) => e.type === 'turn_started')
    expect(starts).toHaveLength(1)
    expect((starts[0] as { payload: { userMessage: string } }).payload.userMessage).toContain('SONG SONG')
  })

  function replay(): { frames: CommanderFrame[]; summarize: ReturnType<typeof vi.fn> } {
    const frames: CommanderFrame[] = []
    const summarize = vi.fn(async (text: string) => `recap\n\n${text.slice(0, 40)}`)
    const mirror = new CommanderMirror({
      send: (f) => frames.push(f),
      sendWeb: () => {},
      hasDevice: () => true,
      summarize,
      dataDir,
    })
    const state = newTurnState()
    for (const line of transcript()) mirror.ingest(lineToEvents(line, state), 'sess-async')
    return { frames, summarize }
  }

  const agentFrames = (frames: CommanderFrame[]) =>
    frames.filter((f) => (f.payload as { kind?: string }).kind === 'agents')
      .map((f) => (f.payload as { agents: Array<{ text: string }> }).agents.map((a) => a.text))

  it('never ticks a sub-agent off on its launch ack', () => {
    const { frames } = replay()
    // Three spawns + three finishes = six list pushes (this turn started with no list to clear).
    const live = agentFrames(frames)
    expect(live).toHaveLength(6)
    // After the third spawn every row is still running: a `✓` there would be the launch-ack bug.
    expect(live[2]).toHaveLength(3)
    expect(live[2].every((t) => t.startsWith('›'))).toBe(true)
    expect(live[5].every((t) => t.startsWith('✓'))).toBe(true)
  })

  it('holds the recap until the last sub-agent reports in, then recaps the FINISHED answer', async () => {
    const { frames, summarize } = replay()
    // The parent turn already ended in the transcript — nothing may have been summarized yet.
    expect(summarize).not.toHaveBeenCalled()
    expect(frames.some((f) => (f.payload as { kind?: string }).kind === 'summary')).toBe(false)

    await vi.advanceTimersByTimeAsync(13_000) // backstop window after the last finish
    expect(summarize).toHaveBeenCalledTimes(1)
    const text = summarize.mock.calls[0][0] as string
    expect(text).toContain('Cả 3 sub-agent đã hoàn thành') // the wrap-up, not the launch message
  })

  it('a cancel while sub-agents run drops the held recap instead of firing it later', async () => {
    const frames: CommanderFrame[] = []
    const summarize = vi.fn(async () => 'recap\n\nbody')
    const mirror = new CommanderMirror({ send: (f) => frames.push(f), sendWeb: () => {}, hasDevice: () => true, summarize, dataDir })
    const state = newTurnState()
    for (const line of transcript()) {
      const evs = lineToEvents(line, state)
      // Cut the replay off at the turn-end that the sub-agents are holding open.
      mirror.ingest(evs, 'sess-cancel')
      if (evs.some((e) => e.type === 'turn_ended')) break
    }
    mirror.cancel('sess-cancel')
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('keeps a sub-agent announced just BEFORE its turn opened (cursor hook ordering)', () => {
    // Measured live: cursor's tool-start hook reached the mirror at 10:20:36.799 and its transcript-derived
    // turn_started at 10:20:36.862 — 63ms later. A blanket reset on turn_started deleted the first Task, so
    // two parallel sub-agents showed as one row and the held turn-end released a sub-agent early.
    const frames: CommanderFrame[] = []
    const mirror = new CommanderMirror({ send: (f) => frames.push(f), sendWeb: () => {}, hasDevice: () => true, summarize: async () => null, dataDir })
    mirror.ingest([
      { type: 'tool_start', payload: { id: 'task-a', tool: 'Task', input: { description: 'SJC gold price today' } } },
      { type: 'turn_started', payload: { userMessage: 'two sub-agents' } },
      { type: 'tool_start', payload: { id: 'task-b', tool: 'Task', input: { description: 'USD/VND rate today' } } },
    ] as LiveEvent[], 'sess-order')
    const lists = agentFrames(frames)
    expect(lists[lists.length - 1]).toHaveLength(2)
  })

  it('does not let LAST turn\'s sub-agent hold THIS turn\'s recap', async () => {
    // The row survives the turn boundary so the device keeps showing it — but an agent spawned two
    // prompts ago must not park the answer to the question just asked (worst case: the 10-minute
    // backstop, with nothing on screen to explain the wait).
    const frames: CommanderFrame[] = []
    const summarize = vi.fn(async (_text: string) => 'recap\n\nbody')
    const mirror = new CommanderMirror({ send: (f) => frames.push(f), sendWeb: () => {}, hasDevice: () => true, summarize, dataDir })
    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'spawn one' } },
      { type: 'tool_start', payload: { id: 'toolu_slow', tool: 'Agent', input: { description: 'still running' } } },
      { type: 'tool_end', payload: { id: 'toolu_slow', tool: 'Agent', output: 'Async agent launched successfully.', isError: false, summary: '' } },
      { type: 'turn_ended', payload: {} },
      // …the user moves on to something unrelated while it runs.
      { type: 'turn_started', payload: { userMessage: 'what time is it?' } },
      { type: 'text_delta', payload: { content: 'It is 11:00.' } },
      { type: 'turn_ended', payload: {} },
    ] as LiveEvent[], 'sess-carry')

    await vi.advanceTimersByTimeAsync(100)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0][0]).toContain('It is 11:00.')
    // and the carried row is still on the device's list, still marked running
    const last = frames.filter((f) => (f.payload as { kind?: string }).kind === 'agents').at(-1)
    expect((last?.payload as { agents: Array<{ text: string }> }).agents.map((a) => a.text)).toEqual(['› still running'])
  })

  it('releases the turn-end anyway if a sub-agent never reports back', async () => {
    const frames: CommanderFrame[] = []
    const summarize = vi.fn(async () => 'recap\n\nbody')
    const mirror = new CommanderMirror({ send: (f) => frames.push(f), sendWeb: () => {}, hasDevice: () => true, summarize, dataDir })
    mirror.ingest([
      { type: 'turn_started', payload: { userMessage: 'spawn one' } },
      { type: 'tool_start', payload: { id: 'toolu_x', tool: 'Agent', input: { description: 'never returns' } } },
      { type: 'tool_end', payload: { id: 'toolu_x', tool: 'Agent', output: 'Async agent launched successfully.', isError: false, summary: '' } },
      { type: 'text_delta', payload: { content: 'launched it' } },
      { type: 'turn_ended', payload: {} },
    ] as LiveEvent[], 'sess-stuck')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(summarize).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(summarize).toHaveBeenCalledTimes(1)
  })
})

/**
 * A background sub-agent that finishes while its parent is still working is handed back INTO the running
 * turn: Claude Code writes its `<task-notification>` as a `queued_command` attachment (commandMode
 * `task-notification`), not as the `type:"user"` record it writes when the parent is idle. Across real
 * 2.1.270–2.1.287 transcripts the attachment is the more common of the two (about 800 against 370). Read only from
 * user records, that sub-agent never finished: its row stayed running on the dial, and the parent's recap
 * was held until the backstop gave up on it. Records synthesized in the real shape; the text is invented.
 */
describe('async sub-agents handed back mid-turn', () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o)
  const notification = (id: string, status: string) =>
    `<task-notification>\n<task-id>a1b2c3d4e5f6a7b8c</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/tasks/a1b2c3d4e5f6a7b8c.output</output-file>\n<status>${status}</status>\n<summary>Agent "Count the fixtures" finished</summary>\n<result>There are 12 fixtures.</result>\n</task-notification>`
  const turn = [
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'count the fixtures in the background, then tidy the README' } }),
    line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg1', name: 'Agent', input: { description: 'Count the fixtures', run_in_background: true } }], stop_reason: 'tool_use' } }),
    line({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg1', content: 'Async agent launched successfully.' }] } }),
    line({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ed1', name: 'Edit', input: { file_path: 'README.md' } }], stop_reason: 'tool_use' } }),
    line({ type: 'user', uuid: 'r2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ed1', content: 'The file README.md has been updated successfully.' }] } }),
    line({
      type: 'attachment', uuid: 'q1',
      attachment: { type: 'queued_command', prompt: notification('toolu_bg1', 'completed'), commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' } },
    }),
    line({ type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'README tidied; the scout counted 12 fixtures.' }], stop_reason: 'end_turn' } }),
  ]

  it('finishes the sub-agent, keyed by its tool-use id, and opens no turn', () => {
    const state = newTurnState()
    const events = turn.flatMap((raw) => lineToEvents(raw, state))
    expect(events.filter((e) => e.type === 'subagent_finished')).toEqual([
      { type: 'subagent_finished', payload: { id: 'toolu_bg1', status: 'completed', summary: 'Agent "Count the fixtures" finished' } },
    ])
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'turn_ended', payload: {} })
  })

  it('ticks the row off on the dial, so the recap is not held for it', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'adapter-subagent-'))
    try {
      const frames: CommanderFrame[] = []
      const summarize = vi.fn(async () => 'recap\n\nbody')
      const mirror = new CommanderMirror({ send: (f) => frames.push(f), sendWeb: () => {}, hasDevice: () => true, summarize, dataDir: dir })
      const state = newTurnState()
      for (const raw of turn) mirror.ingest(lineToEvents(raw, state), 'sess-midturn')
      const rows = frames.filter((f) => (f.payload as { kind?: string }).kind === 'agents')
        .map((f) => (f.payload as { agents: Array<{ text: string }> }).agents.map((a) => a.text))
      expect(rows.at(-1)?.every((text) => text.startsWith('✓'))).toBe(true)
      await vi.advanceTimersByTimeAsync(13_000)
      expect(summarize).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
