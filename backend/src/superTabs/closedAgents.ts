import { isBuddy } from './buddies.js'
import { MACHINE_FRESH_MS, type MachineObservation } from './machines.js'
import { activeWork, type Agent, type RemovedSession, type SuperTabState } from './model.js'
import { agentProjectId, canReadProject, isConfidential, ledProject, onTeamAccount, projectsOf } from './projects.js'
import { logger } from '../utils/logger.js'

// Huy, 2026-11-02: four agents closed on their machine sat under Idle for hours, each in the machine's stopped list, because
// only an agent's own host removed it, and only after a stop was asked for. A session closed by hand never asked. Now the
// report that shows a session gone removes its agent (docs/plans/2026-11-02-closed-agents-leave-list-plan.md).

/** How long an agent not listed running stays before its machine, still reporting, removes it without a stopped list. */
export const DOWN_REMOVE_MS = 15 * 60_000
/** The most records of removed agents one machine keeps, the oldest going first, and how long one lasts. */
export const REMOVED_KEPT = 50
export const REMOVED_KEEP_MS = 30 * 24 * 60 * 60_000
/** How long an agent whose session is listed stopped stays first: a host mid-restart, or an agent changing its session, lists
 *  one stopped for a moment before it is back (security reviews of #2569). */
export const STOPPED_REMOVE_MS = 30_000

/** Whether [target] could ever leave this way: not a coordinator, a Buddy, one kept or being stopped. */
const removable = (state: SuperTabState, target: Agent): boolean =>
  !isBuddy(target) && target.workDecision !== 'keep' && target.workDecision !== 'stop' && !ledProject(state, target.id)

/**
 * The agents of [machineId] that [report], arriving now over the reading in [state], shows closed: not listed running, down
 * for a while, and either proved stopped (the proof the slot count accepts, machines.ts machineSlots; STOPPED_REMOVE_MS) or
 * not listed for DOWN_REMOVE_MS while the machine's other sessions still run. The last reading must be fresh and not list
 * them running either, so one report after a silence never removes anyone, and a report whose running list is empty never
 * removes by time (a fault in the host's listing would empty a whole machine). Never a coordinator (a project's end is the
 * only removal that takes one), a Buddy (its owner stops it), an agent someone chose to keep: it stays, shown as closed, or
 * one being stopped: its host closes it and takes it out (commands.ts agent.remove). Whether a task is still held is judged by
 * removeClosedAgents, after the loss of tasks.
 */
export function closedAgents(state: SuperTabState, machineId: string, report: Pick<MachineObservation, 'runningHarnessIds' | 'stoppedHarnessIds' | 'stoppedReservations'>, now: number): Agent[] {
  const previous = state.machines?.find(m => m.machineId === machineId)?.observation
  const fresh = previous && now - previous.receivedAt <= MACHINE_FRESH_MS ? previous : undefined
  if (!fresh) return []
  return state.agents.filter(target => {
    if (target.machineId !== machineId || report.runningHarnessIds.includes(target.harnessId) || fresh.runningHarnessIds.includes(target.harnessId)) return false
    if (!removable(state, target)) return false
    if (!target.downSince) return false
    const down = now - Date.parse(target.downSince)
    if (report.stoppedHarnessIds.includes(target.harnessId)) {
      const reservation = state.harnessReservations?.find(r => r.machineId === machineId && r.harnessId === target.harnessId)
      // Older hosts can prove a first launch stopped, but cannot tell a resumed runtime from its predecessor.
      return down >= STOPPED_REMOVE_MS
        && (!reservation || !reservation.renewed || !!report.stoppedReservations?.some(r => r.harnessId === target.harnessId && r.generation === reservation.generation))
    }
    return down >= DOWN_REMOVE_MS && report.runningHarnessIds.length > 0 && fresh.runningHarnessIds.length > 0
  })
}

/** The record that its host closes the session of a removed agent: a confidential session in a Team account keeps the account
 *  for its project until the host confirms the close, which it does once the session's data there is deleted (security re-check
 *  2 of #2089). The close also frees the session's slot (commands.ts agent.sessionClosed). Written before the agent leaves its
 *  groups, which decide whether the session is confidential. */
