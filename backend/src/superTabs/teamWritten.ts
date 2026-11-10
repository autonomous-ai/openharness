/**
 * A task a Harness Team agent worked on (audit H2, docs/security/2026-11-02-team-account-boundary.md): its branch runs
 * only in a Team account, never with the main account's rights, as install scripts, tests and project settings would
 * run there with no race and no bug. docs/plans/2026-11-02-team-written-branch-plan.md.
 *
 * The mark follows the code (#3304): a Team agent assigned to build the task, or GitHub's record of a bot's push. Joining the
 * task, being named into it, posting or opening it marks nothing: a push of the agent's own shows in GitHub's record. It is
 * never read from a commit's author, which anyone can write. A step reads its task's mark, and a Team agent given only a
 * step does not mark the task. An assignment's mark stays; a push's, or one a join set before #3304, clears only when a clean
 * GitHub read covers every pull request it rests on (applyPushOrigin).
 */
import type { PushOrigin } from '../github/pushOrigin.js'
import { codePullRequests, fail, type Agent, type Conversation, type SuperTabState } from './model.js'
import { groupProject, ledProject } from './projects.js'

export const TEAM_WRITTEN_WORK = 'TEAM_WRITTEN_WORK'
export const TEAM_WRITTEN_REASON = 'A Harness Team agent wrote this task\'s code, so only the project owner\'s own agent, on their own computer, may run it.'

const coordinates = (state: SuperTabState, group: Conversation, worker: Agent): boolean =>
  ledProject(state, worker.id)?.id === groupProject(state, group).id

/** Told to an agent in the main account when a task it works on turns out to be Team-written. */
export const TEAM_WRITTEN_STOP = 'Stop: GitHub shows a Harness Team agent pushed to this task\'s branch. Do not install, build, test or run it. Set this step blocked: only the project owner\'s own agent may take it.'

/** The task a group's code belongs to: its own, or for a step, the task the step belongs to. */
const taskOf = (state: SuperTabState, group: Conversation): Conversation | undefined =>
  group.reviewOf ? state.conversations.find(c => c.id === group.reviewOf) : group

/** Whether [group]'s code is Team-written. A step whose task this command did not load counts as Team-written: an unknown
 *  never reads as clean. */
export function teamWrittenTask(state: SuperTabState, group: Conversation): boolean {
  const task = taskOf(state, group)
  return !task || !!group.teamWritten || !!task.teamWritten
}

type Cause = NonNullable<Conversation['teamWrittenBy']>

/** Marks [group] for [cause], keeping the strongest: a lasting cause over pull requests, and the pull requests of every push read. */
function mark(group: Conversation, cause: Cause): void {
  const was = group.teamWrittenBy
  group.teamWritten = true
  if (was && was.kind !== 'pushed') return
  group.teamWrittenBy = cause.kind === 'pushed' && was?.kind === 'pushed' ? { kind: 'pushed', pulls: [...new Set([...was.pulls, ...cause.pulls])] } : cause
}

/** Marks each task one of [agentIds], Harness Team agents leaving with their machine (machine.teamGone), was assigned to build:
 *  a task from before the mark read its assignee, which is gone now. A step or the project's coordinator marks nothing. */
export function markHeldByTeam(state: SuperTabState, agentIds: ReadonlySet<string>): void {
  for (const group of state.conversations) {
    const worker = group.assignment ? state.agents.find(a => a.id === group.assignment!.agentId) : undefined
    if (worker && agentIds.has(worker.id) && !group.reviewOf && !coordinates(state, group, worker)) mark(group, { kind: 'assigned' })
  }
}

/** Refuses an agent for Team-written code. The project's coordinator stays: it never builds or runs it. */
export function requireTeamWrittenAccount(state: SuperTabState, group: Conversation, worker: Agent): void {
  if (barredFromTeamWritten(state, group, worker)) failTeamWritten()
}

/** Whether [worker] may not join [group], Team-written code: anyone but its project's coordinator, the project owner's own agent
 *  (Harness Team accounts are gone: task #4120, the PM's ruling). */
export const barredFromTeamWritten = (state: SuperTabState, group: Conversation, worker: Agent, marked = teamWrittenTask(state, group)): boolean =>
  marked && !coordinates(state, group, worker) && !ownersOwnAgent(state, group, worker)

/** Whether [worker] is [group]'s project owner's own agent, on their own machine: brought by them, on a machine they own, through no
 *  machine share (task #4120, the PM's ruling; security review 2 of #3446). */
export const ownersOwnAgent = (state: SuperTabState, group: Conversation, worker: Agent): boolean => {
  const ownerId = groupProject(state, group).ownerId
  return worker.contributorId === ownerId && worker.machineOwnerId === ownerId && !worker.hostGrant
}

