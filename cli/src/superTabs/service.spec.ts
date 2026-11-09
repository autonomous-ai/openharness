import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import type { CoreApi } from '../core/api.js'
import type { SaidOnCard } from './cards.js'
import { superTabService } from './service.js'
import { object } from './wire.js'
import { hostForm, swarmReply } from './fixtures/read/index.js'
import { HostFeed } from './hostFeed.js'

const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
import { SuperTabHostError, type SuperTabHost, type SuperTabHostOptions } from './host.js'

const owner = { local: true, owner: true }, visitor = { local: false, owner: false }
/** The backend's Lead rule: an agent leads a project when it leads that project's Lead conversation ('lead' before projects). */
const leads = (state: Record<string, unknown>, agentId: unknown) => {
  const ids = Array.isArray(state.projects) ? list(state.projects).map(p => p.leadConversationId) : ['lead']
  return list(state.conversations).some(c => ids.includes(c.id) && c.leadId === agentId)
}
/** This test's Swarm as the backend serves it: the host form lists [agent] on its machine (a Lead by the backend's rule), a read
 *  of the tab gets [state] by parts, and anything else gets [state] as the whole Swarm's read once did. */
const swarmData = (agent: Record<string, unknown>, path: string, state: Record<string, unknown> = { agents: [agent] }): unknown =>
  path.includes('/hosts/') ? hostForm([{ tabId: 'tab', agent, lead: leads(state, agent.id) }], { tabs: ['tab'] })
    : /^\/api\/super-tabs\/tab\/(parts|changes)/.test(path) ? swarmReply(path, state) : { state }
function setup(options: { prepareContribution?: typeof import('./contribution.js').prepareContribution; setMachineAgents?: typeof import('./contribution.js').setMachineAgents } = {}) {
  const agentId = createHash('sha256').update(JSON.stringify(['machine-1', 'native'])).digest('hex').slice(0, 24)
  const agent = { id: agentId, machineId: 'machine-1', harnessId: 'native' }
  const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => ({ status: 200, body: { success: true, data: swarmData(agent, path) } }))
  const core = fakeCore({ account: { backend: call }, agents: { byAgent: vi.fn(() => ({ agentId: 'native' }) as never) } })
  const start = vi.fn(), stop = vi.fn()
  const service = superTabService(core, { host: () => ({ machineId: 'machine-1', start, stop }) as unknown as SuperTabHost, ...options })
  return { ...service, call, core, agent, agentId, start, stop, ask: service.requests.super_tabs }
}
describe('restart role lookup through the service', () => {
  it('does not start the delivery loop when a personal session restarts', async () => {
    const host = vi.fn(() => ({ machineId: 'machine-1', start: vi.fn(), stop: vi.fn(), swarmRole: async () => null }) as never)
    const core = fakeCore({ account: { backend: vi.fn(async () => ({ status: 200, body: { data: hostForm([]) } })) } })
    const service = superTabService(core, { host })
    expect(await service.port.swarmRole('personal')).toBeNull()
    expect(await service.requests.super_tabs({ action: 'swarmRole', harnessId: 'personal' }, owner)).toEqual({ ok: true, role: null })
    expect(host).not.toHaveBeenCalled()
    service.port.stop()
  })
  it('answers the same current role in inline and process requests, for the owner only', async () => {
    const agent = { id: 'agent', machineId: 'machine-1', harnessId: 'old-native' }
    const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => ({ status: 200, body: { data:
      path.includes('/hosts/') ? hostForm([{ tabId: 'tab', agent }]) : swarmReply(path, { agents: [agent], conversations: [{ leadId: 'agent' }] }) } }))
    const service = superTabService(fakeCore({ account: { backend: call } }))
    expect(await service.port.swarmRole('old-native')).toEqual({ role: 'coordinator', mode: 'orchestration' })
    expect(await service.requests.super_tabs({ action: 'swarmRole', harnessId: 'old-native' }, owner)).toEqual({ ok: true, role: 'lead', mode: 'orchestration' })
    expect(await service.requests.super_tabs({ action: 'swarmRole', harnessId: 'old-native' }, visitor)).toMatchObject({ error: 'OWNER_REQUIRED' })
    call.mockRejectedValueOnce(new Error('Offline'))
    expect(await service.port.swarmRole('old-native')).toBeUndefined()
    service.port.stop()
  })
  // Import an agent (security review of #2783): whether any Swarm lists the harness here, for its owner only; an unreadable
  // roster answers no `listed`, which Desktop refuses on.
  it('says whether any Swarm lists a harness on this machine, for the owner only', async () => {
    const agent = { id: 'agent', machineId: 'machine-1', harnessId: 'kept' }
    const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => ({ status: 200, body: { data:
      path.includes('/hosts/') ? hostForm([{ tabId: 'tab', agent, stopRequested: true }])
        : swarmReply(path, { agents: [agent], conversations: [{ archived: true, agentIds: ['agent'] }] }) } }))
    const service = superTabService(fakeCore({ account: { backend: call } }))
    expect(await service.requests.super_tabs({ action: 'swarmListed', harnessId: 'kept' }, owner)).toEqual({ ok: true, listed: true })
    expect(await service.requests.super_tabs({ action: 'swarmListed', harnessId: 'personal' }, owner)).toEqual({ ok: true, listed: false })
    expect(await service.requests.super_tabs({ action: 'swarmListed', harnessId: 'kept' }, visitor)).toMatchObject({ error: 'OWNER_REQUIRED' })
    call.mockRejectedValueOnce(new Error('Offline'))
    expect(await service.requests.super_tabs({ action: 'swarmListed', harnessId: 'kept' }, owner)).toEqual({ ok: true })
    service.port.stop()
  })
  // Project instructions, phase 4 (decision 1): the process answers the core in the wire's values, which a core from before
  // role kinds reads too; a Reviewer's answer keeps its swarm-review file.
  it('answers the core\'s role lookup in the values every core reads', async () => {
    const agent = { id: 'agent', machineId: 'machine-1', harnessId: 'old-native', role: 'reviewer' }
    const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => ({ status: 200, body: { data:
      path.includes('/hosts/') ? hostForm([{ tabId: 'tab', agent }]) : swarmReply(path, { agents: [agent], conversations: [{ leadId: 'other', agentIds: ['agent'] }] }) } }))
    const service = superTabService(fakeCore({ account: { backend: call } }))
    expect(await service.port.swarmRole('old-native')).toEqual({ role: 'agent', fallback: 'review', mode: 'orchestration' })
    expect(await service.requests.super_tabs({ action: 'swarmRole', harnessId: 'old-native' }, owner)).toEqual({ ok: true, role: 'review', mode: 'orchestration' })
    service.port.stop()
  })
  // The second review of #2087: a Buddy is one by its owner field (backend buddies.ts), whether or not its chat is open.
  it('knows a Buddy by its owner field, even with its chat archived', async () => {
    const agent = { id: 'agent', machineId: 'machine-1', harnessId: 'buddy-native', buddyOf: { personId: 'person-1' } }
    const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => ({ status: 200, body: { data:
      path.includes('/hosts/') ? hostForm([{ tabId: 'tab', agent }]) : swarmReply(path, { agents: [agent], conversations: [{ id: 'chat', archived: true, agentIds: ['agent'] }] }) } }))
    const service = superTabService(fakeCore({ account: { backend: call } }))
    expect(await service.port.swarmRole('buddy-native')).toEqual({ role: 'buddy', mode: 'orchestration' })
    service.port.stop()
  })
  it('bounds an unavailable backend lookup without delaying restart indefinitely', async () => {
    vi.useFakeTimers()
    try {
      const core = fakeCore({ account: { backend: () => new Promise(() => {}) } })
      const service = superTabService(core)
      const read = service.port.swarmRole('old-native')
      await vi.advanceTimersByTimeAsync(3000)
      expect(await read).toBeUndefined()
      service.port.stop()
    } finally { vi.useRealTimers() }
  })
})

