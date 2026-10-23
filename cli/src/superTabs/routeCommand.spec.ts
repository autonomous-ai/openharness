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
  // An engine the route does not offer: it only puts m2 in the Swarm's Machines list, as a person adding the machine does.
  { id: 'a2', name: 'Elsewhere', machineId: 'm2', harnessId: 'h2', configuration: { engine: 'pi', model: 'default', effort: 'default' } },
]
const conversations = (assignment: unknown = null) => [
  { id: 'lead', title: 'Lead', leadId: 'lead', agentIds: ['lead', 'a1'], archived: false, brief: '', checks: [], assignment: null },
  { id: 'g1', title: 'API', leadId: 'lead', agentIds: ['lead'], archived: false, brief: 'Add the endpoint.', checks: [{ description: 'Tests pass' }], assignment },
]
const tab = (assignment: unknown = null) => ({ revision: 3, state: { id: 'tab', agents, conversations: conversations(assignment) } })
const usage = { providers: [{ provider: 'claude', outcome: 'answered', httpStatus: 200, account: 'acct', body: { five_hour: { utilization: 40, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() }, seven_day: { utilization: 10 } } }] }
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
function scoped(answers: { record?: Answer; tab?: unknown; context?: Answer; history?: Answer; historyHangs?: boolean; recordThrows?: boolean } = {}) {
  return vi.fn(async (payload: Record<string, any>): Promise<Record<string, unknown>> => {
    if (payload.action === 'routeContext') return answers.context ?? { ok: true, value: { agentId: 'lead', tab: answers.tab ?? tab(), policy: { policy, warnings: ['w'] }, machines: [{ machineId: 'm1', name: 'remote-1' }, { machineId: 'm2', name: 'mac' }] } }
    if (payload.action === 'routeHistory') return answers.historyHangs ? new Promise(() => {}) : answers.history ?? { ok: true, value: { decisions: [], attempts: [] } }
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
/** Each candidate's line, as the route log keeps it. */
const labels = (s: ReturnType<typeof scoped>) => (recorded(s).command.decision.candidates as Array<{ label: string }>).map(c => c.label)

describe('routeTask', () => {
  it('offers the same member after Change agent when only its replacement terminal is live', async () => {
    const rebound = tab()
    rebound.state.agents = agents.map(a => a.id === 'a1' ? { ...a, harnessId: 'replacement' } : a)
    const s = scoped({ tab: rebound })
    const result = await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['replacement'] })), () => 'op')
    expect(result).toMatchObject({ ok: true, pick: { kind: 'member', agentId: 'a1' } })
    expect(recorded(s).command.decision.excluded.some((c: { title: string }) => c.title.startsWith('Multiply'))).toBe(false)
  })
  it('collects members and new agents, records and returns the first in the order, and never asks Jev', async () => {
    const s = scoped()
    const result = await routeTask(input, s, where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, routeDecisionId: 'd1', via: 'order', p: null, pick: { id: 'c0' }, warnings: ['w'] })
    expect(s.mock.calls.map(c => c[0].action)).toEqual(['routeContext', 'routeHistory', 'command'])
    expect(recorded(s).command.decision).not.toHaveProperty('context')
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
  it('does not offer a member that is already working on a task', async () => {
    const s = scoped({ tab: tab({ id: 'x', agentId: 'a1', status: 'working' }) })
    await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['h1'] })))
    expect((recorded(s).command.decision.candidates as Array<{ title: string }>).some(c => c.title.startsWith('Multiply'))).toBe(false)
  })
  it('leaves out what breaks the owner\'s rules in the tab, and ignores a rule it cannot read', async () => {
    const ruled = tab(); (ruled.state as Record<string, unknown>).rules = [{ id: 'r1', rule: { kind: 'forbidModel', model: 'sonnet' }, text: 'No Sonnet.' }, { id: 'r2', text: 7 }]
    const s = scoped({ tab: ruled })
    const result = await routeTask(input, s, where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, pick: { model: 'opus' }, belowFloor: false })
    const decision = recorded(s).command.decision
    expect(decision.candidates.every((c: { model: string }) => c.model === 'opus')).toBe(true)
    expect(decision.excluded).toEqual(expect.arrayContaining([{ title: 'Multiply · Claude sonnet medium · remote-1', reason: 'Breaks the owner\'s rule: No Sonnet.' }]))
  })
  it('applies only the rules of the group\'s project', async () => {
    // 2026-10-23: one project's rules (three machines, no Haiku, high effort) left every other project's Lead without candidates.
    const models = async (projectId: string) => {
      const ruled = tab(); (ruled.state as Record<string, unknown>).rules = [{ id: 'r1', projectId, rule: { kind: 'forbidModel', model: 'sonnet' }, text: 'No Sonnet.' }]
      const s = scoped({ tab: ruled })
      await routeTask(input, s, where as never, opener(), () => 'op')
      return new Set(recorded(s).command.decision.candidates.map((c: { model: string }) => c.model))
    }
    expect(await models('other')).toContain('sonnet')
    expect(await models('lead')).not.toContain('sonnet')
  })
  it('offers a Reviewer only for a review group, and starts a new one as a Reviewer', async () => {
    const offered = async (reviewer: boolean, reviewGroup: boolean) => {
      const t = tab(); t.state.agents = agents.map(a => a.id === 'a1' && reviewer ? { ...a, role: 'reviewer' } : a)
      if (reviewGroup) (t.state.conversations[1] as Record<string, unknown>).reviewOf = 'g0'
      const s = scoped({ tab: t })
      const result = await routeTask(input, s, where as never, opener(), () => 'op')
      const titles = (recorded(s).command.decision.candidates as Array<{ title: string }>).map(c => c.title)
      return { member: titles.some(c => c.startsWith('Multiply')), next: String(result.next) }
    }
    expect((await offered(true, false)).member).toBe(false)
    expect((await offered(false, true)).member).toBe(false)
    expect((await offered(true, true)).member).toBe(true)
    const fresh = await offered(false, true)
    expect(fresh.next).toContain('"name":"Reviewer","role":"reviewer"')
    expect((await offered(false, false)).next).not.toContain('"role"')
  })
  it('tells the Lead how to assign a member or start a new agent with the decision', async () => {
    const member = await routeTask(input, scoped(), where as never, opener(), () => 'op')
    // Cheapest first: the member on sonnet.
    expect(member).toMatchObject({ pick: { kind: 'member', agentId: 'a1' } })
    expect(member.next).toContain('"type":"work.assign","conversationId":"g1","agentId":"a1","routeDecisionId":"d1"')
    const fresh = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high' } }, scoped(), where as never, opener(), () => 'op')
    expect(fresh).toMatchObject({ pick: { kind: 'new', engine: 'claude', model: 'opus', effort: 'high' } })
    expect(fresh.next).toContain('"engine":"claude","model":"opus","effort":"high","routeDecisionId":"d1"')
    // Without a branch the agent starts from the default one, and the hint says how to choose another.
    expect(fresh.next).toContain('"branchRef":"refs/remotes/origin/BRANCH"')
    expect(fresh.next).toContain('default branch, fetched first')
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
  it('considers only the account machines the Swarm lists, and always the Lead\'s own', async () => {
    const context = { ok: true, value: { agentId: 'lead', tab: tab(), policy: { policy }, machines: [{ machineId: 'm1', name: 'remote-1' }, { machineId: 'm2', name: 'mac' }, { machineId: 'm9', name: 'vm' }] } }
    const s = scoped({ context }), open = opener()
    await routeTask(input, s, where as never, open, () => 'op')
    // m9 is the account's but not in the Swarm's list: it is neither probed nor a candidate nor an exclusion.
    expect(open.mock.calls.map(c => c[1]).sort()).toEqual(['m1', 'm2'])
    const decision = recorded(s).command.decision
    expect([...decision.candidates, ...decision.excluded].some((c: { title: string }) => c.title.includes('vm'))).toBe(false)
    expect(decision.candidates.some((c: { machineId?: string; title: string }) => c.title.includes('mac'))).toBe(true)
  })
  it('offers new agents on the Lead\'s own machine when the account list could not be read', async () => {
    const context = { ok: true, value: { agentId: 'lead', tab: tab(), policy: { policy }, machines: [], machinesUnreadable: true } }
    const s = scoped({ context }), open = opener()
    await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high' } }, s, where as never, open, () => 'op')
    expect(open.mock.calls.map(c => c[1])).toEqual(['m1'])
    expect(recorded(s).command.decision.candidates.some((c: { title: string }) => c.title.startsWith('New agent') && c.title.includes('m1'))).toBe(true)
  })
  it('says a listed machine without the project folder needs it cloned, not that its disk could not be verified', async () => {
    const needs = { cwd: '/repo/api' }
    const noFolder = { ok: true, resources: { memoryTotalBytes: 8e9, memoryUsedBytes: 1e9, cpuPercent: 10 }, tools: {}, devices: {} }
    const s = scoped()
    await routeTask({ ...input, assessment: { ...input.assessment, needs } }, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], capacity: id === 'm1' ? { ...noFolder, tools: { git: true } } : noFolder })), () => 'op')
    const excluded = recorded(s).command.decision.excluded as Array<{ title: string; reason: string }>
    const reasonOf = (machine: string) => excluded.filter(e => e.title.includes(machine)).map(e => e.reason)
    expect(reasonOf('mac').some(r => r.includes('This machine does not have the project folder. Add it to the Swarm so it can clone the project.'))).toBe(true)
    expect(reasonOf('mac').some(r => /Project disk space/.test(r))).toBe(false)
    // Its other reasons stay.
    expect(reasonOf('mac').some(r => /Required tool not verified: git/.test(r))).toBe(true)
    // The Lead's own machine keeps the plain reason: its folder was named by the Lead itself.
    expect(reasonOf('remote-1').some(r => r.includes('Project disk space could not be verified.'))).toBe(true)
  })
  it('offers a listed machine whose capacity read measured the project folder', async () => {
    const s = scoped()
    await routeTask({ ...input, assessment: { ...input.assessment, needs: { cwd: '/repo/api' } } }, s, where as never,
      opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], capacity: { ok: true, resources: { memoryTotalBytes: 8e9, memoryUsedBytes: 1e9, cpuPercent: 10, projectDiskFreeBytes: 1e11 }, tools: { git: true }, devices: {} } })), () => 'op')
    expect(recorded(s).command.decision.candidates.some((c: { title: string }) => c.title.startsWith('New agent') && c.title.includes('mac'))).toBe(true)
  })
  it('keeps "could not be verified" on a listed machine whose capacity read failed, because a failed read says nothing about the folder', async () => {
    const s = scoped()
    await routeTask({ ...input, assessment: { ...input.assessment, needs: { cwd: '/repo/api' } } }, s, where as never,
      opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], ...(id === 'm2' ? { capacity: { ok: false, error: 'UNSUPPORTED' } } : {}) })), () => 'op')
    const reasons = (recorded(s).command.decision.excluded as Array<{ title: string; reason: string }>).filter(e => e.title.includes('mac')).map(e => e.reason)
    expect(reasons.length).toBeGreaterThan(0)
    for (const reason of reasons) {
      expect(reason).toContain('Project disk space could not be verified.')
      expect(reason).not.toContain('does not have the project folder')
    }
  })
  it('names a member that has no name, model or effort of its own, and leaves the decision blank when it is unrecorded', async () => {
    const plain = tab(); plain.state.agents = [{ id: 'a1', machineId: 'm1', harnessId: 'h1', configuration: { engine: 'claude' } }, agents[1]] as never
    const options = { tab: plain, record: { error: 'BACKEND_UNAVAILABLE' } }
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
    const s = scoped({ tab: two })
    const open = vi.fn(async (_w: unknown, id: string) => id === 'theirs' ? Promise.reject(new Error('not yours')) : daemon(id, { agents: id === 'm1' ? ['h1'] : [] })) as never
    // theirs is not in the account's list, m1 is; the unknown collaborator member is shown only as a fallback.
    const result = await routeTask(input, s, where as never, open)
    expect(result).toMatchObject({ ok: true })
    const titles = (recorded(s).command.decision.candidates as Array<{ title: string }>).map(c => c.title)
    expect(titles.some(t => t.startsWith('Multiply'))).toBe(true)
    expect(titles.some(t => t.startsWith('Collab'))).toBe(false)
    // Left out because others' quota fits, which the log says.
    expect(recorded(s).command.decision.excluded).toEqual(expect.arrayContaining([{ title: 'Collab · Claude sonnet medium · theirs',
      reason: 'Its quota could not be read in full, and another candidate\'s quota fits this task.' }]))
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
    const s = scoped({ tab: working })
    const open = opener(id => daemon(id, { agents: id === 'm1' ? ['h1', 'h3', 'h4'] : [], usage: { providers: [] }, engines: [{ engine: 'claude', installed: true, signedIn: true }, { engine: 'codex', installed: true, signedIn: true }] }))
    await routeTask(input, s, where as never, open)
    const rated = Object.fromEntries((recorded(s).command.decision.candidates as Array<{ title: string; quality: number; cost: number }>)
      .filter(c => /hand/.test(c.title)).map(c => [c.title.split(' · ')[0], [c.quality, c.cost]]))
    expect(rated).toEqual({ 'Opus hand': [3, 3], 'Sonnet hand': [2, 2], 'Codex hand': [3, 2] })
  })
  it('counts the quota open picks hold on the same account, and tells the Lead when nobody is expected to cover the task', async () => {
    const pick = { conversationId: 'g1', title: 'Pick', outcome: null, assignmentId: 'as1', createdAt: new Date().toISOString(), final: { kind: 'new', engine: 'claude', model: 'opus' } }
    const decisions = [{ ...pick, id: 'd1', account: 'acct', spend: { '5-hour': 45, weekly: 6 }, size: 'medium' },
      // A finished pick, one not yet started and one from before phase 1 hold nothing.
      { ...pick, id: 'd2', account: 'acct', spend: { '5-hour': 45 }, size: 'medium', outcome: 'done' }, { ...pick, id: 'd3', account: 'acct', spend: { '5-hour': 45 }, size: 'medium', final: null }, { ...pick, id: 'd4' }]
    const s = scoped({ history: { ok: true, value: { messages: [], decisions, attempts: [] } } })
    const result = await routeTask(input, s, where as never, opener(), () => 'op')
    // 60% left less the 10% reserve and the 45% the open pick holds leaves 5% for a task that needs 30%.
    expect(recorded(s).command.decision.candidates.every((c: { fit: { status: string; account: string } }) => c.fit.status === 'short' && c.fit.account === 'acct')).toBe(true)
    expect(result.warnings).toEqual(['w', expect.stringMatching(/^No candidate is expected to cover this task; its 5-hour quota is expected to run out partway and resets in 3h\.$/)])
  })
  it('records again in the shape an older backend knows when it refuses the new fields as invalid', async () => {
    const s = scoped(), base = s.getMockImplementation()!
    let refused = 0
    s.mockImplementation(async payload => payload.action === 'command' && !refused++ ? { error: 'VALIDATION_ERROR', detail: 'decision.candidates.0: Unrecognized key: "fit"', status: 400 } : base(payload))
    expect(await routeTask(input, s, where as never, opener(), () => 'op')).toMatchObject({ ok: true, routeDecisionId: 'd1' })
    const [phase1, v1] = s.mock.calls.filter(c => c[0].action === 'command').map(c => c[0])
    expect(phase1.command.decision.assessment.size).toBe('medium')
    expect(phase1.command.decision.candidates[0]).toHaveProperty('fit')
    expect(v1.operationId).toBe(phase1.operationId)
    expect(v1.command.decision.assessment).not.toHaveProperty('size')
    expect(v1.command.decision.candidates.some((c: object) => 'fit' in c)).toBe(false)
  })
  it('still routes when recording fails or the connection is lost', async () => {
    const result = await routeTask(input, scoped({ record: { error: 'BACKEND_UNAVAILABLE' } }), where as never, opener())
    expect(result).toMatchObject({ ok: true, via: 'order', unrecorded: true })
    expect(result).not.toHaveProperty('routeDecisionId')
    const lost = await routeTask(input, scoped({ recordThrows: true }), where as never, opener())
    expect(lost).toMatchObject({ ok: true, via: 'order', unrecorded: true })
  })
  it('says when the pick was the only candidate that can run the task', async () => {
    const s = scoped()
    // Only the member's machine answers, and its engine is not installed for a new agent.
    const open = vi.fn(async (_w: unknown, id: string) => id === 'm1'
      ? daemon(id, { agents: ['h1'], engines: [{ engine: 'claude', installed: false }] }) as never : Promise.reject(new Error('gone')))
    expect(await routeTask(input, s, where as never, open as never)).toMatchObject({ ok: true, via: 'only', pick: { agentId: 'a1' } })
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
    expect(reasons).toContain('Required tool missing: git. Required device unavailable: /dev/ttyUSB0.')
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
      'Required tool not verified: git. Ask the machine owner to check it and refresh the machine reading.', 'Required device unavailable: /dev/x.',
      'The subscription has an exhausted usage window. Wait for a fresh allowance reading or choose another account.'])
    const unknown = admission({ resources: {}, tools: {}, devices: {} }, { installed: true, signedIn: true }, quotaOf({}, 'claude', false), { ...requirements, tools: [], devices: [] })
    expect(unknown).toMatchObject({ allowed: true, reasons: [] })
  })
})

