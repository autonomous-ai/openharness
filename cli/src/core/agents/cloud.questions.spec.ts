import { OWNER_ANSWER_DOWN as CLOUD_ANSWER_DOWN } from '../../lib/sessionOwnerWire.js'
import { createQuestionPresentations } from '../questions.js'
import { cloudFactory } from '../../testing/sessionFactories.js'
import { answerExperimentQuery } from '../experimentQueries.js'
import { fakeCore } from '../../testing/fakeCore.js'
import { cloudQuestionClose, prepareCloudQuestion } from '../../cloud/questions.js'
import { expect, it, vi } from 'vitest'
import { createCloudOwners } from '../../testing/cloudOwners.js'

import type { CloudHarness } from '../../lib/cloudAgents.js'

const owner: CloudHarness = { agentId: 'cloud_1', agent: 'devin-cloud', name: 'Fixture', state: 'needs_input', activity: null,
  repository: null, branch: null, links: [], messages: 1, createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z' }
function fixture(whenStarting?: () => Promise<boolean> | null) {
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }, questions = createQuestionPresentations(), openQuestions = questions.openQuestions
  const answer = vi.fn(async () => ({ ok: true as const }))
  const port = { answer }
  const cloud = createCloudOwners({ ownsFactory: cloudFactory, native: () => false, clients, questions, whenStarting, port: () => port as never, log: () => {} })
  cloud.doors.publish([owner])
  return { cloud, clients, openQuestions, questions, answer }
}
it('an old close cannot erase the replacement question for the same owner', () => {
  const { cloud, openQuestions } = fixture()
  cloud.doors.ask('cloud_1', 'cloud_q_old', prepareCloudQuestion('cloud_1', 'cloud_q_old', { text: 'Old?', choices: ['Yes'] }))
  cloud.doors.ask('cloud_1', 'cloud_q_new', prepareCloudQuestion('cloud_1', 'cloud_q_new', { text: 'New?', choices: ['No'] }))
  const replacement = openQuestions.get('cloud_1')
  cloud.doors.unask('cloud_1', 'cloud_q_old', cloudQuestionClose('cloud_1', 'cloud_q_old'))
  expect(openQuestions.get('cloud_1')).toEqual(replacement)
})
it('a replaced request no longer routes an answer to the provider', () => {
  const { cloud, answer } = fixture()
  cloud.doors.ask('cloud_1', 'cloud_q_old', prepareCloudQuestion('cloud_1', 'cloud_q_old', { text: 'Old?', choices: ['Yes'] }))
  cloud.doors.ask('cloud_1', 'cloud_q_new', prepareCloudQuestion('cloud_1', 'cloud_q_new', { text: 'New?', choices: ['No'] }))
  expect(cloud.answer({ requestId: 'cloud_q_old', answers: { answer: 'Yes' } })).toBeNull()
  expect(answer).not.toHaveBeenCalled()
})

