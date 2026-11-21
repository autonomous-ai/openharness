import { Hash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createSessionOwners } from './sessionOwners.js'
import { createQuestionPresentations } from '../questions.js'
import { answerExperimentQuery } from '../experimentQueries.js'
import { fakeCore } from '../../testing/fakeCore.js'
import { SESSION_FACTS_FORMAT, encodeSessionFacts, sessionFrame, type SessionFacts } from '../../lib/sessionPresentation.js'
import { emptySessionFingerprint, sessionImageHash, SESSION_OWNER_LIMITS, type OwnerAppend, type OwnerCard, type OwnerResult,
  type SessionOwnerLimits } from '../../lib/sessionOwnerWire.js'

const row = (id = 'owned', overrides: Partial<SessionFacts> = {}): SessionFacts => ({ id, engine: 'fixture', name: id,
  createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z', ...overrides })
const image = (rows: SessionFacts[]) => {
  const hash = sessionImageHash()
  rows.forEach((value, i) => { if (i) hash.update(','); hash.update(encodeSessionFacts(value)) })
  return hash.update(']').digest('hex')
}
const card = (id: string): OwnerCard => ({ type: 'commander_event', agentId: id, dbSessionId: id,
  payload: { kind: 'processing', text: 'Working' } })
const cleanups: Array<() => void> = []
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.useRealTimers() })
function fixture(limits: SessionOwnerLimits = SESSION_OWNER_LIMITS, onQuestion?: () => void) {
  const events: string[] = [], native = new Set<string>()
  let current = true, failBroadcast = false, ordinal = 0
  const authority = { service: 'component', identity: {}, current: () => current }
  const owners = createSessionOwners({ factoryOwner: name => name === 'fixture' ? { kind: 'service', service: 'component' }
    : name === 'other' ? { kind: 'service', service: 'second' } : undefined,
    native: id => native.has(id), port: () => null, whenStarting: () => null, questions: createQuestionPresentations(), limits, log: () => {},
    clients: { send(frame) {
      if (failBroadcast) throw new Error('synthetic client failure')
      events.push(frame.type === 'agent_synced' ? `row:${(frame.payload.agent as { id: string }).id}` : `delete:${frame.payload.agentId}`)
    }, sendCommander(frame) { if (frame.type === 'commander_event') events.push(`card:${frame.agentId}`) }, sendLocal() { onQuestion?.() } } })
  cleanups.push(owners.stop)
  const doors = owners.bound(authority)
  const begin = (rows: SessionFacts[], before = emptySessionFingerprint(), after = image(rows)) => {
    const transfer = `t${++ordinal}`
    expect(doors.begin({ format: SESSION_FACTS_FORMAT, transfer, factory: 'fixture', before, after, count: rows.length })).toEqual({ ok: true })
    return transfer
  }
  const append = (transfer: string, rows: SessionFacts[], index = 0, cards: OwnerCard[] = []) => doors.append({ transfer, index,
    rows: rows.map(facts => ({ facts, ...(cards.find(card => card.agentId === facts.id) ? { card: cards.find(card => card.agentId === facts.id)! } : {}) })) })
  const publish = (rows: SessionFacts[], before = emptySessionFingerprint(), cards: OwnerCard[] = []) => {
    const transfer = begin(rows, before)
    if (rows.length) expect(append(transfer, rows, 0, cards)).toEqual({ ok: true })
    return doors.end(transfer)
  }
  return { owners, doors, events, native, authority, begin, append, publish,
    revoke() { current = false }, fail() { failBroadcast = true }, resume() { failBroadcast = false } }
}

it('atomically installs ordered rows/cards then omissions, with only the accepted common fingerprint in recovery', () => {
  const f = fixture(), first = [row('gone')], next = [row('a'), row('b')]
  expect(f.doors.checkpoint('fixture')).toEqual({ fingerprint: emptySessionFingerprint() })
  expect(f.publish(first)).toEqual({ ok: true }); f.events.length = 0
  const transfer = f.begin(next, image(first))
  expect(f.append(transfer, next, 0, [card('b'), card('a')])).toEqual({ ok: true })
  expect(f.owners.frames()).toEqual(first.map(value => sessionFrame(value)))
  expect(f.doors.checkpoint('fixture')).toEqual({ fingerprint: image(first) })
  expect(f.events).toEqual([])
  expect(f.doors.end(transfer)).toEqual({ ok: true })
  expect(f.events).toEqual(['row:a', 'card:a', 'row:b', 'card:b', 'delete:gone'])
  expect(f.doors.checkpoint('fixture')).toEqual({ fingerprint: image(next) })
})

