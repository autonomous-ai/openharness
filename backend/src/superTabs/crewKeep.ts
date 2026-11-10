/**
 * The crew keeper (task #3398): what the Swarm does for its crew members on its own, decided from the state alone so it can
 * be tested with fake machines. A crew member idle an hour sleeps; one whose machine fails moves to the best fallback in the
 * route's order (project instructions, Order and quota); folders of long-asleep members, and of asleep members on a machine
 * short of disk, are dropped. The numbers are in crewRules.ts. Nothing applies the actions since Swarm v4 (anh Dee, 2026-11-09: the
 * server runs no v3 job on its own): this module goes with the crew (slice S14).
 */
import { machineRuleRefusal } from './machineRules.js'
import type { MachineRule } from './policy.js'
import { activeWork, actorKey, stableId, type Agent, type AgentStart, type AgentStartRequest, type CrewTrouble, type MessageDraft, type SuperTabState } from './model.js'
import { isBuddy } from './buddies.js'
import { isCrew } from './crew.js'
import { roleNameOf } from './instructions.js'
import { AGENT_MEMORY_BYTES, projectFolder, type ContributedMachine } from './machines.js'
import { agentProjectId, groupProject, projectsOf } from './projects.js'
import { placeAfter, queueSiblings } from './taskQueue.js'
import { groupsOf, idleSince } from './tidy.js'
import { DISK_FLOOR_BYTES, FOLDER_ASLEEP_MS, HELD_TASK_MS, MOVE_LOW_DISK_BYTES, MOVE_OFFLINE_MS, MOVE_QUOTA_OUT_MS, MOVE_REFUSED_WAIT_MS, QUOTA_FLOOR_PERCENT, QUOTA_FLOOR_PM_PERCENT, SLEEP_IDLE_MS, UNSTABLE_STOPS, UNSTABLE_WINDOW_MS } from './crewRules.js'

/** The engine's quota reading for [pool]. */
const quotaOf = (pool: ContributedMachine, engine: string) => pool.observation?.quotas.find(q => q.engine === engine)

function resetMs(value: string | number | null): number | null {
  if (typeof value === 'number') return value > 1e10 ? value : value * 1000
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null }
  return null
}

export type CrewAction =
  | { kind: 'sleep'; agentId: string }
  | { kind: 'move'; agentId: string; toMachineId: string; reason: CrewTrouble }
  | { kind: 'stuck'; agentId: string; reason: CrewTrouble }
  | { kind: 'dropFolder'; agentId: string; why: 'asleep-7d' | 'low-disk' }

/** What the keeper asks of the rest of the Swarm: whether [machineId] would admit a start of [agent]'s kind now (machines.ts
 *  admitMachineStart, with the store's Team-account facts). */
export interface CrewDeps {
  admits(machineId: string, agent: Agent): boolean
  /** A project's machine rules, from its rules record (policy.ts machines). */
  machineRules?(projectId: string): readonly MachineRule[]
}

/** Whether [agent] is crew (#3397's `crew` record), read without its type until that change lands. */

/** [machineId]'s contribution while it stands: a withdrawn one (its person left or became a viewer) reads as none, never a
 *  refusal, so a sweep never stops on it. */
function standingPool(state: SuperTabState, machineId: string): ContributedMachine | undefined {
  const pool = state.machines?.find(m => m.machineId === machineId)
  const contributor = pool && state.people.find(p => p.id === pool.contributorId)
  return pool && contributor && contributor.role !== 'viewer' && contributor.generation === pool.membershipGeneration ? pool : undefined
}

/** The task [agent] holds: its active one, or one its machine took from it within HELD_TASK_MS and not handed on since. */
function heldTasks(state: SuperTabState, agent: Agent, now: number) {
  const lost = agent.lostTask && now - agent.lostTask.at < HELD_TASK_MS ? agent.lostTask : undefined
  return state.conversations.filter(c => c.assignment?.agentId === agent.id && (activeWork(c)
    || (c.assignment.status === 'lost' && !!lost && lost.conversationId === c.id && lost.assignmentId === c.assignment.id)))
}

/** Puts [group] at the head of its project's Next up. */
function toHead(state: SuperTabState, group: import('./model.js').Conversation): void {
  const siblings = queueSiblings(state, groupProject(state, group))
  if (siblings.some(s => s.id === group.id)) for (const [id, rank] of placeAfter(siblings, group.id, null)) {
    const sibling = state.conversations.find(c => c.id === id)
    if (sibling) sibling.queueRank = rank
  }
}

