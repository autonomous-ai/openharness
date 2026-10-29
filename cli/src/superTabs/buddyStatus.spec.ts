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
      archived: 'Archived tasks are left out: read them with status --archived.',
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

  it('marks the tasks that changed since its last read, newest first, and leaves out archived and dormant ones', async () => {
    const groups = [{ ...offline, id: 'a', number: 1, pullRequestUrls: [] }, { ...offline, id: 'b', number: 2, pullRequestUrls: [] },
      { ...offline, id: 'c', number: 3, archived: true, pullRequestUrls: [] }, { ...offline, id: 'd', number: 4, dormant: true, pullRequestUrls: [] }]
    const status = await buddyStatus(input(swarm(groups), { a: 1000, b: 3000, c: 4000, d: 4000 }, 2000), { pullRequests: reader().read, decisions: decisions() })
    const tasks = status.tasks as Array<{ number: number; changed: boolean }>
    expect(tasks.map(t => [t.number, t.changed])).toEqual([[2, true], [1, false]])
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