it('refuses a 257-row chunk without changing either accepted state or its valid stage continuation', () => {
  const f = fixture(), rows = Array.from({ length: 257 }, (_, i) => row(`id_${i}`)), transfer = f.begin(rows)
  expect(f.append(transfer, rows)).toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
  expect(f.owners.frames()).toEqual([]); expect(f.events).toEqual([])
  expect(f.append(transfer, rows.slice(0, 256))).toEqual({ ok: true })
  expect(f.append(transfer, rows.slice(256), 256)).toEqual({ ok: true })
  expect(f.doors.end(transfer)).toEqual({ ok: true })
  expect(f.owners.frames().map(value => value.id)).toEqual(rows.map(value => value.id))
})

it.each(['wrong count', 'wrong hash', 'duplicate id', 'wrong index', 'malformed row', 'foreign card', 'wrong card name'])
('refuses %s through the real dispatcher without replacing an accepted owner', async reason => {
  const f = fixture(), old = [row('existing')], next = [row('new')]
  expect(f.publish(old)).toEqual({ ok: true }); f.events.length = 0
  const transfer = f.begin(next, image(old), reason === 'wrong hash' ? image([]) : image(next))
  const value: OwnerAppend = { transfer, index: reason === 'wrong index' ? 1 : 0, rows: [{ facts: next[0] }] }
  if (reason === 'duplicate id') value.rows.push({ facts: next[0] })
  if (reason === 'malformed row') value.rows[0].facts = { id: 'new' } as SessionFacts
  if (reason === 'foreign card') value.rows[0].card = card('foreign')
  if (reason === 'wrong card name') value.rows[0].card = { ...card('new'), name: 'Wrong' }
  const proof = { current: () => true, ownsRequest: () => false }
  let result = reason === 'wrong count' ? { ok: true } : await answerExperimentQuery(fakeCore(), new Set(), 'component',
    'session_owner_append', value as unknown as Record<string, unknown>, undefined, proof, f.doors)
  if (result?.ok === true) result = await answerExperimentQuery(fakeCore(), new Set(), 'component', 'session_owner_end',
    { transfer }, undefined, proof, f.doors)
  expect(result).toMatchObject({ ok: false })
  expect(f.owners.frames()).toEqual(old.map(value => sessionFrame(value))); expect(f.events).toEqual([])
  expect(f.doors.checkpoint('fixture')).toEqual({ fingerprint: image(old) })
})

it.each(['before begin', 'during append'] as const)('permits safe omitted native takeover %s but refuses retaining that owner', phase => {
  for (const retained of [false, true]) {
    const f = fixture(), old = [row('a')], next = retained ? old : []
    expect(f.publish(old)).toEqual({ ok: true }); f.events.length = 0
    const claim = () => { f.native.add('a'); f.owners.nativeEntered('a', '') }
    if (phase === 'before begin') claim()
    const transfer = f.begin(next, image(old))
    let result: OwnerResult = { ok: true }
    if (retained) result = f.append(transfer, next) as OwnerResult
    if (phase === 'during append') claim()
    if (result.ok) result = f.doors.end(transfer) as OwnerResult
    expect(result).toEqual(retained ? { ok: false, error: 'SESSION_OWNER_CONFLICT' } : { ok: true })
    expect(f.events).toEqual([]); expect(f.owners.frames()).toEqual([])
    f.native.delete('a')
    expect(f.owners.owns('a')).toBe(false)
    expect(f.doors.checkpoint('fixture')).toEqual(retained ? { ok: false, error: 'SESSION_OWNER_CONFLICT' }
      : { fingerprint: emptySessionFingerprint() })
  }
})