const isLead = (state: SuperTabState, agent: Agent) => state.conversations.some(c => c.leadId === agent.id)
const hasWork = (state: SuperTabState, agent: Agent) => state.conversations.some(c => c.assignment?.agentId === agent.id && activeWork(c))
const freeDisk = (pool: ContributedMachine) => {
  const resources = pool.observation?.resources
  return resources?.projectDiskFreeBytes ?? resources?.diskFreeBytes
}

/** Why [pool] can't keep a crew member of [engine] at [now], or null. Unknown readings never count as trouble. */
export function crewTrouble(state: SuperTabState, pool: ContributedMachine | null | undefined, engine: string, now: number): CrewTrouble | null {
  const reading = pool?.observation
  if (!pool || !reading || now - reading.receivedAt > MOVE_OFFLINE_MS) return 'offline'
  if (reading.readiness?.engines?.find(e => e.engine === engine)?.signedIn === false) return 'signed-out'
  const quota = quotaOf(pool, engine)
  if (quota?.known && quota.windows.some(w => {
    if (!(w.usedPercent >= 100)) return false
    const back = resetMs(w.resetsAt)
    return back === null || back - now > MOVE_QUOTA_OUT_MS
  })) return 'quota'
  const disk = freeDisk(pool)
  if (typeof disk === 'number' && disk < MOVE_LOW_DISK_BYTES) return 'disk'
  // Below the routing's quota floor (task #3662): a member there stops again and again as the weekly quota runs out, so it moves
  // to a better account rather than reopening in place. An unknown reading is never trouble.
  const weekly = quota?.known ? quota.windows.find(w => w.name === 'weekly') : undefined
  // Used up (100%) is the 'quota' rule's above: it waits when the window resets within the hour.
  if (weekly && weekly.usedPercent < 100 && 100 - weekly.usedPercent < (runsPm(state, pool, engine) ? QUOTA_FLOOR_PM_PERCENT : QUOTA_FLOOR_PERCENT)) return 'quota-low'
  return null
}

/** Whether a project's coordinator runs on [pool]'s account for [engine]: its weekly quota is the PM's, so a crew member leaves it
 *  sooner. An account is a machine. */
function runsPm(state: SuperTabState, pool: ContributedMachine, engine: string): boolean {
  return state.conversations.some(c => {
    const lead = c.leadId ? state.agents.find(a => a.id === c.leadId) : undefined
    if (!lead || lead.configuration.engine !== engine) return false
    return lead.machineId === pool.machineId
  })
}

/** Whether [agent] stopped [UNSTABLE_STOPS] times within the last [UNSTABLE_WINDOW_MS]. */
const unstable = (agent: Agent, now: number): boolean => (agent.stops ?? []).filter(at => now - at < UNSTABLE_WINDOW_MS).length >= UNSTABLE_STOPS

/** The fallback machines for [agent], best first, in the route's order: the same account kind as the machine it leaves, then
 *  the account whose weekly quota resets soonest, then the most left, then the fewest agents working, then by name. Only
 *  machines with no trouble that admit its start. */

export function fallbacks(state: SuperTabState, agent: Agent, now: number, deps: CrewDeps): ContributedMachine[] {
  const engine = agent.configuration.engine
  // A crew Reviewer goes nowhere a no-Reviewer rule refuses its reviews (review of #3964): any role the review steps take as a
  // Reviewer's (reviewerPick.ts), its crew role or else its role name.
  const reviews = /review/i.test(agent.crew?.role ?? roleNameOf(state, agent))
  const projectId = agentProjectId(state, agent)
  const rules = projectId ? deps.machineRules?.(projectId) ?? [] : []
  const weekly = (pool: ContributedMachine) => quotaOf(pool, engine)?.windows.find(w => w.name === 'weekly')
  const working = (pool: ContributedMachine) => state.agents.filter(a => a.machineId === pool.machineId && hasWork(state, a)).length
  const key = (pool: ContributedMachine): Array<number | string> => {
    const w = weekly(pool)
    return [(w && resetMs(w.resetsAt)) ?? Number.MAX_SAFE_INTEGER,
      w ? w.usedPercent : 100, working(pool), pool.name]
  }
  return (state.machines ?? [])
    // A machine that just refused its start waits.
    .filter(pool => pool.machineId !== agent.machineId && !pool.buddyOnly && standingPool(state, pool.machineId)
      && !(agent.crewMoveRefused?.machineId === pool.machineId && now - agent.crewMoveRefused.at < MOVE_REFUSED_WAIT_MS)
      && !machineRuleRefusal(rules, { machineId: pool.machineId, engine, review: reviews }, now) && !crewTrouble(state, pool, engine, now) && deps.admits(pool.machineId, agent))
    .map(pool => ({ pool, key: key(pool) }))
    .sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i]! < b.key[i]! ? -1 : 1; return 0 })
    .map(entry => entry.pool)
}

