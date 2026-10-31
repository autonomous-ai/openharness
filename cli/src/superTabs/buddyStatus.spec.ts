import { describe, expect, it } from 'vitest'
import { buddyArchived, buddyStatus, isBuddyIn, BUDDY_TASKS_MAX } from './buddyStatus.js'
import type { PullRequestsResult } from '../lib/pullRequestsStatus.js'

const pr = (n: number) => `https://github.com/acme/app/pull/${n}`
/** A Swarm as a Buddy's own read gives it (backend buddies.ts): its project chat, its chat, and its project's workgroups. */
function swarm(groups: Record<string, unknown>[] = []) {
  return {
    projects: [{ id: 'app', name: 'App', leadConversationId: 'app-chat' }],
    agents: [
      { id: 'buddy', name: 'Buddy', projectId: 'app', machineId: 'peer-mac', buddyOf: { personId: 'peer', generation: 'g' } },
      { id: 'pm', name: 'PM', displayName: 'Ada', projectId: 'app', machineId: 'owner-mac' },
      { id: 'builder', name: 'Builder', displayName: 'Echo', projectId: 'app', machineId: 'owner-mac', role: 'builder' },
      { id: 'reviewer', name: 'Reviewer', projectId: 'app', machineId: 'studio', role: 'reviewer', downSince: '2026-10-29T01:00:00.000Z' },
    ],
    conversations: [
      { id: 'app-chat', projectId: 'app', title: 'App', leadId: 'pm', agentIds: ['pm'], checks: [], assignment: null },
      { id: 'buddy-chat', kind: 'buddy', projectId: 'app', title: 'Buddy', leadId: null, agentIds: ['buddy'], checks: [], assignment: null, buddyOwnerId: 'peer' },
      ...groups,
    ],
  }
}
const offline = {
  id: 'offline', projectId: 'app', number: 12, title: 'Offline sync', leadId: 'pm', agentIds: ['pm', 'builder', 'reviewer'], archived: false,
  brief: 'The whole brief, which the summary leaves out.', task: { goal: 'Keep edits', changes: 'x', constraints: 'y', owns: ['desktop/lib/sync'] },
  checks: [{ id: 'c1', description: 'Edits survive a restart', passedBy: null }, { id: 'c2', description: 'Specs pass', passedBy: 'builder' }],
  assignment: { id: 'a1', agentId: 'builder', status: 'needs_human', result: 'Ship it behind a flag?', execution: { machineId: 'owner-mac' } },
  pullRequestUrls: [pr(12)],
}
const found = (url: string, state = 'Open', ci = 'failing'): PullRequestsResult['rows'][number] =>
  ({ url, status: 'found', title: 'Offline sync', state: state as 'Open', ci: ci as 'failing', checks: { passed: 3, failed: 1, pending: 0, total: 4 },
    reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' })
const reader = (rows = (urls: string[]) => urls.map(url => found(url)), error?: string) => {
  const asked: string[][] = []
  return { asked, read: async (urls: string[]): Promise<PullRequestsResult> => { asked.push(urls); return { rows: rows(urls), checkedAt: 'now', ...(error ? { error } : {}) } } }
}
const decisions = (list: Record<string, unknown>[] = []) => async () => ({ decisions: list, more: false })
const input = (state: Record<string, unknown>, changedAt: Record<string, number> = {}, since: number | null = null) =>
  ({ state, lastChangedAt: 5000, groupChangedAt: new Map(Object.entries(changedAt)), agentId: 'buddy', since })

describe('a Buddy\'s status', () => {
  it('is only a Buddy\'s', () => {
    expect(isBuddyIn(swarm(), 'buddy')).toBe(true)
    expect(isBuddyIn(swarm(), 'builder')).toBe(false)
    expect(isBuddyIn(swarm(), 'gone')).toBe(false)
  })

  it('says which task owns what, its pull request with merge and CI state, and what blocks it, without brief or machines', async () => {
    const prs = reader()
    const status = await buddyStatus(input(swarm([offline]), { offline: Date.parse('2026-10-29T03:00:00.000Z') }), { pullRequests: prs.read,
      decisions: decisions([{ id: 'd1', conversationId: 'offline', question: 'Ship it behind a flag?', options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' }]) })
    expect(status).toEqual({
      project: { name: 'App', chat: 'app-chat' }, chat: 'buddy-chat', since: null, more: 0,
      archived: 'Archived tasks the PM has reported on are left out: read them with status --archived.',
      tasks: [{ conversationId: 'offline', number: 12, title: 'Offline sync', status: 'needs_human', note: 'Ship it behind a flag?', owns: ['desktop/lib/sync'],
        agents: [{ name: 'Ada', role: 'Product Manager', state: 'present' }, { name: 'Echo', role: 'Engineer', state: 'needs_human' },
          { name: 'Reviewer', role: 'Reviewer', state: 'down' }],
        checks: [{ description: 'Edits survive a restart', passed: false }, { description: 'Specs pass', passed: true }],
        pullRequests: [{ url: pr(12), state: 'Open', ci: 'failing', checks: { passed: 3, failed: 1, pending: 0, total: 4 }, review: 'REVIEW_REQUIRED', merge: 'BLOCKED' }],
        decisions: [{ question: 'Ship it behind a flag?', options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' }],
        lastActivity: '2026-10-29T03:00:00.000Z', changed: false }],
    })
    expect(JSON.stringify(status)).not.toMatch(/owner-mac|studio|peer-mac|whole brief/)
    expect(prs.asked).toEqual([[pr(12)]])
  })

  it('marks the tasks that changed since its last read, newest first; shows one archived until its report, and leaves out dormant ones', async () => {
    const groups = [{ ...offline, id: 'a', number: 1, pullRequestUrls: [] }, { ...offline, id: 'b', number: 2, pullRequestUrls: [] },
      { ...offline, id: 'c', number: 3, archived: true, pullRequestUrls: [] }, { ...offline, id: 'd', number: 4, dormant: true, pullRequestUrls: [] }]
    const status = await buddyStatus(input(swarm(groups), { a: 1000, b: 3000, c: 4000, d: 4000 }, 2000), { pullRequests: reader().read, decisions: decisions() })
    const tasks = status.tasks as Array<{ number: number; changed: boolean }>
    // An archived task stays active until the PM's report covers it (backend commands.ts), and the archived list has only
    // dormant ones: the summary shows it, marked, so it is in one of the two (security review 1 of #2115).
    expect(tasks.map(t => [t.number, t.changed, (t as { archived?: boolean }).archived ?? false])).toEqual([[3, true, true], [2, true, false], [1, false, false]])
    expect(status.since).toBe(new Date(2000).toISOString())
  })

  it('stays bounded: the newest tasks, and pull requests checked up to the reader\'s limit', async () => {
    const groups = Array.from({ length: BUDDY_TASKS_MAX + 5 }, (_, i) => ({ ...offline, id: `g${i}`, number: i + 1, pullRequestUrls: [pr(i + 1)] }))
    const prs = reader()
    const status = await buddyStatus(input(swarm(groups), Object.fromEntries(groups.map((g, i) => [g.id, i]))), { pullRequests: prs.read, decisions: decisions() })
    const tasks = status.tasks as Array<{ number: number; pullRequests: Array<{ state?: string }> }>
    expect(tasks).toHaveLength(BUDDY_TASKS_MAX)
    expect(status.more).toBe(5)
    expect(tasks[0]!.number).toBe(BUDDY_TASKS_MAX + 5)
    expect(prs.asked).toEqual([tasks.slice(0, 50).map(t => pr(t.number))])
    expect(tasks[50]!.pullRequests).toEqual([{ url: pr(tasks[50]!.number), state: 'not checked' }])
  })

  it('checks only valid pull request links, so one malformed link never fails the rest', async () => {
    const prs = reader(urls => urls.map(url => found(url)))
    const status = await buddyStatus(input(swarm([{ ...offline, pullRequestUrls: [pr(12), 'https://github.com/acme/app/pull/0', 'https://github.com/acme/app/pull/12/files'] }])),
      { pullRequests: prs.read, decisions: decisions() })
    expect(prs.asked).toEqual([[pr(12)]])
    expect((status.tasks as Array<{ pullRequests: Array<{ url: string; state: string }> }>)[0]!.pullRequests.map(p => p.state)).toEqual(['Open'])
  })

  it('still lists its tasks when GitHub cannot be read, saying why', async () => {
    const status = await buddyStatus(input(swarm([offline])), { pullRequests: reader(urls => urls.map(url => ({ url, status: 'unavailable', error: 'GH_SIGNED_OUT' })), 'GH_SIGNED_OUT').read,
      decisions: decisions() })
    expect(status.pullRequestsError).toBe('GH_SIGNED_OUT')
    expect((status.tasks as Array<{ pullRequests: unknown }>)[0]!.pullRequests).toEqual([{ url: pr(12), state: 'unavailable' }])
  })
})

describe('a Buddy\'s archived tasks', () => {
  it('lists one page of them in the same rows, with the cursor for the next', async () => {
    const page = { groups: [{ key: 'old', version: 1, changedAt: 1000, data: { ...offline, id: 'old', number: 9, dormant: true } }], next: 'cursor-2' }
    const status = await buddyArchived(page, swarm(), 'buddy', { pullRequests: reader().read, decisions: decisions() })
    expect((status.tasks as Array<{ number: number }>).map(t => t.number)).toEqual([9])
    expect(status.next).toBe('cursor-2')
  })
})

describe('a person\'s one Buddy\'s status (spec 2026-10-31-one-buddy-per-swarm)', () => {
  /** What the one Buddy reads: every project its person reads, each project's chat and tasks, and its one chat. */
  const many = (projects: number) => {
    const ids = Array.from({ length: projects }, (_, i) => `p${i}`)
    return {
      projects: ids.map(id => ({ id, name: `Project ${id}`, leadConversationId: `${id}-chat` })),
      agents: [{ id: 'buddy', name: 'Buddy', buddyScope: 'swarm', buddyOf: { personId: 'peer', generation: 'g' } }],
      conversations: [
        { id: 'swarm-chat', kind: 'swarm-buddy', title: 'Buddy', leadId: null, agentIds: ['buddy'], checks: [], assignment: null, buddyOwnerId: 'peer' },
        ...ids.map(id => ({ id: `${id}-chat`, projectId: id, title: id, leadId: null, agentIds: [], checks: [], assignment: null })),
        ...ids.flatMap(id => [1, 2].map(n => ({ id: `${id}-t${n}`, projectId: id, number: n, title: `${id} task ${n}`, leadId: null, agentIds: [], checks: [], assignment: null }))),
      ],
    }
  }
  const changed = (state: ReturnType<typeof many>) => Object.fromEntries(state.conversations.map((c, i) => [c.id, 1000 + i]))

  it('is an index: one line per project, at most 50, and the 20 newest tasks across them, each naming its project', async () => {
    const state = many(60)
    const status = await buddyStatus(input(state, changed(state)), { pullRequests: reader().read, decisions: decisions() })
    expect(status.projects).toHaveLength(50)
    expect(status.moreProjects).toBe(10)
    expect((status.projects as Array<Record<string, unknown>>)[0]).toEqual({ name: 'Project p0', chat: 'p0-chat', open: 2, changed: 0 })
    const tasks = status.tasks as Array<Record<string, unknown>>
    expect(tasks).toHaveLength(20)
    expect(tasks[0]).toMatchObject({ project: 'Project p59', title: 'p59 task 2' })
    expect(status.more).toBe(100)
    expect(status.chat).toBe('swarm-chat')
    // No project chat or Buddy chat is listed as a task.
    expect(tasks.map(t => t.conversationId)).not.toContain('swarm-chat')
    expect(tasks.some(t => String(t.conversationId).endsWith('-chat'))).toBe(false)
  })

  it('reads one project by name or id with status --project, and says which projects there are for a name it does not know', async () => {
    const state = many(3)
    const one = await buddyStatus({ ...input(state, changed(state)), project: 'project p1' }, { pullRequests: reader().read, decisions: decisions() })
    expect(one.project).toEqual({ name: 'Project p1', chat: 'p1-chat' })
    expect((one.tasks as Array<Record<string, unknown>>).map(t => t.conversationId)).toEqual(['p1-t2', 'p1-t1'])
    expect((await buddyStatus({ ...input(state, changed(state)), project: 'p2' }, { pullRequests: reader().read, decisions: decisions() })).project)
      .toEqual({ name: 'Project p2', chat: 'p2-chat' })
    expect(await buddyStatus({ ...input(state), project: 'Nope' }, { pullRequests: reader().read, decisions: decisions() }))
      .toEqual({ error: 'No project named Nope that your owner reads.', projects: ['Project p0', 'Project p1', 'Project p2'] })
  })
})
