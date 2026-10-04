import { appendFileSync, chmodSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexNormalizer, codexGoalOf, startsCodexTurn } from '../engines/codex/normalizer.js'
import { canonical, fromTheEnd, goalForgotten, newFold, session, wholeHistory } from '../testing/transcriptOracle.js'
import {
  attachTranscript,
  claudeAttachRules,
  codexAttachRules,
  HEAD_RECORD_LIMIT,
  isWholeRecord,
  locateAttachSpan,
  replayAttachSpan,
  type AttachRules,
} from './attachTranscript.js'
import { foldTranscript, lastTurnTextFromRawLines, lineToEvents, newTurnState, selectClaudeRecapLine, startsClaudeTurn, TranscriptFold, type LiveEvent } from './normalize.js'
import { RuntimeProfileManager } from './runtimeProfile.js'
import { tailFile, tailFileUntil } from './transcriptTail.js'
import { Watcher, type LineEvent } from '../watcher/watcher.js'

// ── Codex records, in the shapes a 0.159 rollout writes ──────────────────────────────────────────────
const cx = (type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: '2026-10-03T23:21:44.458Z', type, payload })
const codex = {
  meta: (version = '0.159.0') => cx('session_meta', { id: 'thread-1', cli_version: version, cwd: '/tmp/work' }),
  context: (model: string, effort: string | null, mode: string | null) => cx('turn_context', {
    turn_id: 't', model, ...(effort ? { reasoning_effort: effort } : {}), ...(mode ? { collaboration_mode: { mode } } : {}),
  }),
  settings: (model: string, effort: string, mode: string) => cx('event_msg', {
    type: 'thread_settings_applied', thread_settings: { model, reasoning_effort: effort, collaboration_mode: { mode } },
  }),
  started: (turn: string) => cx('event_msg', { type: 'task_started', turn_id: turn }),
  user: (text: string) => cx('event_msg', { type: 'user_message', message: text }),
  userItem: (text: string) => cx('event_msg', {
    type: 'item_completed', turn_id: 't', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text, text_elements: [] }] },
  }),
  goal: (objective: string) => cx('response_item', {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: `<codex_internal_context source="goal">\n<objective>${objective}</objective>\n</codex_internal_context>` }],
  }),
  developer: (text: string) => cx('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }),
  agent: (text: string, phase = 'final_answer') => cx('event_msg', {
    type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text }], phase },
  }),
  reasoning: (text: string) => cx('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text }] }),
  call: (id: string, cmd: string) => cx('response_item', { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd }) }),
  output: (id: string, output: string) => cx('response_item', { type: 'function_call_output', call_id: id, output }),
  complete: (turn: string) => cx('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: 'done' }),
  aborted: (turn: string) => cx('event_msg', { type: 'turn_aborted', turn_id: turn }),
  compacted: (bytes: number) => cx('compacted', { message: '📘é'.repeat(bytes / 6), replacement_history: [] }),
  contextCompacted: () => cx('event_msg', { type: 'context_compacted' }),
  tokens: () => cx('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } }),
}

/** A rollout with every shape attach has to get right, in the order Codex writes them. */
const codexScenario = (): string[] => [
  codex.meta(),
  codex.developer('<permissions instructions>'),
  codex.settings('gpt-5.5', 'high', 'default'),
  codex.started('t1'), codex.context('gpt-5.5', 'high', 'default'), codex.user('first question'),
  codex.reasoning('Planning'), codex.call('c1', 'ls'), codex.output('c1', 'a\nb'), codex.agent('one answer'), codex.complete('t1'),
  codex.started('t2'), codex.context('gpt-6', 'xhigh', 'plan'), codex.userItem('second, in the item shape'),
  codex.reasoning('Thinking 漢字 📘'), codex.agent('looking', 'commentary'),
  codex.compacted(150_000), codex.contextCompacted(), codex.tokens(),
  codex.call('c2', 'npm test'), codex.output('c2', 'ok'), codex.agent('second answer'), codex.complete('t2'),
  codex.settings('gpt-6', 'low', 'default'),
  codex.started('t3'), codex.context('gpt-6', null, 'default'), codex.user('third: effort left out'),
  codex.call('c3', 'sleep 1'),
  codex.user(''), // an empty message opens nothing
  codex.output('c3', 'slept'), codex.complete('t3'),
  codex.started('t4'), codex.context('gpt-6', 'medium', 'default'), codex.user('interrupted one'), codex.aborted('t4'),
  codex.started('t5'), codex.context('gpt-6', 'medium', 'default'), codex.goal('ship the release'), codex.reasoning('goal work'), codex.complete('t5'),
  codex.started('t6'), codex.context('gpt-6', 'medium', 'default'), codex.goal('ship the release'), codex.agent('continuing'), codex.complete('t6'),
  codex.started('t7'), codex.context('gpt-6', 'medium', 'default'), codex.user('a question mid-goal'), codex.complete('t7'),
  codex.started('t8'), codex.context('gpt-6', 'medium', 'default'), codex.goal('ship the release'), codex.reasoning('still the goal'),
  codex.call('c8', 'make'), codex.complete('t8'),
  codex.started('t9'), codex.context('gpt-6', 'max', 'plan'), codex.goal('a different goal'), codex.reasoning('new goal'),
  codex.complete('t9'),
  // A message sent mid-task, with a call still in flight: its output arrives after the new message.
  codex.started('t10'), codex.context('gpt-6', 'max', 'default'), codex.user('start the build'),
  codex.call('c10', 'make all'), codex.user('also run the tests while that builds'),
  codex.output('c10', 'built'), codex.reasoning('now the tests'), codex.call('c11', 'npm test'),
]

// ── Claude Code records ───────────────────────────────────────────────────────────────────────────────
let uuid = 0
const cl = (record: Record<string, unknown>): string => JSON.stringify({
  parentUuid: null, isSidechain: false, userType: 'external', cwd: '/tmp', sessionId: 's', version: '2.1.212',
  timestamp: '2026-10-03T23:21:44.458Z', uuid: `u${++uuid}`, ...record,
})
const claude = {
  user: (content: unknown, extra: Record<string, unknown> = {}) => cl({ type: 'user', message: { role: 'user', content }, ...extra }),
  assistant: (content: unknown[], stop: string | null, model = 'claude-opus-5-5') =>
    cl({ type: 'assistant', message: { id: `m${uuid}`, role: 'assistant', model, content, stop_reason: stop } }),
  text: (text: string) => ({ type: 'text', text }),
  thinking: (thinking: string) => ({ type: 'thinking', thinking }),
  tool: (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } }),
  result: (id: string, content: string) => cl({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }),
  compact: () => cl({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } }),
  summary: () => cl({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary of the earlier conversation' } }),
}

const claudeScenario = (): string[] => [
  JSON.stringify({ type: 'summary', summary: 'Earlier work', leafUuid: 'x' }),
  claude.user('first prompt'),
  claude.assistant([claude.thinking('let me think'), claude.text('First answer.')], 'end_turn'),
  claude.user('second prompt with a tool'),
  claude.assistant([claude.text('Checking.'), claude.tool('toolu_1', 'ls')], 'tool_use'),
  claude.result('toolu_1', 'files'),
  claude.assistant([claude.thinking('found them 漢字'), claude.text('Done: '.repeat(20_000))], 'end_turn', 'claude-fable-5-1'),
  claude.user('<local-command-stdout>Set model to Opus 5.5</local-command-stdout>'),
  claude.user('<bash-input>git status</bash-input><bash-stdout>clean</bash-stdout>'),
  claude.user('third prompt, interrupted'),
  claude.assistant([claude.tool('toolu_2', 'sleep 100')], 'tool_use'),
  claude.user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
  claude.user('<task-notification><task-id>a</task-id><tool-use-id>toolu_9</tool-use-id><status>completed</status><summary>bg done</summary></task-notification>'),
  claude.compact(), claude.summary(),
  claude.user('loop iteration', { isMeta: true, promptSource: 'system' }),
  claude.assistant([claude.text('Loop ran.')], 'end_turn', '<synthetic>'),
  claude.user('a bookkeeping line', { isMeta: true }),
  claude.user('fourth prompt'),
  claude.assistant([claude.text('Working on it'), claude.tool('toolu_3', 'make')], 'tool_use'),
  claude.result('toolu_3', 'built'),
  claude.assistant([claude.thinking('almost'), claude.text('Built it.')], 'end_turn'),
  claude.user('fifth prompt, left running'),
  claude.assistant([claude.tool('toolu_4', 'npm test')], 'tool_use'),
  // A prompt that lands while a call is in flight: the result arrives after it, naming its call.
  claude.user('sixth prompt, typed during the tests'),
  claude.result('toolu_4', 'tests passed'),
  claude.assistant([claude.thinking('reading results'), claude.text('All green.')], 'end_turn'),
]

describe('attachTranscript', () => {
  let dir: string, file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'attach-transcript-')); file = join(dir, 'rollout.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // The guarantee: at every point a daemon could attach — after any record, mid-record, with either
  // line ending — the end-first read leaves the fold, the chips and the next live events exactly where
  // reading the whole history would.
  describe.each([['codex', codexScenario], ['claude', claudeScenario]] as const)('%s: equals the whole-history attach', (engine, scenario) => {
    const records = scenario()
    const cuts = records.map((_, index) => index + 1)

    it.each(cuts)('after record %i, then streams the rest identically', async (cut) => {
      for (const separator of ['\n', '\r\n']) {
        writeFileSync(file, records.slice(0, cut).join(separator) + separator)
        const whole = await wholeHistory(engine, file, false)
        const tail = await fromTheEnd(engine, file, false)
        expect(tail.turnOpen).toBe(whole.turnOpen)
        expect(tail.opened).toEqual(whole.opened)
        expect(tail.profile).toEqual(whole.profile)
        expect(tail.content).toBe(whole.content)
        expect(tail.next).toBe(Buffer.byteLength(records.slice(0, cut).join(separator) + separator))
        const rest = records.slice(cut)
        const expected = rest.flatMap(whole.ingest)
        expect(canonical(rest.flatMap(tail.ingest))).toEqual(canonical(engine === 'codex' ? goalForgotten(records, cut, expected) : expected))
      }
    })

    it.each(cuts)('with record %i still being written, leaves it to the tail', async (cut) => {
      const done = records.slice(0, cut - 1)
      const prefix = done.length ? done.join('\n') + '\n' : ''
      const half = records[cut - 1].slice(0, Math.floor(records[cut - 1].length / 2))
      writeFileSync(file, prefix + half)
      const whole = await wholeHistory(engine, file, false)
      const tail = await fromTheEnd(engine, file, false)
      expect(tail.turnOpen).toBe(whole.turnOpen)
      expect(tail.opened).toEqual(whole.opened)
      expect(tail.profile).toEqual(whole.profile)
      expect(tail.content).toBe(true)
      // The tail picks the half-written record up whole, where the whole-history attach lost it.
      expect(tail.next).toBe(Buffer.byteLength(prefix))
      const rest = records.slice(cut - 1)
      const expected = rest.flatMap(whole.ingest)
      expect(canonical(rest.flatMap(tail.ingest))).toEqual(canonical(engine === 'codex' ? goalForgotten(records, cut - 1, expected) : expected))
    })

    it.each(cuts)('replays a first-turn transcript of %i records live, whole', async (cut) => {
      writeFileSync(file, records.slice(0, cut).join('\n'))
      const whole = await wholeHistory(engine, file, true)
      const tail = await fromTheEnd(engine, file, true)
      expect(canonical(tail.live)).toEqual(canonical(whole.live))
      expect(tail.turnOpen).toBe(false)
      expect(tail.profile).toEqual(whole.profile)
    })
  })

  it('labels a goal turn after an ordinary opener as the goal submission, and nothing else changes', async () => {
    const records = [codex.goal('ship'), codex.complete('a'), codex.user('a question'), codex.complete('b')]
    writeFileSync(file, records.join('\n') + '\n')
    const whole = await wholeHistory('codex', file, false)
    const tail = await fromTheEnd('codex', file, false)
    const next = [codex.goal('ship'), codex.agent('more'), codex.complete('c'), codex.goal('ship')]
    const opened = (events: LiveEvent[]) => events.filter((event) => event.type === 'turn_started').map((event) => event.payload)
    expect(opened(next.flatMap(whole.ingest))).toEqual([{ userMessage: 'Continuing goal: ship' }, { userMessage: 'Continuing goal: ship' }])
    expect(opened(next.flatMap(tail.ingest))).toEqual([{ userMessage: '/goal ship' }, { userMessage: 'Continuing goal: ship' }])
  })

  it('keeps the continuation label when the open turn is itself a goal turn', async () => {
    writeFileSync(file, [codex.goal('ship'), codex.complete('a'), codex.user('q'), codex.complete('b'), codex.goal('ship'), codex.reasoning('go')].join('\n') + '\n')
    expect((await fromTheEnd('codex', file, false)).opened).toEqual({ type: 'turn_started', payload: { userMessage: 'Continuing goal: ship' } })
    expect((await wholeHistory('codex', file, false)).opened).toEqual({ type: 'turn_started', payload: { userMessage: 'Continuing goal: ship' } })
  })

  it('reports a forked rollout\'s own CLI version, where the whole fold ends on its parent\'s', async () => {
    // A fork opens with its own session_meta, then copies its parent's history, the parent's own included.
    const turn = (id: string, text: string) => [codex.started(id), codex.context('gpt-6', 'high', 'default'), codex.user(text)]
    writeFileSync(file, [codex.meta('0.160.0'), codex.meta('0.159.0'), ...turn('t1', 'go'), codex.complete('t1'), ...turn('t2', 'again')].join('\n') + '\n')
    expect((await wholeHistory('codex', file, false)).profile).toEqual({ model: 'gpt-6', effort: 'high', mode: 'default', cliVersion: '0.159.0' })
    expect((await fromTheEnd('codex', file, false)).profile).toEqual({ model: 'gpt-6', effort: 'high', mode: 'default', cliVersion: '0.160.0' })
  })

  it('reads only the last turn of a long history, never the rest', async () => {
    const history = codexScenario()
    const turn = [codex.started('t-last'), codex.context('gpt-6', 'high', 'default'), codex.user('last'), codex.reasoning('now')]
    writeFileSync(file, [...history, ...Array(200).fill(codex.compacted(30_000)), codex.complete('x'), ...turn].join('\n') + '\n')
    const fields = (line: string) => new RuntimeProfileManager().transcriptFields(session('codex'), line)
    const span = await locateAttachSpan(file, codexAttachRules(fields))
    const full = Buffer.byteLength([...history, ...Array(200).fill(codex.compacted(30_000)), codex.complete('x')].join('\n') + '\n')
    // Codex's turn begins at its task_started; the turn_context after it already sets every field.
    expect(span).toMatchObject({ turnFrom: full, profileFrom: full, seeds: [] })
    expect(span?.head).toBe(history[0])
  })
})

