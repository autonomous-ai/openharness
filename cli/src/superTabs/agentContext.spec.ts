import { describe, expect, it } from 'vitest'
import { isCoordinator, mineText, openWorkOf, taskText, unknownAgents } from './agentContext.js'

const NOW = Date.parse('2026-11-02T10:00:00.000Z')
const MIN = 60_000

type Group = Record<string, unknown>
function swarm(groups: Group[], extra: Record<string, unknown> = {}) {
  return {
    projects: [{ id: 'app', name: 'App', leadConversationId: 'lead-app' }, { id: 'web', name: 'Web', leadConversationId: 'lead-web' }],
    people: [{ id: 'ken', email: 'ken@example.com' }],
    agents: [{ id: 'pm', name: 'PM' }, { id: 'dev1', name: 'Dev1' }, { id: 'rev1', name: 'Rev1' }, { id: 'pm-web', name: 'Web PM' }],
    conversations: [
      { id: 'lead-app', projectId: 'app', title: 'App', leadId: 'pm', agentIds: ['pm'], archived: false, checks: [], assignment: null },
      { id: 'lead-web', projectId: 'web', title: 'Web', leadId: 'pm-web', agentIds: ['pm-web'], archived: false, checks: [], assignment: null },
      ...groups,
    ],
    ...extra,
  }
}
const task = (id: string, number: number, title: string, agentId: string | null, status: string | null, more: Group = {}): Group => ({
  id, projectId: 'app', number, title, leadId: 'pm', agentIds: ['pm'], archived: false, checks: [],
  assignment: agentId ? { id: `as-${id}`, agentId, status, result: null } : null, ...more,
})
const changed = (entries: Record<string, number>) => new Map(Object.entries(entries))

describe('mine', () => {
  it('lists an agent\'s open task with status, update time, result and PR', () => {
    const state = swarm([task('g12', 12, 'Fix login', 'dev1', 'working', {
      assignment: { id: 'a', agentId: 'dev1', status: 'working', result: 'Tests pass on main\nmore detail' },
      pullRequestUrls: ['https://github.com/o/r/pull/7'] })])
    expect(mineText(state, changed({ g12: NOW - 5 * MIN }), 'dev1', NOW)).toBe(
      '#12 Fix login (conversation g12) — working, updated 5 min ago; last result: Tests pass on main; PR https://github.com/o/r/pull/7')
  })

  it('leaves out a reused agent\'s finished task', () => {
    const state = swarm([task('g11', 11, 'Old work', 'dev1', 'done'), task('g12', 12, 'Fix login', 'dev1', 'working')])
    expect(openWorkOf(state, 'dev1').map(t => t.number)).toEqual([12])
    expect(mineText(state, changed({}), 'dev1', NOW)).not.toContain('#11')
  })

  it('leaves out archived tasks', () => {
    const state = swarm([task('g12', 12, 'Fix login', 'dev1', 'working', { archived: true })])
    expect(mineText(state, changed({}), 'dev1', NOW)).toBe('No task is assigned to you.')
  })

  it('lists the steps of its work with their assignee', () => {
    const state = swarm([task('g12', 12, 'Fix login', 'dev1', 'working'),
      task('g13', 13, 'Review: Fix login', 'rev1', 'working', { reviewOf: 'g12' })])
    expect(mineText(state, changed({}), 'dev1', NOW)).toContain('\n  steps: Review: Fix login (Rev1): working')
    // The Reviewer sees its step by the task it belongs to.
    expect(mineText(state, changed({}), 'rev1', NOW)).toBe('#12 Fix login · Review: Fix login (conversation g13) — working')
  })

  it('the coordinator\'s mine lists its project\'s open tasks and counts them', () => {
    const state = swarm([task('g12', 12, 'Fix login', 'dev1', 'working'), task('g14', 14, 'Docs', null, null),
      task('g15', 15, 'Shipped', 'dev1', 'done'), task('g16', 16, 'Review', 'rev1', 'review', { reviewOf: 'g12' }),
      { ...task('g20', 20, 'Web work', 'pm-web', 'working'), projectId: 'web' }])
    expect(isCoordinator(state, 'pm')).toBe(true)
    const text = mineText(state, changed({}), 'pm', NOW)
    expect(text).toContain('#12 Fix login (conversation g12) — Dev1, working')
    expect(text).toContain('#14 Docs (conversation g14) — unassigned')
    expect(text).not.toContain('#15')
    expect(text).not.toContain('Web work')
    // g12 and g14; g16 is a step of g12, shown under it.
    expect(text).toContain('  steps: Review (Rev1): review')
    expect(text.endsWith('2 open tasks.')).toBe(true)
  })

  it('with nothing says so', () => {
    expect(mineText(swarm([]), changed({}), 'dev1', NOW)).toBe('No task is assigned to you.')
  })

  it('cuts a result to its first line and 160 characters', () => {
    const long = 'x'.repeat(200)
    const state = swarm([task('g12', 12, 'Fix login', 'dev1', 'working', { assignment: { id: 'a', agentId: 'dev1', status: 'working', result: long } })])
    expect(mineText(state, changed({}), 'dev1', NOW)).toContain(`last result: ${'x'.repeat(160)}…`)
  })
})

