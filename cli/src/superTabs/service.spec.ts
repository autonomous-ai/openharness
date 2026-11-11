import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import type { CoreApi } from '../core/api.js'
import type { SaidOnCard } from './cards.js'
import { superTabService, type SuperTabServiceOptions } from './service.js'
import { GitHubStop } from './githubRest.js'
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
function setup(options: Pick<SuperTabServiceOptions, 'prepareContribution' | 'nextThings'> = {}) {
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
    expect(await service.port.swarmRole('old-native')).toEqual({ role: 'coordinator' })
    expect(await service.requests.super_tabs({ action: 'swarmRole', harnessId: 'old-native' }, owner)).toEqual({ ok: true, role: 'lead' })
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
  // role kinds reads too; a Reviewer's answer keeps its Reviewer kind.
  it('answers the core\'s role lookup in the values every core reads', async () => {
    const agent = { id: 'agent', machineId: 'machine-1', harnessId: 'old-native', role: 'reviewer' }
    const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => ({ status: 200, body: { data:
      path.includes('/hosts/') ? hostForm([{ tabId: 'tab', agent }]) : swarmReply(path, { agents: [agent], conversations: [{ leadId: 'other', agentIds: ['agent'] }] }) } }))
    const service = superTabService(fakeCore({ account: { backend: call } }))
    expect(await service.port.swarmRole('old-native')).toEqual({ role: 'agent', fallback: 'review' })
    expect(await service.requests.super_tabs({ action: 'swarmRole', harnessId: 'old-native' }, owner)).toEqual({ ok: true, role: 'review' })
    service.port.stop()
  })
  // The v3 Buddy is gone (backend S17): a row that still names an owner gets a role from its groups alone, as any agent's.
  it('gives no role to a row that names an owner and is in no open group', async () => {
    const agent = { id: 'agent', machineId: 'machine-1', harnessId: 'owned-native', buddyOf: { personId: 'person-1' } }
    const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => ({ status: 200, body: { data:
      path.includes('/hosts/') ? hostForm([{ tabId: 'tab', agent }]) : swarmReply(path, { agents: [agent], conversations: [{ id: 'chat', archived: true, agentIds: ['agent'] }] }) } }))
    const service = superTabService(fakeCore({ account: { backend: call } }))
    expect(await service.port.swarmRole('owned-native')).toBeNull()
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

describe('a post sent to an older backend', () => {
  const send = (t: ReturnType<typeof setup>, command: Record<string, unknown>) => t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'task-op', command }, owner)
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
  for (const action of ['backend', 'command', 'messages']) {
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
// The leaderboard's daemon half (superTabs/shipping.ts) runs while the host does: no host, no Swarm agents here to read for.
it('starts the leaderboard\'s reporter with the host and stops it with the service', async () => {
  const shipping = { start: vi.fn(), stop: vi.fn() }
  const service = superTabService(fakeCore({ account: { backend: vi.fn() } }), { host: () => ({ machineId: 'machine-1', start: vi.fn(), stop: vi.fn() }) as unknown as SuperTabHost, shipping: () => shipping })
  expect(shipping.start).not.toHaveBeenCalled()
  expect(await service.requests.super_tabs({ action: 'wake' }, owner)).toEqual({ ok: true })
  expect(shipping.start).toHaveBeenCalledOnce()
  service.port.disconnected()
  expect(shipping.stop).toHaveBeenCalledOnce()
})
// An agent's answer to its launch line, posted in its chat (superTabs/firstAnswers.ts), looked for while the host runs.
it('starts the first answers with the host and stops them with the service', async () => {
  const firstAnswers = { start: vi.fn(), stop: vi.fn() }
  const service = superTabService(fakeCore({ account: { backend: vi.fn() } }), { host: () => ({ machineId: 'machine-1', start: vi.fn(), stop: vi.fn() }) as unknown as SuperTabHost,
    shipping: () => ({ start: vi.fn(), stop: vi.fn() }), firstAnswers: () => firstAnswers })
  expect(firstAnswers.start).not.toHaveBeenCalled()
  expect(await service.requests.super_tabs({ action: 'wake' }, owner)).toEqual({ ok: true })
  expect(firstAnswers.start).toHaveBeenCalledOnce()
  service.port.disconnected()
  expect(firstAnswers.stop).toHaveBeenCalledOnce()
})
// Swarm plan, step 1, item 1: an agent's next thing, typed as its turn ends (nextThing.ts), with the host.
it('starts the next things with the host and stops them with the service', async () => {
  const nextThings = { start: vi.fn(), stop: vi.fn(), inbox: vi.fn() }
  const service = superTabService(fakeCore({ account: { backend: vi.fn() } }), { host: () => ({ machineId: 'machine-1', start: vi.fn(), stop: vi.fn() }) as unknown as SuperTabHost,
    shipping: () => ({ start: vi.fn(), stop: vi.fn() }), firstAnswers: () => ({ start: vi.fn(), stop: vi.fn() }), nextThings: () => nextThings })
  expect(nextThings.start).not.toHaveBeenCalled()
  expect(await service.requests.super_tabs({ action: 'wake' }, owner)).toEqual({ ok: true })
  expect(nextThings.start).toHaveBeenCalledOnce()
  service.port.disconnected()
  expect(nextThings.stop).toHaveBeenCalledOnce()
})
// Swarm plan, step 1, item 2: what waits for the agent that asks, as its turns' ends type it (nextThing.ts inbox).
it('lists what waits for the agent in its own pane, and says a GitHub failure by its code', async () => {
  const inbox = vi.fn(async (_harnessId: string) => ['Next: acme/app#12 Fix the login bug. …'])
  const t = setup({ nextThings: () => ({ start: vi.fn(), stop: vi.fn(), inbox }) })
  expect(await t.ask({ action: 'inbox', harnessId: 'native' }, owner)).toEqual({ ok: true, value: { waiting: ['Next: acme/app#12 Fix the login bug. …'] } })
  expect(inbox).toHaveBeenCalledWith('native')
  inbox.mockRejectedValueOnce(new GitHubStop('RATE_LIMITED', 'GitHub asks to wait until 14:05.', true, 0))
  expect(await t.ask({ action: 'inbox', harnessId: 'native' }, owner)).toEqual({ error: 'RATE_LIMITED', detail: 'GitHub asks to wait until 14:05.' })
  inbox.mockRejectedValueOnce(new Error('Disk full'))
  expect(await t.ask({ action: 'inbox', harnessId: 'native' }, owner)).toEqual({ error: 'SUPER_TAB_UNAVAILABLE', detail: 'Disk full' })
  // Only an agent asks it, for itself.
  expect(await t.ask({ action: 'inbox', harnessId: 'stranger' }, owner)).toMatchObject({ error: 'NOT_IN_SWARM' })
  expect(inbox).toHaveBeenCalledTimes(3)
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
it('sends no refusal the server dropped', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const sources = readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  expect(sources.length).toBeGreaterThan(20)
  expect(sources.filter(f => /'(LEAD_REQUIRED|TASK_REQUIRED)'/.test(readFileSync(join(dir, f), 'utf8')))).toEqual([])
})
// Swarm v4 (2026-11-09): an agent its person only talks to in their 1:1 chat is never told its Swarm's id, and the basics tell
// it to post in its project's channel: in its own pane, the one Swarm it is in is meant.
it('serves an agent in its own pane that leaves its Swarm out, in the one Swarm it is in', async () => {
  const t = setup()
  expect(await t.ask({ action: 'status', harnessId: 'native' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab/parts?asAgentId=${t.agentId}`, undefined)
  // One in no Swarm is told so: "Name the Swarm with --tab ID." sent it looking for an id it has none of (Q3, 2026-11-09).
  // Named, so a caller can tell it from a bad request; and it may be in one this machine cannot reach (its access or billing).
  expect(await t.ask({ action: 'status', harnessId: 'stranger' }, owner)).toEqual({ error: 'NOT_IN_SWARM', detail: 'This agent is not in a Swarm '
    + 'on this machine\'s roster. If it should be, this machine may have no access to it, or its billing does not allow it: check how this machine is shared.' })
})
it('asks an agent in two Swarms to name one', async () => {
  const agent = { id: 'a', machineId: 'machine-1', harnessId: 'native' }
  const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => ({ status: 200, body: { success: true, data: path.includes('/hosts/')
    ? hostForm([{ tabId: 'tab', agent }, { tabId: 'other', agent }], { tabs: ['tab', 'other'] }) : { state: { agents: [agent] } } } }))
  const service = superTabService(fakeCore({ account: { backend: call }, agents: { byAgent: vi.fn(() => ({ agentId: 'native' }) as never) } }),
    { host: () => ({ machineId: 'machine-1', start: vi.fn(), stop: vi.fn() }) as unknown as SuperTabHost })
  expect(await service.requests.super_tabs({ action: 'status', harnessId: 'native' }, owner))
    .toEqual({ error: 'SWARM_AMBIGUOUS', detail: 'This agent is in 2 Swarms: name one with --tab (tab, other).' })
})
it('resolves a native caller to its exact contribution and rechecks it before every agent command', async () => {
  const t = setup()
  expect(await t.ask({ action: 'messages', tabId: 'tab', harnessId: 'native', conversationId: 'lead' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab/parts?asAgentId=${t.agentId}`, undefined)
  const command = { type: 'message.send', conversationId: 'lead', text: 'Ready', replyTo: null, recipientIds: [] }
  expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'op', command }, owner)).toMatchObject({ ok: true, operationId: 'op' })
  expect(t.call).toHaveBeenLastCalledWith('POST', '/api/super-tabs/tab/commands', { operationId: 'op', command, asAgentId: t.agentId })
  expect(await t.ask({ action: 'message', tabId: 'tab', agentId: t.agentId, conversationId: 'lead', messageId: 'old-question' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenCalledWith('GET', `/api/super-tabs/tab/conversations/lead/messages?asAgentId=${t.agentId}&messageId=old-question`, undefined)
  t.agent.machineId = 'another-machine'
  expect(await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'lead' }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
  t.agent.machineId = 'machine-1'; vi.mocked(t.core.agents.byAgent).mockReturnValue(undefined)
  expect(await t.ask({ action: 'messages', tabId: 'tab', agentId: t.agentId, conversationId: 'lead' }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
})

// Security review of #2087: a harness that names another agent with --agent spoke as it. The CLI
// now says which harness asks, and the agent it names must be that harness's own.
it('refuses a harness that names another agent, for posts and message reads, and serves its own', async () => {
  const t = setup()
  const post = { type: 'message.send', conversationId: 'lead', text: 'Ready', replyTo: null, recipientIds: [] }
  const asks = [{ action: 'command', operationId: 'op-1', command: post }, { action: 'message', conversationId: 'lead', messageId: 'old-question' }, { action: 'messages', conversationId: 'lead' }]
  for (const ask of asks) {
    t.call.mockClear()
    expect(await t.ask({ ...ask, tabId: 'tab', agentId: t.agentId, harnessId: 'other-pane' }, owner)).toEqual({
      error: 'AGENT_MISMATCH', detail: 'This harness may speak only as its own Swarm agent. Run the command without --agent, or with its own id.' })
    expect(t.call.mock.calls.filter(([method]) => method === 'POST')).toEqual([])
    expect(await t.ask({ ...ask, tabId: 'tab', agentId: t.agentId, harnessId: 'native' }, owner)).toMatchObject({ ok: true })
  }
})

// Second security review of #2087: from an agent's pane, --machine sent its request to the owner's other Mac, where no
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
})

it('resolves a replacement terminal to the original stable member', async () => {
  const t = setup()
  t.agent.harnessId = 'replacement'
  expect(await t.ask({ action: 'messages', tabId: 'tab', harnessId: 'replacement', conversationId: 'lead' }, owner)).toMatchObject({ ok: true })
  expect(t.call).toHaveBeenLastCalledWith('GET', `/api/super-tabs/tab/parts?asAgentId=${t.agentId}`, undefined)
  expect(await t.ask({ action: 'messages', tabId: 'tab', harnessId: 'native', conversationId: 'lead' }, owner)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
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

// Swarm v4: an agent has the chat's reads and its posts, and no manual. A session from before gets INVALID_REQUEST, as the route's did.
it('has no agent action but status and the chat\'s own: each other is refused, and the Swarm and the server are read for none', async () => {
  const t = setup()
  for (const action of ['mine', 'task', 'decisions', 'instructions', 'costs', 'help', 'startStatus', 'proposalTarget', 'setMachineAgents',
    'routeContext', 'routeHistory', 'machineRules', 'ciLoad', 'routeJev']) {
    t.call.mockClear()
    expect(await t.ask({ action, tabId: 'tab', agentId: t.agentId, conversationId: 'g1', startId: 'start-1', state: 'open', days: 7, machineId: 'studio', maxAgents: 8 }, owner), action)
      .toEqual({ error: 'INVALID_REQUEST' })
    // Only the host's roster is read, to know the caller: nothing of the Swarm, and nothing is sent.
    expect(t.call.mock.calls.filter(([method, path]) => method !== 'GET' || !String(path).includes('/hosts/')), action).toEqual([])
  }
})

// A process that writes to the daemon's socket gets what the CLI's parser gives: only what an agent's commands send goes out as the agent.
it('sends as the agent only a post, an answer and its terminal commands: every other command type is refused, and nothing is sent', async () => {
  const t = setup()
  for (const type of ['work.assign', 'agent.start', 'message.react', 'agent.release', 'work.status', 'conversation.create',
    'machine.remove', 'agent.setUp', 'tab.tidy', 'decision.ask', 'instructions.save', undefined, 7]) {
    t.call.mockClear()
    expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: 'op-1', command: { type, conversationId: 'g1' } }, owner), String(type))
      .toEqual({ error: 'INVALID_REQUEST' })
    // Only the host's roster is read, to know the caller: nothing is sent.
    expect(t.call.mock.calls.filter(([method, path]) => method !== 'GET' || !String(path).includes('/hosts/')), String(type)).toEqual([])
  }
  for (const command of [{ type: 'message.send', conversationId: 'g1', text: 'Hi', replyTo: null, recipientIds: [] },
    { type: 'agent.screen', agentId: 'other' }, { type: 'agent.input', agentId: 'other', text: 'y' }]) {
    expect(await t.ask({ action: 'command', tabId: 'tab', agentId: t.agentId, operationId: `op-${command.type.replace('.', '-')}`, command }, owner), command.type).toMatchObject({ ok: true })
  }
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

  it('runs a person\'s Swarm host only once it hosts Swarm work', () => {
    const start = vi.fn()
    const service = superTabService(fakeCore({ dataDir: mkdtempSync(join(tmpdir(), 'host-wake-')) }),
      { githubTokens: () => ({ start: vi.fn(), stop: vi.fn() }), host: () => ({ machineId: 'machine-1', start, stop: vi.fn() }) as unknown as SuperTabHost })
    service.port.connected()
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps the tokens fresh while connected, and stops with the service', () => {
    const tokens = { start: vi.fn(), stop: vi.fn() }
    const service = superTabService(fakeCore(), { githubTokens: () => tokens })
    service.port.connected()
    expect(tokens.start).toHaveBeenCalledTimes(1)
    service.port.disconnected()
    service.port.stop()
    expect(tokens.stop).toHaveBeenCalledTimes(2)
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
      expect(await service.requests.super_tabs({ action }, owner)).toEqual({ error: 'INVALID_REQUEST', detail: 'Name the Swarm with --tab ID.' })
    }
    expect(make).not.toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
  })
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

// Lead mentions (spec 2026-10-24-lead-mentions): a post names people by id or email; the backend gets their person ids.
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

})

describe('a conversation\'s pages and threads', () => {
  const pages = () => {
    const t = setup()
    t.call.mockImplementation(async (_method, path) => ({ status: 200, body: { success: true, data: path.includes('/messages?') ? { messages: [], next: null } : swarmData(t.agent, path) } }))
    return t
  }

  it('pages a task\'s older messages', async () => {
    const t = pages()
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
    const t = pages()
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
})

// Task steps design: a task's chat shows its steps' rows by time.
describe('a task\'s steps in messages', () => {
  const ok = (data: unknown) => ({ status: 200, body: { success: true, data } })
  const row = (id: string, conversationId: string, createdAt: string) => ({ id, conversationId, createdAt, text: id, author: { name: 'A' } })
  const conversations = [{ id: 'g1835', number: 1835, title: 'Fix login', archived: false, checks: [] },
    { id: 'g1918', number: 1918, title: 'Review', reviewOf: 'g1835', step: 'Thiết kế "v2"', archived: false, checks: [] },
    { id: 'g1919', number: 1919, title: 'Test', reviewOf: 'g1835', step: 'Test', archived: false, checks: [] }]
  function wired(t: ReturnType<typeof setup>, options: { steps?: boolean; failing?: string } = {}) {
    vi.mocked(t.core.account.backend).mockImplementation(async (_method, path) => {
      const read = /\/conversations\/(g\d+)\/messages\?/.exec(path)
      if (read) {
        if (read[1] === options.failing) return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'No' } } } as never
        const rows = { g1835: [row('t1', 'g1835', '2026-11-02T09:00:00Z'), row('t2', 'g1835', '2026-11-02T09:10:00Z')],
          g1918: [row('s1', 'g1918', '2026-11-02T09:05:00Z')], g1919: [row('u1', 'g1919', '2026-11-02T09:15:00Z')] }[read[1]!] ?? []
        return ok({ messages: rows, next: null, threads: [] }) as never
      }
      const data = swarmData(t.agent, path, { agents: [t.agent], conversations })
      return ok(options.steps && /\/parts/.test(path) ? { ...object(data), steps: true } : data) as never
    })
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
})

// A reader's verdict is made by command in its own pane (githubVerdict.ts): the daemon posts it and tells the backend whose it is.
describe('a verdict by command', () => {
  const HEAD = 'f6edb44c0ffee0000000000000000000000000ab'
  function verdictSetup(given: Record<string, unknown> = {}) {
    const agentId = createHash('sha256').update(JSON.stringify(['machine-1', 'native'])).digest('hex').slice(0, 24)
    const agent = { id: agentId, machineId: 'machine-1', harnessId: 'native', displayName: 'Juno', contributorId: 'me', machineOwnerId: 'me', ...given }
    const state = { agents: [agent], projects: [{ id: 'app', repository: { repositoryUrl: 'https://github.com/Acme/App.git' } }] }
    const call = vi.fn<CoreApi['account']['backend']>(async (_method, path) => ({ status: 200, body: { success: true,
      data: path.includes('/github-comments') ? { recorded: true } : swarmData(agent, path, state) } }))
    const core = fakeCore({ account: { backend: call, identity: vi.fn(async () => ({ accountId: 'me' }) as never) }, agents: { byAgent: vi.fn(() => ({ agentId: 'native' }) as never) } })
    const sent: Array<{ path: string; body: unknown }> = []
    const github = { get: vi.fn(async (path: string): Promise<{ status: number; etag: null; resetAt: null; body: unknown }> => ({ status: 200, etag: null, resetAt: null,
      body: path === '/user' ? { login: 'reader-login' } : path.includes('/comments') ? [] : { state: 'open', head: { sha: HEAD, ref: 'pip/12' }, labels: [{ name: 'builder:pip' }] } })),
      send: vi.fn(async (_method: string, path: string, body?: unknown): Promise<{ status: number; etag: null; resetAt: null; body: unknown }> => { sent.push({ path, body })
        return { status: 201, etag: null, resetAt: null, body: { id: 9001, html_url: 'https://github.com/acme/app/pull/27#issuecomment-9001' } } }) }
    const service = superTabService(core, { host: () => ({ machineId: 'machine-1', start: vi.fn(), stop: vi.fn() }) as unknown as SuperTabHost, github: () => github })
    const read = (extra: Record<string, unknown> = {}) => service.requests.super_tabs({ action: 'read', tabId: 'tab', harnessId: 'native', repository: 'acme/app', number: 27,
      verdict: 'READ-OK', sha: 'f6edb44', text: 'Ran the tests.', ...extra }, owner)
    return { service, call, sent, github, agentId, read }
  }
  it('posts it under the calling agent\'s name on its project\'s repository, and records the comment as that agent\'s', async () => {
    const t = verdictSetup()
    expect(await t.read()).toEqual({ ok: true, value: { url: 'https://github.com/acme/app/pull/27#issuecomment-9001', head: HEAD, posted: true } })
    expect(t.sent).toEqual([{ path: '/repos/acme/app/issues/27/comments', body: { body: expect.stringMatching(new RegExp(`^Juno, \\d\\d:\\d\\d: READ-OK ${HEAD}\\n\\nRan the tests\\.$`)) } }])
    expect(t.call).toHaveBeenCalledWith('POST', `/api/super-tabs/tab/github-comments?asAgentId=${t.agentId}`, { repository: 'acme/app', kind: 'issue', commentId: '9001' })
    t.service.port.stop()
  })
  it('refuses a request that is no verdict, a repository of no project of the agent\'s, and another computer\'s caller, and posts nothing', async () => {
    const t = verdictSetup()
    expect(await t.read({ sha: 'HEAD' })).toEqual({ error: 'INVALID_REQUEST' })
    expect(await t.read({ repository: 'other/thing' })).toMatchObject({ error: 'REPOSITORY_NOT_PROJECT', status: 422 })
    expect(await t.service.requests.super_tabs({ action: 'read', tabId: 'tab', harnessId: 'native', repository: 'acme/app', number: 27, verdict: 'READ-OK', sha: 'f6edb44', text: '' },
      { local: false, owner: true, accountOwner: true })).toMatchObject({ error: 'AGENT_LOCAL_ONLY' })
    expect(t.sent).toEqual([])
    expect(t.github.get).not.toHaveBeenCalled()
    t.service.port.stop()
  })
  it('takes a task as the calling agent, under its name, and records its claim as that agent\'s', async () => {
    const t = verdictSetup()
    t.github.get.mockImplementation(async (path: string) => ({ status: 200, etag: null, resetAt: null,
      body: /\/issues\/34$/.test(path) ? { number: 34, state: 'open', labels: [{ name: 'builder:juno' }], html_url: 'https://github.com/acme/app/issues/34' }
        : [] }))
    t.github.send.mockImplementation(async (_method: string, path: string, body?: unknown) => { t.sent.push({ path, body })
      return path.endsWith('/labels') ? { status: 200, etag: null, resetAt: null, body: [{ name: 'builder:juno' }, { name: 'status:taken' }] }
        : { status: 201, etag: null, resetAt: null, body: { id: 9001, html_url: 'https://github.com/acme/app/pull/27#issuecomment-9001' } } })
    expect(await t.service.requests.super_tabs({ action: 'take', tabId: 'tab', harnessId: 'native', repository: 'acme/app', number: 34 }, owner))
      .toEqual({ ok: true, value: { url: 'https://github.com/acme/app/pull/27#issuecomment-9001', taken: true } })
    expect(t.sent.map(sent => sent.path)).toEqual(['/repos/acme/app/issues/34/labels', '/repos/acme/app/issues/34/comments'])
    expect(t.sent[1]!.body).toEqual({ body: expect.stringMatching(/^Juno, \d\d:\d\d: taken by Juno$/) })
    expect(t.call).toHaveBeenCalledWith('POST', `/api/super-tabs/tab/github-comments?asAgentId=${t.agentId}`, { repository: 'acme/app', kind: 'issue', commentId: '9001' })
    expect(await t.service.requests.super_tabs({ action: 'take', tabId: 'tab', harnessId: 'native', repository: 'acme/app', number: 0 }, owner)).toEqual({ error: 'INVALID_REQUEST' })
    t.service.port.stop()
  })
  // The CLI gives up after 30 seconds and says "Try again" while the daemon works on: the same command again joins the one
  // still running, and posts nothing of its own (the second review of #3907).
  it('does a command that arrives again while the first still runs once, and answers both', async () => {
    const t = verdictSetup()
    t.github.get.mockImplementation(async (path: string) => ({ status: 200, etag: null, resetAt: null,
      body: /\/issues\/34$/.test(path) ? { number: 34, state: 'open', labels: [{ name: 'builder:juno' }] } : [] }))
    t.github.send.mockImplementation(async (_method: string, path: string, body?: unknown) => { t.sent.push({ path, body })
      return path.endsWith('/labels') ? { status: 200, etag: null, resetAt: null, body: [{ name: 'builder:juno' }, { name: 'status:taken' }] }
        : { status: 201, etag: null, resetAt: null, body: { id: 9001, html_url: 'https://github.com/acme/app/issues/34#issuecomment-9001' } } })
    const take = () => t.service.requests.super_tabs({ action: 'take', tabId: 'tab', harnessId: 'native', repository: 'acme/app', number: 34 }, owner)
    const answers = await Promise.all([take(), take()])
    expect(answers).toEqual(Array(2).fill({ ok: true, value: { url: 'https://github.com/acme/app/issues/34#issuecomment-9001', taken: true } }))
    expect(t.sent.map(sent => sent.path)).toEqual(['/repos/acme/app/issues/34/labels', '/repos/acme/app/issues/34/comments'])
    t.service.port.stop()
    // A verdict the same way; another verdict on the same head is its own command.
    const u = verdictSetup()
    const reads = await Promise.all([u.read(), u.read(), u.read({ verdict: 'HOLD', text: 'It breaks the build.' })])
    expect(reads.map(read => 'ok' in read)).toEqual([true, true, true])
    expect(u.sent.map(sent => String((sent.body as { body: string }).body).split('\n')[0]!.replace(/^Juno, \d\d:\d\d: /, ''))).toEqual([`READ-OK ${HEAD}`, `HOLD ${HEAD}`])
    u.service.port.stop()
  })
  // Review of #3902: this computer's gh login is its person's, so only that person's own agent here posts with it, as GitHub
  // news and the merger read with it only for such an agent (githubMentions.ts watchedAgents, githubMerge.ts ledProjects).
  it('posts with this computer\'s GitHub login only for its own person\'s agent, and signs with the agent\'s name when it has no display name', async () => {
    for (const other of [{ contributorId: 'mate' }, { machineOwnerId: 'mate' }]) {
      const t = verdictSetup(other)
      expect(await t.read()).toEqual({ error: 'AGENT_UNAVAILABLE', detail: 'A verdict is posted with its person\'s own GitHub login, on that person\'s computer.' })
      expect(await t.service.requests.super_tabs({ action: 'take', tabId: 'tab', harnessId: 'native', repository: 'acme/app', number: 34 }, owner))
        .toEqual({ error: 'AGENT_UNAVAILABLE', detail: 'A task is taken with its person\'s own GitHub login, on that person\'s computer.' })
      expect(t.github.get).not.toHaveBeenCalled()
      t.service.port.stop()
    }
    const t = verdictSetup({ displayName: '  ', name: 'Atlas' })
    expect(await t.read()).toMatchObject({ ok: true })
    expect(t.sent[0]?.body).toEqual({ body: expect.stringMatching(/^Atlas, /) })
    t.service.port.stop()
  })
})
