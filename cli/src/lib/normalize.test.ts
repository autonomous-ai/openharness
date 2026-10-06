import { describe, it, expect } from 'vitest'
import {
  lastTurnTextFromRawLines,
  lineToEvents,
  messagesToEvents,
  newTurnState,
  windowRawLines,
} from './normalize.js'

// Build a synthetic transcript: 3 turns, each = [user prompt, assistant tool_use, user tool_result].
// uuids: u1 a1 r1 | u2 a2 r2 | u3 a3 r3  (turn starts at line indices 0, 3, 6).
const line = (o: Record<string, unknown>) => JSON.stringify(o)
const userPrompt = (uuid: string, text: string) =>
  line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } })
const asstToolUse = (uuid: string, id: string, name: string) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } })
const asstText = (uuid: string, text: string) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const userToolResult = (uuid: string, toolUseId: string) =>
  line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] } })

const LINES = [
  userPrompt('u1', 'hello 1'), asstToolUse('a1', 't1', 'Bash'), userToolResult('r1', 't1'),
  userPrompt('u2', 'hello 2'), asstToolUse('a2', 't2', 'Read'), userToolResult('r2', 't2'),
  userPrompt('u3', 'hello 3'), asstToolUse('a3', 't3', 'Grep'), userToolResult('r3', 't3'),
]

describe('windowRawLines', () => {
  it('newest window is turn-snapped, reports hasMore + a real oldestCursor', () => {
    const w = windowRawLines(LINES, { limit: 2 })
    // limit=2 lands mid-turn (index 7); snaps back to the turn start u3 (index 6).
    expect(w.window).toEqual(LINES.slice(6, 9))
    expect(w.hasMore).toBe(true)
    expect(w.oldestCursor).toBe('u3')
    expect(w.staleCursor).toBeUndefined()

    // The window is self-contained: the tool_use precedes its tool_result, so messagesToEvents'
    // stateful tool-name map resolves — the tool card renders with its real name.
    const events = messagesToEvents(w.window)
    expect(events.some((e) => e.type === 'user_message' && (e.payload as { content: string }).content === 'hello 3')).toBe(true)
    expect(events.some((e) => e.type === 'tool_start' && (e.payload as { tool: string }).tool === 'Grep')).toBe(true)
  })

  it('pages backward with before=oldestCursor until hasMore=false', () => {
    const p1 = windowRawLines(LINES, { limit: 2, before: 'u3' })
    expect(p1.window).toEqual(LINES.slice(3, 6)) // turn 2
    expect(p1.hasMore).toBe(true)
    expect(p1.oldestCursor).toBe('u2')

    const p2 = windowRawLines(LINES, { limit: 2, before: 'u2' })
    expect(p2.window).toEqual(LINES.slice(0, 3)) // turn 1 — oldest
    expect(p2.hasMore).toBe(false)
    expect(p2.oldestCursor).toBe('u1')
  })

  it('flags a stale cursor (empty window) when before is not in the file', () => {
    const w = windowRawLines(LINES, { limit: 2, before: 'does-not-exist' })
    expect(w.staleCursor).toBe(true)
    expect(w.window).toEqual([])
    expect(w.hasMore).toBe(false)
  })

  it('returns everything when the window is larger than the transcript', () => {
    const w = windowRawLines(LINES, { limit: 100 })
    expect(w.window).toEqual(LINES)
    expect(w.hasMore).toBe(false)
    expect(w.oldestCursor).toBe('u1')
  })
})