const question = (id = 'cloud_q_one', agentId = 'cloud_1') => prepareCloudQuestion(agentId, id, { text: 'Choose', choices: ['Yes'] })
const invalid = { ok: false, error: 'SESSION_OWNER_INVALID' }
it('admits a common request id without feature prefixes and preserves its exact answer route', async () => {
  const { cloud, answer } = fixture()
  const prepared = prepareCloudQuestion('cloud_1', 'request_1', { text: 'Which?', choices: ['Yes'] })
  expect(cloud.doors.ask('cloud_1', 'request_1', prepared)).toEqual({ ok: true })
  expect(await cloud.answer({ requestId: 'request_1', answers: { answer: 'Yes' } })).toEqual({ ok: true })
  expect(answer).toHaveBeenCalledWith('cloud_1', 'request_1', { answer: 'Yes' })
})
it('admits only bounded exact question fields for the accepted owner, atomically', () => {
  const { cloud, clients, openQuestions } = fixture()
  const good = question()
  const bad: unknown[] = [null, [], {}, { ...good, extra: true }, { ...good, dial: 'yes' },
    { ...good, close: null }, { ...good, close: { ...good.close, type: 'agent_deleted' } },
    { ...good, close: { ...good.close, agentId: 'other' } }, { ...good, close: { ...good.close, dbSessionId: 'other' } },
    { ...good, close: { ...good.close, payload: {} } }, { ...good, close: { ...good.close, payload: { requestId: 'cloud_q_wrong' } } },
    { ...good, frame: null }, { ...good, frame: { ...good.frame, type: 'agent_create' } },
    { ...good, frame: { ...good.frame, agentId: 'other' } }, { ...good, frame: { ...good.frame, dbSessionId: 'other' } }]
  for (const payload of [{}, { ...good.frame.payload, requestId: 'cloud_q_other' },
    { ...good.frame.payload, notification: null }, { ...good.frame.payload, notification: { id: 'other', kind: 'needsYou' } },
    { ...good.frame.payload, notification: { id: 'cloud_q_one', kind: 'done' } },
    { ...good.frame.payload, questions: null }, { ...good.frame.payload, questions: [] }]) bad.push({ ...good, frame: { ...good.frame, payload } })
  for (const value of [null, { ...good.frame.payload.questions[0], key: '' }, { ...good.frame.payload.questions[0], q: 1 },
    { ...good.frame.payload.questions[0], q: 'x'.repeat(22 * 1024) }, { ...good.frame.payload.questions[0], multi: 'true' },
    { ...good.frame.payload.questions[0], canText: 0 }, { ...good.frame.payload.questions[0], options: null },
    { ...good.frame.payload.questions[0], options: Array(30).fill('x'.repeat(1000)) }, { ...good.frame.payload.questions[0], options: [1] },
    { ...good.frame.payload.questions[0], options: [''] }, { ...good.frame.payload.questions[0], options: new Array(1) }, { ...good.frame.payload.questions[0], options: ['x'.repeat(22 * 1024)] },
    { ...good.frame.payload.questions[0], options: [] }]) bad.push({ ...good, frame: { ...good.frame, payload: { ...good.frame.payload, questions: [value] } } })
  clients.sendCommander.mockClear()
  for (const value of bad) expect(cloud.doors.ask('cloud_1', 'cloud_q_one', value as never)).toEqual(invalid)
  expect(cloud.doors.ask('cloud_missing', 'cloud_q_one', good)).toEqual(invalid)
  expect(cloud.doors.ask('cloud_1', 9 as never, good)).toEqual(invalid)
  expect(cloud.doors.ask('cloud_1', 'cloud_q_' + 'x'.repeat(80), good)).toEqual(invalid)
  expect(openQuestions.size).toBe(0)
  expect(clients.sendLocal).not.toHaveBeenCalled()
  expect(clients.sendCommander).not.toHaveBeenCalled()
})
it('preserves the accepted dial destination when reconnect narrows it, with immutable admitted bytes', () => {
  const { cloud, clients } = fixture(), value = question()
  expect(cloud.doors.ask('cloud_1', 'cloud_q_one', value)).toEqual({ ok: true })
  value.close.payload.requestId = 'mutated'
  value.frame.payload.questions[0].q = 'mutated'
  expect(cloud.doors.ask('cloud_1', 'cloud_q_one', { ...question(), dial: false })).toEqual({ ok: true })
  expect(cloud.doors.ask('cloud_1', 'cloud_q_one', value)).toEqual(invalid)
  clients.sendCommander.mockClear()
  expect(cloud.doors.unask('cloud_1', 'cloud_q_one', cloudQuestionClose('cloud_1', 'cloud_q_one'))).toEqual({ ok: true })
  expect(clients.sendCommander).toHaveBeenCalledExactlyOnceWith(cloudQuestionClose('cloud_1', 'cloud_q_one'))
  clients.sendLocal.mockClear()
  expect(cloud.doors.unask('cloud_1', 'cloud_q_one', cloudQuestionClose('cloud_1', 'cloud_q_one'))).toEqual({ ok: true })
  expect(clients.sendLocal).not.toHaveBeenCalled()
})
it('refuses destination broadening, request collisions and forged closes without losing the current question', () => {
  const { cloud, openQuestions } = fixture()
  cloud.doors.publish([owner, { ...owner, agentId: 'cloud_2' }])
  const local = { ...question(), dial: false }
  cloud.doors.ask('cloud_1', 'cloud_q_one', local)
  expect(cloud.doors.ask('cloud_1', 'cloud_q_one', question())).toEqual(invalid)
  expect(cloud.doors.ask('cloud_2', 'cloud_q_one', question('cloud_q_one', 'cloud_2'))).toEqual(invalid)
  for (const [agentId, requestId, close] of [['cloud_missing', 'cloud_q_one', cloudQuestionClose('cloud_missing', 'cloud_q_one')],
    [1, 'cloud_q_one', local.close], ['invalid', 'cloud_q_one', local.close], ['cloud_' + 'x'.repeat(80), 'cloud_q_one', local.close],
    ['cloud_1', 1, local.close], ['cloud_1', 'wrong', local.close], ['cloud_1', 'cloud_q_' + 'x'.repeat(80), local.close],
    ['cloud_1', 'cloud_q_one', { ...local.close, dial: true }], ['cloud_2', 'cloud_q_one', cloudQuestionClose('cloud_2', 'cloud_q_one')]]) {
    expect(cloud.doors.unask(agentId as string, requestId as string, close as never)).toEqual(invalid)
  }
  expect(openQuestions.get('cloud_1')).toEqual(local.frame)
})
it('closes and forgets questions with their owner, and ignores a late answer for a replacement', async () => {
  const { cloud, clients, answer, openQuestions } = fixture()
  let finish!: (value: { ok: true }) => void
  answer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  cloud.doors.ask('cloud_1', 'cloud_q_one', question())
  const answering = cloud.answer({ requestId: 'cloud_q_one', answers: { answer: 'Yes' } })
  cloud.doors.ask('cloud_1', 'cloud_q_two', question('cloud_q_two'))
  finish({ ok: true })
  expect(await answering).toEqual({ ok: true })
  expect(openQuestions.get('cloud_1')).toEqual(question('cloud_q_two').frame)
  cloud.doors.publish([])
  expect(openQuestions.size).toBe(0)
  expect(clients.sendLocal).toHaveBeenLastCalledWith(cloudQuestionClose('cloud_1', 'cloud_q_two'))
  expect(cloud.answer({ requestId: 'cloud_q_two' })).toBeNull()
  clients.sendLocal.mockClear()
  expect(cloud.doors.unask('cloud_1', 'cloud_q_two', cloudQuestionClose('cloud_1', 'cloud_q_two'))).toEqual({ ok: true })
  expect(clients.sendLocal).not.toHaveBeenCalled()
  cloud.doors.publish([owner])
  expect(cloud.answer({ requestId: 'cloud_q_two' })).toBeNull()
})

