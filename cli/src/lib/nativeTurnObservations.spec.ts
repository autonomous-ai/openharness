import { expect, it, vi } from 'vitest'
import { createNativeTurnObservations, inputContextIn, nativeSubmitKey, nativeTurnBinding, nativeTurnCursorIn, nativeTurnPageIn,
  NATIVE_TURN_LEASE_MS, NATIVE_TURN_TEXT_LIMIT } from './nativeTurnObservations.js'
import type { LiveEvent } from '../engines/kit/events.js'

const context = 'fixture-native-context'
const start = (userMessage = 'Review this change'): LiveEvent => ({ type: 'turn_started', payload: { userMessage } })
const text = (content = 'The change is ready.'): LiveEvent => ({ type: 'text_delta', payload: { content } })
const end = (aborted = false): LiveEvent => ({ type: 'turn_ended', payload: aborted ? { aborted: true } : {} })
function setup() {
  let time = 0, sequence = 0
  let binding: { sessionId: string; engine: string; runtime: string } | null = { sessionId: 'session', engine: 'claude', runtime: 'tmux/%1' }
  const resolve = vi.fn(() => binding)
  const turns = createNativeTurnObservations({ resolve, now: () => time, id: () => `fixture-observation-${++sequence}` })
  return { turns, resolve, advance: (ms: number) => { time += ms }, bind: (next: typeof binding) => { binding = next } }
}

it('records only observed live prompts and answers, with a stable turn identity and no tools or thinking', () => {
  const f = setup()
  f.turns.ingest('agent', [start('Private old prompt'), text('Private old answer'), end()])
  const before = f.turns.read('agent')!
  expect(before.observations).toEqual([])
  f.turns.typed('agent', context)
  f.turns.typed('agent', context, true)
  f.turns.ingest('agent', [start(), { type: 'thinking_delta', payload: { content: 'private reasoning' } },
    { type: 'tool_start', payload: { id: 'tool', tool: 'Read', input: 'private file' } }, text(), end()])
  const page = f.turns.read('agent', before.cursor)!
  expect(page.gap).toBe(false)
  expect(page.observations).toEqual([
    { sequence: 1, turnId: 'fixture-observation-2', kind: 'prompt', text: 'Review this change', inputContext: context, interrupted: false, truncated: false },
    { sequence: 2, turnId: 'fixture-observation-2', kind: 'answer', text: 'The change is ready.', inputContext: context, interrupted: false, truncated: false },
  ])
  expect(f.turns.read('agent', page.cursor)?.observations).toEqual([])
  page.observations[0].text = 'Mutated by reader'
  expect(f.turns.read('agent', before.cursor)?.observations[0].text).toBe('Review this change')
  expect(nativeTurnPageIn(page)).toEqual(page)
})

it('does not infer identity from a draft, ambiguous input, a previous turn or a programmatic paste', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  f.turns.typed('agent', context)
  f.turns.ingest('agent', [start('An autonomous turn'), end()])
  f.turns.typed('agent', 'other-valid-context', true)
  f.turns.ingest('agent', [start('Mixed draft'), end()])
  f.turns.typed('agent', context, true)
  f.turns.submitting('agent')
  f.turns.typed('agent', context, true)
  f.turns.ingest('agent', [start('Programmatic paste'), end()])
  f.turns.ingest('agent', [start('Queued unclaimed input'), end(), start('Second queued unclaimed input'), end()])
  f.turns.typed('agent', context, true)
  f.turns.ingest('agent', [start('Native prompt'), end(), start('Another autonomous turn'), end()])
  expect(f.turns.read('agent', cursor)!.observations.filter(e => e.kind === 'prompt').map(e => e.inputContext))
    .toEqual([null, null, null, null, null, context, null])
  f.turns.typed('not-observed', context, true)
  f.turns.submitting('not-observed')
})

it('retains several queued native submissions from one context, and withholds ambiguous or excessive queues', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  for (let n = 0; n < 3; n++) f.turns.typed('agent', context, true)
  for (let n = 0; n < 3; n++) f.turns.ingest('agent', [start(), end()])
  expect(f.turns.read('agent', cursor)!.observations.map(e => e.inputContext)).toEqual(Array(6).fill(context))
  const next = f.turns.read('agent')!.cursor
  f.turns.typed('agent', context, true)
  f.turns.typed('agent', 'other-native-context', true)
  f.turns.ingest('agent', [start(), end(), start(), end()])
  expect(f.turns.read('agent', next)!.observations.every(e => e.inputContext === null)).toBe(true)
  for (let n = 0; n < 40; n++) f.turns.typed('agent', context, true)
  f.turns.submitting('agent')
  const overflow = f.turns.read('agent')!.cursor
  for (let n = 0; n < 40; n++) f.turns.ingest('agent', [start(), end()])
  expect(f.turns.read('agent', overflow)!.observations.every(e => e.inputContext === null)).toBe(true)
})