describe('five-part task commands', () => {
  const task = { goal: 'Save edits', changes: 'Persist drafts', constraints: 'No dependencies', owns: ['cli/src/superTabs'] }
  const brief = 'Goal:\nSave edits\n\nChanges:\nPersist drafts\n\nConstraints:\nNo dependencies\n\nOwns:\n- cli/src/superTabs'
  const checks = [{ description: 'Draft survives reconnect', independent: false }]
  const send = (t: ReturnType<typeof setup>, command: Record<string, unknown>) => t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'task-op', command }, owner)

  for (const type of ['conversation.create', 'work.define']) {
    const base = { type, ...(type === 'conversation.create' ? { title: 'Drafts' } : { conversationId: 'group' }) }
    // Project instructions, phase 4: no part is required here; a task missing one goes as the brief of those it has.
    it(`${type} sends a task missing a part, or with no checks, as written`, async () => {
      for (const [missing, invalid] of [
        ['Goal', { task: { ...task, goal: ' ' } }], ['Changes', { task: { ...task, changes: '' } }],
        ['Constraints', { task: { ...task, constraints: null } }], ['Owns', { task: { ...task, owns: [] } }],
      ] as const) {
        const t = setup()
        expect(await send(t, Object.assign({ ...base, task, checks }, invalid))).toMatchObject({ ok: true })
        const sent = (t.call.mock.calls.filter(c => c[0] === 'POST').at(-1)![2] as { command: Record<string, unknown> }).command
        expect(sent).not.toHaveProperty('task')
        expect(String(sent.brief)).not.toContain(`${missing}:`)
      }
      const none = setup()
      expect(await send(none, { ...base, task, checks: [] })).toMatchObject({ ok: true })
      expect(none.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'task-op', asAgentId: none.agentId, command: { ...base, task, brief, checks: [] } })
    })
    it(`${type} sends the complete template and renders its compatibility brief`, async () => {
      const t = setup()
      expect(await send(t, { ...base, brief: 'ignored', task: { ...task, goal: ' Save edits ', owns: [' cli/src/superTabs '] }, checks })).toMatchObject({ ok: true })
      expect(t.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'task-op', asAgentId: t.agentId, command: { ...base, task, brief, checks } })
    })
    it(`${type} retries an old backend's task refusal once using the same operation`, async () => {
      const t = setup(), original = t.call.getMockImplementation()!
      t.call.mockImplementation(async (...args) => args[0] === 'POST' && (args[2] as { command: { task?: unknown } }).command.task
        ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'command: Unrecognized key: "task"' } } } as never
        : original(...args))
      expect(await send(t, { ...base, task, checks })).toMatchObject({ ok: true })
      expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(2)
      expect(t.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'task-op', asAgentId: t.agentId, command: { ...base, brief, checks } })
    })
  }
  // A backend from before answers below (task #2929) refuses the field: the answer goes as a reply, which still settles it.
  it('sends an answer as a reply to a backend that refuses answers, once, with the same operation', async () => {
    const t = setup(), original = t.call.getMockImplementation()!
    t.call.mockImplementation(async (...args) => args[0] === 'POST' && (args[2] as { command: { answers?: unknown } }).command.answers
      ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'command: Unrecognized key: "answers"' } } } as never
      : original(...args))
    const post = { type: 'message.send', conversationId: 'lead', text: 'Done.', replyTo: null, answers: 'm1', recipientIds: [] }
    expect(await send(t, post)).toMatchObject({ ok: true })
    expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(2)
    expect(t.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'task-op', asAgentId: t.agentId,
      command: { type: 'message.send', conversationId: 'lead', text: 'Done.', replyTo: 'm1', recipientIds: [] } })
  })
  it('renders a task\'s review plan into its brief as the backend does', async () => {
    const t = setup()
    const review = { focus: ' Check revoked access first. ', reviews: 2 }
    expect(await send(t, { type: 'conversation.create', title: 'Drafts', task: { ...task, review }, checks })).toMatchObject({ ok: true })
    expect(t.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'task-op', asAgentId: t.agentId,
      command: { type: 'conversation.create', title: 'Drafts', task: { ...task, review }, checks,
        brief: `${brief}\n\nReview:\nCheck revoked access first.\nTwo independent reviews, each by a different Reviewer.` } })
  })
  it('tells the Lead an older server takes no review plan, and sends nothing more', async () => {
    const t = setup(), original = t.call.getMockImplementation()!
    t.call.mockImplementation(async (...args) => args[0] === 'POST'
      ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'command.task: Unrecognized key: "review"' } } } as never : original(...args))
    expect(await send(t, { type: 'work.define', conversationId: 'group', task: { ...task, review: { reviews: 2 } }, checks }))
      .toMatchObject({ error: 'REVIEW_PLAN_UNSUPPORTED', detail: expect.stringContaining('review focus in its constraints') })
    expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(1)
  })
  it('preserves other errors and never repeats a failed compatibility retry', async () => {
    for (const [status, code, message, count] of [
      [403, 'FORBIDDEN', 'Unrecognized key: "task"', 1], [400, 'VALIDATION_ERROR', 'Invalid title', 1],
      [503, 'BACKEND_UNAVAILABLE', 'Offline', 1], [400, 'VALIDATION_ERROR', 'Unrecognized key: "task"', 2],
    ] as const) {
      const t = setup(), original = t.call.getMockImplementation()!
      t.call.mockImplementation(async (...args) => args[0] === 'POST'
        ? { status, body: { success: false, error: { code, message } } } as never : original(...args))
      expect(await send(t, { type: 'work.define', conversationId: 'group', task, checks })).toMatchObject({ error: code, detail: message })
      expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(count)
    }
  })
  it('recovers a committed legacy receipt after a lost reply and backend upgrade', async () => {
    const t = setup(), original = t.call.getMockImplementation()!
    let upgraded = false, recorded: string | null = null
    t.call.mockImplementation(async (...args) => {
      if (args[0] !== 'POST') return original(...args)
      const body = args[2] as { command: Record<string, unknown> }
      if (!upgraded && body.command.task) return { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'command: Unrecognized key: "task"' } } }
      if (!recorded) { recorded = JSON.stringify(body); upgraded = true; throw new Error('Reply lost after commit') }
      return JSON.stringify(body) === recorded
        ? { status: 200, body: { success: true, data: { result: { conversationId: 'only-group' } } } }
        : { status: 409, body: { success: false, error: { code: 'OPERATION_REUSED', message: 'Choose a new operation ID for different content.' } } }
    })
    const command = { type: 'conversation.create', title: 'Drafts', task, checks }
    expect(await send(t, command)).toMatchObject({ error: 'SUPER_TAB_UNAVAILABLE' })
    expect(await send(t, command)).toMatchObject({ ok: true, value: { result: { conversationId: 'only-group' } } })
    expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(4)
    // A real content change must still fail even when its receipt is checked in legacy form.
    expect(await send(t, { ...command, title: 'Different work' })).toMatchObject({ error: 'OPERATION_REUSED' })
  })
  it('does not strip task fields from unrelated commands', async () => {
    const t = setup(), original = t.call.getMockImplementation()!
    t.call.mockImplementation(async (...args) => args[0] === 'POST'
      ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'command: Unrecognized key: "task"' } } }
      : original(...args))
    expect(await send(t, { type: 'message.send', task })).toMatchObject({ error: 'VALIDATION_ERROR' })
    expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(1)
  })
  // Project instructions, phase 4: the template says what a good task has; the CLI refuses none. An incomplete task goes as
  // its rendered brief, so an older backend that requires every part still takes it.
  it('takes a task as written', async () => {
    for (const type of ['conversation.create', 'work.define']) {
      const base = { type, ...(type === 'conversation.create' ? { title: 'Drafts' } : { conversationId: 'group' }) }
      const t = setup()
      expect(await send(t, { ...base, task: { goal: 'Save edits' }, checks: [] })).toMatchObject({ ok: true })
      expect(t.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'task-op', asAgentId: t.agentId,
        command: { ...base, brief: 'Goal:\nSave edits', checks: [] } })
      // The agent's own brief stays, before the parts it gave.
      const own = setup()
      expect(await send(own, { ...base, brief: 'Keep drafts.', task: { goal: ' Save edits ', owns: ['cli', ' '] }, checks })).toMatchObject({ ok: true })
      expect(own.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'task-op', asAgentId: own.agentId,
        command: { ...base, brief: 'Keep drafts.\n\nGoal:\nSave edits\n\nOwns:\n- cli', checks } })
      // A complete task, as today.
      const whole = setup()
      expect(await send(whole, { ...base, task, checks })).toMatchObject({ ok: true })
      expect(whole.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'task-op', asAgentId: whole.agentId,
        command: { ...base, task, brief, checks } })
    }
  })
  it('documents all five parts in both command examples', async () => {
    const t = setup(), answer = await t.ask({ action: 'help' }, owner) as { help: { commands: Array<Record<string, unknown>> } }
    for (const type of ['conversation.create', 'work.define']) {
      expect(answer.help.commands.find(c => c.type === type)).toMatchObject({ task: { goal: expect.any(String), changes: expect.any(String), constraints: expect.any(String), owns: expect.any(Array) }, checks: [expect.objectContaining({ description: expect.any(String) })] })
    }
  })
  it('rejects oversized task sections, ownership and compatibility briefs before sending', async () => {
    for (const invalid of [{ ...task, goal: 'x'.repeat(8001) }, { ...task, owns: Array(41).fill('path') },
      { ...task, owns: ['x'.repeat(4097)] }, { ...task, owns: Array(40).fill('x'.repeat(200)) }]) {
      const t = setup()
      expect(await send(t, { type: 'conversation.create', title: 'Drafts', task: invalid, checks })).toMatchObject({ error: 'INVALID_TASK' })
      expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(0)
    }
  })
})

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
// WS roadmap Phase 2a, the Lead's rule (2026-10-29): pushes can be missed, so a reconnect's host never trusts the old socket's
// word that the server pushes; it reads at once and each second until the new socket says so.
it('gives the host a new feed after a reconnect, one that has not heard the server push', async () => {
  const feeds: HostFeed[] = []
  const host = vi.fn((_core: CoreApi, machineId: string, given?: SuperTabHostOptions) => {
    feeds.push(given!.sources!.feed)
    return { machineId, start: vi.fn(), stop: vi.fn() } as unknown as SuperTabHost
  })
  const service = superTabService(fakeCore({ account: { backend: vi.fn() } }), { host })
  expect(await service.requests.super_tabs({ action: 'wake' }, owner)).toEqual({ ok: true })
  feeds[0]!.heard({ type: 'swarm_host_changed' })
  expect(feeds[0]!.pushing).toBe(true)
  service.port.disconnected()
  service.port.connected()
  expect(await service.requests.super_tabs({ action: 'wake' }, owner)).toEqual({ ok: true })
  expect(feeds).toHaveLength(2)
  expect(feeds[1]).not.toBe(feeds[0])
  expect(feeds[1]!.pushing).toBe(false)
  service.port.stop()
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
it('sets a machine\'s agents only for the person at this computer, and says what the number means', async () => {
  const setMachineAgents = vi.fn(async () => ({ ok: true, machineId: 'studio', maxAgents: 96, maximum: 96 }))
  const t = setup({ setMachineAgents })
  const ask = { action: 'setMachineAgents', tabId: 'tab', machineId: 'studio', maxAgents: 96 }
  for (const asker of [visitor, { local: false, owner: true, accountOwner: true }]) expect(await t.ask(ask, asker)).toEqual({ error: 'OWNER_REQUIRED' })
  expect(setMachineAgents).not.toHaveBeenCalled()
  for (const maxAgents of [0, 2.5, '96', 1025]) expect(await t.ask({ ...ask, maxAgents }, owner)).toMatchObject({ error: 'INVALID_REQUEST' })
  expect(await t.ask(ask, owner)).toEqual({ ok: true, machineId: 'studio', maxAgents: 96, maximum: 96 })
  expect(setMachineAgents).toHaveBeenCalledWith(t.core, { tabId: 'tab', machineId: 'studio', maxAgents: 96 })
  const help = (await t.ask({ action: 'help' }, owner) as { help: Record<string, string> }).help
  expect(help.setAgents).toContain('how many Swarm agents may run on that machine at once')
})
describe('a machine offered with more than 16 agents', () => {
  const contribute = (maxAgents: number) => ({ action: 'backend', method: 'POST', path: '/api/super-tabs/tab/commands', body: { operationId: 'add-studio',
    command: { type: 'machine.contribute', machineId: 'studio', name: 'Studio', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents } } })
  // What a server from before 1024 answers (backend middlewares/validation.ts, zod 4's message for .max(16)).
  const refuse = (message: string) => ({ status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message } } })
  it('is offered with 16 when an older server refuses more, under the same operation', async () => {
    const t = setup()
    t.call.mockResolvedValueOnce(refuse('command.maxAgents: Too big: expected number to be <=16'))
    t.call.mockResolvedValueOnce({ status: 200, body: { success: true, data: { result: { machineId: 'studio' } } } })
    expect(await t.ask(contribute(96), owner)).toEqual({ ok: true, value: { result: { machineId: 'studio' } } })
    expect(t.call.mock.calls.map(([method, path, body]) => [method, path, object(object(body).command).maxAgents, object(body).operationId])).toEqual([
      ['POST', '/api/super-tabs/tab/commands', 96, 'add-studio'],
      ['POST', '/api/super-tabs/tab/commands', 16, 'add-studio'],
    ])
  })
  it('keeps every other refusal as the server gave it', async () => {
    const t = setup()
    t.call.mockResolvedValueOnce(refuse('command.cwd: Use a full folder path, such as /home/me/work or C:\\Users\\me\\work.'))
    expect(await t.ask(contribute(96), owner)).toMatchObject({ error: 'VALIDATION_ERROR', status: 400 })
    t.call.mockResolvedValueOnce(refuse('command.maxAgents: Too big: expected number to be <=1024'))
    expect(await t.ask(contribute(2048), owner)).toMatchObject({ error: 'VALIDATION_ERROR', status: 400 })
    t.call.mockResolvedValueOnce(refuse('command.maxAgents: Too big: expected number to be <=16'))
    expect(await t.ask(contribute(16), owner)).toMatchObject({ error: 'VALIDATION_ERROR', status: 400 })
    expect(t.call).toHaveBeenCalledTimes(3)
  })
})
// Project instructions, phase 4: what an agent may do is the server's to say, and it now lets any agent of the project tag,
// ask and tell; the help names no rule, floor or step-up the server dropped.
it('gives every agent the same help, with no rule the server dropped', async () => {
  const t = setup()
  const help = (await t.ask({ action: 'help', tabId: 'tab', agentId: t.agentId }, owner) as { help: Record<string, unknown> }).help
  expect(String(help.post)).toContain('--mention')
  // Task #2924: an agent with work in the project posts in its project chat itself, joining nobody there (#2207).
  expect(String(help.post)).toContain('In the project chat, an agent with a task or step in the project posts and reacts without joining it, and a person\'s answer to its line reaches it; --to there adds no agent, so name only the PM.')
  // Task #2963: an unnamed post no longer reaches the PM.
  expect(String(help.post)).toContain('With no --to or @Name it reaches no agent, except the agent a reply answers and, in a task or step, its assignee. Your status tells the PM your work: never post it results, verdicts or acknowledgements.')
  expect(String(help.post)).not.toContain('your post reaches the PM')
  expect((help.commands as Array<{ type: string }>).map(c => c.type)).toEqual(expect.arrayContaining(['decision.ask']))
  // Task #4547: a person's chat with their own agent is theirs alone; no help text teaches the retired private line.
  expect(JSON.stringify(help)).not.toContain('person.tell')
  const dropped = /prefer stop|agree an order|Only its project's Lead|without a routeDecisionId is refused|hard rule|top tier|steps the task up|"name":"Builder"|role "reviewer"/i
  expect(JSON.stringify(help)).not.toMatch(dropped)
  expect(Object.values(help).filter(v => typeof v === 'string').join('\n')).not.toMatch(dropped)
  // Help asked with no agent behind it is the same.
  expect((await t.ask({ action: 'help' }, owner) as { help: unknown }).help).toEqual(help)
})
it('sends no refusal the server dropped', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const sources = readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  expect(sources.length).toBeGreaterThan(20)
  expect(sources.filter(f => /'(LEAD_REQUIRED|TASK_REQUIRED)'/.test(readFileSync(join(dir, f), 'utf8')))).toEqual([])
})
it('documents how a lead shares its project repository for other machines', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { commands: Array<Record<string, unknown>> } }
  expect(answer.help.commands).toContainEqual({ type: 'project.repository', projectId: 'PROJECT', repositoryUrl: 'https://github.com/OWNER/REPOSITORY' })
})
// Project instructions, phase 4: project.skills and rule.set leave the help (agents change the instructions); tab.tidy is still
// the Swarm owner's setting, now about archiving alone.
it('tells how the instructions are changed, and how the Swarm\'s tidying is turned off or on at its owner\'s own request', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { command: string; commands: Array<Record<string, unknown>> } }
  const types = answer.help.commands.map(c => c.type)
  expect(types).not.toContain('project.skills')
  expect(types).not.toContain('rule.set')
  expect(types).not.toContain('rule.remove')
  expect(answer.help.commands).toContainEqual(expect.objectContaining({ type: 'instructions.save', projectId: 'PROJECT', askedBy: 'PERSON' }))
  expect(answer.help.commands).toContainEqual({ type: 'tab.tidy', enabled: false, askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } })
  expect(answer.help.command).toContain('tab.tidy turns off, or back on, the Swarm\'s tidying: finished groups archive once their pull requests are merged or closed. The Swarm owner does, or the PM passing on the owner\'s own chat message, with askedIn naming it.')
})
// Task #3117: a task is created with its priority, and the PM or a person changes it.
it('asks for a task\'s priority on conversation.create, says what P0 to P3 mean, and how work.priority changes it', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { command: string; mine: string; commands: Array<Record<string, unknown>> } }
  expect(answer.help.mine).toContain('one line per task, P0 first (number, priority, title,')
  const creates = answer.help.commands.filter(c => c.type === 'conversation.create')
  expect(creates.find(c => !('step' in c))).toMatchObject({ title: 'Outcome', priority: 'P0|P1|P2|P3', requesterId: 'PERSON' })
  // A step carries no priority.
  expect(creates.find(c => 'step' in c)).not.toHaveProperty('priority')
  expect(answer.help.commands).toContainEqual({ type: 'work.priority', conversationId: 'GROUP', priority: 'P0' })
  // Task #3389: an agent\'s task needs its goal, a check, a priority and who asked, or a reason nobody did.
  expect(answer.help.command).toContain('TASK_CONTRACT_MISSING')
  expect(answer.help.command).toContain('noRequesterReason')
  expect(answer.help.command).not.toContain('checks may be empty')
  expect(answer.help.command).toContain('A task\'s priority is P0 (hotfix: something shipped is broken, loses data, or stops people\'s or agents\' work), P1 (needed by users soon), P2 (planned goal) or P3 (tools, docs or process): give one on conversation.create (a person\'s without one gets P2); only the PM or a person sets P0, or changes a priority later with work.priority.')
})
it('tells the Lead that start works only on a machine in the Swarm\'s Machines list', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { start: string } }
  expect(answer.help.start).toContain('create one agent in a conversation on a machine in this Swarm\'s Machines list; to use another machine, a person adds it to the Swarm first.')
  expect(answer.help.start).toContain('Repeat exactly after an interruption')
})
// Project instructions, phase 4: an agent starts in a role named by the instructions (roleName), never a kind.
it('explains starting an agent in a role of the instructions', async () => {
  const answer = await setup().ask({ action: 'help' }, owner) as { help: { status: string; start: string; command: string; startRequest: Record<string, unknown> } }
  expect(answer.help.start).toContain('Set roleName to the role the project\'s instructions give the agent')
  expect(answer.help.startRequest).toMatchObject({ roleName: 'ROLE' })
  expect(JSON.stringify(answer.help)).not.toMatch(/Custom skills|roleId/)
})
// Dee, 10-31: the Leads (Product Managers) chat is gone; no help points an agent at it.
it('explains to the PM other projects\' work, and points nobody at the removed Leads conversation', async () => {
  const answer = await setup().ask({ action: 'help' }, owner) as { help: Record<string, unknown> }
  expect(answer.help.status).toContain('The PM\'s status also lists otherProjectsWork: the active work of the Swarm\'s other projects')
  expect(answer.help).not.toHaveProperty('leads')
  expect(JSON.stringify(answer.help)).not.toMatch(/Leads conversation|leadsConversationId/)
})
it('resolves a native caller to its exact contribution and rechecks it before every agent command', async () => {
  const t = setup()
  expect(await t.ask({ action: 'status', tabId: 'tab', harnessId: 'native' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab/parts?asAgentId=${t.agentId}`, undefined)
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

// Leads see each other's work (spec 2026-10-23): a Lead's status carries other projects' active work, in the backend's own
// fields and nothing more; an agent that leads nothing never sees it. Nobody reads the removed Leads conversation (10-31).
describe('other projects\' work in status', () => {
  const work = { conversationId: 'docs-roster', projectName: 'Docs', title: 'Roster', owns: ['desktop/lib/super_tabs'], status: 'review',
    agentName: 'Builder', pr: 'https://github.com/example/project/pull/12' }
  /** A Swarm whose project Pilot is led, through its Lead conversation, by [leadId]; [groups] are further conversations. */
  const swarm = (t: ReturnType<typeof setup>, leadId: string | null, groups: Record<string, unknown>[] = [], legacy = false) => {
    const lead = legacy ? 'lead' : 'pilot'
    const state = { agents: [t.agent], leadsConversationId: 'leads', ...(legacy ? {} : { projects: [{ id: 'pilot', name: 'Pilot', leadConversationId: 'pilot' }] }),
      conversations: [{ id: lead, leadId, agentIds: [t.agentId] }, ...groups, { id: 'leads', kind: 'leads', title: 'Leads', leadId: null, agentIds: [t.agentId] }],
      otherProjectsWork: [{ ...work, assignmentId: 'internal', brief: 'The whole brief' }] }
    t.call.mockImplementation(async (_method, path) => ({ status: 200, body: { success: true, data: swarmData(t.agent, path, state) } }))
  }
  const status = async (t: ReturnType<typeof setup>) => object(object(object(await t.ask({ action: 'status', tabId: 'tab', agentId: t.agentId }, owner)).value).state)

  it('shows a Lead each other project\'s active work in the agreed fields alone', async () => {
    const t = setup()
    swarm(t, t.agentId)
    const state = await status(t)
    expect(state.otherProjectsWork).toEqual([work])
    // Dee, 10-31: the Leads conversation is removed; a Lead no longer reads it either, even from an older server.
    expect(state).not.toHaveProperty('leadsConversationId')
    expect(list(state.conversations).map(c => c.id)).toEqual(['pilot'])
  })

  it('shows the Lead of a Swarm from before projects that work too', async () => {
    const t = setup()
    swarm(t, t.agentId, [], true)
    expect((await status(t)).otherProjectsWork).toEqual([work])
  })

  // The review of #1657: the backend's Lead is its project's Lead conversation's. A former Lead still named on an older
  // work group is not one.
  it('shows a former Lead that still leads an older work group neither that work nor the Leads conversation', async () => {
    const t = setup()
    swarm(t, 'new-lead', [{ id: 'older-work', projectId: 'pilot', leadId: t.agentId, agentIds: [t.agentId] }])
    const state = await status(t)
    expect(state).not.toHaveProperty('otherProjectsWork')
    expect(state).not.toHaveProperty('leadsConversationId')
    expect(list(state.conversations).map(c => c.id)).toEqual(['pilot', 'older-work'])
  })

  it('shows an agent that leads nothing neither that work nor the Leads conversation, whatever the server sends', async () => {
    const t = setup()
    swarm(t, 'another-lead')
    const state = await status(t)
    expect(state).not.toHaveProperty('otherProjectsWork')
    expect(state).not.toHaveProperty('leadsConversationId')
    expect(list(state.conversations).map(c => c.id)).toEqual(['pilot'])
  })

  // Task #3117: a task's priority reaches the PM and every other agent as the backend sends it.
  it('keeps a task\'s priority, for a Lead and for any other agent', async () => {
    for (const leadId of ['self', 'another-lead']) {
      const t = setup()
      swarm(t, leadId === 'self' ? t.agentId : leadId, [{ id: 'hotfix', projectId: 'pilot', number: 7, title: 'Checkout fails', priority: 'P0', agentIds: [] }])
      expect(list((await status(t)).conversations).find(c => c.id === 'hotfix'), leadId).toMatchObject({ priority: 'P0' })
    }
  })
})

// Security review of #2087: a harness that names another agent with --agent spoke as it (a Buddy as its Builder). The CLI
// now says which harness asks, and the agent it names must be that harness's own.
it('refuses a harness that names another agent, for posts, commands, work status and message reads, and serves its own', async () => {
  const t = setup()
  const post = { type: 'message.send', conversationId: 'lead', text: 'Ready', replyTo: null, recipientIds: [] }
  const status = { type: 'work.status', conversationId: 'g1', assignmentId: 'a1', status: 'done', result: 'r' }
  const asks = [{ action: 'command', operationId: 'op-1', command: post }, { action: 'command', operationId: 'op-2', command: status },
    { action: 'message', conversationId: 'lead', messageId: 'old-question' }, { action: 'messages', conversationId: 'lead' }]
  for (const ask of asks) {
    t.call.mockClear()
    expect(await t.ask({ ...ask, tabId: 'tab', agentId: t.agentId, harnessId: 'buddy-pane' }, owner)).toEqual({
      error: 'AGENT_MISMATCH', detail: 'This harness may speak only as its own Swarm agent. Run the command without --agent, or with its own id.' })
    expect(t.call.mock.calls.filter(([method]) => method === 'POST')).toEqual([])
    expect(await t.ask({ ...ask, tabId: 'tab', agentId: t.agentId, harnessId: 'native' }, owner)).toMatchObject({ ok: true })
  }
})

// Second security review of #2087: from a Buddy's pane, --machine sent an agent's request to the owner's other Mac, where no
// pane was known and the agent it named was served. An agent speaks to its own computer's Harness alone.
it('refuses every agent request that came over the link from another computer, whatever it names', async () => {
  const t = setup()
  const relayed = { local: false, owner: true, accountOwner: true, machine: { machineId: 'studio', label: 'Studio' } }
  const post = { type: 'message.send', conversationId: 'lead', text: 'Ready', replyTo: null, recipientIds: [] }
  for (const ask of [{ action: 'status' }, { action: 'command', operationId: 'op', command: post }, { action: 'message', conversationId: 'lead', messageId: 'm' }]) {
    t.call.mockClear()
    for (const who of [{ agentId: t.agentId }, { harnessId: 'native' }, {}]) {
      expect(await t.ask({ ...ask, tabId: 'tab', ...who }, relayed)).toEqual({ error: 'AGENT_LOCAL_ONLY',
        detail: 'An agent speaks to the Swarm through its own computer\'s Harness only, not through another machine.' })
    }
    expect(t.call).not.toHaveBeenCalled()
  }
  // Help reads nothing of the Swarm and stays the plain help.
  expect(await t.ask({ action: 'help', tabId: 'tab', agentId: t.agentId }, relayed)).toMatchObject({ ok: true, help: { status: expect.any(String) } })
})

// The second review: a Buddy is known from this computer's own launch record (start.ts starts it with the Swarm role buddy,
// and core/agents/create.ts saves it on the session), not from a server read that missed its deadline under load.
describe('whether a harness is a Buddy', () => {
  const sessions = (rows: Record<string, unknown>[]) => {
    const t = setup()
    vi.mocked(t.core.agents.byAgent).mockImplementation(id => rows.find(row => row.agentId === id) as never)
    vi.mocked(t.core.agents.live).mockReturnValue(rows as never)
    return t
  }
  it('answers from the launch record alone, asking the server nothing', async () => {
    const t = sessions([{ agentId: 'buddy', swarmSkill: { role: 'buddy', key: 'k' } }, { agentId: 'builder', swarmSkill: { role: 'agent', key: 'k' } },
      { agentId: 'person' }])
    t.call.mockClear()
    expect(await t.ask({ action: 'buddyCheck', harnessId: 'buddy' }, owner)).toEqual({ ok: true, buddy: true })
    expect(await t.ask({ action: 'buddyCheck', harnessId: 'builder' }, owner)).toEqual({ ok: true, buddy: false })
    expect(await t.ask({ action: 'buddyCheck', harnessId: 'person' }, owner)).toEqual({ ok: true, buddy: false })
    expect(await t.ask({ action: 'buddyCheck', harnessId: 'gone' }, owner)).toEqual({ ok: true, buddy: false })
    // Without a harness: whether this computer runs a Buddy at all (Windows, which cannot check a pane, refuses on it).
    expect(await t.ask({ action: 'buddyCheck' }, owner)).toEqual({ ok: true, buddiesHere: true })
    expect(t.call).not.toHaveBeenCalled()
    expect(await sessions([{ agentId: 'person' }]).ask({ action: 'buddyCheck' }, owner)).toEqual({ ok: true, buddiesHere: false })
  })
  it('asks the server about a harness an agent started with no Swarm record, as one more reason to refuse only', async () => {
    const t = sessions([{ agentId: 'native', startedBy: 'agent' }])
    Object.assign(t.agent, { buddyOf: { personId: 'person-1' } })
    expect(await t.ask({ action: 'buddyCheck', harnessId: 'native' }, owner)).toEqual({ ok: true, buddy: true })
    // The server unreachable: no reason to refuse.
    t.call.mockRejectedValue(new Error('Offline'))
    expect(await t.ask({ action: 'buddyCheck', harnessId: 'native' }, owner)).toEqual({ ok: true, buddy: false })
  })
  it('answers this computer\'s own processes only', async () => {
    const t = sessions([{ agentId: 'buddy', swarmSkill: { role: 'buddy', key: 'k' } }])
    expect(await t.ask({ action: 'buddyCheck', harnessId: 'buddy' }, { local: false, owner: true, accountOwner: true })).toEqual({ error: 'OWNER_REQUIRED' })
  })
})

it('resolves a replacement terminal to the original stable member', async () => {
  const t = setup()
  t.agent.harnessId = 'replacement'
  expect(await t.ask({ action: 'status', tabId: 'tab', harnessId: 'replacement' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab/parts?asAgentId=${t.agentId}`, undefined)
  expect(await t.ask({ action: 'status', tabId: 'tab', harnessId: 'native' }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
})

it('tells which branch a started agent works from, and how to choose another', async () => {
  const t = setup()
  const help = (await t.ask({ action: 'help' }, owner)).help as { start: string; startRequest: Record<string, unknown>; commands: unknown[] }
  expect(help.start).toContain('default branch, fetched first')
  expect(help.start).toContain('branchRef')
  expect(help.startRequest).toMatchObject({ worktree: true, branchRef: 'refs/remotes/origin/BASE_BRANCH' })
  // The template asks for memory and disk, not a CPU reading: one busy sample would refuse a start the route admits.
  expect(help.startRequest.requirements).toMatchObject({ memoryBytes: 2147483648, diskBytes: 10737418240, maxCpuPercent: 100 })
  // A linked group (a review) is opened with reviewOf; the agent's role is the instructions' (roleName), never a kind.
  expect(help.commands).toContainEqual(expect.objectContaining({ type: 'conversation.create', reviewOf: 'GROUP' }))
  expect(help.start).toContain('roleName')
  expect(help.start).not.toContain('"reviewer"')
})

it('keeps host capacity separate from account authority and closes it on disconnect or identity change', async () => {
  const core = fakeCore()
  const reserve = vi.fn(async () => ({ ok: true, reservationId: 'native-creation-id' }))
  const observe = vi.fn(async () => ({ ok: true, released: true }))
  const giveBack = vi.fn(async () => ({ ok: true, reservationId: 'native-creation-id', returned: true }))
  const stop = vi.fn(), factory = vi.fn(() => ({ reserve, observe, giveBack, ended: vi.fn(), creationOf: vi.fn(() => null), stop }))
  const service = superTabService(core, { reservations: factory })
  const closed = new AbortController().signal
  expect(factory).not.toHaveBeenCalled()
  expect(await service.requests.super_tabs({ action: 'reserveCapacity', creationId: 'native-creation-id' }, visitor, closed)).toMatchObject({ ok: true })
  expect(reserve).toHaveBeenCalledWith({ action: 'reserveCapacity', creationId: 'native-creation-id' }, closed)
  expect(await service.requests.super_tabs({ action: 'observeCapacity', creationId: 'native-creation-id' }, visitor)).toMatchObject({ released: true })
  expect(await service.requests.super_tabs({ action: 'returnCapacity', creationId: 'native-creation-id' }, visitor, closed)).toMatchObject({ returned: true })
  expect(giveBack).toHaveBeenCalledWith('native-creation-id', closed)
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

// Issue #2989: a start the Swarm failed gives its reservation back at once. Only this machine's own host, which read that
// verdict from the Swarm, may say so: a relayed caller with machine access could otherwise free memory still starting.
it('ends a failed start\'s reservation only for a caller on this machine', async () => {
  const core = fakeCore()
  const ended = vi.fn(async () => ({ ok: true, reservationId: 'native-creation-id', returned: true }))
  const factory = vi.fn(() => ({ reserve: vi.fn(), observe: vi.fn(), giveBack: vi.fn(), ended, creationOf: vi.fn(() => null), stop: vi.fn() }))
  const service = superTabService(core, { reservations: factory })
  const closed = new AbortController().signal
  expect(await service.requests.super_tabs({ action: 'endCapacity', creationId: 'native-creation-id' }, visitor, closed)).toEqual({ error: 'OWNER_REQUIRED' })
  expect(ended).not.toHaveBeenCalled()
  expect(await service.requests.super_tabs({ action: 'endCapacity', creationId: 'native-creation-id' }, { local: true, owner: false }, closed))
    .toMatchObject({ ok: true, returned: true })
  expect(ended).toHaveBeenCalledWith('native-creation-id', closed)
})

it('gives the host this machine\'s record of the Swarm starts, to close a session the backend ends', async () => {
  const core = fakeCore()
  const creationOf = vi.fn((harnessId: string) => harnessId === 'harness' ? 'super-0123456789abcdef' : null)
  const factory = vi.fn(() => ({ reserve: vi.fn(), observe: vi.fn(), giveBack: vi.fn(), ended: vi.fn(), creationOf, stop: vi.fn() }))
  let options: SuperTabHostOptions = {}
  const host = vi.fn((_core: unknown, _machine: string, given: SuperTabHostOptions) => {
    options = given
    return { machineId: 'machine-1', start: vi.fn(), stop: vi.fn() } as unknown as SuperTabHost
  })
  const service = superTabService(core, { reservations: factory, host })
  expect(await service.requests.super_tabs({ action: 'wake' }, owner)).toEqual({ ok: true })
  expect(options.startReceipt?.('harness')).toBe('super-0123456789abcdef')
  expect(options.startReceipt?.('another')).toBeNull()
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

// The route is gone (the plan with it): no action reads its context, history, machine rules or CI load, and Jev is long gone.
it('has no route actions: each is refused and nothing of the routing is read', async () => {
  const t = setup()
  for (const action of ['routeContext', 'routeHistory', 'machineRules', 'ciLoad', 'routeJev']) {
    expect(await t.ask({ action, tabId: 'tab', harnessId: 'native', conversationId: 'g1', projectId: 'lead' }, owner)).toEqual({ error: 'INVALID_REQUEST' })
  }
  expect(t.call).not.toHaveBeenCalledWith('GET', expect.stringMatching(/routing-policy|route-decisions|machine-rules|ci-load/), undefined)
  expect(vi.mocked(t.core.account.backend)).not.toHaveBeenCalledWith('POST', '/api/route/jev', expect.anything())
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
      data: path.includes('/messages') ? { messages: rows(t.agentId), next: null } : swarmData(t.agent, path) } }))
    const value = (await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'lead' }, owner) as { value: { messages: Record<string, unknown>[] } }).value
    expect(value.messages.map(m => m.answered)).toEqual([true, false, undefined, undefined, false])
    // A person's email is passed as the backend sent it.
    expect((value.messages[0]!.author as { name: string }).name).toBe('sam@example.com')
  })
  // An answer right below a message settles the agent's delivery and has no replyTo (task #2929): its delivery says it was answered.
  it('marks a message answered when the caller\'s delivery of it was answered, as by an answer right below it', async () => {
    const t = setup()
    const delivery = (status: string) => [{ id: 'd1', agentId: t.agentId, status }, { id: 'd2', agentId: 'someone-else', status: 'answered' }]
    const feed = [
      { id: 'q1', sequence: 1, author: person, recipientIds: [t.agentId], replyTo: null, deliveries: delivery('answered') },
      { id: 'q2', sequence: 2, author: person, recipientIds: [t.agentId], replyTo: null, deliveries: delivery('delivered') },
      { id: 'a1', sequence: 3, author: { kind: 'agent', id: t.agentId, name: 'Lead' }, recipientIds: [], replyTo: null },
    ]
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => ({ status: 200, body: { success: true,
      data: path.includes('/messages') ? { messages: feed, next: null } : swarmData(t.agent, path) } }))
    const value = (await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'lead' }, owner) as { value: { messages: Record<string, unknown>[] } }).value
    expect(value.messages.map(m => m.answered)).toEqual([true, false, undefined])
  })
  it('names the thread root on each thread reply only, so an agent reading one feed sees which thread a reply is in', async () => {
    const t = setup()
    const feed = [
      { id: 'r1', sequence: 1, author: person, recipientIds: [], replyTo: null, thread: 'r1' },
      { id: 'r2', sequence: 2, author: person, recipientIds: [t.agentId], replyTo: 'r1', thread: 'r1' },
      { id: 'r3', sequence: 3, author: person, recipientIds: [], replyTo: 'old', thread: 'r3' },
      { id: 'r4', sequence: 4, author: person, recipientIds: [], replyTo: null, thread: null },
    ]
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => ({ status: 200, body: { success: true,
      data: path.includes('/messages') ? { messages: feed, next: null, threads: [{ id: 'r1', replies: 1 }] } : swarmData(t.agent, path) } }))
    const value = (await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'lead' }, owner) as
      { value: { messages: Record<string, unknown>[]; threads: unknown[] } }).value
    expect(value.messages.map(m => m.thread)).toEqual([undefined, 'r1', undefined, undefined])
    expect(value.messages.map(m => 'thread' in m)).toEqual([false, true, false, false])
    expect(value.threads).toEqual([{ id: 'r1', replies: 1 }])
  })
  it('reads the later messages of one exact message to tell whether it was answered', async () => {
    const t = setup()
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => {
      const all = rows(t.agentId)
      const data = path.includes('messageId=m1') ? { messages: [all[0]] } : path.includes('after=1') ? { messages: all.slice(1) } : swarmData(t.agent, path)
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
        : path.includes('after=') ? { messages: all.slice(1) } : swarmData(t.agent, path)
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
      path.includes('/messages?') ? { messages: [{ id: messageId, attachments: [{ id: 'f0' }] }] } : swarmData(t.agent, path) } }))
    expect(await t.ask({ action: 'attachment', step: 'sent', tabId: 'tab', agentId: t.agentId, conversationId: 'lead', operationId: 'op' }, owner))
      .toEqual({ ok: true, value: { agentId: t.agentId, attachmentIds: ['f0'] } })
    expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab/conversations/lead/messages?asAgentId=${t.agentId}&messageId=${messageId}`, undefined)
    vi.mocked(t.core.account.backend).mockImplementation(async (_method: string, path: string) => ({ status: 200, body: { success: true, data:
      path.includes('/messages?') ? { messages: [] } : swarmData(t.agent, path) } }))
    expect(await t.ask({ action: 'attachment', step: 'sent', tabId: 'tab', agentId: t.agentId, conversationId: 'lead', operationId: 'op' }, owner))
      .toEqual({ ok: true, value: { agentId: t.agentId, attachmentIds: null } })
  })
})

it('teaches agents to say when their work needs a person or is stuck', async () => {
  const t = setup()
  const help = (await t.ask({ action: 'help' }, owner)) as { help: { command: string; commands: Array<Record<string, unknown>> } }
  expect(help.help.commands.filter(c => c.type === 'work.status').map(c => c.status)).toEqual(['working', 'needs_human', 'needs_human', 'blocked', 'done'])
  expect(help.help.command).toContain('needs_human')
})

it('says a server from before rules does not support them, and passes a malformed rule\'s refusal through', async () => {
  const t = setup()
  const refuse = (message: string) => t.call.mockImplementation(async (...args: unknown[]) => args[0] === 'POST'
    ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message } } } as never
    : { status: 200, body: { success: true, data: swarmData(t.agent, args[1] as string) } })
  const send = (command: object) => t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'rule', command }, owner)
  refuse("command.type: Invalid discriminator value. Expected 'machine.contribute'")
  expect(await send({ type: 'rule.set', rule: { kind: 'preferIdle' }, text: 'Idle first.' })).toEqual({ error: 'RULES_UNSUPPORTED', detail: 'This Swarm\'s server does not support rules yet.' })
  expect(await send({ type: 'rule.remove', ruleId: 'r' })).toMatchObject({ error: 'RULES_UNSUPPORTED' })
  refuse('command.rule.effort: Invalid option')
  expect(await send({ type: 'rule.set', rule: { kind: 'minEffort', effort: 'huge' }, text: 'x' })).not.toMatchObject({ error: 'RULES_UNSUPPORTED' })
})

// Project instructions, phase 4: no build, review or grid rule is the help's, and the route is no part of it.
it('offers every agent no route and no rule command', async () => {
  const help = (await setup().ask({ action: 'help' }, owner)).help as { commands: Array<{ type: string }> }
  expect(help).not.toHaveProperty('route')
  expect(help.commands.map(c => c.type)).not.toContain('rule.set')
})

it('documents finished worker decisions and explains an older backend without release support', async () => {
  const t = setup()
  const help = (await t.ask({ action: 'help' }, owner)).help as { commands: unknown[]; release: string }
  expect(help.commands).toContainEqual({ type: 'agent.release', agentId: 'AGENT', decision: 'keep|stop' })
  expect(help.commands).toContainEqual(expect.objectContaining({ type: 'work.cancel', assignmentId: 'current' }))
  expect(help.release).toContain('agent.release records keep, or requests stop, for an agent whose work ended')
  expect(help.release).not.toContain('prefer stop')
  t.call.mockImplementation(async (...args: unknown[]) => args[0] === 'POST'
    ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } } } as never
    : { status: 200, body: { success: true, data: swarmData(t.agent, args[1] as string) } })
  const reply = await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'release', command: { type: 'agent.release', agentId: 'worker', decision: 'stop' } }, owner)
  expect(reply).toMatchObject({ detail: 'This backend does not support releasing Builders yet. Update the backend and try again.' })
})

describe('the Swarm cards the devices ask for', () => {
  function withCards() {
    const cards = { want: vi.fn(), open: vi.fn(), side: vi.fn(), threadLeave: vi.fn((..._a: unknown[]): { tabId: string; conversationId: string } | null => null), say: vi.fn(async (): Promise<SaidOnCard> => ({ said: true })), worker: vi.fn((machineId: string, harnessId: string) => machineId === 'm2' && harnessId === 'h-r1'), recap: vi.fn(async (tabId: string, leadId: string) => ({ tabId, leadId, text: 'Shipped', at: 5, none: false })), onCards: undefined as unknown, onRecap: undefined as unknown }
    const superTabs = { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(), screen: vi.fn(), input: vi.fn(), inputIfScreen: vi.fn() }
    const core = fakeCore({ superTabs })
    const make = vi.fn(() => cards as never)
    const service = superTabService(core, { cards: make })
    return { cards, superTabs, make, core, ask: service.requests.super_tabs, port: service.port }
  }
  it('starts and stops the reader as a capable Pro comes and goes, and hands what it reads to the core', async () => {
    const t = withCards()
    expect(await t.ask({ action: 'cardsWanted', on: true }, owner)).toEqual({ ok: true })
    expect(t.cards.want).toHaveBeenLastCalledWith(true, [], null)
    expect(await t.ask({ action: 'cardsWanted', on: true, include: ['s1', 'bad id', 'x'.repeat(48), 7] }, owner)).toEqual({ ok: true })
    expect(t.cards.want).toHaveBeenLastCalledWith(true, ['s1'], null)
    expect(await t.ask({ action: 'cardsWanted', on: false }, owner)).toEqual({ ok: true })
    expect(t.cards.want).toHaveBeenLastCalledWith(false, [], null)
    // One reader for the machine, whose answers go to the core.
    expect(t.make).toHaveBeenCalledOnce()
    ;(t.cards.onCards as (items: unknown[]) => void)([])
    ;(t.cards.onRecap as (recap: unknown) => void)({ tabId: 't1' })
    expect(t.superTabs.cards).toHaveBeenCalledWith([])
    expect(t.superTabs.cardRecap).toHaveBeenCalledWith({ tabId: 't1' })
    // The service going away stops the polling; the next ask makes a new reader.
    t.port.stop()
    expect(t.cards.want).toHaveBeenLastCalledWith(false)
    await t.ask({ action: 'cardsWanted', on: true }, owner)
    expect(t.make).toHaveBeenCalledTimes(2)
    // A different machine id (the daemon was set up again) is a different reader, and the old one stops.
    vi.spyOn(t.core.daemon, 'machineId').mockReturnValue('machine-2')
    await t.ask({ action: 'cardsWanted', on: true }, owner)
    expect(t.make).toHaveBeenCalledTimes(3)
  })
  it('reads one Lead\'s recap and notes which one the Pro has open', async () => {
    const t = withCards()
    expect(await t.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1' }, owner)).toEqual({ ok: true, tabId: 't1', leadId: 'l1', text: 'Shipped', at: 5, none: false })
    expect(await t.ask({ action: 'cardOpen', session: 's1', tabId: 't1', leadId: 'l1' }, owner)).toEqual({ ok: true })
    expect(t.cards.open).toHaveBeenLastCalledWith('s1', 't1', 'l1', false)
    expect(await t.ask({ action: 'cardOpen', session: 's1', tabId: 't1', leadId: null }, owner)).toEqual({ ok: true })
    expect(t.cards.open).toHaveBeenLastCalledWith('s1', 't1', null, false)
    for (const bad of [{ action: 'cardRecap', tabId: 'bad id', leadId: 'l1' }, { action: 'cardRecap', tabId: 't1' }, { action: 'cardOpen', session: 's1', tabId: 't1', leadId: 'bad id' }, { action: 'cardOpen', session: 's1', leadId: null },
      { action: 'cardOpen', tabId: 't1', leadId: null }, { action: 'cardRecap', tabId: 'x'.repeat(48), leadId: 'l1' }]) {
      expect(await t.ask(bad, owner)).toEqual({ error: 'INVALID_REQUEST' })
    }
  })
  it('cardsWanted passes focus to the cards; cardRecap, cardOpen and cardSay pass chat', async () => {
    const t = withCards()
    await t.ask({ action: 'cardsWanted', on: true, include: ['s1'], focus: { tabId: 's1', conversationId: 'g1', extra: 1 } }, owner)
    expect(t.cards.want).toHaveBeenLastCalledWith(true, ['s1'], { tabId: 's1', conversationId: 'g1' })
    // Whether a device caused the move is no part of the focus any more (it only kept a dial's side, task #3908).
    await t.ask({ action: 'cardsWanted', on: true, include: ['s1'], focus: { tabId: 's1', conversationId: 'g1', fromDevice: true } }, owner)
    expect(t.cards.want).toHaveBeenLastCalledWith(true, ['s1'], { tabId: 's1', conversationId: 'g1' })
    // A thread open beside it is no part of the focus any more.
    await t.ask({ action: 'cardsWanted', on: true, include: ['s1'], focus: { tabId: 's1', conversationId: 'g1', threadRoot: 'm1' } }, owner)
    expect(t.cards.want).toHaveBeenLastCalledWith(true, ['s1'], { tabId: 's1', conversationId: 'g1' })
    // A focus that is not two ids is none.
    for (const focus of [{ tabId: 'bad id', conversationId: 'g1' }, { tabId: 's1', conversationId: 'x'.repeat(48) }, { tabId: 's1' }, 'g1']) {
      await t.ask({ action: 'cardsWanted', on: true, include: ['s1'], focus }, owner)
      expect(t.cards.want).toHaveBeenLastCalledWith(true, ['s1'], null)
    }
    await t.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1', chat: true }, owner)
    expect(t.cards.recap).toHaveBeenLastCalledWith('t1', 'l1', true)
    await t.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1', chat: 'yes' }, owner)
    expect(t.cards.recap).toHaveBeenLastCalledWith('t1', 'l1', false)
    await t.ask({ action: 'cardOpen', session: 's1', tabId: 't1', leadId: 'l1', chat: true }, owner)
    expect(t.cards.open).toHaveBeenLastCalledWith('s1', 't1', 'l1', true)
    expect(await t.ask({ action: 'cardSay', harnessId: 'h1', text: ' ship it ', chat: true }, owner)).toEqual({ ok: true, said: true })
    expect(t.cards.say).toHaveBeenLastCalledWith('h1', 'ship it', true)
    await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it' }, owner)
    expect(t.cards.say).toHaveBeenLastCalledWith('h1', 'ship it', false)
  })
  it('answers an older dial\'s cardSide as no request, and the buddy flag reaches recap, open and say', async () => {
    const t = withCards()
    expect(await t.ask({ action: 'cardSide', tabId: 't1', side: 'buddy' }, owner)).toMatchObject({ error: expect.any(String) })
    await t.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1', chat: 'buddy' }, owner)
    expect(t.cards.recap).toHaveBeenLastCalledWith('t1', 'l1', 'buddy')
    await t.ask({ action: 'cardOpen', session: 's1', tabId: 't1', leadId: 'l1', chat: 'buddy' }, owner)
    expect(t.cards.open).toHaveBeenLastCalledWith('s1', 't1', 'l1', 'buddy')
    await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: 'buddy' }, owner)
    expect(t.cards.say).toHaveBeenLastCalledWith('h1', 'ship it', 'buddy')
    // The chat the words were spoken to rides with them; one that is not an id is none.
    await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: 'buddy', chatId: 'pm1' }, owner)
    expect(t.cards.say).toHaveBeenLastCalledWith('h1', 'ship it', 'buddy', 'pm1')
    await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: 'buddy', chatId: 'bad id' }, owner)
    expect(t.cards.say).toHaveBeenLastCalledWith('h1', 'ship it', 'buddy')
    // Reviewed on the dial: only with the chat it was reviewed for.
    await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: 'buddy', chatId: 'pm1', reviewed: true }, owner)
    expect(t.cards.say).toHaveBeenLastCalledWith('h1', 'ship it', 'buddy', 'pm1', true)
    await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: 'buddy', reviewed: true }, owner)
    expect(t.cards.say).toHaveBeenLastCalledWith('h1', 'ship it', 'buddy')
  })
  // Task #3908: threads are gone from the dial. An older dial's frames still arrive and are answered as before they existed.
  it('answers an older dial\'s thread frames without a thread: cardThreadLeave is no request, and cardSay passes no thread options', async () => {
    const t = withCards()
    expect(await t.ask({ action: 'cardThreadLeave', tabId: 't1', leadId: 'l1', chat: 'buddy' }, owner)).toMatchObject({ error: expect.any(String) })
    await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: true, threaded: true, thread: null }, owner)
    expect(t.cards.say).toHaveBeenLastCalledWith('h1', 'ship it', true)
    await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: true, chatId: 'lead-web', reviewed: true, thread: 'm9' }, owner)
    expect(t.cards.say).toHaveBeenLastCalledWith('h1', 'ship it', true, 'lead-web', true)
    t.cards.say.mockResolvedValueOnce({ said: true })
    expect(await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: true }, owner)).toEqual({ ok: true, said: true })
  })
  it('cardSay passes a refused post\'s code and message on, and says nothing of a refusal otherwise', async () => {
    const t = withCards()
    t.cards.say.mockResolvedValueOnce({ said: false, refused: { code: 'PM_CHAT_READ_ONLY', message: 'Chat with PM is read-only.' } })
    expect(await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it', chat: true }, owner))
      .toEqual({ ok: true, said: false, refused: { code: 'PM_CHAT_READ_ONLY', message: 'Chat with PM is read-only.' } })
    t.cards.say.mockResolvedValueOnce({ said: false })
    expect(await t.ask({ action: 'cardSay', harnessId: 'h1', text: 'ship it' }, owner)).toEqual({ ok: true, said: false })
  })
  it('cardWorker says whether a machine\'s harness is one of a Swarm\'s workers, for the devices to keep its failure quiet', async () => {
    const t = withCards()
    expect(await t.ask({ action: 'cardWorker', machineId: 'm2', harnessId: 'h-r1' }, owner)).toEqual({ ok: true, worker: true })
    expect(await t.ask({ action: 'cardWorker', machineId: 'm1', harnessId: 'h-r1' }, owner)).toEqual({ ok: true, worker: false })
    for (const bad of [{ action: 'cardWorker', machineId: 'bad id', harnessId: 'h-r1' }, { action: 'cardWorker', machineId: 'm2' }, { action: 'cardWorker', harnessId: 'h-r1' }]) {
      expect(await t.ask(bad, owner)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(await t.ask({ action: 'cardWorker', machineId: 'm2', harnessId: 'h-r1' }, { local: false, owner: true })).toEqual({ error: 'OWNER_REQUIRED' })
  })
  it('answers a backend refusal while reading a recap as the service does any other', async () => {
    const t = withCards()
    t.cards.recap.mockRejectedValueOnce(new SuperTabHostError('FORBIDDEN', 'Access withdrawn', 403))
    expect(await t.ask({ action: 'cardRecap', tabId: 't1', leadId: 'l1' }, owner)).toEqual({ error: 'FORBIDDEN', detail: 'Access withdrawn', status: 403 })
  })
  it('refuses all three to anyone but the machine\'s owner, like the other actions', async () => {
    const t = withCards()
    for (const action of ['cardsWanted', 'cardRecap', 'cardOpen']) {
      expect(await t.ask({ action, on: true, tabId: 't1', leadId: 'l1' }, visitor)).toEqual({ error: 'OWNER_REQUIRED' })
      expect(await t.ask({ action, on: true, tabId: 't1', leadId: 'l1' }, { local: false, owner: true })).toEqual({ error: 'OWNER_REQUIRED' })
    }
    expect(t.make).not.toHaveBeenCalled()
  })
  it('refuses all three to an account owner who is not at this computer', async () => {
    const t = withCards()
    for (const action of ['cardsWanted', 'cardRecap', 'cardOpen']) {
      expect(await t.ask({ action, on: true, session: 's1', tabId: 't1', leadId: 'l1' }, { local: false, owner: true, accountOwner: true } as never)).toEqual({ error: 'OWNER_REQUIRED' })
    }
    expect(t.make).not.toHaveBeenCalled()
  })
})

describe('a Lead\'s terminal result', () => {
  it('reads the result of its own terminal request as the calling agent, and nothing for a bad id', async () => {
    const t = setup()
    t.call.mockImplementation(async (_method, path) => ({ status: 200, body: { success: true, data: path.includes('/terminal/')
      ? { ok: true, text: 'Allow? 1. Yes' } : swarmData(t.agent, path) } }))
    expect(await t.ask({ action: 'terminalResult', tabId: 'tab', agentId: t.agentId, terminalRequestId: 'r1', requestId: 'transport-1' }, owner))
      .toEqual({ ok: true, value: { ok: true, text: 'Allow? 1. Yes' } })
    expect(t.call.mock.calls.at(-1)!.slice(0, 2)).toEqual(['GET', `/api/super-tabs/tab/terminal/r1?asAgentId=${t.agentId}`])
    expect(await t.ask({ action: 'terminalResult', tabId: 'tab', agentId: t.agentId, terminalRequestId: '../x' }, owner)).toEqual({ error: 'INVALID_REQUEST' })
  })
})

describe('a connected service', () => {
  // The Harness GitHub App is gone: no action gives an agent a token, and the server is asked for none.
  it('has no githubToken action: it is refused, and no token is asked of the server', async () => {
    const call = vi.fn<CoreApi['account']['backend']>(async (method, path) => ({ status: 200, body: { success: true, data: method === 'GET' && path.includes('/hosts/machine-1/changes')
      ? hostForm([{ tabId: 'tab-1', agent: { id: 'agent-1', machineId: 'machine-1', harnessId: 'native' } }]) : {} } }))
    const service = superTabService(fakeCore({ account: { backend: call }, agents: { byAgent: vi.fn(() => ({ agentId: 'native' }) as never) } }),
      { teamEngines: () => ({ start: vi.fn(), stop: vi.fn() }) })
    expect(await service.requests.super_tabs({ action: 'githubToken', harnessId: 'native' }, owner)).toEqual({ error: 'INVALID_REQUEST' })
    expect(call.mock.calls.some(([, path]) => String(path).includes('github-token'))).toBe(false)
  })

  it('runs a team daemon\'s Swarm host from its first connection, and a person\'s only once it hosts Swarm work', () => {
    const quiet = { teamEngines: () => ({ start: vi.fn(), stop: vi.fn() }) }
    const started = (team: boolean) => {
      const start = vi.fn()
      const service = superTabService(fakeCore({ dataDir: mkdtempSync(join(tmpdir(), 'team-wake-')) }),
        { ...quiet, team: () => team, host: () => ({ machineId: 'machine-1', start, stop: vi.fn() }) as unknown as SuperTabHost })
      service.port.connected()
      return start.mock.calls.length
    }
    // Added to a Swarm by its Mac's daemon, which does not wake it: without its host it reported no privacy check (third VM run).
    expect(started(true)).toBe(1)
    expect(started(false)).toBe(0)
  })

  it('reports its engines while connected, and stops with the service', () => {
    // In a Harness Team account, the engines installed and signed in are reported to its owner (team/engines.ts).
    const engines = { start: vi.fn(), stop: vi.fn() }
    const service = superTabService(fakeCore(), { teamEngines: () => engines })
    service.port.connected()
    expect(engines.start).toHaveBeenCalledTimes(1)
    service.port.disconnected()
    service.port.stop()
    expect(engines.stop).toHaveBeenCalledTimes(2)
  })
})

describe('the Harness Team account\'s own tmux', () => {
  it('is looked at as the service connects, and not again once there or installed; a failure again later', async () => {
    const quiet = { teamEngines: () => ({ start: vi.fn(), stop: vi.fn() }) as never }
    const installed = vi.fn(async () => 'installed' as const)
    const service = superTabService(fakeCore(), { ...quiet, teamTmux: installed })
    service.port.connected()
    await Promise.resolve()
    service.port.connected()
    expect(installed).toHaveBeenCalledOnce()
    const failed = vi.fn(async () => 'failed' as const)
    const retried = superTabService(fakeCore(), { ...quiet, teamTmux: failed })
    retried.port.connected()
    await Promise.resolve()
    retried.port.connected()
    expect(failed).toHaveBeenCalledOnce()
    vi.useFakeTimers({ now: Date.now() + 31 * 60_000 })
    retried.port.connected()
    vi.useRealTimers()
    expect(failed).toHaveBeenCalledTimes(2)
  })
})

describe('a Harness Team account, which Swarm v3 has none of (#4221)', () => {
  it('is offered at no moment, set up, declined or read by this daemon, even where the Swarm cannot be read', async () => {
    // What a daemon from before would make the setup with: nothing may reach it now.
    const make = vi.fn(async () => ({ offer: vi.fn(async () => ({ state: 'wanted' as const })), decline: vi.fn(), status: vi.fn() }))
    const backend = vi.fn<CoreApi['account']['backend']>(async () => ({ status: 503, body: { success: false } }))
    const service = superTabService(fakeCore({ account: { backend } }), { teamSetup: make } as never)
    for (const reason of ['startup', 'join', 'contribute', 'manual']) {
      for (const action of ['teamSetupCheck', 'teamSetup']) {
        expect(await service.requests.super_tabs({ action, reason, tabId: 'unreadable' }, owner)).toEqual({ error: 'INVALID_REQUEST' })
      }
    }
    for (const action of ['teamSetupDecline', 'teamSetupStatus']) {
      expect(await service.requests.super_tabs({ action }, owner)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(make).not.toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
  })
})

// Lead mentions (spec 2026-10-24-lead-mentions): a post names people by id or email; the backend gets their person ids,
// and every agent's help offers it (project instructions, phase 4).
describe('mentions on a post', () => {
  const people: Array<Record<string, unknown>> = [{ id: 'person-ken', email: 'Ken@Example.com', role: 'owner', username: '0xken15', name: 'Ken' },
    { id: 'person-dee', email: 'dee@example.com', role: 'collaborator', username: 'dee' }]
  const swarm = (t: ReturnType<typeof setup>, leadId: string | null) => {
    const state = { agents: [t.agent], people, projects: [{ id: 'pilot', name: 'Pilot', leadConversationId: 'pilot' }],
      conversations: [{ id: 'pilot', leadId, agentIds: [t.agentId] }, { id: 'work', projectId: 'pilot', leadId: t.agentId, agentIds: [t.agentId] }] }
    t.call.mockImplementation(async (_method, path) => ({ status: 200, body: { success: true, data: swarmData(t.agent, path, state) } }))
  }
  const post = (t: ReturnType<typeof setup>, mentions: unknown) => t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'op',
    command: { type: 'message.send', conversationId: 'pilot', text: 'Please confirm', replyTo: null, recipientIds: [], mentions } }, owner)
  const posted = (t: ReturnType<typeof setup>) => t.call.mock.calls.filter(([method]) => method === 'POST')

  it('sends the person ids of people named by id or by email, each once', async () => {
    const t = setup()
    swarm(t, t.agentId)
    expect(await post(t, ['ken@example.com', 'person-dee', 'KEN@EXAMPLE.COM'])).toMatchObject({ ok: true, operationId: 'op' })
    expect(posted(t)).toEqual([['POST', '/api/super-tabs/tab/commands', { operationId: 'op', asAgentId: t.agentId,
      command: { type: 'message.send', conversationId: 'pilot', text: 'Please confirm', replyTo: null, recipientIds: [], mentions: ['person-ken', 'person-dee'] } }]])
  })

  // Task #2954 (Ken, 11-04): a PM typed --mention with Ken's email and a machine's privacy hook stopped its session. A post
  // names people by username or display name; an email still works for older callers.
  it('sends the person ids of people named by username or display name, in any case and with or without @', async () => {
    const t = setup()
    swarm(t, t.agentId)
    expect(await post(t, ['@0xKen15', 'Dee', ' ken '])).toMatchObject({ ok: true })
    expect(posted(t).map(([, , body]) => (body as { command: { mentions: string[] } }).command.mentions)).toEqual([['person-ken', 'person-dee']])
  })

  it('refuses a display name two people go by, naming their usernames, and takes either by username', async () => {
    const t = setup()
    people.push({ id: 'person-ken2', email: 'ken@other.example', role: 'collaborator', username: 'kenb', name: 'ken' })
    try {
      swarm(t, t.agentId)
      expect(await post(t, ['Ken'])).toEqual({ error: 'MENTION_AMBIGUOUS',
        detail: 'Ken is the name of more than one person here (0xken15, kenb). Tag them by username or id.', status: 400 })
      expect(posted(t)).toEqual([])
      expect(await post(t, ['kenb', '0xken15'])).toMatchObject({ ok: true })
      expect(posted(t).map(([, , body]) => (body as { command: { mentions: string[] } }).command.mentions)).toEqual([['person-ken2', 'person-ken']])
    } finally { people.pop() }
  })

  it('refuses a person who is not in the Swarm before anything is sent', async () => {
    const t = setup()
    swarm(t, t.agentId)
    expect(await post(t, ['dee@example.com', 'someone@example.com'])).toEqual({ error: 'MENTION_UNKNOWN',
      detail: 'someone@example.com is not a person in this Swarm. Tag a person by the username or id shown in status.', status: 400 })
    expect(await post(t, [42])).toMatchObject({ error: 'MENTION_UNKNOWN' })
    expect(posted(t)).toEqual([])
  })

  it('explains a server from before mentions', async () => {
    const t = setup()
    swarm(t, t.agentId)
    const read = t.call.getMockImplementation()!
    t.call.mockImplementation(async (...args) => args[0] === 'POST'
      ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'command: Unrecognized key: "mentions"' } } } as never : read(...args))
    expect(await post(t, ['person-ken'])).toEqual({ error: 'MENTIONS_UNSUPPORTED', detail: 'This Swarm\'s server does not support tagging people yet.' })
  })

  const help = async (t: ReturnType<typeof setup>, payload: Record<string, unknown>) => object(object(await t.ask({ action: 'help', ...payload }, owner)).help)
  const mention = '[--mention PERSON]...'
  // Project instructions, phase 4: any agent of the project tags people and asks a batch; the server says where not.
  it('offers --mention and a batch of questions in every agent\'s help', async () => {
    const t = setup()
    swarm(t, t.agentId)
    const lead = await help(t, { tabId: 'tab', agentId: t.agentId })
    expect(lead.post).toContain(`post GROUP TEXT|- OPERATION_ID [--to AGENT]... [--answers MESSAGE_ID | --reply-to MESSAGE_ID] [--attach PATH]... ${mention}:`)
    expect(lead.post).toContain('--answers puts your answer right below that message, in the main chat; --reply-to puts it in that message\'s thread.')
    // 2026-10-30: TEXT - posted a literal dash; help says - reads the message from stdin (command.ts postStdin).
    expect(lead.post).toContain("when it holds quotes, or is only -, put - in its place and send the message on stdin (post GROUP - OPERATION_ID <<'MSG' … MSG); an empty stdin is refused and nothing is posted.")
    // By username, display name or id, never email (task #2954).
    expect(lead.post).toContain('--mention tags a person, by the username, display name or id shown in status (up to 5), when you need them to act or decide; it shows in their notifications.')
    // The server reads tags from the text too (backend mentions.ts).
    expect(lead.post).toContain('An @username in TEXT tags that person as well, outside code and links. Never type a person\'s email.')
    expect(lead.post).not.toMatch(/email shown|@email/)
    expect(await help(t, { tabId: 'tab', harnessId: 'native' })).toEqual(lead)
    // An agent that coordinates nothing reads the same, and so does help outside a tab or with a caller that cannot be read.
    swarm(t, 'new-lead')
    expect(await help(t, { tabId: 'tab', agentId: t.agentId })).toEqual(lead)
    expect(await help(t, {})).toEqual(lead)
    expect(await help(t, { tabId: 'tab' })).toEqual(lead)
    t.call.mockRejectedValue(new Error('Offline'))
    expect(await help(t, { tabId: 'tab', agentId: t.agentId })).toEqual(lead)
    t.call.mockResolvedValue({ status: 200, body: { success: true, data: hostForm([], { tabs: ['tab'] }) } })
    expect(await help(t, { tabId: 'tab', agentId: t.agentId })).toEqual(lead)
    expect(lead).not.toHaveProperty('leadOptions')
  })

  it('tells every agent how to read the project\'s decisions, ask one through needs_human, or ask a batch', async () => {
    const t = setup()
    swarm(t, t.agentId)
    const each = await help(t, {})
    expect(each.decisions).toContain('decisions [--answered]: the decisions asked of people in your project')
    expect(each.decisions).toContain('A decision is not a private channel')
    expect(each.commands).toContainEqual(expect.objectContaining({ type: 'work.status', status: 'needs_human',
      ask: { personId: 'PERSON', options: ['Option A', 'Option B'], recommended: 0, unblocks: 'What the answer unblocks' } }))
    expect(each.commands).toContainEqual(expect.objectContaining({ type: 'decision.ask', conversationId: 'GROUP', personId: 'PERSON' }))
    expect(each.commands).not.toContainEqual(expect.objectContaining({ type: 'person.tell' }))
    expect(each.decisions).not.toContain('person.tell')
  })
})

// #2358: a Buddy's guard refuses a post whose TEXT is -, as its message on stdin would skip the secret check. Its help then
// still offered - and stdin, so a Buddy that followed it was refused and tried again: a Buddy's help passes TEXT in quotes.
describe('a Buddy\'s help', () => {
  const STDIN_HINT = "put - in its place and send the message on stdin (post GROUP - OPERATION_ID <<'MSG' … MSG)"
  const QUOTED = 'TEXT is one argument, the message itself in quotes: \'your message\', or "it\'s done" when it holds an apostrophe. A Buddy never passes - for TEXT'
  const help = async (t: ReturnType<typeof setup>, payload: Record<string, unknown>, asker: Parameters<ReturnType<typeof setup>['ask']>[1] = owner) =>
    object(object(await t.ask({ action: 'help', ...payload }, asker)).help)
  const expectBuddy = (each: Record<string, unknown>) => {
    expect(each.post).toMatch(/^post GROUP TEXT OPERATION_ID \[--to AGENT\]\.\.\. \[--answers MESSAGE_ID \| --reply-to MESSAGE_ID\] \[--attach PATH\]\.\.\. \[--mention PERSON\]\.\.\.: /)
    expect(String(each.post)).toContain(QUOTED)
    expect(String(each.post)).not.toContain('TEXT|-')
    expect(String(each.post)).not.toContain(STDIN_HINT)
  }
  const expectStdin = (each: Record<string, unknown>) => {
    expect(String(each.post)).toContain('post GROUP TEXT|- OPERATION_ID')
    expect(String(each.post)).toContain(STDIN_HINT)
    expect(String(each.post)).not.toContain(QUOTED)
  }
  const localBuddy = (t: ReturnType<typeof setup>) => vi.mocked(t.core.agents.byAgent).mockReturnValue({ agentId: 'native', swarmSkill: { role: 'buddy', key: 'k' } } as never)

  it('passes TEXT in quotes for a Buddy the server records, and keeps the stdin hint for a Builder and a Lead', async () => {
    const builder = setup()
    const plain = await help(builder, { tabId: 'tab', agentId: builder.agentId })
    expectStdin(plain)
    const t = setup()
    Object.assign(t.agent, { buddyOf: { personId: 'peer', generation: 'g' } })
    const buddy = await help(t, { tabId: 'tab', agentId: t.agentId })
    expectBuddy(buddy)
    expect(await help(t, { tabId: 'tab', harnessId: 'native' })).toEqual(buddy)
    // Only the post and command lines differ: a Buddy reads the same help otherwise, and no Lead option.
    expect({ ...buddy, post: null, command: null }).toEqual({ ...plain, post: null, command: null })
    const lead = setup()
    lead.call.mockImplementation(async (_method, path) => ({ status: 200, body: { success: true, data: swarmData(lead.agent, path,
      { agents: [lead.agent], projects: [{ id: 'pilot', leadConversationId: 'pilot' }], conversations: [{ id: 'pilot', leadId: lead.agentId, agentIds: [lead.agentId] }] }) } }))
    const leadHelp = await help(lead, { tabId: 'tab', agentId: lead.agentId })
    expectStdin(leadHelp)
    expect(String(leadHelp.post)).toContain('--mention')
  })

  // A Buddy's help kept the command entry's stdin form (- in the JSON's place, a heredoc), which its guard refuses as well:
  // it offers stdin nowhere, and everyone else's command entry keeps it.
  it('offers a Buddy stdin nowhere, and keeps the command entry\'s stdin form for a Builder', async () => {
    const COMMAND_STDIN = "put - in its place and send it on stdin (command OPERATION_ID - <<'JSON' … JSON)"
    const builder = setup()
    const plain = await help(builder, { tabId: 'tab', agentId: builder.agentId })
    expect(String(plain.command)).toContain(COMMAND_STDIN)
    const t = setup()
    Object.assign(t.agent, { buddyOf: { personId: 'peer', generation: 'g' } })
    const buddy = await help(t, { tabId: 'tab', agentId: t.agentId })
    expect(String(buddy.command)).toMatch(/^command OPERATION_ID JSON: send one of the commands below\. The JSON is one argument, in single quotes/)
    expect(String(buddy.command)).toContain("command OPERATION_ID '{...}' (an apostrophe inside it as \\u0027). Reuse exactly")
    // The rest of the entry is everyone's: only how the JSON is passed differs.
    const tail = (text: unknown) => String(text).slice(String(text).indexOf(' Reuse exactly the same ID'))
    expect(tail(buddy.command)).toBe(tail(plain.command))
    // No entry offers stdin: no heredoc, no - in an argument's place, no TEXT|-. Its post may still say stdin is refused.
    for (const [key, text] of Object.entries(buddy)) expect(JSON.stringify(text), key).not.toMatch(/<<|in its place|send (it|the [a-zA-Z]+) on stdin|\|-/)
    expect(JSON.stringify(plain)).toMatch(/<<'JSON'/)
  })

  it('is a Buddy\'s help for a harness this computer started as a Buddy, as its guard is', async () => {
    const t = setup()
    localBuddy(t)
    expectBuddy(await help(t, { tabId: 'tab', agentId: t.agentId }))
    // A Builder's own launch record keeps the plain help.
    vi.mocked(t.core.agents.byAgent).mockReturnValue({ agentId: 'native', swarmSkill: { role: 'dev', key: 'k' } } as never)
    expectStdin(await help(t, { tabId: 'tab', agentId: t.agentId }))
  })

  it('stays a Buddy\'s help when its roster cannot be read, and is the plain help for anyone else', async () => {
    const t = setup()
    localBuddy(t)
    t.call.mockRejectedValue(new Error('Offline'))
    expectBuddy(await help(t, { tabId: 'tab', harnessId: 'native' }))
    // Off the roster, or not listed on this machine.
    t.call.mockResolvedValue({ status: 200, body: { success: true, data: hostForm([], { tabs: ['tab'] }) } })
    expectBuddy(await help(t, { tabId: 'tab', harnessId: 'native' }))
    expectBuddy(await help(t, { harnessId: 'native' }))
    // Without a harness, or from another computer, nothing tells a Buddy apart: the plain help, never an error.
    expectStdin(await help(t, { tabId: 'tab' }))
    expectStdin(await help(t, {}))
    expectStdin(await help(t, { tabId: 'tab', harnessId: 'native' }, { local: false, owner: true, accountOwner: true, machine: { machineId: 'studio', label: 'Studio' } }))
    vi.mocked(t.core.agents.byAgent).mockReturnValue(undefined)
    expectStdin(await help(t, { tabId: 'tab', harnessId: 'native' }))
  })
})

// A Buddy reads its project's work as its person (Ken, 10-29): its status is a bounded task summary, never the whole Swarm,
// with pull requests read through its person's own GitHub on their machine; archived tasks and older messages on request.
describe('a Buddy\'s status', () => {
  const buddySetup = () => {
    const t = setup()
    Object.assign(t.agent, { projectId: 'app', buddyOf: { personId: 'peer', generation: 'g' } })
    const state = { agents: [t.agent], projects: [{ id: 'app', name: 'App', leadConversationId: 'app-chat' }],
      conversations: [{ id: 'app-chat', projectId: 'app', title: 'App', leadId: null, agentIds: [], checks: [] },
        { id: 'offline', projectId: 'app', number: 12, title: 'Offline sync', brief: 'The whole brief', leadId: null, agentIds: [], checks: [],
          assignment: { status: 'blocked', result: 'Waiting for the sync API' }, pullRequestUrls: ['https://github.com/acme/app/pull/12'] }] }
    t.call.mockImplementation(async (_method, path) => ({ status: 200, body: { success: true, data: path.includes('/decisions?') ? { decisions: [], more: false }
      : path.includes('/groups?dormant=1') ? { groups: [], next: null } : path.includes('/messages?') ? { messages: [], next: null } : swarmData(t.agent, path, state) } }))
    const pullRequests = vi.fn(async (urls: string[]) => ({ rows: urls.map(url => ({ url, status: 'found' as const, state: 'Open' as const, ci: 'passing' as const })), checkedAt: 'now' }))
    const service = superTabService(t.core, { host: () => ({ machineId: 'machine-1', start: vi.fn(), stop: vi.fn() }) as unknown as SuperTabHost, pullRequests })
    return { ...t, pullRequests, ask: service.requests.super_tabs }
  }

  it('is its project\'s tasks with their pull request state, and no Swarm state', async () => {
    const t = buddySetup()
    const value = object(object(await t.ask({ action: 'status', tabId: 'tab', agentId: t.agentId }, owner)).value)
    expect(value.state).toBeUndefined()
    expect(object(value.summary).tasks).toEqual([expect.objectContaining({ number: 12, title: 'Offline sync', status: 'blocked', note: 'Waiting for the sync API',
      pullRequests: [expect.objectContaining({ url: 'https://github.com/acme/app/pull/12', state: 'Open', ci: 'passing' })] })])
    expect(JSON.stringify(value)).not.toContain('The whole brief')
    expect(t.call).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/decisions?state=open&asAgentId=${t.agentId}`, undefined)
  })

  // Huy 11-06 (#3872): a proposal's files are uploaded to the Buddy's chat for its project's PM, which the summary never names.
  // This read answers just that: the chat it names when this Buddy reads it, its own record, and each project's chat.
  it('answers a proposal\'s files with its chat, its own record and the projects\' chats, and nothing else of the Swarm', async () => {
    const t = buddySetup()
    const value = object(object(await t.ask({ action: 'proposalTarget', tabId: 'tab', agentId: t.agentId, conversationId: 'app-chat' }, owner)).value)
    expect(value).toEqual({ chat: { id: 'app-chat', projectId: 'app' }, self: { id: t.agentId, projectId: 'app' },
      projects: [{ id: 'app', leadConversationId: 'app-chat' }] })
    expect(JSON.stringify(value)).not.toContain('Offline sync')
    // A chat it does not read is none.
    expect(object(object(await t.ask({ action: 'proposalTarget', tabId: 'tab', agentId: t.agentId, conversationId: 'elsewhere' }, owner)).value).chat).toBeNull()
    expect(await t.ask({ action: 'proposalTarget', tabId: 'tab', agentId: t.agentId, conversationId: 'not an id' }, owner)).toMatchObject({ error: 'INVALID_REQUEST' })
  })

  it('reads its archived tasks a page at a time, in its own project only', async () => {
    const t = buddySetup()
    expect(await t.ask({ action: 'status', tabId: 'tab', agentId: t.agentId, archived: true, before: 'page-2' }, owner)).toMatchObject({ ok: true, value: { summary: { tasks: [], next: null } } })
    expect(t.call).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/groups?dormant=1&projectId=app&before=page-2&asAgentId=${t.agentId}`, undefined)
  })

  it('pages a task\'s older messages', async () => {
    const t = buddySetup()
    expect(await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'offline', before: 40, beforeId: 'm-1' }, owner)).toMatchObject({ ok: true })
    expect(t.call).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/conversations/offline/messages?asAgentId=${t.agentId}&before=40&beforeId=m-1`, undefined)
    // A cursor that is not one is refused, never read as the newest page.
    const calls = t.call.mock.calls.length
    for (const bad of [{ before: 2 ** 53, beforeId: 'm-1' }, { before: 40 }, { before: 40, beforeId: 'a b' }, { before: -1, beforeId: 'm-1' }]) {
      expect(await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'offline', ...bad }, owner)).toMatchObject({ error: 'INVALID_REQUEST' })
    }
    expect(t.call.mock.calls.slice(calls).filter(([, path]) => String(path).includes('/messages?'))).toEqual([])
  })

  it('reads one thread, with the main-chat messages a thread session started from, and refuses a thread that is not an id', async () => {
    const t = buddySetup()
    vi.mocked(t.core.account.backend).mockImplementation(async (_method: string, path: string) => ({ status: 200, body: { success: true, data:
      path.includes('/messages?') ? { messages: [{ id: 'root-1', thread: 'root-1' }], next: null, context: [{ id: 'older', text: 'earlier' }] }
        : swarmData(t.agent, path) } }))
    expect(await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'chat', thread: 'root-1' }, owner))
      .toMatchObject({ ok: true, value: { context: [{ id: 'older', text: 'earlier' }] } })
    expect(t.call).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/conversations/chat/messages?asAgentId=${t.agentId}&thread=root-1`, undefined)
    await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'chat', thread: 'root-1', before: 40, beforeId: 'm-1' }, owner)
    expect(t.call).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/conversations/chat/messages?asAgentId=${t.agentId}&before=40&beforeId=m-1&thread=root-1`, undefined)
    const calls = t.call.mock.calls.length
    expect(await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'chat', thread: 'a&b=c' }, owner)).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(t.call.mock.calls.slice(calls).filter(([, path]) => String(path).includes('/messages?'))).toEqual([])
  })

  it('leaves every other agent\'s status as it was', async () => {
    const t = setup()
    const value = object(object(await t.ask({ action: 'status', tabId: 'tab', agentId: t.agentId }, owner)).value)
    expect(value.state).toBeDefined()
    expect(value.summary).toBeUndefined()
  })
})