describe('locateAttachSpan', () => {
  let dir: string, file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'attach-span-')); file = join(dir, 't.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const opener = (line: string) => line.startsWith('{"open"')
  const rules = (over: Partial<AttachRules> = {}): AttachRules => ({
    startsTurn: opener, turnMarkers: [Buffer.from('open')], fields: () => [], required: [], ...over,
  })

  it('returns the whole file for an empty transcript or a first turn', async () => {
    writeFileSync(file, '')
    expect(await locateAttachSpan(file, rules())).toEqual({ end: 0, turnFrom: 0, profileFrom: 0, head: null, seeds: [] })
    writeFileSync(file, '{"open":1}\n{"x":1}\n')
    expect(await locateAttachSpan(file, rules(), { fromStart: true })).toEqual({ end: 19, turnFrom: 0, profileFrom: 0, head: null, seeds: [] })
  })

  it('never decodes a record without a turn marker to ask whether it opens a turn', async () => {
    writeFileSync(file, ['{"open":1}', '{"open":2}', ...Array(50).fill('{"noise":"x"}')].join('\n'))
    const asked: string[] = []
    const span = await locateAttachSpan(file, rules({ startsTurn: (line) => { asked.push(line); return opener(line) } }))
    expect(asked).toEqual(['{"open":2}'])
    expect(span?.turnFrom).toBe(11)
  })

  it('takes the whole file as the turn when nothing opens one', async () => {
    writeFileSync(file, '{"a":1}\n{"b":2}\n')
    expect(await locateAttachSpan(file, rules())).toEqual({ end: 16, turnFrom: 0, profileFrom: 0, head: null, seeds: [] })
  })

  it('reaches back past the opener only as far as the newest record setting each missing field', async () => {
    const lines = ['{"meta":1}', '{"model":"old","effort":"low"}', '{"effort":"high"}', '{"x":1}', '{"open":1}', '{"model":"new"}']
    writeFileSync(file, lines.join('\n'))
    const fields = (line: string) => {
      const record = JSON.parse(line) as Record<string, unknown>
      return (['model', 'effort'] as const).filter((field) => field in record)
    }
    const span = await locateAttachSpan(file, rules({ fields, required: ['model', 'effort'] }))
    const offset = (index: number) => Buffer.byteLength(lines.slice(0, index).join('\n') + '\n')
    expect(span).toEqual({ end: Buffer.byteLength(lines.join('\n')), turnFrom: offset(4), profileFrom: offset(2), head: '{"meta":1}', seeds: [] })
  })

  it('asks only marked records about fields, and stops at BOF when a field is never set', async () => {
    writeFileSync(file, ['{"settings":1}', '{"x":2}', '{"open":1}'].join('\n'))
    const asked: string[] = []
    const span = await locateAttachSpan(file, rules({
      fields: (line) => { asked.push(line); return [] },
      fieldMarkers: [Buffer.from('settings')],
      required: ['mode'],
    }))
    expect(asked).toEqual(['{"settings":1}'])
    expect(span).toMatchObject({ turnFrom: 23, profileFrom: 23, head: '{"settings":1}' })
  })

  it('finds the seed an opener depends on, and gives up on it at BOF', async () => {
    const lines = ['{"goal":"a"}', '{"x":1}', '{"open":1,"goal":"a"}']
    writeFileSync(file, lines.join('\n'))
    const seeded = rules({
      seedFor: (line) => (line.includes('goal') ? (candidate) => candidate.includes('goal') : null),
      seedMarkers: [Buffer.from('goal')],
    })
    expect((await locateAttachSpan(file, seeded))?.seeds).toEqual(['{"goal":"a"}'])
    writeFileSync(file, lines.slice(1).join('\n'))
    expect((await locateAttachSpan(file, seeded))?.seeds).toEqual([])
    writeFileSync(file, '{"goal":"a"}\n{"open":2}')
    expect((await locateAttachSpan(file, seeded))?.seeds).toEqual([])
  })

  it('stops reaching back for fields and seeds at the reach limit', async () => {
    const lines = ['{"model":"far","goal":1}', ...Array(20).fill('{"pad":"xxxxxxxxxxxxxxxxxxxx"}'), '{"open":1,"goal":1}', '{"x":1}']
    writeFileSync(file, lines.join('\n'))
    const reaching = rules({
      fields: (line) => (line.includes('model') ? ['model'] : []),
      required: ['model'],
      seedFor: () => (line) => line.includes('goal'),
      seedMarkers: [Buffer.from('goal')],
    })
    const opener = Buffer.byteLength(lines.slice(0, 21).join('\n') + '\n')
    expect(await locateAttachSpan(file, reaching, { reach: 100 })).toEqual({
      end: Buffer.byteLength(lines.join('\n')), turnFrom: opener, profileFrom: opener, head: '{"model":"far","goal":1}', seeds: [],
    })
    expect(await locateAttachSpan(file, reaching, { reach: opener })).toMatchObject({ profileFrom: 0, head: null, seeds: ['{"model":"far","goal":1}'] })
  })

  it('leaves the head out when it is the opener itself or too large to be metadata', async () => {
    writeFileSync(file, '{"open":1}\n{"x":1}')
    expect((await locateAttachSpan(file, rules()))?.head).toBeNull()
    writeFileSync(file, `{"big":"${'x'.repeat(HEAD_RECORD_LIMIT)}"}\n{"open":1}\n`)
    expect(await locateAttachSpan(file, rules())).toMatchObject({ turnFrom: HEAD_RECORD_LIMIT + 11, head: null })
  })

  it('reports a file that shrank under the walk', async () => {
    writeFileSync(file, ['{"open":1}', ...Array(10_000).fill('{"noise":"xxxxxxxxxxxxxxxx"}')].join('\n'))
    expect(await locateAttachSpan(file, rules({
      startsTurn: () => false,
      turnMarkers: [Buffer.from('noise')],
      fields: () => { truncateSync(file, 10); return [] },
      required: ['model'],
    }))).toBeNull()
  })
})

