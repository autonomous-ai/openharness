import { describe, expect, it, vi, type Mock } from 'vitest'
import type { openDaemon } from '../agentClient/daemon.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELSEWHERE, heldLocalModels, localProbes, NO_SWARM_AGENTS_ON, offlineModels, routeTask, servedModels, STALL_RETRY_MS, stalled } from './routeCommand.js'
import type { describeScmProject } from '../scm/scmProjects.js'
import { admission, quotaOf, RELAYED_QUOTA, USED_UP_WINDOW } from './capacity.js'
import { OTHER_REPOSITORY, type Catalog, type Probe } from './route.js'

// Sonnet rated 3, as an owner who wants Sonnet Builders rates it (a build needs 3: route.ts buildRefusals), so the member these
// specs probe can build; the specs of the floor itself use a table of their own ([floorPolicy]).
const policy = { version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: '', models: [
  { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
  { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 3, cost: 2, enabled: true },
  { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: false },
] }
/** The table with Sonnet at its real rating, 2, for the specs of strength and floors. */
const floorPolicy = { ...policy, models: policy.models.map(m => m.model === 'sonnet' ? { ...m, quality: 2 } : m) }
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
/** Runs [body] with [os] on the list of systems Swarm agents are not started on, as a future entry would put it. */
async function withBlocked(os: string, body: () => Promise<void>) {
  const blocked = NO_SWARM_AGENTS_ON as string[]
  blocked.push(os)
  try { await body() } finally { blocked.splice(blocked.indexOf(os), 1) }
}
function scoped(answers: { record?: Answer; tab?: unknown; context?: Answer; history?: Answer; instructions?: Answer; historyHangs?: boolean; recordThrows?: boolean; policy?: typeof policy } = {}) {
  return vi.fn(async (payload: Record<string, any>): Promise<Record<string, unknown>> => {
    if (payload.action === 'routeContext') return answers.context ?? { ok: true, value: { agentId: 'lead', tab: answers.tab ?? tab(), policy: { policy: answers.policy ?? policy, warnings: ['w'] }, machines: [{ machineId: 'm1', name: 'remote-1' }, { machineId: 'm2', name: 'mac' }] } }
    if (payload.action === 'routeHistory') return answers.historyHangs ? new Promise(() => {}) : answers.history ?? { ok: true, value: { decisions: [], attempts: [] } }
    if (payload.action === 'instructions') return answers.instructions ?? { ok: true, value: { projectId: 'p1', revision: 2, hash: 'h', text: 'Work by this.', template: false, coordinatorName: 'Ana', notes: [{ id: 'n1', text: 'Be quick', askedBy: 'Ken', at: 't', expiresAt: null }] } }
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
  it('never offers OpenCode or Kilo even if an old policy enables them', async () => {
    const oldPolicy = { ...policy, models: [...policy.models.map(model => ({ ...model, enabled: false })),
      { engine: 'opencode', model: 'default', effort: 'default', quality: 3, cost: 1, enabled: true },
      { engine: 'kilo', model: 'default', effort: 'default', quality: 3, cost: 1, enabled: true }] }
    const oldTab = tab(); oldTab.state.agents = [agents[1]]
    const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: oldTab, policy: { policy: oldPolicy },
      machines: [{ machineId: 'm1', name: 'remote-1' }] } } })
    const result = await routeTask(input, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [],
      engines: [{ engine: 'claude', installed: true }, { engine: 'opencode', installed: true }, { engine: 'kilo', installed: true }] })))
    expect(result).toMatchObject({ error: 'NO_CANDIDATE' })
  })
  it('offers the same member after Change agent when only its replacement terminal is live', async () => {
    const rebound = tab()
    rebound.state.agents = agents.map(a => a.id === 'a1' ? { ...a, harnessId: 'replacement' } : a)
    const s = scoped({ tab: rebound })
    const result = await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['replacement'] })), () => 'op')
    expect(result).toMatchObject({ ok: true, pick: { kind: 'member', agentId: 'a1' } })
    expect(recorded(s).command.decision.excluded.some((c: { title: string }) => c.title.startsWith('Multiply'))).toBe(false)
  })
  it('shows the group\'s project instructions and notes in its answer, and still answers when they cannot be read', async () => {
    const s = scoped()
    const result = await routeTask(input, s, where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, instructions: { revision: 2, text: 'Work by this.', notes: [{ text: 'Be quick' }] } })
    expect(result).not.toHaveProperty('instructionsUnreadable')
    expect(s.mock.calls.find(c => c[0].action === 'instructions')![0]).toMatchObject({ projectId: 'lead' })
    const old = scoped({ instructions: { error: 'INSTRUCTIONS_UNAVAILABLE', detail: 'x' } })
    const unread = await routeTask(input, old, where as never, opener(), () => 'op')
    expect(unread).toMatchObject({ ok: true, instructionsUnreadable: true })
    expect(unread).not.toHaveProperty('instructions')
  })
  it('collects members and new agents, records and returns the first in the order, and never asks Jev', async () => {
    const s = scoped()
    const result = await routeTask(input, s, where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, routeDecisionId: 'd1', via: 'order', p: null, pick: { id: 'c0' }, warnings: ['w'] })
    expect(s.mock.calls.map(c => c[0].action)).toEqual(['routeContext', 'routeHistory', 'instructions', 'command'])
    expect(recorded(s).command.decision).not.toHaveProperty('context')
    const record = recorded(s)
    expect(record).toMatchObject({ operationId: 'route-op', command: { type: 'route.record', conversationId: 'g1' } })
    // The idle member Multiply is a candidate. (The idle coordinator is too: 'routing by facts', below.)
    const titles = (record.command.decision.candidates as Array<{ title: string }>).map(c => c.title)
    expect(titles).toContain('Multiply · Claude sonnet medium · remote-1')
    expect((result.alternatives as unknown[]).length).toBeLessThanOrEqual(2)
  })
  // A member at work is not offered; one whose task was lost is, with a note ('a member whose last task was lost').
  it('does not offer a member whose task is working', async () => {
    const state = tab({ id: 'x', agentId: 'a1', status: 'working' })
    const s = scoped({ tab: state })
    await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['h1'] })))
    expect((recorded(s).command.decision.candidates as Array<{ title: string }>).some(c => c.title.startsWith('Multiply'))).toBe(false)
  })
  // v2: one Codex account answered 429 for 40 minutes and stalled reviews. Since the project instructions (phase 4) the
  // account that lost the task is a note on its candidates, not a filter: the agent choosing decides.
  describe('a review whose agent lost it', () => {
    const accountOn = (account: string) => ({ providers: [{ ...usage.providers[0]!, account }] })
    /** `removed`: the Lead stopped the failed Reviewer and its host removed it, so only the group remembers where it failed. */
    const route = async (failed: boolean, machines: string[] = ['m1', 'm2'], removed = false) => {
      const state = tab()
      const reviewer = { id: 'r1', name: 'Reviewer', role: 'reviewer', machineId: 'm1', harnessId: 'hr', configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' },
        ...(failed ? { lostTask: { conversationId: 'g1', assignmentId: 'x', reason: 'its model keeps failing', at: 1 } } : {}) }
      Object.assign(state.state.conversations[1]!, { reviewOf: 'lead', ...(failed ? { assignment: { id: 'x', agentId: 'r1', status: 'lost', lost: { reason: 'its model keeps failing', at: 1 } },
        lostAttempt: { id: 'x', agentId: 'r1', machineId: 'm1', engine: 'claude' } } : {}) })
      state.state.agents = [...agents.filter(a => a.id !== 'a2' || machines.includes('m2')), ...removed ? [] : [reviewer]]
      const s = scoped({ tab: state, context: { ok: true, value: { agentId: 'lead', tab: state, policy: { policy, warnings: [] },
        machines: machines.map(id => ({ machineId: id, name: id === 'm1' ? 'remote-1' : 'mac' })) } } })
      const result = await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['hr'], usage: accountOn(id === 'm1' ? 'acct-1' : 'acct-2') })), () => 'op')
      return { result, s }
    }
    const noted = (s: ReturnType<typeof scoped>) => [...new Set((recorded(s).command.decision.candidates as Array<{ machineId: string; label: string }>)
      .filter(c => c.label.includes('Its account lost this task before')).map(c => c.machineId))]
    it('notes the account whose model failed on its candidates, and still offers them', async () => {
      expect(noted((await route(false)).s)).toEqual([])
      const { result, s } = await route(true)
      expect(result).toMatchObject({ ok: true })
      expect(noted(s)).toEqual(['m1'])
      expect(JSON.stringify(recorded(s).command.decision.excluded)).not.toContain('lost this task')
      // With no other machine, that account is the pick, with the note.
      const alone = await route(true, ['m1'])
      expect(alone.result).toMatchObject({ ok: true, pick: { machineId: 'm1', notes: expect.arrayContaining([expect.stringContaining('Its account lost this task before')]) } })
    })
    it('remembers the failed account after its agent is stopped and removed', async () => {
      expect(noted((await route(true, ['m1', 'm2'], true)).s)).toEqual(['m1'])
    })
  })

  // Final review, Important 3, and project instructions, phase 4: an agent whose last task was lost is offered, with a note
  // while the backend keeps its mark (backend superTabs/model.ts lostTask), which recovery or any assignment clears.
  describe('a member whose last task was lost', () => {
    const lostTask = { conversationId: 'g0', assignmentId: 'x', reason: 'no progress for 30 minutes', at: 1 }
    const healthy = { id: 'a3', name: 'Healthy', machineId: 'm1', harnessId: 'h3', configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' } }
    const earlier = (assignment: Record<string, unknown>, more: Record<string, unknown> = {}) =>
      ({ id: 'g0', title: 'Old', leadId: 'lead', agentIds: ['lead', 'a1'], archived: false, brief: 'Old work.', checks: [], assignment, ...more })
    const lost = { id: 'x', agentId: 'a1', lost: { reason: lostTask.reason, at: 1 } }
    const route = async (members: unknown[], groups: unknown[]) => {
      const state = tab(); Object.assign(state.state, { agents: members, conversations: [...state.state.conversations, ...groups] })
      const s = scoped({ tab: state })
      const result = await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['h1', 'h3'] })), () => 'op')
      const decision = recorded(s).command.decision
      return { result, candidates: (decision.candidates as Array<{ title: string; agentId?: string; label: string }>), excluded: decision.excluded as Array<{ title: string; reason: string }> }
    }
    const marked = agents.map(a => a.id === 'a1' ? { ...a, lostTask } : a)
    const note = 'It lost its last task (no progress for 30 minutes).'
    const lineOf = (candidates: Array<{ title: string; label: string }>, name: string) => candidates.find(c => c.title.startsWith(name))?.label

    it('is offered with a note after its lost task is cancelled, beside a healthy member', async () => {
      const { result, candidates, excluded } = await route([...marked, healthy], [earlier({ ...lost, status: 'cancelled' })])
      expect(lineOf(candidates, 'Multiply')).toContain(note)
      expect(lineOf(candidates, 'Healthy')).not.toContain('lost its last task')
      expect(excluded.some(e => e.title.startsWith('Multiply'))).toBe(false)
      expect(result).toMatchObject({ ok: true, pick: { kind: 'member', agentId: 'a3' } })
    })
    it('is offered with a note after its lost task is handed to another agent', async () => {
      const { result, candidates } = await route([...marked, healthy],
        [earlier({ id: 'y', agentId: 'a3', status: 'working' }, { lostAttempt: { id: 'x', agentId: 'a1' } })])
      expect(lineOf(candidates, 'Multiply')).toContain(note)
      expect(result).toMatchObject({ ok: true, pick: { kind: 'member', agentId: 'a1', notes: [note] } })
    })
    it('carries no note once it finished a new task, which clears its mark', async () => {
      const { candidates } = await route([...agents, healthy],
        [earlier({ ...lost, status: 'cancelled' }), earlier({ id: 'z', agentId: 'a1', status: 'done' }, { id: 'g2' })])
      expect(lineOf(candidates, 'Multiply')).not.toContain('lost its last task')
    })
    it('is offered with a note while its task is still lost', async () => {
      const { candidates } = await route(marked, [earlier({ ...lost, status: 'lost' })])
      expect(lineOf(candidates, 'Multiply')).toContain(note)
    })
    // Re-check of #1749: recovery clears the mark while the old task may still be lost; that task alone says nothing.
    it('carries no note after its terminal was replaced, though its old task is still lost', async () => {
      const replaced = agents.map(a => a.id === 'a1' ? { ...a, harnessId: 'h1b' } : a)
      const state = tab(); Object.assign(state.state, { agents: replaced, conversations: [...state.state.conversations, earlier({ ...lost, status: 'lost' })] })
      const s = scoped({ tab: state })
      await routeTask(input, s, where as never, opener(id => daemon(id, { agents: ['h1b'] })), () => 'op')
      expect(lineOf(recorded(s).command.decision.candidates, 'Multiply')).not.toContain('lost its last task')
    })
    it('carries no note after it finished a newer task, though its old task is still lost', async () => {
      const { candidates } = await route(agents, [earlier({ ...lost, status: 'lost' }), earlier({ id: 'z', agentId: 'a1', status: 'done' }, { id: 'g2' })])
      expect(lineOf(candidates, 'Multiply')).not.toContain('lost its last task')
    })
  })
  // Project instructions, phase 4: an older backend's rules are its own to apply; the route reads none (the instructions'
  // Routing section says what the owner wants).
  it('ignores the owner\'s rules in the tab', async () => {
    const ruled = tab(); (ruled.state as Record<string, unknown>).rules = [{ id: 'r1', rule: { kind: 'forbidModel', model: 'sonnet' }, text: 'No Sonnet.' }, { id: 'r2', text: 7 }]
    const s = scoped({ tab: ruled })
    const result = await routeTask(input, s, where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, pick: { model: 'sonnet' } })
    const decision = recorded(s).command.decision
    expect(decision.candidates.some((c: { model: string }) => c.model === 'sonnet')).toBe(true)
    expect(JSON.stringify(decision)).not.toContain('Breaks the owner')
  })
  it('never offers a Buddy: it brainstorms with its owner and is never assigned work', async () => {
    const t = tab(); t.state.agents = agents.map(a => a.id === 'a1' ? { ...a, buddyOf: { personId: 'peer', generation: 'g' } } : a)
    const s = scoped({ tab: t })
    await routeTask(input, s, where as never, opener(), () => 'op')
    const titles = (recorded(s).command.decision.candidates as Array<{ title: string }>).map(c => c.title)
    expect(titles.some(c => c.startsWith('Multiply'))).toBe(false)
  })
  // Project instructions, phase 4: an agent's role decides nothing here; an older client's Reviewer is a member like any other.
  it('offers an agent of any role for any group', async () => {
    const offered = async (reviewer: boolean, reviewGroup: boolean) => {
      const t = tab(); t.state.agents = agents.map(a => a.id === 'a1' && reviewer ? { ...a, role: 'reviewer' } : a)
      if (reviewGroup) (t.state.conversations[1] as Record<string, unknown>).reviewOf = 'g0'
      const s = scoped({ tab: t })
      const result = await routeTask(input, s, where as never, opener(), () => 'op')
      const titles = (recorded(s).command.decision.candidates as Array<{ title: string }>).map(c => c.title)
      return { member: titles.some(c => c.startsWith('Multiply')), assessment: recorded(s).command.decision.assessment, result }
    }
    for (const [reviewer, reviewGroup] of [[true, false], [false, true], [true, true], [false, false]]) {
      const { member, assessment } = await offered(reviewer!, reviewGroup!)
      expect(member).toBe(true)
      // No kind is forced on a linked task: the agent's own, or none.
      expect(assessment).not.toHaveProperty('kind')
    }
  })
  // Ken, 2026-10-30: reviews of Claude builds waited all morning for Codex quota. Any strong engine reviews any build now.
  it('offers a review the reviewed Builder\'s own engine at once while another engine could review, with no same-engine note', async () => {
    const t = tab(); t.state.agents = agents.map(a => a.id === 'a1' ? { ...a, role: 'reviewer', configuration: { engine: 'claude', model: 'opus', effort: 'high' } } : a)
    t.state.conversations.push({ id: 'g0', title: 'Built', leadId: 'lead', agentIds: ['lead'], archived: false, brief: '', checks: [],
      assignment: { id: 'b', agentId: 'gone', status: 'review', configuration: { engine: 'claude', model: 'opus', effort: 'high' } } } as never)
    Object.assign(t.state.conversations[1]!, { reviewOf: 'g0' })
    // Codex is on in the policy and signed in with quota, so a Codex Reviewer could start too.
    const both = { ...floorPolicy, models: floorPolicy.models.map(m => ({ ...m, enabled: true })) }
    const context = { ok: true, value: { agentId: 'lead', tab: t, policy: { policy: both, warnings: [] }, machines: [{ machineId: 'm1', name: 'remote-1' }] } }
    const s = scoped({ context })
    const result = await routeTask(input, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [],
      engines: [{ engine: 'claude', installed: true, signedIn: true }, { engine: 'codex', installed: true, signedIn: true }] })), () => 'op')
    // The idle Claude Opus agent is a candidate at once; Codex's top tier, cheaper, ranks first.
    expect(result).toMatchObject({ ok: true, pick: { kind: 'new', engine: 'codex' } })
    const decision = recorded(s).command.decision
    expect(decision.candidates.map((c: { title: string }) => c.title)).toContain('Multiply · Claude opus high · remote-1')
    expect(decision.why).not.toMatch(/same-engine/)
    expect(JSON.stringify(decision.excluded)).not.toMatch(/another engine|same-engine|top tier/)
  })
  // 2026-10-30: every Codex Reviewer was out of weekly quota for days, and Claude builds' reviews waited all morning for it.
  // Since Ken's ruling that day the review takes whichever strong Reviewer can start, and waits for no other engine.
  describe('a review while Codex is short of quota', () => {
    const DAY = 86_400_000, MIN = 60_000
    const pool = (machineId: string, engines: string[], weekly: { usedPercent: number; resetsIn: number } = { usedPercent: 10, resetsIn: 5 * DAY }) => ({
      machineId, name: machineId, cwd: '/w', engines, paused: false, contributorId: 'owner',
      observation: { receivedAt: Date.now(), resources: { memoryTotalBytes: 32e9, memoryUsedBytes: 2e9, projectDiskFreeBytes: 200e9 }, tools: { git: true }, runningHarnessIds: [],
        quotas: engines.map(engine => ({ engine, known: true, windows: [{ name: '5-hour', usedPercent: 20, resetsAt: Date.now() + 3600000 },
          { name: 'weekly', usedPercent: engine === 'codex' ? weekly.usedPercent : 10, resetsAt: Date.now() + (engine === 'codex' ? weekly.resetsIn : 5 * DAY) }] })) } })
    const both = { ...floorPolicy, models: floorPolicy.models.map(m => ({ ...m, enabled: true })) }
    const routeWith = async (codexBox: Record<string, unknown>) => {
      const t = tab(); t.state.agents = [] as never
      t.state.conversations.push({ id: 'g0', title: 'Built', leadId: 'lead', agentIds: ['lead'], archived: false, brief: '', checks: [],
        assignment: { id: 'b', agentId: 'gone', status: 'review', configuration: { engine: 'claude', model: 'opus', effort: 'high' } } } as never)
      Object.assign(t.state.conversations[1]!, { reviewOf: 'g0' })
      Object.assign(t.state, { machines: [pool('m1', ['claude']), codexBox] })
      const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: t, policy: { policy: both, warnings: [] }, machines: [] } } })
      const result = await routeTask(input, s, where as never, opener(), () => 'op')
      return { result, decision: 'error' in result ? null : recorded(s).command.decision }
    }
    const opusNow = { ok: true, pick: { engine: 'claude', model: 'opus', machineId: 'm1' } }

    it('starts Claude Opus at once for a Claude build while Codex is out of quota for days, with no note', async () => {
      const { result, decision } = await routeWith(pool('m2', ['codex'], { usedPercent: 100, resetsIn: 3 * DAY }))
      expect(result).toMatchObject(opusNow)
      expect(decision.why).not.toMatch(/same-engine/)
    })

    it('waits for no Codex window that resets soon', async () => {
      const { result, decision } = await routeWith(pool('m2', ['codex'], { usedPercent: 100, resetsIn: 10 * MIN }))
      expect(result).toMatchObject(opusNow)
      expect(JSON.stringify(decision.excluded)).not.toMatch(/another engine/)
    })
  })
  // Project instructions, phase 4: strength ranks, it does not filter. The idle Sonnet member is offered below the top tier.
  it('ranks an idle Sonnet member below the top tier, and tells the server when a person named the model', async () => {
    const s = scoped({ policy: floorPolicy })
    expect(await routeTask(input, s, where as never, opener(), () => 'op')).toMatchObject({ ok: true, pick: { kind: 'new', model: 'opus' } })
    expect(recorded(s).command.decision.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Multiply · Claude sonnet medium · remote-1', quality: 2 })]))
    expect(JSON.stringify(recorded(s).command.decision.excluded)).not.toContain('rated 3')
    const named = scoped({ policy: floorPolicy })
    expect(await routeTask({ ...input, assessment: { ...input.assessment, model: 'sonnet' } }, named, where as never, opener(), () => 'op'))
      .toMatchObject({ ok: true, pick: { kind: 'member', agentId: 'a1' } })
    expect(recorded(named).command.decision.assessment).toMatchObject({ model: 'sonnet' })
  })
  it('tells the agent how to assign a member or start a new agent with the decision', async () => {
    const member = await routeTask(input, scoped(), where as never, opener(), () => 'op')
    // Cheapest first: the member on sonnet.
    expect(member).toMatchObject({ pick: { kind: 'member', agentId: 'a1' } })
    expect(member.next).toContain('"type":"work.assign","conversationId":"g1","agentId":"a1","routeDecisionId":"d1"')
    const fresh = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high' } }, scoped({ policy: floorPolicy }), where as never, opener(), () => 'op')
    expect(fresh).toMatchObject({ pick: { kind: 'new', engine: 'claude', model: 'opus', effort: 'high' } })
    expect(fresh.next).toContain('"engine":"claude","model":"opus","effort":"high","routeDecisionId":"d1"')
    // Without a branch the agent starts from the default one, and the hint says how to choose another.
    expect(fresh.next).toContain('"branchRef":"refs/remotes/origin/BRANCH"')
    expect(fresh.next).toContain('default branch, fetched first')
    // A complete start: every field its schema requires, with the defaults the help gives.
    const hint = JSON.parse(/start OPERATION_ID (\{.*\}), then/.exec(fresh.next as string)![1]!)
    expect(hint).toEqual({ conversationId: 'g1', name: 'NAME', roleName: 'ROLE', cwd: '/absolute/repo/on/that/machine', worktree: true,
      requirements: { memoryBytes: 2147483648, diskBytes: 10737418240, maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false },
      machineId: 'm2', engine: 'claude', model: 'opus', effort: 'high', routeDecisionId: 'd1' })
    // The task's own repository, when the assessment named one, and no decision when none was recorded.
    const placed = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high', needs: { cwd: '/repo/api' } } },
      scoped({ record: { error: 'BACKEND_UNAVAILABLE' }, policy: floorPolicy }), where as never, opener(), () => 'op')
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
    const result = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high' } }, scoped({ policy: floorPolicy }), where as never, make, () => 'op')
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
  it('starts no new agent on an account machine whose system is on the list, and keeps a member already there', async () => {
    // The list is empty now (#1969); it stays for a system Swarm agents cannot run on yet.
    const os = 'Plan 9'
    const plan9 = opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], capacity: { resources: { memoryTotalBytes: 8e9, memoryUsedBytes: 1e9, cpuPercent: 10, projectDiskFreeBytes: 1e11, os }, tools: { git: true }, devices: {} } }))
    const s = scoped()
    await withBlocked(os, async () => expect(await routeTask(input, s, where, plan9)).toMatchObject({ ok: true, pick: { kind: 'member' } }))
    expect(recorded(s).command.decision.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('New agent'),
      reason: expect.stringContaining('Swarm agents do not run on Plan 9 yet.') })]))
  })
  it('offers new agents on an account machine that runs Windows, as on any other, and notes where the last two starts started nothing', async () => {
    // Swarm agents were kept off Windows while grid's CLI did not run there (2026-10-26). It does since grid 0.3.61 and CLI
    // 0.4.95: a Claude Code agent on a grid model started and answered on DESKTOP-0TFH0OJ.
    const windows = opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], capacity: { resources: { memoryTotalBytes: 8e9, memoryUsedBytes: 1e9, cpuPercent: 10, projectDiskFreeBytes: 1e11, os: 'Windows' }, tools: { git: true }, devices: {} } }))
    const s = scoped()
    await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high' } }, s, where, windows)
    const decision = recorded(s).command.decision
    expect(decision.candidates.some((c: { title: string }) => c.title.startsWith('New agent'))).toBe(true)
    expect(JSON.stringify(decision.excluded)).not.toContain('Windows')
    const failed = { id: 's', request: { machineId: 'm1' }, harnessId: null, dispatched: true, error: 'The engine did not start.' }
    const t = tab(); Object.assign(t.state, { starts: [failed, { ...failed, id: 's2' }] })
    const stuck = scoped({ tab: t })
    await routeTask(input, stuck, where, opener())
    // A note on its new agents, not a filter (project instructions, phase 4); a member there is not a start.
    const rows = recorded(stuck).command.decision.candidates as Array<{ title: string; label: string; machineId: string }>
    expect(rows.filter(r => r.machineId === 'm1' && r.title.startsWith('New agent')).every(r => r.label.includes('last 2 starts'))).toBe(true)
    expect(rows.filter(r => r.machineId === 'm1' && r.title.startsWith('New agent'))).not.toHaveLength(0)
    expect(rows.find(r => r.title.startsWith('Multiply'))!.label).not.toContain('last 2 starts')
  })
  // Mac Auto, Swarm autonomous-harness, 2026-10-29: two starts failed on Harness bugs later fixed and released, and the machine
  // stayed out of every route until a person started an agent there by hand.
  it('lets a machine back into routes once its failed starts say nothing about it: updated since, or 30 minutes old', () => {
    const now = Date.parse('2026-10-29T10:00:00Z')
    const failed = (id: string, at: number, version?: string) => ({ id, request: { machineId: 'm1' }, harnessId: null, dispatched: true,
      error: 'Mac Auto did not start it within 3 minutes', dispatchedAt: at, ...(version ? { dispatchedVersion: version } : {}) })
    const two = [failed('s1', now - 20 * 60_000, '0.5.1'), failed('s2', now - 10 * 60_000, '0.5.1')]
    expect(stalled(two, 'm1', { clientVersion: '0.5.1' }, now)).toBe(true)
    // Its daemon now runs another version than the newer failure was dispatched to.
    expect(stalled(two, 'm1', { clientVersion: '0.5.6' }, now)).toBe(false)
    // A failure on the version it runs now still counts, whatever the one before was dispatched to.
    expect(stalled([two[0]!, failed('s3', now - 60_000, '0.5.6')], 'm1', { clientVersion: '0.5.6' }, now)).toBe(true)
    // Routing tries once again after the window, and a start that fails then keeps it out another window.
    expect(stalled(two, 'm1', {}, now - 10 * 60_000 + STALL_RETRY_MS)).toBe(false)
    expect(stalled([two[1]!, failed('s4', now + STALL_RETRY_MS, '0.5.1')], 'm1', {}, now + STALL_RETRY_MS + 60_000)).toBe(true)
    // A start from before either was recorded counts as before; one that started an agent, or one still being created, never stalls.
    const old = { id: 'o', request: { machineId: 'm1' }, harnessId: null, dispatched: true, error: 'failed' }
    expect(stalled([old, { ...old, id: 'o2' }], 'm1', { clientVersion: '0.5.6' }, now)).toBe(true)
    expect(stalled([two[0]!, { ...two[1]!, harnessId: 'h', error: null }], 'm1', {}, now)).toBe(false)
    expect(stalled([two[0]!, { ...two[1]!, error: null }], 'm1', {}, now)).toBe(false)
    // A Team account's refusal of a model its owner is not offered says the request was wrong, not the machine: it never
    // counts, so the two failures before it decide (start.ts, Fork A's refusal before anything launches).
    const refused = (id: string) => ({ id, request: { machineId: 'm1' }, harnessId: null, dispatched: false, requestedAt: now,
      error: "This machine's ChatGPT account (its owner's subscription, used through the owner's relay) does not offer gpt-6.1-sol; it offers gpt-6-luna, gpt-5.6-terra." })
    expect(stalled([refused('r1'), refused('r2')], 'm1', {}, now)).toBe(false)
    expect(stalled([two[0]!, refused('r3'), refused('r4')], 'm1', {}, now)).toBe(false)
    expect(stalled([...two, refused('r5')], 'm1', { clientVersion: '0.5.1' }, now)).toBe(true)
    // A start queued and never picked up is dated by its request.
    const queued = (id: string) => ({ id, request: { machineId: 'm1' }, harnessId: null, dispatched: false, error: null, requestedAt: now - STALL_RETRY_MS - 1 })
    expect(stalled([queued('q1'), queued('q2')], 'm1', {}, now)).toBe(false)
  })
  it('routes again to a machine whose last 2 starts failed more than 30 minutes ago', async () => {
    const failed = { id: 's', request: { machineId: 'm1' }, harnessId: null, dispatched: true, error: 'The engine did not start.',
      dispatchedAt: Date.now() - STALL_RETRY_MS - 60_000 }
    const t = tab(); Object.assign(t.state, { starts: [failed, { ...failed, id: 's2' }] })
    const s = scoped({ tab: t })
    await routeTask(input, s, where, opener())
    expect(JSON.stringify(recorded(s).command.decision)).not.toContain('last 2 starts')
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
    // A member launched on Claude's own model ranks first where the catalog rates that model 3; with no row it is unrated, at 1.
    const options = { tab: plain, record: { error: 'BACKEND_UNAVAILABLE' }, policy: floorPolicy }
    const rated = { ...options, policy: { ...floorPolicy, models: [...floorPolicy.models, { engine: 'claude', model: 'default', effort: 'default', quality: 3, cost: 1, enabled: true }] } }
    const easy = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'low' } }, scoped(rated), where as never, opener())
    expect(easy).toMatchObject({ unrecorded: true, pick: { kind: 'member', title: 'Member · Claude default default · remote-1' } })
    expect(easy.next).not.toContain('routeDecisionId')
    const hard = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'high' } }, scoped(options), where as never, opener())
    expect(hard).toMatchObject({ unrecorded: true, pick: { kind: 'new' } })
    expect(hard.next).not.toMatch(/routeDecisionId"|same routeDecisionId/)
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
    // The two members there, the idle coordinator among them.
    expect(decision.candidates.map((c: { agentId?: string }) => c.agentId)).toEqual(['a1', 'lead'])
    // New agents there stay excluded: nothing can start on a machine nobody can open.
    expect(decision.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'Machine is offline or unreachable.' })]))
    expect(decision.excluded.some((e: { title: string }) => e.title.startsWith('Multiply'))).toBe(false)
  })
  it('ranks a member whose quota is known before one on a machine that cannot be read, and shows both', async () => {
    const two = tab(); two.state.agents = [...agents, { id: 'a2', name: 'Collab', machineId: 'theirs', harnessId: 'h2', configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' } }] as never
    const s = scoped({ tab: two })
    const open = vi.fn(async (_w: unknown, id: string) => id === 'theirs' ? Promise.reject(new Error('not yours')) : daemon(id, { agents: id === 'm1' ? ['h1'] : [] })) as never
    // theirs is not in the account's list, m1 is; the collaborator's member there has an unknown quota.
    const result = await routeTask(input, s, where as never, open)
    expect(result).toMatchObject({ ok: true, pick: { agentId: 'a1' } })
    const titles = (recorded(s).command.decision.candidates as Array<{ title: string }>).map(c => c.title)
    expect(titles.indexOf('Multiply · Claude sonnet medium · remote-1')).toBeLessThan(titles.indexOf('Collab · Claude sonnet medium · theirs'))
    expect(JSON.stringify(recorded(s).command.decision.excluded)).not.toContain('Collab')
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
      { id: 'a5', name: 'Mini hand', machineId: 'm1', harnessId: 'h5', configuration: { engine: 'codex', model: 'gpt-5.5-mini', effort: 'high' } },
      agents[1]] as never
    // Codex hand was launched on the engine's own model, which it reports by its slug; Mini hand was launched on a model the
    // policy does not name (review of #2137).
    Object.assign(working.state, { starts: [{ harnessId: 'h4', request: { model: 'default' } }, { harnessId: 'h5', request: { model: 'gpt-5.5-mini' } }] })
    const s = scoped({ tab: working, policy: floorPolicy })
    const open = opener(id => daemon(id, { agents: id === 'm1' ? ['h1', 'h3', 'h4', 'h5'] : [], usage: { providers: [] }, engines: [{ engine: 'claude', installed: true, signedIn: true }, { engine: 'codex', installed: true, signedIn: true }] }))
    await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'low' } }, s, where as never, open)
    const candidates = recorded(s).command.decision.candidates as Array<{ title: string; quality: number; cost: number; label: string }>
    const rated = Object.fromEntries(candidates.filter(c => /hand/.test(c.title)).map(c => [c.title.split(' · ')[0], [c.quality, c.cost]]))
    expect(rated).toEqual({ 'Opus hand': [3, 3], 'Codex hand': [3, 2], 'Sonnet hand': [2, 2], 'Mini hand': [1, 1] })
    // A model the catalog does not rate is offered unrated, and its line says so.
    expect(candidates.find(c => c.title.startsWith('Mini hand'))!.label).toContain('unrated')
    expect(candidates.find(c => c.title.startsWith('Sonnet hand'))!.label).toContain('strength 2')
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
  it('keeps a queued start in the reroute quota hold until its linked work finishes', async () => {
    const queued = { id: 'queued', conversationId: 'g1', account: 'acct', spend: { '5-hour': 45 }, size: 'medium',
      final: { kind: 'new', startId: 'start-1', engine: 'claude', model: 'opus' }, assignmentId: null,
      outcome: null as string | null, createdAt: new Date().toISOString() }
    const routeWith = async (decision: typeof queued) => {
      const s = scoped({ history: { ok: true, value: { decisions: [decision], attempts: [] } } })
      await routeTask(input, s, where as never, opener(), () => 'op')
      return recorded(s).command.decision.candidates as Array<{ fit: { status: string } }>
    }
    expect((await routeWith(queued)).every(candidate => candidate.fit.status === 'short')).toBe(true)
    expect((await routeWith({ ...queued, outcome: 'done' })).some(candidate => candidate.fit.status === 'fits')).toBe(true)
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
  it('records the job kind, leaving only it out for a backend from before kinds, and phase 1 fields only after a second refusal', async () => {
    const kinded = { ...input, assessment: { ...input.assessment, kind: 'docs' } }
    const commands = (s: ReturnType<typeof scoped>) => s.mock.calls.filter(c => c[0].action === 'command').map(c => c[0].command.decision.assessment)
    const current = scoped()
    await routeTask(kinded, current, where as never, opener(), () => 'op')
    expect(commands(current)).toEqual([{ difficulty: 'medium', risk: 'low', why: 'Endpoint.', size: 'medium', kind: 'docs' }])
    const refusing = (keys: string[]) => {
      const s = scoped(), base = s.getMockImplementation()!
      s.mockImplementation(async payload => {
        const sent = payload.action === 'command' ? JSON.stringify(payload.command) : ''
        return keys.some(key => sent.includes(`"${key}"`)) ? { error: 'VALIDATION_ERROR', detail: `Unrecognized key: "${keys[0]}"`, status: 400 } : base(payload)
      })
      return s
    }
    const beforeKinds = refusing(['kind":"docs'])
    expect(await routeTask(kinded, beforeKinds, where as never, opener(), () => 'op')).toMatchObject({ ok: true, routeDecisionId: 'd1' })
    expect(commands(beforeKinds).map(a => Object.keys(a))).toEqual([['difficulty', 'risk', 'why', 'size', 'kind'], ['difficulty', 'risk', 'why', 'size']])
    const beforePhase1 = refusing(['kind":"docs', 'size'])
    expect(await routeTask(kinded, beforePhase1, where as never, opener(), () => 'op')).toMatchObject({ ok: true, routeDecisionId: 'd1' })
    expect(commands(beforePhase1).map(a => Object.keys(a))).toEqual([['difficulty', 'risk', 'why', 'size', 'kind'], ['difficulty', 'risk', 'why', 'size'], ['difficulty', 'risk', 'why']])
    // A task with no kind never needs the extra try.
    const plain = refusing(['size'])
    await routeTask(input, plain, where as never, opener(), () => 'op')
    expect(commands(plain)).toHaveLength(2)
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
  // Project instructions, phase 4: quota is information, not a gate.
  it('offers a member on a used-up account with a note, and one whose quota is merely unknown without one', async () => {
    const exhausted = { providers: [{ provider: 'claude', outcome: 'answered', httpStatus: 200, body: { five_hour: { utilization: 100 } } }] }
    const line = (s: ReturnType<typeof scoped>) => (recorded(s).command.decision.candidates as Array<{ title: string; label: string }>).find(c => c.title.startsWith('Multiply'))?.label
    const s = scoped()
    await routeTask(input, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], usage: id === 'm1' ? exhausted : usage })))
    expect(line(s)).toContain(USED_UP_WINDOW)
    const t = scoped()
    await routeTask(input, t, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], usage: { providers: [] } })))
    expect(line(t)).toBeDefined()
    expect(line(t)).not.toContain(USED_UP_WINDOW)
  })
  it('notes a member whose screen showed a usage limit until its reset time, and not after', async () => {
    const limited = (until: string | null) => { const t = tab(); t.state.agents = agents.map(a => a.id === 'a1' ? { ...a, limitedUntil: until } : a); return t }
    const line = (s: ReturnType<typeof scoped>) => (recorded(s).command.decision.candidates as Array<{ title: string; label: string }>).find(c => c.title.startsWith('Multiply'))?.label
    const s = scoped({ tab: limited(new Date(Date.now() + 30 * 60_000).toISOString()) })
    await routeTask(input, s, where as never, opener())
    expect(line(s)).toContain('usage limit')
    for (const until of [new Date(Date.now() - 60_000).toISOString(), null]) {
      const t = scoped({ tab: limited(until) })
      await routeTask(input, t, where as never, opener())
      expect(line(t)).not.toContain('usage limit')
    }
  })
  it('uses the real admission texts the member refusal filter keys on', () => {
    const quota = quotaOf({ providers: [{ provider: 'claude', outcome: 'answered', httpStatus: 200, body: { five_hour: { utilization: 100 } } }] }, 'claude', false)
    const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: ['git'], devices: ['/dev/x'], quotaRequired: false }
    const { reasons, unknown: unknowns } = admission({ resources: {}, tools: {}, devices: {} }, { installed: true, signedIn: true }, quota, requirements)
    expect(unknowns).toContain(USED_UP_WINDOW)
    expect(reasons).toEqual([
      'Required tool not verified: git. Ask the machine owner to check it and refresh the machine reading.', 'Required device unavailable: /dev/x.'])
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
    // The task names a folder and the member works in another repository (Diego, 2026-10-30, #2377): it cannot run there, so
    // it is left out with why.
    expect(memberLabel(s)).toBeUndefined()
    expect(recorded(s).command.decision.excluded).toContainEqual(expect.objectContaining({ title: expect.stringContaining('Multiply'), reason: OTHER_REPOSITORY }))
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
  async function runPool(pool: Record<string, any>, members = false, needs: Record<string, unknown> = {}, project?: Record<string, unknown>,
    more: { state?: Record<string, unknown>; tab?: Record<string, unknown>; review?: boolean; kind?: string } = {}) {
    const groups = conversations()
    if (project) Object.assign(groups[1]!, { projectId: project.id })
    if (more.review) Object.assign(groups[1]!, { reviewOf: 'g0' })
    // Without members, no agent at all: the idle coordinator is a member candidate too (project instructions, phase 4).
    const crew = members ? agents.map(a => more.review && a.id === 'a1' ? { ...a, role: 'reviewer' } : a) : []
    const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: { ...more.tab, state: { id: 'tab', agents: crew, conversations: groups, machines: [pool], ...(project ? { projects: [project] } : {}), ...more.state } }, policy: { policy, warnings: [] }, machines: [] } } })
    const open = opener()
    const answer = await routeTask({ ...input, assessment: { ...input.assessment, needs, ...(more.kind ? { kind: more.kind } : {}) } }, s, where, open)
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
  it('reads an old OpenCode contribution as its installed Claude observation', async () => {
    const pool = healthy()
    pool.engines = ['opencode']
    const { answer, s } = await runPool(pool)
    expect(answer).toMatchObject({ ok: true, pick: { engine: 'claude' } })
    expect(recorded(s).command.decision.candidates.every((c: { engine: string }) => c.engine === 'claude')).toBe(true)
  })
  it('keeps a healthy contributed member pickable', async () => {
    const { answer, s } = await runPool(healthy(), true)
    expect(answer.ok).toBe(true)
    expect(recorded(s).command.decision.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('Multiply') })]))
  })
  // Project instructions, phase 4: quota is information, not a gate.
  it('offers a contributed member and new agents on a used-up account, each with a note', async () => {
    const pool = healthy(); pool.observation.quotas[0]!.windows[0]!.usedPercent = 100
    const { answer, s } = await runPool(pool, true)
    expect(answer).toMatchObject({ ok: true })
    const rows = recorded(s).command.decision.candidates as Array<{ title: string; label: string }>
    expect(rows.map(r => r.title)).toEqual(expect.arrayContaining([expect.stringContaining('Multiply'), expect.stringContaining('New agent')]))
    expect(rows.every(r => r.label.includes(USED_UP_WINDOW))).toBe(true)
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
  // v1 routing (#229): the route sent work to a Windows machine that never started agents, to machines without the
  // project and to machines that could not push. A machine that says it cannot do the work is left out, with why; one
  // that says nothing is not. Since the project instructions (phase 4), a login that cannot push is a note: whether the
  // work pushes is the instructions' to say.
  describe('what a machine says it is ready for', () => {
    const reasons = (answer: Record<string, unknown>) => (answer.excluded as Array<{ title: string; reason: string }>)
    const project = { id: 'p2', ownerId: 'owner', repository: { machineId: 'other', cwd: '/elsewhere', repositoryUrl: 'https://github.com/Example/Two.git' } }
    const swarm = (checkouts?: unknown[], engines?: unknown[]) => {
      const pool: Record<string, any> = { ...healthy(), scope: 'swarm', cwd: '/swarm-root', contributorId: 'owner' }
      pool.observation.readiness = { ...(checkouts ? { checkouts } : {}), ...(engines ? { engines } : {}) }
      return pool
    }
    const checkout = (extra: Record<string, unknown> = {}) => ({ folder: 'p2', repository: 'github.com/example/two', git: true, push: true, ...extra })

    it('never starts a Swarm agent on a contributed machine whose system is on the list, and keeps a member already there', async () => {
      const plan9 = healthy(); Object.assign(plan9.observation.resources, { os: 'Plan 9' })
      await withBlocked('Plan 9', async () => {
        const { answer } = await runPool(plan9)
        expect(answer).toMatchObject({ error: 'NO_CANDIDATE' })
        expect(reasons(answer)[0]!.reason).toContain('Swarm agents do not run on Plan 9 yet')
        expect((await runPool(plan9, true)).answer).toMatchObject({ ok: true, pick: { kind: 'member' } })
      })
    })

    it('routes on Windows exactly as on any other machine, with or without members there', async () => {
      const windows = healthy(); Object.assign(windows.observation.resources, { os: 'Windows' })
      for (const members of [false, true]) {
        const onWindows = (await runPool(windows, members)).answer
        expect(onWindows.ok).toBe(true)
        expect(onWindows.pick).toEqual((await runPool(healthy(), members)).answer.pick)
      }
    })

    it('leaves out an engine the machine says is signed out or not installed, and keeps one whose sign-in is unknown', async () => {
      const out = await runPool(swarm(undefined, [{ engine: 'claude', installed: true, signedIn: false }]), false, {}, project)
      expect(out.answer).toMatchObject({ error: 'NO_CANDIDATE' })
      expect(reasons(out.answer)[0]!.reason).toContain('Claude Code is not signed in to a subscription on this machine.')
      const missing = await runPool(swarm(undefined, [{ engine: 'claude', installed: false, signedIn: null }]), false, {}, project)
      expect(reasons(missing.answer)[0]!.reason).toContain('Claude Code is not installed on this machine.')
      for (const engines of [[{ engine: 'claude', installed: true, signedIn: null }], [{ engine: 'claude', installed: null, signedIn: null }], [{ engine: 'codex', installed: true, signedIn: false }], [{ engine: 'cursor', installed: false, signedIn: null }], []]) {
        expect((await runPool(swarm(undefined, engines), false, {}, project)).answer.ok).toBe(true)
      }
    })

    it('says why an engine\'s allowance is unknown, from the machine\'s reading', async () => {
      const pool = swarm()
      pool.observation.quotas = [{ engine: 'claude', known: false, windows: [] }]
      pool.observation.quotaReasons = { claude: 'Anthropic is limiting how often the allowance can be read.' }
      const { answer, s } = await runPool(pool, false, {}, project)
      expect(answer.ok).toBe(true)
      expect(JSON.stringify(recorded(s).command.decision)).toContain('quota unknown (Anthropic is limiting how often the allowance can be read.)')
      delete pool.observation.quotaReasons
      const older = JSON.stringify(recorded((await runPool(pool, false, {}, project)).s).command.decision)
      expect(older).toContain('quota unknown')
      expect(older).not.toContain('quota unknown (')
    })

    it('leaves out an engine the server says is suspended on the machine, with why, and keeps the others', async () => {
      const pool = swarm()
      pool.suspendedEngines = { claude: 'Claude Code is suspended on this machine: its last 2 starts there failed.' }
      const out = await runPool(pool, false, {}, project)
      expect(out.answer).toMatchObject({ error: 'NO_CANDIDATE' })
      expect(reasons(out.answer)[0]!.reason).toContain('Claude Code is suspended on this machine: its last 2 starts there failed.')
      pool.suspendedEngines = { codex: 'Codex is suspended on this machine: its last 2 starts there failed.' }
      expect((await runPool(pool, false, {}, project)).answer.ok).toBe(true)
      // The machine's own reading says more, and goes first: what its owner can fix there, not the count of failed starts.
      // An engine this CLI does not run, or a reason that is not words, is not read.
      const unsigned = swarm(undefined, [{ engine: 'claude', installed: true, signedIn: false }])
      unsigned.suspendedEngines = { claude: 'Claude Code is suspended on this machine: its last 2 starts there failed.', gemini: 'Suspended.', codex: 2 }
      const both = await runPool(unsigned, false, {}, project)
      expect(both.answer).toMatchObject({ error: 'NO_CANDIDATE' })
      expect(reasons(both.answer)[0]!.reason).toContain('not signed in to a subscription')
      expect(JSON.stringify(reasons(both.answer))).not.toMatch(/suspended|Suspended/)
    })

    it('still offers a local model on a machine whose engine is signed out, since the grid needs no subscription', async () => {
      const grid = 'swarm-0123456789ab', pool = swarm(undefined, [{ engine: 'claude', installed: true, signedIn: false }])
      pool.observation.localModels = [{ grid, model: 'qwen3' }]
      const { answer, s } = await runPool(pool, false, {}, project, { state: { localModels: { grid, enabled: true } }, kind: 'tests' })
      expect(answer).toMatchObject({ ok: true, pick: { gridModel: 'qwen3' } })
      expect(recorded(s).command.decision.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('not signed in') })]))
    })

    it('leaves out a project folder that is not a checkout of the project\'s repository', async () => {
      const plain = await runPool(swarm([checkout({ git: false, repository: null, push: null })]), false, {}, project)
      expect(plain.answer).toMatchObject({ error: 'NO_CANDIDATE' })
      expect(reasons(plain.answer)[0]!.reason).toContain('is not a git checkout')
      const other = await runPool(swarm([checkout({ repository: 'github.com/example/other' })]), false, {}, project)
      expect(reasons(other.answer)[0]!.reason).toContain('checkout of another repository')
      // Its own repository under another address, no folder yet (it is cloned on start), or a remote it cannot name.
      for (const checkouts of [[checkout()], [checkout({ folder: 'p9', git: false })], [checkout({ repository: null })]]) {
        expect((await runPool(swarm(checkouts), false, {}, project)).answer.ok).toBe(true)
      }
      expect((await runPool(swarm([checkout({ repository: 'github.com/example/other' })]), false, {}, { ...project, repository: { ...project.repository, repositoryUrl: undefined, machineId: 'm1' } })).answer.ok).toBe(true)
    })

    const lines = (s: ReturnType<typeof scoped>) => recorded(s).command.decision.candidates as Array<{ title: string; label: string }>
    it('notes a machine whose login cannot push, on members and new agents, for any task', async () => {
      const denied = swarm([checkout({ push: false })])
      for (const review of [false, true]) {
        const work = await runPool(denied, true, {}, project, { review })
        expect(work.answer).toMatchObject({ ok: true })
        const rows = lines(work.s).filter(r => !r.title.startsWith('Lead'))
        expect(rows.map(r => r.title)).toEqual(expect.arrayContaining([expect.stringContaining('Multiply'), expect.stringContaining('New agent')]))
        expect(rows.every(r => r.label.includes('cannot push to the project repository'))).toBe(true)
      }
      // An unknown push says nothing.
      expect(JSON.stringify(lines((await runPool(swarm([checkout({ push: null })]), false, {}, project)).s))).not.toContain('cannot push')
    })

    it('ignores the machine\'s own login when a teammate\'s project pushes through the Harness GitHub App', async () => {
      const mates = { ...project, ownerId: 'mate' }
      const noted = async (p: Record<string, unknown>, tab?: Record<string, unknown>) =>
        JSON.stringify(lines((await runPool(swarm([checkout({ push: false })]), false, {}, p, tab ? { tab } : {})).s)).includes('cannot push')
      expect(await noted(mates, { githubApp: true })).toBe(false)
      // The owner's own project still pushes with the owner's login, and without the App so does a teammate's.
      expect(await noted(project, { githubApp: true })).toBe(true)
      expect(await noted(mates)).toBe(true)
    })

    it('notes a machine whose last two starts started nothing, until one does', async () => {
      const start = (extra: Record<string, unknown>) => ({ id: `s${Math.random()}`, request: { machineId: 'm1' }, harnessId: null, dispatched: false, error: null, ...extra })
      const failed = start({ error: 'Claude Code is not signed in.' }), queued = start({}), started = start({ harnessId: 'h9', dispatched: true })
      const stuck = await runPool(healthy(), true, {}, undefined, { state: { starts: [started, failed, queued] } })
      expect(stuck.answer).toMatchObject({ ok: true, pick: { kind: 'member' } })
      const rows = lines(stuck.s)
      expect(rows.filter(r => r.title.startsWith('New agent')).every(r => r.label.includes('last 2 starts'))).toBe(true)
      expect(rows.find(r => r.title.startsWith('Multiply'))!.label).not.toContain('last 2 starts')
      for (const starts of [[failed, started], [failed], [failed, start({ dispatched: true })], [failed, queued].map(s => ({ ...s, request: { machineId: 'm9' } }))]) {
        const { answer, s } = await runPool(healthy(), false, {}, undefined, { state: { starts } })
        expect(answer.ok).toBe(true)
        expect(JSON.stringify(lines(s))).not.toContain('last 2 starts')
      }
    })
  })

  // 2026-10-27: a task to check a device plugged into one person's Mac went to another machine by policy order. Since the
  // project instructions (phase 4) the requirement is not enforced: every other machine says it is not the required one.
  describe('a task that requires a machine', () => {
    const two = (diego: (p: any) => void = () => {}) => {
      const other = { ...healthy(), machineId: 'm3', name: 'Diego Mac', observation: { ...healthy().observation, runningHarnessIds: [] } }
      diego(other)
      return [healthy(), other]
    }
    const requiring = (requires: Record<string, unknown>) => {
      const groups = conversations()
      Object.assign(groups[1]!, { task: { goal: 'Check the device', changes: 'None', constraints: 'None', owns: ['devices'], requires } })
      return groups
    }
    async function route(machines: unknown[], requires: Record<string, unknown>, members = true) {
      const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: { state: { id: 'tab', agents: members ? agents : [agents[1]], conversations: requiring(requires), machines } },
        policy: { policy, warnings: [] }, machines: [] } } })
      return { answer: await routeTask(input, s, where, opener()), s }
    }
    const elsewhere = (s: ReturnType<typeof scoped>) => [...new Set((recorded(s).command.decision.candidates as Array<{ machineId: string; label: string }>)
      .filter(c => c.label.includes(ELSEWHERE)).map(c => c.machineId))]
    it('offers every machine, and notes on the others that the requirement names another', async () => {
      const { answer, s } = await route(two(), { machines: ['m3'] })
      expect(answer).toMatchObject({ ok: true })
      const machines = new Set((recorded(s).command.decision.candidates as Array<{ machineId: string }>).map(c => c.machineId))
      expect(machines).toEqual(new Set(['m1', 'm3']))
      expect(elsewhere(s)).toEqual(['m1'])
      expect(JSON.stringify(recorded(s).command.decision.excluded)).not.toContain(ELSEWHERE)
    })
    it('routes elsewhere, with the note, while the required machine has no free slot', async () => {
      const full = await route(two(p => { p.availableSlots = 0 }), { machines: ['m3'] })
      expect(full.answer).toMatchObject({ ok: true, pick: { machineId: 'm1', notes: expect.arrayContaining([ELSEWHERE]) } })
    })
    it('notes every machine when the required one is one the agent cannot see', async () => {
      const { answer, s } = await route(two(), { machines: [], unseenMachines: 1 })
      expect(answer).toMatchObject({ ok: true })
      expect(elsewhere(s).sort()).toEqual(['m1', 'm3'])
    })
    it('counts a Mac\'s Harness Team account as that Mac', async () => {
      const team = { ...healthy(), machineId: 't3', name: 'Diego Mac', hostMachineId: 'm3', contributorId: 'owner', observation: { ...healthy().observation, runningHarnessIds: [] } }
      const { s } = await route([healthy(), team], { machines: ['m3'] }, false)
      expect(elsewhere(s)).toEqual(['m1'])
    })
    it('keeps routing a task without a requirement as before', async () => {
      const { answer } = await route(two(), undefined as never)
      expect(answer).toMatchObject({ ok: true })
    })
  })
  describe('a task that requires a device', () => {
    const requiring = (starts: unknown[] = []) => {
      const groups = conversations()
      Object.assign(groups[1]!, { task: { goal: 'g', changes: 'c', constraints: 'k', owns: ['o'], requires: { devices: ['/dev/cu.usbmodem1'] } } })
      return { revision: 3, state: { id: 'tab', agents, conversations: groups, starts } }
    }
    it('waits when no machine has the device connected', async () => {
      const answer = await routeTask(input, scoped({ tab: requiring() }), where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [] })), () => 'op')
      expect(answer).toMatchObject({ error: 'NO_CANDIDATE', waiting: true,
        detail: 'This task waits for the machine it requires; route it again once that machine can take it.' })
    })
    it('notes a member whose own start did not have its machine check the device', async () => {
      const connected = opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], devices: { '/dev/cu.usbmodem1': true } }))
      const members = async (starts: unknown[]) => {
        const s = scoped({ tab: requiring(starts) })
        await routeTask(input, s, where as never, connected, () => 'op')
        return (recorded(s).command.decision.candidates as Array<{ title: string; label: string }>).find(c => c.title.startsWith('Multiply'))!.label
      }
      expect(await members([])).toContain('Its start did not have its machine check the device this task requires.')
      const checked = await members([{ harnessId: 'h1', request: { machineId: 'm1', requirements: { devices: ['/dev/cu.usbmodem1'] } } }])
      expect(checked).not.toContain('check the device')
    })
  })
  it('asks the machine for the devices the group\'s task requires, beside those the Lead names', async () => {
    const groups = conversations()
    Object.assign(groups[1]!, { task: { goal: 'g', changes: 'c', constraints: 'k', owns: ['o'], requires: { devices: ['/dev/cu.usbmodem1'] } } })
    const s = scoped({ tab: { revision: 3, state: { id: 'tab', agents, conversations: groups } } })
    const make = opener(id => daemon(id, { devices: { '/dev/cu.usbmodem1': id === 'm2', '/dev/ttyUSB0': true } }))
    const answer = await routeTask({ ...input, assessment: { ...input.assessment, needs: { devices: ['/dev/ttyUSB0'] } } }, s, where as never, make, () => 'op')
    expect(answer).toMatchObject({ ok: true, pick: { machineId: 'm2' } })
    const hint = JSON.parse(/start OPERATION_ID (\{.*\}), then/.exec(answer.next as string)![1]!)
    expect(hint.requirements.devices).toEqual(['/dev/ttyUSB0', '/dev/cu.usbmodem1'])
  })

  it.each([
    ['stale', (p: any) => { p.observation.receivedAt = 0 }],
    ['paused', (p: any) => { p.paused = true }],
    ['full', (p: any) => { p.availableSlots = 0 }],
    ['low disk', (p: any) => { p.observation.resources.projectDiskFreeBytes = 1 }],
    ['unknown memory', (p: any) => { delete p.observation.resources.memoryUsedBytes }],
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
  it('lists API-key machines beside a subscription one, and offers the best row of every other machine as an alternative', async () => {
    const keyed = (machineId: string) => ({ ...healthy(), machineId, name: `Keyed ${machineId}`, observation: { ...healthy().observation, runningHarnessIds: [],
      quotas: [{ engine: 'claude', known: true, windows: [] }] } })
    // The subscription machine has two engines, so its two best rows come before any other machine's.
    const subscription = healthy(), reading = { usedPercent: 20, resetsAt: Date.now() + 5 * 86_400_000 }
    Object.assign(subscription, { engines: ['claude', 'codex'] })
    subscription.observation.quotas = ['claude', 'codex'].map(engine => ({ engine, known: true, windows: [{ ...reading, name: '5-hour' }, { ...reading, name: 'weekly' }] }))
    const enabled = { ...floorPolicy, models: floorPolicy.models.map(m => ({ ...m, enabled: true })) }
    const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: { state: { id: 'tab', agents: [], conversations: conversations(), machines: [subscription, keyed('m2'), keyed('m3')] } },
      policy: { policy: enabled, warnings: [] }, machines: [] } } })
    const answer = await routeTask(input, s, where, opener())
    expect(answer).toMatchObject({ ok: true, pick: { machineId: 'm1', engine: 'codex' } })
    expect((answer.alternatives as Array<{ machineId: string; engine: string }>).map(x => [x.machineId, x.engine])).toEqual([['m1', 'claude'], ['m2', 'claude'], ['m3', 'claude']])
  })
  it('leaves out a machine that cannot take a teammate\'s project, with the backend\'s reason, and keeps its owner\'s own work there', async () => {
    const reason = 'Contributed laptop has no Harness Team account yet, so it runs only its owner\'s projects.'
    const refusing = (contributorId: string) => ({ ...healthy(), contributorId, teamWork: { allowed: false, code: 'TEAM_ACCOUNT_REQUIRED', reason } })
    const owners = { id: 'lead', ownerId: 'owner' }
    // The Swarm owner's project on a teammate's personal laptop: no new agent there, and not its member either.
    const teammate = await runPool(refusing('mate'), true, {}, owners)
    expect(teammate.answer).toMatchObject({ error: 'NO_CANDIDATE' })
    expect(teammate.answer.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringContaining('Multiply'), reason }),
      expect.objectContaining({ title: expect.not.stringContaining('Multiply'), reason })]))
    // The same laptop's own owner's project, as before.
    expect((await runPool(refusing('mate'), false, {}, { id: 'lead', ownerId: 'mate' })).answer.ok).toBe(true)
    // A Team machine that takes it, and a backend from before the rule that says nothing.
    expect((await runPool({ ...healthy(), contributorId: 'mate', teamWork: { allowed: true } }, false, {}, owners)).answer.ok).toBe(true)
    expect((await runPool({ ...healthy(), contributorId: 'mate' }, false, {}, owners)).answer.ok).toBe(true)
    // Offline is said once, by the reading's own age.
    const offline = { ...refusing('mate'), teamWork: { allowed: false, code: 'MACHINE_OFFLINE', reason: 'Contributed laptop is offline.' } }
    offline.observation.receivedAt = 0
    const silent = await runPool(offline, false, {}, owners)
    expect(silent.answer.excluded).not.toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('Contributed laptop is offline.') })]))
  })
  // One machine (docs/plans/2026-10-24-swarm-team-account.md): a Mac's Harness Team account is that Mac. The Lead is offered
  // the Mac once: a teammate's project starts in the team account, the Mac's owner's own projects stay with the owner.
  describe('a Mac and its Harness Team account', () => {
    const NO_ACCOUNT = 'MacBook Pro has no Harness Team account yet, so it runs only its owner\'s projects.'
    const mac = () => ({ ...healthy(), name: 'MacBook Pro', scope: 'swarm', cwd: '/mate/swarm', contributorId: 'mate',
      teamWork: { allowed: false, code: 'TEAM_ACCOUNT_REQUIRED', reason: NO_ACCOUNT } })
    const team = () => ({ ...healthy(), machineId: 'm1-team', hostMachineId: 'm1', name: 'MacBook Pro', scope: 'swarm', cwd: '/team/swarm', contributorId: 'mate',
      teamWork: { allowed: true } })
    async function route(ownerId: string, machines: Record<string, unknown>[] = [mac(), team()]) {
      const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: { state: { id: 'tab', agents: [], conversations: conversations(), machines,
        projects: [{ id: 'lead', ownerId, repository: { repositoryUrl: 'https://github.com/example/project' } }] } },
        policy: { policy, warnings: [] }, machines: [] } } })
      const answer = await routeTask(input, s, where, opener())
      const decision = s.mock.calls.find(c => c[0].action === 'command')?.[0].command.decision
      return { answer, candidates: (decision?.candidates ?? []) as Array<{ machineId: string; kind: string; title: string }>,
        excluded: (decision?.excluded ?? answer.excluded ?? []) as Array<{ reason: string }> }
    }

    it('starts a teammate\'s project in the team account, under the Mac\'s name, without calling the Mac unfit', async () => {
      const { answer, candidates, excluded } = await route('owner')
      expect(answer).toMatchObject({ ok: true, pick: { machineId: 'm1-team' } })
      expect(answer.next).toContain('/team/swarm/lead')
      expect(candidates.filter(c => c.kind === 'new').map(c => c.machineId)).toEqual(expect.arrayContaining(['m1-team']))
      expect(candidates.some(c => c.kind === 'new' && c.machineId === 'm1')).toBe(false)
      expect(excluded.some(e => e.reason === NO_ACCOUNT)).toBe(false)
    })

    it('keeps the Mac\'s owner\'s own project with the owner, never the team account', async () => {
      const { answer, candidates } = await route('mate')
      expect(answer).toMatchObject({ ok: true, pick: { machineId: 'm1' } })
      expect(candidates.some(c => c.machineId === 'm1-team')).toBe(false)
    })

    it('says the team account\'s own reason when it cannot take the work, and still offers nothing as the owner', async () => {
      const reason = 'The Harness Team account on MacBook Pro is not private (gitconfig: it could read its owner\'s ~/.gitconfig), so it runs only its owner\'s projects.'
      const { answer, excluded } = await route('owner', [mac(), { ...team(), teamWork: { allowed: false, code: 'PRIVACY_CHECK_FAILED', reason } }])
      expect(answer).toMatchObject({ error: 'NO_CANDIDATE' })
      expect(excluded.map(e => e.reason)).toContain(reason)
      expect(excluded.some(e => e.reason === NO_ACCOUNT)).toBe(false)
    })

    it('offers a team account whose Mac is not in the Swarm as itself, folded into nothing', async () => {
      // Probed for new agents under its own name, not left out as folded.
      const { candidates } = await route('owner', [{ ...team(), hostMachineId: 'm-elsewhere' }])
      expect(candidates.map(c => c.title)).toContain('New agent · Claude opus high · MacBook Pro')
    })

    // 2026-10-30 overnight: Codex in Tony's team account was never offered for reviews. The account spends Tony's own
    // subscription through the relay, so it reads its quota as unknown, and the route dropped every unknown candidate while
    // another machine's quota fit. The Mac's own reading is that subscription's.
    describe('a team account that spends its Mac\'s subscription through the relay', () => {
      const relayed = (why = RELAYED_QUOTA) => ({ ...team(), observation: { ...team().observation, quotas: [{ engine: 'claude', known: false, windows: [] }],
        quotaReasons: { claude: why } } })
      // Full readings, both windows, as every Claude account reports them.
      const full = <T extends ReturnType<typeof healthy>>(pool: T): T => ({ ...pool, observation: { ...pool.observation, quotas: [{ engine: 'claude', known: true,
        windows: [{ name: '5-hour', usedPercent: 20, resetsAt: Date.now() + 3_600_000 }, { name: 'weekly', usedPercent: 30, resetsAt: Date.now() + 4 * 86_400_000 }] }] } })
      const fullMac = () => full(mac())
      // Another machine whose quota fits, as MacBookPro2021's Codex read that night.
      const other = () => full({ ...healthy(), machineId: 'm9', name: 'Other Mac', scope: 'swarm', cwd: '/other/swarm', contributorId: 'owner' })
      const fit = (s: ReturnType<typeof scoped>, machineId: string) =>
        (recorded(s).command.decision.candidates as Array<{ machineId: string; kind: string; label: string; fit: { status: string; account: string } }>)
          .find(c => c.machineId === machineId && c.kind === 'new')
      async function routeWith(machines: Record<string, unknown>[]) {
        const s = scoped({ context: { ok: true, value: { agentId: 'lead', tab: { state: { id: 'tab', agents: [], conversations: conversations(), machines,
          projects: [{ id: 'lead', ownerId: 'owner', repository: { repositoryUrl: 'https://github.com/example/project' } }] } },
          policy: { policy, warnings: [] }, machines: [] } } })
        return { answer: await routeTask(input, s, where, opener()), s }
      }

      it('reads the Mac\'s quota for it, on the Mac\'s account, and says so in its line', async () => {
        const { s } = await routeWith([fullMac(), relayed(), other()])
        const row = fit(s, 'm1-team')
        expect(row).toMatchObject({ fit: { status: 'fits', account: 'm1:claude' } })
        expect(row!.label).toContain('quota read on MacBook Pro, whose subscription this account spends')
        expect(row!.label).toContain('5-hour 80% left')
        expect(recorded(s).command.decision.excluded).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('MacBook Pro') })]))
      })

      it('keeps the quota unknown when the account says it cannot read it for another reason, and still offers it', async () => {
        const { s } = await routeWith([fullMac(), relayed('The allowance reader on this machine did not answer.'), other()])
        expect(fit(s, 'm1-team')).toMatchObject({ fit: { status: 'unknown' } })
        expect(fit(s, 'm1-team')!.label).toContain('quota unknown (The allowance reader on this machine did not answer.)')
        expect(recorded(s).command.decision.excluded).toEqual([])
      })

      // The decision kept its exclusions, but the Lead's answer showed none, so nobody saw why the Mac was never offered.
      it('tells the Lead each machine it left out and why, whether it picked another or found none', async () => {
        const reason = 'The Harness Team account on MacBook Pro is not private (gitconfig: it could read its owner\'s ~/.gitconfig), so it runs only its owner\'s projects.'
        const refused = { ...relayed(), teamWork: { allowed: false, code: 'PRIVACY_CHECK_FAILED', reason } }
        const picked = await routeWith([fullMac(), refused, other()])
        expect(picked.answer).toMatchObject({ ok: true, pick: { machineId: 'm9' } })
        expect(picked.answer.leftOut).toEqual([{ machine: 'MacBook Pro', reasons: [reason] }])
        const none = await routeWith([fullMac(), refused])
        expect(none.answer).toMatchObject({ error: 'NO_CANDIDATE' })
        expect(none.answer.leftOut).toEqual(expect.arrayContaining([{ machine: 'MacBook Pro', reasons: [reason] }]))
        // A machine with a row offered is not left out, though its other rows were.
        expect((await routeWith([fullMac(), relayed(), other()])).answer.leftOut).toEqual([])
      })

      it('borrows nothing from a Mac whose reading is stale or that another person contributed', async () => {
        const stale = fullMac(); stale.observation = { ...stale.observation, receivedAt: 0 }
        for (const host of [stale, { ...fullMac(), contributorId: 'someone-else' }]) {
          const { s } = await routeWith([host, relayed(), other()])
          expect(fit(s, 'm1-team')).toMatchObject({ fit: { status: 'unknown' } })
          expect(fit(s, 'm1-team')!.label).not.toContain('quota read on')
        }
      })
    })
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

