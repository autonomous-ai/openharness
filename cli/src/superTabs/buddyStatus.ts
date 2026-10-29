/**
 * A Buddy's status (Ken, 10-29): its project's work as its person reads it, so it can say which task owns something, its
 * pull request and CI state, and what blocks it without the PM's summaries. The backend decides what a Buddy reads
 * (buddies.ts: its project's workgroups, never a private chat); this only shapes that read into a bounded task summary in
 * place of the whole Swarm every other agent gets: no briefs, machines or starts, at most BUDDY_TASKS_MAX tasks, and pull
 * requests read with the person's own GitHub (a Buddy runs only on its person's own machine) up to the reader's limit.
 */
import { PULL_REQUESTS_MAX, type PullRequestsResult } from '../lib/pullRequestsStatus.js'
import { validPullRequestUrl } from '../lib/sessionWorkWire.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value ? value.slice(0, max) : undefined

/** The newest tasks a summary lists; `more` counts the rest. One of the largest projects holds about 60 open groups. */
export const BUDDY_TASKS_MAX = 100
const ARCHIVED = 'Archived tasks the PM has reported on are left out: read them with status --archived.'
const ROLES: Record<string, string> = { builder: 'Engineer', reviewer: 'Reviewer' }

export interface BuddyStatusDeps {
  /** The person's own GitHub, through gh on their machine (lib/pullRequestsStatus.ts). */
  pullRequests: (urls: string[]) => Promise<PullRequestsResult>
  /** The person's open decisions in this project, as the backend's decisions read gives them to their Buddy. */
  decisions: () => Promise<unknown>
}
export interface BuddyStatusInput {
  state: Json
  lastChangedAt: number | null
  /** When each group last changed, from its part (swarmReads.ts). */
  groupChangedAt: ReadonlyMap<string, number>
  agentId: string
  /** This Buddy's previous summary's lastChangedAt, or null on its first. */
  since: number | null
}

export const isBuddyIn = (state: Json, agentId: string): boolean => !!object(list(state.agents).find(a => a.id === agentId)?.buddyOf).personId

export async function buddyStatus(input: BuddyStatusInput, deps: BuddyStatusDeps): Promise<Json> {
  const { state, agentId } = input
  const self = list(state.agents).find(a => a.id === agentId)
  const project = list(state.projects).find(p => p.id === self?.projectId) ?? { name: null, leadConversationId: 'lead' }
  const changedAt = (id: unknown) => input.groupChangedAt.get(String(id)) ?? 0
  const open = list(state.conversations)
    // An archived task stays in the active set until the PM's report covers it (backend commands.ts conversation.archive),
    // and the archived list holds only dormant ones: it is shown here, marked, so it is never in neither (review 1 of #2115).
    .filter(c => c.id !== project.leadConversationId && c.kind !== 'buddy' && c.kind !== 'leads' && c.dormant !== true)
    .sort((a, b) => changedAt(b.id) - changedAt(a.id))
  const groups = open.slice(0, BUDDY_TASKS_MAX)
  const rows = await taskRows(groups, state, deps, id => {
    const at = changedAt(id)
    return { lastActivity: at ? new Date(at).toISOString() : null, changed: input.since !== null && at > input.since }
  })
  return {
    project: { name: project.name ?? null, chat: project.leadConversationId },
    chat: list(state.conversations).find(c => c.kind === 'buddy' && Array.isArray(c.agentIds) && c.agentIds.includes(agentId))?.id ?? null,
    since: input.since === null ? null : new Date(input.since).toISOString(),
    more: open.length - groups.length,
    archived: ARCHIVED,
    ...rows,
  }
}

/** One page of the archived tasks a Buddy reads (the backend's dormant list, 50 a page), in the same rows. */
export async function buddyArchived(page: unknown, state: Json, _agentId: string, deps: BuddyStatusDeps): Promise<Json> {
  const parts = list(object(page).groups)
  const changedAt = new Map(parts.map(p => [String(object(p.data).id), Number(p.changedAt) || 0]))
  const rows = await taskRows(parts.map(p => object(p.data)), state, deps, id => {
    const at = changedAt.get(String(id)) ?? 0
    return { lastActivity: at ? new Date(at).toISOString() : null }
  })
  return { ...rows, next: typeof object(page).next === 'string' ? object(page).next : null }
}

async function taskRows(groups: Json[], state: Json, deps: BuddyStatusDeps, activity: (id: unknown) => Json): Promise<Json> {
  // Only links the reader takes: it refuses a whole batch for one it does not (security review 2 of #2115).
  const urls = (group: Json) => (Array.isArray(group.pullRequestUrls) ? group.pullRequestUrls : []).filter(validPullRequestUrl)
  // Newest tasks first, so the reader's limit leaves out the oldest pull requests, never the ones being worked on.
  const checked = [...new Set(groups.flatMap(urls))].slice(0, PULL_REQUESTS_MAX)
  const [read, asked] = await Promise.all([
    checked.length ? deps.pullRequests(checked) : Promise.resolve({ rows: [] } as unknown as PullRequestsResult),
    deps.decisions().catch(() => null),
  ])
  const prs = new Map(read.rows.map(row => [row.url, row]))
  const decisions = list(object(asked).decisions)
  const agents = new Map(list(state.agents).map(a => [a.id, a]))
  const tasks = groups.map(group => {
    const assignment = object(group.assignment), status = typeof assignment.status === 'string' ? assignment.status : 'open'
    return {
      conversationId: group.id, number: group.number ?? null, title: group.title, ...(group.archived === true ? { archived: true } : {}),
      ...(group.reviewOf ? { reviewOf: group.reviewOf } : {}),
      status, ...(text(assignment.result, 500) ? { note: text(assignment.result, 500) } : {}),
      owns: Array.isArray(object(group.task).owns) ? (object(group.task).owns as unknown[]).filter(o => typeof o === 'string').slice(0, 40) : [],
      agents: (Array.isArray(group.agentIds) ? group.agentIds : []).flatMap(id => {
        const agent = agents.get(id)
        if (!agent) return []
        const role = group.leadId === id ? 'Product Manager' : ROLES[String(agent.role ?? 'builder')] ?? 'Engineer'
        const state = agent.downSince ? 'down' : assignment.agentId === id ? status : 'present'
        return [{ name: agent.displayName ?? agent.name, role, state }]
      }),
      checks: list(group.checks).map(c => ({ description: c.description, passed: !!c.passedBy })),
      pullRequests: urls(group).map(url => {
        const row = prs.get(url)
        if (!row) return { url, state: 'not checked' }
        if (row.status !== 'found') return { url, state: row.status === 'no_access' ? 'no access' : 'unavailable' }
        return { url, state: row.state, ci: row.ci, checks: row.checks, review: row.reviewDecision || null, merge: row.mergeStateStatus }
      }),
      decisions: decisions.filter(d => d.conversationId === group.id)
        .map(d => ({ question: d.question, options: d.options, recommended: d.recommended, unblocks: d.unblocks })),
      ...activity(group.id),
    }
  })
  return { tasks, ...(read.error ? { pullRequestsError: read.error } : {}), ...(asked === null ? { decisionsError: 'Your decisions could not be read.' } : {}) }
}
