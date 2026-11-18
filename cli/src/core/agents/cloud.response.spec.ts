import { describe, expect, it, vi } from 'vitest'
import { CLOUD_DOWN, type CloudPort } from '../api.js'
import { cloudAgentFrame, type CloudHarness } from '../../lib/cloudAgents.js'
import { prepareCloudQuestion } from '../../cloud/questions.js'
import { createCloudAgents } from './cloud.js'

const owner: CloudHarness = { agentId: 'cloud_1', agent: 'devin-cloud', name: 'Original', state: 'working', activity: null,
  repository: null, branch: null, links: [], messages: 0, createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z' }
const prepared = () => ({ agent: cloudAgentFrame({ ...owner, name: 'Renamed' }),
  renamed: { type: 'agent_renamed', payload: { agentId: owner.agentId, name: 'Renamed', engine: owner.agent } } })

function setup() {
  let resolve!: (value: unknown) => void
  const rename = vi.fn(() => new Promise(done => { resolve = done }))
  let current = { rename } as unknown as CloudPort | null
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }
  const cloud = createCloudAgents({ port: () => current, clients, openQuestions: new Map(), log: () => {} })
  cloud.doors.publish([owner]); clients.send.mockClear(); clients.sendCommander.mockClear()
  return { cloud, clients, rename, resolve: (value: unknown) => resolve(value), replace: () => { current = { rename } as unknown as CloudPort }, disable: () => { current = null } }
}

describe('prepared Cloud operation responses', () => {
  it('forwards the prepared rename reply and event', async () => {
    const t = setup(), answer = t.cloud.update({ agentId: owner.agentId, name: 'Renamed' })
    t.resolve(prepared())
    expect(await answer).toEqual({ agent: prepared().agent })
    expect(t.clients.send).toHaveBeenCalledWith(prepared().renamed)
    expect(t.clients.sendCommander).toHaveBeenCalledWith(prepared().renamed)
    expect(t.rename).toHaveBeenCalledWith(owner.agentId, 'Renamed', expect.objectContaining(owner))
  })

  it.each(['removed', 'owner replaced', 'service replaced', 'service disabled'])('refuses a late rename after %s', async reason => {
    const t = setup(), answer = t.cloud.update({ agentId: owner.agentId, name: 'Renamed' })
    // Resolve first: revocation must still win before the caller's async continuation.
    t.resolve(prepared())
    if (reason === 'removed') t.cloud.doors.publish([])
    if (reason === 'owner replaced') t.cloud.doors.publish([{ ...owner, createdAt: '2026-10-12T10:00:00.000Z' }])
    if (reason === 'service replaced') t.replace()
    if (reason === 'service disabled') t.disable()
    t.clients.send.mockClear(); t.clients.sendCommander.mockClear()
    expect(await answer).toMatchObject({ error: 'SERVICE_UNAVAILABLE', detail: CLOUD_DOWN.detail })
    expect(t.clients.send).not.toHaveBeenCalled()
    expect(t.clients.sendCommander).not.toHaveBeenCalled()
  })
})

function immediate(value: unknown, starting?: () => Promise<boolean> | null) {
  const call = vi.fn(async () => value)
  let port = { create: call, deliver: call, answer: call, rename: call, stopHarness: call } as unknown as CloudPort
  const clients = { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }, log = vi.fn()
  const cloud = createCloudAgents({ port: () => port, whenStarting: starting, clients, openQuestions: new Map(), log })
  cloud.doors.publish([owner]); cloud.doors.ask(owner.agentId, 'cloud_q_1', prepareCloudQuestion(owner.agentId, 'cloud_q_1', { text: 'Which?', choices: [] }))
  clients.send.mockClear(); clients.sendCommander.mockClear()
  return { cloud, call, clients, log, replace: () => { port = { ...port } } }
}

it('captures the first physical port after readiness, and refuses a failed start without invoking it', async () => {
  let up!: (value: boolean) => void
  const readiness = new Promise<boolean>(resolve => { up = resolve })
  const t = immediate(prepared(), () => readiness)
  const pending = t.cloud.update({ agentId: owner.agentId, name: 'Renamed' })
  expect(t.call).not.toHaveBeenCalled()
  t.replace(); up(true)
  expect(await pending).toEqual({ agent: prepared().agent })
  expect(t.call).toHaveBeenCalledOnce()
  const failed = immediate(prepared(), () => Promise.resolve(false))
  expect(await failed.cloud.update({ agentId: owner.agentId, name: 'Renamed' })).toMatchObject({ error: 'SERVICE_UNAVAILABLE' })
  expect(failed.call).not.toHaveBeenCalled()
})