describe('lastTurnTextFromRawLines', () => {
  it('extracts the last real user ask and assistant text from session JSONL', () => {
    const lines = [
      userPrompt('u1', 'old ask'),
      asstText('a1', 'old answer'),
      userPrompt('u2', 'current ask'),
      asstToolUse('a2', 't2', 'Bash'),
      userToolResult('r2', 't2'),
      asstText('a3', 'first answer part'),
      asstText('a4', 'second answer part'),
    ]

    expect(lastTurnTextFromRawLines(lines)).toEqual({
      userMessage: 'current ask',
      assistantText: 'first answer part\n\nsecond answer part',
    })
  })

  it('takes the answer after the last tool call, not the narration before it', () => {
    // A long working turn: the assistant narrates, works, narrates, works, then answers. The recap and the
    // reader show the answer; before this they showed the FIRST narration line.
    const lines = [
      userPrompt('u1', 'why is the build red'),
      asstText('a1', 'Let me look at the logs.'),
      asstToolUse('a2', 't1', 'Bash'),
      userToolResult('r1', 't1'),
      asstText('a3', 'The lockfile is stale, checking the CI config next.'),
      asstToolUse('a4', 't2', 'Read'),
      userToolResult('r2', 't2'),
      asstText('a5', 'The build is red because the lockfile is stale.'),
      asstText('a6', 'Regenerating it fixes it.'),
    ]
    expect(lastTurnTextFromRawLines(lines)).toEqual({
      userMessage: 'why is the build red',
      assistantText: 'The build is red because the lockfile is stale.\n\nRegenerating it fixes it.',
    })
  })

  it('treats text written in the same message as a tool call as narration too', () => {
    const lines = [
      userPrompt('u1', 'fix it'),
      line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [
        { type: 'text', text: 'Reading the file first.' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
      userToolResult('r1', 't1'),
      asstText('a2', 'Fixed: the import was misspelled.'),
    ]
    expect(lastTurnTextFromRawLines(lines)?.assistantText).toBe('Fixed: the import was misspelled.')
  })

  it('still summarizes a turn that never reached an answer, from what was said', () => {
    // It ended on a tool call (or was interrupted): there is nothing after the last one, so the narration
    // is all there is, and a recap of it beats a blank tile.
    const lines = [
      userPrompt('u1', 'run the migration'),
      asstText('a1', 'Starting the migration now.'),
      asstToolUse('a2', 't1', 'Bash'),
    ]
    expect(lastTurnTextFromRawLines(lines)?.assistantText).toBe('Starting the migration now.')
  })

  it('keeps the last REAL ask when bash-mode (!command) lines follow it', () => {
    // Bash mode writes the command + its output back as a user line. It is the person running a shell,
    // not a prompt, so the recap must stay on the real task instead of drifting to shell mechanics.
    const lines = [
      userPrompt('u1', 'scan the network for loginable OrangePis'),
      asstText('a1', 'Found .143 — orangepi/orangepi works and it has passwordless sudo.'),
      userPrompt('b1', "<bash-input>ssh orangepi@172.168.20.143 echo hi</bash-input>"),
      userPrompt('b2', '<bash-stdout></bash-stdout><bash-stderr>unsupported option "no...".</bash-stderr>'),
      asstText('a2', 'That paste dropped a space; put it on one line.'),
    ]
    // The ask is the task, and the assistant text stays attributed to it (bash lines opened no new turn).
    expect(lastTurnTextFromRawLines(lines)).toEqual({
      userMessage: 'scan the network for loginable OrangePis',
      assistantText: 'Found .143 — orangepi/orangepi works and it has passwordless sudo.\n\nThat paste dropped a space; put it on one line.',
    })
  })

  it('still counts a user line that carries prose alongside a bash block', () => {
    const lines = [
      userPrompt('u1', 'old ask'),
      asstText('a1', 'old answer'),
      userPrompt('u2', 'here is the output, what now?\n<bash-stdout>port 22 open</bash-stdout>'),
      asstText('a2', 'It is reachable — try the default creds next.'),
    ]
    expect(lastTurnTextFromRawLines(lines)).toEqual({
      userMessage: 'here is the output, what now?\n<bash-stdout>port 22 open</bash-stdout>',
      assistantText: 'It is reachable — try the default creds next.',
    })
  })

  it('skips compact metadata, platform prompts, and tool_result user echoes', () => {
    const lines = [
      line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } }),
      line({ type: 'user', uuid: 'meta', isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: 'summary' }] } }),
      userPrompt('u1', '<!-- CONTEXT SUMMARY -->\nplatform prompt'),
      userPrompt('u2', 'real ask'),
      userToolResult('r2', 'tool'),
      asstText('a2', 'real answer'),
    ]

    expect(lastTurnTextFromRawLines(lines)).toEqual({
      userMessage: 'real ask',
      assistantText: 'real answer',
    })
  })
})

describe('Claude local command records', () => {
  const modelOutput = userPrompt(
    'local-model',
    '<local-command-stdout>Set model to \u001b[1mOpus 4.8\u001b[22m and saved as your default for new sessions</local-command-stdout>',
  )
  const effortOutput = userPrompt(
    'local-effort',
    '<local-command-stdout>Set effort level to high (saved as your default for new sessions)</local-command-stdout>',
  )

  it('does not render local command stdout during replay', () => {
    expect(messagesToEvents([modelOutput, effortOutput])).toEqual([
      { type: 'done', payload: { result: 'success' } },
    ])
  })

  it('does not open a live turn for local command stdout', () => {
    const state = newTurnState()

    expect(lineToEvents(modelOutput, state)).toEqual([])
    expect(lineToEvents(effortOutput, state)).toEqual([])
    expect(state.turnOpen).toBe(false)
  })
})