describe('what the route log says about each candidate', () => {
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
      history: { ok: true, value: { decisions: [], attempts: [], ...past } } }
  }
  const memberLabel = (s: ReturnType<typeof scoped>) => labels(s).find(l => l.startsWith('Member Multiply'))!
  const newLabel = (s: ReturnType<typeof scoped>) => labels(s).find(l => l.startsWith('New agent'))!

  it('reads the task folder, the member frames and the machines, and labels each candidate with what they say', async () => {
    const s = scoped(world())
    const make = (id: string) => daemon(id, { agents: id === 'm1' ? ['h1', 'x', 'y'] : ['z'], frames: { h1: frame() } })
    const describeRepo = describeGit()
    await routeTask(withCwd, s, where as never, opener(make), () => 'op', describeRepo)
    expect(describeRepo.describe).toHaveBeenCalledWith('/w/api')
    expect(describeRepo.isDirectory).toHaveBeenCalledWith('/w/api')
    expect(memberLabel(s)).toContain('same repo · on "Fix auth" · in api, branch feat/auth · last active 2h ago')
    expect(labels(s).some(l => /^New agent.*remote-1.*has the task folder · 3 agents running · 7\.0 GB memory free/.test(l))).toBe(true)
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
  })
  it('labels a member with its earlier work in this Super Tab, from the state and the log', async () => {
    const decision = (id: string, conversationId: string, patch: Record<string, unknown> = {}) => ({ id, conversationId, title: `Pick ${id}`, via: 'jev', outcome: 'stopped', assignmentId: `as-${id}`,
      createdAt: '2026-10-19T10:00:00Z', final: { kind: 'new', engine: 'claude', model: 'opus' }, ...patch })
    const decisions = [{ ...decision('d7', 'g1', { outcome: null, assignmentId: null, final: null }), via: undefined }, decision('d6', 'g1', { outcome: 'done', assignmentId: 'x', final: { kind: 'member', agentId: 'a1' } }), decision('d5', 'g1'),
      decision('d4', 'other', { final: { kind: 'member', agentId: 'a1' }, outcome: 'done' }), decision('d3', 'g1', { final: null }), decision('d2', 'lead'), decision('d1', 'g1', { outcome: 'superseded' }), decision('d0', 'g1', { final: { kind: 'member', agentId: 'gone' } })]
    const s = scoped(world({ decisions }, { id: 'x', agentId: 'a1', status: 'done', result: 'Shipped.' }))
    await routeTask(input, s, where as never, opener())
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
  it('keeps a stopped attempt in the member\'s earlier work after the group was defined again', async () => {
    // `work.define` took the stopped assignment out of the state and no decision of the log names it (a person assigned it).
    // A row without an id names no assignment and is left out.
    const attempts = [{ agentId: 'a1', status: 'done' }, { id: 'as-2', agentId: 'a1', status: 'done', result: 'Shipped.' }, { id: 'as-1', agentId: 'a1', status: 'stopped', result: 'Tests failed.' }]
    const s = scoped(world({ attempts }))
    await routeTask(input, s, where as never, opener())
    expect(memberLabel(s)).toContain('earlier here: API done; API stopped')
  })
  it('orders the member\'s attempts oldest first, a person\'s assignment before a routed one', async () => {
    // as-1 was assigned by a person (no decision); as-2 was routed. The log alone would list as-2 first.
    const decision = { id: 'd2', conversationId: 'g1', title: 'Pick', via: 'jev', outcome: 'done', assignmentId: 'as-2', createdAt: '2026-10-19T11:00:00Z', final: { kind: 'member', agentId: 'a1' } }
    const attempts = [{ id: 'as-2', agentId: 'a1', status: 'done', result: 'Second.', createdAt: '2026-10-19T11:00:00Z' }, { id: 'as-1', agentId: 'a1', status: 'stopped', result: 'First.', createdAt: '2026-10-19T10:00:00Z' }]
    const s = scoped(world({ decisions: [decision], attempts }, { id: 'as-3', agentId: 'a1', status: 'stopped', result: 'Third.' }))
    await routeTask(input, s, where as never, opener())
    expect(memberLabel(s)).toContain('earlier here: API stopped; API done; API stopped')
    // Without the attempts read the log's order stays.
    const old = scoped(world({ decisions: [decision], attempts: undefined, attemptsUnreadable: true }, { id: 'as-3', agentId: 'a1', status: 'stopped', result: 'Third.' }))
    await routeTask(input, old, where as never, opener())
    expect(memberLabel(old)).toContain('earlier here: API stopped; API done')
  })
  it('lists an attempt once when the log and the attempts both know it', async () => {
    const decision = { id: 'd5', conversationId: 'g1', title: 'Pick', via: 'jev', outcome: 'stopped', assignmentId: 'as-1', createdAt: '2026-10-19T10:00:00Z', final: { kind: 'new', engine: 'claude', model: 'opus' } }
    const s = scoped(world({ decisions: [decision], attempts: [{ id: 'as-1', agentId: 'gone', status: 'stopped', result: 'Out of memory.' }] }, { id: 'as-2', agentId: 'a1', status: 'done', result: 'Shipped.' }))
    await routeTask(input, s, where as never, opener())
    expect(memberLabel(s)).toContain('earlier here: API done')
  })
  it('finds nothing to admit on a machine that reports no capacity', async () => {
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
  it('still routes when a source cannot be read', async () => {
    const run = async (extra: Record<string, unknown>, options: Record<string, unknown> = {}, describeRepo: ReturnType<typeof describeGit> = describeGit()) => {
      const s = scoped(world(extra))
      const answer = await routeTask(withCwd, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], frames: { h1: frame() }, ...options })), () => 'op', describeRepo)
      expect(answer).toMatchObject({ ok: true })
      return s
    }
    expect(memberLabel(await run({}))).toContain('same repo')
    // An older backend (404) and a failed read both leave the attempts and the log out.
    expect(memberLabel(await run({ attempts: undefined, attemptsUnreadable: true }))).toContain('same repo')
    expect(memberLabel(await run({ decisions: undefined, decisionsUnreadable: true }))).toContain('same repo')
    for (const failing of [vi.fn(async () => { throw new Error('git') }), vi.fn(async () => null)]) {
      expect(memberLabel(await run({}, {}, { ...describeGit(), describe: failing as never }))).toContain('repo unknown')
    }
    // A folder read that never answers does not hold the route: it is given up after three seconds.
    vi.useFakeTimers()
    try {
      const pending = run({}, {}, { ...describeGit(), describe: vi.fn(() => new Promise(() => {})) as never })
      await vi.advanceTimersByTimeAsync(3000)
      expect(memberLabel(await pending)).toContain('repo unknown')
    } finally { vi.useRealTimers() }
    // Without the agent list there is no machine load; the members there cannot run, so only new agents are shown.
    expect(newLabel(await run({}, { listFails: true }))).toContain('agents running unknown')
  })
  it('finds a member in the task\'s folder when the Lead\'s machine does not have it', async () => {
    const two = tab(); two.state.agents = [{ ...agents[0], machineId: 'm2' }, agents[1]] as never
    const s = scoped(world({ tab: two }))
    const there = frame({ project: git({ remote: null, root: '/w/api', cwd: '/w/api' }) })
    const reader = describeGit(git(), false)
    await routeTask(withCwd, s, where as never, opener(id => daemon(id, { agents: id === 'm2' ? ['h1'] : [], frames: { h1: there } })), () => 'op', reader)
    expect(memberLabel(s)).toContain('same repo')
    expect(reader.describe).not.toHaveBeenCalled()
  })
  it('says a folder is unknown, not missing, when it cannot be told apart from a refusal', async () => {
    for (const code of ['EACCES', 'ENOTDIR']) {
      const s = scoped(world())
      await routeTask(withCwd, s, where as never, opener(), () => 'op', { describe: vi.fn() as never, isDirectory: async () => { throw Object.assign(new Error(code), { code }) } })
      expect(memberLabel(s)).toContain('repo unknown')
    }
  })
  it('reads the task folder on this machine when no reader is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'route-folder-'))
    try {
      await writeFile(join(dir, 'file'), 'x')
      // A member standing in the folder is in it when the folder is there or absent here; a broken path says nothing.
      for (const [cwd, repo] of [[dir, 'same repo'], [join(dir, 'absent'), 'same repo'], [join(dir, 'file', 'inside'), 'repo unknown']] as const) {
        const s = scoped(world())
        const there = frame({ project: { name: 'x', cwd, root: null, remote: null } })
        await routeTask({ ...input, assessment: { ...input.assessment, needs: { cwd } } }, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], frames: { h1: there } })), () => 'op')
        expect(memberLabel(s)).toContain(repo)
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
      await vi.advanceTimersByTimeAsync(3000)
      expect(await pending).toMatchObject({ ok: true })
    } finally { vi.useRealTimers() }
  })
  it('lists a member whose machine cannot be opened as one whose activity is unknown', async () => {
    const two = tab(); two.state.agents = [...agents, { id: 'a2', name: 'Collab', machineId: 'theirs', harnessId: 'h2', configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' } }] as never
    const s = scoped(world({ tab: two }))
    const open = vi.fn(async (_w: unknown, id: string) => id === 'theirs' ? Promise.reject(new Error('not yours')) : daemon(id, { agents: id === 'm1' ? ['h1'] : [], frames: { h1: frame() }, usage: { providers: [] } })) as never
    await routeTask(input, s, where as never, open)
    expect(labels(s).find(l => l.startsWith('Member Collab'))).toContain('activity unknown')
  })
})


