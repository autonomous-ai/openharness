import { describe, expect, it, vi, type Mock } from 'vitest'
import type { openDaemon } from '../agentClient/daemon.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeTask } from './routeCommand.js'
import type { describeScmProject } from '../scm/scmProjects.js'
import { admission, quotaOf } from './capacity.js'

const policy = { version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: '', models: [
  { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: true },
  { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: false },
] }
const agents = [
  { id: 'a1', name: 'Multiply', machineId: 'm1', harnessId: 'h1', configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' } },
  { id: 'lead', name: 'Lead', machineId: 'm1', harnessId: 'hl', configuration: { engine: 'claude', model: 'opus', effort: 'high' } },
]
const conversations = (assignment: unknown = null) => [
  { id: 'lead', title: 'Lead', leadId: 'lead', agentIds: ['lead', 'a1'], archived: false, brief: '', checks: [], assignment: null },
  { id: 'g1', title: 'API', leadId: 'lead', agentIds: ['lead'], archived: false, brief: 'Add the endpoint.', checks: [{ description: 'Tests pass' }], assignment },
]
const tab = (assignment: unknown = null) => ({ revision: 3, state: { id: 'tab', agents, conversations: conversations(assignment) } })
const usage = { providers: [{ provider: 'claude', outcome: 'answered', httpStatus: 200, account: 'acct', body: { five_hour: { utilization: 40, resets_at: '2026-10-19T12:00:00Z' }, seven_day: { utilization: 10 } } }] }
function daemon(machineId: string, options: { agents?: string[]; frames?: Record<string, Record<string, unknown>>; capacity?: Record<string, unknown>; terminalAvailable?: boolean; tools?: Record<string, boolean>; devices?: Record<string, boolean>; usage?: unknown; listFails?: boolean; engines?: unknown } = {}) {
  return {
    machineId, close: vi.fn(),
    request: vi.fn(async (type: string, _payload?: unknown, _timeout?: number) => {
      if (type === 'agents_list') {
        if (options.listFails) throw new Error('timeout')
        return { agents: (options.agents ?? []).map(id => ({ id, terminal: { available: options.terminalAvailable ?? true }, ...options.frames?.[id] })) }
      }
      if (type === 'super_tabs') return options.capacity ?? { resources: { memoryTotalBytes: 8e9, memoryUsedBytes: 1e9, cpuPercent: 10, projectDiskFreeBytes: 1e11 }, tools: options.tools ?? { git: true }, devices: options.devices ?? {} }
      if (type === 'engines_probe') return { engines: options.engines ?? [{ engine: 'claude', installed: true, signedIn: true }] }
      if (type === 'usage_read') return options.usage ?? usage
      return {}
    }),
  }
}
type Answer = Record<string, unknown>
function scoped(answers: { jev?: Answer; record?: Answer; tab?: unknown; context?: Answer; history?: Answer; historyHangs?: boolean; jevThrows?: boolean; recordThrows?: boolean } = {}) {
  return vi.fn(async (payload: Record<string, any>): Promise<Record<string, unknown>> => {
    if (payload.action === 'routeContext') return answers.context ?? { ok: true, value: { agentId: 'lead', tab: answers.tab ?? tab(), policy: { policy, warnings: ['w'] }, machines: [{ machineId: 'm1', name: 'remote-1' }, { machineId: 'm2', name: 'mac' }] } }
    if (payload.action === 'routeHistory') return answers.historyHangs ? new Promise(() => {}) : answers.history ?? { ok: true, value: { messages: [], decisions: [], attempts: [] } }
    if (payload.action === 'routeJev') {
      if (answers.jevThrows) throw new Error('socket closed')
      // Jev answers over every candidate it was shown, as the real client's answers do.
      const ids = Object.keys(payload.questions.who.criteria)
      return answers.jev ?? { ok: true, value: { answers: { who: { choice: 'c1', probabilities: Object.fromEntries(ids.map(id => [id, id === 'c1' ? 0.9 : 0.1 / (ids.length - 1)])) } } } }
    }
    if (payload.action === 'command') {
      if (answers.recordThrows) throw new Error('socket closed')
      return answers.record ?? { ok: true, value: { result: { routeDecisionId: 'd1' } } }
    }
    return { error: 'UNEXPECTED' }
  })
}
const where = { port: 1, dataDir: '/nonexistent', machineId: 'm1' }
const input = { tabId: 'tab', conversationId: 'g1', assessment: { difficulty: 'medium', risk: 'low', why: 'Endpoint.' } }
const opener = (make: (id: string) => ReturnType<typeof daemon> = id => daemon(id, { agents: id === 'm1' ? ['h1'] : [] })) => vi.fn(async (_w: unknown, id = '') => make(id)) as unknown as typeof openDaemon & Mock
const recorded = (s: ReturnType<typeof scoped>) => s.mock.calls.find(c => c[0].action === 'command')![0]
const jevCall = (s: ReturnType<typeof scoped>) => s.mock.calls.find(c => c[0].action === 'routeJev')![0]

describe('routeTask', () => {
  it('collects members and new agents, asks Jev, records and returns the pick', async () => {
    const s = scoped()
    const result = await routeTask(input, s, where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, routeDecisionId: 'd1', via: 'jev', pick: { id: 'c1' }, warnings: ['w'] })
    const record = recorded(s)
    expect(record).toMatchObject({ operationId: 'route-op', command: { type: 'route.record', conversationId: 'g1' } })
    // The idle Lead is not a candidate (neither the group's nor the tab's); the idle member Multiply is.
    const titles = (record.command.decision.candidates as Array<{ title: string }>).map(c => c.title)
    expect(titles).toContain('Multiply · Claude sonnet medium · remote-1')
    expect(titles.some(t => t.startsWith('Lead'))).toBe(false)
    expect((result.alternatives as unknown[]).length).toBeLessThanOrEqual(2)
    expect(titles.some(t => /^Lead|\bLead\b/.test(t.split(' · ')[0]))).toBe(false)
    // The Lead's id is never offered either, even where the group's Lead and the tab Lead differ.
    const other = tab(); (other.state.conversations[1] as Record<string, unknown>).leadId = 'a1'
    const t = scoped({ tab: other, context: { ok: true, value: { agentId: 'a1', tab: other, policy: { policy }, machines: [{ machineId: 'm1', name: 'remote-1' }] } } })
    await routeTask(input, t, where as never, opener(), () => 'op')
    const offered = (recorded(t).command.decision.candidates as Array<{ title: string }>).map(c => c.title)
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.some(c => /^(Lead|Multiply) ·/.test(c))).toBe(false)
  })
  it('tells the Lead how to assign a member or start a new agent with the decision', async () => {
    const member = await routeTask(input, scoped({ jev: { ok: true, value: { unavailable: 'BUSY' } } }), where as never, opener(), () => 'op')
    // Cheapest first: the member on sonnet.
    expect(member).toMatchObject({ pick: { kind: 'member', agentId: 'a1' } })
    expect(member.next).toContain('"type":"work.assign","conversationId":"g1","agentId":"a1","routeDecisionId":"d1"')
    const fresh = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high' } }, scoped({ jev: { ok: true, value: { unavailable: 'BUSY' } } }), where as never, opener(), () => 'op')
    expect(fresh).toMatchObject({ pick: { kind: 'new', engine: 'claude', model: 'opus', effort: 'high' } })
    expect(fresh.next).toContain('"engine":"claude","model":"opus","effort":"high","routeDecisionId":"d1"')
    // A complete start: every field its schema requires, with the defaults the help gives.
    const hint = JSON.parse(/start OPERATION_ID (\{.*\}), then/.exec(fresh.next as string)![1]!)
    expect(hint).toEqual({ conversationId: 'g1', name: 'Builder', cwd: '/absolute/repo/on/that/machine', worktree: true,
      requirements: { memoryBytes: 2147483648, diskBytes: 10737418240, maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false },
      machineId: 'm2', engine: 'claude', model: 'opus', effort: 'high', routeDecisionId: 'd1' })
    // The task's own repository, when the assessment named one, and no decision when none was recorded.
    const placed = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high', needs: { cwd: '/repo/api' } } },
      scoped({ record: { error: 'BACKEND_UNAVAILABLE' } }), where as never, opener(), () => 'op')
    expect(JSON.parse(/start OPERATION_ID (\{.*\}), then/.exec(placed.next as string)![1]!)).toMatchObject({ cwd: '/repo/api' })
    expect(placed.next).not.toContain('routeDecisionId')
  })
  it('admits the pick on the requirements its start hint asks for, with the task\'s tools and devices', async () => {
    const needs = { tools: ['git', 'docker'], devices: ['/dev/ttyUSB0'] }
    const hard = { ...input, assessment: { ...input.assessment, difficulty: 'high', needs } }
    const daemons: ReturnType<typeof daemon>[] = []
    const make = opener((id) => { const d = daemon(id, { tools: { git: true, docker: true }, devices: { '/dev/ttyUSB0': true } }); daemons.push(d); return d })
    const result = await routeTask(hard, scoped(), where as never, make, () => 'op')
    const hint = JSON.parse(/start OPERATION_ID (\{.*\}), then/.exec(result.next as string)![1]!)
    expect(hint.requirements).toEqual({ memoryBytes: 2147483648, diskBytes: 10737418240, maxCpuPercent: 100, tools: ['git', 'docker'], devices: ['/dev/ttyUSB0'], quotaRequired: false })
    // The probe asked each machine about the same tools and devices, so what it admitted starts.
    const capacity = daemons.flatMap(d => d.request.mock.calls).filter(c => c[0] === 'super_tabs').map(c => c[1] as Record<string, unknown>)
    expect(capacity.length).toBeGreaterThan(0)
    for (const asked of capacity) expect(asked).toMatchObject({ tools: ['git', 'docker'], devices: ['/dev/ttyUSB0'] })
  })
  it('keeps a machine in the route when its CPU reads busy, because CPU use is only a momentary reading', async () => {
    const make = opener(id => {
      const d = daemon(id, { agents: id === 'm1' ? ['h1'] : [] }), request = d.request.getMockImplementation()!
      d.request.mockImplementation(async (type, payload, ms) => type === 'super_tabs' && (payload as Record<string, unknown>)?.action === 'capacity'
        ? { resources: { memoryTotalBytes: 8e9, memoryUsedBytes: 1e9, cpuPercent: 98, projectDiskFreeBytes: 1e11 }, tools: { git: true }, devices: {} }
        : request(type, payload, ms))
      return d
    })
    const result = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high' } }, scoped(), where as never, make, () => 'op')
    expect(result).toMatchObject({ ok: true, pick: { kind: 'new' } })
  })
  it('warns when the account\'s machines could not be read, and still offers the Lead\'s own machine', async () => {
    const context = { ok: true, value: { agentId: 'lead', tab: tab(), policy: { policy, warnings: ['w'] }, machines: [], machinesUnreadable: true } }
    const result = await routeTask(input, scoped({ context }), where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, warnings: ['w', "The account's machine list could not be read; only known machines were considered."] })
    const fine = await routeTask(input, scoped(), where as never, opener(), () => 'op')
    expect(fine.warnings).toEqual(['w'])
  })
  it('names a member that has no name, model or effort of its own, and leaves the decision blank when it is unrecorded', async () => {
    const plain = tab(); plain.state.agents = [{ id: 'a1', machineId: 'm1', harnessId: 'h1', configuration: { engine: 'claude' } }, agents[1]] as never
    const options = { tab: plain, record: { error: 'BACKEND_UNAVAILABLE' }, jev: { ok: true, value: { unavailable: 'BUSY' } } }
    const easy = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'low' } }, scoped(options), where as never, opener())
    expect(easy).toMatchObject({ unrecorded: true, pick: { kind: 'member', title: 'Member · Claude default default · remote-1' } })
    expect(easy.next).not.toContain('routeDecisionId')
    const hard = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high' } }, scoped(options), where as never, opener())
    expect(hard).toMatchObject({ unrecorded: true, pick: { kind: 'new' } })
    expect(hard.next).not.toMatch(/routeDecisionId"|same routeDecisionId/)
  })
  it('refuses a caller who is not the Lead of the group before probing anything', async () => {
    const open = vi.fn()
    const s = scoped({ context: { ok: true, value: { agentId: 'a1', tab: tab(), policy: { policy }, machines: [] } } })
    expect(await routeTask(input, s, where as never, open as never)).toMatchObject({ error: 'LEAD_REQUIRED' })
    expect(open).not.toHaveBeenCalled()
  })
  it('returns a Jev-stage refusal as the result instead of falling back to the policy order', async () => {
    for (const error of ['RATE_LIMITED', 'LEAD_REQUIRED']) {
      const s = scoped({ jev: { error, detail: 'no', status: 429 } })
      expect(await routeTask(input, s, where as never, opener())).toMatchObject({ error })
      expect(s.mock.calls.some(c => c[0].action === 'command')).toBe(false)
    }
  })
  it('returns a record refusal as an error, and only a transport failure as unrecorded', async () => {
    expect(await routeTask(input, scoped({ record: { error: 'RATE_LIMITED', detail: 'slow down', status: 429 } }), where as never, opener()))
      .toMatchObject({ error: 'RATE_LIMITED' })
    for (const error of ['BACKEND_UNAVAILABLE', 'BACKEND_TIMEOUT', 'BACKEND_UNREACHABLE', 'AGENT_UNAVAILABLE', 'SUPER_TAB_UNAVAILABLE']) {
      expect(await routeTask(input, scoped({ record: { error } }), where as never, opener())).toMatchObject({ ok: true, unrecorded: true })
    }
  })
  it('returns NO_CANDIDATE with reasons when every account machine is offline, without opening any', async () => {
    const open = vi.fn()
    const offline = { ok: true, value: { agentId: 'lead', tab: tab(), policy: { policy }, machines: [{ machineId: 'm1', name: 'remote-1', status: 'offline' }, { machineId: 'm2', name: 'mac', status: 'offline' }] } }
    const result = await routeTask(input, scoped({ context: offline }), where as never, open as never)
    expect(result).toMatchObject({ error: 'NO_CANDIDATE' })
    expect((result.excluded as Array<{ reason: string }>).every(e => /offline or unreachable/.test(e.reason))).toBe(true)
    expect((result.excluded as unknown[]).length).toBeGreaterThan(2)
    expect(open).not.toHaveBeenCalled()
  })
  it('keeps a member on a machine this account cannot open as unknown, not offline, and routes to it when nothing known is left', async () => {
    const s = scoped()
    const open = vi.fn(async () => { throw Object.assign(new Error('gone'), { code: 'MACHINE_UNAVAILABLE' }) })
    const result = await routeTask(input, s, where as never, open as never)
    expect(result).toMatchObject({ ok: true, pick: { kind: 'member', agentId: 'a1' } })
    const decision = recorded(s).command.decision
    expect(decision.candidates).toHaveLength(1)
    // New agents there stay excluded: nothing can start on a machine nobody can open.
    expect(decision.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'Machine is offline or unreachable.' })]))
    expect(decision.excluded.some((e: { title: string }) => e.title.startsWith('Multiply'))).toBe(false)
  })
  it('prefers a member whose capacity is known over one on a machine that cannot be read', async () => {
    const two = tab(); two.state.agents = [...agents, { id: 'a2', name: 'Collab', machineId: 'theirs', harnessId: 'h2', configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' } }] as never
    const s = scoped({ tab: two, jev: { ok: true, value: { unavailable: 'BUSY' } } })
    const open = vi.fn(async (_w: unknown, id: string) => id === 'theirs' ? Promise.reject(new Error('not yours')) : daemon(id, { agents: id === 'm1' ? ['h1'] : [] })) as never
    // theirs is not in the account's list, m1 is; the unknown collaborator member is shown only as a fallback.
    const result = await routeTask(input, s, where as never, open)
    expect(result).toMatchObject({ ok: true })
    const titles = (recorded(s).command.decision.candidates as Array<{ title: string }>).map(c => c.title)
    expect(titles.some(t => t.startsWith('Multiply'))).toBe(true)
    expect(titles.some(t => t.startsWith('Collab'))).toBe(false)
    expect(recorded(s).command.decision.excluded.some((e: { title: string }) => e.title.startsWith('Collab'))).toBe(false)
  })
  it('opens a machine only members know and probes its members, but starts nothing new there', async () => {
    const two = tab(); two.state.agents = [{ ...agents[0], machineId: 'theirs' }, agents[1]] as never
    const s = scoped({ tab: two })
    const open = opener(id => daemon(id, { agents: id === 'theirs' ? ['h1'] : [] }))
    await routeTask(input, s, where as never, open)
    const titles = (recorded(s).command.decision.candidates as Array<{ title: string }>).map(c => c.title)
    expect(titles).toContain('Multiply · Claude sonnet medium · theirs')
    expect(titles.filter(t => t.endsWith('· theirs'))).toHaveLength(1)
  })
  it('rates members by the model their engine reported after work', async () => {
    const working = tab()
    working.state.agents = [
      { id: 'a1', name: 'Opus hand', machineId: 'm1', harnessId: 'h1', configuration: { engine: 'claude', model: 'claude-opus-4-7', effort: 'high' } },
      { id: 'a3', name: 'Sonnet hand', machineId: 'm1', harnessId: 'h3', configuration: { engine: 'claude', model: 'claude-sonnet-4-5[1m]', effort: 'medium' } },
      { id: 'a4', name: 'Codex hand', machineId: 'm1', harnessId: 'h4', configuration: { engine: 'codex', model: 'gpt-5.5', effort: 'high' } },
      agents[1]] as never
    const s = scoped({ tab: working, jev: { ok: true, value: { unavailable: 'BUSY' } } })
    const open = opener(id => daemon(id, { agents: id === 'm1' ? ['h1', 'h3', 'h4'] : [], usage: { providers: [] }, engines: [{ engine: 'claude', installed: true, signedIn: true }, { engine: 'codex', installed: true, signedIn: true }] }))
    await routeTask(input, s, where as never, open)
    const rated = Object.fromEntries((recorded(s).command.decision.candidates as Array<{ title: string; quality: number; cost: number }>)
      .filter(c => /hand/.test(c.title)).map(c => [c.title.split(' · ')[0], [c.quality, c.cost]]))
    expect(rated).toEqual({ 'Opus hand': [3, 3], 'Sonnet hand': [2, 2], 'Codex hand': [3, 2] })
  })
  it('falls back to the policy order when Jev is unavailable, and still routes when recording fails', async () => {
    const result = await routeTask(input, scoped({ jev: { ok: true, value: { unavailable: 'BUSY' } }, record: { error: 'BACKEND_UNAVAILABLE' } }), where as never, opener())
    expect(result).toMatchObject({ ok: true, via: 'order', unrecorded: true })
    expect(result).not.toHaveProperty('routeDecisionId')
  })
  it('treats a failed Jev answer or a lost connection as Jev unavailable and still routes', async () => {
    const failed = await routeTask(input, scoped({ jev: { error: 'AGENT_UNAVAILABLE' } }), where as never, opener())
    expect(failed).toMatchObject({ ok: true, via: 'order' })
    expect(failed.why).toContain('UNAVAILABLE')
    const lost = await routeTask(input, scoped({ jevThrows: true, recordThrows: true }), where as never, opener())
    expect(lost).toMatchObject({ ok: true, via: 'order', unrecorded: true })
    const noAnswer = await routeTask(input, scoped({ jev: { ok: true, value: { answers: {} } } }), where as never, opener())
    expect(noAnswer).toMatchObject({ ok: true, via: 'order' })
    const s = scoped(); await routeTask(input, s, where as never, opener())
    expect(jevCall(s).conversationId).toBe('g1')
  })
  it('does not ask Jev when only one candidate can run the task', async () => {
    const s = scoped()
    // Only the member's machine answers, and its engine is not installed for a new agent.
    const open = vi.fn(async (_w: unknown, id: string) => id === 'm1'
      ? daemon(id, { agents: ['h1'], engines: [{ engine: 'claude', installed: false }] }) as never : Promise.reject(new Error('gone')))
    expect(await routeTask(input, s, where as never, open as never)).toMatchObject({ ok: true, via: 'only', pick: { agentId: 'a1' } })
    expect(s.mock.calls.filter(c => c[0].action === 'routeJev')).toHaveLength(0)
  })
  it('refuses an invalid assessment, an unknown group and a failed context read', async () => {
    const open = vi.fn()
    expect(await routeTask({ ...input, assessment: { difficulty: 'x' } }, scoped(), where as never, open as never)).toMatchObject({ error: 'INVALID_REQUEST' })
    expect(await routeTask({ ...input, conversationId: 'nope' }, scoped(), where as never, open as never)).toMatchObject({ error: 'NOT_FOUND' })
    const failing = vi.fn(async () => ({ error: 'AGENT_UNAVAILABLE', detail: 'x' }))
    expect(await routeTask(input, failing, where as never, open as never)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
    const refused = vi.fn(async () => { throw new Error('socket closed') })
    expect(await routeTask(input, refused, where as never, open as never)).toEqual({ error: 'AGENT_UNAVAILABLE', detail: 'socket closed' })
    expect(await routeTask(input, vi.fn(async () => { throw 'odd' }), where as never, open as never)).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
    expect(await routeTask(input, scoped({ context: { ok: false } }), where as never, open as never)).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  })
  it('tolerates a tab without agents, conversations or machines, and names a machine only the members know', async () => {
    const bare = { ok: true, value: { tab: { state: {} }, policy: { policy } } }
    expect(await routeTask(input, scoped({ context: bare }), where as never, vi.fn() as never)).toMatchObject({ error: 'NOT_FOUND' })
    const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: tab(), policy: { policy } } } })
    const result = await routeTask(input, s, where as never, opener())
    expect(result).toMatchObject({ ok: true, warnings: [] })
    expect((recorded(s).command.decision.candidates as Array<{ title: string }>).some(c => c.title.endsWith('· m1'))).toBe(true)
  })
  it('excludes a member whose terminal is gone or not running, and survives a failed agent list', async () => {
    const s = scoped()
    await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['h1'], terminalAvailable: false })))
    expect(recorded(s).command.decision.excluded).toEqual(expect.arrayContaining([{ title: 'Multiply · Claude sonnet medium · remote-1', reason: 'Its terminal is not running.' }]))
    const t = scoped()
    await routeTask(input, t, where as never, opener(id => daemon(id, { listFails: true })))
    expect(recorded(t).command.decision.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'Its terminal is not running.' })]))
  })
  it('gives the history of a group whose last attempt ended', async () => {
    for (const [assignment, line] of [
      [{ id: 'x', agentId: 'a1', status: 'stopped', result: 'Tests failed.' }, 'Multiply: stopped — Tests failed.'],
      [{ id: 'x', agentId: 'gone', status: 'done' }, 'An agent: done'],
    ] as const) {
      const s = scoped({ tab: tab(assignment) })
      await routeTask(input, s, where as never, opener())
      expect(jevCall(s).state.history).toContain(`- ${line}`)
    }
    const s = scoped({ tab: tab({ id: 'x', agentId: 'a1', status: 'working' }) })
    await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['h1'] })))
    expect(jevCall(s).state.history).toContain('No earlier attempts in this group.')
  })
  it('keeps a group without brief or checks routable', async () => {
    const odd = tab(); const group = odd.state.conversations[1] as Record<string, unknown>
    delete group.brief; group.title = undefined; group.checks = [{}]
    const s = scoped({ tab: odd })
    expect(await routeTask(input, s, where as never, opener())).toMatchObject({ ok: true })
    delete group.checks
    expect(await routeTask(input, s, where as never, opener())).toMatchObject({ ok: true })
  })
  it('turns the task needs and the real admission refusals into member and new-agent exclusions', async () => {
    const needs = { tools: ['git'], devices: ['/dev/ttyUSB0'], cwd: '/repo' }
    const s = scoped()
    const open = opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], tools: { git: false }, devices: {} }))
    const result = await routeTask({ ...input, assessment: { ...input.assessment, needs } }, s, where as never, open)
    expect(result).toMatchObject({ error: 'NO_CANDIDATE' })
    const reasons = (result.excluded as Array<{ reason: string }>).map(e => e.reason)
    expect(reasons).toContain('Required tool unavailable: git. Required device unavailable: /dev/ttyUSB0.')
    const d = open.mock.results[0] && await open.mock.results[0].value as ReturnType<typeof daemon>
    expect(d.request).toHaveBeenCalledWith('super_tabs', expect.objectContaining({ action: 'capacity', cwd: '/repo', tools: ['git'], devices: ['/dev/ttyUSB0'] }), 20_000)
  })
  it('excludes a member on an exhausted usage window but not one whose quota is merely unknown', async () => {
    const exhausted = { providers: [{ provider: 'claude', outcome: 'answered', httpStatus: 200, body: { five_hour: { utilization: 100 } } }] }
    const s = scoped()
    await routeTask(input, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], usage: id === 'm1' ? exhausted : usage })))
    expect(recorded(s).command.decision.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('Multiply'), reason: expect.stringContaining('exhausted usage window') })]))
    const t = scoped()
    await routeTask(input, t, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], usage: { providers: [] } })))
    expect((recorded(t).command.decision.candidates as Array<{ title: string }>).some(c => c.title.startsWith('Multiply'))).toBe(true)
  })
  it('uses the real admission texts the member refusal filter keys on', () => {
    const quota = quotaOf({ providers: [{ provider: 'claude', outcome: 'answered', httpStatus: 200, body: { five_hour: { utilization: 100 } } }] }, 'claude', false)
    const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: ['git'], devices: ['/dev/x'], quotaRequired: false }
    const { reasons } = admission({ resources: {}, tools: {}, devices: {} }, { installed: true, signedIn: true }, quota, requirements)
    expect(reasons).toEqual([
      'Required tool unavailable: git.', 'Required device unavailable: /dev/x.',
      'The subscription has an exhausted usage window. Wait for a fresh allowance reading or choose another account.'])
    const unknown = admission({ resources: {}, tools: {}, devices: {} }, { installed: true, signedIn: true }, quotaOf({}, 'claude', false), { ...requirements, tools: [], devices: [] })
    expect(unknown).toMatchObject({ allowed: true, reasons: [] })
  })
})