describe('replayAttachSpan', () => {
  let dir: string, file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'attach-replay-')); file = join(dir, 't.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('feeds the head and older records to the profile only, the seed to the fold first', async () => {
    writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n')
    const seen: string[] = []
    const read = await replayAttachSpan(file, { end: 32, turnFrom: 16, profileFrom: 8, head: '{"a":1}', seeds: ['{"s":0}'] }, {
      profile: (line) => seen.push(`profile ${line}`),
      fold: (line) => seen.push(`fold ${line}`),
      observe: (line) => seen.push(`observe ${line}`),
    })
    expect(seen).toEqual([
      'profile {"a":1}', 'fold {"s":0}',
      'profile {"b":2}',
      'profile {"c":3}', 'observe {"c":3}', 'fold {"c":3}',
      'profile {"d":4}', 'observe {"d":4}', 'fold {"d":4}',
    ])
    expect(read).toEqual({ next: 32, records: 2, content: true })
  })

  it('counts a record still being written as content without feeding it', async () => {
    writeFileSync(file, '{"half":')
    const fed: string[] = []
    const read = await replayAttachSpan(file, { end: 8, turnFrom: 0, profileFrom: 0, head: null, seeds: [] }, {
      profile: (line) => fed.push(line), fold: (line) => fed.push(line),
    })
    expect(fed).toEqual([])
    expect(read).toEqual({ next: 0, records: 0, content: true })
  })

  it('says a whitespace-only transcript has no content', async () => {
    writeFileSync(file, '  \n\n')
    expect(await replayAttachSpan(file, { end: 4, turnFrom: 0, profileFrom: 0, head: null, seeds: [] }, { profile: () => {}, fold: () => {} }))
      .toEqual({ next: 4, records: 0, content: false })
  })

  it('hands the tail the span end when the file shrank under the replay', async () => {
    writeFileSync(file, '{"a":1}\n')
    expect(await replayAttachSpan(file, { end: 500, turnFrom: 0, profileFrom: 0, head: null, seeds: [] }, { profile: () => {}, fold: () => {} }))
      .toEqual({ next: 500, records: 0, content: false })
  })
})