it('enforces encoded byte bounds as well as character bounds', () => {
  const { cloud } = fixture()
  const requestId = 'cloud_q_' + '\0'.repeat(72)
  const value = prepareCloudQuestion('cloud_1', requestId, { text: '\0'.repeat(500), choices: Array(6).fill('\0'.repeat(500)) })
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(22 * 1024)
  expect(cloud.doors.ask('cloud_1', requestId, value)).toEqual(invalid)
  const agentId = 'cloud_' + '\0'.repeat(74)
  cloud.doors.publish([{ ...owner, agentId }])
  const close = cloudQuestionClose(agentId, requestId)
  expect(Buffer.byteLength(JSON.stringify(close))).toBeGreaterThan(1024)
  expect(cloud.doors.unask(agentId, requestId, close)).toEqual(invalid)
})
it('does not delete another question written to the shared session question slot', () => {
  const { cloud, openQuestions, questions } = fixture()
  cloud.doors.ask('cloud_1', 'cloud_q_one', question())
  cloud.doors.unask('cloud_1', 'cloud_q_one', cloudQuestionClose('cloud_1', 'cloud_q_one'))
  const newer = { type: 'commander_question', payload: { requestId: 'another_source' } }
  expect(questions.set({}, 'cloud_1', newer, { dial: false, remote: true })).toBe(true)
  expect(cloud.answer({ requestId: 'cloud_q_one' })).toBeNull()
  cloud.doors.unask('cloud_1', 'cloud_q_one', cloudQuestionClose('cloud_1', 'cloud_q_one'))
  expect(openQuestions.get('cloud_1')).toBe(newer)
})

it('returns truthful prepared-question refusal through the real dispatcher and fences a stale close', async () => {
  const { cloud, clients, openQuestions } = fixture(), core = fakeCore()
  let current = true
  const authority = { current: () => current, ownsRequest: () => false }, active = new Set(['cloud'])
  const payload = { agentId: 'cloud_1', questionId: 'cloud_q_one', question: question() }
  expect(await answerExperimentQuery(core, active, 'cloud', 'session_owner_ask', payload, undefined, authority, cloud.doors)).toEqual({ ok: true })
  expect(await answerExperimentQuery(core, active, 'cloud', 'session_owner_ask', { ...payload, question: {} }, undefined, authority, cloud.doors)).toEqual(invalid)
  clients.sendLocal.mockClear()
  current = false
  const close = { agentId: 'cloud_1', questionId: 'cloud_q_one', close: question().close }
  expect(await answerExperimentQuery(core, active, 'cloud', 'session_owner_unask', close, undefined, authority, cloud.doors)).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  expect(clients.sendLocal).not.toHaveBeenCalled()
  expect(openQuestions.get('cloud_1')).toEqual(question().frame)
  current = true
  expect(await answerExperimentQuery(core, active, 'cloud', 'session_owner_unask', close, undefined, authority, cloud.doors)).toEqual({ ok: true })
  expect(openQuestions.size).toBe(0)
})