it('does not let omission bypass a wrong hash or an expired physical owner', () => {
  const f = fixture(), old = [row()]
  expect(f.publish(old)).toEqual({ ok: true }); f.native.add('owned'); f.owners.nativeEntered('owned', '')
  const transfer = f.begin([], image(old), image(old))
  expect(f.doors.end(transfer)).toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
  const next = f.begin([], image(old)); f.revoke()
  expect(f.doors.end(next)).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  const reconnect = f.owners.bound({ ...f.authority, identity: {}, current: () => true })
  expect(reconnect.end(next)).toEqual({ ok: false, error: 'SESSION_OWNER_EXPIRED' })
})

it('installs the complete accepted map before a broadcast failure, permitting exact lost-ACK recovery', () => {
  const f = fixture(), rows = [row('a'), row('b')], transfer = f.begin(rows)
  expect(f.append(transfer, rows)).toEqual({ ok: true }); f.fail()
  expect(f.doors.end(transfer)).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  expect(f.owners.frames()).toEqual(rows.map(value => sessionFrame(value)))
  expect(f.doors.checkpoint('fixture')).toEqual({ fingerprint: image(rows) })
  f.resume(); expect(f.publish(rows, image(rows))).toEqual({ ok: true }); expect(f.events).toEqual([])
})

it('detaches admitted nested values and cards until end and rejects accessor/prototype authority', () => {
  const f = fixture(), facts = row('a', { app: { note: { value: 'captured' } } }), prepared = card('a'), transfer = f.begin([facts])
  expect(f.append(transfer, [facts], 0, [prepared])).toEqual({ ok: true })
  ;(facts.app!.note as { value: string }).value = 'changed'; prepared.payload.text = 'changed'
  expect(f.doors.end(transfer)).toEqual({ ok: true })
  expect(f.owners.frames()[0]).toMatchObject({ note: { value: 'captured' } })
  let reads = 0
  for (const bad of [Object.defineProperty({}, 'id', { enumerable: true, get() { reads++; return 'a' } }),
    { ...row('b'), app: JSON.parse('{"__proto__":{"id":"spoofed"}}') }, { ...row('b'), app: { id: 'spoofed' } }]) {
    const t = f.begin([row('b')], image([row('a', { app: { note: { value: 'captured' } } })]))
    expect(f.append(t, [bad as SessionFacts])).toMatchObject({ ok: false })
    f.doors.cancel(t)
  }
  expect(reads).toBe(0)
})

it('holds one stage only, binds empty catalogues to a declared factory, and uses an absolute timeout', async () => {
  vi.useFakeTimers()
  const f = fixture({ ...SESSION_OWNER_LIMITS, timeoutMs: 10 }), rows = [row('a'), row('b')]
  const transfer = f.begin(rows)
  const begin = { format: SESSION_FACTS_FORMAT, transfer: 'other', factory: 'fixture', before: image([]), after: image([]), count: 0 }
  expect(f.doors.begin(begin)).toEqual({ ok: false, error: 'SESSION_OWNER_BUSY' })
  expect(f.doors.begin({ ...begin, factory: 'other' })).toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
  expect(f.owners.bound({ service: 'second', identity: {}, current: () => true }).cancel(transfer)).toEqual({ ok: true })
  await vi.advanceTimersByTimeAsync(9)
  expect(f.append(transfer, rows.slice(0, 1))).toEqual({ ok: true })
  await vi.advanceTimersByTimeAsync(1)
  expect(f.append(transfer, rows.slice(1), 1)).toEqual({ ok: false, error: 'SESSION_OWNER_EXPIRED' })
  expect(f.doors.begin(begin)).toEqual({ ok: true }); expect(f.doors.cancel('other')).toEqual({ ok: true })
  expect(f.owners.frames()).toEqual([])
})

it.each(['bytes', 'objects', 'properties', 'slots'] as const)('charges every retained %s before commit without accepting a prefix', kind => {
  const limits = { ...SESSION_OWNER_LIMITS, catalogue: { ...SESSION_OWNER_LIMITS.catalogue, [kind]: kind === 'bytes' ? 100 : 2 } }
  const f = fixture(limits), facts = row('a', { app: { nested: [{ a: 1 }, { b: 2 }, { c: 3 }] } }), transfer = f.begin([facts])
  expect(f.append(transfer, [facts])).toEqual({ ok: false, error: 'SESSION_OWNER_LIMIT' })
  expect(f.owners.frames()).toEqual([]); expect(f.events).toEqual([])
})