describe('task', () => {
  const group = task('g12', 12, 'Fix login', 'dev1', 'working', {
    brief: 'Goal:\nSign in works offline.', pullRequestUrls: ['https://github.com/o/r/pull/7'],
    assignment: { id: 'a3', agentId: 'dev1', status: 'working', result: 'Fixed the token refresh' },
    checks: [
      { id: 'c1', description: 'Signs in offline', independent: true, evidence: 'Ran the app offline', passedBy: 'agent:rev1' },
      { id: 'c2', description: 'Refresh keeps the session', independent: true, evidence: 'Session dropped after refresh\nlog…', passedBy: null },
      { id: 'c3', description: 'Docs updated', independent: false, evidence: null, passedBy: null },
    ],
  })
  const attempts = [
    { id: 'a2', agentId: 'gone', status: 'lost', result: 'Stalled', createdAt: '2026-11-01T09:00:00.000Z' },
    { id: 'a1', agentId: 'dev1', status: 'stopped', result: null, createdAt: '2026-10-31T09:00:00.000Z' },
  ]

  it('shows goal, checks, attempts and linked tasks', () => {
    const state = swarm([group, task('g13', 13, 'Review: Fix login', 'rev1', 'working', { reviewOf: 'g12' })])
    const text = taskText(group, state, attempts, changed({ g12: NOW - 2 * MIN }), NOW)
    expect(text.split('\n')[0]).toBe('#12 Fix login (conversation g12)')
    expect(text).toContain('Project: App · Status: working · Assignee: Dev1 · Updated 2 min ago')
    expect(text).toContain('PR: https://github.com/o/r/pull/7')
    expect(text).toContain('Goal:\nSign in works offline.')
    expect(text).toContain('✓ Signs in offline — by Rev1')
    expect(text).toContain('✗ Refresh keeps the session — Session dropped after refresh')
    expect(text).toContain('· Docs updated')
    const lines = text.split('\n')
    const at = lines.indexOf('Attempts (newest first):')
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '- Dev1, working (current): Fixed the token refresh',
      '- gone, lost, 2026-11-01 09:00 UTC: Stalled',
      '- Dev1, stopped, 2026-10-31 09:00 UTC',
    ])
    expect(text).toContain('Steps:\n- Review: Fix login (Rev1): working (conversation g13)')
    expect(text).toContain('messages g12')
    expect(text).toContain('messages g12 --thread ROOT')
  })

  it('shows at most 10 attempts', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, agentId: 'dev1', status: 'stopped', result: null, createdAt: '2026-10-31T09:00:00.000Z' }))
    const text = taskText(group, swarm([group]), many, changed({}), NOW)
    expect(text.split('\n').filter(l => l.startsWith('- Dev1, '))).toHaveLength(10)
  })

  it('cuts a long brief with a pointer', () => {
    const long = { ...group, brief: 'b'.repeat(2000) }
    const text = taskText(long, swarm([long]), [], changed({}), NOW)
    expect(text).toContain(`${'b'.repeat(1500)}… (cut; the whole brief: status)`)
  })

  it('says when its attempts could not be read', () => {
    expect(taskText(group, swarm([group]), null, changed({}), NOW)).toContain('Earlier attempts could not be read.')
  })
})

