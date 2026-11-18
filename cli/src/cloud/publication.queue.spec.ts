import { createQuestionPresentations } from '../core/questions.js'
import { cloudFactory } from '../testing/sessionFactories.js'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { CloudCore } from '../core/api.js'
import { createCloudAgents } from '../core/agents/cloud.js'
import { cloudAgentFrame, cloudFingerprint, cloudHarnessIn, type CloudHarness } from '../lib/cloudAgents.js'
import { prepareCloudCards } from './cards.js'
import { CLOUD_OUTPUT_BYTES, createCloudPublication, type CloudJournal } from './publication.js'

const row = (id = 'cloud_a', over: Partial<CloudHarness> = {}): CloudHarness => ({ agentId: id, agent: 'fo', name: id,
  state: 'working', activity: null, repository: null, branch: null, links: [], messages: 1,
  createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', ...over })
const done = (id = 'cloud_a', answer = 'First'): CloudHarness => row(id, { state: 'idle', said: answer, card: { recap: answer, text: answer } })
function setup() {
  const events: string[] = [], log = vi.fn()
  const core = createCloudAgents({ ownsFactory: cloudFactory, native: () => false, port: () => null, questions: createQuestionPresentations(), log: () => {}, clients: {
    send: () => {}, sendLocal: () => {}, sendCommander: frame => events.push(frame.type === 'agent_synced'
      ? `row:${(frame.payload.agent as { id: string }).id}` : frame.type === 'commander_event'
        ? `${frame.payload.kind}:${frame.agentId}` : frame.type === 'agent_deleted' ? `delete:${frame.payload.agentId}` : frame.type),
  } })
  let snapshot: CloudHarness[] = [], saved: CloudJournal | undefined
  const doors: CloudCore = { ...core.doors }
  const persist = vi.fn((journal: CloudJournal) => { saved = structuredClone(journal) })
  const make = () => createCloudPublication({ core: doors, saved, persist,
    snapshot: () => snapshot, questions: () => [], log })
  let publication = make()
  return { core, doors, events, log, persist, get publication() { return publication }, get saved() { return saved },
    rows(rows: CloudHarness[]) { snapshot = rows; publication.publish(rows) },
    snapshot(rows: CloudHarness[]) { snapshot = rows },
    async connect() { await publication.connect(); await vi.waitFor(() => expect(publication.state().pending).toBeNull()) },
    restart(legacy = saved) { publication.stop(); saved = legacy; publication = make() },
    close() { publication.stop() },
  }
}

it('shares each encoded publication row across card fingerprints and the final payload bound', async () => {
  const f = setup()
  try {
    await f.connect()
    const rows = [row('cloud_a'), row('cloud_b'), row('cloud_c')]
    const normalized = rows.map(value => cloudHarnessIn(value)!)
    const writes = f.persist.mock.calls.length
    const encode = vi.spyOn(JSON, 'stringify')
    let calls: unknown[]
    try {
      f.rows(rows)
      await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
      calls = encode.mock.calls.map(([value]) => value)
    } finally { encode.mockRestore() }
    const ownerArray = (value: unknown): value is CloudHarness[] => Array.isArray(value) && value.length > 0
      && value.every(owner => owner && typeof owner === 'object' && 'agentId' in owner && 'agent' in owner)
    const encodings = {
      catalogues: calls.filter(value => ownerArray(value) && value.length === rows.length).length,
      singletonOwners: calls.filter(value => ownerArray(value) && value.length === 1).length,
      fullPayloads: calls.filter(value => value && typeof value === 'object' && 'harnesses' in value
        && ownerArray(value.harnesses) && 'cards' in value).length,
    }
    expect(f.core.frames()).toEqual(normalized.map(cloudAgentFrame))
    expect(f.events).toEqual(['row:cloud_a', 'processing:cloud_a', 'row:cloud_b', 'processing:cloud_b', 'row:cloud_c', 'processing:cloud_c'])
    expect(f.publication.state().accepted.fingerprint).toBe(cloudFingerprint(normalized))
    expect(f.persist).toHaveBeenCalledTimes(writes + 1)
    expect(encodings).toEqual({ catalogues: 1, singletonOwners: 0, fullPayloads: 0 })
  } finally { f.close() }
})

it('keeps a prepared intent and cards fixed across an acknowledgement and captures the next mutation', async () => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    const source = done(), first = structuredClone(source)
    let release!: () => void
    const held = new Promise<{ ok: true }>(resolve => { release = () => resolve({ ok: true }) })
    const send = f.doors.publish
    const publications: Array<{ rows: CloudHarness[]; cards: unknown }> = []
    f.doors.publish = (rows, cards) => {
      publications.push(structuredClone({ rows, cards }))
      const result = send(rows, cards)
      return publications.length === 1 ? held.then(() => result) : result
    }
    const writes = f.persist.mock.calls.length
    f.rows([source])
    const intent = structuredClone(f.publication.state().pending)
    expect(intent?.fingerprint).toBe(cloudFingerprint([cloudHarnessIn(first)!]))
    expect(f.saved?.pending).toEqual(intent)
    source.name = 'Renamed'; source.said = 'Second'; source.card!.recap = 'Second'; source.card!.text = 'Second result'
    f.rows([source])
    expect(f.publication.state().pending).toEqual(intent)
    expect(f.saved?.pending).toEqual(intent)
    expect(f.persist).toHaveBeenCalledTimes(writes + 1)
    expect(publications).toHaveLength(1)
    release()
    await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    expect(publications.map(value => value.rows)).toEqual([[cloudHarnessIn(first)], [cloudHarnessIn(source)]])
    expect(publications.map(value => value.cards)).toEqual([first, source].map(value => [{
      type: 'commander_event', agentId: value.agentId, dbSessionId: value.agentId, name: value.name,
      payload: { kind: 'summary', ...value.card, notification: { id: `${value.agentId}:1`, kind: 'done' } },
    }]))
    expect(f.publication.state().accepted.fingerprint).toBe(cloudFingerprint([cloudHarnessIn(source)!]))
    expect(f.persist).toHaveBeenCalledTimes(writes + 2)
    expect(f.saved?.pending).toEqual(f.publication.state().accepted)
  } finally { f.close() }
})