describe('attachTranscript retries', () => {
  let dir: string, file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'attach-retry-')); file = join(dir, 't.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // 21 bytes a record, each carrying its index, so a rule can tell which walk is looking at it.
  const noise = (count: number) => Array.from({ length: count }, (_, i) => `{"noise":"${String(i).padStart(8, '0')}"}`).join('\n') + '\n'
  const indexOf = (line: string) => Number((JSON.parse(line) as { noise: string }).noise)

  it('walks again after a shrink, then replays the whole of whatever is left', async () => {
    writeFileSync(file, noise(14_000))
    let shrinks = 0
    const folded: string[] = []
    const read = await attachTranscript(file, {
      startsTurn: () => false,
      turnMarkers: [Buffer.from('noise')],
      fields: (line) => {
        // Each walk sees the file cut well below the next chunk it is going to read.
        if (shrinks === 0 && indexOf(line) >= 7_000) { shrinks++; writeFileSync(file, noise(7_000)) }
        else if (shrinks === 1 && indexOf(line) < 7_000) { shrinks++; writeFileSync(file, noise(3)) }
        return []
      },
      required: ['model'],
    }, { profile: () => {}, fold: (line) => folded.push(line) })
    expect(shrinks).toBe(2)
    expect(read).toMatchObject({ turnFrom: 0, profileFrom: 0, records: 3, end: 63, next: 63 })
    expect(folded).toHaveLength(3)
  })

  it('uses the second walk when only the first is disturbed', async () => {
    writeFileSync(file, noise(14_000))
    let shrinks = 0
    const read = await attachTranscript(file, {
      startsTurn: () => false,
      turnMarkers: [Buffer.from('noise')],
      fields: () => { if (!shrinks++) writeFileSync(file, '{"open":1}\n'); return [] },
      required: ['model'],
    }, { profile: () => {}, fold: () => {} })
    expect(read).toMatchObject({ end: 11, records: 1, next: 11 })
  })
})