// Swarm group #13, 2026-10-29: a Codex Builder on gpt-6-luna sent its start id, then a made-up one, as assignmentId; both were
// refused as stale without the right id, and its finished task stayed open until the Lead cancelled it.
describe('the assignment a command names', () => {
  const live = '58c2d5f2bdc100771bc57de7'
  const withTask = (t: ReturnType<typeof setup>, holder: string) => {
    const state = { agents: [t.agent], conversations: [{ id: 'g1', agentIds: [t.agentId], assignment: { id: live, agentId: holder, status: 'working' } }] }
    const answer = t.call.getMockImplementation()!
    t.call.mockImplementation(async (method, path, body) => method === 'GET' && !path.includes('/hosts/')
      ? { status: 200, body: { success: true, data: swarmData(t.agent, path, state) } } : answer(method, path, body))
  }
  const posted = (t: ReturnType<typeof setup>) => t.call.mock.calls.filter(c => c[0] === 'POST').map(c => (c[2] as { command: Record<string, unknown> }).command)
  const status = (assignmentId?: string) => ({ type: 'work.status', conversationId: 'g1', ...(assignmentId === undefined ? {} : { assignmentId }), status: 'review', result: 'PR #1' })

  it('sends "current", or no id, as the task the agent holds', async () => {
    const t = setup(); withTask(t, t.agentId)
    expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'a', command: status('current') }, owner)).toMatchObject({ ok: true })
    expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'b', command: status() }, owner)).toMatchObject({ ok: true })
    expect(posted(t)).toEqual([{ ...status(), assignmentId: live }, { ...status(), assignmentId: live }])
  })

  it('answers a stale id with the one to use', async () => {
    const t = setup(); withTask(t, t.agentId)
    const answer = t.call.getMockImplementation()!
    t.call.mockImplementation(async (method, path, body) => method === 'POST'
      ? { status: 409, body: { success: false, error: { code: 'STALE_ASSIGNMENT', message: 'This is no longer the active assignment.' } } } : answer(method, path, body))
    expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'c', command: status('9887f5667a24ace0b589b7ff') }, owner)).toMatchObject({
      error: 'STALE_ASSIGNMENT', detail: `This is no longer the active assignment. This group's active assignment is ${live}: send it again with "assignmentId": "${live}" (or "current").` })
  })

  it('sends a check with no group to the one task the agent holds', async () => {
    const t = setup(); withTask(t, t.agentId)
    const check = { type: 'work.check', assignmentId: 'current', checkId: 'c1', passed: true, evidence: 'Posted' }
    expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'e', command: check }, owner)).toMatchObject({ ok: true })
    expect(posted(t)).toEqual([{ ...check, conversationId: 'g1', assignmentId: live }])
  })

  it('never fills in another agent\'s task for a status', async () => {
    const t = setup(); withTask(t, 'someone-else')
    await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'd', command: status('current') }, owner)
    expect(posted(t)).toEqual([status('current')])
  })
})