/** Whether any crew member needs another machine now, so the sweep reads the store's Team facts only then (review of #3229). */
export function crewNeedsMachine(state: SuperTabState, now: number): boolean {
  return crewKeep(state, now, { admits: () => true }).some(a => a.kind === 'move')
}

/** What the keeper does now for the Swarm's crew: one action per member at most, and one low-disk drop per machine. */
export function crewKeep(state: SuperTabState, now: number, deps: CrewDeps): CrewAction[] {
  const actions: CrewAction[] = []
  const members = state.agents.filter(a => isCrew(a) && !isBuddy(a) && !isLead(state, a) && !a.movedTo)
  for (const agent of members) {
    const trouble = crewTrouble(state, standingPool(state, agent.machineId), agent.configuration.engine, now) ?? (unstable(agent, now) ? 'unstable' : null)
    // An asleep member, or an awake one with no work on a machine gone offline (a laptop closed for the night), stays where it
    // is: it holds nothing to move, and a wake or new work moves it then (review of #3229).
    const stays = !!agent.asleep || (trouble === 'offline' && !heldTasks(state, agent, now).length)
    if (trouble && !stays) {
      const to = fallbacks(state, agent, now, deps)[0]
      if (to) actions.push({ kind: 'move', agentId: agent.id, toMachineId: to.machineId, reason: trouble })
      else if (agent.crewStuck !== trouble) actions.push({ kind: 'stuck', agentId: agent.id, reason: trouble })
      continue
    }
    if (trouble && !agent.asleep) continue
    if (agent.asleep) {
      if (!agent.asleep.folderDropped && now - agent.asleep.since >= FOLDER_ASLEEP_MS) actions.push({ kind: 'dropFolder', agentId: agent.id, why: 'asleep-7d' })
      continue
    }
    if (hasWork(state, agent)) continue
    const since = idleSince(agent, groupsOf(state, agent))
    if (since !== undefined && now - since >= SLEEP_IDLE_MS) actions.push({ kind: 'sleep', agentId: agent.id })
  }
  // A machine short of disk gives back the folder of its member asleep longest first, one a pass, until a reading shows room.
  for (const pool of state.machines ?? []) {
    const disk = freeDisk(pool)
    if (typeof disk !== 'number' || disk >= DISK_FLOOR_BYTES) continue
    const asleep = members.filter(a => a.machineId === pool.machineId && a.asleep && !a.asleep.folderDropped
      && !actions.some(x => x.kind === 'dropFolder' && x.agentId === a.id))
      .sort((a, b) => a.asleep!.since - b.asleep!.since)[0]
    if (asleep) actions.push({ kind: 'dropFolder', agentId: asleep.id, why: 'low-disk' })
  }
  return actions
}

const ENGINE = (engine: string) => engine === 'claude' ? 'Claude' : engine === 'codex' ? 'Codex' : engine
const machineName = (state: SuperTabState, machineId: string) => state.machines?.find(m => m.machineId === machineId)?.name ?? 'its machine'
/** Why a member leaves [from], in words the project chat and its hand-off note use. */
export function troubleText(state: SuperTabState, agent: Agent, reason: CrewTrouble): string {
  const from = machineName(state, agent.machineId), engine = ENGINE(agent.configuration.engine)
  return reason === 'offline' ? `${from} has been offline over 5 minutes`
    : reason === 'signed-out' ? `${engine} is signed out on ${from}`
    : reason === 'quota' ? `${from} is out of ${engine} quota for over an hour`
    : reason === 'quota-low' ? `${engine} on ${from} is nearly out of weekly quota`
    : reason === 'unstable' ? `${nameOf(agent)} stopped ${UNSTABLE_STOPS} times in the last hour on ${from}`
    : `${from} is low on disk`
}
const nameOf = (agent: Agent) => agent.displayName ?? agent.name