it('holds every healthy-link transition and question behind an unknown acknowledgement', async () => {
  const f = setup()
  try {
    await f.connect()
    let release!: () => void
    const held = new Promise<{ ok: true }>(resolve => { release = () => resolve({ ok: true }) })
    const send = f.doors.publish
    f.doors.publish = (rows, cards) => { const result = send(rows, cards); f.doors.publish = send; return held.then(() => result) }
    f.rows([row()])
    f.rows([done()])
    f.publication.ask({ agentId: 'cloud_a', requestId: 'cloud_q_one', question: { text: 'Choose', choices: ['Yes'] } })
    f.rows([row(), row('cloud_b')])
    f.publication.unask('cloud_a', 'cloud_q_one')
    f.rows([done('cloud_a', 'Second')])
    expect(f.events).toEqual(['row:cloud_a', 'processing:cloud_a'])
    release()
    await vi.waitFor(() => expect(f.events.at(-1)).toBe('delete:cloud_b'))
    expect(f.events).toEqual(['row:cloud_a', 'processing:cloud_a', 'row:cloud_a', 'summary:cloud_a',
      'commander_question', 'row:cloud_a', 'processing:cloud_a', 'row:cloud_b', 'processing:cloud_b',
      'commander_question_close', 'row:cloud_a', 'summary:cloud_a', 'delete:cloud_b'])
  } finally { f.close() }
})