it('preserves another declared service and its authority while replacing only the publishing service', () => {
  const f = fixture(), second = f.owners.bound({ service: 'second', identity: {}, current: () => true })
  const foreign = row('second', { engine: 'other' })
  expect(second.begin({ format: SESSION_FACTS_FORMAT, transfer: 'other', factory: 'other', before: image([]), after: image([foreign]), count: 1 })).toEqual({ ok: true })
  expect(second.append({ transfer: 'other', index: 0, rows: [{ facts: foreign }] })).toEqual({ ok: true })
  expect(second.end('other')).toEqual({ ok: true })
  f.events.length = 0
  expect(f.publish([row('first')])).toEqual({ ok: true })
  expect(f.owners.frames()).toEqual([foreign, row('first')].map(value => sessionFrame(value)))
  expect(f.events).toEqual(['row:first'])
  expect(second.checkpoint('other')).toEqual({ fingerprint: image([foreign]) })
  expect(f.doors.checkpoint('other')).toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
  const transfer = f.begin([row('second')], image([row('first')]))
  expect(f.append(transfer, [row('second')])).toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
  expect(f.publish([], image([row('first')]))).toEqual({ ok: true })
  expect(f.owners.frames()).toEqual([sessionFrame(foreign)])
  expect(second.checkpoint('other')).toEqual({ fingerprint: image([foreign]) })
})

it('counts retained foreign owners against the joint bound before admitting a new stage', () => {
  const f = fixture({ ...SESSION_OWNER_LIMITS, count: 1 })
  const second = f.owners.bound({ service: 'second', identity: {}, current: () => true }), foreign = row('second', { engine: 'other' })
  expect(second.begin({ format: SESSION_FACTS_FORMAT, transfer: 'other', factory: 'other', before: image([]), after: image([foreign]), count: 1 })).toEqual({ ok: true })
  expect(second.append({ transfer: 'other', index: 0, rows: [{ facts: foreign }] })).toEqual({ ok: true })
  expect(second.end('other')).toEqual({ ok: true })
  expect(f.doors.begin({ format: SESSION_FACTS_FORMAT, transfer: 'new', factory: 'fixture', before: image([]), after: image([row()]), count: 1 }))
    .toEqual({ ok: false, error: 'SESSION_OWNER_LIMIT' })
  expect(f.owners.frames()).toEqual([sessionFrame(foreign)])
})

it('refuses a stale before image and every operation on a disconnected bound door', () => {
  const f = fixture(), accepted = [row()]
  expect(f.publish(accepted)).toEqual({ ok: true })
  const begin = { format: SESSION_FACTS_FORMAT, transfer: 't', factory: 'fixture', before: image([]), after: image([]), count: 0 }
  expect(f.doors.begin(begin)).toEqual({ ok: false, error: 'SESSION_OWNER_CONFLICT' })
  f.revoke()
  for (const result of [f.doors.begin(begin), f.doors.checkpoint('fixture'), f.doors.cancel('t'),
    f.doors.ask('owned', 'q', {} as never), f.doors.unask('owned', 'q', {} as never)]) {
    expect(result).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  }
  expect(f.owners.frames()).toEqual(accepted.map(value => sessionFrame(value)))
})

it('enforces the absolute stage expiry even when the event loop has not delivered its timer', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
  try {
    const f = fixture({ ...SESSION_OWNER_LIMITS, timeoutMs: 10 }), transfer = f.begin([row()])
    clock.mockReturnValue(110)
    expect(f.append(transfer, [row()])).toEqual({ ok: false, error: 'SESSION_OWNER_EXPIRED' })
    expect(f.owners.frames()).toEqual([])
    expect(f.publish([])).toEqual({ ok: true })
  } finally { clock.mockRestore() }
})

