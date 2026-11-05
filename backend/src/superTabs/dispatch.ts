/**
 * The Swarm hands the next task to a free crew member by itself (task #3400, anh Dee's Swarm redesign, 2026-11-05: the
 * server does the routine). What it decides is here, from the state alone: each task's lane, who of the crew is free, what
 * each free member gets, the two clocks and the capacity line. The store's pass (store.ts dispatchCrew) sends each pick
 * through work.assign, whose own write refuses a second assignment.
 */
import { isBuddy } from './buddies.js'
import { sessionClosed } from './closedAgents.js'
import { activeWork, type Agent, type Assignment, type Conversation, type SuperTabState } from './model.js'
import { agentProjectId, projectOf, projectsOf } from './projects.js'
import { queueOrder, queueSiblings } from './taskQueue.js'
import { FAILED, type PullRequestWatch } from './pullRequestEvents.js'

const HOUR_MS = 3_600_000

/** A lane of work and the repository paths it owns: the project rules record's `lanes` entry (#3393), the same shape. */
export interface Lane { name: string; owns: readonly string[] }

/** The numbers of the dispatch, in one place until the project rules record (#3393) holds them. */
export const DISPATCH_RULES = Object.freeze({
  /** How often the worker's pass runs; commits that free a member or open a task run it at once too. */
  everyMs: 30_000,
  /** A member with this many handed tasks (ready for review, still its own) takes no new one. */
  maxHanded: 3,
  /** Without progress this long, the member is told once. */
  nudgeAfterMs: 2 * HOUR_MS,
  /** Without progress this long, the task goes back to its lane. */
  returnAfterMs: 3 * HOUR_MS,
  lanes: Object.freeze([
    { name: 'backend', owns: ['backend/'] },
    { name: 'CLI', owns: ['cli/'] },
    { name: 'Desktop', owns: ['desktop/'] },
    { name: 'mobile', owns: ['mobile/'] },
    { name: 'docs', owns: ['docs/'] },
  ] as readonly Lane[]),
})
export type DispatchRules = typeof DISPATCH_RULES