it('keeps unknown and malformed input context unknown', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  f.turns.typed('agent', 'bad')
  f.turns.typed('agent', context, true)
  f.turns.ingest('agent', [start(), end()])
  expect(f.turns.read('agent', cursor)?.observations[0].inputContext).toBeNull()
  const page = f.turns.read('agent', cursor)!
  expect(page.observations.every(event => event.unattributedInput === true)).toBe(true)
  expect(nativeTurnPageIn(page)).toEqual(page)
  expect(nativeTurnPageIn({ ...page, observations: [{ ...page.observations[0], unattributedInput: 'yes' }] })).toBeNull()
  const beforeProgrammatic = f.turns.read('agent')!.cursor
  f.turns.submitting('agent'); f.turns.ingest('agent', [start(), end()])
  expect(f.turns.read('agent', beforeProgrammatic)!.observations.every(event => !event.unattributedInput)).toBe(true)
  expect(inputContextIn({ id: context })).toBeNull()
})

it('attributes a composed native message at its actual write boundary and withholds overlapping provenance', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  f.turns.submitting('agent', context)
  f.turns.ingest('agent', [start('Composed message'), text(), end()])
  expect(f.turns.read('agent', cursor)!.observations.every(event => event.inputContext === context)).toBe(true)
  const before = f.turns.read('agent')!.cursor
  f.turns.typed('agent', 'another-native-context', true)
  f.turns.submitting('agent', context)
  f.turns.ingest('agent', [start(), end(), start(), end()])
  expect(f.turns.read('agent', before)!.observations.every(event => event.inputContext === null && event.unattributedInput)).toBe(true)
})

it('marks unfinished turns interrupted and caps long prompt/answer content without collecting tool output', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  const long = 'x'.repeat(NATIVE_TURN_TEXT_LIMIT + 10)
  f.turns.ingest('agent', [text('before prompt'), start(long), text(long), text(long), start('Next'), end(true), end()])
  const events = f.turns.read('agent', cursor)!.observations
  expect(events).toHaveLength(4)
  expect(events[0]).toMatchObject({ kind: 'prompt', truncated: true, text: long.slice(0, NATIVE_TURN_TEXT_LIMIT) })
  expect(events[1]).toMatchObject({ kind: 'answer', truncated: true, interrupted: true, text: long.slice(0, NATIVE_TURN_TEXT_LIMIT) })
  expect(events[3]).toMatchObject({ kind: 'answer', text: '', interrupted: true })
})

it('keeps a bounded Unicode prefix and never appends later output after truncation', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  const prefix = 'x'.repeat(NATIVE_TURN_TEXT_LIMIT - 1)
  f.turns.ingest('agent', [start(`${prefix}🙂`), text(`${prefix}🙂`), text('unrelated later output'), end()])
  expect(f.turns.read('agent', cursor)!.observations.map(e => e.text)).toEqual([prefix, prefix])
  const current = f.turns.read('agent')!.cursor
  f.turns.ingest('agent', [start(), text('x'.repeat(NATIVE_TURN_TEXT_LIMIT)), text('overflow'), end()])
  expect(f.turns.read('agent', current)!.observations[1]).toMatchObject({ truncated: true, text: 'x'.repeat(NATIVE_TURN_TEXT_LIMIT) })
})

it('starts a new reader at the current boundary and makes replay/rebinding gaps explicit', () => {
  const f = setup(), before = f.turns.read('agent')!.cursor
  f.turns.ingest('agent', [start(), text(), end()])
  expect(f.turns.read('agent')!.observations).toEqual([])
  f.turns.ingest('agent', [start('Old replayed prompt'), text('Old answer'), end()], true)
  const replayed = f.turns.read('agent', before)!
  expect(replayed).toMatchObject({ observations: [], gap: true })
  f.bind({ sessionId: 'new-session', engine: 'codex', runtime: 'tmux/%2' })
  const rebound = f.turns.read('agent', replayed.cursor)!
  expect(rebound).toMatchObject({ observations: [], gap: true })
  f.bind(null)
  expect(f.turns.read('agent', rebound.cursor)).toBeNull()
  f.turns.typed('agent', context)
})