describe('local models on the Swarm\'s grid', () => {
  const GRID = 'swarm-0123456789ab', NOW = 1_000_000_000
  const served = (models: Array<Record<string, unknown>>, receivedAt: unknown = NOW - 1_000) => ({ machineId: 'm1', observation: { receivedAt, localModels: models } })
  const state = (patch: Record<string, unknown> = {}) => ({ localModels: { grid: GRID, enabled: true }, machines: [served([{ grid: GRID, model: 'qwen3', name: 'Qwen 3' }])], agents: [], starts: [], ...patch })
  const base = (patch: Partial<Probe> = {}): Probe => ({ kind: 'new', machineId: 'm1', machineName: 'remote-1', engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2,
    quota: { known: true, leftPercent: 50, resetsAt: null }, activity: 'new agent', known: true, refusals: [], notes: [], ...patch })
  const catalog: Catalog = { models: [], grid: { strength: 1, models: [] } }
  const offered = (s: Record<string, unknown>, opts: { probes?: Probe[]; catalog?: Catalog } = {}) =>
    localProbes(s, opts.catalog ?? catalog, opts.probes ?? [base()], NOW)

  it('offers one new agent per machine and engine on each served model, free and at the grid\'s strength', () => {
    const probes = [base({ notes: ['Its subscription is used up.', 'Stalled.'] }), base({ model: 'opus', effort: 'high' }),
      base({ engine: 'codex', refusals: ['Its subscription is used up.', 'Too little memory.'] }), base({ kind: 'member', agentId: 'a1' }), base({ gridModel: 'other' })]
    const rows = offered(state(), { probes, catalog: { ...catalog, grid: { strength: 2, models: [] } } })
    expect(rows.map(r => [r.engine, r.model, r.effort, r.quality, r.cost, r.gridModel, r.gridName, r.gridLabel, r.refusals, r.notes])).toEqual([
      ['claude', 'default', 'default', 2, 1, 'qwen3', GRID, 'Qwen 3', [], ['Stalled.']],
      ['codex', 'default', 'default', 2, 1, 'qwen3', GRID, 'Qwen 3', ['Too little memory.'], []],
    ])
    expect(rows[0]!.quota).toMatchObject({ known: false })
    // A backend before the add-on serves no grid strength: 1. A model with no name is called by its model.
    const unnamed = state({ machines: [served([{ grid: GRID, model: 'qwen3' }])] })
    expect(offered(unnamed)[0]).toMatchObject({ quality: 1, gridLabel: 'qwen3' })
  })
  it('rates each served model by the catalog\'s grid rows: Kimi K3 and DeepSeek v4.1 at 2, a small Qwen at the grid\'s strength', () => {
    const models = [{ model: 'kimi k3', strength: 2 }, { model: 'deepseek v4.1', strength: 2 }]
    const three = state({ machines: [served([{ grid: GRID, model: 'moonshotai/kimi-k3', kind: 'api' }, { grid: GRID, model: 'deepseek/deepseek-v4.1-flash-1017', kind: 'api' },
      { grid: GRID, model: 'qwen3:4b', name: 'Qwen 3 4B' }])] })
    const rows = offered(three, { catalog: { ...catalog, grid: { strength: 1, models } } })
    expect(rows.map(r => [r.gridModel, r.quality])).toEqual([['moonshotai/kimi-k3', 2], ['deepseek/deepseek-v4.1-flash-1017', 2], ['qwen3:4b', 1]])
  })
  it('offers nothing with the add-on off', () => {
    expect(offered(state({ localModels: undefined }))).toEqual([])
    expect(offered(state({ localModels: { grid: GRID, enabled: false } }))).toEqual([])
    expect(offered(state({ localModels: { enabled: true } }))).toEqual([])
  })
  it('reads only fresh readings, and of a model on another grid only on the machine that reaches it', () => {
    expect(offered(state({ machines: [served([{ grid: GRID, model: 'qwen3' }], NOW - 60_000)] }))).toEqual([])
    expect(offered(state({ machines: [served([{ grid: GRID, model: 'qwen3' }], 'soon')] }))).toEqual([])
    expect(offered(state({ machines: [served([{ grid: GRID, model: 7 }, { grid: 3, model: 'x' }])] }))).toEqual([])
    // Shared with m1's owner on their team grid: offered on m1 alone, while one on the Swarm's grid is offered on both.
    const reach = state({ machines: [served([{ grid: 'team-grid', model: 'team-model', kind: 'shared' }]), { machineId: 'm2', observation: { receivedAt: NOW - 1_000, localModels: [{ grid: GRID, model: 'qwen3' }] } }] })
    const rows = offered(reach, { probes: [base(), base({ machineId: 'm2', machineName: 'mac' })] })
    expect(rows.map(r => [r.machineId, r.gridName, r.gridModel, r.gridKind])).toEqual([
      ['m1', 'team-grid', 'team-model', 'shared'], ['m1', GRID, 'qwen3', 'local'], ['m2', GRID, 'qwen3', 'local'],
    ])
    // An API a member shares, by its kind; another grid's model without one is shared with that machine's owner.
    const kinds = state({ machines: [served([{ grid: GRID, model: 'ds', kind: 'api' }, { grid: 'team-grid', model: 'tm' }])] })
    expect(offered(kinds).map(r => [r.gridModel, r.gridKind])).toEqual([['ds', 'api'], ['tm', 'shared']])
    // An agent started on the shared model takes it, by its own grid.
    expect(offered({ ...reach, starts: [{ request: { gridModel: 'team-model', gridName: 'team-grid' } }] }, { probes: [base()] }).map(r => r.gridModel)).toEqual(['qwen3'])
  })
  it('keeps a model for the agent started on it until that agent leaves the Swarm', () => {
    const start = (patch: Record<string, unknown>) => ({ request: { gridModel: 'qwen3' }, ...patch })
    expect(offered(state({ starts: [start({})] }))).toEqual([])
    expect(offered(state({ starts: [start({ harnessId: 'h9' })], agents: [{ harnessId: 'h9' }] }))).toEqual([])
    expect(offered(state({ starts: [start({ harnessId: 'h9' })] }))).toHaveLength(1)
    expect(offered(state({ starts: [start({ error: 'NO_CAPACITY' })] }))).toHaveLength(1)
    expect(offered(state({ starts: [{ request: { model: 'opus' } }, {}] }))).toHaveLength(1)
  })
  it('never offers a model that is still starting: the grid does not list it yet', () => {
    expect(offered(state({ machines: [served([{ grid: GRID, model: 'qwen3', name: 'Qwen 3', starting: true }])] }))).toEqual([])
    expect(offered(state({ machines: [served([{ grid: GRID, model: 'qwen3', name: 'Qwen 3', starting: false }])] }))).toHaveLength(1)
  })
  it('lets up to four agents share an API model, which answers several requests at once', () => {
    const api = state({ machines: [served([{ grid: GRID, model: 'ds', name: 'DeepSeek', kind: 'api' }])] })
    const starts = (n: number) => Array.from({ length: n }, (_, i) => ({ request: { gridModel: 'ds' }, harnessId: `h${i}` }))
    const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ harnessId: `h${i}`, name: `B${i}` }))
    expect(offered({ ...api, starts: starts(3), agents: agents(3) })).toHaveLength(1)
    expect(offered({ ...api, starts: starts(4), agents: agents(4) })).toEqual([])
  })
  it('names the agents on each model that takes no more, so the route can say why it is not offered', () => {
    const api = served([{ grid: GRID, model: 'ds', name: 'DeepSeek', kind: 'api' }, { grid: GRID, model: 'qwen3', name: 'Qwen 3' }])
    const s = state({ machines: [api],
      starts: [{ request: { gridModel: 'qwen3' }, harnessId: 'h1' }, { request: { gridModel: 'qwen3' } },
        ...['h2', 'h3', 'h4', 'h5'].map(harnessId => ({ request: { gridModel: 'ds' }, harnessId }))],
      agents: [{ harnessId: 'h1', displayName: 'Faye', name: 'Builder' }, { harnessId: 'h2', name: 'Wren' }, { harnessId: 'h3' }, { harnessId: 'h4', name: 'Ada' }, { harnessId: 'h5', name: 'Bo' }] })
    expect(heldLocalModels(s, NOW)).toEqual([
      { model: 'ds', label: 'DeepSeek', kind: 'api', holders: ['Wren', 'an agent', 'Ada', 'Bo'] },
      { model: 'qwen3', label: 'Qwen 3', kind: 'local', holders: ['Faye', 'an agent that is starting'] },
    ])
    // Nothing is held while the add-on is off, or with a model nobody is on.
    expect(heldLocalModels(state({ localModels: { grid: GRID, enabled: false } }), NOW)).toEqual([])
    expect(heldLocalModels(state(), NOW)).toEqual([])
    expect(heldLocalModels(state({ localModels: undefined }))).toEqual([])
  })
  // Project instructions, phase 4, decision 19: a model too small or too slow for a coding agent is offered, with why.
  it('serves the models a fresh reading says are too small or too slow, with why as a note, once each', () => {
    const why = 'llama3.2:3b is too small for a coding agent.'
    const refusing = (receivedAt: unknown, refusedModels: unknown) => ({ machineId: 'm2', observation: { receivedAt, refusedModels } })
    const s = state({ machines: [served([{ grid: GRID, model: 'fast', name: 'Fast' }]), refusing(NOW - 1_000, [
      { grid: GRID, model: 'llama3.2:3b', why }, { grid: GRID, model: 'llama3.2:3b', why }, { grid: GRID, model: 'tiny', name: 'Tiny 1B', why: 'small' },
      { grid: 'other-grid', model: 'x', why }, { grid: GRID, model: 7, why }, { grid: GRID, model: 'no-why' },
      // Another machine serves it fit: no note.
      { grid: GRID, model: 'fast', why: 'slow here' }]),
      refusing(NOW - 60_000, [{ grid: GRID, model: 'stale', why }]), refusing('soon', [{ grid: GRID, model: 'odd', why }])] })
    expect([...servedModels(s, GRID, NOW).values()].map(m => [m.model, m.label, m.note])).toEqual([
      ['fast', 'Fast', undefined], ['llama3.2:3b', 'llama3.2:3b', why], ['tiny', 'Tiny 1B', 'small']])
    expect(offered(s).map(r => [r.gridModel, r.notes])).toEqual([['fast', []], ['llama3.2:3b', [why]], ['tiny', ['small']]])
    // None of them is held: nobody is on them.
    expect(heldLocalModels(s, NOW)).toEqual([])
  })
  it('leaves out a model whose host is offline, with that reason, unless another host serves it', async () => {
    const t = tab(); Object.assign(t.state, { localModels: { grid: GRID, enabled: true }, machines: [
      { machineId: 'm1', name: 'remote-1', observation: { receivedAt: Date.now(), localModels: [{ grid: GRID, model: 'deepseek/deepseek-v4.1', kind: 'api' }] } },
      { machineId: 'rig', name: '2x 4090 Rig', observation: { receivedAt: Date.now() - 10 * 60_000, localModels: [{ grid: GRID, model: 'moonshotai/kimi-k3', name: 'Kimi K3' },
        { grid: GRID, model: 'deepseek/deepseek-v4.1', kind: 'api' }, { grid: GRID, model: 'starting', starting: true }, { grid: 7, model: 'odd' }] } },
      { machineId: 'old', observation: { receivedAt: 'never', localModels: [{ grid: GRID, model: 'unnamed-host' }] } }] })
    const s = scoped({ tab: t })
    const result = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'low', local: true } }, s, where as never, opener(), () => 'op')
    const excluded = recorded(s).command.decision.excluded as Array<{ title: string; reason: string }>
    expect(excluded.filter(e => /offline/.test(e.reason))).toEqual([
      { title: 'Kimi K3', reason: 'Its host 2x 4090 Rig is offline, so an agent on it would never start.' },
      { title: 'unnamed-host', reason: 'Its host, a machine of this Swarm, is offline, so an agent on it would never start.' },
    ])
    expect(result).toMatchObject({ ok: true, pick: { gridModel: 'deepseek/deepseek-v4.1' } })
    // A linked task is routed like any other (project instructions, phase 4): the same is said for it. Nothing with the add-on off.
    Object.assign(t.state.conversations[1]!, { reviewOf: 'lead' })
    const review = scoped({ tab: t })
    await routeTask(input, review, where as never, opener(), () => 'op')
    expect(JSON.stringify(recorded(review).command.decision.excluded)).toContain('offline, so an agent')
    expect(offlineModels(t.state)).toHaveLength(2)
    expect(offlineModels({ ...t.state, localModels: { grid: GRID, enabled: false } })).toEqual([])
    expect(offlineModels({ ...t.state, localModels: undefined })).toEqual([])
  })
  it('routes a low task to a served model and starts it on the grid, with no subscription model', async () => {
    const t = tab(); Object.assign(t.state, { localModels: { grid: GRID, enabled: true },
      machines: [{ machineId: 'm1', observation: { receivedAt: Date.now(), localModels: [{ grid: GRID, model: 'qwen3', name: 'Qwen 3' }] } }] })
    const s = scoped({ tab: t })
    const result = await routeTask({ ...input, assessment: { ...input.assessment, difficulty: 'low', local: true } }, s, where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, pick: { kind: 'new', gridModel: 'qwen3', gridName: GRID } })
    const hint = JSON.parse(/start OPERATION_ID (\{.*\}), then/.exec(result.next as string)![1]!)
    expect(hint).toMatchObject({ engine: 'claude', gridModel: 'qwen3', gridName: GRID })
    expect(hint).not.toHaveProperty('model')
    expect(recorded(s).command.decision.candidates[0]).toMatchObject({ gridModel: 'qwen3', gridName: GRID })
  })
})