/** The lane [name] means, matched in any case, as the table writes it; undefined when the table has none by that name. */
export function laneNamed(lanes: readonly Lane[], name: string): string | undefined {
  return lanes.find(lane => lane.name.toLowerCase() === name.trim().toLowerCase())?.name
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
  if (group.lane) return laneNamed(lanes, group.lane) ?? group.lane
  let best: string | null = null, most = 0
  for (const lane of lanes) {
    const count = (group.task?.owns ?? []).filter(path => lane.owns.some(area => under(path.replace(/^\.?\//, ''), area))).length
    if (count > most) { best = lane.name; most = count }
  }
  return best
}

/** The reason the 3-hour clock gives a task it puts back in its lane (liveness.ts); the dispatch reads it to keep that task
 *  from its last member for one pass. */
export const returnReason = (lane: string | null): string => `no progress for 3 hours: back in the ${lane ?? 'project'} lane`
const RETURN_PREFIX = 'no progress for 3 hours'

/** What a crew member hears after 2 hours without progress on its task. */
export const nudgeLine = (lane: string | null): string =>
  `No progress on this task for 2 hours. Post where it stands, or set it blocked with why; at 3 hours it goes back to the ${lane ?? 'project'} lane.`

/** The crew's clocks on [assignment] of [group], held by [worker] (liveness.ts): from its own last progress (its assignment,
 *  status, check or post: `progressAt`), only while a crew member is working on a task. `nudge` after `nudgeAfterMs`, once
 *  per spell of quiet; `return` after `returnAfterMs`. Waiting on a person, blocked or handed: no clock. */
export function crewClock(group: Conversation, worker: Agent, assignment: Assignment, now: number, rules: DispatchRules): 'nudge' | 'return' | null {
  const since = assignment.progressAt
  if (!worker.crew || group.reviewOf || assignment.status !== 'working' || since === undefined) return null
  if (now - since >= rules.returnAfterMs) return 'return'
  return now - since >= rules.nudgeAfterMs && !(assignment.nudgedAt !== undefined && assignment.nudgedAt >= since) ? 'nudge' : null
}

/** A task its own Engineer handed over: ready for review (its own `review` status), still its own, its Engineer free for the
 *  next (task #3399, handed.ts; until that lands, the same rule here). A step's review status is not a hand-over. */
export const handed = (group: Conversation): boolean => !group.reviewOf && group.assignment?.status === 'review'
/** Active work in its agent's hands: open and not handed (#3399 handed.ts occupiesAgent). */
export const occupiesAgent = (group: Conversation): boolean => activeWork(group) && !handed(group)

/** Moving off a failing machine (task #3398, crewMove.ts): work.assign refuses it until the move lands. Read without a type
 *  until #3398 declares it, as #3397 does. */
const moving = (agent: Agent): boolean => !!(agent as { movedTo?: unknown }).movedTo
/** Asleep (task #3398, crewSleep.ts): its session closed on purpose; work.assign wakes it in the same write. */
const asleep = (agent: Agent): boolean => !!(agent as { asleep?: unknown }).asleep

/** The crew of [projectId] free for a task: crew members (not its PM, not a Buddy, not stopping or moving, a session not
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
  const launching = (agent: Agent) => !!state.starts?.some(s => !s.poolSettled && s.poolGeneration && s.request.machineId === agent.machineId && s.harnessId === agent.harnessId)
  return state.agents
    .filter(agent => !!agent.crew && agentProjectId(state, agent) === projectId && !leads.has(agent.id) && !isBuddy(agent)
      && agent.workDecision !== 'stop' && !moving(agent) && (asleep(agent) || !sessionClosed(state, agent, now)) && !launching(agent)
      && !busy.has(agent.id) && (handedBy.get(agent.id) ?? 0) < rules.maxHanded)
    .map((agent, at) => ({ agent, at, handed: handedBy.get(agent.id) ?? 0 }))
    .sort((a, b) => a.handed - b.handed || a.at - b.at)
    .map(entry => entry.agent)
}

/** The open tasks of [projectId] a member may be handed, in the order they go out: a task (not its chat, a Buddy chat, a
 *  private chat or a step) with a brief, no active work, not finished, whose not-before day has come; P0 first, then the
 *  project's Next up. */
export function openTasks(state: SuperTabState, projectId: string, now: number): Conversation[] {
  const today = new Date(now).toISOString().slice(0, 10)
  const open = queueSiblings(state, projectOf(state, projectId)).filter(group => (group.task || group.brief.trim())
    && !activeWork(group) && !['done', 'cancelled'].includes(group.assignment?.status ?? '') && !(group.notBefore && group.notBefore > today))
  const ordered = queueOrder(open)
  return [...ordered.filter(g => g.priority === 'P0'), ...ordered.filter(g => g.priority !== 'P0')]
}

/** Whether [member] takes work in [lane]: its own lane, or any for a crew Engineer with none. */
function takes(member: Agent, lane: string | null, rules: DispatchRules): boolean {
  const own = member.crew?.lane
  if (own) return lane !== null && laneNamed(rules.lanes, own) === lane
  return /^engineer$/i.test(member.crew?.role.trim() ?? '')
}

/** The tasks [member] could be handed now, best first: those pinned to it (oldest pin first), then its lane's open tasks.
 *  A task it just lost to the 3-hour clock is not offered to it. */
export function candidatesFor(state: SuperTabState, member: Agent, rules: DispatchRules, now: number, open = openTasks(state, agentProjectId(state, member)!, now)) {
  const lostByIt = (group: Conversation) => group.lostAttempt?.agentId === member.id && group.assignment?.status === 'lost'
    && !!group.assignment.lost?.reason.startsWith(RETURN_PREFIX)
  const pinned = open.filter(g => g.pin?.agentId === member.id).sort((a, b) => a.pin!.at - b.pin!.at)
  const crewIds = new Set(state.agents.filter(a => a.crew).map(a => a.id))
  const lane = open.filter(g => !pinned.includes(g) && !(g.pin && crewIds.has(g.pin.agentId)) && !lostByIt(g)
    && takes(member, laneOf(g, rules.lanes), rules))
  return [...pinned.map(group => ({ group, why: 'pin' as const })), ...lane.map(group => ({ group, why: 'lane' as const }))]
}

/** One assignment the dispatch makes. */
export interface DispatchPick { conversationId: string; agentId: string; why: 'pin' | 'lane'; lane: string | null }

/** What each free crew member of [projectId] gets in one pass: its first candidate no other member took first. Nothing while
 *  the Swarm is paused. */
export function dispatchPlan(state: SuperTabState, projectId: string, rules: DispatchRules, now: number): DispatchPick[] {
  if (state.paused) return []
  const open = openTasks(state, projectId, now), taken = new Set<string>(), picks: DispatchPick[] = []
  for (const member of freeCrew(state, projectId, rules, now)) {
    const next = candidatesFor(state, member, rules, now, open).find(c => !taken.has(c.group.id))
    if (!next) continue
    taken.add(next.group.id)
    picks.push({ conversationId: next.group.id, agentId: member.id, why: next.why, lane: laneOf(next.group, rules.lanes) })
  }
  return picks
}

/** One lane's line of the capacity read: its waiting tasks (open, nobody's, in hand-out order), how many of its tasks are in
 *  someone's hands, and since when the longest-waiting one has waited (null when no wait was recorded). */
export interface LaneCapacity { lane: string; waiting: number; busy: number; oldestAt: number | null; taskIds: string[] }

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
    return [{ lane: name, waiting: waiting.length, busy: inHand, oldestAt: since.length ? Math.min(...since) : null, taskIds: waiting.map(g => g.id) }]
  })
}

/** "Desktop: 6 waiting, 2 busy, oldest 2 h" (under an hour in minutes; no oldest when none was recorded). */
export function capacityLine(c: LaneCapacity, now: number): string {
  const age = c.oldestAt === null ? null : Math.max(0, now - c.oldestAt)
  const oldest = age === null ? '' : age >= HOUR_MS ? `, oldest ${Math.floor(age / HOUR_MS)} h` : `, oldest ${Math.floor(age / 60_000)} min`
  return `${c.lane}: ${c.waiting} waiting, ${c.busy} busy${oldest}`
}

/** The read's `derived.lanes`: each project [visible] (the reader's view) shows that has a crew, by project id; undefined when
 *  none has. */
export function derivedLanes(state: SuperTabState, visible: SuperTabState, now = Date.now()): Record<string, LaneCapacity[]> | undefined {
  const crewed = new Set(state.agents.filter(a => a.crew).map(a => agentProjectId(state, a)))
  const lanes = projectsOf(visible).filter(p => crewed.has(p.id)).map(p => [p.id, laneCapacity(state, p.id, DISPATCH_RULES, now)] as const)
  return lanes.length ? Object.fromEntries(lanes) : undefined
}

/** What [watch] says its task's builder should come back for: a merge conflict, or a failed check run at its head. */
export function pullRequestPin(watch: Pick<PullRequestWatch, 'mergeable' | 'checkRuns'>): 'ci' | 'conflict' | null {
  if (watch.mergeable === false) return 'conflict'
  return watch.checkRuns.some(run => !!run.conclusion && FAILED.has(run.conclusion)) ? 'ci' : null
}

/** Pins [group], a task with no active work, to its last attempt's agent for [why]: the dispatch hands it to that member
 *  first, while it is in the crew (candidatesFor). A pin already there keeps its time; active work is never pinned. */
export function pinBuilder(group: Conversation, why: NonNullable<Conversation['pin']>['why'], now: number): void {
  const builder = group.lostAttempt?.agentId ?? group.assignment?.agentId
  if (!builder || activeWork(group) || group.pin) return
  group.pin = { agentId: builder, why, at: now }
}
