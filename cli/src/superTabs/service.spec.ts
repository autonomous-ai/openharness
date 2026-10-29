import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import type { CoreApi } from '../core/api.js'
import { sharedSwarm, superTabService } from './service.js'
import { object } from './wire.js'
import { hostForm, swarmReply } from './fixtures/read/index.js'
import { HostFeed } from './hostFeed.js'
import { SwarmReads } from './swarmReads.js'

const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
import { hostJournalFile, SuperTabHostError, type SuperTabHost, type SuperTabHostOptions } from './host.js'

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
    expect(await service.port.swarmRole('old-native')).toEqual({ role: 'lead', mode: 'orchestration' })
    expect(await service.requests.super_tabs({ action: 'swarmRole', harnessId: 'old-native' }, owner)).toEqual({ ok: true, role: 'lead', mode: 'orchestration' })
    expect(await service.requests.super_tabs({ action: 'swarmRole', harnessId: 'old-native' }, visitor)).toMatchObject({ error: 'OWNER_REQUIRED' })
    call.mockRejectedValueOnce(new Error('Offline'))
    expect(await service.port.swarmRole('old-native')).toBeUndefined()
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
    it(`${type} requires each task part and a nonempty acceptance check`, async () => {
      for (const [field, invalid] of [
        ['goal', { task: { ...task, goal: ' ' } }], ['changes', { task: { ...task, changes: '' } }],
        ['constraints', { task: { ...task, constraints: null } }], ['owns', { task: { ...task, owns: [] } }],
        ['owns', { task: { ...task, owns: [' '] } }], ['goal', { task: undefined }],
        ['acceptance checks', { checks: [] }], ['acceptance checks', { checks: [{ description: ' ' }] }],
      ] as const) {
        const t = setup()
        expect(await send(t, Object.assign({ ...base, task, checks }, invalid))).toMatchObject({ error: 'TASK_REQUIRED', detail: expect.stringContaining(field) })
        expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(0)
      }
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
it('documents how a lead shares its project repository for other machines', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { commands: Array<Record<string, unknown>> } }
  expect(answer.help.commands).toContainEqual({ type: 'project.repository', projectId: 'PROJECT', repositoryUrl: 'https://github.com/OWNER/REPOSITORY' })
})
it('tells the Lead how to switch a project\'s skills on its owner\'s own request', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { command: string; commands: Array<Record<string, unknown>> } }
  expect(answer.help.commands).toContainEqual({ type: 'project.skills', projectId: 'PROJECT', mode: 'default|orchestration|custom',
    askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } })
  expect(answer.help.command).toContain('project.skills switches a project between the Default, Harness orchestration and Custom skills (Custom once its owner has made the project\'s roles): only its project owner does, or its Lead passing on that owner\'s own chat message, with askedIn naming it.')
})
it('tells the Lead how to turn the Swarm\'s tidying off or on at its owner\'s own request', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { command: string; commands: Array<Record<string, unknown>> } }
  expect(answer.help.commands).toContainEqual({ type: 'tab.tidy', enabled: false, askedIn: { conversationId: 'GROUP', messageId: 'OWNER_MESSAGE' } })
  expect(answer.help.command).toContain('tab.tidy turns off, or back on, the Swarm\'s tidying: workers idle for 15 minutes stop and finished groups archive once their pull requests are merged or closed. Only the Swarm owner does, or a Lead passing on the owner\'s own chat message, with askedIn naming it.')
})
it('tells the Lead that start works only on a machine in the Swarm\'s Machines list', async () => {
  const t = setup()
  const answer = await t.ask({ action: 'help' }, owner) as { help: { start: string } }
  expect(answer.help.start).toContain('create one agent in a conversation on a machine in this Swarm\'s Machines list; to use another machine, a person adds it to the Swarm first.')
  expect(answer.help.start).toContain('Repeat exactly after an interruption')
})
// Custom roles and skills per project (spec 2026-10-23): a Lead starts and assigns by role, from the roles status shows.
it('explains a project\'s Custom roles: where status shows them, and starting or assigning with one', async () => {
  const answer = await setup().ask({ action: 'help' }, owner) as { help: { status: string; start: string; command: string } }
  expect(answer.help.status).toContain('A project on Custom skills lists its roles (id, name, kind) in status.')
  expect(answer.help.start).toContain('On Custom skills, add "roleId" to the start request to start the agent in that role of its kind')
  expect(answer.help.command).toContain('work.assign takes "roleId" too')
})
it('explains to a Lead other projects\' work and the Leads conversation', async () => {
  const answer = await setup().ask({ action: 'help' }, owner) as { help: { status: string; leads: string } }
  expect(answer.help.status).toContain('A Lead\'s status also lists otherProjectsWork: the active work of the Swarm\'s other projects')
  expect(answer.help.leads).toContain('leadsConversationId')
  expect(answer.help.leads).toContain('Only Leads and people post there, and only Leads among agents receive it.')
  expect(answer.help.leads).toContain('if your task touches the same code, say so there and agree an order first')
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

// Leads see each other's work and talk (spec 2026-10-23): a Lead's status carries other projects' active work, in the
// backend's own fields and nothing more; an agent that leads nothing never sees it nor the Leads conversation.
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
    expect(state.leadsConversationId).toBe('leads')
    expect(list(state.conversations).map(c => c.id)).toEqual(['pilot', 'leads'])
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

it('resolves a replacement terminal to the original stable member', async () => {
  const t = setup()
  t.agent.harnessId = 'replacement'
  expect(await t.ask({ action: 'status', tabId: 'tab', harnessId: 'replacement' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab/parts?asAgentId=${t.agentId}`, undefined)
  expect(await t.ask({ action: 'status', tabId: 'tab', harnessId: 'native' }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
})

it('tells the Lead which branch a started agent works from, and how to choose another', async () => {
  const t = setup()
  const help = (await t.ask({ action: 'help' }, owner)).help as { start: string; startRequest: Record<string, unknown> }
  expect(help.start).toContain('default branch, fetched first')
  expect(help.start).toContain('branchRef')
  expect(help.startRequest).toMatchObject({ worktree: true, branchRef: 'refs/remotes/origin/BASE_BRANCH' })
  expect(help.start).toContain('role "reviewer"')
  expect(help.start).toContain('reviewOf')
})

it('keeps host capacity separate from account authority and closes it on disconnect or identity change', async () => {
  const core = fakeCore()
  const reserve = vi.fn(async () => ({ ok: true, reservationId: 'native-creation-id' }))
  const observe = vi.fn(async () => ({ ok: true, released: true }))
  const stop = vi.fn(), factory = vi.fn(() => ({ reserve, observe, creationOf: vi.fn(() => null), stop }))
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

it('gives the host this machine\'s record of the Swarm starts, to close a session the backend ends', async () => {
  const core = fakeCore()
  const creationOf = vi.fn((harnessId: string) => harnessId === 'harness' ? 'super-0123456789abcdef' : null)
  const factory = vi.fn(() => ({ reserve: vi.fn(), observe: vi.fn(), creationOf, stop: vi.fn() }))
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

it('returns the routing context to a verified contribution', async () => {
  const t = setup()
  vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => path.includes('/routing-policy')
    ? { status: 200, body: { success: true, data: { policy: { version: 1 }, warnings: [], overridden: [] } } }
    : { status: 200, body: { success: true, data: swarmData(t.agent, path) } })
  t.core.account.machines = vi.fn(async () => ({ status: 200, body: { success: true, data: {
    machines: [{ machineId: 'm1', name: 'remote-1', status: 'online' }],
    sharedMachines: [{ machineId: 'm2', name: 'shared', status: 'online', share: { added: true } }, { machineId: 'm3', name: 'not added', status: 'online' }] } } }))
  expect(await t.ask({ action: 'routeContext', tabId: 'tab', harnessId: 'native' }, owner)).toEqual({ ok: true, value: {
    agentId: t.agentId, tab: { lastChangedAt: expect.any(Number), state: expect.objectContaining({ agents: [t.agent] }) }, policy: { policy: { version: 1 }, warnings: [], overridden: [] },
    machines: [{ machineId: 'm1', name: 'remote-1', status: 'online' }, { machineId: 'm2', name: 'shared', status: 'online' }] } })
  expect(t.call).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/routing-policy?asAgentId=${t.agentId}`, undefined)
})
describe('routeHistory', () => {
  const contextOf = (t: ReturnType<typeof setup>, read: (path: string) => Promise<unknown>, lead?: string) => {
    const state = { agents: [{ ...t.agent, name: 'Boss' }, { id: 'a2', name: 'Multiply' }, { id: 'a3', name: 'Reader' }], conversations: [{ id: 'g1', leadId: lead ?? t.agentId }] }
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => {
      if (path.includes('/messages') || path.includes('/route-decisions') || path.includes('/attempts')) return await read(path) as never
      // The one group by id (design 4.5), from the same state.
      if (path.startsWith('/api/super-tabs/tab/groups/g1?')) return { status: 200, body: { success: true, data: { group: { key: 'g1', version: 1, changedAt: 1, data: state.conversations[0] } } } }
      return { status: 200, body: { success: true, data: path.includes('/routing-policy') ? { policy: { version: 1 }, warnings: [] } : swarmData(t.agent, path, state) } }
    })
    t.core.account.machines = vi.fn(async () => ({ status: 200, body: { data: { machines: [] } } }))
    return t.ask({ action: 'routeHistory', tabId: 'tab', harnessId: 'native', conversationId: 'g1' }, owner) as Promise<{ value: Record<string, unknown> }>
  }
  const ok = (data: unknown) => ({ status: 200, body: { success: true, data } })
  it('reads only the route log and the attempts, never the group\'s messages, which only Jev read', async () => {
    const t = setup()
    const { value } = await contextOf(t, async () => ok([]))
    expect(value).toEqual({ decisions: [], attempts: [] })
    expect(vi.mocked(t.core.account.backend)).not.toHaveBeenCalledWith('GET', expect.stringContaining('/messages'), undefined)
  })
  it('is for the Lead of the group only, like the route', async () => {
    const t = setup()
    expect(await contextOf(t, async () => ok([]), 'someone-else')).toMatchObject({ error: 'LEAD_REQUIRED', status: 403 })
    expect(vi.mocked(t.core.account.backend)).not.toHaveBeenCalledWith('GET', expect.stringContaining('/route-decisions'), undefined)
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
  it('gives every attempt of the group, newest first, with only what the route needs and no more than fifty', async () => {
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
    expect(old.value).toMatchObject({ decisions: [], attemptsUnreadable: true })
    expect(old.value).not.toHaveProperty('attempts')
    const failed = await contextOf(setup(), async path => path.includes('/attempts') ? Promise.reject(new Error('down')) : without(path))
    expect(failed.value).toMatchObject({ attemptsUnreadable: true, decisions: [] })
    const odd = await contextOf(setup(), async path => path.includes('/attempts') ? ok({ attempts: 'no' }) : without(path))
    expect(odd.value).toMatchObject({ attemptsUnreadable: true })
    vi.useFakeTimers()
    try {
      const slow = contextOf(setup(), async path => path.includes('/attempts') ? new Promise(() => {}) : without(path))
      await vi.advanceTimersByTimeAsync(3000)
      expect((await slow).value).toMatchObject({ decisions: [], attemptsUnreadable: true })
    } finally { vi.useRealTimers() }
  })
  it('marks the route log unreadable on its own, and never waits longer than three seconds for it', async () => {
    const odd = await contextOf(setup(), async path => path.includes('/attempts') ? ok([]) : { status: 503, body: { error: 'SERVICE_UNAVAILABLE' } })
    expect(odd.value).toEqual({ decisionsUnreadable: true, attempts: [] })
    vi.useFakeTimers()
    try {
      const slow = contextOf(setup(), async path => path.includes('/attempts') ? ok([]) : new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(3000)
      expect((await slow).value).toEqual({ decisionsUnreadable: true, attempts: [] })
    } finally { vi.useRealTimers() }
  })
})
it('says the machine list could not be read, instead of offering none', async () => {
  const t = setup()
  vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => path.includes('/routing-policy')
    ? { status: 200, body: { success: true, data: { policy: { version: 1 }, warnings: [], overridden: [] } } }
    : { status: 200, body: { success: true, data: swarmData(t.agent, path) } })
  for (const answer of [async () => ({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } }), async () => { throw new Error('link lost') }]) {
    t.core.account.machines = vi.fn(answer)
    expect(await t.ask({ action: 'routeContext', tabId: 'tab', harnessId: 'native' }, owner)).toMatchObject({ ok: true, value: { machines: [], machinesUnreadable: true } })
  }
  t.core.account.machines = vi.fn(async () => ({ status: 200, body: { data: { machines: [{ machineId: 'm1', name: 'remote-1', status: 'online' }] } } }))
  expect((await t.ask({ action: 'routeContext', tabId: 'tab', harnessId: 'native' }, owner) as { value: object }).value).not.toHaveProperty('machinesUnreadable')
})
it('no longer asks Jev: the daemon has no routeJev action', async () => {
  const t = setup()
  expect(await t.ask({ action: 'routeJev', tabId: 'tab', harnessId: 'native', conversationId: 'g1', state: {}, questions: {} }, owner)).not.toMatchObject({ ok: true })
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

it('tells the Lead that simple work ranks grid models first, and how the owner opts out', async () => {
  const help = (await setup().ask({ action: 'help' }, owner)).help as { commands: unknown[]; command: string }
  expect(help.commands).toContainEqual(expect.objectContaining({ type: 'rule.set', rule: { kind: 'noGridFirst' } }))
  expect(help.command).toContain('ranks models on the Swarm\'s grid first unless the owner set noGridFirst')
})

it('documents finished worker decisions and explains an older backend without release support', async () => {
  const t = setup()
  const help = (await t.ask({ action: 'help' }, owner)).help as { commands: unknown[]; release: string }
  expect(help.commands).toContainEqual({ type: 'agent.release', agentId: 'AGENT', decision: 'keep|stop' })
  expect(help.commands).toContainEqual(expect.objectContaining({ type: 'work.cancel', assignmentId: 'ATTEMPT' }))
  expect(help.release).toContain('prefer stop')
  t.call.mockImplementation(async (...args: unknown[]) => args[0] === 'POST'
    ? { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } } } as never
    : { status: 200, body: { success: true, data: swarmData(t.agent, args[1] as string) } })
  const reply = await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'release', command: { type: 'agent.release', agentId: 'worker', decision: 'stop' } }, owner)
  expect(reply).toMatchObject({ detail: 'This backend does not support releasing Builders yet. Update the backend and try again.' })
})

describe('the Swarm cards the devices ask for', () => {
  function withCards() {
    const cards = { want: vi.fn(), open: vi.fn(), say: vi.fn(async () => true), worker: vi.fn((machineId: string, harnessId: string) => machineId === 'm2' && harnessId === 'h-r1'), recap: vi.fn(async (tabId: string, leadId: string) => ({ tabId, leadId, text: 'Shipped', at: 5, none: false })), onCards: undefined as unknown, onRecap: undefined as unknown }
    const superTabs = { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(), screen: vi.fn(), input: vi.fn() }
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

describe('GitHub App tokens through the service', () => {
  it('gives a local agent its task\'s token, never one asked for through the relay', async () => {
    const call = vi.fn<CoreApi['account']['backend']>(async (method, path) => ({ status: 200, body: { success: true, data: method === 'GET' && path.includes('/hosts/machine-1/changes')
      ? hostForm([{ tabId: 'tab-1', agent: { id: 'agent-1', machineId: 'machine-1', harnessId: 'native' } }])
      : { token: 'ghs_fixtureToken0000001', expiresAt: '2026-10-24T13:00:00.000Z', repository: 'acme/app', trailers: [] } } }))
    const service = superTabService(fakeCore({ account: { backend: call }, agents: { byAgent: vi.fn(() => ({ agentId: 'native' }) as never) } }),
      { githubTokens: () => ({ start: vi.fn(), stop: vi.fn() }) })
    expect(await service.requests.super_tabs({ action: 'githubToken', harnessId: 'native' }, owner))
      .toMatchObject({ ok: true, value: { token: 'ghs_fixtureToken0000001', tabId: 'tab-1', agentId: 'agent-1' } })
    expect(call).toHaveBeenCalledWith('POST', '/api/super-tabs/tab-1/github-token?asAgentId=agent-1', { machineId: 'machine-1' })
    const calls = call.mock.calls.length
    expect(await service.requests.super_tabs({ action: 'githubToken', harnessId: 'native' }, { local: false, owner: true, accountOwner: true } as never))
      .toEqual({ error: 'OWNER_REQUIRED' })
    expect(await service.requests.super_tabs({ action: 'githubToken', harnessId: 'native' }, visitor)).toEqual({ error: 'OWNER_REQUIRED' })
    expect(call.mock.calls.length).toBe(calls)
  })

  it('runs a team daemon\'s Swarm host from its first connection, and a person\'s only once it hosts Swarm work', () => {
    const quiet = { githubTokens: () => ({ start: vi.fn(), stop: vi.fn() }), teamEngines: () => ({ start: vi.fn(), stop: vi.fn() }), teamRelay: () => ({ start: vi.fn(), stop: vi.fn(async () => {}) }) }
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

  it('keeps the tokens fresh while connected, and stops with the service', () => {
    const tokens = { start: vi.fn(), stop: vi.fn() }
    const engines = { start: vi.fn(), stop: vi.fn() }
    const service = superTabService(fakeCore(), { githubTokens: () => tokens, teamEngines: () => engines })
    service.port.connected()
    expect(tokens.start).toHaveBeenCalledTimes(1)
    // And, in a Harness Team account, reports its own engines to its owner (team/engines.ts).
    expect(engines.start).toHaveBeenCalledTimes(1)
    service.port.disconnected()
    service.port.stop()
    expect(tokens.stop).toHaveBeenCalledTimes(2)
    expect(engines.stop).toHaveBeenCalledTimes(2)
  })
})

describe('the owner\'s subscriptions for the Harness Team account', () => {
  it('start with the service\'s first connection and stop only with the service, not a lost connection', async () => {
    const relay = { start: vi.fn(), stop: vi.fn(async () => {}) }
    const service = superTabService(fakeCore(), { githubTokens: () => ({ start: vi.fn(), stop: vi.fn() }) as never,
      teamEngines: () => ({ start: vi.fn(), stop: vi.fn() }) as never, teamRelay: () => relay })
    service.port.connected()
    expect(relay.start).toHaveBeenCalledOnce()
    service.port.disconnected()
    expect(relay.stop).not.toHaveBeenCalled()
    service.port.stop()
    expect(relay.stop).toHaveBeenCalledOnce()
  })
})

describe('the Harness Team account\'s own tmux', () => {
  it('is looked at as the service connects, and not again once there or installed; a failure again later', async () => {
    const quiet = { githubTokens: () => ({ start: vi.fn(), stop: vi.fn() }) as never, teamEngines: () => ({ start: vi.fn(), stop: vi.fn() }) as never,
      teamRelay: () => ({ start: vi.fn(), stop: vi.fn(async () => {}) }) }
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

describe('the Harness Team account, offered by Desktop on this Mac', () => {
  it('runs only for the local owner, for a moment the person is there, and says whether it started', async () => {
    const offer = vi.fn(async (_reason: string, _shared: () => Promise<boolean>) => ({ state: 'started' as const }))
    const make = vi.fn(async () => ({ offer, decline: vi.fn() }))
    const service = superTabService(fakeCore(), { teamSetup: make })
    expect(await service.requests.super_tabs({ action: 'teamSetup', reason: 'join' }, owner)).toEqual({ ok: true, state: 'started' })
    expect(offer).toHaveBeenCalledWith('join', expect.any(Function), false)
    for (const asker of [visitor, { local: false, owner: true, accountOwner: true }]) {
      expect(await service.requests.super_tabs({ action: 'teamSetup', reason: 'join' }, asker as never)).toEqual({ error: 'OWNER_REQUIRED' })
    }
    for (const reason of [undefined, 'background', 7]) {
      expect(await service.requests.super_tabs({ action: 'teamSetup', reason }, owner)).toEqual({ error: 'INVALID_REQUEST' })
    }
    await service.requests.super_tabs({ action: 'teamSetup', reason: 'contribute' }, owner)
    expect(make).toHaveBeenCalledTimes(1)
    expect(offer).toHaveBeenCalledTimes(2)
  })

  it('at app start, answers at once on a Mac that hosts no Swarm work, as no regular user\'s does', async () => {
    const offer = vi.fn(async (_reason: string, _shared: () => Promise<boolean>) => ({ state: 'not-shared' as const }))
    const make = vi.fn(async () => ({ offer, decline: vi.fn() }))
    const dataDir = mkdtempSync(join(tmpdir(), 'team-startup-'))
    const service = superTabService(fakeCore({ dataDir }), { teamSetup: make })
    expect(await service.requests.super_tabs({ action: 'teamSetup', reason: 'startup' }, owner)).toEqual({ ok: true, state: 'not-shared' })
    expect(make).not.toHaveBeenCalled()
    // Once this Mac hosts Swarm work, the offer decides.
    mkdirSync(dirname(hostJournalFile(dataDir, 'machine-1')), { recursive: true })
    writeFileSync(hostJournalFile(dataDir, 'machine-1'), '{}')
    await service.requests.super_tabs({ action: 'teamSetup', reason: 'startup' }, owner)
    expect(offer).toHaveBeenCalledWith('startup', expect.any(Function), false)
  })

  it('says whether it is wanted without asking macOS, runs it when the person asks, and remembers "Not now"', async () => {
    const offer = vi.fn(async (_reason: string, _shared: () => Promise<boolean>, check?: boolean) => ({ state: check ? 'wanted' as const : 'started' as const }))
    const decline = vi.fn()
    const service = superTabService(fakeCore(), { teamSetup: async () => ({ offer, decline }) })
    expect(await service.requests.super_tabs({ action: 'teamSetupCheck', reason: 'join' }, owner)).toEqual({ ok: true, state: 'wanted' })
    expect(offer).toHaveBeenLastCalledWith('join', expect.any(Function), true)
    expect(await service.requests.super_tabs({ action: 'teamSetup', reason: 'manual' }, owner)).toEqual({ ok: true, state: 'started' })
    expect(offer).toHaveBeenLastCalledWith('manual', expect.any(Function), false)
    expect(await service.requests.super_tabs({ action: 'teamSetupDecline' }, owner)).toEqual({ ok: true })
    expect(decline).toHaveBeenCalledOnce()
    for (const action of ['teamSetupCheck', 'teamSetupDecline']) {
      expect(await service.requests.super_tabs({ action, reason: 'join' }, visitor)).toEqual({ error: 'OWNER_REQUIRED' })
    }
    expect(await service.requests.super_tabs({ action: 'teamSetupCheck', reason: 'later' }, owner)).toEqual({ error: 'INVALID_REQUEST' })
  })

  it('offers nothing for a Swarm joined or added to that the team account is not tried in yet', async () => {
    const offer = vi.fn(async () => ({ state: 'wanted' as const }))
    const tabs: Record<string, Record<string, unknown>> = { elsewhere: { people: [{ id: 'me' }], teamAccounts: false }, mine: { people: [{ id: 'me' }] } }
    const backend = vi.fn<CoreApi['account']['backend']>(async (_method, path) => {
      const tab = tabs[path.split('/')[3]!]
      return tab ? { status: 200, body: { success: true, data: swarmReply(path, tab) } } : { status: 503, body: { success: false } }
    })
    const service = superTabService(fakeCore({ account: { backend } }), { teamSetup: async () => ({ offer, decline: vi.fn() }) })
    for (const reason of ['join', 'contribute']) {
      expect(await service.requests.super_tabs({ action: 'teamSetupCheck', reason, tabId: 'elsewhere' }, owner)).toEqual({ ok: true, state: 'not-used' })
    }
    expect(offer).not.toHaveBeenCalled()
    // Its own Swarm, one the server cannot read now, and an older Desktop that names none are offered, as before.
    for (const tabId of ['mine', 'unreadable', undefined]) {
      expect(await service.requests.super_tabs({ action: 'teamSetupCheck', reason: 'join', tabId }, owner)).toEqual({ ok: true, state: 'wanted' })
    }
    expect(offer).toHaveBeenCalledTimes(3)
  })

  it('tries again to make its setup when making it failed', async () => {
    const make = vi.fn().mockRejectedValueOnce(new Error('import failed')).mockResolvedValueOnce({ offer: async () => ({ state: 'exists' }), decline: vi.fn() })
    const service = superTabService(fakeCore(), { teamSetup: make })
    expect(await service.requests.super_tabs({ action: 'teamSetup', reason: 'join' }, owner)).toMatchObject({ error: 'SUPER_TAB_UNAVAILABLE' })
    expect(await service.requests.super_tabs({ action: 'teamSetup', reason: 'join' }, owner)).toEqual({ ok: true, state: 'exists' })
  })

  it('at app start, counts a Swarm this Mac is in with anyone else in it', async () => {
    const answers = (pools: unknown, tabs: Record<string, unknown>) => vi.fn<CoreApi['account']['backend']>(async (_method, path) => {
      if (path.includes('/hosts/')) return pools instanceof Error ? { status: 503, body: { success: false } }
        : { status: 200, body: { success: true, data: Array.isArray(pools) ? hostForm([], { pools }) : pools } }
      const tab = tabs[path.split('/')[3]!]
      return tab ? { status: 200, body: { success: true, data: swarmReply(path, tab as Record<string, unknown>) } } : { status: 403, body: { success: false, error: { code: 'FORBIDDEN' } } }
    })
    const sources = (call: CoreApi['account']['backend'], machineId = 'machine-1') => {
      const core = fakeCore({ account: { backend: call }, daemon: { machineId: () => machineId } as never })
      return { feed: new HostFeed(core, machineId), reads: new SwarmReads(core) }
    }
    const shared = answers([{ tabId: 'solo' }, { tabId: 'gone' }, { tabId: 'team' }],
      { solo: { people: [{ id: 'me' }] }, team: { people: [{ id: 'me' }, { id: 'kim' }] } })
    expect(await sharedSwarm(sources(shared))).toBe(true)
    // A Swarm the team account is not tried in yet (backend machines.ts teamAccountSwarm) does not count.
    expect(await sharedSwarm(sources(answers([{ tabId: 'team' }], { team: { people: [{ id: 'me' }, { id: 'kim' }], teamAccounts: false } })))).toBe(false)
    expect(shared.mock.calls.map(c => c[1])).toEqual(['/api/super-tabs/hosts/machine-1/changes?full=1',
      '/api/super-tabs/solo/parts', '/api/super-tabs/gone/parts', '/api/super-tabs/team/parts'])
    expect(await sharedSwarm(sources(answers([{ tabId: 'solo' }, { tabId: '../x' }], { solo: { people: [{ id: 'me' }] } })))).toBe(false)
    expect(await sharedSwarm(sources(answers(new Error('down'), {})))).toBe(false)
    expect(await sharedSwarm(sources(answers({ not: 'a host form' }, {})))).toBe(false)
    expect(await sharedSwarm(sources(answers([], {}), ''))).toBe(false)
  })
})

// Lead mentions (spec 2026-10-24-lead-mentions): a post names people by id or email; the backend gets their person ids,
// and only a Lead's help offers it.
describe('mentions on a post', () => {
  const people = [{ id: 'person-ken', email: 'Ken@Example.com', role: 'owner' }, { id: 'person-dee', email: 'dee@example.com', role: 'collaborator' }]
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

  it('refuses a person who is not in the Swarm before anything is sent', async () => {
    const t = setup()
    swarm(t, t.agentId)
    expect(await post(t, ['dee@example.com', 'someone@example.com'])).toEqual({ error: 'MENTION_UNKNOWN',
      detail: 'someone@example.com is not a person in this Swarm. Tag a person by the id or email shown in status.', status: 400 })
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
  it('offers --mention in help to a project\'s Lead only', async () => {
    const t = setup()
    swarm(t, t.agentId)
    const lead = await help(t, { tabId: 'tab', agentId: t.agentId })
    expect(lead.post).toContain(`post GROUP TEXT OPERATION_ID [--reply-to MESSAGE_ID] [--attach PATH]... ${mention}:`)
    expect(lead.post).toContain('--mention tags a person, by the id or email shown in status (up to 5), when you need them to act or decide; it shows in their notifications.')
    expect(await help(t, { tabId: 'tab', harnessId: 'native' })).toEqual(lead)
    // A former Lead still named on an older work group is not one, as in status.
    swarm(t, 'new-lead')
    expect(String((await help(t, { tabId: 'tab', agentId: t.agentId })).post)).not.toContain('--mention')
  })
  it('offers plan in help to a project\'s Lead only', async () => {
    const t = setup()
    swarm(t, t.agentId)
    expect(String((await help(t, { tabId: 'tab', agentId: t.agentId })).plan)).toContain('plan [JSON]: the best plan for all your open groups')
    swarm(t, 'new-lead')
    expect((await help(t, { tabId: 'tab', agentId: t.agentId })).plan).toBeUndefined()
  })

  it('tells every agent how to read its decisions and ask one through needs_human, and only a Lead how to ask a batch', async () => {
    const t = setup()
    swarm(t, t.agentId)
    const lead = await help(t, { tabId: 'tab', agentId: t.agentId })
    const plain = await help(t, {})
    for (const each of [lead, plain]) {
      expect(each.decisions).toContain('decisions [--answered]: the decisions you asked of people')
      expect(each.decisions).toContain('A decision is not a private channel')
      expect(each.commands).toContainEqual(expect.objectContaining({ type: 'work.status', status: 'needs_human',
        ask: { personId: 'PERSON', options: ['Option A', 'Option B'], recommended: 0, unblocks: 'What the answer unblocks' } }))
    }
    expect(lead.commands).toContainEqual(expect.objectContaining({ type: 'decision.ask', conversationId: 'GROUP', personId: 'PERSON' }))
    expect(plain.commands).not.toContainEqual(expect.objectContaining({ type: 'decision.ask' }))
  })

  it('answers help without --mention outside a tab, or when the caller cannot be read', async () => {
    const t = setup()
    swarm(t, t.agentId)
    const plain = await help(t, {})
    expect(String(plain.post)).not.toContain('--mention')
    expect(plain.leadOptions).toBe('Leads: run help with --tab ID for options only a Lead has.')
    expect(String((await help(t, { tabId: 'tab' })).post)).not.toContain('--mention')
    t.call.mockRejectedValue(new Error('Offline'))
    expect(String((await help(t, { tabId: 'tab', agentId: t.agentId })).post)).not.toContain('--mention')
    t.call.mockResolvedValue({ status: 200, body: { success: true, data: hostForm([], { tabs: ['tab'] }) } })
    expect(String((await help(t, { tabId: 'tab', agentId: t.agentId })).post)).not.toContain('--mention')
  })
})