describe('turn openers match the normalizers exactly', () => {
  const claudeCorpus = [
    ...claudeScenario(), '', '   ', 'not json', 'null', '42', '"text"', '[]',
    claude.user([]), claude.user(null), claude.user([{ type: 'text', text: '' }]),
    claude.user([{ type: 'image', source: {} }, { type: 'text', text: 'look' }]),
    claude.user('[Request interrupted by user]'),
    claude.user('<system-reminder>only a reminder</system-reminder>'),
    JSON.stringify({ type: 'user', message: { role: 'assistant', content: 'odd' } }),
    JSON.stringify({ type: 'user' }),
  ]
  it.each(claudeCorpus.map((line, index) => [index, line] as const))('claude record %i', (_, line) => {
    const opened = lineToEvents(line, newTurnState()).some((event) => event.type === 'turn_started')
    expect(startsClaudeTurn(line)).toBe(opened)
  })

  const codexCorpus = [
    ...codexScenario(), '', 'not json', 'null', cx('event_msg', {}), JSON.stringify({ type: 'event_msg' }),
    cx('event_msg', { type: 'UserMessage', message: 'old vocabulary' }),
    cx('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [] } }),
    cx('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<codex_internal_context source="goal"><objective>x</objective>' }] }),
    cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<codex_internal_context source="goal">no objective' }] }),
    cx('compacted', { type: 'user_message', message: 'inside a compaction' }),
  ]
  it.each(codexCorpus.map((line, index) => [index, line] as const))('codex record %i', (_, line) => {
    const opened = new CodexNormalizer('live', () => null).ingest(line).some((event) => event.type === 'turn_started')
    expect(startsCodexTurn(line)).toBe(opened)
  })

  it('reads a goal objective only from a goal injection', () => {
    expect(codexGoalOf(codex.goal('ship it'))).toBe('ship it')
    expect(codexGoalOf(codex.user('ship it'))).toBeNull()
    expect(codexGoalOf(codex.developer('<codex_internal_context source="goal"><objective>x</objective>'))).toBeNull()
    expect(codexGoalOf(cx('response_item', { type: 'reasoning' }))).toBeNull()
    expect(codexGoalOf('not json')).toBeNull()
  })
})