it('recovers a legacy same-image accepted/pending journal, then preserves add, rename and deletion', async () => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    f.rows([done()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    const accepted = f.publication.state().accepted
    const replay = prepareCloudCards([cloudHarnessIn(done())!], accepted)
    // Older components wrote this intent on every physical reconnect, including unchanged images.
    // Real card preparation proves either match has the same transition history in this ambiguous case.
    expect(replay.next).toEqual(accepted)
    expect(replay.cards).toEqual([])
    const body = { version: 1 as const, accepted, pending: replay.next }
    const legacy = { ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
    f.events.length = 0
    f.restart(legacy); await f.connect()
    expect(f.saved).toEqual(legacy)
    expect(f.publication.state().accepted).toEqual(accepted)
    expect(f.events).toEqual([])
    f.rows([{ ...done(), name: 'Renamed' }, row('cloud_b')])
    await vi.waitFor(() => expect(f.events).toContain('processing:cloud_b'))
    expect(f.core.frames()[0].name).toBe('Renamed')
    f.rows([row('cloud_b')]); await vi.waitFor(() => expect(f.events.at(-1)).toBe('delete:cloud_a'))
    expect(f.core.frames().map(frame => frame.id)).toEqual(['cloud_b'])
    expect(f.events.filter(event => event.startsWith('summary:'))).toEqual([])
  } finally { f.close() }
})

it('treats an applied empty image as quiet authority after a lost acknowledgement', async () => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    const send = f.doors.publish
    f.doors.publish = (rows, cards) => { send(rows, cards); return new Promise(() => {}) }
    f.rows([])
    expect(f.core.frames()).toEqual([])
    f.restart(); f.doors.publish = send; await f.connect()
    f.events.length = 0; f.rows([done()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    expect(f.events).toEqual(['row:cloud_a'])
  } finally { f.close() }
})

it('refuses further reservations at a fixed bound and releases them without a waiting queue', async () => {
  const f = setup()
  try {
    await f.connect()
    const held = []
    for (let count = 0; count < 10; count++) { const reservation = f.publication.reserve(); expect(reservation).not.toBeNull(); held.push(reservation!) }
    expect(f.publication.reserve()).toBeNull()
    for (const reservation of held) { f.publication.release(reservation); f.publication.release(reservation) }
    expect(f.publication.reserve()).not.toBeNull()
  } finally { f.close() }
})

it('fences a late acknowledgement after a newer physical connection recovers', async () => {
  const f = setup()
  try {
    await f.connect()
    let release!: () => void
    const held = new Promise<{ ok: true }>(resolve => { release = () => resolve({ ok: true }) })
    const send = f.doors.publish
    f.doors.publish = (rows, cards) => { send(rows, cards); return held }
    f.rows([row()]); f.publication.disconnect(); f.rows([done()])
    f.doors.publish = send; await f.connect()
    release(); await Promise.resolve()
    expect(f.publication.state().accepted.fingerprint).toBe(await f.core.doors.checkpoint())
    expect(f.events.filter(event => event === 'summary:cloud_a')).toHaveLength(1)
  } finally { f.close() }
})

it('fences a late recovery read after a newer connection has already recovered', async () => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    const checkpoint = f.doors.checkpoint
    const oldImage = await checkpoint()
    let release!: () => void
    f.doors.checkpoint = () => new Promise(resolve => { release = () => resolve(oldImage) })
    const old = f.publication.connect()
    f.rows([done()]); f.doors.checkpoint = checkpoint; await f.connect()
    release(); await old
    expect(f.publication.state().accepted.fingerprint).toBe(await checkpoint())
    expect(f.events.filter(event => event === 'summary:cloud_a')).toHaveLength(1)
  } finally { f.close() }
})

it('holds an unanswered publication after its deadline instead of adding retries to the connection', async () => {
  const f = setup()
  try {
    await f.connect()
    vi.useFakeTimers()
    const send = vi.fn(() => new Promise<{ ok: true }>(() => {}))
    f.doors.publish = send; f.rows([row()])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.publication.status()).toBe('CLOUD_PUBLICATION_UNAVAILABLE')
    f.rows([done()])
    await vi.advanceTimersByTimeAsync(100_000)
    expect(send).toHaveBeenCalledOnce()
    expect(f.publication.state().accepted.owners).toEqual([])
  } finally { f.close(); vi.useRealTimers() }
})

it('does not advance its checkpoint when core refuses a prepared publication', async () => {
  const f = setup()
  try {
    await f.connect()
    f.doors.publish = () => ({ ok: false, error: 'CLOUD_PUBLICATION_INVALID' })
    f.rows([row()])
    await vi.waitFor(() => expect(f.publication.status()).toBe('CLOUD_PUBLICATION_INVALID'))
    expect(f.publication.state().accepted.owners).toEqual([])
    expect(f.publication.reserve()).toBeNull()
    expect(f.core.frames()).toEqual([])
  } finally { f.close() }
})