/** The start that moves [agent] to [pool], as an agent.start of the same member there: its project's folder, its name, role,
 *  engine, model and effort, in its project's chat. Null when its project is gone. Checked by admitMachineStart before use. */
export function crewMoveRequest(state: SuperTabState, agent: Agent, pool: ContributedMachine): AgentStartRequest | null {
  const project = projectsOf(state).find(p => p.id === agentProjectId(state, agent))
  if (!project || !state.conversations.some(c => c.id === project.leadConversationId)) return null
  const { engine, model, effort } = agent.configuration
  return { conversationId: project.leadConversationId, machineId: pool.machineId, engine, ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    name: agent.name, ...(agent.roleName ? { roleName: agent.roleName } : {}), cwd: projectFolder(pool, project), worktree: true,
    requirements: { memoryBytes: AGENT_MEMORY_BYTES, diskBytes: 10 * 1024 ** 3, maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false },
    crewMoveOf: agent.id }
}

/** The note the moved member reads first (the host shows it in its start row): why it moved, and that its task was handed back. */
function handoffNote(state: SuperTabState, agent: Agent, reason: CrewTrouble, to: ContributedMachine, now: number): string {
  const task = heldTasks(state, agent, now)[0]
  const pr = task?.pullRequestUrls?.at(-1)
  return [`You are ${nameOf(agent)}, moved from ${machineName(state, agent.machineId)} to ${to.name} because ${troubleText(state, agent, reason)}.`,
    'This folder is new: fetch your branch before you go on.',
    task ? `Your task "${task.title}" went back to the head of the list${pr ? ` (its pull request: ${pr})` : ''}; it comes back to you or to whoever is free first.` : '']
    .filter(Boolean).join(' ').slice(0, 1000)
}

/** Its project's chat, written as a system row by the Swarm's owner, as liveness.ts's notices are. */
function notice(state: SuperTabState, agent: Agent, id: string, text: string): MessageDraft[] {
  const owner = state.people.find(p => p.id === state.ownerId)
  const project = projectsOf(state).find(p => p.id === agentProjectId(state, agent))
  if (!owner || !project || !state.conversations.some(c => c.id === project.leadConversationId)) return []
  return [{ id, conversationId: project.leadConversationId, replyTo: null, recipients: [],
    author: { kind: 'person', id: owner.id, name: owner.email, membershipGeneration: owner.generation }, text, source: { kind: 'system' } }]
}

/**
 * Applies the keeper to [state] (store.ts, with the Swarm's time checks): sleeps, moves, says a stuck move once, and marks
 * folders to drop. A move whose start ended without running is forgotten first, so the member can move again. Returns the
 * project chat rows to post: one per move and per stuck member, none for a sleep.
 */
