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

type Cause = NonNullable<Conversation['teamWrittenBy']>

/** Marks [group] for [cause], keeping the strongest: a lasting cause over pull requests, and the pull requests of every push read. */
function mark(group: Conversation, cause: Cause): void {
  const was = group.teamWrittenBy
  group.teamWritten = true
  if (was && was.kind !== 'pushed') return
  group.teamWrittenBy = cause.kind === 'pushed' && was?.kind === 'pushed' ? { kind: 'pushed', pulls: [...new Set([...was.pulls, ...cause.pulls])] } : cause
}

/** Marks [group] when [worker], assigned to build it, runs in a Team account. A step or the project's coordinator marks nothing. */
export function markTeamWritten(state: SuperTabState, group: Conversation, worker: Agent): void {
  if (group.reviewOf || coordinates(state, group, worker) || !onTeamAccount(state, worker)) return
  mark(group, { kind: 'assigned' })
}

/** What a step opened on [task] stores: a copy of its task's mark, or an assignment's when it reads as Team-written by its assignee. */
export function stepMark(state: SuperTabState, task: Conversation): Pick<Conversation, 'teamWritten' | 'teamWrittenBy'> {
  if (task.teamWritten) return { teamWritten: true, ...task.teamWrittenBy ? { teamWrittenBy: structuredClone(task.teamWrittenBy) } : {} }
  return teamWrittenTask(state, task) ? { teamWritten: true, teamWrittenBy: { kind: 'assigned' } } : {}
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
      if (!member || seen.has(id) || onTeamAccount(state, member) || coordinates(state, group, member)) return false
      seen.add(id)
      return true
    })
    return agentIds.length ? [{ conversationId: c.id, agentIds }] : []
  })
}

/**
 * GitHub's record of who pushed [pulls], the pull requests the store read (none for a branch). A bot among them marks [group]
 * and its task. A clean read clears a mark only where it covered everything that mark rests on (#3304): every pull request
 * the task and that conversation record, and for a push's mark the pull requests it was read on. An assignment's mark and a
 * branch's stay. A pull request recorded after the read was not covered, so it clears nothing.
 */
export function applyPushOrigin(state: SuperTabState, group: Conversation, origin: PushOrigin | undefined, pulls: readonly string[] = []): void {
  const task = taskOf(state, group)
  if (origin === 'team') {
    const cause: Cause = pulls.length ? { kind: 'pushed', pulls: [...new Set(pulls)] } : { kind: 'branch' }
    if (task) mark(task, cause)
    mark(group, cause)
    return
  }
  if (origin !== 'clean' || !task?.pullRequestUrls?.length) return
  const read = new Set(pulls.map(url => url.toLowerCase()))
  const covers = (urls: readonly string[]) => urls.every(url => read.has(url.toLowerCase()))
  if (!covers(task.pullRequestUrls)) return
  for (const marked of [task, ...state.conversations.filter(c => c.reviewOf === task.id)]) {
    const by = marked.teamWrittenBy
    if (!marked.teamWritten || (by && (by.kind !== 'pushed' || !covers(by.pulls))) || !covers(marked.pullRequestUrls ?? [])) continue
    delete marked.teamWritten
    delete marked.teamWrittenBy
  }
}

/** [reason]: why GitHub cannot show it, when that is known (repositoryReach.ts unknownPushReason). */
export function failPushUnknown(reason?: string | null): never {
  return fail(TEAM_WRITTEN_WORK, reason ?? 'GitHub could not show who pushed this task\'s code, so it runs only in a Team account for now. Choose an agent in a Team account, or try again in a minute.', 403)
}