// Task steps design: a step is shown inside its task, never as a task of its own.
describe('steps', () => {
  const withSteps = () => swarm([
    task('g1835', 1835, 'Fix login', 'dev1', 'working'),
    task('g1918', 1918, 'Review', 'rev1', 'working', { reviewOf: 'g1835', step: 'Review',
      checks: [{ id: 'c', description: 'Verdict', independent: false, evidence: null, passedBy: 'agent:rev1' }] }),
    task('g1919', 1919, 'Test', 'dev1', 'done', { reviewOf: 'g1835', step: 'Test', assignment: { id: 'a', agentId: 'dev1', status: 'done', result: 'Passed on a Mac' } }),
  ], { agents: [{ id: 'pm', name: 'PM' }, { id: 'dev1', name: 'Dev1' }, { id: 'rev1', name: 'Rev1' }] })

  it('mine shows a step\'s agent its step by its task', () => {
    expect(mineText(withSteps(), changed({}), 'rev1', NOW)).toBe('#1835 Fix login · Review (conversation g1918) — working')
  })

  it('mine shows the owner its task\'s steps on one line', () => {
    expect(mineText(withSteps(), changed({}), 'dev1', NOW)).toBe(
      '#1835 Fix login (conversation g1835) — working\n  steps: Review (Rev1): working · Test (Dev1): done')
  })

  it('the coordinator\'s open work counts tasks, not steps', () => {
    const text = mineText(withSteps(), changed({}), 'pm', NOW)
    expect(text).toContain('#1835 Fix login (conversation g1835) — Dev1, working\n  steps: Review (Rev1): working · Test (Dev1): done')
    expect(text).not.toContain('#1918')
    expect(text.endsWith('1 open task.')).toBe(true)
  })

  it('task lists its steps', () => {
    const state = withSteps()
    const group = (state.conversations as Array<Record<string, unknown>>).find(c => c.id === 'g1835')!
    const text = taskText(group, state, [], changed({}), NOW)
    expect(text).toContain('Steps:\n- Review (Rev1): working, 1 of 1 checks passed (conversation g1918)\n- Test (Dev1): done: Passed on a Mac (conversation g1919)')
    expect(text).not.toContain('Linked:')
  })

  it('task of a step shows its task with the step marked', () => {
    const state = withSteps()
    const step = (state.conversations as Array<Record<string, unknown>>).find(c => c.id === 'g1918')!
    const text = taskText(step, state, [], changed({}), NOW)
    expect(text.split('\n')[0]).toBe('#1835 Fix login (conversation g1835)')
    expect(text).toContain('▶ Review (Rev1): working')
  })
})

// E2E 2026-11-02: a new Swarm's default project is 'lead', whose Lead conversation has no projectId while its tasks say
// 'lead' (backend groupProject reads a missing one as 'lead'): the PM's mine counted none of them.
describe('the default project', () => {
  it('the coordinator\'s mine counts the tasks of a Lead conversation with no projectId', () => {
    const state = {
      projects: [{ id: 'lead', name: 'Main', leadConversationId: 'lead' }],
      agents: [{ id: 'pm', name: 'PM' }, { id: 'dev1', name: 'Dev1' }],
      conversations: [
        { id: 'lead', title: 'Main', leadId: 'pm', agentIds: ['pm'], archived: false, checks: [], assignment: null },
        { ...task('g1', 1, 'Fix login', 'dev1', 'review'), projectId: 'lead' },
      ],
    }
    expect(mineText(state, changed({}), 'pm', NOW)).toBe('#1 Fix login (conversation g1) — Dev1, review\n1 open task.')
  })
})

