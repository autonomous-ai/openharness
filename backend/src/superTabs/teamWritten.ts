/**
 * A task a Harness Team agent worked on (audit H2, docs/security/2026-11-02-team-account-boundary.md): its branch runs
 * only in a Team account, never with the main account's rights, as install scripts, tests and project settings would
 * run there with no race and no bug. docs/plans/2026-11-02-team-written-branch-plan.md.
 *
 * The mark comes from the Swarm's own record of who worked on the task, or from GitHub's record of who pushed. It never
 * clears, and it is never read from a commit's author, which anyone can write. A step reads its task's mark. A Team agent
 * given only a step does not mark the task: it reads or tests, and a push of its own shows in GitHub's record.
 */
import { fail, type Agent, type Conversation, type SuperTabState } from './model.js'
import { groupProject, ledProject, onTeamAccount, teamAccountPool } from './projects.js'

export const TEAM_WRITTEN_WORK = 'TEAM_WRITTEN_WORK'
export const TEAM_WRITTEN_REASON = 'A Harness Team agent wrote this task\'s code, so it runs only in a Team account, never in the main account. Choose an agent or machine in a Team account.'

const coordinates = (state: SuperTabState, group: Conversation, worker: Agent): boolean =>
  ledProject(state, worker.id)?.id === groupProject(state, group).id

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
  if (!coordinates(state, group, worker) && teamWrittenTask(state, group) && !onTeamAccount(state, worker)) failTeamWritten()
}

/** Refuses a start for Team-written code on a machine outside a Team account. */
export function requireTeamWrittenMachine(state: SuperTabState, group: Conversation, machineId: string): void {
  if (teamWrittenTask(state, group) && !teamAccountPool(state.machines?.find(m => m.machineId === machineId))) failTeamWritten()
}

export function failTeamWritten(): never {
  return fail(TEAM_WRITTEN_WORK, TEAM_WRITTEN_REASON, 403)
}