it('rejects duplicate owners inside a declared two-row image and invalid stage envelopes without replacing accepted rows', () => {
  const f = fixture(), old = [row('old')]
  expect(f.publish(old)).toEqual({ ok: true })
  const begin = { format: SESSION_FACTS_FORMAT, transfer: 't', factory: 'fixture', before: image(old), after: image([]), count: 0 }
  for (const value of [null, [], { ...begin, extra: true }, { ...begin, [Symbol('extra')]: true }, Object.assign(Object.create({ inherited: true }), begin)]) {
    expect(f.doors.begin(value as never)).toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
  }
  const transfer = f.begin([row('new'), row('new')], image(old))
  expect(f.append(transfer, [row('new'), row('new')])).toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
  expect(f.owners.frames()).toEqual(old.map(value => sessionFrame(value)))
})

it('refuses decorated arrays and malformed append items, preserving the accepted image', () => {
  const f = fixture(), old = [row('old')]
  expect(f.publish(old)).toEqual({ ok: true })
  const extra = Object.assign([{ facts: row() }], { extra: true })
  const hidden = Object.defineProperty([{ facts: row() }], '0', { enumerable: false })
  for (const rows of [extra, hidden, [null], [{ facts: row(), extra: true }], [{ facts: row(), card: { ...card('owned'), extra: true } }],
    [{ facts: row(), card: { ...card('owned'), payload: [] } }]]) {
    const transfer = f.begin([row()], image(old))
    expect(f.doors.append({ transfer, index: 0, rows } as OwnerAppend)).toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
    f.doors.cancel(transfer)
    expect(f.owners.frames()).toEqual(old.map(value => sessionFrame(value)))
  }
})

it('charges the private incarnation and reserved revocation flag before accepting a row', () => {
  const f = fixture({ ...SESSION_OWNER_LIMITS, catalogue: { ...SESSION_OWNER_LIMITS.catalogue, properties: 6 } })
  const transfer = f.begin([row()])
  expect(f.append(transfer, [row()])).toEqual({ ok: false, error: 'SESSION_OWNER_LIMIT' })
  expect(f.owners.frames()).toEqual([])
})

it('reads activity snapshots and processing cards from the same accepted owner and stops reading a revoked owner', () => {
  const f = fixture(), rows = [row('empty'), row('no-snapshot', { work: {} }), row('snapshot', { work: { snapshot: true, processing: {} } }),
    row('text', { work: { text: 'Working', elapsedSeconds: 0, processing: {} } })]
  expect(f.publish(rows)).toEqual({ ok: true })
  expect(f.owners.activitySnapshot('absent')).toBeNull(); expect(f.owners.activitySnapshot('empty')).toBeNull()
  expect(f.owners.activitySnapshot('no-snapshot')).toBeNull(); expect(f.owners.activitySnapshot('snapshot')).toEqual({ text: '' })
  expect(f.owners.activitySnapshot('text')).toEqual({ text: 'Working', elapsedSeconds: 0 })
  expect(f.owners.liveCards()).toEqual([{ ...card('snapshot'), payload: { kind: 'processing', text: '' } },
    { ...card('text'), payload: { kind: 'processing', text: 'Working' } }])
  f.native.add('text'); f.owners.nativeEntered('text', '')
  expect(f.owners.activitySnapshot('text')).toBeNull()
  expect(f.owners.liveCards()).toEqual([{ ...card('snapshot'), payload: { kind: 'processing', text: '' } }])
})


it.each(['append', 'end'] as const)('refuses a stage that crosses its absolute deadline during %s hashing', phase => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
  const update = Hash.prototype.update
  let hashing: { mockRestore(): void } | undefined
  try {
    const f = fixture({ ...SESSION_OWNER_LIMITS, timeoutMs: 10 }), old = [row('old')], next = [row('new')]
    expect(f.publish(old)).toEqual({ ok: true }); f.events.length = 0
    const transfer = f.begin(next, image(old))
    if (phase === 'end') expect(f.append(transfer, next, 0, [card('new')])).toEqual({ ok: true })
    // Simulate elapsed CPU time after the real hash consumed its bytes. The event loop cannot deliver
    // the expiry timer while synchronous validation/hashing is running; admission must check the clock itself.
    hashing = vi.spyOn(Hash.prototype, 'update').mockImplementation(function (this: Hash, ...args: Parameters<Hash['update']>) {
      const result = Reflect.apply(update, this, args) as Hash
      clock.mockReturnValue(110)
      return result
    })
    const result = phase === 'append' ? f.append(transfer, next, 0, [card('new')]) : f.doors.end(transfer)
    hashing.mockRestore(); hashing = undefined
    expect(result).toEqual({ ok: false, error: 'SESSION_OWNER_EXPIRED' })
    expect(f.owners.frames()).toEqual(old.map(value => sessionFrame(value))); expect(f.events).toEqual([])
    expect(f.doors.checkpoint('fixture')).toEqual({ fingerprint: image(old) })
    clock.mockReturnValue(120)
    expect(f.publish(next, image(old), [card('new')])).toEqual({ ok: true })
    expect(f.events).toEqual(['row:new', 'card:new', 'delete:old'])
  } finally { hashing?.mockRestore(); clock.mockRestore() }
})

