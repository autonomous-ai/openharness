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
  /** For a step: its task's number and title, by which it is shown (task steps design). */
  taskNumber: number | null
  taskTitle: string | null
}

const isOpen = (group: Json): boolean => {
  const status = text(object(group.assignment).status)
  return !!status && !FINISHED_STATUSES.includes(status)
}
const leadConversations = (state: Json): string[] =>
  Array.isArray(state.projects) ? list(state.projects).map(p => String(p.leadConversationId)) : ['lead']
/** A step of a task (task steps design): a linked group with a name; an older linked group has none. */
export const isStep = (group: Json): boolean => typeof group.reviewOf === 'string'
/** A step's name: the one it was opened with, else its title (a linked task opened without one is a step too, Ken
 *  2026-11-02; backend steps.ts stepName). */
export const stepName = (group: Json): string => text(group.step) ?? String(group.title ?? '')
/** Work an agent may hold: a group of a project that is not its Lead conversation, a Buddy chat or any other kind. */
const isWork = (state: Json, group: Json): boolean => !group.kind && !leadConversations(state).includes(String(group.id))
/** A task: work that is not a step. */
const isTask = (state: Json, group: Json): boolean => isWork(state, group) && !isStep(group)

/** A project's Lead is its Lead conversation's, as the backend reads it; a Swarm from before projects has one, 'lead'. */
export function isCoordinator(state: Json, agentId: string): boolean {
  const leads = leadConversations(state)
  return list(state.conversations).some(c => leads.includes(String(c.id)) && c.leadId === agentId)
}

const agentName = (state: Json, agentId: unknown): string | null =>
  typeof agentId === 'string' ? text(list(state.agents).find(a => a.id === agentId)?.name) ?? agentId : null

function lineOf(state: Json, group: Json): TaskLine {
  const assignment = object(group.assignment)
  const task = isStep(group) ? list(state.conversations).find(c => c.id === group.reviewOf) : undefined
  return {
    taskNumber: task && typeof task.number === 'number' ? task.number : null, taskTitle: task ? String(task.title ?? '') : null,
    id: String(group.id), number: typeof group.number === 'number' ? group.number : null, title: String(group.title ?? ''),
    status: text(assignment.status) ?? 'unassigned', agentName: agentName(state, assignment.agentId),
    updatedAt: null, result: text(assignment.result),
    pullRequestUrls: Array.isArray(group.pullRequestUrls) ? group.pullRequestUrls.filter((u): u is string => typeof u === 'string') : [],
    step: isStep(group) ? stepName(group) : null, taskId: text(group.reviewOf),
  }
}

/** The tasks assigned to [agentId] that are open work and not archived. A reused agent keeps `assignment.agentId` on an
 *  old finished task until it goes dormant; listing it ("#11 (done)") is the confusion this exists to end. */
export function openWorkOf(state: Json, agentId: string): TaskLine[] {
  return list(state.conversations)
    .filter(g => isWork(state, g) && g.archived !== true && isOpen(g) && object(g.assignment).agentId === agentId)
    .map(g => lineOf(state, g))
}