export function recordClosing(state: SuperTabState, target: Agent, now: number): void {
  if (state.closingSessions?.some(c => c.agentId === target.id && c.harnessId === target.harnessId)) return
  const held = onTeamAccount(state, target) && isConfidential(state, target) ? { heldFor: agentProjectId(state, target), since: now } : {}
  // Its machine part outlives the Buddy-only record while this closes: it stays as private as the record (read/changes.ts).
  const hidden = state.machines?.some(m => m.machineId === target.machineId && m.buddyOnly) ? { buddyOnly: true as const } : {}
  ;(state.closingSessions ??= []).push({ agentId: target.id, machineId: target.machineId, harnessId: target.harnessId, machineOwnerId: target.machineOwnerId, ...held, ...hidden })
}

/** Removes those of [closed] that hold no task now: from the agents and from every group's members and leads, as commands.ts
 *  removeAgent does, with the close order its host needs. A task just lost keeps its agent until its Lead hands it on or
 *  cancels it (it is still fenced and told by name, liveness.ts); the next report removes the agent then. The removed agents,
 *  for the caller to cancel what waits for them. */
export function removeClosedAgents(state: SuperTabState, closed: Agent[], now: number): Agent[] {
  const holding = new Set(state.conversations.filter(group => activeWork(group) || group.assignment?.status === 'lost').map(group => group.assignment!.agentId))
  const removed = closed.filter(target => !holding.has(target.id))
  if (!removed.length) return []
  for (const target of removed) recordClosing(state, target, now)
  const gone = new Set(removed.map(target => target.id))
  for (const target of removed) keepRecord(state, target, now)
  state.agents = state.agents.filter(target => !gone.has(target.id))
  for (const group of state.conversations) {
    group.agentIds = group.agentIds.filter(id => !gone.has(id))
    if (group.leadId && gone.has(group.leadId)) group.leadId = null
  }
  return removed
}

/** What a removal restores from if the session reopens (task #2131), unless the agent is meant to stay gone: someone asked it to stop,
 *  or its session held private chats, which purge deletes. Only what it was, not how it was doing: down, stopping, lost, noticed. */
function keepRecord(state: SuperTabState, target: Agent, now: number): void {
  if (target.workDecision === 'stop' || target.confidential || isConfidential(state, target)) return
  const { downSince: _down, lostTask: _lost, releaseId: _release, idleStop: _idle, idleNoticedAt: _noticed, workDecision: _decision, ...agent } = target
  const others = (state.removedSessions ?? []).filter(r => r.machineId !== target.machineId || r.harnessId !== target.harnessId)
  const mine = others.filter(r => r.machineId === target.machineId)
  const over = mine.length + 1 - REMOVED_KEPT
  const dropped = new Set(over > 0 ? [...mine].sort((a, b) => a.removedAt - b.removedAt).slice(0, over) : [])
  state.removedSessions = [...others.filter(r => !dropped.has(r)), { machineId: target.machineId, harnessId: target.harnessId, agent,
    groupIds: state.conversations.filter(group => group.agentIds.includes(target.id)).map(group => group.id),
    leadOf: state.conversations.filter(group => group.leadId === target.id).map(group => group.id), removedAt: now }]
}

/** This machine's records of sessions [running] lists again, for the report to read their groups before restoring them. */
export const reopened = (state: SuperTabState, machineId: string, running: readonly string[]): RemovedSession[] =>
  (state.removedSessions ?? []).filter(r => r.machineId === machineId && running.includes(r.harnessId))

/** Why [record] may not come back as it was, by a fixed word, or null. Each read from the state this write loaded, as any of it may
 *  have changed since. */
