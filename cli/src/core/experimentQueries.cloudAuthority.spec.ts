import { emptyOwnerCore } from '../testing/cloudOwners.js'
import { expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { answerExperimentQuery } from './experimentQueries.js'
import { createServiceLinks, type ServiceFrame } from './serviceLinks.js'
import { createSessionOwners } from './agents/sessionOwners.js'
import { createQuestionPresentations } from './questions.js'
import { processCoreApi } from '../services/processCoreApi.js'
import { SESSION_FACTS_FORMAT, encodeSessionFacts, type SessionFacts } from '../lib/sessionPresentation.js'
import { emptySessionFingerprint, sessionImageHash, SESSION_OWNER_LIMITS } from '../lib/sessionOwnerWire.js'

const token = 'c'.repeat(48)
const queries = ['session_owner_checkpoint', 'session_owner_begin', 'session_owner_append', 'session_owner_end', 'session_owner_cancel', 'session_owner_ask', 'session_owner_unask'] as const
const payload = { harnesses: [], agentId: 'cloud_fixture', questionId: 'cloud_q_fixture',
  question: { text: 'Fixture question', choices: [] } }

it.each([0, 1])('publishes %i session rows through the authenticated service query envelope', async count => {
  const core = fakeCore(), sent = vi.fn()
  const owners = createSessionOwners({ factoryOwner: factory => factory === 'fixture' ? { kind: 'service', service: 'cloud' } : undefined,
    native: () => false, port: () => null, whenStarting: () => null, questions: createQuestionPresentations(),
    limits: SESSION_OWNER_LIMITS, clients: { send: sent, sendCommander: vi.fn(), sendLocal: vi.fn() }, log: () => {} })
  const links = createServiceLinks({ token, owned: { cloud: [] }, log: () => {},
    answer: async (service, query, data, authority) => await answerExperimentQuery(core, new Set(), service, query, data,
      undefined, authority, owners.bound({ service, identity: authority, current: () => authority.current!() })) ?? {} })
  let reply!: (value: Record<string, unknown>) => void, ordinal = 0
  const link = links.accept('cloud', token, { sendFrame: frame => {
    expect(frame.type).toBe('service_query_result')
    const { requestId, ...result } = frame.payload!
    expect(requestId).toBe(`query-${ordinal}`)
    reply(result)
    return true
  } }, () => {})!
  // The process transport adds these two routing fields after the component constructs its payload.
  const ask = (query: string, data: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => {
    reply = resolve
    link.receive(JSON.parse(JSON.stringify({ type: 'service_query', payload: { ...data, query, requestId: `query-${++ordinal}` } })))
  })
  const door = processCoreApi('/fixture', 'cloud', { ask }).owners!
  const facts: SessionFacts = { id: 'owned', engine: 'fixture', name: 'Fixture', createdAt: '0', updatedAt: '0' }
  const after = count ? sessionImageHash().update(encodeSessionFacts(facts)).update(']').digest('hex') : emptySessionFingerprint()
  const begin = { format: SESSION_FACTS_FORMAT, transfer: 'transfer', factory: 'fixture', before: emptySessionFingerprint(), after, count }
  try {
    expect(await door.checkpoint('fixture')).toEqual({ fingerprint: emptySessionFingerprint() })
    expect(await door.begin(begin)).toEqual({ ok: true })
    if (count) {
      expect(await ask('session_owner_append', { transfer: 'transfer', index: 0, rows: [{ facts }], unexpected: true }))
        .toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
      expect(await door.append({ transfer: 'transfer', index: 0, rows: [{ facts }] })).toEqual({ ok: true })
    }
    expect(await door.end('transfer')).toEqual({ ok: true })
    expect(await door.checkpoint('fixture')).toEqual({ fingerprint: after })
    expect(owners.frames()).toMatchObject(count ? [{ id: 'owned', name: 'Fixture' }] : [])
    expect(sent).toHaveBeenCalledTimes(count)
    expect(await ask('session_owner_begin', { ...begin, before: after, unexpected: true }))
      .toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
  } finally { link.closed(); owners.stop() }
})

it.each(queries)('%s cannot act after its connection is replaced during asynchronous dispatch', async query => {
  const owners = { begin: vi.fn(() => ({ ok: true as const })), append: vi.fn(() => ({ ok: true as const })), end: vi.fn(() => ({ ok: true as const })), cancel: vi.fn(() => ({ ok: true as const })), checkpoint: vi.fn(() => ({ fingerprint: 'a'.repeat(64) })), ask: vi.fn(() => ({ ok: true as const })), unask: vi.fn(() => ({ ok: true as const })) }, core = fakeCore()
  let entered!: () => void, release!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const links = createServiceLinks({ token, owned: { cloud: [] }, log: () => {},
    answer: async (service, name, data, authority) => {
      entered()
      await held
      return await answerExperimentQuery(core, new Set(['cloud']), service, name, data, undefined, authority, owners) ?? {}
    },
  })
  const oldFrames: ServiceFrame[] = [], newFrames: ServiceFrame[] = []
  const first = links.accept('cloud', token, { sendFrame: frame => { oldFrames.push(frame); return true } }, () => {})!
  first.receive({ type: 'service_query', payload: { ...payload, query, requestId: 'before' } })
  await entering
  const second = links.accept('cloud', token, { sendFrame: frame => { newFrames.push(frame); return true } }, () => {})!
  release()
  await vi.waitFor(() => expect(oldFrames).toContainEqual({ type: 'service_query_result',
    payload: { requestId: 'before', error: 'SERVICE_UNAVAILABLE' } }))
  for (const effect of Object.values(owners)) expect(effect).not.toHaveBeenCalled()

  second.receive({ type: 'service_query', payload: { ...payload, query, requestId: 'after' } })
  await vi.waitFor(() => expect(newFrames).toContainEqual({ type: 'service_query_result', payload: { requestId: 'after', ...(query === 'session_owner_checkpoint' ? { fingerprint: 'a'.repeat(64) } : { ok: true }) } }))
  expect(Object.values(owners).reduce((count, effect) => count + effect.mock.calls.length, 0)).toBe(1)
  second.closed()
})

it.each(queries)('%s refuses an authority that cannot prove its current connection', async query => {
  const owners = { begin: vi.fn(() => ({ ok: true as const })), append: vi.fn(() => ({ ok: true as const })), end: vi.fn(() => ({ ok: true as const })), cancel: vi.fn(() => ({ ok: true as const })), checkpoint: vi.fn(() => ({ fingerprint: 'a'.repeat(64) })), ask: vi.fn(() => ({ ok: true as const })), unask: vi.fn(() => ({ ok: true as const })) }, core = fakeCore()
  expect(await answerExperimentQuery(core, new Set(['cloud']), 'cloud', query, payload, undefined,
    { ownsRequest: () => false }, owners)).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  for (const effect of Object.values(owners)) expect(effect).not.toHaveBeenCalled()
})

it.each(queries)('%s refuses a process query without connection authority', async query => {
  const owners = { begin: vi.fn(() => ({ ok: true as const })), append: vi.fn(() => ({ ok: true as const })), end: vi.fn(() => ({ ok: true as const })), cancel: vi.fn(() => ({ ok: true as const })), checkpoint: vi.fn(() => ({ fingerprint: 'a'.repeat(64) })), ask: vi.fn(() => ({ ok: true as const })), unask: vi.fn(() => ({ ok: true as const })) }, core = fakeCore()
  expect(await answerExperimentQuery(core, new Set(['cloud']), 'cloud', query, payload, undefined, undefined, owners))
    .toEqual({ error: 'SERVICE_UNAVAILABLE' })
  for (const effect of Object.values(owners)) expect(effect).not.toHaveBeenCalled()
})