describe('rules', () => {
  it('give Codex its markers, fields and goal seed', () => {
    const rules = codexAttachRules(() => [])
    expect(rules.required).toEqual(['model', 'effort', 'mode'])
    expect(rules.seedFor?.(codex.user('x'))).toBeNull()
    const seed = rules.seedFor?.(codex.goal('g'))
    expect(seed?.(codex.goal('other'))).toBe(true)
    expect(seed?.(codex.user('g'))).toBe(false)
    for (const line of codexScenario().filter(startsCodexTurn)) {
      expect(rules.turnMarkers.some((marker) => Buffer.from(line).includes(marker))).toBe(true)
    }
  })

  it('give Claude its marker and the model alone', () => {
    const rules = claudeAttachRules(() => [])
    expect(rules.required).toEqual(['model'])
    expect(rules.fieldMarkers).toBeUndefined()
    expect(rules.seedFor).toBeUndefined()
    for (const line of claudeScenario().filter(startsClaudeTurn)) {
      expect(rules.turnMarkers.some((marker) => Buffer.from(line).includes(marker))).toBe(true)
    }
  })

  it('treat a record without a line ending as whole only when it parses', () => {
    expect(isWholeRecord('{"a":1}')).toBe(true)
    expect(isWholeRecord('{"a":')).toBe(false)
  })
})

describe('TranscriptFold', () => {
  it('matches foldTranscript, keeping only the last turn_started of the history', () => {
    const lines = claudeScenario()
    for (const live of [false, true]) {
      const a = newTurnState(), b = newTurnState()
      const whole = foldTranscript((line) => lineToEvents(line, a), lines, () => a.turnOpen, { live })
      const stream = new TranscriptFold((line) => lineToEvents(line, b), () => b.turnOpen, live)
      for (const line of lines) stream.push(line)
      const out = stream.finish()
      expect(out.turnOpen).toBe(whole.turnOpen)
      expect(out.live).toEqual(whole.live)
      expect(out.history).toEqual(whole.history.filter((event) => event.type === 'turn_started').slice(-1))
    }
    expect(new TranscriptFold(() => [], () => true, false).finish()).toEqual({ history: [], live: [], turnOpen: true })
  })
})

describe('the Claude recap reads only its last turn', () => {
  let dir: string, file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-recap-')); file = join(dir, 's.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const records = claudeScenario()

  it.each(records.map((_, index) => index + 1))('matches the whole-file recap after record %i', async (cut) => {
    writeFileSync(file, records.slice(0, cut).join('\n') + '\n')
    const whole = lastTurnTextFromRawLines(await tailFile(file, Infinity))
    expect(lastTurnTextFromRawLines(await tailFileUntil(file, selectClaudeRecapLine))).toEqual(whole)
  })

  it('keeps a turn that never reached an answer, and skips records the recap ignores', async () => {
    writeFileSync(file, [claude.user('q'), claude.assistant([claude.text('Let me look'), claude.tool('t', 'ls')], 'tool_use'), claude.result('t', 'x'), 'null', claude.compact()].join('\n'))
    expect(lastTurnTextFromRawLines(await tailFileUntil(file, selectClaudeRecapLine))).toEqual({ userMessage: 'q', assistantText: 'Let me look' })
    expect(selectClaudeRecapLine('not json')).toBe('skip')
    expect(selectClaudeRecapLine(JSON.stringify({ type: 'system' }))).toBe('skip')
  })
})

