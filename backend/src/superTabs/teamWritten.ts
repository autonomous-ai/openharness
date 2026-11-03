/**
 * A task a Harness Team agent worked on (audit H2, docs/security/2026-11-02-team-account-boundary.md): its branch runs
 * only in a Team account, never with the main account's rights, as install scripts, tests and project settings would
 * run there with no race and no bug. docs/plans/2026-11-02-team-written-branch-plan.md.
 *
 * The mark comes from the Swarm's own record of who worked on the task, or from GitHub's record of who pushed. It never
 * clears, and it is never read from a commit's author, which anyone can write. A step reads its task's mark. A Team agent
 * given only a step does not mark the task: it reads or tests, and a push of its own shows in GitHub's record.
 */
import type { PushOrigin } from '../github/pushOrigin.js'
import { fail, type Agent, type Conversation, type SuperTabState } from './model.js'
import { groupProject, ledProject, onTeamAccount, teamAccountPool } from './projects.js'

export const TEAM_WRITTEN_WORK = 'TEAM_WRITTEN_WORK'
export const TEAM_WRITTEN_REASON = 'A Harness Team agent wrote this task\'s code, so it runs only in a Team account, never in the main account. Choose an agent or machine in a Team account.'

const coordinates = (state: SuperTabState, group: Conversation, worker: Agent): boolean =>
  ledProject(state, worker.id)?.id === groupProject(state, group).id

/** Told to an agent in the main account when a task it works on turns out to be Team-written. */
export const TEAM_WRITTEN_STOP = 'Stop: GitHub shows a Harness Team agent pushed to this task\'s branch. Do not install, build, test or run it in the main account. Set this step blocked and hand it to an agent in a Team account.'

/** The task a group's code belongs to: its own, or for a step, the task the step belongs to. */
const taskOf = (state: SuperTabState, group: Conversation): Conversation | undefined =>
  group.reviewOf ? state.conversations.find(c => c.id === group.reviewOf) : group

/** Whether [group]'s code is Team-written. An open task from before the mark reads its current assignee too. A step whose
 *  task this command did not load counts as Team-written: an unknown never reads as clean. */
export function teamWrittenTask(state: SuperTabState, group: Conversation): boolean {
  const task = taskOf(state, group)
  if (!task || group.teamWritten || task.teamWritten) return true
  const assignee = state.agents.find(a => a.id === task.assignment?.agentId)
  return !!assignee && onTeamAccount(state, assignee)
}

/** Marks [group] when [worker], assigned to it or added to it, runs in a Team account. A step or the project's coordinator marks nothing. */
export function markTeamWritten(state: SuperTabState, group: Conversation, worker: Agent): void {
  if (group.reviewOf || coordinates(state, group, worker) || !onTeamAccount(state, worker)) return
  group.teamWritten = true
}

/** Refuses an agent outside a Team account for Team-written code. The project's coordinator stays: it never builds or runs it. */
export function requireTeamWrittenAccount(state: SuperTabState, group: Conversation, worker: Agent): void {
  if (barredFromTeamWritten(state, group, worker)) failTeamWritten()
}

/** Whether [worker] may not join [group]: an agent outside a Team account, in Team-written code, and not its project's coordinator. */
export const barredFromTeamWritten = (state: SuperTabState, group: Conversation, worker: Agent): boolean =>
  !coordinates(state, group, worker) && teamWrittenTask(state, group) && !onTeamAccount(state, worker)

/** Refuses a start for Team-written code on a machine outside a Team account. */
export function requireTeamWrittenMachine(state: SuperTabState, group: Conversation, machineId: string): void {
  if (teamWrittenTask(state, group) && !teamAccountPool(state.machines?.find(m => m.machineId === machineId))) failTeamWritten()
}

export function failTeamWritten(details?: Record<string, unknown>): never {
  return fail(TEAM_WRITTEN_WORK, TEAM_WRITTEN_REASON, 403, details)
}

/** Whether [worker] has a step of [group], assigned now or before: it reads or tests that task, and a push of its own shows in GitHub. */
export const hasStep = (state: SuperTabState, group: Conversation, worker: Agent): boolean =>
  state.conversations.some(c => c.reviewOf === group.id && (c.assignment?.agentId === worker.id || c.agentIds.includes(worker.id)))

/** Refuses an agent naming a main-account member of Team-written work in a post: how a re-test or re-check is asked for. */
export function requireNameable(state: SuperTabState, group: Conversation, sender: Agent, named: Agent): void {
  if (coordinates(state, group, sender) || named.id === sender.id) return
  requireTeamWrittenAccount(state, group, named)
}

/** Everyone to tell when [group]'s task has just been marked, by the conversation that reaches them, each once: the main-account
 *  members of the task and of every step, finished steps included, as the workflow asks them again. Not the coordinator. */
export function mainAccountMembers(state: SuperTabState, group: Conversation, except?: string): Array<{ conversationId: string; agentIds: string[] }> {
  const task = taskOf(state, group) ?? group
  const seen = new Set<string>(except ? [except] : [])
  return [task, ...state.conversations.filter(c => c.reviewOf === task.id)].flatMap(c => {
    const agentIds = c.agentIds.filter(id => {
      const member = state.agents.find(a => a.id === id)
      if (!member || seen.has(id) || onTeamAccount(state, member) || coordinates(state, group, member)) return false
      seen.add(id)
      return true
    })
    return agentIds.length ? [{ conversationId: c.id, agentIds }] : []
  })
}

/** GitHub's record of who pushed: a bot among [group]'s pushes marks its task for good. A clean reading clears nothing. */
export function applyPushOrigin(state: SuperTabState, group: Conversation, origin: PushOrigin | undefined): void {
  if (origin !== 'team') return
  const task = taskOf(state, group)
  if (task) task.teamWritten = true
  group.teamWritten = true
}

export function failPushUnknown(): never {
  return fail(TEAM_WRITTEN_WORK, 'GitHub could not show who pushed this task\'s code, so it runs only in a Team account for now. Choose an agent in a Team account, or try again in a minute.', 403)
}
