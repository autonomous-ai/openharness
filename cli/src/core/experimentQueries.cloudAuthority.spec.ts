import { emptyOwnerCore } from '../testing/cloudOwners.js'
import { expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { answerExperimentQuery } from './experimentQueries.js'
import { createServiceLinks, type ServiceFrame } from './serviceLinks.js'

const token = 'c'.repeat(48)
const queries = ['session_owner_checkpoint', 'session_owner_begin', 'session_owner_append', 'session_owner_end', 'session_owner_cancel', 'session_owner_ask', 'session_owner_unask'] as const
const payload = { harnesses: [], agentId: 'cloud_fixture', questionId: 'cloud_q_fixture',
  question: { text: 'Fixture question', choices: [] } }

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