// Project instructions, phase 4: any agent of the project routes, every member is a candidate whatever its kind, and what a
// rule, a lost task, a stall or an avoided account used to filter is a note on the candidate.
describe('routing by facts', () => {
  const accountOn = (account: string) => ({ providers: [{ ...usage.providers[0]!, account }] })
  const shown = (s: ReturnType<typeof scoped>) => recorded(s).command.decision.candidates as Array<{ title: string; label: string; quality: number; machineId: string; gridModel?: string }>

  it('lets any agent of the group\'s project route', async () => {
    const open = opener()
    const s = scoped({ context: { ok: true, value: { agentId: 'a1', tab: tab(), policy: { policy }, machines: [{ machineId: 'm1', name: 'remote-1' }] } } })
    expect(await routeTask(input, s, where as never, open, () => 'op')).toMatchObject({ ok: true, routeDecisionId: 'd1' })
    expect(open).toHaveBeenCalled()
  })

  it('shows lost, stalled and avoided accounts as notes', async () => {
    const t = tab()
    t.state.agents = [
      { ...agents[0]!, lostTask: { conversationId: 'g0', assignmentId: 'x', reason: 'stalled', at: 1 } },
      agents[1]!,
      { id: 'r1', name: 'Reviewer', role: 'reviewer', machineId: 'm1', harnessId: 'hr', configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' } },
    ] as never
    // The group's last attempt failed on m1's Claude account; m2's last two starts started nothing.
    Object.assign(t.state.conversations[1]!, { lostAttempt: { id: 'x', agentId: 'gone', machineId: 'm1', engine: 'claude' } })
    const failed = { id: 's', request: { machineId: 'm2' }, harnessId: null, dispatched: true, error: 'The engine did not start.' }
    Object.assign(t.state, { starts: [failed, { ...failed, id: 's2' }] })
    const s = scoped({ tab: t })
    const result = await routeTask(input, s, where as never, opener(id => daemon(id, { agents: id === 'm1' ? ['h1', 'hl', 'hr'] : [],
      usage: accountOn(id === 'm1' ? 'acct-1' : 'acct-2') })), () => 'op')
    expect(result).toMatchObject({ ok: true })
    const rows = shown(s), line = (prefix: string) => rows.find(r => r.title.startsWith(prefix))!.label
    // The idle coordinator and a reviewer-kind member are candidates for a build.
    expect(rows.map(r => r.title)).toEqual(expect.arrayContaining(['Multiply · Claude sonnet medium · remote-1', 'Lead · Claude opus high · remote-1',
      'Reviewer · Claude sonnet medium · remote-1']))
    expect(line('Multiply')).toContain('It lost its last task (stalled).')
    for (const row of rows.filter(r => r.machineId === 'm1')) expect(row.label).toContain('Its account lost this task before')
    for (const row of rows.filter(r => r.machineId === 'm2')) expect(row.label).toContain('last 2 starts')
    expect(recorded(s).command.decision.excluded).toEqual([])
    // The answer says the same of what it offers.
    const offered = [result.pick, ...(result.alternatives as unknown[])] as Array<{ machineId: string; notes?: string[] }>
    expect(offered.filter(o => o.machineId === 'm1').every(o => o.notes?.some(n => n.includes('Its account lost this task before')))).toBe(true)
  })

  it('reads the catalog, or an older backend\'s policy', async () => {
    const catalog = { models: [{ engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
      { engine: 'claude', model: 'sonnet', effort: 'medium', strength: 2, cost: 2, offered: false, note: 'Not offered by default.' }],
      grid: { strength: 1, models: [] }, priors: {}, prices: [] }
    const served = scoped({ context: { ok: true, value: { agentId: 'lead', tab: tab(), policy: { policy, warnings: [], catalog }, machines: [{ machineId: 'm1', name: 'remote-1' }] } } })
    await routeTask(input, served, where as never, opener(), () => 'op')
    const rows = shown(served)
    expect(rows.find(r => r.title.startsWith('Multiply'))).toMatchObject({ quality: 2, label: expect.stringContaining('Not offered by default.') })
    expect(rows.filter(r => r.title.startsWith('New agent')).map(r => r.title)).toEqual(['New agent · Claude opus high · remote-1'])
    // An older backend serves only its policy: its rows, rated as it rates them.
    const old = scoped()
    await routeTask(input, old, where as never, opener(), () => 'op')
    expect(shown(old).find(r => r.title.startsWith('Multiply'))).toMatchObject({ quality: 3 })
    expect(shown(old).map(r => r.title)).toContain('New agent · Claude sonnet medium · remote-1')
  })

  // Final review: a named grid model whose host is down became an unrated Codex candidate; nothing serves it, and the route says
  // why. An unreadable catalog became an empty one without a word: no new agent was offered and nobody heard why.
  it('names no stand-in for a named model whose host is offline, and says why', async () => {
    const GRID = 'swarm-0123456789ab'
    const t = tab(); Object.assign(t.state, { localModels: { grid: GRID, enabled: true }, machines: [{ machineId: 'rig', name: '2x 4090 Rig',
      observation: { receivedAt: Date.now() - 10 * 60_000, localModels: [{ grid: GRID, model: 'moonshotai/kimi-k3', name: 'Kimi K3' }] } }] })
    const opened = opener(id => daemon(id, { agents: id === 'm1' ? ['h1'] : [], engines: [{ engine: 'claude', installed: true, signedIn: true }, { engine: 'codex', installed: true, signedIn: true }] }))
    const result = await routeTask({ ...input, assessment: { ...input.assessment, model: 'kimi k3' } }, scoped({ tab: t }), where as never, opened, () => 'op')
    expect(result).toMatchObject({ error: 'NO_CANDIDATE' })
    expect(result.excluded).toEqual(expect.arrayContaining([{ title: 'Named model', reason: expect.stringContaining('No candidate runs "kimi k3"') },
      { title: 'Kimi K3', reason: 'Its host 2x 4090 Rig is offline, so an agent on it would never start.' }]))
  })
  it('says when the catalog could not be read, so no new agent is offered', async () => {
    const empty = scoped({ context: { ok: true, value: { agentId: 'lead', tab: tab(), policy: {}, machines: [{ machineId: 'm1', name: 'remote-1' }] } } })
    const result = await routeTask(input, empty, where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, pick: { kind: 'member' } })
    expect(result.warnings).toContain('The model catalog could not be read, or lists no models: no new agent on Claude Code or Codex is offered, only agents already in the Swarm and models served on its grid.')
    expect(recorded(empty).command.decision.excluded).toContainEqual({ title: 'New agents', reason: expect.stringContaining('The model catalog could not be read') })
  })

  it('offers a small or slow grid model with a note', async () => {
    const GRID = 'swarm-0123456789ab', why = 'llama3.2:3b is too small for a coding agent (about 3B parameters; a coding agent needs 7B or more).'
    const t = tab(); Object.assign(t.state, { localModels: { grid: GRID, enabled: true },
      machines: [{ machineId: 'rig', name: 'Rig', observation: { receivedAt: Date.now(), localModels: [], refusedModels: [{ grid: GRID, model: 'llama3.2:3b', why }] } }] })
    const s = scoped({ tab: t })
    const result = await routeTask({ ...input, assessment: { ...input.assessment, local: true } }, s, where as never, opener(), () => 'op')
    expect(result).toMatchObject({ ok: true, pick: { gridModel: 'llama3.2:3b', notes: [why] } })
    expect(shown(s).every(r => r.gridModel === 'llama3.2:3b' && r.label.includes(why))).toBe(true)
  })

  it('gives a neutral next step: the role comes from the project\'s instructions', async () => {
    const hard = { ...input, assessment: { ...input.assessment, difficulty: 'high' } }
    // Only the Sonnet member, so a stronger new agent is the pick.
    const crew = (reviewOf?: string) => {
      const t = tab(); t.state.agents = [agents[0]] as never
      if (reviewOf) Object.assign(t.state.conversations[1]!, { reviewOf })
      return t
    }
    const build = await routeTask(hard, scoped({ tab: crew(), policy: floorPolicy }), where as never, opener(), () => 'op')
    const reviewing = await routeTask(hard, scoped({ tab: crew('lead'), policy: floorPolicy }), where as never, opener(), () => 'op')
    for (const answer of [build, reviewing]) {
      expect(answer).toMatchObject({ ok: true, pick: { kind: 'new' } })
      expect(answer.next).toContain('"roleName":"ROLE"')
      expect(answer.next).not.toMatch(/Builder|Reviewer|"role":"reviewer"/)
    }
    // A backend without instructions takes no roleName.
    const old = await routeTask(hard, scoped({ tab: crew(), policy: floorPolicy, instructions: { error: 'NOT_FOUND' } }), where as never, opener(), () => 'op')
    expect(old.next).not.toContain('roleName')
  })
})