describe('the review of the first cut', () => {
  let dir: string, file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'attach-review-')); file = join(dir, 'rollout.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // A reset (Codex fires SessionStart on every compaction) re-reads a session that is being tailed.
  // The tail is held for the whole attach: the read stops where delivery stopped, a record written
  // meanwhile reaches only the new fold, and nothing is delivered twice.
  it('hands a tailed session over to the new fold without losing or repeating a record', async () => {
    const open = [codex.meta(), codex.started('t1'), codex.context('gpt-6', 'high', 'default'), codex.user('go'), codex.reasoning('working')]
    writeFileSync(file, open.join('\n') + '\n')
    const watcher = new Watcher()
    const seen: Array<{ fold: string; text: string }> = []
    let current = 'old'
    watcher.on('line', (event: LineEvent) => seen.push({ fold: current, text: event.text }))
    await watcher.addSession({ sessionId: 's1', engine: 'codex', transcriptPath: file })
    appendFileSync(file, codex.agent('still going') + '\n')
    await watcher.pollSession('s1')
    expect(seen.map((line) => line.fold)).toEqual(['old'])

    const hold = (await watcher.hold('s1', file))!
    const heldAt = hold.offset
    expect(heldAt).toBe(Buffer.byteLength([...open, codex.agent('still going')].join('\n') + '\n'))
    const replacement = newFold('codex')
    const stream = new TranscriptFold(replacement.ingest, replacement.turnOpen, false)
    const read = await attachTranscript(file, codexAttachRules(() => []), {
      // Written while the attach reads: the turn ends.
      start: () => { appendFileSync(file, codex.complete('t1') + '\n') },
      profile: () => {},
      fold: (line) => stream.push(line),
    }, { end: heldAt })
    // Held: nothing reaches the old fold, however long it waits (a drain would wait for the release).
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(seen).toHaveLength(1)
    expect(stream.finish().turnOpen).toBe(true)
    expect(read.next).toBe(heldAt)

    current = 'new'
    hold.release(read.next)
    await watcher.pollSession('s1')
    expect(seen).toEqual([{ fold: 'old', text: codex.agent('still going') }, { fold: 'new', text: codex.complete('t1') }])
    for (const line of seen.filter((entry) => entry.fold === 'new')) replacement.ingest(line.text)
    expect(replacement.turnOpen()).toBe(false)
    await watcher.stop()
  })

  it('shows the device the record Codex writes before the opener, which is the turn\'s input', async () => {
    const input = cx('response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }],
      internal_chat_message_metadata_passthrough: { turn_id: 't1', content_item_kinds: ['user.text'] },
    })
    writeFileSync(file, [codex.meta(), codex.started('t1'), codex.context('gpt-6', 'high', 'default'), input, codex.userItem('go'), codex.reasoning('x')].join('\n') + '\n')
    const observed: string[] = []
    await attachTranscript(file, codexAttachRules(() => []), { profile: () => {}, fold: () => {}, observe: (line) => observed.push(line) })
    expect(observed).toContain(input)
    expect(observed[0]).toBe(codex.started('t1'))
  })

  it('treats a transcript that is missing as an empty history, as the whole read did', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fed: string[] = []
      const read = await attachTranscript(file, codexAttachRules(() => []), { profile: (line) => fed.push(line), fold: (line) => fed.push(line) })
      expect(read).toMatchObject({ next: 0, records: 0, content: false, turnFrom: 0, seeds: [], failed: true })
      expect(fed).toEqual([])
      expect(warn).toHaveBeenCalledOnce()
    } finally { warn.mockRestore() }
  })

  // A read that fails must not hand the tail byte 0: from there it would deliver every old turn as a
  // new one. It hands it the end it was reading to, and says it failed.
  it.each([
    ['cannot be read at all', () => { chmodSync(file, 0o000) }, () => {}],
    ['stops being readable once its span is found', () => {}, () => { chmodSync(file, 0o000) }],
  ])('resumes the tail at the end of a transcript that %s', async (_, prepare, start) => {
    const content = [codex.started('t1'), codex.user('a'), codex.complete('t1')].join('\n') + '\n'
    writeFileSync(file, content)
    prepare()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const read = await attachTranscript(file, codexAttachRules(() => []), { start, profile: () => {}, fold: () => {} })
      expect(read).toMatchObject({ next: Buffer.byteLength(content), records: 0, content: true, failed: true })
      chmodSync(file, 0o600)
      prepare()
      const boundary = Buffer.byteLength(codex.started('t1') + '\n' + codex.user('a') + '\n')
      const held = await attachTranscript(file, codexAttachRules(() => []), { start, profile: () => {}, fold: () => {} }, { end: boundary })
      expect(held).toMatchObject({ next: boundary, failed: true })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
      chmodSync(file, 0o600)
    }
  })

  // A consumer that throws loses that record, not the attach: the read still ends exactly where it
  // stopped, so a record the engine writes meanwhile — whole, or still being written — is tailed.
  it.each([
    ['whole', (record: string) => [record + '\n', '']],
    ['half-written', (record: string) => [record.slice(0, 20), record.slice(20) + '\n']],
  ])('tails a record written %s while a consumer throws', async (_, split) => {
    const content = [codex.started('t1'), codex.user('a'), codex.complete('t1')].join('\n') + '\n'
    writeFileSync(file, content)
    const record = codex.user('a prompt typed while the daemon was attaching')
    const [now, later] = split(record)
    const folded: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const read = await attachTranscript(file, codexAttachRules(() => []), {
        profile: () => { throw new Error('profile') },
        fold: (line) => {
          if (!folded.length) { appendFileSync(file, now); folded.push(line); throw new Error('boom') }
          folded.push(line)
        },
        observe: () => { throw new Error('device') },
      })
      expect(read).toMatchObject({ next: Buffer.byteLength(content), records: 3, failed: false })
      expect(folded).toEqual([codex.started('t1'), codex.user('a'), codex.complete('t1')])
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0][0]).toContain('7 record(s) could not be taken in: Error: profile')
      const watcher = new Watcher()
      const lines: string[] = []
      watcher.on('line', (event: LineEvent) => lines.push(event.text))
      await watcher.addSession({ sessionId: 's', engine: 'codex', transcriptPath: file }, { fromOffset: read.next })
      appendFileSync(file, later)
      await watcher.pollSession('s')
      await watcher.stop()
      expect(lines).toEqual([record])
    } finally { warn.mockRestore() }
  })

  it('names thinking blocks so no two windows of one session share an id, and one window keeps its names', async () => {
    const records = claudeScenario()
    const ids = async (cut: number) => {
      writeFileSync(file, records.slice(0, cut).join('\n') + '\n')
      const tail = await fromTheEnd('claude', file, false)
      const next = [claude.user('next'), claude.assistant([claude.thinking('a'), claude.thinking('b')], 'end_turn')]
      return next.flatMap(tail.ingest).flatMap((event) => {
        const id = (event.payload as { thinkingId?: string }).thinkingId
        return event.type === 'thinking_delta' && id ? [id] : []
      })
    }
    const early = await ids(10)
    const late = await ids(records.length)
    expect(early).toHaveLength(2)
    expect(new Set([...early, ...late]).size).toBe(4)
    expect(await ids(records.length)).toEqual(late)
  })

  it('reaches back for the call a turn\'s result answers, and only within reach', async () => {
    const call = claude.assistant([claude.tool('toolu_far', 'make')], 'tool_use')
    const lines = [claude.user('first'), call, claude.user('second, mid-call'), claude.result('toolu_far', 'made')]
    writeFileSync(file, lines.join('\n') + '\n')
    expect((await locateAttachSpan(file, claudeAttachRules(() => [])))?.seeds).toEqual([call])
    expect((await locateAttachSpan(file, claudeAttachRules(() => []), { reach: 1 }))?.seeds).toEqual([])
    writeFileSync(file, [claude.user('first'), claude.user('second'), claude.result('', 'no id')].join('\n') + '\n')
    expect((await locateAttachSpan(file, claudeAttachRules(() => [])))?.seeds).toEqual([])
  })

  it('does not look past a finished task for the beginning of a turn that has none', async () => {
    writeFileSync(file, [codex.started('t1'), codex.user('a'), codex.complete('t1'), codex.user('b, no task_started')].join('\n') + '\n')
    const span = await locateAttachSpan(file, codexAttachRules(() => []))
    expect(span?.turnFrom).toBe(Buffer.byteLength([codex.started('t1'), codex.user('a'), codex.complete('t1')].join('\n') + '\n'))
  })
})

