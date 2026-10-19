import { describe, expect, it, vi, type Mock } from 'vitest'
import type { openDaemon } from '../agentClient/daemon.js'
import { routeTask } from './routeCommand.js'
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
function daemon(machineId: string, options: { agents?: string[]; terminalAvailable?: boolean; tools?: Record<string, boolean>; devices?: Record<string, boolean>; usage?: unknown; listFails?: boolean; engines?: unknown } = {}) {
  return {
    machineId, close: vi.fn(),
    request: vi.fn(async (type: string, _payload?: unknown, _timeout?: number) => {
      if (type === 'agents_list') {
        if (options.listFails) throw new Error('timeout')
        return { agents: (options.agents ?? []).map(id => ({ id, terminal: { available: options.terminalAvailable ?? true } })) }
      }
      if (type === 'super_tabs') return { resources: { memoryTotalBytes: 8e9, memoryUsedBytes: 1e9, cpuPercent: 10, projectDiskFreeBytes: 1e11 }, tools: options.tools ?? { git: true }, devices: options.devices ?? {} }
      if (type === 'engines_probe') return { engines: options.engines ?? [{ engine: 'claude', installed: true, signedIn: true }] }
      if (type === 'usage_read') return options.usage ?? usage
      return {}
    }),
  }
}
type Answer = Record<string, unknown>
function scoped(answers: { jev?: Answer; record?: Answer; tab?: unknown; context?: Answer; jevThrows?: boolean; recordThrows?: boolean } = {}) {
  return vi.fn(async (payload: Record<string, any>): Promise<Record<string, unknown>> => {
    if (payload.action === 'routeContext') return answers.context ?? { ok: true, value: { agentId: 'lead', tab: answers.tab ?? tab(), policy: { policy, warnings: ['w'] }, machines: [{ machineId: 'm1', name: 'remote-1' }, { machineId: 'm2', name: 'mac' }] } }
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
      expect(jevCall(s).state.history).toContain(line)
    }
    const s = scoped({ tab: tab({ id: 'x', agentId: 'a1', status: 'working' }) })
    await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['h1'] })))
    expect(jevCall(s).state.history).toBe('No earlier attempts.')
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