it.each(['malformed', 'duplicate', 'non-list'] as const)('refuses an invalid %s component snapshot without withdrawing accepted owners', async bad => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    f.events.length = 0
    const rows = bad === 'non-list' ? 'invalid' as never : bad === 'duplicate' ? [row(), row()] : [row(), { ...row('cloud_bad'), state: 'unknown' } as never]
    expect(() => f.rows(rows)).toThrow('CLOUD_PUBLICATION_INVALID')
    expect(f.publication.status()).toBe('CLOUD_PUBLICATION_INVALID')
    expect(f.core.frames().map(frame => frame.id)).toEqual(['cloud_a'])
    expect(f.events).toEqual([])
  } finally { f.close() }
})


it.each([null, { fingerprint: 'bad', owners: [] }, { fingerprint: 'a'.repeat(64), owners: [{ agentId: 'wrong' }] }])(
  'holds a malformed saved presentation without changing accepted owners', async accepted => {
    const f = setup()
    let publication: ReturnType<typeof createCloudPublication> | undefined
    try {
      await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
      publication = createCloudPublication({ core: f.doors, saved: { version: 1, accepted, pending: null },
        persist: () => { throw new Error('must not write') }, snapshot: () => [], questions: () => [], log: f.log })
      await publication.connect()
      expect(publication.status()).toBe('CLOUD_PUBLICATION_RECOVERY_REQUIRED')
      expect(f.core.frames().map(frame => frame.id)).toEqual(['cloud_a'])
      publication.ask({ agentId: 'cloud_a', requestId: 'cloud_q_held', question: { text: 'Held', choices: [] } })
      publication.unask('cloud_a', 'cloud_q_held')
    } finally { publication?.stop(); f.close() }
  })

it('reports a sustained connection failure once and sends nothing after stopping', async () => {
  const f = setup()
  try {
    f.doors.checkpoint = () => Promise.reject(new Error('fixture disconnected'))
    await f.publication.connect(); await f.publication.connect()
    expect(f.log).toHaveBeenCalledTimes(1)
    expect(f.log).toHaveBeenCalledWith('[cloud] CLOUD_PUBLICATION_UNAVAILABLE')
    f.close()
    await f.publication.connect()
    f.publication.ask({ agentId: 'cloud_a', requestId: 'cloud_q_stopped', question: { text: 'Stopped', choices: [] } })
    f.publication.unask('cloud_a', 'cloud_q_stopped')
    expect(f.events).toEqual([])
  } finally { f.close() }
})

it('refuses a spent reservation before sending output', async () => {
  const f = setup()
  try {
    await f.connect()
    const reservation = f.publication.reserve()!
    f.publication.release(reservation)
    expect(() => f.publication.publish([row()], reservation)).toThrow('CLOUD_PUBLICATION_LIMIT')
    expect(f.events).toEqual([])
  } finally { f.close() }
})

it('bounds queued output count while the first publication is unanswered', async () => {
  const f = setup()
  try {
    await f.connect()
    f.doors.publish = () => new Promise(() => {})
    f.rows([row()])
    for (let index = 0; index < 63; index++) f.publication.unask('cloud_a', `cloud_q_${index}`)
    expect(() => f.publication.unask('cloud_a', 'cloud_q_overflow')).toThrow('CLOUD_PUBLICATION_LIMIT')
    expect(f.publication.status()).toBe('CLOUD_PUBLICATION_LIMIT')
  } finally { f.close() }
})

const heavy = (id: string): CloudHarness => row(id, { said: '\0'.repeat(4000),
  card: { recap: '\0'.repeat(2000), text: '\0'.repeat(2000) },
  links: Array.from({ length: 8 }, () => ({ label: 'Link', url: `https://example.test/${'\0'.repeat(2000)}` })),
})

it('bounds queued bytes even when the action count fits', async () => {
  const f = setup()
  try {
    await f.connect(); f.doors.publish = () => new Promise(() => {})
    let refused = false
    for (let index = 0; index < 63; index++) {
      try { f.rows([{ ...heavy('cloud_a'), name: `Name ${index}` }]) } catch { refused = true; break }
    }
    expect(refused).toBe(true)
    expect(f.publication.status()).toBe('CLOUD_PUBLICATION_LIMIT')
  } finally { f.close() }
})

