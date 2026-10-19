import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { superTabService } from './service.js'
import type { SuperTabHost } from './host.js'

const owner = { local: true, owner: true }, visitor = { local: false, owner: false }
function setup() {
  const agentId = createHash('sha256').update(JSON.stringify(['machine-1', 'native'])).digest('hex').slice(0, 24)
  const agent = { id: agentId, machineId: 'machine-1', harnessId: 'native' }
  const call = vi.fn(async () => ({ status: 200, body: { success: true, data: { state: { agents: [agent] } } } }))
  const core = fakeCore({ account: { backend: call }, agents: { byAgent: vi.fn(() => ({ agentId: 'native' }) as never) } })
  const start = vi.fn(), stop = vi.fn()
  const service = superTabService(core, { host: () => ({ machineId: 'machine-1', start, stop }) as unknown as SuperTabHost })
  return { ...service, call, core, agent, agentId, start, stop, ask: service.requests.super_tabs }
}
it('keeps a shared machine controller out of the host account while accepting its own paired apps', async () => {
  const t = setup()
  for (const accountOwner of [undefined, false]) {
    expect(await t.ask({ action: 'backend', method: 'GET', path: '/api/super-tabs/tab', accountOwner: true },
      { local: false, owner: true, accountOwner })).toEqual({ error: 'OWNER_REQUIRED' })
  }
  expect(t.call).not.toHaveBeenCalled()
  expect(await t.ask({ action: 'backend', method: 'GET', path: '/api/super-tabs/tab' },
    { local: false, owner: true, accountOwner: true })).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenCalledOnce()
})
it('lets a shared host be woken without exposing its account proxy or agent identity', async () => {
  const t = setup()
  expect(await t.ask({ action: 'wake' }, visitor)).toEqual({ ok: true })
  expect(t.start).toHaveBeenCalledOnce()
  for (const action of ['backend', 'status', 'command', 'help']) {
    expect(await t.ask({ action }, visitor)).toEqual({ error: 'OWNER_REQUIRED' })
  }
  expect(t.call).not.toHaveBeenCalled()
  t.port.disconnected(); expect(t.stop).toHaveBeenCalledOnce()
})
it('limits the owner proxy to Super Tab endpoints and preserves backend failures', async () => {
  const t = setup()
  for (const path of ['/api/auth/me', '/api/super-tabs/../auth/me', '/api/super-tabs%2F..', 'https://elsewhere.invalid', '/api/super-tabs#other']) {
    expect(await t.ask({ action: 'backend', method: 'GET', path }, owner)).toMatchObject({ error: 'INVALID_REQUEST' })
  }
  expect(await t.ask({ action: 'backend', method: 'DELETE', path: '/api/super-tabs' }, owner)).toMatchObject({ error: 'INVALID_REQUEST' })
  expect(t.call).not.toHaveBeenCalled()
  expect(await t.ask({ action: 'backend', method: 'GET', path: '/api/super-tabs/tab?asAgentId=agent' }, owner)).toMatchObject({ ok: true })
  vi.mocked(t.core.account.backend).mockResolvedValueOnce({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Access withdrawn' } } })
  expect(await t.ask({ action: 'backend', method: 'GET', path: '/api/super-tabs/tab' }, owner)).toEqual({ error: 'FORBIDDEN', detail: 'Access withdrawn', status: 403 })
})
it('resolves a native caller to its exact contribution and rechecks it before every agent command', async () => {
  const t = setup()
  expect(await t.ask({ action: 'status', tabId: 'tab', harnessId: 'native' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab?asAgentId=${t.agentId}`, undefined)
  const command = { type: 'message.send', conversationId: 'lead', text: 'Ready', replyTo: null, recipientIds: [] }
  expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'op', command }, owner)).toMatchObject({ ok: true, operationId: 'op' })
  expect(t.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'op', command, asAgentId: t.agentId })
  expect(await t.ask({ action: 'message', tabId: 'tab', agentId: t.agentId, conversationId: 'lead', messageId: 'old-question' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab/conversations/lead/messages?asAgentId=${t.agentId}&messageId=old-question`, undefined)
  t.agent.machineId = 'another-machine'
  expect(await t.ask({ action: 'status', tabId: 'tab', agentId: t.agentId }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
  t.agent.machineId = 'machine-1'; vi.mocked(t.core.agents.byAgent).mockReturnValue(undefined)
  expect(await t.ask({ action: 'status', tabId: 'tab', agentId: t.agentId }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
})

it('keeps host capacity separate from account authority and closes it on disconnect or identity change', async () => {
  const core = fakeCore()
  const reserve = vi.fn(async () => ({ ok: true, reservationId: 'native-creation-id' }))
  const observe = vi.fn(async () => ({ ok: true, released: true }))
  const stop = vi.fn(), factory = vi.fn(() => ({ reserve, observe, stop }))
  const service = superTabService(core, { reservations: factory })
  const closed = new AbortController().signal
  expect(factory).not.toHaveBeenCalled()
  expect(await service.requests.super_tabs({ action: 'reserveCapacity', creationId: 'native-creation-id' }, visitor, closed)).toMatchObject({ ok: true })
  expect(reserve).toHaveBeenCalledWith({ action: 'reserveCapacity', creationId: 'native-creation-id' }, closed)
  expect(await service.requests.super_tabs({ action: 'observeCapacity', creationId: 'native-creation-id' }, visitor)).toMatchObject({ released: true })
  expect(factory).toHaveBeenCalledTimes(1)
  service.port.disconnected(); expect(stop).toHaveBeenCalledTimes(1)
  await service.requests.super_tabs({ action: 'reserveCapacity' }, visitor)
  expect(factory).toHaveBeenCalledTimes(2)
  core.daemon.machineId = () => 'changed-machine'
  await service.requests.super_tabs({ action: 'reserveCapacity' }, visitor)
  expect(stop).toHaveBeenCalledTimes(2)
  expect(factory).toHaveBeenLastCalledWith(core, 'changed-machine')
  service.port.stop(); expect(stop).toHaveBeenCalledTimes(3)
})

it('lets a machine client prepare only a backend-verified terminal context', async () => {
  const core = fakeCore(), prepareNative = vi.fn(async () => ({ ok: true, inputContext: 'context_1234567890' }))
  const service = superTabService(core, { host: () => ({ machineId: 'machine-1', start: vi.fn(), stop: vi.fn(), prepareNative }) as unknown as SuperTabHost })
  const signal = new AbortController().signal
  expect(await service.requests.super_tabs({ action: 'prepareNative', tabId: 'tab', contextId: 'context_1234567890' }, visitor, signal))
    .toEqual({ ok: true, inputContext: 'context_1234567890' })
  expect(prepareNative).toHaveBeenLastCalledWith('tab', 'context_1234567890', false, signal)
  await service.requests.super_tabs({ action: 'renewNative', tabId: 'tab', contextId: 'context_1234567890' }, visitor)
  expect(prepareNative).toHaveBeenLastCalledWith('tab', 'context_1234567890', true, undefined)
  expect(core.account.backend).not.toHaveBeenCalled()
})
