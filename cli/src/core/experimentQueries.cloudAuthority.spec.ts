import { expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { answerExperimentQuery } from './experimentQueries.js'
import { createServiceLinks, type ServiceFrame } from './serviceLinks.js'

const token = 'c'.repeat(48)
const queries = ['cloud_checkpoint', 'cloud_publish', 'cloud_ask', 'cloud_unask'] as const
const payload = { harnesses: [], agentId: 'cloud_fixture', questionId: 'cloud_q_fixture',
  question: { text: 'Fixture question', choices: [] } }

it.each(queries)('%s cannot act after its connection is replaced during asynchronous dispatch', async query => {
  const cloud = { checkpoint: vi.fn(() => 'a'.repeat(64)), publish: vi.fn(() => ({ ok: true })), ask: vi.fn(), unask: vi.fn() }, core = fakeCore({ cloud })
  let entered!: () => void, release!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const links = createServiceLinks({ token, owned: { cloud: [] }, log: () => {},
    answer: async (service, name, data, authority) => {
      entered()
      await held
      return await answerExperimentQuery(core, new Set(['cloud']), service, name, data, undefined, authority) ?? {}
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
  for (const effect of Object.values(cloud)) expect(effect).not.toHaveBeenCalled()

  second.receive({ type: 'service_query', payload: { ...payload, query, requestId: 'after' } })
  await vi.waitFor(() => expect(newFrames).toContainEqual({ type: 'service_query_result', payload: { requestId: 'after', ...(query === 'cloud_checkpoint' ? { fingerprint: 'a'.repeat(64) } : query === 'cloud_publish' ? { ok: true } : {}) } }))
  expect(Object.values(cloud).reduce((count, effect) => count + effect.mock.calls.length, 0)).toBe(1)
  second.closed()
})

it.each(queries)('%s refuses an authority that cannot prove its current connection', async query => {
  const cloud = { checkpoint: vi.fn(() => 'a'.repeat(64)), publish: vi.fn(() => ({ ok: true })), ask: vi.fn(), unask: vi.fn() }, core = fakeCore({ cloud })
  expect(await answerExperimentQuery(core, new Set(['cloud']), 'cloud', query, payload, undefined,
    { ownsRequest: () => false })).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  for (const effect of Object.values(cloud)) expect(effect).not.toHaveBeenCalled()
})

it.each(queries)('%s refuses a process query without connection authority', async query => {
  const cloud = { checkpoint: vi.fn(() => 'a'.repeat(64)), publish: vi.fn(() => ({ ok: true })), ask: vi.fn(), unask: vi.fn() }, core = fakeCore({ cloud })
  expect(await answerExperimentQuery(core, new Set(['cloud']), 'cloud', query, payload))
    .toEqual({ error: 'SERVICE_UNAVAILABLE' })
  for (const effect of Object.values(cloud)) expect(effect).not.toHaveBeenCalled()
})