export function applyCrewKeep(state: SuperTabState, now: number, deps: CrewDeps): MessageDraft[] {
  for (const agent of state.agents) {
    if (!agent.movedTo) continue
    const start = state.starts?.find(s => s.id === agent.movedTo!.startId)
    if (!start || start.error) delete agent.movedTo
  }
  const drafts: MessageDraft[] = []
  for (const action of crewKeep(state, now, deps)) {
    const agent = state.agents.find(a => a.id === action.agentId)!
    if (action.kind === 'sleep') agent.asleep = { since: now }
    else if (action.kind === 'dropFolder') agent.asleep = { ...agent.asleep!, folderDropped: true }
    else if (action.kind === 'stuck') {
      agent.crewStuck = action.reason
      drafts.push(...notice(state, agent, stableId('crew-stuck', agent.id, action.reason, String(now)),
        `${nameOf(agent)} can't keep working there: ${troubleText(state, agent, action.reason)}, and no other machine can take it now.`))
    } else {
      const pool = state.machines!.find(m => m.machineId === action.toMachineId)!
      const request = crewMoveRequest(state, agent, pool)
      state.starts ??= []
      if (!request || state.starts.filter(s => !s.harnessId && !s.error).length >= 32) continue
      const contributor = state.people.find(p => p.id === pool.contributorId)
      if (!contributor) continue
      const id = stableId('crew-move', agent.id, String(now))
      const start: AgentStart = { poolGeneration: pool.generation, id, creationId: `super-${id}`,
        actorKey: actorKey({ kind: 'person', userId: contributor.id, email: contributor.email }), contributorId: contributor.id,
        membershipGeneration: contributor.generation, machineOwnerId: pool.contributorId, hostGrant: null,
        request: { ...request, handoffNote: handoffNote(state, agent, action.reason, pool, now) }, harnessId: null, dispatched: false, error: null, requestedAt: now }
      state.starts.push(start)
      // At the head of the list now, before the old session's loss of it (offline, or its host closing it) can come first.
      for (const group of heldTasks(state, agent, now)) {
        // A member that keeps stopping hands its task on now, back to its area for whoever is free, rather than waiting 5 minutes for
        // each reopen and then for its move (task #3662).
        if (action.reason === 'unstable' && activeWork(group)) {
          group.assignment!.status = 'lost'
          group.assignment!.lost = { reason: 'crew-unstable', at: now }
          group.lostAttempt = { id: group.assignment!.id, agentId: agent.id, machineId: agent.machineId, engine: agent.configuration.engine }
        }
        toHead(state, group)
      }
      agent.movedTo = { machineId: pool.machineId, startId: id, reason: action.reason, at: now }
      delete agent.crewStuck
      drafts.push(...notice(state, agent, stableId('crew-move', agent.id, id),
        `${nameOf(agent)} is moving to ${pool.name}: ${troubleText(state, agent, action.reason)}. Its task goes back to the head of the list.`))
    }
  }
  return drafts
}

/** An asleep agent woken for work (a Buddy's, buddySleep.ts and buddyEngine.ts): its host reopens the session in place. The reopen grace counts
 *  from now (#3397's CREW_REOPEN_GRACE_MS from downSince), so the task is not lost while it reopens. Whether it was asleep. */
export function wakeCrewMember(agent: Agent, now: number): boolean {
  if (!agent.asleep) return false
  delete agent.asleep
  agent.downSince = new Date(now).toISOString()
  return true
}

/** A move's start failed: the member stays where it was, and the keeper may try another machine on its next pass. */
export function crewMoveFailed(state: SuperTabState, start: AgentStart, now: number): void {
  const from = start.request.crewMoveOf ? state.agents.find(a => a.id === start.request.crewMoveOf) : undefined
  if (from?.movedTo?.startId !== start.id) return
  delete from.movedTo
  from.crewMoveRefused = { machineId: start.request.machineId, at: now }
}

/**
 * A move's new session started as [agentId] (agent.started): it becomes the same member. It takes the old one's crew record,
 * name and groups, and records where it came from. The old one's active task is lost with reason crew-moved and goes to the
 * head of its project's Next up, so whoever is free next (or this member) takes it with its pushed branch. Then the old
 * agent is removed, which closes its session on its host and drops its folder when clean ([remove]: commands.ts removeAgent).
 */
export function takeOverCrewMember(state: SuperTabState, start: AgentStart, agentId: string, now: number, remove: (agent: Agent) => void): void {
  const from = start.request.crewMoveOf ? state.agents.find(a => a.id === start.request.crewMoveOf) : undefined
  const moved = state.agents.find(a => a.id === agentId)
  if (!from || !moved || from.movedTo?.startId !== start.id) return
  const crew = (from as Agent & { crew?: unknown }).crew
  if (crew) (moved as Agent & { crew?: unknown }).crew = crew
  moved.displayName = nameOf(from)
  moved.movedFrom = { agentId: from.id, machineId: from.machineId, reason: from.movedTo.reason, at: now }
  for (const group of state.conversations) {
    if (group.agentIds.includes(from.id) && !group.agentIds.includes(moved.id)) group.agentIds.push(moved.id)
    if (group.assignment?.agentId !== from.id) continue
    if (activeWork(group)) {
      group.assignment.status = 'lost'
      group.assignment.lost = { reason: 'crew-moved', at: now }
      group.lostAttempt = { id: group.assignment.id, agentId: from.id, machineId: from.machineId, engine: from.configuration.engine }
      toHead(state, group)
    } else if (group.assignment.status === 'lost' && (group.assignment.lost?.at ?? 0) >= from.movedTo.at) toHead(state, group)
  }
  remove(from)
}