// Review of #2106: an attempt ends with every token its session used, read as it finishes, not the last machine report's.
describe('finishing your own work', () => {
  const opus = { 'claude-opus-5-5': { input: 7000, output: 1200, cacheRead: 0, cacheWrite: 0 } }
  const status = (status: string) => ({ type: 'work.status', conversationId: 'g1', assignmentId: 'a1', status, result: 'Shipped.' })
  const posts = (t: ReturnType<typeof setup>) => t.call.mock.calls.filter(c => c[0] === 'POST' && c[1] === '/api/super-tabs/tab/commands').map(c => (c[2] as { command: Record<string, unknown> }).command)

  it('sends Done and Stopped with your session’s totals read now, and nothing with any other status or without a reading', async () => {
    const t = setup()
    const fresh = vi.fn(async (_agentId: string) => ({ totalTokens: 8200, updatedAt: '2026-10-29T00:00:00Z', models: opus }))
    t.core.usageFresh = fresh
    for (const s of ['done', 'stopped', 'review']) await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: `op-${s}`, command: status(s) }, owner)
    expect(posts(t)).toEqual([{ ...status('done'), tokens: opus }, { ...status('stopped'), tokens: opus }, status('review')])
    expect(fresh).toHaveBeenCalledWith('native')
    fresh.mockResolvedValueOnce({ totalTokens: null, updatedAt: '2026-10-29T00:00:00Z' } as never)
    await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'op-none', command: status('done') }, owner)
    fresh.mockRejectedValueOnce(new Error('unreadable'))
    await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'op-fail', command: status('done') }, owner)
    expect(posts(t).slice(-2)).toEqual([status('done'), status('done')])
  })

  it('sends Done again without the totals to a backend from before them', async () => {
    const t = setup()
    t.core.usageFresh = async () => ({ totalTokens: 8200, updatedAt: '2026-10-29T00:00:00Z', models: opus })
    const answer = t.call.getMockImplementation()!
    t.call.mockImplementation(async (method, path, body) => (body as { command?: { tokens?: unknown } })?.command?.tokens
      ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'command: Unrecognized key: "tokens"' } } } : answer(method, path, body))
    expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'op', command: status('done') }, owner)).toMatchObject({ ok: true })
    expect(posts(t)).toEqual([{ ...status('done'), tokens: opus }, status('done')])
  })
})