it('clears a cancelled stage timer before replacement, so its old deadline cannot drop the new stage', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const f = fixture({ ...SESSION_OWNER_LIMITS, timeoutMs: 10 }), first = f.begin([row('first')])
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(5)
  expect(f.doors.cancel(first)).toEqual({ ok: true }); expect(vi.getTimerCount()).toBe(0)
  const rows = [row('replacement')], replacement = f.begin(rows)
  await vi.advanceTimersByTimeAsync(5)
  expect(f.append(replacement, rows)).toEqual({ ok: true })
  expect(f.doors.end(replacement)).toEqual({ ok: true }); expect(vi.getTimerCount()).toBe(0)
  expect(f.owners.frames()).toEqual(rows.map(value => sessionFrame(value)))
  f.begin([], image(rows)); f.owners.stop(); expect(vi.getTimerCount()).toBe(0)
})

it('refuses a stale malformed question door without invoking input accessors or emitting an effect', () => {
  const f = fixture(), read = vi.fn(() => 'private canary')
  expect(f.publish([row()])).toEqual({ ok: true }); f.events.length = 0
  const malformed = Object.defineProperty({}, 'frame', { enumerable: true, get: read })
  f.revoke()
  expect(f.doors.ask('owned', 'q', malformed as never)).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  expect(f.doors.unask('owned', 'q', malformed as never)).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  expect(read).not.toHaveBeenCalled(); expect(f.events).toEqual([])
})


it('reports a failed question delivery and permits exact replay after the local client recovers', () => {
  let unavailable = true
  const f = fixture(undefined, () => { if (unavailable) throw new Error('private client detail') })
  expect(f.publish([row()])).toEqual({ ok: true }); f.events.length = 0
  const requestId = 'question', close = { type: 'commander_question_close' as const, agentId: 'owned', dbSessionId: 'owned', payload: { requestId } }
  const question = { frame: { type: 'commander_question' as const, agentId: 'owned', dbSessionId: 'owned', payload: {
    requestId, questions: [{ key: 'choice', q: 'Choose', options: ['Yes'], multi: false, canText: true }],
    notification: { id: requestId, kind: 'needsYou' as const } } }, close, dial: false }
  expect(f.doors.ask('owned', requestId, question)).toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
  expect(f.owners.frames()).toEqual([sessionFrame(row())]); expect(f.events).toEqual([])
  unavailable = false
  expect(f.doors.ask('owned', requestId, question)).toEqual({ ok: true })
  expect(f.doors.unask('owned', requestId, close)).toEqual({ ok: true })
})

it('replaces an abandoned physical stage and refuses its old append without disturbing the new link', () => {
  const f = fixture(), abandoned = f.begin([row('old')])
  f.revoke()
  const current = f.owners.bound({ service: 'component', identity: {}, current: () => true }), rows = [row('new')]
  expect(current.begin({ format: SESSION_FACTS_FORMAT, transfer: 'replacement', factory: 'fixture',
    before: image([]), after: image(rows), count: 1 })).toEqual({ ok: true })
  expect(f.append(abandoned, [row('old')])).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
  expect(current.append({ transfer: 'replacement', index: 0, rows: rows.map(facts => ({ facts })) })).toEqual({ ok: true })
  expect(current.end('replacement')).toEqual({ ok: true })
  expect(f.owners.frames()).toEqual(rows.map(value => sessionFrame(value))); expect(f.events).toEqual(['row:new'])
})
