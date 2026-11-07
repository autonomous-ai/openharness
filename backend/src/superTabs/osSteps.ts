/**
 * A Linux or Windows test step waits for a machine of its OS (tasks #4278, #4410). Since v3 (#4120) a Tester starts only on
 * its own person's computer and a Team account takes no work, so harness's Linux steps had nobody who could take them, yet
 * every new head opened one and the PM closed it by hand (#4204, #4215, #4216, #4217, #4252, #4259 on 11-07); Windows steps
 * then did the same, and #3362 makes them more common. A Ready now opens one only where the project can test on that OS.
 * Otherwise the task says so once: for Linux, CI's Linux unit checks stand in; for Windows nothing does, and a person's check
 * is owed (docs/windows-rules.md). The time checks open the step once such a machine is there. Mac steps open as before.
 */
import { agentDisplayName } from './agentNames.js'
import { isBuddy } from './buddies.js'
import { machineOffline, machineProjectRefusal, swarmMachines } from './machines.js'
import { activeWork, stableId, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, onTeamAccount, teamAccountPool, type SwarmProject } from './projects.js'
import { OS_PLACE, reportsOs, type PlannedStep, type StepOs } from './reviewTable.js'
import { openReviewStep, type StepPull } from './stepOpen.js'
import { stepName, stepsOf } from './steps.js'

/** The OSes whose test step waits for a machine of its own. */
export type WaitingOs = 'linux' | 'windows'
export const waits = (os: StepOs | undefined): os is WaitingOs => os === 'linux' || os === 'windows'

/** What the task says while its step of each OS waits. */
export const WAIT_LINE: Record<WaitingOs, string> = {
  linux: 'No Linux machine: CI\'s Linux runs stand in.',
  windows: 'No Windows machine: a person\'s Windows check is owed.',
}

/** A task's test step that waits for a machine of its OS, with the pull requests its brief names (no history: the brief says
 *  it is unknown). One per OS and task, replaced at each Ready, gone once the step opens. */
export interface WaitingStep { step: PlannedStep; pulls: StepPull[] }

/** Where a task keeps its waiting step of each OS: Linux's as #4278 stored it. */
const FIELD = { linux: 'waitingLinuxStep', windows: 'waitingWindowsStep' } as const satisfies Record<WaitingOs, keyof Conversation>

const coordinatorOf = (state: SuperTabState, project: SwarmProject) =>
  state.agents.find(a => a.id === state.conversations.find(c => c.id === project.leadConversationId)?.leadId)

/**
 * Whether [project] can test on [os] at [now]: an own-account machine reports [os], online, not paused or being removed, open
 * to the project, and a Tester can get there: it is the PM's own person's computer, where the PM may start one, or an
 * own-account agent of the project runs there as that machine's person.
 */
export function testsOn(state: SuperTabState, project: SwarmProject, now: number, os: WaitingOs): boolean {
  const pm = coordinatorOf(state, project)
  return swarmMachines(state).some(pool => reportsOs(pool.observation?.resources?.os, os) && !machineOffline(pool, now) && !pool.paused
    && !pool.removal && !teamAccountPool(pool) && !machineProjectRefusal(state, pool.machineId, project)
    && (pool.contributorId === pm?.contributorId || state.agents.some(a => a.machineId === pool.machineId && a.contributorId === pool.contributorId
      && !isBuddy(a) && a.workDecision !== 'stop' && !onTeamAccount(state, a) && agentProjectId(state, a) === project.id)))
}

/** Records [step] of [task], of a waiting OS, as waiting for a machine of it, briefed on [pulls]; true when it was not waiting
 *  yet, so the task is told once. */
export function waitFor(task: Conversation, step: PlannedStep & { os: WaitingOs }, pulls: readonly StepPull[]): boolean {
  const first = !task[FIELD[step.os]]
  task[FIELD[step.os]] = { step, pulls: pulls.map(({ url, head, base }) => ({ url, head, ...base ? { base } : {} })) }
  return first
}

/** [task]'s step of [os] waits no more: it opens now. */
export function stopWaiting(task: Conversation, os: WaitingOs): void {
  delete task[FIELD[os]]
}

/**
 * The time checks' pass (store.ts runTimeChecks): each open task's waiting step of each OS opens once its project can test on
 * that OS, and the PM hears it in the task, to give it a Tester there. Written as the PM; a project with none keeps waiting.
 */
export function openWaitingSteps(state: SuperTabState, now: number): MessageDraft[] {
  const can = new Map<string, boolean>()
  const able = (project: SwarmProject, os: WaitingOs) => {
    const key = `${os}:${project.id}`
    return can.get(key) ?? can.set(key, testsOn(state, project, now, os)).get(key)!
  }
  return state.conversations.filter(task => !task.archived && activeWork(task)).flatMap(task => (Object.keys(FIELD) as WaitingOs[]).flatMap(os => {
    const waiting = task[FIELD[os]]
    if (!waiting) return []
    const project = groupProject(state, task), pm = coordinatorOf(state, project)
    if (!pm || !able(project, os)) return []
    const { step, pulls } = waiting
    stopWaiting(task, os)
    // One its PM opened by hand meanwhile is that step.
    if (stepsOf(state, task.id).some(s => !s.archived && stepName(s) === step.name)) return []
    const author: Author = { kind: 'agent', id: pm.id, name: pm.name, displayName: agentDisplayName(state.agents, pm.id), membershipGeneration: pm.membershipGeneration }
    const id = stableId(task.id, `${os}-step`, ...pulls.map(pull => pull.head ?? ''))
    const { brief } = openReviewStep(state, task, step, pulls, id, author)
    return [brief, { id: stableId(id, 'told'), conversationId: task.id, author, replyTo: null, recipients: [pm.id], source: { kind: 'system' as const },
      text: `${step.name} of #${task.number} is open: ${OS_PLACE[os]} is here now. Give it a Tester there.` }]
  }))
}
