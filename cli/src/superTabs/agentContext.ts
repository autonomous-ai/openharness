/**
 * What an agent works on, from the Swarm read it already makes (design docs/plans/2026-11-02-agent-context-design.md,
 * section 1). Ken, 2026-11-02: agents forgot which task they were on and how far it got, and the PM read the whole Swarm
 * (over a hundred groups) to learn its project's progress. `mine` is one short line per task; `task` is one task as its
 * readers need it. Nothing here decides workflow: when to read them is the project's instructions'.
 */

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null

/** Statuses of finished work, as the backend's FINISHED (parts/light.ts) and activeWork (model.ts) read them. */
export const FINISHED_STATUSES: readonly string[] = ['done', 'stopped', 'cancelled', 'lost']
const RESULT_MAX = 160
const BRIEF_MAX = 1500
const ATTEMPTS_MAX = 10

export interface TaskLine {
  id: string
  number: number | null
  title: string
  status: string
  agentName: string | null
  updatedAt: number | null
  result: string | null
  pullRequestUrls: string[]
  step: string | null
  taskId: string | null
}

const isOpen = (group: Json): boolean => {
  const status = text(object(group.assignment).status)
  return !!status && !FINISHED_STATUSES.includes(status)
}
const leadConversations = (state: Json): string[] =>
  Array.isArray(state.projects) ? list(state.projects).map(p => String(p.leadConversationId)) : ['lead']
/** A task: a group of a project that is not its Lead conversation, a Buddy chat or any other kind. */
const isTask = (state: Json, group: Json): boolean => !group.kind && !leadConversations(state).includes(String(group.id))

/** A project's Lead is its Lead conversation's, as the backend reads it; a Swarm from before projects has one, 'lead'. */
export function isCoordinator(state: Json, agentId: string): boolean {
  const leads = leadConversations(state)
  return list(state.conversations).some(c => leads.includes(String(c.id)) && c.leadId === agentId)
}

const agentName = (state: Json, agentId: unknown): string | null =>
  typeof agentId === 'string' ? text(list(state.agents).find(a => a.id === agentId)?.name) ?? agentId : null

function lineOf(state: Json, group: Json): TaskLine {
  const assignment = object(group.assignment)
  return {
    id: String(group.id), number: typeof group.number === 'number' ? group.number : null, title: String(group.title ?? ''),
    status: text(assignment.status) ?? 'unassigned', agentName: agentName(state, assignment.agentId),
    updatedAt: null, result: text(assignment.result),
    pullRequestUrls: Array.isArray(group.pullRequestUrls) ? group.pullRequestUrls.filter((u): u is string => typeof u === 'string') : [],
    step: text(group.step), taskId: text(group.reviewOf),
  }
}

/** The tasks assigned to [agentId] that are open work and not archived. A reused agent keeps `assignment.agentId` on an
 *  old finished task until it goes dormant; listing it ("#11 (done)") is the confusion this exists to end. */
export function openWorkOf(state: Json, agentId: string): TaskLine[] {
  return list(state.conversations)
    .filter(g => isTask(state, g) && g.archived !== true && isOpen(g) && object(g.assignment).agentId === agentId)
    .map(g => lineOf(state, g))
}

/** The coordinator's project: every task of it that is not archived and not finished, assigned or not. */
export function projectOpenWork(state: Json, agentId: string): TaskLine[] {
  const leads = new Set(leadConversations(state))
  const lead = list(state.conversations).find(c => leads.has(String(c.id)) && c.leadId === agentId)
  if (!lead) return []
  return list(state.conversations)
    .filter(g => isTask(state, g) && g.archived !== true && (g.projectId ?? null) === (lead.projectId ?? null)
      && (!g.assignment || isOpen(g)))
    .map(g => lineOf(state, g))
}

const firstLine = (value: string, max: number): string => {
  const line = value.split('\n', 1)[0]!.trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}