it.each(['retired', 'replaced', 'retired and replayed', 'owner recreated'] as const)('fences an answer whose question is %s during startup', async change => {
  let ready!: (up: boolean) => void
  const starting = new Promise<boolean>(resolve => { ready = resolve })
  const f = fixture(() => starting)
  f.cloud.doors.ask(owner.agentId, 'cloud_q_one', question())
  const pending = f.cloud.answer({ requestId: 'cloud_q_one', answers: { answer: 'Yes' } })
  expect(f.answer).not.toHaveBeenCalled()
  if (change === 'owner recreated') { f.cloud.doors.publish([]); f.cloud.doors.publish([owner]) }
  else f.cloud.doors.unask(owner.agentId, 'cloud_q_one', cloudQuestionClose(owner.agentId, 'cloud_q_one'))
  if (change === 'replaced') f.cloud.doors.ask(owner.agentId, 'cloud_q_two', question('cloud_q_two'))
  if (change === 'retired and replayed' || change === 'owner recreated') f.cloud.doors.ask(owner.agentId, 'cloud_q_one', question())
  ready(true)
  expect(await pending).toEqual(CLOUD_ANSWER_DOWN)
  expect(f.answer).not.toHaveBeenCalled()
})

it('keeps the canonical question identity across an identical Cloud replay during startup', async () => {
  let ready!: (up: boolean) => void
  const starting = new Promise<boolean>(resolve => { ready = resolve })
  const f = fixture(() => starting)
  f.cloud.doors.ask(owner.agentId, 'cloud_q_one', question())
  const accepted = f.questions.request('cloud_q_one')
  const pending = f.cloud.answer({ requestId: 'cloud_q_one', answers: { answer: 'Yes' } })
  f.cloud.doors.publish([{ ...owner, messages: 2 }])
  expect(f.cloud.doors.ask(owner.agentId, 'cloud_q_one', { ...question(), dial: false })).toEqual({ ok: true })
  ready(true)
  expect(await pending).toEqual({ ok: true })
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(owner.agentId, 'cloud_q_one', { answer: 'Yes' })
  expect(f.questions.request('cloud_q_one')).toBe(accepted)
})

it.each(['removed', 'recreated with identical facts', 'replaced by a different incarnation'] as const)('fences an answer result after its owner is %s', async change => {
  const f = fixture()
  let finish!: (value: { ok: true }) => void
  f.answer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  f.cloud.doors.ask(owner.agentId, 'cloud_q_one', question())
  const pending = f.cloud.answer({ requestId: 'cloud_q_one', answers: { answer: 'Yes' } })
  // The real service closes the answered question before replying. Owner revocation still wins.
  f.cloud.doors.unask(owner.agentId, 'cloud_q_one', cloudQuestionClose(owner.agentId, 'cloud_q_one'))
  finish({ ok: true })
  if (change !== 'replaced by a different incarnation') f.cloud.doors.publish([])
  if (change !== 'removed') f.cloud.doors.publish([{ ...owner, ...(change === 'replaced by a different incarnation' ? { createdAt: '2026-11-19T00:00:00.000Z' } : {}) }])
  expect(await pending).toEqual(CLOUD_ANSWER_DOWN)
})


it('retires a question when the same id is published as a different owner incarnation', () => {
  const f = fixture()
  f.cloud.doors.ask(owner.agentId, 'cloud_q_one', question())
  f.cloud.doors.publish([{ ...owner, createdAt: '2026-11-19T00:00:00.000Z' }])
  expect(f.cloud.answer({ requestId: 'cloud_q_one', answers: { answer: 'Yes' } })).toBeNull()
  expect(f.openQuestions.size).toBe(0)
  expect(f.clients.sendLocal).toHaveBeenLastCalledWith(cloudQuestionClose(owner.agentId, 'cloud_q_one'))
})