// Agent context design, section 1 (Ken, 2026-11-02: agents forgot their task; the PM read the whole Swarm for progress).
describe('mine and task', () => {
  const ok = (data: unknown) => ({ status: 200, body: { success: true, data } })
  const withState = (t: ReturnType<typeof setup>, conversations: Array<Record<string, unknown>>, groupRead?: (path: string) => unknown) => {
    const state = { agents: [{ ...t.agent, name: 'Dev1' }], conversations }
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => {
      if (path.includes('/attempts')) return ok([]) as never
      if (path.startsWith('/api/super-tabs/tab/groups/') && groupRead) return groupRead(path) as never
      return ok(swarmData(t.agent, path, state)) as never
    })
  }
  it('mine answers its text', async () => {
    const t = setup()
    withState(t, [{ id: 'g12', number: 12, title: 'Fix login', archived: false, checks: [], assignment: { agentId: t.agentId, status: 'working', result: null } }])
    const answer = await t.ask({ action: 'mine', tabId: 'tab', harnessId: 'native' }, owner) as { value: { text: string } }
    expect(answer.value.text).toMatch(/^#12 P2 Fix login \(conversation g12\) — working/)
  })
  it('task reads a dormant group from the group read', async () => {
    const t = setup()
    const dormant = { id: 'g9', number: 9, title: 'Old fix', archived: true, dormant: true, checks: [], brief: 'Goal:\nOld.', assignment: { agentId: t.agentId, status: 'done', result: 'Merged' } }
    withState(t, [], path => path.startsWith('/api/super-tabs/tab/groups/g9?') ? ok({ group: { key: 'g9', version: 1, changedAt: 1, data: dormant } }) : ok({}))
    const answer = await t.ask({ action: 'task', tabId: 'tab', harnessId: 'native', conversationId: 'g9' }, owner) as { value: { text: string } }
    expect(answer.value.text.split('\n')[0]).toBe('#9 P2 Old fix (conversation g9)')
    expect(answer.value.text).toContain('- Dev1, done (current): Merged')
  })
  it('task names a stopped assignee from the task\'s messages', async () => {
    const t = setup()
    const group = { id: 'g9', number: 9, title: 'Fix', archived: false, checks: [], assignment: { agentId: 'gone', status: 'done', result: null } }
    withState(t, [group])
    const answer = vi.mocked(t.core.account.backend).getMockImplementation()!
    vi.mocked(t.core.account.backend).mockImplementation(async (method, path, body) => path.includes('/conversations/g9/messages')
      ? ok({ messages: [{ id: 'm', conversationId: 'g9', author: { kind: 'agent', id: 'gone', name: 'Avery' }, text: 'Done' }], next: null }) as never
      : answer(method, path, body))
    const result = await t.ask({ action: 'task', tabId: 'tab', harnessId: 'native', conversationId: 'g9' }, owner) as { value: { text: string } }
    expect(result.value.text).toContain('Assignee: Avery')
  })
  it('task of a group it cannot read answers NOT_FOUND', async () => {
    const t = setup()
    withState(t, [], () => ({ status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'This conversation is unavailable.' } } }))
    expect(await t.ask({ action: 'task', tabId: 'tab', harnessId: 'native', conversationId: 'g404' }, owner)).toMatchObject({ error: 'NOT_FOUND' })
  })
  it('help names mine and task', async () => {
    const t = setup()
    const answer = await t.ask({ action: 'help', tabId: 'tab', harnessId: 'native' }, owner) as { help: Record<string, unknown> }
    expect(answer.help.mine).toEqual(expect.stringContaining('mine'))
    expect(answer.help.task).toEqual(expect.stringContaining('task GROUP'))
  })
})