/** Whether [machineId] is [group]'s project owner's own computer: a listed machine they contributed. */
export function ownersOwnMachine(state: SuperTabState, group: Conversation, machineId: string): boolean {
  const pool = state.machines?.find(m => m.machineId === machineId)
  return !!pool && pool.contributorId === groupProject(state, group).ownerId
}

/** Refuses a start for Team-written code anywhere but its project owner's own computer (task #4120, the PM's ruling). */
export function requireTeamWrittenMachine(state: SuperTabState, group: Conversation, machineId: string): void {
  if (teamWrittenTask(state, group) && !ownersOwnMachine(state, group, machineId)) failTeamWritten()
}

export function failTeamWritten(details?: Record<string, unknown>): never {
  return fail(TEAM_WRITTEN_WORK, TEAM_WRITTEN_REASON, 403, details)
}

/** Whether [sender] may name [named] in a post: not a main-account member of Team-written work, how a re-test or re-check is
 *  asked for, unless [sender] coordinates. A post that names one it may not goes out without it (commands.ts message.send). */
export const mayName = (state: SuperTabState, group: Conversation, sender: Agent, named: Agent): boolean =>
  coordinates(state, group, sender) || named.id === sender.id || !barredFromTeamWritten(state, group, named)

/** Everyone to tell when [group]'s task has just been marked, by the conversation that reaches them, each once: the main-account
 *  members of the task and of every step, finished steps included, as the workflow asks them again. Not the coordinator. */
export function mainAccountMembers(state: SuperTabState, group: Conversation, except?: string): Array<{ conversationId: string; agentIds: string[] }> {
  const task = taskOf(state, group) ?? group
  const seen = new Set<string>(except ? [except] : [])
  return [task, ...state.conversations.filter(c => c.reviewOf === task.id)].flatMap(c => {
    const agentIds = c.agentIds.filter(id => {
      const member = state.agents.find(a => a.id === id)
      // Only those it bars: not a Team agent, the coordinator or the project owner's own agent (barredFromTeamWritten).
      if (!member || seen.has(id) || !barredFromTeamWritten(state, task, member, true)) return false
      seen.add(id)
      return true
    })
    return agentIds.length ? [{ conversationId: c.id, agentIds }] : []
  })
}

/**
 * GitHub's record of who pushed [pulls], the pull requests the store read (none for a branch). A bot among them marks [group],
 * and its task too unless [group] is a step and [taskRead], the read of the task's own code, is not team (#3554). A clean read
 * clears a mark only where it covered everything that mark rests on (#3304): the code each of the task and that conversation
 * is in (model.ts codePullRequests), and for a push's mark the pull requests it was read on. An assignment's mark and a
 * branch's stay. A pull request recorded after the read was not covered, so it clears nothing.
 */
export function applyPushOrigin(state: SuperTabState, group: Conversation, origin: PushOrigin | undefined, pulls: readonly string[] = [],
  taskRead?: { origin: PushOrigin; pulls: readonly string[] }): void {
  const task = taskOf(state, group)
  // A step's own links (a reviewer citing another pull request, log lines) are read for the step alone; its task is marked by the
  // read of the task's own code (task #3554: #3462 was marked for its Team reviewers' links). Without that read, as before.
  const own = group.reviewOf && taskRead ? taskRead : { origin, pulls }
  const causeOf = (read: readonly string[]): Cause => read.length ? { kind: 'pushed', pulls: [...new Set(read)] } : { kind: 'branch' }
  if (origin === 'team' || own.origin === 'team') {
    if (task && own.origin === 'team') mark(task, causeOf(own.pulls))
    if (origin === 'team') mark(group, causeOf(pulls))
    return
  }
  const code = task ? codePullRequests(task) : []
  if (origin !== 'clean' || !task || !code.length) return
  const read = new Set(pulls.map(url => url.toLowerCase()))
  const covers = (urls: readonly string[]) => urls.every(url => read.has(url.toLowerCase()))
  if (!covers(code)) return
  for (const marked of [task, ...state.conversations.filter(c => c.reviewOf === task.id)]) {
    const by = marked.teamWrittenBy
    if (!marked.teamWritten || (by && (by.kind !== 'pushed' || !covers(by.pulls))) || !covers(codePullRequests(marked))) continue
    delete marked.teamWritten
    delete marked.teamWrittenBy
  }
}

export function failPushUnknown(): never {
  return fail(TEAM_WRITTEN_WORK, 'GitHub could not show who pushed this task\'s code, so only the project owner\'s own agent may run it for now. Try again in a minute.', 403)
}