// E2E 2026-11-02: after the PM stopped the Engineer, task GROUP printed its raw id where it had said "Engineer".
describe('a stopped agent', () => {
  it('task names it from the names it was given', () => {
    const group = task('g1', 1, 'Fix', 'gone', 'done', { checks: [{ id: 'c', description: 'Tests pass', independent: false, evidence: 'ok', passedBy: 'agent:gone' }] })
    const text = taskText(group, swarm([group]), [], changed({}), NOW, new Map([['gone', 'Avery']]))
    expect(text).toContain('Assignee: Avery')
    expect(text).toContain('✓ Tests pass — by Avery')
  })
})

// Ken, 2026-11-02: every linked task is a step, named or not (backend steps.ts isStep).
describe('a linked task with no step name', () => {
  it('is a step named by its title', () => {
    const state = swarm([task('g12', 12, 'Fix login', 'dev1', 'working'),
      task('g13', 13, 'Test: PR #7', 'rev1', 'working', { reviewOf: 'g12' })])
    expect(mineText(state, changed({}), 'dev1', NOW)).toBe('#12 Fix login (conversation g12) — working\n  steps: Test: PR #7 (Rev1): working')
    expect(mineText(state, changed({}), 'rev1', NOW)).toBe('#12 Fix login · Test: PR #7 (conversation g13) — working')
  })
})

// Diego, 2026-11-03 (#2311): a Tester and a Reviewer record the same check; each one's latest verdict is kept, and a failure
// wins until its own checker passes it.
describe('a check with several checkers', () => {
  const verdict = (by: string, passed: boolean, evidence: string, at: number) => ({ by, passed, evidence, at })
  const withCheck = (check: Group) => task('g1', 1, 'Fix login', 'dev1', 'review',
    { checks: [{ id: 'c', description: 'Signs in offline', independent: true, ...check }] })

  it('shows each checker\'s verdict, a failure first', () => {
    const group = withCheck({ evidence: 'Crashes offline\nlog', passedBy: null,
      verdicts: [verdict('agent:rev1', true, 'Diff reads right', 1), verdict('person:owner', false, 'Crashes offline\nlog', 2)] })
    // A person by username, never email (task #2954).
    const state = swarm([group], { people: [{ id: 'owner', email: 'owner@example.com', username: 'ken15' }] })
    expect(taskText(group, state, [], changed({}), NOW)).toContain('✗ Signs in offline — failed by ken15: Crashes offline; passed by Rev1')
  })

  it('names every checker that passed it', () => {
    const group = withCheck({ evidence: 'Works', passedBy: 'agent:dev1',
      verdicts: [verdict('agent:rev1', true, 'Diff reads right', 1), verdict('agent:dev1', true, 'Works', 2)] })
    expect(taskText(group, swarm([group]), [], changed({}), NOW)).toContain('✓ Signs in offline — by Rev1, Dev1')
  })

  it('names a stopped checker', () => {
    const group = withCheck({ evidence: 'Crashes', passedBy: null, verdicts: [verdict('agent:gone', false, 'Crashes', 1)] })
    expect(unknownAgents(group, swarm([group]), [])).toContain('gone')
  })

  // Diego, 2026-11-04 (#2656): a departed checker's failure is read by its last known name, not a bare id.
  it('names a stopped checker\'s failure by its last known name', () => {
    const group = withCheck({ evidence: 'Crashes', passedBy: null,
      verdicts: [verdict('agent:gone', false, 'Crashes', 1), verdict('agent:rev1', true, 'Diff reads right', 2)] })
    expect(taskText(group, swarm([group]), [], changed({}), NOW, new Map([['gone', 'Plover']])))
      .toContain('✗ Signs in offline — failed by Plover: Crashes; passed by Rev1')
  })
})