/** How long ago, for a person or a model reading a terminal: minutes and hours, else the UTC time. */
export function ago(at: number, now: number): string {
  const ms = now - at
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`
  return utc(at)
}
const utc = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const label = (line: TaskLine): string =>
  `${line.number !== null ? `#${line.number} ` : ''}${line.title} (conversation ${line.id})`

function ownLine(line: TaskLine, changedAt: number | undefined, now: number): string {
  return `${label(line)} — ${line.status}`
    + (changedAt !== undefined ? `, updated ${ago(changedAt, now)}` : '')
    + (line.result ? `; last result: ${firstLine(line.result, RESULT_MAX)}` : '')
    + (line.pullRequestUrls.length ? `; PR ${line.pullRequestUrls.join(', ')}` : '')
}
const otherLine = (line: TaskLine): string =>
  `${label(line)} — ${line.agentName ? `${line.agentName}, ${line.status}` : 'unassigned'}`

/** Open tasks linked to [taskId] either way (`reviewOf`), not archived. */
function linkedTo(state: Json, group: Json): TaskLine[] {
  return list(state.conversations)
    .filter(g => g.id !== group.id && g.archived !== true && (g.reviewOf === group.id || g.id === group.reviewOf)
      && (!g.assignment || isOpen(g)))
    .map(g => lineOf(state, g))
}

export function mineText(state: Json, groupChangedAt: ReadonlyMap<string, number>, agentId: string, now: number): string {
  if (isCoordinator(state, agentId)) {
    const open = projectOpenWork(state, agentId)
    if (!open.length) return 'Your project has no open task.'
    return [...open.map(otherLine), `${open.length} open task${open.length === 1 ? '' : 's'}.`].join('\n')
  }
  const own = openWorkOf(state, agentId)
  if (!own.length) return 'No task is assigned to you.'
  const groups = new Map(list(state.conversations).map(g => [String(g.id), g]))
  return own.map(line => [ownLine(line, groupChangedAt.get(line.id), now),
    ...linkedTo(state, groups.get(line.id)!).map(linked => `  linked: ${otherLine(linked)}`)].join('\n')).join('\n')
}

function checkLine(state: Json, check: Json): string {
  const description = String(check.description ?? '')
  const by = text(check.passedBy)
  if (by) {
    const [kind, id] = by.split(':', 2)
    const name = kind === 'agent' ? agentName(state, id) : text(list(state.people).find(p => p.id === id)?.email) ?? id
    return `✓ ${description} — by ${name}`
  }
  const evidence = text(check.evidence)
  return evidence ? `✗ ${description} — ${firstLine(evidence, RESULT_MAX)}` : `· ${description}`
}

function attemptLine(state: Json, attempt: Json, current: boolean): string {
  const at = typeof attempt.createdAt === 'string' ? Date.parse(attempt.createdAt) : NaN
  const result = text(attempt.result)
  return `- ${agentName(state, attempt.agentId) ?? 'unknown'}, ${String(attempt.status)}`
    + (current ? ' (current)' : Number.isFinite(at) ? `, ${utc(at)}` : '')
    + (result ? `: ${firstLine(result, RESULT_MAX)}` : '')
}

/** One task: what it is, its checks, its attempts (the current one, then [attempts] as the backend's attempts read gives
 *  them, newest first; null when that read failed), its linked tasks and how to read its conversation. */
export function taskText(group: Json, state: Json, attempts: Json[] | null, groupChangedAt: ReadonlyMap<string, number>, now: number): string {
  const line = lineOf(state, group)
  const project = list(state.projects).find(p => p.id === group.projectId)
  const changedAt = groupChangedAt.get(line.id)
  const brief = text(group.brief) ?? ''
  const assignment = group.assignment ? object(group.assignment) : null
  const tried = [...assignment ? [attemptLine(state, assignment, true)] : [],
    ...(attempts ?? []).map(a => attemptLine(state, a, false))].slice(0, ATTEMPTS_MAX)
  const checks = list(group.checks)
  const linked = linkedTo(state, group)
  return [
    label(line),
    [project ? `Project: ${String(project.name)}` : null, `Status: ${line.status}`, line.agentName ? `Assignee: ${line.agentName}` : null,
      changedAt !== undefined ? `Updated ${ago(changedAt, now)}` : null].filter(Boolean).join(' · '),
    ...line.pullRequestUrls.length ? [`PR: ${line.pullRequestUrls.join(', ')}`] : [],
    '',
    brief.length > BRIEF_MAX ? `${brief.slice(0, BRIEF_MAX)}… (cut; the whole brief: status)` : brief || 'No brief.',
    '',
    'Checks:',
    ...checks.length ? checks.map(c => checkLine(state, c)) : ['none'],
    '',
    'Attempts (newest first):',
    ...tried.length ? tried : ['none'],
    ...attempts === null ? ['Earlier attempts could not be read.'] : [],
    ...linked.length ? ['', 'Linked:', ...linked.map(l => `- ${otherLine(l)}`)] : [],
    '',
    `Read its conversation: messages ${line.id}; one thread: messages ${line.id} --thread ROOT`,
  ].join('\n')
}
