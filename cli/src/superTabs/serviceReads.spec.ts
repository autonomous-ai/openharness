import { describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { FIXTURE, ok, readFixture, type BackendReply } from './fixtures/read/index.js'
import type { SuperTabHost } from './host.js'
import { superTabService } from './service.js'

type Json = Record<string, unknown>
const T = FIXTURE.tabId, M = FIXTURE.machineId
const owner = { local: true, owner: true }

/** The fixture Swarm on its own machine: the host form lists the Lead and the Builder, each reads its own view by parts. */
function swarm(extra: (method: string, path: string, body?: unknown) => BackendReply | undefined = () => undefined) {
  const call = vi.fn<CoreApi['account']['backend']>(async (method, path, body) => {
    const answer = extra(method, path, body)
    if (answer) return answer
    if (path.startsWith(`/api/super-tabs/hosts/${M}/changes`)) return ok(readFixture('host-full'))
    if (path === `/api/super-tabs/${T}/parts?asAgentId=${FIXTURE.leadId}`) return ok(readFixture('parts-lead'))
    if (path === `/api/super-tabs/${T}/parts?asAgentId=${FIXTURE.builderId}`) return ok(readFixture('parts-builder'))
    if (path.startsWith(`/api/super-tabs/${T}/changes?`)) return ok(readFixture('changes-reload'))
    return ok({ messages: [], next: null })
  })
  const core = fakeCore({ account: { backend: call }, daemon: { machineId: () => M } as never,
    agents: { byAgent: vi.fn((id: string) => ([FIXTURE.leadHarness, FIXTURE.builderHarness] as string[]).includes(id) ? { agentId: id } as never : undefined) } })
  const service = superTabService(core, { host: () => ({ machineId: M, start: vi.fn(), stop: vi.fn() }) as unknown as SuperTabHost })
  const reads = () => call.mock.calls.map(c => c[1]).filter(path => /\/parts|\/changes\?cursor|\/super-tabs\/[A-Za-z0-9]+\?/.test(path) && !path.includes('/hosts/'))
  return { call, core, ask: service.requests.super_tabs, reads }
}
describe('what each action reads of the Swarm', () => {
  it('finds the caller by its harness, as the roster lists it on this machine', async () => {
    const s = swarm()
    expect(await s.ask({ action: 'messages', tabId: T, harnessId: FIXTURE.builderHarness, conversationId: FIXTURE.workGroup }, owner)).not.toHaveProperty('error')
    expect(s.reads()).toEqual([`/api/super-tabs/${T}/parts?asAgentId=${FIXTURE.builderId}`])
  })
  // Task steps design: a task's newest page shows its steps' rows, so it reads the Swarm, by what changed, to find them.
  it('reads the Swarm once for a conversation\'s newest messages, to find its steps', async () => {
    const s = swarm()
    expect(await s.ask({ action: 'messages', tabId: T, agentId: FIXTURE.builderId, conversationId: FIXTURE.workGroup }, owner)).not.toHaveProperty('error')
    expect(s.reads()).toEqual([`/api/super-tabs/${T}/parts?asAgentId=${FIXTURE.builderId}`])
  })
  it.each([
    ['message', { conversationId: FIXTURE.workGroup, messageId: 'f00000000000000000000001' }],
    ['terminalResult', { terminalRequestId: 'r1' }],
    ['attachment', { conversationId: FIXTURE.workGroup, step: 'sent', operationId: 'op-1' }],
    ['command', { operationId: 'op-2', command: { type: 'message.send', conversationId: FIXTURE.workGroup, text: 'Hi', replyTo: null, recipientIds: [] } }],
  ])('reads nothing of it for %s', async (action, payload) => {
    const s = swarm()
    const answer = await s.ask({ action, tabId: T, agentId: FIXTURE.builderId, ...payload }, owner)
    expect(answer).not.toHaveProperty('error')
    expect(s.reads()).toEqual([])
  })
  it('reads the people only for a post that tags someone', async () => {
    const s = swarm()
    await s.ask({ action: 'command', tabId: T, agentId: FIXTURE.leadId, operationId: 'op-3',
      command: { type: 'message.send', conversationId: FIXTURE.leadGroup, text: 'Please decide', replyTo: null, recipientIds: [], mentions: ['dev@example.com'] } }, owner)
    expect(s.reads()).toEqual([`/api/super-tabs/${T}/parts?asAgentId=${FIXTURE.leadId}`])
    expect(s.call).toHaveBeenCalledWith('POST', `/api/super-tabs/${T}/commands`, expect.objectContaining({
      command: expect.objectContaining({ mentions: [FIXTURE.collaboratorId] }) }))
  })
  it('reads the roster as it is now for every call, so an agent started a moment ago is known at once', async () => {
    let started = false
    const s = swarm((_method, path) => path.startsWith(`/api/super-tabs/hosts/${M}/changes`) && !started
      ? ok({ ...readFixture<Json>('host-full'), tabs: [] }) : undefined)
    expect(await s.ask({ action: 'messages', tabId: T, agentId: FIXTURE.builderId, conversationId: FIXTURE.workGroup }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
    started = true
    expect(await s.ask({ action: 'messages', tabId: T, agentId: FIXTURE.builderId, conversationId: FIXTURE.workGroup }, owner)).toMatchObject({ ok: true })
    expect(s.call.mock.calls.map(c => c[1]).filter(path => path.includes('/hosts/')))
      .toEqual([`/api/super-tabs/hosts/${M}/changes?full=1`, `/api/super-tabs/hosts/${M}/changes?cursor=eyJ2IjoyLCJ0IjoxNzkzMDEwMDc0Mzc1LCJlIjowfQ`])
  })
  // The server leaves an agent off the roster when this machine has no access or billing for it: the error says where to look.
  it('refuses a caller the roster does not list here, or whose session is not running, saying which', async () => {
    const s = swarm()
    expect(await s.ask({ action: 'messages', tabId: T, agentId: 'a0000000000000000000000z', conversationId: FIXTURE.workGroup }, owner))
      .toEqual({ error: 'AGENT_UNAVAILABLE', detail: 'This agent is not on this machine\'s Swarm roster right now. That can mean this machine has no access to it, or its billing does not allow it. Check how this machine is shared.' })
    vi.mocked(s.core.agents.byAgent).mockReturnValue(undefined)
    expect(await s.ask({ action: 'messages', tabId: T, agentId: FIXTURE.builderId, conversationId: FIXTURE.workGroup }, owner))
      .toEqual({ error: 'AGENT_UNAVAILABLE', detail: 'This agent is not a running contribution on this machine.' })
  })
  it('tells the person to update Harness when the server needs a newer one', async () => {
    const s = swarm((_method, path) => path.includes('/parts') ? { status: 426, body: { success: false, error: { code: 'UPDATE_REQUIRED' } } } : undefined)
    expect(await s.ask({ action: 'command', tabId: T, agentId: FIXTURE.leadId, operationId: 'op-4',
      command: { type: 'message.send', conversationId: FIXTURE.leadGroup, text: 'Please decide', replyTo: null, recipientIds: [], mentions: ['dev@example.com'] } }, owner))
      .toEqual({ error: 'UPDATE_REQUIRED', detail: 'Update Harness to keep using this Swarm.', status: 426 })
  })
})