describe('turn close on terminal stop reasons', () => {
  const asstStop = (uuid: string, text: string, stopReason: string) =>
    line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stopReason } })

  const openTurn = () => {
    const state = newTurnState()
    lineToEvents(userPrompt('u1', 'hello'), state)
    expect(state.turnOpen).toBe(true)
    return state
  }

  it('closes the turn on max_tokens and refusal (not just end_turn/stop_sequence)', () => {
    for (const reason of ['end_turn', 'stop_sequence', 'max_tokens', 'refusal']) {
      const state = openTurn()
      const events = lineToEvents(asstStop('a1', 'partial', reason), state)
      expect(events).toContainEqual({ type: 'turn_ended', payload: {} })
      expect(state.turnOpen).toBe(false)
    }
  })

  it('does NOT close on tool_use or pause_turn (turn continues)', () => {
    for (const reason of ['tool_use', 'pause_turn']) {
      const state = openTurn()
      const events = lineToEvents(asstStop('a1', 'thinking', reason), state)
      expect(events).not.toContainEqual({ type: 'turn_ended', payload: {} })
      expect(state.turnOpen).toBe(true)
    }
  })

  it('does NOT close on a terminal stop reason while a tool is still pending', () => {
    const state = openTurn()
    lineToEvents(asstToolUse('a1', 't1', 'Bash'), state) // adds t1 to pendingTools
    const events = lineToEvents(asstStop('a2', 'done', 'end_turn'), state)
    expect(events).not.toContainEqual({ type: 'turn_ended', payload: {} })
    expect(state.turnOpen).toBe(true)
  })
})

describe('bash-mode lines are not turns', () => {
  it('a !command line opens no turn and leaves an open one untouched', () => {
    const state = newTurnState()
    // A bash-only line before any prompt: nothing opens.
    expect(lineToEvents(userPrompt('b0', '<bash-input>ls</bash-input>'), state)).toEqual([])
    expect(state.turnOpen).toBe(false)
    // Open a real turn, then a bash exchange mid-turn: it neither ends nor starts a turn.
    lineToEvents(userPrompt('u1', 'scan the network'), state)
    expect(state.turnOpen).toBe(true)
    expect(lineToEvents(userPrompt('b1', '<bash-input>ssh box echo hi</bash-input>'), state)).toEqual([])
    expect(lineToEvents(userPrompt('b2', '<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>'), state)).toEqual([])
    expect(state.turnOpen).toBe(true)
  })

  it('a line with real prose beside a bash block still starts a turn', () => {
    const state = newTurnState()
    const events = lineToEvents(userPrompt('u1', 'what does this mean?\n<bash-stderr>boom</bash-stderr>'), state)
    expect(events).toContainEqual({ type: 'turn_started', payload: { userMessage: 'what does this mean?\n<bash-stderr>boom</bash-stderr>' } })
    expect(state.turnOpen).toBe(true)
  })
})

describe('slash-command prompts', () => {
  // Claude Code records a typed command ONLY as these tags; the expansion it sends to the model is a
  // separate `isMeta` line we suppress. Before the fix both normalized to "" and NO turn ever opened,
  // so the device's `/goal <text>` (deviceWs sends exactly this) tripped the submit-verify retries and
  // surfaced "The agent did not accept the message" even though claude had run the command fine.
  const goalCmd = userPrompt(
    'c1',
    '<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>ship the release</command-args>',
  )
  const goalStdout = userPrompt('c2', '<local-command-stdout>Goal set: ship the release</local-command-stdout>')
  const modelCmd = userPrompt(
    'c3',
    '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>',
  )

  it('opens a live turn with the command text verbatim (matches the injected fingerprint)', () => {
    const state = newTurnState()

    expect(lineToEvents(goalCmd, state)).toEqual([
      { type: 'turn_started', payload: { userMessage: '/goal ship the release' } },
    ])
    expect(state.turnOpen).toBe(true)
    expect(lineToEvents(goalStdout, state)).toEqual([]) // the echo must not re-open a turn
  })

  it('keeps local-only TUI commands silent', () => {
    const state = newTurnState()

    expect(lineToEvents(modelCmd, state)).toEqual([])
    expect(state.turnOpen).toBe(false)
  })

  it('leads the recap with the command text', () => {
    expect(lastTurnTextFromRawLines([goalCmd, goalStdout, asstText('a1', 'done')])).toEqual({
      userMessage: '/goal ship the release',
      assistantText: 'done',
    })
  })
})