it('bounds the complete prepared wire image before the core can accept any rows', async () => {
  const f = setup()
  try {
    await f.connect()
    const size = Buffer.byteLength(JSON.stringify(cloudHarnessIn(heavy('cloud_fixture'))))
    const count = Math.floor((CLOUD_OUTPUT_BYTES - 65_536) / size)
    const working = Array.from({ length: count }, (_, index) => heavy(`cloud_${index}`))
    f.rows(working); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    expect(f.core.frames()).toHaveLength(count)
    f.events.length = 0
    f.rows(working.map(value => ({ ...value, state: 'idle', said: '\u0001'.repeat(4000) })))
    await vi.waitFor(() => expect(f.publication.status()).toBe('CLOUD_PUBLICATION_LIMIT'))
    expect(f.events).toEqual([])
    expect(f.core.frames().every(frame => frame.cloud.state === 'working')).toBe(true)
  } finally { f.close() }
})

it('refuses oversized catalogues and oversized legacy timestamps without sending them', async () => {
  const f = setup(), large = setup()
  try {
    await f.connect(); await large.connect()
    expect(() => f.rows(Array.from({ length: 60 }, (_, index) => heavy(`cloud_${index}`)))).toThrow('CLOUD_PUBLICATION_LIMIT')
    const createdAt = `Wed Nov 18 2026 00:00:00 GMT+0000${' '.repeat(200_000)}`
    expect(cloudHarnessIn(row('cloud_a', { createdAt }))).not.toBeNull()
    expect(() => large.rows([row('cloud_a', { createdAt })])).toThrow('CLOUD_PUBLICATION_LIMIT')
    expect(f.events).toEqual([]); expect(large.events).toEqual([])
  } finally { f.close(); large.close() }
})

it('revokes a recovery read that resolved just before its async continuation', async () => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    const older = f.publication.connect()
    await Promise.resolve()
    f.rows([done()])
    const newer = f.publication.connect()
    await Promise.all([older, newer])
    await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    expect(f.events.filter(event => event === 'summary:cloud_a')).toHaveLength(1)
  } finally { f.close() }
})

it('revokes a question acknowledgement that resolved just before its async continuation', async () => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    f.publication.ask({ agentId: 'cloud_a', requestId: 'cloud_q_race', question: { text: 'Choice', choices: ['Yes'] } })
    await Promise.resolve()
    await f.connect()
    f.rows([done()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    expect(f.events.filter(event => event === 'summary:cloud_a')).toHaveLength(1)
  } finally { f.close() }
})

it.each(['ask', 'unask'] as const)('holds a refused %s with a named visible failure instead of acknowledging it', async kind => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    f.doors[kind] = () => ({ ok: false, error: 'CLOUD_QUESTION_INVALID' })
    if (kind === 'ask') f.publication.ask({ agentId: 'cloud_a', requestId: 'cloud_q_refused', question: { text: 'Choice', choices: ['Yes'] } })
    else f.publication.unask('cloud_a', 'cloud_q_refused')
    await vi.waitFor(() => expect(f.publication.status()).toBe('CLOUD_QUESTION_INVALID'))
    expect(f.publication.reserve()).toBeNull()
    expect(f.log).toHaveBeenCalledWith('[cloud] CLOUD_QUESTION_INVALID')
  } finally { f.close() }
})
it('revokes a close acknowledgement that resolved just before its async continuation', async () => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    f.publication.unask('cloud_a', 'cloud_q_race')
    await Promise.resolve()
    await f.connect()
    f.rows([done()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    expect(f.events.filter(event => event === 'summary:cloud_a')).toHaveLength(1)
  } finally { f.close() }
})

it('does not hold valid output when an owner withdrawal is followed by its already-retired close', async () => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    f.publication.ask({ agentId: 'cloud_a', requestId: 'cloud_q_removed', question: { text: 'Choose', choices: ['Yes'] } })
    await vi.waitFor(() => expect(f.events.at(-1)).toBe('commander_question'))
    let observed!: (value: unknown) => void
    const closed = new Promise(resolve => { observed = resolve }), unask = f.doors.unask
    f.doors.unask = (...args) => { const result = unask(...args); observed(result); return result }
    f.rows([])
    f.publication.unask('cloud_a', 'cloud_q_removed')
    f.rows([row('cloud_b')])
    expect(await closed).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.core.owns('cloud_b')).toBe(true))
    expect(f.publication.status()).toBeNull()
    expect(f.events.filter(event => event === 'commander_question_close')).toHaveLength(1)
  } finally { f.close() }
})

