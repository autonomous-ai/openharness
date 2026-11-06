/**
 * The Swarm hands the next task to a free project worker by itself (#3592 extends #3400's crew dispatch). What it decides
 * is here, from the state alone: each task's lane, who is free, what
 * each free member gets, the two clocks and the capacity line. The store's pass (store.ts dispatchCrew) sends each pick
 * through work.assign, whose own write refuses a second assignment.
 */
import { SEED_RULES, type ProjectRules } from './policy.js'
import { isBuddy } from './buddies.js'
import { sessionClosed } from './closedAgents.js'
import { activeWork, handed, occupiesAgent, reviewsWanted, type Agent, type Assignment, type Conversation, type SuperTabState } from './model.js'
import { agentProjectId, onTeamAccount, projectOf, projectsOf } from './projects.js'
import { barredFromTeamWritten } from './teamWritten.js'
import { digestOf, localNow } from './digest.js'
import { DEFAULT_TIME_ZONE } from './costs/reflection.js'
import { queueOrder, queueSiblings } from './taskQueue.js'
import { unavailableReason } from './liveness.js'
import { FAILED, type PullRequestWatch } from './pullRequestEvents.js'
import { modelMatches } from './rules.js'
import { roleNameOf } from './instructions.js'
import { reviewerCandidates } from './reviewerPick.js'
import { stepName } from './steps.js'

const HOUR_MS = 3_600_000

/** A lane of work and the repository paths it owns: the project rules record's `lanes` entry (#3393), the same shape. */
export interface Lane { name: string; owns: readonly string[] }

/** The validated dispatch policy of one project; the default is only for legacy pure callers. */
export interface DispatchRules extends Readonly<ProjectRules['dispatch']> { readonly lanes: readonly Lane[] }
export const dispatchRules = (rules: ProjectRules): DispatchRules => ({ ...rules.dispatch, lanes: rules.lanes })
/** Null holds only this project's configurable clocks and dispatch until its rules can be repaired/read. */
export type DispatchLookup = (projectId: string) => DispatchRules | null
export const DISPATCH_RULES: DispatchRules = Object.freeze(dispatchRules(SEED_RULES))

/** The lane [name] means, matched in any case, as the table writes it; undefined when the table has none by that name. */
export function laneNamed(lanes: readonly Lane[], name: string): string | undefined {
  return lanes.find(lane => lane.name.toLowerCase() === name.trim().toLowerCase())?.name
}

/** Stores [group]'s hand-out lane, when it is a task (not a chat, a step or a private chat), after its paths or lane changed:
 *  readers copy it (read/views.ts groupView), no read computes it. */
export function stampLane(group: Conversation, lanes: readonly Lane[] = DISPATCH_RULES.lanes): void {
  if (group.task && !group.reviewOf && !group.kind && !group.audience) group.handOutLane = laneOf(group, lanes)
  else delete group.handOutLane
}