function refusal(state: SuperTabState, record: RemovedSession, machineOwnerId: string, elsewhere: ReadonlySet<string>, granted: ReadonlySet<string>): string | null {
  const { agent } = record
  // The record names its own session; a machine reports only its own, and a report is the only way here.
  if (agent.machineId !== record.machineId || agent.harnessId !== record.harnessId || agent.machineOwnerId !== machineOwnerId) return 'not-this-machine'
  if (state.agents.some(a => a.id === agent.id || (a.machineId === record.machineId && a.harnessId === record.harnessId))) return 'already-listed'
  if (elsewhere.has(record.harnessId)) return 'in-another-swarm'
  if (!granted.has(record.harnessId)) return 'share-ended'
  if (state.closingSessions?.some(c => c.machineId === record.machineId && c.harnessId === record.harnessId && c.heldFor)) return 'team-held'
  // Its contributor may be another person, on a machine shared with them: they must still be here, and the share must hold ([granted]).
  const contributor = state.people.find(p => p.id === agent.contributorId)
  if (!contributor || contributor.generation !== agent.membershipGeneration || contributor.role === 'viewer') return 'contributor-changed'
  if (!state.projects) return null
  const project = projectsOf(state).find(p => p.id === agent.projectId)
  return project && canReadProject(state, { kind: 'person', userId: contributor.id, email: contributor.email }, project) ? null : 'project-ended'
}

/**
 * Brings back the agents of [machineId] whose sessions [running] lists again, from the records their removal kept, and drops the
 * records that came due or can't be restored. Called only with a report already proved to be this machine's
 * ([machineOwnerId], its signed-in owner); no command reaches it. An agent comes back only to the open groups of its own project it was in, never a
 * private chat, since who may read there is not its to decide again. [elsewhere]: sessions registered in another Swarm by now.
 * [granted]: sessions whose share of this machine still holds. The restored agents.
 */
export function restoreSessions(state: SuperTabState, machineId: string, running: readonly string[], machineOwnerId: string, now: number,
  elsewhere: ReadonlySet<string>, granted: ReadonlySet<string>, reserve: (harnessId: string) => void): Agent[] {
  const records = state.removedSessions
  if (!records?.length) return []
  const restored: Agent[] = []
  const left = records.filter(record => {
    if (record.machineId !== machineId) return true
    if (now - record.removedAt >= REMOVED_KEEP_MS) return false
    if (!running.includes(record.harnessId)) return true
    const refused = refusal(state, record, machineOwnerId, elsewhere, granted)
    if (refused) {
      logger.info('[swarm] a reopened session was not restored', { reason: refused })
      return false
    }
    state.agents.push(record.agent)
    reserve(record.harnessId)
    // Back before its host closed it: the session stays open, as when a person adds it back (commands.ts agent.add). A close held for
    // a Team account was refused above: that account stays held until its host confirms (refusal, `team-held`).
    state.closingSessions = state.closingSessions?.filter(c => c.machineId !== record.machineId || c.harnessId !== record.harnessId)
    if (!state.closingSessions?.length) delete state.closingSessions
    for (const group of state.conversations) {
      if (group.archived || group.dormant || group.kind || group.audience || (state.projects && group.projectId !== record.agent.projectId)) continue
      if (record.groupIds.includes(group.id) && !group.agentIds.includes(record.agent.id)) group.agentIds.push(record.agent.id)
      if (record.leadOf.includes(group.id) && !group.leadId) group.leadId = record.agent.id
    }
    restored.push(record.agent)
    return false
  })
  if (left.length !== records.length) state.removedSessions = left
  return restored
}

/** The next time a report of [machineId] could remove an agent, after those it just judged: its reports skip the full load
 *  until then (machineReports.ts), so a stopped list that stays the same still removes its agent when its wait ends. */
export function nextRemovalAt(state: SuperTabState, machineId: string, now: number): number | undefined {
  const stopped = state.machines?.find(m => m.machineId === machineId)?.observation?.stoppedHarnessIds ?? []
  const ends = state.agents.filter(a => a.machineId === machineId && a.downSince && removable(state, a))
    .map(a => Date.parse(a.downSince!) + (stopped.includes(a.harnessId) ? STOPPED_REMOVE_MS : DOWN_REMOVE_MS))
    .filter(end => end > now)
  return ends.length ? Math.min(...ends) : undefined
}