it.each(['malformed', 'duplicate', 'non-list', 'row bytes', 'catalogue bytes'] as const)(
  'validates %s snapshots before skipping a proven retained publication', async bad => {
    const f = setup()
    try {
      await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
      const before = structuredClone(f.saved)
      const rows = bad === 'non-list' ? 'invalid' as never : bad === 'duplicate' ? [row(), row()]
        : bad === 'malformed' ? [row(), { ...row('cloud_bad'), state: 'unknown' } as never]
          : bad === 'row bytes' ? [row('cloud_a', { createdAt: `Wed Nov 18 2026 00:00:00 GMT+0000${' '.repeat(200_000)}` })]
            : Array.from({ length: 60 }, (_, index) => heavy(`cloud_${index}`))
      f.snapshot(rows); f.events.length = 0
      await f.publication.connect()
      expect(f.publication.status()).toBe(bad.endsWith('bytes') ? 'CLOUD_PUBLICATION_LIMIT' : 'CLOUD_PUBLICATION_INVALID')
      expect(f.core.frames().map(frame => frame.id)).toEqual(['cloud_a'])
      expect(f.events).toEqual([])
      expect(f.saved).toEqual(before)
    } finally { f.close() }
  })

it('retains full-image reservation accounting after skipping an unchanged catalogue', async () => {
  const f = setup()
  try {
    await f.connect()
    const size = Buffer.byteLength(JSON.stringify(cloudHarnessIn(heavy('cloud_fixture'))))
    const count = Math.floor((CLOUD_OUTPUT_BYTES - 4096) / size) - 1
    f.rows(Array.from({ length: count }, (_, index) => heavy(`cloud_${index}`)))
    await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    expect(f.core.frames()).toHaveLength(count)
    expect(f.publication.reserve()).toBeNull()
    const saved = structuredClone(f.saved)
    f.restart(); f.events.length = 0; await f.connect()
    expect(f.saved).toEqual(saved)
    expect(f.events).toEqual([])
    expect(f.publication.reserve()).toBeNull()
  } finally { f.close() }
})

it('revokes a publication acknowledgement that resolved just before its async continuation', async () => {
  const f = setup()
  try {
    await f.connect()
    f.rows([row()])
    await Promise.resolve()
    f.publication.disconnect()
    await f.connect()
    expect(f.publication.state().accepted.fingerprint).toBe(await f.core.doors.checkpoint())
    f.rows([done()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    expect(f.events.filter(event => event === 'summary:cloud_a')).toHaveLength(1)
    expect(f.publication.status()).toBeNull()
  } finally { f.close() }
})

it('omits redundant sync for hidden card changes and completes with the latest component card', async () => {
  const f = setup()
  try {
    await f.connect()
    const owner = row('cloud_hidden', { state: 'idle', said: null })
    f.rows([owner]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    const visible = () => ({ frames: f.core.frames(), recent: f.core.recent(owner.agentId), said: f.core.said(owner.agentId),
      activity: f.core.activity(owner.agentId), cards: f.core.liveCards(), rows: f.core.dialRows() })
    const before = structuredClone(visible())
    const latest = { recap: 'Latest recap', text: 'Latest detail' }
    f.events.length = 0
    for (const card of [null, { recap: 'Earlier recap', text: 'Earlier detail' }, latest]) {
      f.rows([{ ...owner, card }]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
      expect(visible()).toEqual(before)
      expect(f.events.filter(event => !event.startsWith('row:'))).toEqual([])
    }
    const hiddenEvents = [...f.events]
    f.events.length = 0
    f.rows([{ ...owner, said: 'The completed answer.', card: latest }])
    await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    expect(f.core.recent(owner.agentId)).toEqual([{ kind: 'summary', ...latest, fullText: 'The completed answer.' }])
    expect(f.events).toEqual(['row:cloud_hidden', 'summary:cloud_hidden'])
    // Deliberate migration change: a raw-only card update no longer syncs an identical complete public view.
    // The current implementation fails here; all latest-card and no-false-completion assertions run first.
    expect(hiddenEvents).toEqual([])
  } finally { f.close() }
})