describe('status with steps', () => {
  it('prints a task\'s steps under it, not as rows', async () => {
    const t = setup()
    const conversations = [{ id: 'g1835', number: 1835, title: 'Fix login', archived: false, checks: [] },
      { id: 'g1918', number: 1918, title: 'Review', reviewOf: 'g1835', step: 'Review', archived: false, checks: [] },
      { id: 'g9', number: 9, title: 'Old review', reviewOf: 'g1835', archived: false, checks: [] }]
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => ({ status: 200, body: { success: true,
      data: swarmData(t.agent, path, { agents: [t.agent], conversations }) } }) as never)
    const answer = await t.ask({ action: 'status', tabId: 'tab', harnessId: 'native' }, owner) as { value: { state: { conversations: Array<Record<string, unknown>> } } }
    const rows = answer.value.state.conversations
    // Every linked group is a step, named or not (Ken, 2026-11-02).
    expect(rows.map(c => c.id)).toEqual(['g1835'])
    expect((rows[0]!.steps as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['g1918', 'g9'])
  })
})

// Task steps design: a task's chat shows its steps' rows by time, and a step is opened only on a backend that has steps.
describe('a task\'s steps in messages and commands', () => {
  const ok = (data: unknown) => ({ status: 200, body: { success: true, data } })
  const row = (id: string, conversationId: string, createdAt: string) => ({ id, conversationId, createdAt, text: id, author: { name: 'A' } })
  const conversations = [{ id: 'g1835', number: 1835, title: 'Fix login', archived: false, checks: [] },
    { id: 'g1918', number: 1918, title: 'Review', reviewOf: 'g1835', step: 'Thiết kế "v2"', archived: false, checks: [] },
    { id: 'g1919', number: 1919, title: 'Test', reviewOf: 'g1835', step: 'Test', archived: false, checks: [] }]
  function wired(t: ReturnType<typeof setup>, options: { steps?: boolean; failing?: string } = {}) {
    const sent: Array<Record<string, unknown>> = []
    vi.mocked(t.core.account.backend).mockImplementation(async (method, path, body) => {
      const read = /\/conversations\/(g\d+)\/messages\?/.exec(path)
      if (read) {
        if (read[1] === options.failing) return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'No' } } } as never
        const rows = { g1835: [row('t1', 'g1835', '2026-11-02T09:00:00Z'), row('t2', 'g1835', '2026-11-02T09:10:00Z')],
          g1918: [row('s1', 'g1918', '2026-11-02T09:05:00Z')], g1919: [row('u1', 'g1919', '2026-11-02T09:15:00Z')] }[read[1]!] ?? []
        return ok({ messages: rows, next: null, threads: [] }) as never
      }
      if (method === 'POST' && path.endsWith('/commands')) { sent.push(object(body)); return ok({ revision: 1, result: {} }) as never }
      const data = swarmData(t.agent, path, { agents: [t.agent], conversations })
      return ok(options.steps && /\/parts/.test(path) ? { ...object(data), steps: true } : data) as never
    })
    return sent
  }
  it('messages of a task merges its steps\' rows by time and tags them', async () => {
    const t = setup(); wired(t, { steps: true })
    const answer = await t.ask({ action: 'messages', tabId: 'tab', harnessId: 'native', conversationId: 'g1835' }, owner) as { value: { messages: Array<Record<string, unknown>> } }
    expect(answer.value.messages.map(m => [m.id, m.step ?? null])).toEqual([['t1', null], ['s1', 'Thiết kế "v2"'], ['t2', null], ['u1', 'Test']])
  })
  it('an unreadable step leaves the task\'s rows and says which step is missing', async () => {
    const t = setup(); wired(t, { steps: true, failing: 'g1919' })
    const answer = await t.ask({ action: 'messages', tabId: 'tab', harnessId: 'native', conversationId: 'g1835' }, owner) as { value: { messages: Array<Record<string, unknown>>; stepsMissing: string[] } }
    expect(answer.value.messages.map(m => m.id)).toEqual(['t1', 's1', 't2'])
    expect(answer.value.stepsMissing).toEqual(['Test'])
  })
  // Final review, minor 6: an archived task keeps its steps' rows, archived with it.
  it('messages of an archived task still merges its archived steps', async () => {
    const t = setup()
    const archived = conversations.map(c => ({ ...c, archived: true }))
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => {
      const read = /\/conversations\/(g\d+)\/messages\?/.exec(path)
      if (read) return ok({ messages: read[1] === 'g1918' ? [row('s1', 'g1918', '2026-11-02T09:05:00Z')] : [], next: null, threads: [] }) as never
      return ok(swarmData(t.agent, path, { agents: [t.agent], conversations: archived })) as never
    })
    const answer = await t.ask({ action: 'messages', tabId: 'tab', harnessId: 'native', conversationId: 'g1835' }, owner) as { value: { messages: Array<Record<string, unknown>> } }
    expect(answer.value.messages.map(m => m.id)).toEqual(['s1'])
  })
  it('messages of a step reads the step alone', async () => {
    const t = setup(); wired(t, { steps: true })
    const answer = await t.ask({ action: 'messages', tabId: 'tab', harnessId: 'native', conversationId: 'g1918' }, owner) as { value: { messages: Array<Record<string, unknown>> } }
    expect(answer.value.messages.map(m => m.id)).toEqual(['s1'])
  })
  it('step is dropped for a backend without steps', async () => {
    const t = setup(); const sent = wired(t, { steps: false })
    await t.ask({ action: 'command', tabId: 'tab', harnessId: 'native', operationId: 'op-1',
      command: { type: 'conversation.create', title: 'Review', reviewOf: 'g1835', step: 'Review', checks: [] } }, owner)
    expect(object(sent[0]!.command)).toMatchObject({ type: 'conversation.create', reviewOf: 'g1835' })
    expect(object(sent[0]!.command)).not.toHaveProperty('step')
  })
  // Final review, minor 7: the flag is read at the first load, so a backend rolled back since refuses `step`; the command is
  // sent once more without it, and the step opens as a plain linked task.
  it('sends it again without step when the backend refuses the field', async () => {
    const t = setup(); const sent = wired(t, { steps: true })
    const answer = vi.mocked(t.core.account.backend).getMockImplementation()!
    vi.mocked(t.core.account.backend).mockImplementation(async (method, path, body) => method === 'POST' && path.endsWith('/commands')
      && 'step' in object(object(body).command)
      ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Unrecognized key: "step"' } } } as never
      : answer(method, path, body))
    const result = await t.ask({ action: 'command', tabId: 'tab', harnessId: 'native', operationId: 'op-1',
      command: { type: 'conversation.create', title: 'Review', reviewOf: 'g1835', step: 'Review', checks: [] } }, owner)
    expect(result).toMatchObject({ ok: true })
    expect(sent).toHaveLength(1)
    expect(object(sent[0]!.command)).not.toHaveProperty('step')
  })
  it('step is sent to a backend that has steps', async () => {
    const t = setup(); const sent = wired(t, { steps: true })
    await t.ask({ action: 'command', tabId: 'tab', harnessId: 'native', operationId: 'op-1',
      command: { type: 'conversation.create', title: 'Review', reviewOf: 'g1835', step: 'Review', checks: [] } }, owner)
    expect(object(sent[0]!.command)).toMatchObject({ step: 'Review' })
  })
})

it('help shows a step\'s example with neutral words', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help', tabId: 'tab', harnessId: 'native' }, owner) as { help: { commands: Array<Record<string, unknown>> } }
  const step = answer.help.commands.find(c => c.type === 'conversation.create' && 'step' in c)!
  expect(step).toMatchObject({ reviewOf: 'GROUP', step: 'STEP_NAME' })
  expect(JSON.stringify(answer.help.commands)).not.toContain('Review: Outcome')
})
