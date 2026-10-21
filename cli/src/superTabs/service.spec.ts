import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { superTabService } from './service.js'
import type { SuperTabHost } from './host.js'
import { createJevDecide, type JevDecide } from '../lib/jev/jevClient.js'

// The real client would read the developer's OpenRouter key; the account backend is the only part under test.
vi.mock('../lib/jev/jevClient.js', async importOriginal => ({ ...await importOriginal<typeof import('../lib/jev/jevClient.js')>(), createJevDecide: vi.fn() }))
const createJev = vi.mocked(createJevDecide)

const owner = { local: true, owner: true }, visitor = { local: false, owner: false }
function setup(options: { jev?: () => JevDecide; prepareContribution?: typeof import('./contribution.js').prepareContribution } = {}) {
  const agentId = createHash('sha256').update(JSON.stringify(['machine-1', 'native'])).digest('hex').slice(0, 24)
  const agent = { id: agentId, machineId: 'machine-1', harnessId: 'native' }
  const call = vi.fn(async () => ({ status: 200, body: { success: true, data: { state: { agents: [agent] } } } }))
  const core = fakeCore({ account: { backend: call }, agents: { byAgent: vi.fn(() => ({ agentId: 'native' }) as never) } })
  const start = vi.fn(), stop = vi.fn()
  const service = superTabService(core, { host: () => ({ machineId: 'machine-1', start, stop }) as unknown as SuperTabHost, ...options })
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
it('documents how a lead shares its project repository for other machines', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { commands: Array<Record<string, unknown>> } }
  expect(answer.help.commands).toContainEqual({ type: 'project.repository', projectId: 'PROJECT', repositoryUrl: 'https://github.com/OWNER/REPOSITORY' })
})
it('tells the Lead that start works only on a machine in the Swarm\'s Machines list', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { start: string } }
  expect(answer.help.start).toContain('create one agent in a conversation on a machine in this Swarm\'s Machines list; to use another machine, a person adds it to the Swarm first.')
  expect(answer.help.start).toContain('Repeat exactly after an interruption')
})
it('resolves a native caller to its exact contribution and rechecks it before every agent command', async () => {
  const t = setup()
  expect(await t.ask({ action: 'status', tabId: 'tab', harnessId: 'native' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab?asAgentId=${t.agentId}`, undefined)
  const command = { type: 'message.send', conversationId: 'lead', text: 'Ready', replyTo: null, recipientIds: [] }
  expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'op', command }, owner)).toMatchObject({ ok: true, operationId: 'op' })
  expect(t.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'op', command, asAgentId: t.agentId })
  expect(await t.ask({ action: 'message', tabId: 'tab', agentId: t.agentId, conversationId: 'lead', messageId: 'old-question' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/conversations/lead/messages?asAgentId=${t.agentId}&messageId=old-question`, undefined)
  t.agent.machineId = 'another-machine'
  expect(await t.ask({ action: 'status', tabId: 'tab', agentId: t.agentId }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
  t.agent.machineId = 'machine-1'; vi.mocked(t.core.agents.byAgent).mockReturnValue(undefined)
  expect(await t.ask({ action: 'status', tabId: 'tab', agentId: t.agentId }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
})

it('tells the Lead which branch a started agent works from, and how to choose another', async () => {
  const t = setup()
  const help = (await t.ask({ action: 'help' }, owner)).help as { start: string; startRequest: Record<string, unknown> }
  expect(help.start).toContain('default branch, fetched first')
  expect(help.start).toContain('branchRef')
  expect(help.startRequest).toMatchObject({ worktree: true, branchRef: 'refs/remotes/origin/BASE_BRANCH' })
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

it('returns the routing context to a verified contribution', async () => {
  const t = setup()
  vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => path.includes('/routing-policy')
    ? { status: 200, body: { success: true, data: { policy: { version: 1 }, warnings: [], overridden: [] } } }
    : { status: 200, body: { success: true, data: { state: { agents: [t.agent] } } } })
  t.core.account.machines = vi.fn(async () => ({ status: 200, body: { success: true, data: {
    machines: [{ machineId: 'm1', name: 'remote-1', status: 'online' }],
    sharedMachines: [{ machineId: 'm2', name: 'shared', status: 'online', share: { added: true } }, { machineId: 'm3', name: 'not added', status: 'online' }] } } }))
  expect(await t.ask({ action: 'routeContext', tabId: 'tab', harnessId: 'native' }, owner)).toEqual({ ok: true, value: {
    agentId: t.agentId, tab: { state: { agents: [t.agent] } }, policy: { policy: { version: 1 }, warnings: [], overridden: [] },
    machines: [{ machineId: 'm1', name: 'remote-1', status: 'online' }, { machineId: 'm2', name: 'shared', status: 'online' }] } })
  expect(t.call).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/routing-policy?asAgentId=${t.agentId}`, undefined)
})
describe('routeHistory for Jev', () => {
  const contextOf = (t: ReturnType<typeof setup>, read: (path: string) => Promise<unknown>, lead?: string) => {
    const state = { agents: [{ ...t.agent, name: 'Boss' }, { id: 'a2', name: 'Multiply' }, { id: 'a3', name: 'Reader' }], conversations: [{ id: 'g1', leadId: lead ?? t.agentId }] }
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => {
      if (path.includes('/messages') || path.includes('/route-decisions') || path.includes('/attempts')) return await read(path) as never
      return { status: 200, body: { success: true, data: path.includes('/routing-policy') ? { policy: { version: 1 }, warnings: [] } : { state } } }
    })
    t.core.account.machines = vi.fn(async () => ({ status: 200, body: { data: { machines: [] } } }))
    return t.ask({ action: 'routeHistory', tabId: 'tab', harnessId: 'native', conversationId: 'g1' }, owner) as Promise<{ value: Record<string, unknown> }>
  }
  const ok = (data: unknown) => ({ status: 200, body: { success: true, data } })
  it('gives the last ten group messages with a role instead of an author, and never an agent transcript or a routing note', async () => {
    const t = setup()
    const person = (text: string) => ({ author: { kind: 'person', id: 'u1', name: 'minh@example.com' }, text })
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => person(`early ${i}`)),
      { author: { kind: 'agent', id: t.agentId, name: 'Boss' }, text: 'Lead says' },
      { author: { kind: 'agent', id: 'a2', name: 'Multiply' }, text: 'Worker says', source: null },
      { author: { kind: 'agent', id: 'a2', name: 'Multiply' }, text: 'TRANSCRIPT', source: { kind: 'native', phase: 'answer' } },
      { author: { kind: 'agent', id: t.agentId, name: 'Boss' }, text: 'Routed to X', source: { kind: 'route', decisionId: 'd' } },
      { author: { kind: 'agent', id: 'gone', name: 'Gone' }, text: 'x'.repeat(1500) },
      { author: { kind: 'agent', id: 'a3', name: 'Reader' }, text: 'last' },
    ]
    const { value } = await contextOf(t, async path => path.includes('/messages') ? ok({ messages: rows }) : ok([]))
    const messages = value.messages as Array<{ from: string; text: string }>
    expect(messages.map(m => m.from)).toEqual([...Array(6).fill('person'), 'Lead', 'Multiply', 'agent', 'Reader'])
    expect(messages[0].text).toBe('early 2')
    expect(messages[8].text).toBe('x'.repeat(1000))
    expect(JSON.stringify(value.messages)).not.toMatch(/@|TRANSCRIPT|Routed to/)
    expect(value).not.toHaveProperty('messagesUnreadable')
    expect(vi.mocked(t.core.account.backend)).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/conversations/g1/messages?asAgentId=${t.agentId}`, undefined)
  })
  it('says the latest page held only log rows, instead of saying nothing was said', async () => {
    const only = [{ author: { kind: 'agent', id: 'a2', name: 'Multiply' }, text: 'T', source: { kind: 'native' } }]
    const { value } = await contextOf(setup(), async path => path.includes('/messages') ? ok({ messages: only }) : ok([]))
    expect(value).toMatchObject({ messages: [], noneInLatest: true })
    const empty = await contextOf(setup(), async path => path.includes('/messages') ? ok({ messages: [] }) : ok([]))
    expect(empty.value).toEqual({ messages: [], decisions: [], attempts: [] })
  })
  it('is for the Lead of the group only, like the route', async () => {
    const t = setup()
    expect(await contextOf(t, async () => ok([]), 'someone-else')).toMatchObject({ error: 'LEAD_REQUIRED', status: 403 })
    expect(vi.mocked(t.core.account.backend)).not.toHaveBeenCalledWith('GET', expect.stringContaining('/messages'), undefined)
  })
  it('gives the latest routing decisions in brief, newest first, without their records', async () => {
    const t = setup()
    const decision = (i: number) => ({ id: `d${i}`, conversationId: 'g1', record: { pick: 'c1', via: i === 2 ? undefined : 'jev', candidates: [{ id: 'c0', title: 'Other' }, { id: 'c1', title: `Pick ${i}`, label: 'big'.repeat(100) }] },
      final: i % 2 ? { kind: 'member', agentId: 'a2', machineId: 'm1' } : { kind: 'new', startId: 's', machineId: 'm1', engine: 'claude', model: 'opus', effort: 'high' },
      outcome: i % 3 ? 'done' : null, assignmentId: `as${i}`, createdAt: '2026-10-19T10:00:00Z', outcomeAt: null })
    const unfinished = { id: 'dx', conversationId: 'g1', record: { pick: 'c9', via: 'order', candidates: [] }, final: null, outcome: 'superseded', assignmentId: null, createdAt: '2026-10-19T09:00:00Z' }
    const { value } = await contextOf(t, async path => path.includes('/messages') ? ok({ messages: [] }) : ok([...Array.from({ length: 60 }, (_, i) => decision(i)), unfinished]))
    const decisions = value.decisions as Array<Record<string, unknown>>
    expect(decisions).toHaveLength(50)
    expect(decisions[0]).toEqual({ id: 'd0', conversationId: 'g1', title: 'Pick 0', via: 'jev', outcome: null, assignmentId: 'as0', createdAt: '2026-10-19T10:00:00Z',
      final: { kind: 'new', engine: 'claude', model: 'opus' } })
    expect(decisions[1]).toMatchObject({ final: { kind: 'member', agentId: 'a2' }, outcome: 'done' })
    expect(decisions[2]).not.toHaveProperty('via')
    expect(JSON.stringify(decisions)).not.toContain('bigbig')
    const last = await contextOf(setup(), async path => path.includes('/messages') ? ok({ messages: [] }) : ok([unfinished]))
    expect(last.value.decisions).toEqual([{ id: 'dx', conversationId: 'g1', title: 'unknown pick', via: 'order', outcome: 'superseded', assignmentId: null, createdAt: '2026-10-19T09:00:00Z', final: null }])
    // The pick's account, spend and size go with it, so the route can count what an open pick still holds.
    const fit = { status: 'fits', coverage: 2, effectiveCost: 3, expiring: 0, spend: { '5-hour': 45, weekly: 6 }, account: 'k1' }
    const sized = (size?: string) => ({ ...decision(0), record: { pick: 'c1', via: 'jev', assessment: size ? { size } : {}, candidates: [{ id: 'c0', title: 'Other' }, { id: 'c1', title: 'Pick', fit }] } })
    const phase1 = await contextOf(setup(), async path => path.includes('/messages') ? ok({ messages: [] }) : ok([sized('large'), sized()]))
    expect(phase1.value.decisions).toMatchObject([{ account: 'k1', spend: { '5-hour': 45, weekly: 6 }, size: 'large' }, { size: 'medium' }])
    // An override runs another candidate: a person's choice holds its own account; a Lead's choice outside the list holds none.
    const other = { ...fit, account: 'k0', spend: { '5-hour': 30, weekly: 4 } }
    const overridden = (override: Record<string, unknown>) => ({ ...sized('large'), override,
      record: { ...sized('large').record, candidates: [{ id: 'c0', title: 'Other', fit: other }, { id: 'c1', title: 'Pick', fit }] } })
    const moved = await contextOf(setup(), async path => path.includes('/messages') ? ok({ messages: [] })
      : ok([overridden({ by: 'person', candidateId: 'c0', reason: 'r' }), overridden({ by: 'lead', reason: 'r' })]))
    const [person, lead] = moved.value.decisions as Array<Record<string, unknown>>
    expect(person).toMatchObject({ title: 'Pick', account: 'k0', spend: { '5-hour': 30, weekly: 4 } })
    expect(lead).not.toHaveProperty('account')
  })
  it('gives every attempt of the group, newest first, with only what Jev needs and no more than fifty', async () => {
    const t = setup()
    const row = (i: number) => ({ id: `as${i}`, agentId: i % 2 ? 'a2' : 'gone', status: 'stopped', result: i === 0 ? 'Tests failed.' : i === 2 ? 'y'.repeat(900) : null, createdAt: '2026-10-19T10:00:00Z',
      conversationId: 'g1', execution: { harnessId: 'secret' } })
    const { value } = await contextOf(t, async path => path.includes('/attempts') ? ok(Array.from({ length: 60 }, (_, i) => row(i))) : ok(path.includes('/messages') ? { messages: [] } : []))
    const attempts = value.attempts as Array<Record<string, unknown>>
    expect(attempts).toHaveLength(50)
    expect(attempts[0]).toEqual({ id: 'as0', agentId: 'gone', status: 'stopped', result: 'Tests failed.', createdAt: '2026-10-19T10:00:00Z' })
    expect(attempts[1]).toEqual({ id: 'as1', agentId: 'a2', status: 'stopped', result: null, createdAt: '2026-10-19T10:00:00Z' })
    expect(attempts[2].result).toBe('y'.repeat(500))
    expect(JSON.stringify(attempts)).not.toContain('secret')
    expect(value).not.toHaveProperty('attemptsUnreadable')
    expect(vi.mocked(t.core.account.backend)).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/conversations/g1/attempts?asAgentId=${t.agentId}`, undefined)
  })
  it('marks the attempts unreadable when an older backend answers 404 or the read fails or hangs', async () => {
    const without = (path: string) => path.includes('/messages') ? ok({ messages: [] }) : ok([])
    const old = await contextOf(setup(), async path => path.includes('/attempts') ? { status: 404, body: { success: false, error: { code: 'NOT_FOUND' } } } : without(path))
    expect(old.value).toMatchObject({ messages: [], decisions: [], attemptsUnreadable: true })
    expect(old.value).not.toHaveProperty('attempts')
    const failed = await contextOf(setup(), async path => path.includes('/attempts') ? Promise.reject(new Error('down')) : without(path))
    expect(failed.value).toMatchObject({ attemptsUnreadable: true, messages: [] })
    const odd = await contextOf(setup(), async path => path.includes('/attempts') ? ok({ attempts: 'no' }) : without(path))
    expect(odd.value).toMatchObject({ attemptsUnreadable: true })
    vi.useFakeTimers()
    try {
      const slow = contextOf(setup(), async path => path.includes('/attempts') ? new Promise(() => {}) : without(path))
      await vi.advanceTimersByTimeAsync(3000)
      expect((await slow).value).toMatchObject({ messages: [], decisions: [], attemptsUnreadable: true })
    } finally { vi.useRealTimers() }
  })
  it('marks each source it could not read on its own, and never waits longer than three seconds for one', async () => {
    const failed = await contextOf(setup(), async path => path.includes('/messages') ? Promise.reject(new Error('down')) : ok([]))
    expect(failed.value).toMatchObject({ messagesUnreadable: true, decisions: [] })
    expect(failed.value).not.toHaveProperty('decisionsUnreadable')
    const odd = await contextOf(setup(), async path => path.includes('/messages') ? ok({ messages: 'no' }) : { status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    expect(odd.value).toMatchObject({ messagesUnreadable: true, decisionsUnreadable: true })
    vi.useFakeTimers()
    try {
      const slow = contextOf(setup(), async path => path.includes('/messages') ? ok({ messages: [] }) : new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(3000)
      expect((await slow).value).toMatchObject({ messages: [], decisionsUnreadable: true })
    } finally { vi.useRealTimers() }
  })
})
it('says the machine list could not be read, instead of offering none', async () => {
  const t = setup()
  vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => path.includes('/routing-policy')
    ? { status: 200, body: { success: true, data: { policy: { version: 1 }, warnings: [], overridden: [] } } }
    : { status: 200, body: { success: true, data: { state: { agents: [t.agent] } } } })
  for (const answer of [async () => ({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } }), async () => { throw new Error('link lost') }]) {
    t.core.account.machines = vi.fn(answer)
    expect(await t.ask({ action: 'routeContext', tabId: 'tab', harnessId: 'native' }, owner)).toMatchObject({ ok: true, value: { machines: [], machinesUnreadable: true } })
  }
  t.core.account.machines = vi.fn(async () => ({ status: 200, body: { data: { machines: [{ machineId: 'm1', name: 'remote-1', status: 'online' }] } } }))
  expect((await t.ask({ action: 'routeContext', tabId: 'tab', harnessId: 'native' }, owner) as { value: object }).value).not.toHaveProperty('machinesUnreadable')
})
const routing = (t: ReturnType<typeof setup>, decisions: unknown[] = [], leadId?: string) => vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => path.includes('/route-decisions')
  ? { status: 200, body: { success: true, data: decisions } }
  : { status: 200, body: { success: true, data: { state: { agents: [t.agent], conversations: [{ id: 'g1', leadId: leadId ?? t.agentId }] } } } })
it('asks Jev with a three-second limit and reports unavailability instead of failing', async () => {
  const answer = { who: { choice: 'c1', probabilities: { c0: 0.2, c1: 0.8 } } }
  const decide = vi.fn<JevDecide>(async () => answer)
  const t = setup({ jev: () => decide }); routing(t)
  expect(await t.ask({ action: 'routeJev', tabId: 'tab', harnessId: 'native', conversationId: 'g1', state: { task: 't' }, questions: { who: {} } }, owner))
    .toEqual({ ok: true, value: { answers: answer } })
  expect(decide.mock.calls[0][2]).toBeInstanceOf(AbortSignal)
  const ask = (extra: object = {}) => t.ask({ action: 'routeJev', tabId: 'tab', harnessId: 'native', conversationId: 'g1', state: {}, questions: {}, ...extra }, owner)
  decide.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'BUSY' }))
  expect(await ask()).toEqual({ ok: true, value: { unavailable: 'BUSY' } })
  decide.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))
  expect(await ask()).toEqual({ ok: true, value: { unavailable: 'TIMEOUT' } })
  decide.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
  expect(await ask()).toEqual({ ok: true, value: { unavailable: 'TIMEOUT' } })
  decide.mockRejectedValueOnce(new Error('boom'))
  expect(await ask()).toEqual({ ok: true, value: { unavailable: 'UNAVAILABLE' } })
  decide.mockRejectedValueOnce('odd')
  expect(await ask()).toEqual({ ok: true, value: { unavailable: 'UNAVAILABLE' } })
})
it('builds Jev from the account backend when no override is given', async () => {
  const t = setup()
  const hosted = { who: { choice: 'c0', probabilities: { c0: 1 } } }
  vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => path === '/api/route/jev'
    ? { status: 200, body: { data: { answers: hosted } } }
    : path.includes('/route-decisions') ? { status: 200, body: { success: true, data: [] } }
    : { status: 200, body: { success: true, data: { state: { agents: [t.agent], conversations: [{ id: 'g1', leadId: t.agentId }] } } } })
  createJev.mockImplementationOnce(options => (async () => {
    const reply = await options!.backend!('POST', '/api/route/jev', {})
    return (reply.body.data as { answers: Record<string, never> }).answers
  }) as JevDecide)
  const service = superTabService(t.core, { host: () => ({ machineId: 'machine-1', start: vi.fn(), stop: vi.fn() }) as unknown as SuperTabHost })
  expect(await service.requests.super_tabs({ action: 'routeJev', tabId: 'tab', harnessId: 'native', conversationId: 'g1', state: {}, questions: {} }, owner))
    .toEqual({ ok: true, value: { answers: hosted } })
})
it('refuses routing to anyone but the group Lead, and past 30 decisions in the rolling hour, before asking Jev', async () => {
  const decide = vi.fn<JevDecide>(async () => ({}))
  const t = setup({ jev: () => decide })
  const ask = (conversationId: string) => t.ask({ action: 'routeJev', tabId: 'tab', harnessId: 'native', conversationId, state: {}, questions: {} }, owner)
  routing(t, [], 'someone-else')
  expect(await ask('g1')).toMatchObject({ error: 'LEAD_REQUIRED', status: 403 })
  routing(t)
  expect(await ask('missing')).toMatchObject({ error: 'LEAD_REQUIRED' })
  const recent = (n: number, age = 1000) => Array.from({ length: n }, () => ({ createdAt: new Date(Date.now() - age).toISOString() }))
  routing(t, recent(30))
  expect(await ask('g1')).toMatchObject({ error: 'RATE_LIMITED', status: 429 })
  routing(t, [...recent(29), ...recent(50, 61 * 60_000)])
  expect(await ask('g1')).toMatchObject({ ok: true })
  routing(t, { not: 'a list' } as never)
  expect(await ask('g1')).toMatchObject({ ok: true })
  expect(decide).toHaveBeenCalledTimes(2)
})

it('prepares machines only for their owner and clears setup receipts on disconnect', async () => {
  const prepareContribution = vi.fn(async () => ({ ok: true, state: 'ready' }))
  const t = setup({ prepareContribution })
  const request = { action: 'prepareContribution', tabId: 'tab', operationId: 'setup' }
  expect(await t.ask(request, visitor)).toEqual({ error: 'OWNER_REQUIRED' })
  expect(await t.ask(request, { local: false, owner: true, accountOwner: false })).toEqual({ error: 'OWNER_REQUIRED' })
  expect(prepareContribution).not.toHaveBeenCalled()
  expect(await t.ask(request, owner)).toMatchObject({ state: 'preparing' })
  expect(await t.ask(request, owner)).toMatchObject({ state: 'ready' })
  expect(prepareContribution).toHaveBeenCalledOnce()
  t.port.disconnected()
  await t.ask(request, owner)
  expect(prepareContribution).toHaveBeenCalledTimes(2)
})

describe('which messages still need an answer', () => {
  const person = { kind: 'person', id: 'p1', name: 'sam@example.com' }
  const rows = (agentId: string) => [
    { id: 'm1', sequence: 1, author: person, recipientIds: [agentId], replyTo: null },
    { id: 'm2', sequence: 2, author: person, recipientIds: [agentId], replyTo: null },
    { id: 'm3', sequence: 3, author: person, recipientIds: ['someone-else'], replyTo: null },
    { id: 'm4', sequence: 4, author: { kind: 'agent', id: agentId, name: 'Lead' }, recipientIds: [], replyTo: 'm1' },
    { id: 'm5', sequence: 5, author: { kind: 'agent', id: 'someone-else', name: 'Other' }, recipientIds: [agentId], replyTo: 'm2' },
  ]
  it('marks messages addressed to the caller as answered or not, and leaves the rest unmarked', async () => {
    const t = setup()
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => ({ status: 200, body: { success: true,
      data: path.includes('/messages') ? { messages: rows(t.agentId), next: null } : { state: { agents: [t.agent] } } } }))
    const value = (await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'lead' }, owner) as { value: { messages: Record<string, unknown>[] } }).value
    expect(value.messages.map(m => m.answered)).toEqual([true, false, undefined, undefined, false])
    // A person's email is passed as the backend sent it.
    expect((value.messages[0]!.author as { name: string }).name).toBe('sam@example.com')
  })
  it('reads the later messages of one exact message to tell whether it was answered', async () => {
    const t = setup()
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => {
      const all = rows(t.agentId)
      const data = path.includes('messageId=m1') ? { messages: [all[0]] } : path.includes('after=1') ? { messages: all.slice(1) } : { state: { agents: [t.agent] } }
      return { status: 200, body: { success: true, data } }
    })
    const value = (await t.ask({ action: 'message', tabId: 'tab', agentId: t.agentId, conversationId: 'lead', messageId: 'm1' }, owner) as { value: { messages: Record<string, unknown>[] } }).value
    expect(value.messages).toHaveLength(1)
    expect(value.messages[0]!.answered).toBe(true)
  })
  it('skips the extra read for a message not addressed to the caller, and survives its failure', async () => {
    const t = setup()
    const reads: string[] = []
    let failAfter = false
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => {
      reads.push(path)
      const all = rows(t.agentId)
      if (path.includes('after=') && failAfter) return { status: 500, body: { success: false, error: { code: 'DOWN', message: 'down' } } }
      const data = path.includes('messageId=m3') ? { messages: [all[2]] } : path.includes('messageId=m1') ? { messages: [all[0]] }
        : path.includes('after=') ? { messages: all.slice(1) } : { state: { agents: [t.agent] } }
      return { status: 200, body: { success: true, data } }
    })
    const ask = (messageId: string) => t.ask({ action: 'message', tabId: 'tab', agentId: t.agentId, conversationId: 'lead', messageId }, owner) as Promise<{ ok?: boolean; value: { messages: Record<string, unknown>[] } }>
    expect((await ask('m3')).value.messages[0]).not.toHaveProperty('answered')
    expect(reads.some(path => path.includes('after='))).toBe(false)
    failAfter = true
    const failed = await ask('m1')
    expect(failed.ok).toBe(true)
    expect(failed.value.messages[0]).not.toHaveProperty('answered')
  })
})

describe('post --attach steps', () => {
  it('reads whether this post already went out with files, as the agent', async () => {
    const t = setup()
    const messageId = createHash('sha256').update(JSON.stringify(['tab', `agent:${t.agentId}`, 'op'])).digest('hex').slice(0, 24)
    vi.mocked(t.core.account.backend).mockImplementation(async (_method: string, path: string) => ({ status: 200, body: { success: true, data:
      path.includes('/messages?') ? { messages: [{ id: messageId, attachments: [{ id: 'f0' }] }] } : { state: { agents: [t.agent] } } } }))
    expect(await t.ask({ action: 'attachment', step: 'sent', tabId: 'tab', agentId: t.agentId, conversationId: 'lead', operationId: 'op' }, owner))
      .toEqual({ ok: true, value: { agentId: t.agentId, attachmentIds: ['f0'] } })
    expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab/conversations/lead/messages?asAgentId=${t.agentId}&messageId=${messageId}`, undefined)
    vi.mocked(t.core.account.backend).mockImplementation(async (_method: string, path: string) => ({ status: 200, body: { success: true, data:
      path.includes('/messages?') ? { messages: [] } : { state: { agents: [t.agent] } } } }))
    expect(await t.ask({ action: 'attachment', step: 'sent', tabId: 'tab', agentId: t.agentId, conversationId: 'lead', operationId: 'op' }, owner))
      .toEqual({ ok: true, value: { agentId: t.agentId, attachmentIds: null } })
  })
})

it('teaches agents to say when their work needs a person or is stuck', async () => {
  const t = setup()
  const help = (await t.ask({ action: 'help' }, owner)) as { help: { command: string; commands: Array<Record<string, unknown>> } }
  expect(help.help.commands.filter(c => c.type === 'work.status').map(c => c.status)).toEqual(['working', 'needs_human', 'blocked', 'done'])
  expect(help.help.command).toContain('needs_human')
})