it('expires unused leases, retains none of the unobserved interval and detects impossible cursors', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  f.turns.ingest('agent', [start(), end()])
  f.advance(NATIVE_TURN_LEASE_MS)
  f.turns.ingest('agent', [start('Unobserved'), end()])
  const renewed = f.turns.read('agent', cursor)!
  expect(renewed).toMatchObject({ gap: true, observations: [] })
  expect(f.turns.read('agent', { ...renewed.cursor, sequence: 1000 })).toMatchObject({ gap: true, observations: [] })
})

it('bounds global retained text and reports precisely when a reader fell behind', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  for (let n = 0; n < 40; n++) f.turns.ingest('agent', [start('x'.repeat(NATIVE_TURN_TEXT_LIMIT)), text('y'.repeat(NATIVE_TURN_TEXT_LIMIT)), end()])
  const page = f.turns.read('agent', cursor)!
  expect(page.gap).toBe(true)
  expect(page.observations.reduce((size, e) => size + e.text.length, 0)).toBeLessThanOrEqual(1024 * 1024)
  expect(page.observations[0].sequence).toBeGreaterThan(1)
  const floor = page.observations[0].sequence - 1
  expect(f.turns.read('agent', { ...cursor, sequence: floor })?.gap).toBe(false)
})

it('bounds record counts and active subscriptions without a background timer', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  for (let n = 0; n < 300; n++) f.turns.ingest('agent', [start(''), end()])
  expect(f.turns.read('agent', cursor)?.observations).toHaveLength(512)
  for (let n = 1; n < 256; n++) expect(f.turns.read(`agent-${n}`)).not.toBeNull()
  expect(f.turns.read('one-too-many')).toBeNull()
  f.advance(NATIVE_TURN_LEASE_MS)
  expect(f.turns.read('one-too-many')).not.toBeNull()
})

it('uses real clock and unique epochs by default', () => {
  const turns = createNativeTurnObservations({ resolve: () => ({ sessionId: 'session', engine: 'claude', runtime: 'tmux/%1' }) })
  expect(nativeTurnCursorIn(turns.read('agent')?.cursor)).not.toBeNull()
})

it('binds an observation to the actual native conversation and runtime', () => {
  expect(nativeTurnBinding(undefined)).toBeNull()
  expect(nativeTurnBinding({ sessionId: '', engine: 'claude', primaryRuntimeKey: null })).toBeNull()
  expect(nativeTurnBinding({ sessionId: 'session', engine: 'claude', primaryRuntimeKey: null })).toEqual({ sessionId: 'session', engine: 'claude', runtime: '' })
  expect(nativeTurnBinding({ sessionId: 'session', engine: 'claude', primaryRuntimeKey: 'tmux/%1' })).toEqual({ sessionId: 'session', engine: 'claude', runtime: 'tmux/%1' })
})

it.each(['\r', '\n', '\r\n', '\x1b[13u', '\x1b[13;1u'])('recognizes a standalone submit key: %j', key => {
  expect(nativeSubmitKey(Buffer.from(key))).toBe(true)
})
it.each(['', 'draft\r', '\x1b\r', '\x1b[13;2u', '\x1b[I', '\x03', 'a long pasted text\n'])('leaves non-submit or ambiguous input unclaimed: %j', key => {
  expect(nativeSubmitKey(Buffer.from(key))).toBe(false)
})
it('does not strip high bits from a malformed escape sequence', () => {
  expect(nativeSubmitKey(Uint8Array.from([0x9b, 0x5b, 0x31, 0x33, 0x75]))).toBe(false)
})

it('rejects malformed page envelopes and cursor values instead of advancing a durable consumer', () => {
  const f = setup(), cursor = f.turns.read('agent')!.cursor
  f.turns.ingest('agent', [start(), end()])
  const page = f.turns.read('agent', cursor)!, first = page.observations[0]
  for (const bad of [null, 2, {}, { epoch: context, sequence: -1 }, { epoch: 'short', sequence: 0 }]) expect(nativeTurnCursorIn(bad)).toBeNull()
  for (const bad of [null, 2, {}, { ...page, gap: 'yes' }, { ...page, observations: {} }, { ...page, observations: Array(513).fill(first) }]) {
    expect(nativeTurnPageIn(bad)).toBeNull()
  }
  for (const event of [null, 3, { ...first, sequence: 4 }, { ...first, sequence: 0.5 },
    { ...first, turnId: '' }, { ...first, kind: 'tool' }, { ...first, text: false },
    { ...first, text: 'x'.repeat(NATIVE_TURN_TEXT_LIMIT + 1) }, { ...first, truncated: 0 },
    { ...first, interrupted: 0 }, { ...first, inputContext: '' },
  ]) expect(nativeTurnPageIn({ ...page, observations: [event] })).toBeNull()
  expect(nativeTurnPageIn({ ...page, observations: [first, first] })).toBeNull()
})
