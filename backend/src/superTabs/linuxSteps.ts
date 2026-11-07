/**
 * A Linux test step waits for a Linux machine (task #4278). Since v3 (#4120) a Tester starts only on its own person's
 * computer and a Team account takes no work, so harness's Linux steps had nobody who could take them, yet every new head
 * opened one and the PM closed it by hand (#4204, #4215, #4216, #4217, #4252, #4259 on 11-07). A Ready now opens one only
 * where the project can test on Linux; otherwise CI's Linux unit checks stand in, the task says so once, and the time checks
 * open the step once such a machine is there. Mac and Windows steps open as before (the task's constraint).
 */
import { agentDisplayName } from './agentNames.js'
import { isBuddy } from './buddies.js'
import { machineOffline, machineProjectRefusal, swarmMachines } from './machines.js'
import { activeWork, stableId, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, onTeamAccount, teamAccountPool, type SwarmProject } from './projects.js'
import { reportsOs, type PlannedStep } from './reviewTable.js'
import { openReviewStep, type StepPull } from './stepOpen.js'
import { stepName, stepsOf } from './steps.js'

/** What the task says while its Linux step waits. */
export const LINUX_WAIT_LINE = 'No Linux machine: CI\'s Linux runs stand in.'

/** A task's Linux test step that waits for a Linux machine, with the pull requests its brief names (no history: the brief
 *  says it is unknown). One per task, replaced at each Ready, gone once the step opens. */
export interface WaitingStep { step: PlannedStep; pulls: StepPull[] }

const coordinatorOf = (state: SuperTabState, project: SwarmProject) =>
  state.agents.find(a => a.id === state.conversations.find(c => c.id === project.leadConversationId)?.leadId)

/**
 * Whether [project] can test on Linux at [now]: an own-account machine reports Linux, online, not paused or being removed,
 * open to the project, and a Tester can get there: it is the PM's own person's computer, where the PM may start one, or an
 * own-account agent of the project runs there as that machine's person.
 */
export function testsOnLinux(state: SuperTabState, project: SwarmProject, now: number): boolean {
  const pm = coordinatorOf(state, project)
  return swarmMachines(state).some(pool => reportsOs(pool.observation?.resources?.os, 'linux') && !machineOffline(pool, now) && !pool.paused
    && !pool.removal && !teamAccountPool(pool) && !machineProjectRefusal(state, pool.machineId, project)
    && (pool.contributorId === pm?.contributorId || state.agents.some(a => a.machineId === pool.machineId && a.contributorId === pool.contributorId
      && !isBuddy(a) && a.workDecision !== 'stop' && !onTeamAccount(state, a) && agentProjectId(state, a) === project.id)))
}

/** Records [step] of [task] as waiting for a Linux machine, briefed on [pulls]; true when it was not waiting yet, so the
 *  task is told once. */
export function waitForLinux(task: Conversation, step: PlannedStep, pulls: readonly StepPull[]): boolean {
  const first = !task.waitingLinuxStep
  task.waitingLinuxStep = { step, pulls: pulls.map(({ url, head, base }) => ({ url, head, ...base ? { base } : {} })) }
  return first
}

/**
 * The time checks' pass (store.ts runTimeChecks): each open task's waiting Linux step opens once its project can test on
 * Linux, and the PM hears it in the task, to give it a Tester there. Written as the PM; a project with none keeps waiting.
 */
export function openWaitingSteps(state: SuperTabState, now: number): MessageDraft[] {
  const waiting = state.conversations.filter(task => task.waitingLinuxStep && !task.archived && activeWork(task))
  const can = new Map<string, boolean>()
  const linux = (project: SwarmProject) => can.get(project.id) ?? can.set(project.id, testsOnLinux(state, project, now)).get(project.id)!
  return waiting.flatMap(task => {
    const project = groupProject(state, task), pm = coordinatorOf(state, project)
    if (!pm || !linux(project)) return []
    const { step, pulls } = task.waitingLinuxStep!
    delete task.waitingLinuxStep
    // One its PM opened by hand meanwhile is that step.
    if (stepsOf(state, task.id).some(s => !s.archived && stepName(s) === step.name)) return []
    const author: Author = { kind: 'agent', id: pm.id, name: pm.name, displayName: agentDisplayName(state.agents, pm.id), membershipGeneration: pm.membershipGeneration }
    const id = stableId(task.id, 'linux-step', ...pulls.map(pull => pull.head ?? ''))
    const { brief } = openReviewStep(state, task, step, pulls, id, author)
    return [brief, { id: stableId(id, 'told'), conversationId: task.id, author, replyTo: null, recipients: [pm.id], source: { kind: 'system' },
      text: `${step.name} of #${task.number} is open: a Linux machine is here now. Give it a Tester there.` }]
  })
}
