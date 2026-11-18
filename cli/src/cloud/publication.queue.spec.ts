import { expect, it, vi } from 'vitest'
import type { CloudCore } from '../core/api.js'
import { createCloudAgents } from '../core/agents/cloud.js'
import type { CloudHarness } from '../lib/cloudAgents.js'
import { createCloudPublication, type CloudJournal } from './publication.js'

const row = (id = 'cloud_a', over: Partial<CloudHarness> = {}): CloudHarness => ({ agentId: id, agent: 'fo', name: id,
  state: 'working', activity: null, repository: null, branch: null, links: [], messages: 1,
  createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', ...over })
const done = (id = 'cloud_a', answer = 'First'): CloudHarness => row(id, { state: 'idle', said: answer, card: { recap: answer, text: answer } })
function setup() {
  const events: string[] = []
  const core = createCloudAgents({ port: () => null, openQuestions: new Map(), log: () => {}, clients: {
    send: () => {}, sendLocal: () => {}, sendCommander: frame => events.push(frame.type === 'agent_synced'
      ? `row:${(frame.payload.agent as { id: string }).id}` : frame.type === 'commander_event'
        ? `${frame.payload.kind}:${frame.agentId}` : frame.type === 'agent_deleted' ? `delete:${frame.payload.agentId}` : frame.type),
  } })
  let snapshot: CloudHarness[] = [], saved: CloudJournal | undefined
  const doors: CloudCore = { ...core.doors }
  const make = () => createCloudPublication({ core: doors, saved, persist: journal => { saved = structuredClone(journal) },
    snapshot: () => snapshot, questions: () => [], log: () => {} })
  let publication = make()
  return { core, doors, events, get publication() { return publication }, get saved() { return saved },
    rows(rows: CloudHarness[]) { snapshot = rows; publication.publish(rows) },
    async connect() { await publication.connect(); await vi.waitFor(() => expect(publication.state().pending).toBeNull()) },
    restart() { publication.stop(); publication = make() },
    close() { publication.stop() },
  }
}

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

it('proves same-image recovery has identical transition state, then preserves a later rename', async () => {
  const f = setup()
  try {
    await f.connect(); f.rows([row()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    f.rows([done()]); await vi.waitFor(() => expect(f.publication.state().pending).toBeNull())
    f.events.length = 0
    const send = f.doors.publish
    f.doors.publish = (rows, cards) => { send(rows, cards); return new Promise(() => {}) }
    await f.publication.connect()
    expect(f.saved!.pending!.fingerprint).toBe(f.saved!.accepted.fingerprint)
    expect(f.saved!.pending).toEqual(f.saved!.accepted)
    f.restart(); f.doors.publish = send; await f.connect()
    f.rows([done('cloud_a', 'First'), row('cloud_b')])
    await vi.waitFor(() => expect(f.events).toContain('processing:cloud_b'))
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