describe('a message typed while Claude Code worked', () => {
  const queued = (prompt: unknown, kind: string, commandMode = 'prompt') => line({
    type: 'attachment', uuid: `q-${kind}`, attachment: { type: 'queued_command', prompt, commandMode, origin: { kind } },
  })
  const prompt = line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'run sleep 8, then say three' } })
  const answer = line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'three\nfour' }], stop_reason: 'end_turn' } })

  it('is in the history where it was delivered, but only the person\'s own words', () => {
    const events = messagesToEvents([
      prompt,
      queued('and then say four', 'human'),
      queued([{ type: 'text', text: 'blocks too' }], 'human'),
      queued('Goal set: ship it', 'auto-continuation'),
      queued('a sub-agent hands back', 'task-notification'),
      queued('/model opus', 'human', 'bash'),
      queued('   ', 'human'),
      answer,
    ])
    expect(events.filter((e) => e.type === 'user_message').map((e) => (e.payload as { content: string }).content))
      .toEqual(['run sleep 8, then say three', 'and then say four', 'blocks too'])
  })

  it('still opens no live turn', () => {
    const state = newTurnState()
    lineToEvents(prompt, state)
    expect(lineToEvents(queued('and then say four', 'human'), state)).toEqual([])
    expect(state.turnOpen).toBe(true)
  })
})

describe('a built-in command Claude Code runs itself, typed plainly', () => {
  const user = (content: string) => line({ type: 'user', uuid: content, message: { role: 'user', content } })
  it.each(['/compact', '/compact keep the plan', '/model opus', '/Clear'])('%s opens no live turn', (prompt) => {
    const state = newTurnState()
    expect(lineToEvents(user(prompt), state)).toEqual([])
    expect(state.turnOpen).toBe(false)
  })
  it.each(['/goal ship it', '/review', '/compactor', 'run /compact later'])('%s is still a prompt', (prompt) => {
    const state = newTurnState()
    expect(lineToEvents(user(prompt), state)).toEqual([{ type: 'turn_started', payload: { userMessage: prompt } }])
  })
})