/** "a, b or c": the lane names as a refusal lists them. */
export function spokenList(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

/** Whether [path] lies under [area]: an area ending in '/' is a folder, any other names one path and what is under it. */
const under = (path: string, area: string): boolean => {
  const folder = area.endsWith('/') ? area : `${area}/`
  return path === area || path.startsWith(folder)
}

/** The lane [group]'s task is handed out in: the one its PM or a person set (work.lane), else the lane owning most of its
 *  owned paths, a tie going to the table's first; null when no lane owns any of them. */
export function laneOf(group: Pick<Conversation, 'lane' | 'task'>, lanes: readonly Lane[]): string | null {
  if (group.lane) return laneNamed(lanes, group.lane) ?? null
  let best: string | null = null, most = 0
  for (const lane of lanes) {
    const count = (group.task?.owns ?? []).filter(path => lane.owns.some(area => under(path.replace(/^\.?\//, ''), area))).length
    if (count > most) { best = lane.name; most = count }
  }
  return best
}

/** Configured time in a progress notice, without rounding a project's threshold. */
const duration = (ms: number): string => {
  const [value, unit] = ms % HOUR_MS === 0 ? [ms / HOUR_MS, 'hour'] : ms % 60_000 === 0 ? [ms / 60_000, 'minute'] : [ms / 1000, 'second']
  return `${value} ${unit}${value === 1 ? '' : 's'}`
}
export const returnReason = (lane: string | null, rules: DispatchRules = DISPATCH_RULES): string =>
  `no progress for ${duration(rules.returnAfterMs)}: back in the ${lane ?? 'project'} lane`

export const nudgeLine = (lane: string | null, rules: DispatchRules = DISPATCH_RULES): string =>
  `No progress on this task for ${duration(rules.nudgeAfterMs)}. Post where it stands, or set it blocked with why; at ${duration(rules.returnAfterMs)} it goes back to the ${lane ?? 'project'} lane.`

/** The progress clocks on [assignment] of [group], held by any project worker (liveness.ts): from its own last progress
 *  (its assignment, status, check or post: `progressAt`), only while working. `nudge` after `nudgeAfterMs`, once
 *  per spell of quiet; `return` after `returnAfterMs`. Waiting on a person, blocked or handed: no clock. */
export function crewClock(_group: Conversation, _worker: Agent, assignment: Assignment, now: number, rules: DispatchRules): 'nudge' | 'return' | null {
  const since = assignment.progressAt
  if (assignment.status !== 'working' || since === undefined) return null
  if (now - since >= rules.returnAfterMs) return 'return'
  return now - since >= rules.nudgeAfterMs && !(assignment.nudgedAt !== undefined && assignment.nudgedAt >= since) ? 'nudge' : null
}

/** Moving off a failing machine (task #3398, crewMove.ts): work.assign refuses it until the move lands. Read without a type
 *  until #3398 declares it, as #3397 does. */
const moving = (agent: Agent): boolean => !!(agent as { movedTo?: unknown }).movedTo
/** Asleep (task #3398, crewSleep.ts): its session closed on purpose; work.assign wakes it in the same write. */
const asleep = (agent: Agent): boolean => !!(agent as { asleep?: unknown }).asleep

/** The workers of [projectId] free for a task (the name is kept for callers): not its PM, not a Buddy, not stopping or moving, a session not
 *  closed unless asleep, no launch still pending) with nothing in their hands and fewer than `maxHanded` handed tasks;
 *  fewest handed first, then as the roster lists them. */
export function freeCrew(state: SuperTabState, projectId: string, rules: DispatchRules, now: number): Agent[] {
  const leads = new Set(state.conversations.flatMap(c => c.leadId ? [c.leadId] : []))
  const handedBy = new Map<string, number>(), busy = new Set<string>()
  for (const group of state.conversations) {
    const holder = group.assignment?.agentId
    if (!holder) continue
    if (occupiesAgent(group)) busy.add(holder)
    else if (activeWork(group) && handed(group)) handedBy.set(holder, (handedBy.get(holder) ?? 0) + 1)
  }
  // A PM in a Harness Team account assigns only agents of its own machine or another Team account (store.ts teamCommand,
  // security review 2 of #2089): the main account stays out of its reach.
  const leadId = state.conversations.find(c => c.id === projectOf(state, projectId).leadConversationId)?.leadId
  const lead = leadId ? state.agents.find(a => a.id === leadId) : undefined
  const reachable = (agent: Agent) => !lead || !onTeamAccount(state, lead) || agent.machineId === lead.machineId || onTeamAccount(state, agent)
  const launching = (agent: Agent) => !!state.starts?.some(s => !s.poolSettled && s.poolGeneration && s.request.machineId === agent.machineId && s.harnessId === agent.harnessId)
  return state.agents
    .filter(agent => agentProjectId(state, agent) === projectId && !leads.has(agent.id) && !isBuddy(agent)
      && agent.workDecision !== 'stop' && !moving(agent) && (asleep(agent) || !sessionClosed(state, agent, now)) && !launching(agent)
      && !busy.has(agent.id) && (handedBy.get(agent.id) ?? 0) < rules.maxHanded && reachable(agent)
      // A member its machine or engine cannot serve now would lose the task at once (liveness.ts): until that clears.
      && !unavailableReason(state, agent, now, asleep(agent)))
    .map((agent, at) => ({ agent, at, handed: handedBy.get(agent.id) ?? 0 }))
    .sort((a, b) => a.handed - b.handed || a.at - b.at)
    .map(entry => entry.agent)
}

/** The open tasks of [projectId] a worker may be handed, plus lost review/test steps whose build is still active: never a
 *  chat or private chat. A brief, no active work, not finished, whose not-before day has come; P0 first, then the
 *  project's Next up. */
export function openTasks(state: SuperTabState, projectId: string, now: number): Conversation[] {
  const project = projectOf(state, projectId)
  // The day people meant: the project's own (its digest's time zone), Vietnam's without one, as the PM schedule reads it.
  const today = localNow(digestOf(project)?.timeZone ?? DEFAULT_TIME_ZONE, now).date
  const lostSteps = state.conversations.filter(group => {
    if (group.archived || group.kind || group.audience || !group.reviewOf || group.assignment?.status !== 'lost' || (group.projectId ?? 'lead') !== projectId) return false
    const task = state.conversations.find(g => g.id === group.reviewOf)
    return !!task && !task.archived && (task.projectId ?? 'lead') === projectId && activeWork(task)
  })
  const open = [...queueSiblings(state, project), ...lostSteps].filter(group => (group.task || group.brief.trim())
    && !activeWork(group) && !['done', 'cancelled'].includes(group.assignment?.status ?? '') && !(group.notBefore && group.notBefore > today))
  const ordered = queueOrder(open)
  return [...ordered.filter(g => g.priority === 'P0'), ...ordered.filter(g => g.priority !== 'P0')]
}

/** The lanes an Engineer takes: its crew lane or last known task area, otherwise any project area. */
function takes(state: SuperTabState, member: Agent, rules: DispatchRules): (lane: string | null) => boolean {
  if (!/^(engineer|builder)$/i.test((member.crew?.role ?? roleNameOf(state, member)).trim())) return () => false
  // Ordinary workers have no crew lane: retain the area of their last task when the server knows it.
  const previous = member.crew ? undefined : state.conversations.findLast(g => g.task && !g.reviewOf && g.assignment?.agentId === member.id)
  const own = member.crew?.lane ?? (previous ? laneOf(previous, rules.lanes) : null)
  return own ? lane => lane !== null && laneNamed(rules.lanes, own) === lane : () => true
}

/** Whether [group] is big, hard or risky work, which Routing puts on Opus or Astra: the PM marked it strong, or it wants two reviews
 *  and the PM did not mark it standard (#3576). */
const needsStrongModel = (group: Conversation): boolean => group.task?.strength === 'strong' || (group.task?.strength === undefined && reviewsWanted(group.task) === 2)
/** Whether [member] runs a model Routing allows for big or risky work: Opus at high effort or above, or Astra at xhigh (an effort
 *  not set is not known to be either). */
const onStrongModel = (member: Agent): boolean => {
  const effort = (member.configuration.effort ?? '').toLowerCase(), model = member.configuration.model
  return (modelMatches('opus', model) && ['high', 'xhigh', 'max'].includes(effort)) || (modelMatches('astra', model) && ['xhigh', 'max'].includes(effort))
}

/** The tasks [member] could be handed now, best first: those pinned to it (oldest pin first), then its lane's open tasks.
 *  A task it just lost to the 3-hour clock is not offered to it. */
export function candidatesFor(state: SuperTabState, member: Agent, rules: DispatchRules, now: number, open = openTasks(state, agentProjectId(state, member)!, now),
  skip: Skip = () => false) {
  const lostByIt = (group: Conversation) => group.lostAttempt?.agentId === member.id && group.assignment?.status === 'lost'
  const pinned = open.filter(g => pinOf(g)?.agentId === member.id).sort((a, b) => pinOf(a)!.at - pinOf(b)!.at)
  const members = new Set(state.agents.filter(a => a.workDecision !== 'stop' && !moving(a)).map(a => a.id))
  const acceptsLane = takes(state, member, rules)
  const steps = open.filter(g => g.reviewOf && !lostByIt(g)).filter(step => {
    const task = state.conversations.find(g => g.id === step.reviewOf)!
    const kind = /test/i.test(stepName(step)) ? 'test' : /security/i.test(stepName(step)) ? 'security' : 'review'
    const latest = task.pullRequestUrls?.at(-1)
    const head = latest ? task.pullRequestHeads?.[latest]?.head ?? null : null
    return reviewerCandidates(state, task, kind, head, now).some(a => a.id === member.id)
  })
  const lane = open.filter(g => (!g.lane || !!laneNamed(rules.lanes, g.lane)) && !g.reviewOf && !pinned.includes(g) && !(pinOf(g) && members.has(pinOf(g)!.agentId)) && !lostByIt(g)
    // Ordinary workers recover work; new tasks still need the PM's route or a standing crew lane.
    && (member.crew || (g.assignment?.status === 'lost' && g.lostAttempt))
    && acceptsLane(laneOf(g, rules.lanes)) && (!needsStrongModel(g) || onStrongModel(member)))
  // Team-written code goes to Team accounts only (teamWritten.ts); a pick refused this round is not sent again (store.ts).
  const allowed = (group: Conversation) => (!group.reviewOf || steps.includes(group)) && !barredFromTeamWritten(state, group, member) && !skip(group.id, member.id)
  return [...pinned.filter(allowed).map(group => ({ group, why: 'pin' as const })),
    ...[...steps.filter(g => !pinned.includes(g)), ...lane].filter(allowed).map(group => ({ group, why: 'lane' as const }))]
}

/** A pin never sends a lost task straight back to the failed agent; another free worker takes it. */
const pinOf = (group: Conversation): Conversation['pin'] =>
  group.pin && !(group.assignment?.status === 'lost' && group.lostAttempt?.agentId === group.pin.agentId) ? group.pin : undefined

/** A pick the caller leaves out: one whose work.assign was refused this round (store.ts dispatchCrew). */
export type Skip = (conversationId: string, agentId: string) => boolean

/** The round a task is in, for its dispatch's operation id and refusal memory: its last assignment's, kept across a
 *  redefinition (its run ledger), so a new round never replays the last one's receipt. */
export const roundOf = (group: Conversation): string => group.ledger?.runs?.at(-1)?.assignmentId ?? group.assignment?.id ?? 'first'

/** One assignment the dispatch makes. */
export interface DispatchPick { conversationId: string; agentId: string; why: 'pin' | 'lane'; lane: string | null }

/** What each free worker of [projectId] gets in one pass: its first candidate no other worker took first. Nothing while
 *  the Swarm is paused. */
export function dispatchPlan(state: SuperTabState, projectId: string, rules: DispatchRules, now: number, skip: Skip = () => false): DispatchPick[] {
  if (state.paused) return []
  const open = openTasks(state, projectId, now), taken = new Set<string>(), picks: DispatchPick[] = []
  for (const member of freeCrew(state, projectId, rules, now)) {
    const next = candidatesFor(state, member, rules, now, open, skip).find(c => !taken.has(c.group.id))
    if (!next) continue
    taken.add(next.group.id)
    picks.push({ conversationId: next.group.id, agentId: member.id, why: next.why, lane: laneOf(next.group, rules.lanes) })
  }
  return picks
}

/** One lane's line of the capacity read: its waiting tasks (open, nobody's, in hand-out order), how many of its tasks are in
 *  someone's hands, and since when the longest-waiting one has waited (null when no wait was recorded). */
export interface LaneCapacity { lane: string; waiting: number; busy: number; oldestAt: number | null }

/** When [group] began waiting with nobody holding it: as its liveness recorded, else when its last attempt was lost. */
const waitingSince = (group: Conversation): number | undefined =>
  group.liveness?.state === 'orphaned' ? group.liveness.since : group.assignment?.lost?.at

/** [projectId]'s lanes as the dispatch sees them, in the table's order, each with work waiting or in hand. A time, not an age,
 *  so the read's summary does not move as the clock does (read/derivedEtag.ts). */
export function laneCapacity(state: SuperTabState, projectId: string, rules: DispatchRules, now = Date.now()): LaneCapacity[] {
  const open = openTasks(state, projectId, now)
  const project = projectOf(state, projectId)
  const busy = queueSiblings(state, project).filter(occupiesAgent)
  return rules.lanes.flatMap(({ name }) => {
    const waiting = open.filter(g => laneOf(g, rules.lanes) === name)
    const inHand = busy.filter(g => laneOf(g, rules.lanes) === name).length
    if (!waiting.length && !inHand) return []
    const since = waiting.map(waitingSince).filter((t): t is number => t !== undefined)
    return [{ lane: name, waiting: waiting.length, busy: inHand, oldestAt: since.length ? Math.min(...since) : null }]
  })
}

/** "Desktop: 6 waiting, 2 busy, oldest 2 h" (under an hour in minutes; no oldest when none was recorded). */
export function capacityLine(c: LaneCapacity, now: number): string {
  const age = c.oldestAt === null ? null : Math.max(0, now - c.oldestAt)
  const oldest = age === null ? '' : age >= HOUR_MS ? `, oldest ${Math.floor(age / HOUR_MS)} h` : `, oldest ${Math.floor(age / 60_000)} min`
  return `${c.lane}: ${c.waiting} waiting, ${c.busy} busy${oldest}`
}

/** What [watch] says its task's builder should come back for: a merge conflict, or a failed check run at its head. */
export function pullRequestPin(watch: Pick<PullRequestWatch, 'mergeable' | 'checkRuns'>): 'ci' | 'conflict' | null {
  if (watch.mergeable === false) return 'conflict'
  return watch.checkRuns.some(run => !!run.conclusion && FAILED.has(run.conclusion)) ? 'ci' : null
}

/** Pins [group], a task with no active work, to its last attempt's agent for [why]: the dispatch hands it to that member
 *  first, while it is available (candidatesFor). A pin already there keeps its time; active work is never pinned. */
export function pinBuilder(group: Conversation, why: NonNullable<Conversation['pin']>['why'], now: number): void {
  // Its last round's agent: a stopped round's, not an older lost one's.
  const builder = group.assignment?.agentId ?? group.lostAttempt?.agentId
  if (!builder || activeWork(group) || group.pin) return
  group.pin = { agentId: builder, why, at: now }
}