describe('routing contributed capacity', () => {
  const healthy = () => ({ machineId: 'm1', name: 'Contributed laptop', cwd: '/owner/project', engines: ['claude'], paused: false,
    observation: { receivedAt: Date.now(), resources: { memoryTotalBytes: 32e9, memoryUsedBytes: 2e9, projectDiskFreeBytes: 200e9 },
      tools: { git: true }, runningHarnessIds: ['h1'], quotas: [{ engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 20, resetsAt: Date.now() + 3600000 }] }] } })
  async function runPool(pool: Record<string, any>, members = false, needs: Record<string, unknown> = {}, project?: Record<string, unknown>) {
    const groups = conversations()
    if (project) Object.assign(groups[1]!, { projectId: project.id })
    const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: { state: { id: 'tab', agents: members ? agents : [agents[1]], conversations: groups, machines: [pool], ...(project ? { projects: [project] } : {}) } }, policy: { policy, warnings: [] }, machines: [] } } })
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
  it('keeps a healthy contributed member pickable', async () => {
    const { answer, s } = await runPool(healthy(), true)
    expect(answer.ok).toBe(true)
    expect(recorded(s).command.decision.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('Multiply') })]))
  })
  it('withholds a contributed member whose engine account has an exhausted usage window', async () => {
    const pool = healthy(); pool.observation.quotas[0]!.windows[0]!.usedPercent = 100
    const { answer } = await runPool(pool, true)
    expect(answer).toMatchObject({ error: 'NO_CANDIDATE' })
    expect(answer.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('Multiply'),
      reason: expect.stringContaining('exhausted usage window') })]))
  })
  it('withholds a contributed member when a required tool was reported missing', async () => {
    const pool = healthy(); pool.observation.tools.git = false
    const { answer } = await runPool(pool, true)
    expect(answer).toMatchObject({ error: 'NO_CANDIDATE' })
    expect(answer.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('Multiply'),
      reason: expect.stringContaining('Required tool missing: git.') })]))
  })
  it('explains a contributed member tool probe that did not complete', async () => {
    const pool = healthy()
    delete (pool.observation.tools as Record<string, unknown>).git
    Object.assign(pool.observation, { toolProbeErrors: { git: 'interactive shell timed out' } })
    const { answer } = await runPool(pool, true)
    expect(answer).toMatchObject({ error: 'NO_CANDIDATE' })
    expect(answer.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('Multiply'),
      reason: expect.stringMatching(/Required tool not verified: git.*interactive shell timed out.*check it/) })]))
  })
  it('withholds a contributed member absent from an explicit running-terminal list', async () => {
    const pool = healthy(); pool.observation.runningHarnessIds = []
    const { answer, s } = await runPool(pool, true)
    expect(answer).toMatchObject({ ok: true, pick: { kind: 'new' } })
    expect(recorded(s).command.decision.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('Multiply'),
      reason: 'Its terminal is not running.' })]))
  })
  it('keeps a contributed member with no running-terminal list pickable and warns that its terminal is unverified', async () => {
    const pool = healthy(); delete (pool.observation as Partial<typeof pool.observation>).runningHarnessIds
    const { answer, s } = await runPool(pool, true)
    expect(answer.ok).toBe(true)
    expect(recorded(s).command.decision.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('Multiply') })]))
    expect(answer.warnings).toEqual(expect.arrayContaining([expect.stringContaining('terminal could not be verified')]))
  })
  it('withholds a contributed member when a required device was not reported', async () => {
    const { answer } = await runPool(healthy(), true, { devices: ['/dev/ttyUSB0'] })
    expect(answer).toMatchObject({ error: 'NO_CANDIDATE' })
    expect(answer.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('Multiply'),
      reason: expect.stringContaining('Required device unavailable: /dev/ttyUSB0.') })]))
  })
  it('routes each swarm project to its own checkout and never widens an old folder grant', async () => {
    const project = { id: 'project-two', repository: { machineId: 'other', cwd: '/elsewhere', repositoryUrl: 'https://github.com/example/two' } }
    expect((await runPool(healthy(), false, {}, project)).answer.ok).not.toBe(true)
    const shared = { ...healthy(), scope: 'swarm', cwd: '/swarm-root' }
    expect((await runPool(shared, false, {}, project)).answer.next).toContain('/swarm-root/project-two')
    project.repository.machineId = 'm1'
    expect((await runPool(shared, false, {}, project)).answer.next).toContain('/elsewhere')
    expect((await runPool(shared, false, {}, { id: 'project-two' })).answer.ok).not.toBe(true)
    expect((await runPool(shared)).answer.ok).not.toBe(true)
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
  it('distinguishes reported missing tools from unverified contributed probes in route reasons', async () => {
    const missing = healthy(); missing.observation.tools.git = false
    const absent = await runPool(missing)
    expect(absent.answer.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('Required tool missing: git.') })]))

    const unverified = healthy(); delete (unverified.observation.tools as Record<string, unknown>).git
    Object.assign(unverified.observation, { toolProbeErrors: { git: 'interactive shell timed out' } })
    const failed = await runPool(unverified)
    expect(failed.answer.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringMatching(/Required tool not verified: git.*interactive shell timed out/) })]))
  })
})