describe('the context routeTask gives Jev', () => {
  const git = (patch: Record<string, unknown> = {}) => ({ kind: 'git', name: 'api', cwd: '/w/api', root: '/w/api', remote: 'github.com/acme/api', branch: 'main', ...patch })
  /** The Lead's machine, as the folder reader sees it: the folder is there (unless said otherwise) and the SCM describes it. */
  const describeGit = (found: unknown = git(), isDirectory = true) => ({ describe: vi.fn(async () => found) as unknown as typeof describeScmProject & Mock, isDirectory: vi.fn(async () => isDirectory) })
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  const frame = (patch: Record<string, unknown> = {}) => ({ title: 'Fix auth', updatedAt: hoursAgo(2), project: git({ cwd: '/w/api-wt', root: '/w/api-wt', branch: 'feat/auth' }),
    gitContext: { current: { branch: 'feat/auth' } }, ...patch })
  const withCwd = { ...input, assessment: { ...input.assessment, needs: { cwd: '/w/api' } } }
  /** The context read and the history read of one tab; `extra` sets the tab, the messages and the decisions. */
  const world = (extra: Record<string, unknown> = {}, assignment: unknown = null) => {
    const { tab: given, ...past } = extra
    return { context: { ok: true, value: { agentId: 'lead', tab: given ?? tab(assignment), policy: { policy, warnings: [] }, machines: [{ machineId: 'm1', name: 'remote-1' }, { machineId: 'm2', name: 'mac' }] } },
      history: { ok: true, value: { messages: [{ from: 'person', text: 'Please add the endpoint.' }, { from: 'Lead', text: 'On it.' }], decisions: [], attempts: [], ...past } } }
  }
  const labels = (s: ReturnType<typeof scoped>) => Object.values(jevCall(s).questions.who.criteria as Record<string, string>)
  const memberLabel = (s: ReturnType<typeof scoped>) => labels(s).find(l => l.startsWith('Member Multiply'))!
  const newLabel = (s: ReturnType<typeof scoped>) => labels(s).find(l => l.startsWith('New agent'))!

  it('reads the messages, the task folder, the member frames and the machines, and gives Jev what each says', async () => {
    const s = scoped(world())
    const make = (id: string) => daemon(id, { agents: id === 'm1' ? ['h1', 'x', 'y'] : ['z'], frames: { h1: frame() } })
    const describeRepo = describeGit()
    await routeTask(withCwd, s, where as never, opener(make), () => 'op', describeRepo)
    expect(describeRepo.describe).toHaveBeenCalledWith('/w/api')
    expect(describeRepo.isDirectory).toHaveBeenCalledWith('/w/api')
    expect(jevCall(s).state.task).toContain('Recent messages:\nperson: Please add the endpoint.\nLead: On it.')
    expect(jevCall(s).state.lead).toContain('Task folder: api (git repository api)')
    expect(memberLabel(s)).toContain('same repo · on "Fix auth" · in api, branch feat/auth · last active 2h ago')
    expect(labels(s).some(l => /^New agent.*remote-1.*has the task folder · 3 agents running · 7\.0 GB memory free/.test(l))).toBe(true)
    expect(recorded(s).command.decision.context).toEqual({ chars: expect.any(Number), missing: [] })
    expect(recorded(s).command.decision.context.chars).toBeGreaterThan(1000)
    expect(recorded(s).command.decision.context.chars).toBeLessThan(17_000 + 31 * 640)
  })
  it('marks a member in another repository, and one it cannot compare', async () => {
    const other = frame({ project: git({ name: 'web', remote: 'github.com/acme/web', root: '/w/web', cwd: '/w/web' }) })
    const s = scoped(world())
    await routeTask(withCwd, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], frames: { h1: other } })), () => 'op', describeGit())
    expect(memberLabel(s)).toContain('different repo')
    const t = scoped(world())
    await routeTask(withCwd, t, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [] })), () => 'op', describeGit())
    expect(memberLabel(t)).toContain('repo unknown · last active unknown')
    const u = scoped(world())
    await routeTask(input, u, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], frames: { h1: frame() } })), () => 'op')
    expect(memberLabel(u)).not.toMatch(/repo/)
    expect(u.mock.calls.find(c => c[0].action === 'command')![0].command.decision.context.missing).toEqual([])
  })
  it('compares a member on another machine by remote only, and uses the branch the frame\'s project reports', async () => {
    const two = tab(); two.state.agents = [{ ...agents[0], machineId: 'm2' }, agents[1]] as never
    const elsewhere = frame({ gitContext: undefined, project: git({ remote: null, root: '/other/api', cwd: '/other/api', branch: 'from-project' }) })
    const s = scoped(world({ tab: two }))
    await routeTask(withCwd, s, where as never, opener(id => daemon(id, { agents: id === 'm2' ? ['h1'] : [], frames: { h1: elsewhere } })), () => 'op', describeGit({ ...git(), remote: null }))
    expect(memberLabel(s)).toContain('repo unknown')
    expect(memberLabel(s)).toContain('branch from-project')
  })
  it('keeps a frame without a project, a title or a time as what the member does not say', async () => {
    const s = scoped(world())
    await routeTask(withCwd, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], frames: { h1: { title: 5, updatedAt: 'later', project: null } } })), () => 'op', describeGit({ kind: 'none', cwd: '/w/api', root: null, remote: null, name: 'api', branch: null }))
    expect(memberLabel(s)).toMatch(/repo unknown · last active unknown/)
    expect(memberLabel(s)).not.toMatch(/on "|branch/)
    expect(jevCall(s).state.lead).toContain('Task folder: api (not a git repository)')
  })
  it('tells Jev what the group and the Super Tab have tried: ended attempts from the state and the log, and the last five decisions', async () => {
    const decision = (id: string, conversationId: string, patch: Record<string, unknown> = {}) => ({ id, conversationId, title: `Pick ${id}`, via: 'jev', outcome: 'stopped', assignmentId: `as-${id}`,
      createdAt: '2026-10-19T10:00:00Z', final: { kind: 'new', engine: 'claude', model: 'opus' }, ...patch })
    const decisions = [{ ...decision('d7', 'g1', { outcome: null, assignmentId: null, final: null }), via: undefined }, decision('d6', 'g1', { outcome: 'done', assignmentId: 'x', final: { kind: 'member', agentId: 'a1' } }), decision('d5', 'g1'),
      decision('d4', 'other', { final: { kind: 'member', agentId: 'a1' }, outcome: 'done' }), decision('d3', 'g1', { final: null }), decision('d2', 'lead'), decision('d1', 'g1', { outcome: 'superseded' }), decision('d0', 'g1', { final: { kind: 'member', agentId: 'gone' } })]
    const s = scoped(world({ decisions }, { id: 'x', agentId: 'a1', status: 'done', result: 'Shipped.' }))
    await routeTask(input, s, where as never, opener())
    const history = jevCall(s).state.history as string
    // Oldest first: the log's attempt by an agent the tab no longer has, its stopped new-agent attempt, then the member's finished one with the result its assignment holds.
    expect(history).toMatch(/Attempts in this group:\n- An agent: stopped\n- New agent \(claude opus\): stopped\n- Multiply: done — Shipped\./)
    expect(history).toContain('Recent routing in this Super Tab:\n- Pick d7: open\n- Pick d6 (jev): done\n- Pick d5 (jev): stopped\n- Pick d4 (jev): done\n- Pick d3 (jev): stopped')
    expect(history).not.toContain('Pick d2')
    // Multiply's earlier work in this Super Tab: the finished assignment (also in the log), and the log's one in a group this tab no longer has.
    expect(memberLabel(s)).toContain('earlier here: API done; another group done')
  })
  it('labels a member with the effort it was launched with when it reports none, and keeps an effort it reports', async () => {
    const label = async (effort: string | undefined, start: unknown) => {
      const t = tab(); t.state.agents = [{ ...agents[0], configuration: { engine: 'claude', model: 'sonnet', effort } }, agents[1]] as never
      ;(t.state as Record<string, unknown>).starts = start === undefined ? undefined : [{ harnessId: 'other', request: { effort: 'low' } }, { harnessId: 'h1', request: start }]
      const s = scoped(world({ tab: t }))
      await routeTask(input, s, where as never, opener())
      return memberLabel(s)
    }
    expect(await label('auto', { effort: 'medium' })).toContain('Claude sonnet medium')
    expect(await label(undefined, { effort: 'medium' })).toContain('Claude sonnet medium')
    expect(await label('high', { effort: 'medium' })).toContain('Claude sonnet high')
    expect(await label('auto', undefined)).toContain('Claude sonnet auto')
    expect(await label('auto', { effort: 'default' })).toContain('Claude sonnet auto')
    expect(await label('auto', {})).toContain('Claude sonnet auto')
    // The rating follows the launch effort too: opus rows exist only at high.
    const t = tab(); t.state.agents = [{ ...agents[0], configuration: { engine: 'claude', model: 'opus', effort: 'auto' } }, agents[1]] as never
    ;(t.state as Record<string, unknown>).starts = [{ harnessId: 'h1', request: { effort: 'high' } }]
    const s = scoped(world({ tab: t }))
    await routeTask(input, s, where as never, opener())
    expect(memberLabel(s)).toContain('Claude opus high')
  })
  it('keeps a stopped attempt in the history and in the member\'s earlier work after the group was defined again', async () => {
    // `work.define` took the stopped assignment out of the state and no decision of the log names it (a person assigned it).
    // A row without an id names no assignment and is left out.
    const attempts = [{ agentId: 'a1', status: 'done' }, { id: 'as-2', agentId: 'a1', status: 'done', result: 'Shipped.' }, { id: 'as-1', agentId: 'a1', status: 'stopped', result: 'Tests failed.' }]
    const s = scoped(world({ attempts }))
    await routeTask(input, s, where as never, opener())
    expect(jevCall(s).state.history).toContain('Attempts in this group:\n- Multiply: stopped — Tests failed.\n- Multiply: done — Shipped.')
    expect(memberLabel(s)).toContain('earlier here: API done; API stopped')
  })
  it('orders the group\'s attempts oldest first, a person\'s assignment before a routed one, and keeps the newest for the member', async () => {
    // as-1 was assigned by a person (no decision); as-2 was routed. The log alone would list as-2 first.
    const decision = { id: 'd2', conversationId: 'g1', title: 'Pick', via: 'jev', outcome: 'done', assignmentId: 'as-2', createdAt: '2026-10-19T11:00:00Z', final: { kind: 'member', agentId: 'a1' } }
    const attempts = [{ id: 'as-2', agentId: 'a1', status: 'done', result: 'Second.', createdAt: '2026-10-19T11:00:00Z' }, { id: 'as-1', agentId: 'a1', status: 'stopped', result: 'First.', createdAt: '2026-10-19T10:00:00Z' }]
    const s = scoped(world({ decisions: [decision], attempts }, { id: 'as-3', agentId: 'a1', status: 'stopped', result: 'Third.' }))
    await routeTask(input, s, where as never, opener())
    expect(jevCall(s).state.history).toContain('Attempts in this group:\n- Multiply: stopped — First.\n- Multiply: done — Second.\n- Multiply: stopped — Third.')
    expect(memberLabel(s)).toContain('earlier here: API stopped; API done; API stopped')
    // Without the attempts read the log's order stays.
    const old = scoped(world({ decisions: [decision], attempts: undefined, attemptsUnreadable: true }, { id: 'as-3', agentId: 'a1', status: 'stopped', result: 'Third.' }))
    await routeTask(input, old, where as never, opener())
    expect(jevCall(old).state.history).toContain('Attempts in this group:\n- Multiply: done\n- Multiply: stopped — Third.')
  })
  it('lists an attempt once when the log and the attempts both know it', async () => {
    const decision = { id: 'd5', conversationId: 'g1', title: 'Pick', via: 'jev', outcome: 'stopped', assignmentId: 'as-1', createdAt: '2026-10-19T10:00:00Z', final: { kind: 'new', engine: 'claude', model: 'opus' } }
    const s = scoped(world({ decisions: [decision], attempts: [{ id: 'as-1', agentId: 'gone', status: 'stopped', result: 'Out of memory.' }] }, { id: 'as-2', agentId: 'a1', status: 'done', result: 'Shipped.' }))
    await routeTask(input, s, where as never, opener())
    const history = jevCall(s).state.history as string
    // The log names the started agent; the attempt gives the result.
    expect(history).toContain('Attempts in this group:\n- New agent (claude opus): stopped — Out of memory.\n- Multiply: done — Shipped.')
    expect(history.match(/Out of memory/g)).toHaveLength(1)
    expect(memberLabel(s)).toContain('earlier here: API done')
  })
  it('cuts an attempt\'s result to 200 characters and scrubs it', async () => {
    const result = `Key sk-${'a1'.repeat(20)} sent to minh@example.com. ${'x'.repeat(400)}`
    const s = scoped(world({ attempts: [{ id: 'as-1', agentId: 'a1', status: 'stopped', result }] }))
    await routeTask(input, s, where as never, opener())
    const line = (jevCall(s).state.history as string).split('\n').find(l => l.startsWith('- Multiply: stopped'))!
    expect(line).toContain('[secret] sent to [email]')
    expect(line).not.toMatch(/@|sk-/)
    expect(line.length).toBeLessThanOrEqual('- Multiply: stopped — '.length + 200)
  })
  it('keeps the log\'s name for a started agent whose assignment names an agent the tab no longer has', async () => {
    const decision = { id: 'd5', conversationId: 'g1', title: 'Pick', via: 'jev', outcome: 'stopped', assignmentId: 'as-5', createdAt: '2026-10-19T10:00:00Z', final: { kind: 'new', engine: 'claude', model: 'opus' } }
    const s = scoped(world({ decisions: [decision] }, { id: 'as-5', agentId: 'gone', status: 'stopped', result: 'Out of memory.' }))
    await routeTask(input, s, where as never, opener())
    expect(jevCall(s).state.history).toContain('- New agent (claude opus): stopped — Out of memory.')
    // A machine that reports no capacity measured nothing, so nothing there can be admitted; the route says so.
    expect(await routeTask(withCwd, scoped(world()), where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], capacity: {} })), () => 'op', describeGit())).toMatchObject({ error: 'NO_CANDIDATE' })
  })
  it('lists a member\'s earlier work newest first, three at most', async () => {
    const many = tab(); many.state.conversations = [conversations()[0],
      ...[1, 2, 3, 4].map(i => ({ id: `e${i}`, title: `Group ${i}`, leadId: 'lead', agentIds: [], archived: false, brief: '', checks: [], assignment: { id: `x${i}`, agentId: 'a1', status: 'stopped', result: null } })),
      conversations()[1]] as never
    const s = scoped(world({ tab: many }))
    await routeTask(input, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [] })))
    expect(memberLabel(s)).toContain('earlier here: Group 4 stopped; Group 3 stopped; Group 2 stopped')
    expect(memberLabel(s)).not.toContain('Group 1')
  })
  it('still routes when a source cannot be read, and lists each one in the decision', async () => {
    const run = async (extra: Record<string, unknown>, options: Record<string, unknown> = {}, describeRepo: ReturnType<typeof describeGit> = describeGit()) => {
      const s = scoped(world(extra))
      const answer = await routeTask(withCwd, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], frames: { h1: frame() }, ...options })), () => 'op', describeRepo)
      expect(answer).toMatchObject({ ok: true })
      return { s, missing: recorded(s).command.decision.context.missing as string[] }
    }
    expect((await run({})).missing).toEqual([])
    const noMessages = await run({ messages: undefined, messagesUnreadable: true })
    expect(jevCall(noMessages.s).state.task).toContain('Recent messages: unknown')
    expect(noMessages.missing).toEqual(['messages'])
    // An older backend (404) and a failed read both leave the attempts out: today's history, and a note in the decision.
    const noAttempts = await run({ attempts: undefined, attemptsUnreadable: true })
    expect(jevCall(noAttempts.s).state.history).toContain('No earlier attempts in this group.')
    expect(noAttempts.missing).toEqual(['attempts'])
    const noLog = await run({ decisions: undefined, decisionsUnreadable: true })
    expect(jevCall(noLog.s).state.history).toContain('Recent routing in this Super Tab: unknown')
    expect(noLog.missing).toEqual(['route log'])
    for (const failing of [vi.fn(async () => { throw new Error('git') }), vi.fn(async () => null)]) {
      const noFolder = await run({}, {}, { ...describeGit(), describe: failing as never })
      expect(jevCall(noFolder.s).state.lead).toContain('Task folder: api (repository unknown)')
      expect(memberLabel(noFolder.s)).toContain('repo unknown')
      expect(noFolder.missing).toEqual(['task folder'])
    }
    // A folder read that never answers does not hold the route: it is given up after three seconds.
    vi.useFakeTimers()
    try {
      const pending = run({}, {}, { ...describeGit(), describe: vi.fn(() => new Promise(() => {})) as never })
      await vi.advanceTimersByTimeAsync(3000)
      expect((await pending).missing).toEqual(['task folder'])
    } finally { vi.useRealTimers() }
    // Without the agent list there is no machine load; the members there cannot run, so only new agents are shown.
    const noList = await run({}, { listFails: true })
    expect(noList.missing).toEqual(['machine load'])
    expect(newLabel(noList.s)).toContain('agents running unknown')
  })
  it('finds a member in the task\'s folder when the Lead\'s machine does not have it', async () => {
    const two = tab(); two.state.agents = [{ ...agents[0], machineId: 'm2' }, agents[1]] as never
    const s = scoped(world({ tab: two }))
    const there = frame({ project: git({ remote: null, root: '/w/api', cwd: '/w/api' }) })
    const reader = describeGit(git(), false)
    await routeTask(withCwd, s, where as never, opener(id => daemon(id, { agents: id === 'm2' ? ['h1'] : [], frames: { h1: there } })), () => 'op', reader)
    expect(memberLabel(s)).toContain('same repo')
    expect(jevCall(s).state.lead).toContain('Task folder: api (not on the Lead\'s machine)')
    expect(reader.describe).not.toHaveBeenCalled()
    expect(recorded(s).command.decision.context.missing).toEqual(['task folder'])
  })
  it('says a folder is unknown, not missing, when it cannot be told apart from a refusal', async () => {
    for (const code of ['EACCES', 'ENOTDIR']) {
      const s = scoped(world())
      await routeTask(withCwd, s, where as never, opener(), () => 'op', { describe: vi.fn() as never, isDirectory: async () => { throw Object.assign(new Error(code), { code }) } })
      expect(jevCall(s).state.lead).toContain('Task folder: api (repository unknown)')
      expect(recorded(s).command.decision.context.missing).toEqual(['task folder'])
    }
  })
  it('reads the task folder on this machine when no reader is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'route-folder-'))
    try {
      await writeFile(join(dir, 'file'), 'x')
      for (const [cwd, folder] of [[dir, 'not a git repository'], [join(dir, 'absent'), 'not on the Lead\'s machine'], [join(dir, 'file', 'inside'), 'repository unknown']] as const) {
        const s = scoped(world())
        await routeTask({ ...input, assessment: { ...input.assessment, needs: { cwd } } }, s, where as never, opener(), () => 'op')
        expect(jevCall(s).state.lead).toContain(folder)
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('starts the probes before the context reads settle, and gives up on a read that hangs', async () => {
    const s = scoped({ ...world(), historyHangs: true })
    const open = opener()
    vi.useFakeTimers()
    try {
      const pending = routeTask(withCwd, s, where as never, open, () => 'op', { describe: vi.fn(() => new Promise(() => {})) as never, isDirectory: async () => true })
      await vi.advanceTimersByTimeAsync(0)
      // Both context reads are still waiting, and the machines have already been opened.
      expect(s.mock.calls.some(c => c[0].action === 'routeHistory')).toBe(true)
      expect(open).toHaveBeenCalled()
      expect(s.mock.calls.some(c => c[0].action === 'routeJev')).toBe(false)
      await vi.advanceTimersByTimeAsync(3000)
      expect(await pending).toMatchObject({ ok: true })
    } finally { vi.useRealTimers() }
    expect(recorded(s).command.decision.context.missing).toEqual(expect.arrayContaining(['messages', 'route log', 'attempts', 'task folder']))
  })
  it('lists a member whose machine cannot be opened as one whose activity is unknown', async () => {
    const two = tab(); two.state.agents = [...agents, { id: 'a2', name: 'Collab', machineId: 'theirs', harnessId: 'h2', configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' } }] as never
    const s = scoped(world({ tab: two }))
    const open = vi.fn(async (_w: unknown, id: string) => id === 'theirs' ? Promise.reject(new Error('not yours')) : daemon(id, { agents: id === 'm1' ? ['h1'] : [], frames: { h1: frame() }, usage: { providers: [] } })) as never
    await routeTask(input, s, where as never, open)
    expect(labels(s).find(l => l.startsWith('Member Collab'))).toContain('activity unknown')
    expect(recorded(s).command.decision.context.missing).toEqual(['member activity'])
  })
  it('records no context when Jev was not asked', async () => {
    const s = scoped(world())
    const open = vi.fn(async (_w: unknown, id: string) => id === 'm1'
      ? daemon(id, { agents: ['h1'], engines: [{ engine: 'claude', installed: false }] }) as never : Promise.reject(new Error('gone')))
    expect(await routeTask(input, s, where as never, open as never)).toMatchObject({ via: 'only' })
    expect(recorded(s).command.decision).not.toHaveProperty('context')
  })
})


describe('routing contributed capacity', () => {
  const healthy = () => ({ machineId: 'm1', name: 'Contributed laptop', cwd: '/owner/project', engines: ['claude'], paused: false,
    observation: { receivedAt: Date.now(), resources: { memoryTotalBytes: 32e9, memoryUsedBytes: 2e9, projectDiskFreeBytes: 200e9 },
      tools: { git: true }, runningHarnessIds: [], quotas: [{ engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 20, resetsAt: Date.now() + 3600000 }] }] } })
  async function runPool(pool: Record<string, any>, members = false, needs: Record<string, unknown> = {}) {
    const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: { state: { id: 'tab', agents: members ? agents : [agents[1]], conversations: conversations(), machines: [pool] } }, policy: { policy, warnings: [] }, machines: [] } } })
    const open = opener()
    const answer = await routeTask({ ...input, assessment: { ...input.assessment, needs } }, s, where, open)
    expect(open).not.toHaveBeenCalled()
    return { answer, s }
  }
  it('routes using owner measurements and the contributed project without opening that machine', async () => {
    const { answer } = await runPool(healthy())
    expect(answer.ok).toBe(true)
    expect(answer.next).toContain('/owner/project')
    const member = await runPool(healthy(), true)
    expect(member.answer.ok).toBe(true)
  })
  it.each([
    ['stale', (p: any) => { p.observation.receivedAt = 0 }],
    ['paused', (p: any) => { p.paused = true }],
    ['full', (p: any) => { p.availableSlots = 0 }],
    ['low disk', (p: any) => { p.observation.resources.projectDiskFreeBytes = 1 }],
    ['unknown memory', (p: any) => { delete p.observation.resources.memoryUsedBytes }],
    ['exhausted', (p: any) => { p.observation.quotas[0].windows[0].usedPercent = 100 }],
    ['no engines', (p: any) => { delete p.engines }],
  ])('withholds new starts when %s', async (_, change) => {
    const p = healthy(); change(p)
    const { answer } = await runPool(p)
    expect(answer.ok).not.toBe(true)
  })
  it('keeps unknown allowance and load distinct from zero', async () => {
    const p = healthy(); delete (p.observation.quotas[0].windows[0] as any).name
    expect((await runPool(p)).answer.ok).toBe(true)
    p.observation.quotas = []
    delete (p.observation as any).runningHarnessIds
    expect((await runPool(p)).answer.ok).toBe(true)
    expect((await runPool({ ...p, observation: {} }, true)).answer.ok).not.toBe(true)
  })
  it('refuses unobserved tools and devices, without probing arbitrary paths on a teammate computer', async () => {
    expect((await runPool(healthy(), false, { tools: ['docker'], devices: ['/dev/fixture'] })).answer.ok).not.toBe(true)
  })
})