it('rechecks the owner after readiness before any provider call', async () => {
  let up!: (value: boolean) => void
  const readiness = new Promise<boolean>(resolve => { up = resolve })
  const t = immediate(prepared(), () => readiness)
  const pending = t.cloud.update({ agentId: owner.agentId, name: 'Renamed' })
  t.cloud.doors.publish([]); up(true)
  expect(await pending).toMatchObject({ error: 'SERVICE_UNAVAILABLE' })
  expect(t.call).not.toHaveBeenCalled()
})

it('keeps the three-second Stop deadline across a stalled first start and a hung component', async () => {
  vi.useFakeTimers()
  try {
    for (const blockedStart of [false, true]) {
      const t = immediate({ deleted: true }, blockedStart ? () => new Promise(() => {}) : () => null)
      if (!blockedStart) t.call.mockImplementation(() => new Promise(() => {}))
      const stopped = t.cloud.stop(owner.agentId)
      let settled = false; void stopped!.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(2999); expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await stopped).toEqual({ deleted: true, detail: 'Stopping. Its pane says when it has.' })
      expect(t.call).toHaveBeenCalledTimes(blockedStart ? 0 : 1)
    }
  } finally { vi.useRealTimers() }
})

it('preserves a captured rename projection while current mutable owner state advances', async () => {
  const t = setup(), pending = t.cloud.update({ agentId: owner.agentId, name: 'Renamed' })
  t.cloud.doors.publish([{ ...owner, state: 'idle', updatedAt: '2026-10-11T11:00:00.000Z' }])
  t.clients.send.mockClear(); t.clients.sendCommander.mockClear()
  t.resolve(prepared())
  expect(await pending).toEqual({ agent: prepared().agent })
  expect(t.clients.send).toHaveBeenCalledWith(prepared().renamed)
})

it('admits only bounded prepared rename replies for the captured owner and name', async () => {
  const good = prepared()
  const malformed: unknown[] = [null, [], {}, { ok: true }, { error: '' }, { error: 'X', detail: 3 }, { error: 'X', extra: true },
    { ...good, extra: true }, { ...good, agent: null },
    ...[{ id: 7 }, { id: 'terminal' }, { id: 'cloud_' + 'x'.repeat(80) }, { sessionId: 'cloud_other' }, { engine: 'unknown' },
      { location: 'local' }, { name: 3 }, { name: 'x'.repeat(121) }, { createdAt: 4 }, { id: 'cloud_other', sessionId: 'cloud_other' },
      { engine: 'fo' }, { createdAt: '2026-10-12T10:00:00Z' }, { name: 'Wrong' }].map(change => ({ ...good, agent: { ...good.agent, ...change } })),
    { ...good, renamed: null }, { ...good, renamed: { ...good.renamed, type: 'agent_deleted' } },
    { ...good, renamed: { ...good.renamed, payload: {} } },
    ...[{ agentId: 'cloud_other' }, { name: 'Wrong' }, { engine: 'fo' }].map(change => ({ ...good, renamed: { ...good.renamed, payload: { ...good.renamed.payload, ...change } } })),
    { ...good, agent: { ...good.agent, extra: 'x'.repeat(256 * 1024) } }]
  for (const result of malformed) {
    const t = immediate(result)
    expect(await t.cloud.update({ agentId: owner.agentId, name: 'Renamed' })).toMatchObject({ error: 'SERVICE_UNAVAILABLE' })
    expect(t.clients.send).not.toHaveBeenCalled(); expect(t.clients.sendCommander).not.toHaveBeenCalled()
    expect(t.log).toHaveBeenLastCalledWith('[cloud] CLOUD_RESPONSE_INVALID')
  }
})

it('checks prepared create, answer, Stop and delivery shapes on the same inline and IPC boundary', async () => {
  for (const value of [null, [], {}, { agent: {} }, { agent: { ...prepared().agent, engine: 'fo' } }]) {
    expect(await immediate(value).cloud.create({ engine: owner.agent })).toMatchObject({ error: 'SERVICE_UNAVAILABLE' })
  }
  for (const value of [{ ok: false, error: 'BUSY', detail: '' }, { ok: false, error: 'STALE_QUESTION', detail: 3 }, { ok: false }, { ok: 'yes' }, { ok: false, error: 'ANSWER_FAILED' }]) {
    expect(await immediate(value).cloud.answer({ requestId: 'cloud_q_1' })).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: CLOUD_DOWN.detail })
  }
  for (const value of [{ deleted: false }, { deleted: true, detail: 3 }, { deleted: true, extra: true }]) {
    expect(await immediate(value).cloud.stop(owner.agentId)).toMatchObject({ error: 'SERVICE_UNAVAILABLE' })
  }
  for (const value of [null, {}, { ok: false, error: 4 }]) {
    expect(await immediate(value).cloud.deliver(owner.agentId, 'hello')).toEqual(CLOUD_DOWN)
  }
  expect(await immediate({ ok: false, error: 'BUSY', detail: 'wait' }).cloud.deliver(owner.agentId, 'hello')).toEqual({ ok: false, error: 'BUSY', detail: 'wait' })
})