/** The coordinator's project: every task of it that is not archived and not finished, assigned or not. */
export function projectOpenWork(state: Json, agentId: string): TaskLine[] {
  const leads = new Set(leadConversations(state))
  const lead = list(state.conversations).find(c => leads.has(String(c.id)) && c.leadId === agentId)
  if (!lead) return []
  // A missing projectId is the default project, 'lead', as the backend reads it (groupProject): a new Swarm's Lead
  // conversation has none while its tasks say 'lead' (E2E 2026-11-02: the PM's mine counted none of them).
  const projectOf = (g: Json) => String(g.projectId ?? 'lead')
  const home = String(list(state.projects).find(p => p.leadConversationId === lead.id)?.id ?? projectOf(lead))
  return list(state.conversations)
    .filter(g => isTask(state, g) && g.archived !== true && projectOf(g) === home
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

const label = (line: TaskLine): string => line.step && line.taskTitle !== null
  ? `${line.taskNumber !== null ? `#${line.taskNumber} ` : ''}${line.taskTitle} · ${line.step} (conversation ${line.id})`
  : `${line.number !== null ? `#${line.number} ` : ''}${line.title} (conversation ${line.id})`

function ownLine(line: TaskLine, changedAt: number | undefined, now: number): string {
  return `${label(line)} — ${line.status}`
    + (changedAt !== undefined ? `, updated ${ago(changedAt, now)}` : '')
    + (line.result ? `; last result: ${firstLine(line.result, RESULT_MAX)}` : '')
    + (line.pullRequestUrls.length ? `; PR ${line.pullRequestUrls.join(', ')}` : '')
}
const otherLine = (line: TaskLine): string =>
  `${label(line)} — ${line.agentName ? `${line.agentName}, ${line.status}` : 'unassigned'}`

/** Open tasks linked to [taskId] either way (`reviewOf`), not archived; steps are listed as steps instead. */
function linkedTo(state: Json, group: Json): TaskLine[] {
  return list(state.conversations)
    .filter(g => g.id !== group.id && g.archived !== true && !isStep(g) && (g.reviewOf === group.id || g.id === group.reviewOf)
      && (!g.assignment || isOpen(g)))
    .map(g => lineOf(state, g))
}

/** The steps of task [taskId] that are not archived, finished ones included: their verdicts are what the owner acts on. */
function stepsOf(state: Json, taskId: string): Json[] {
  return list(state.conversations).filter(g => isStep(g) && g.reviewOf === taskId && g.archived !== true)
}
const stepState = (state: Json, step: Json): string => {
  const line = lineOf(state, step)
  return `${line.step}${line.agentName ? ` (${line.agentName})` : ''}: ${line.status}`
}
/** One line with every step of a task, for `mine`: "  steps: Review (Rev1): working · Test (Dev1): done". */
function stepsLine(state: Json, taskId: string): string[] {
  const steps = stepsOf(state, taskId)
  return steps.length ? [`  steps: ${steps.map(s => stepState(state, s)).join(' · ')}`] : []
}

export function mineText(state: Json, groupChangedAt: ReadonlyMap<string, number>, agentId: string, now: number): string {
  if (isCoordinator(state, agentId)) {
    const open = projectOpenWork(state, agentId)
    if (!open.length) return 'Your project has no open task.'
    return [...open.flatMap(line => [otherLine(line), ...stepsLine(state, line.id)]), `${open.length} open task${open.length === 1 ? '' : 's'}.`].join('\n')
  }
  const own = openWorkOf(state, agentId)
  if (!own.length) return 'No task is assigned to you.'
  const groups = new Map(list(state.conversations).map(g => [String(g.id), g]))
  return own.map(line => [ownLine(line, groupChangedAt.get(line.id), now),
    ...line.step ? [] : [...stepsLine(state, line.id), ...linkedTo(state, groups.get(line.id)!).map(linked => `  linked: ${otherLine(linked)}`)]].join('\n')).join('\n')
}

/** Who an actor key (`agent:ID` or `person:ID`) names: an agent by its name, a person by their email. */
function checkerName(state: Json, by: string): string {
  const [kind, id] = by.split(':', 2)
  return (kind === 'agent' ? agentName(state, id) : text(list(state.people).find(p => p.id === id)?.email)) ?? id ?? by
}

/** A check with each checker's latest verdict (backend checkVerdicts.ts, #2311): failed while any of them failed, each
 *  failure with its evidence first; a check from an older backend has only its last verdict. */
function checkLine(state: Json, check: Json): string {
  const description = String(check.description ?? '')
  const verdicts = list(check.verdicts).filter(v => typeof v.by === 'string')
  if (verdicts.length) {
    const failed = verdicts.filter(v => v.passed !== true), passed = verdicts.filter(v => v.passed === true)
    const by = passed.map(v => checkerName(state, String(v.by))).join(', ')
    if (!failed.length) return `✓ ${description} — by ${by}`
    const failures = failed.map(v => `failed by ${checkerName(state, String(v.by))}: ${firstLine(text(v.evidence) ?? '', RESULT_MAX)}`)
    return `✗ ${description} — ${[...failures, ...passed.length ? [`passed by ${by}`] : []].join('; ')}`
  }
  const by = text(check.passedBy)
  if (by) return `✓ ${description} — by ${checkerName(state, by)}`
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

/** The agent ids [group] and [attempts] name that the Swarm read does not list: agents stopped since. */
export function unknownAgents(group: Json, state: Json, attempts: Json[] | null): string[] {
  const listed = new Set(list(state.agents).map(a => a.id))
  const ids = [object(group.assignment).agentId, ...(attempts ?? []).map(a => a.agentId),
    ...list(group.checks).flatMap(c => [c.passedBy, ...list(c.verdicts).map(v => v.by)])
      .map(by => typeof by === 'string' && by.startsWith('agent:') ? by.slice(6) : null)]
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && !listed.has(id)))]
}

/** One task: what it is, its checks, its attempts (the current one, then [attempts] as the backend's attempts read gives
 *  them, newest first; null when that read failed), its linked tasks and how to read its conversation. */
export function taskText(asked: Json, read: Json, attempts: Json[] | null, groupChangedAt: ReadonlyMap<string, number>, now: number,
  knownNames: ReadonlyMap<string, string> = new Map()): string {
  // An agent stopped since is no longer in the Swarm read: [knownNames] names it (E2E 2026-11-02: a raw id was printed).
  const listed = new Set(list(read.agents).map(a => a.id))
  const state: Json = { ...read, agents: [...list(read.agents), ...[...knownNames].filter(([id]) => !listed.has(id)).map(([id, name]) => ({ id, name }))] }
  // A step is read as its task, with the step marked (task steps design); a step whose task is not in the read reads alone.
  const owning = isStep(asked) ? list(state.conversations).find(c => c.id === asked.reviewOf) : undefined
  const group = owning ?? asked
  const marked = owning ? String(asked.id) : null
  const line = lineOf(state, group)
  const project = list(state.projects).find(p => p.id === group.projectId)
  const changedAt = groupChangedAt.get(line.id)
  const brief = text(group.brief) ?? ''
  const assignment = group.assignment ? object(group.assignment) : null
  const tried = [...assignment ? [attemptLine(state, assignment, true)] : [],
    ...(attempts ?? []).map(a => attemptLine(state, a, false))].slice(0, ATTEMPTS_MAX)
  const checks = list(group.checks)
  const linked = linkedTo(state, group)
  const steps = stepsOf(state, String(group.id)).map(step => {
    const own = lineOf(state, step)
    const checks = list(step.checks)
    const passed = checks.filter(c => text(c.passedBy)).length
    return `${step.id === marked ? '▶' : '-'} ${stepState(state, step)}${checks.length ? `, ${passed} of ${checks.length} checks passed` : ''}`
      + `${own.result ? `: ${firstLine(own.result, RESULT_MAX)}` : ''} (conversation ${own.id})`
  })
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
    ...steps.length ? ['', 'Steps:', ...steps] : [],
    ...linked.length ? ['', 'Linked:', ...linked.map(l => `- ${otherLine(l)}`)] : [],
    '',
    `Read its conversation: messages ${line.id}; one thread: messages ${line.id} --thread ROOT`,
  ].join('\n')
}