describe('the walk, at its edges', () => {
  let dir: string, file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'attach-edges-')); file = join(dir, 't.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps looking for a task\'s beginning past a record that only mentions one', async () => {
    const mention = codex.agent('the task_complete event is next')
    const lines = [codex.started('t1'), codex.user('a'), mention, codex.user('b')]
    writeFileSync(file, lines.join('\n') + '\n')
    expect((await locateAttachSpan(file, codexAttachRules(() => [])))?.turnFrom).toBe(0)
  })

  it('feeds several calls still running, oldest first', async () => {
    const first = claude.assistant([claude.tool('toolu_a', 'make')], 'tool_use')
    const second = claude.assistant([claude.tool('toolu_b', 'npm test')], 'tool_use')
    writeFileSync(file, [claude.user('go'), first, second, claude.user('while both run')].join('\n') + '\n')
    expect((await locateAttachSpan(file, claudeAttachRules(() => [])))?.seeds).toEqual([first, second])
  })

  it('counts an answer before the turn as answered, and passes over one without an id', async () => {
    const lines = [
      claude.user('first'), claude.assistant([claude.tool('toolu_done', 'ls')], 'tool_use'),
      claude.result('toolu_done', 'ok'), claude.result('', 'stray'), claude.user('second'),
    ]
    writeFileSync(file, lines.join('\n') + '\n')
    expect((await locateAttachSpan(file, claudeAttachRules(() => [])))?.seeds).toEqual([])
  })
})