// A Stop hook that blocks keeps Claude Code's turn going: `/goal` is built on one. The shapes are real
// 2.1.282/2.1.283 records with invented text: the feedback as a hidden isMeta user line, then the record
// saying which hook it was, then the continuation's output with no prompt line between. The iteration's
// end_turn closed the turn, and the continuation ran with none open: no turn_started, no turn_ended, no
// recap, and the agent read idle whenever a tool outlasted the work lease.
describe('a Stop hook that blocks', () => {
  const user = (content: string) => line({ type: 'user', uuid: `u-${content}`, message: { role: 'user', content } })
  const feedback = line({ type: 'user', isMeta: true, promptId: 'p1', message: { role: 'user', content: 'Stop hook feedback:\n[goal check]: the condition is not met yet' } })
  const goal = (met: boolean, extra: Record<string, unknown> = {}) => line({
    type: 'attachment', uuid: `g-${met}`, attachment: { type: 'goal_status', met, condition: 'every page loads under a second', reason: 'two pages still slow', ...extra },
  })
  const blocked = (hookEvent: string, blockingError: unknown) => line({
    type: 'attachment', uuid: `b-${hookEvent}`, attachment: { type: 'hook_blocking_error', hookName: hookEvent, hookEvent, toolUseID: 'h1', blockingError },
  })
  const summary = line({ type: 'system', subtype: 'stop_hook_summary', hookCount: 2, hookInfos: [], hookErrors: [], preventedContinuation: false, stopReason: '', hasOutput: false, level: 'suggestion' })
  const answer = (text: string) => line({ type: 'assistant', uuid: `a-${text}`, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } })

  it('opens the goal\'s next iteration as a turn of its own, and closes it at its end', () => {
    const state = newTurnState()
    expect(lineToEvents(user('/goal every page loads under a second'), state)).toEqual([{ type: 'turn_started', payload: { userMessage: '/goal every page loads under a second' } }])
    expect(lineToEvents(answer('made the home page fast'), state).at(-1)).toEqual({ type: 'turn_ended', payload: {} })
    expect(lineToEvents(feedback, state)).toEqual([])
    expect(lineToEvents(goal(false), state)).toEqual([{ type: 'turn_started', payload: { userMessage: 'Continuing goal: every page loads under a second' } }])
    expect(state.turnOpen).toBe(true)
    expect(state.continued).toBe(true)
    expect(lineToEvents(summary, state)).toEqual([])
    expect(lineToEvents(answer('made the rest fast'), state)).toEqual([
      { type: 'text_delta', payload: { content: 'made the rest fast' } },
      { type: 'turn_ended', payload: {} },
    ])
    // A goal met ends nothing more than the end_turn before it did; a goal restated at start opens nothing.
    expect(lineToEvents(goal(true), state)).toEqual([])
    expect(lineToEvents(goal(false, { sentinel: true }), state)).toEqual([])
    expect(state.turnOpen).toBe(false)
  })

  it('opens the turn a person\'s own blocking Stop hook continues, labelled with its first line', () => {
    const state = newTurnState()
    expect(lineToEvents(blocked('Stop', { blockingError: 'Run the tests before you finish.\nThey are in test/.', command: 'check.sh' }), state))
      .toEqual([{ type: 'turn_started', payload: { userMessage: 'Continuing: Run the tests before you finish.' } }])
    const long = newTurnState()
    expect((lineToEvents(blocked('Stop', { blockingError: 'x'.repeat(300) }), long)[0].payload as { userMessage: string }).userMessage)
      .toBe(`Continuing: ${'x'.repeat(197)}...`)
    expect(lineToEvents(blocked('Stop', {}), newTurnState())).toEqual([{ type: 'turn_started', payload: { userMessage: 'Continuing' } }])
    expect(lineToEvents(goal(false, { condition: undefined }), newTurnState())).toEqual([{ type: 'turn_started', payload: { userMessage: 'Continuing goal' } }])
    // A sub-agent's Stop is its own business, and a turn still open (its end_turn not read yet) goes on.
    expect(lineToEvents(blocked('SubagentStop', { blockingError: 'no' }), newTurnState())).toEqual([])
    const open = newTurnState()
    lineToEvents(user('fix it'), open)
    expect(lineToEvents(goal(false), open)).toEqual([])
    expect(open.continued).toBe(false)
  })

  it('closes a pass that ends with no output when the goal pauses, and only such a pass', () => {
    const informational = (content: string) => line({ type: 'system', subtype: 'informational', content, level: 'notice' })
    const duration = line({ type: 'system', subtype: 'turn_duration', durationMs: 42_000, messageCount: 12 })
    const state = newTurnState()
    lineToEvents(user('/goal every page loads under a second'), state)
    lineToEvents(answer('made the home page fast'), state)
    lineToEvents(feedback, state)
    lineToEvents(goal(false), state)
    for (const record of [summary, informational('A hook blocked the stop twice — pausing.'), informational('Goal paused · resume with /goal')]) {
      expect(lineToEvents(record, state)).toEqual([])
    }
    expect(lineToEvents(duration, state)).toEqual([{ type: 'turn_ended', payload: {} }])
    expect(state.turnOpen).toBe(false)
    expect(lineToEvents(duration, state)).toEqual([])
    // A turn a prompt opened is left to its end_turn and the Stop hook, as before.
    const prompted = newTurnState()
    lineToEvents(user('fix it'), prompted)
    expect(lineToEvents(duration, prompted)).toEqual([])
    expect(prompted.turnOpen).toBe(true)
    lineToEvents(feedback, prompted)
    lineToEvents(answer('fixed'), prompted)
    lineToEvents(goal(false), prompted)
    lineToEvents(user('and the rest'), prompted)
    expect(lineToEvents(duration, prompted)).toEqual([])
    expect(lineToEvents(duration, { ...newTurnState(), turnOpen: true })).toEqual([])
  })

  it('shows the continuation in the history once, where the live view started it', () => {
    const contents = messagesToEvents([user('/goal every page loads under a second'), answer('made the home page fast'), feedback, goal(false), blocked('Stop', { blockingError: 'not yet' }), summary, answer('made the rest fast')])
      .filter((e) => e.type === 'user_message' || e.type === 'text_delta').map((e) => (e.payload as { content: string }).content)
    expect(contents).toEqual(['/goal every page loads under a second', 'made the home page fast', 'Continuing goal: every page loads under a second', 'made the rest fast'])
  })
})
