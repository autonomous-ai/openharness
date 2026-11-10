/**
 * One Swarm's rows for a machine's host (design 4.10): exactly what `GET /hosts/:m`, `/pools` and `/assignments` gave
 * before parts (the store's old host reads, which this replaced), built from a reassembled state, with `revision`
 * replaced by `lastChangedAt` and the Leads conversation id added to agent rows.
 */
import { buddySleepManaged } from '../buddySleep.js'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { activeWork, agent, isLeads, SuperTabError, type Agent, type SuperTabState } from '../model.js'
import { buddyChatOf, isBuddy, isSwarmBuddy, isSwarmBuddyChat } from '../buddies.js'
import { buddyEngineChat } from '../buddyEngine.js'
import { hostLocalGrid, machineContribution, machineLimitReached, type MachineCleanup } from '../machines.js'
import { agentProjectId, agentSetRole, canWatchAgent, confidentialSets, isConfidential, groupProject, ledProject, projectsOf, skillModeOf, startProject, skillSetOf, watchClosed, type ConfidentialSets } from '../projects.js'
import type { HostAgentRow, HostPool, HostRosterRow, HostTabRows } from './contract.js'
import { hostEtag } from './hostEtag.js'
import { coordinatorNameOf, FIRST_INSTRUCTIONS, roleNameOf } from '../instructions.js'

export interface HostLookups {
  /** The Swarm's people with their account emails (observers). */
  people: Array<{ id: string; email: string }>
  /** Its agents whose session is confidential in another Swarm (confidential.ts): nobody but its machine's person watches them. */
  confidential: Set<string>
  /** Throws a SuperTabError when the agent's machine grant is gone (store.ts agentGrant). */
  agentGrant(target: Agent): Promise<void>
}

/** Removed machines whose host has not yet said it cleaned up (store.ts cleanups). */
const cleanups = (state: SuperTabState): MachineCleanup[] => [
  ...(state.machines ?? []).flatMap(m => m.removal ? [{ machineId: m.machineId, removalId: m.removal.id, machineOwnerId: m.contributorId }] : []),
  ...(state.machineCleanups ?? [])]

export async function hostTab(tabId: string, state: SuperTabState, machineId: string, user: AuthUser, lastChangedAt: number | null, lookups: HostLookups): Promise<HostTabRows> {
  const rows = { tabId, lastChangedAt, roster: await roster(tabId, state, machineId, user, lastChangedAt, lookups),
    pool: pool(tabId, state, machineId, user), assignments: assignments(tabId, state, machineId, user) }
  return { ...rows, etag: hostEtag(rows) }
}

async function roster(tabId: string, state: SuperTabState, machineId: string, user: AuthUser, lastChangedAt: number | null, lookups: HostLookups): Promise<HostRosterRow[]> {
  const rows: HostRosterRow[] = []
  // Once per read: each row asks it for each person (task #4504). The state is this read's own, so nothing changes it meanwhile.
  const sets = confidentialSets(state)
  for (const target of state.agents.filter(a => a.machineId === machineId && a.machineOwnerId === user.sub)) {
    try { agent(state, target.id); await lookups.agentGrant(target) } catch (error) { if (error instanceof SuperTabError) continue; throw error }
    rows.push(agentRow(tabId, state, machineId, user, lastChangedAt, lookups, target, sets))
  }
  for (const { agentId: id, harnessId } of (state.closingSessions ?? []).filter(c => c.machineId === machineId && c.machineOwnerId === user.sub)) {
    rows.push({ tabId, agent: { id, harnessId, machineId }, closeSession: true, active: false })
  }
  rows.push(...cleanups(state).filter(c => c.machineId === machineId && c.machineOwnerId === user.sub)
    .map(({ removalId }) => ({ tabId, cleanup: { machineId, removalId } })))
  return rows
}

function agentRow(tabId: string, state: SuperTabState, machineId: string, user: AuthUser, lastChangedAt: number | null, lookups: HostLookups, target: Agent,
  sets: ConfidentialSets): HostAgentRow {
  const closed = lookups.confidential.has(target.id)
  const waiting = state.conversations.find(c => activeWork(c) && c.assignment!.agentId === target.id &&
    c.assignment!.execution.machineId === machineId && ['needs_human', 'blocked'].includes(c.assignment!.status))?.assignment
  const home = projectsOf(state).find(p => p.id === agentProjectId(state, target))
  const custom = home && skillSetOf(home) === 'custom' ? home : null
  const chosen = custom ? agentSetRole(state, custom, target) : null
  const buddyChat = isSwarmBuddy(target) || (target.buddySession && target.buddyOf) ? buddyChatOf(state, target) : undefined
  return {
    tabId, tabName: state.name, lastChangedAt, paused: state.paused,
    // `active` lets the host release members that are only in archived groups to automatic cleanup.
    active: state.conversations.some(c => !c.archived && c.agentIds.includes(target.id)),
    attention: waiting ? { assignmentId: waiting.id, status: waiting.status, result: waiting.result?.slice(0, 500) ?? null } : null,
    // No task resumes after a usage limit since Swarm v4 (work.resume is retired, 2026-11-10): an older host still reads the
    // field (cli superTabs/limitResume.ts), so it stays, always empty, until 2026-12-09.
    resume: null,
    agent: target,
    ...(buddySleepManaged(state, target) ? { buddySleepManaged: true as const } : {}),
    // The Swarm owner's host adds the machine any live agent of theirs runs on, in any Swarm they own: a Lead, or a plain v4 agent, which
    // leads nothing (a Personal Swarm may hold nothing else, and never got its machine). Since #4120 a machine takes only its own person's
    // agents, so this adds no one else's work to it. Never for a Buddy: a Buddy-only record is not the machine in the Swarm; an agent of the
    // owner there still joins it, which makes the record an ordinary machine (commands.ts machine.contribute ifMissing; security review 2
    // of #2234). Not where machine.contribute would refuse it (#2637): a Buddy-only record is counted already, so it still joins. Never
    // a machine its person took out of the Swarm (removedMachines): an older host adds it back on this word alone (cli host.ts); a person
    // who wants it back adds it.
    joinSwarm: state.ownerId === user.sub && target.contributorId === user.sub && !isBuddy(target)
      && state.conversations.some(c => !c.archived && c.agentIds.includes(target.id))
      && !state.machines?.some(m => m.machineId === machineId && !m.buddyOnly) && !state.removedMachines?.some(r => r.machineId === machineId)
      && (state.machines?.some(m => m.machineId === machineId) || !machineLimitReached(state, user.sub)),
    skillMode: home ? skillModeOf(home) : 'orchestration',
    // What the host installs as the agent's instructions, read again when the revision moves (project instructions, phase 3).
    roleName: roleNameOf(state, target),
    // At revision 0 (nothing saved) the hash is the template's, so a backend release that changes the template moves it and
    // running daemons read the text again (2026-11-02: agents kept the old routing after #2495, as revision 0 never moves).
    instructions: home ? { projectId: home.id, revision: home.instructionsRevision ?? 0,
      hash: home.instructionsHash ?? (home.instructionsRevision ? null : FIRST_INSTRUCTIONS.instructionsHash),
      coordinatorName: coordinatorNameOf(home) } : null,
    ...(custom ? { role: chosen && { ...chosen, projectId: custom.id } } : {}),
    lead: !!ledProject(state, target.id),
    // Swarm v4 restarts no PM on the server's word (timeChecks.ts): an older host still reads the field, so it stays, always empty.
    owed: null,
    // Removed (model.ts leadsRemoved); an older CLI still reads the field, so it stays, always empty.
    leadsConversationId: null,
    // The conversation it leads: the chat its host rebuilds its start prompt from when it switches it (cli leadSwitchRequest.ts).
    // A field of its own: an older host reads leadsConversationId as "only this conversation's deliveries" (cli host.ts).
    ledConversationId: ledProject(state, target.id)?.leadConversationId ?? null,
    ...(isSwarmBuddy(target) && !target.buddySession ? { buddyConversationId: buddyChat?.id ?? buddyEngineChat(state, target) } : {}),
    stopRequested: target.workDecision === 'stop' && !state.conversations.some(c => activeWork(c) && c.assignment?.agentId === target.id),
    observers: lookups.people.filter(p => p.id !== user.sub && canWatchAgent(state, { kind: 'person', userId: p.id, email: p.email }, target, closed, sets))
      .map(p => ({ email: p.email, userId: p.id })),
    // The host refuses every share of a confidential session, ordinary ones too, and remembers it (cli observers.ts).
    confidential: isConfidential(state, target, closed, sets),
    // But for this Swarm's current Lead: its listed observers watch it while this row is in force (Ken, 2026-10-28).
    membersWatch: isConfidential(state, target, closed, sets) && !watchClosed(state, target, closed, sets),
    // Which of its person's Buddies' chats it is in (task #3818).
    ...isSwarmBuddy(target) || (target.buddySession && target.buddyOf) ? { buddyChatId: buddyChat?.id ?? null } : {},
  }
}

function pool(tabId: string, state: SuperTabState, machineId: string, user: AuthUser): HostPool | null {
  let contribution
  try { contribution = machineContribution(state, machineId) } catch (error) { if (error instanceof SuperTabError) return null; throw error }
  if (!contribution || contribution.contributorId !== user.sub) return null
  const pending = (state.starts ?? []).filter(s => s.request.machineId === machineId && s.poolGeneration === contribution.generation
    && (!s.harnessId || !s.poolSettled) && !s.error)
  // A host from before Buddies reads only `starts`, and would launch a Buddy as a Builder: it never sees one. Nor a Product
  // Manager (leadStart.ts), which goes only to a host that said it starts one.
  // Nor a Regular agent (commands.ts agent.new, task #4116), which an older host would launch in a project folder it lacks.
  const starts = pending.filter(s => !s.request.buddyOf && !s.request.leadFor && !s.request.regular), buddyStarts = pending.filter(s => s.request.buddyOf)
  const regularStarts = pending.filter(s => s.request.regular)
  const leadStarts = pending.filter(s => s.request.leadFor)
  const buddyChats = new Set(buddyStarts.map(s => s.request.conversationId))
  const reservations = (state.harnessReservations ?? []).filter(r => r.machineId === machineId)
  const removedHere = (state.removedSessions ?? []).filter(r => r.machineId === machineId).map(r => r.harnessId)
  return { tabId, paused: state.paused, machine: contribution, starts, ...(buddyStarts.length ? { buddyStarts } : {}), ...(leadStarts.length ? { leadStarts } : {}),
    ...(regularStarts.length ? { regularStarts } : {}),
    ...(contribution.scope === 'swarm' ? { projects: projectsOf(state).filter(p => pending.some(s => startProject(state, s.request)?.id === p.id))
      .map(p => ({ id: p.id, leadConversationId: p.leadConversationId, repository: p.repository,
        // A private conversation is chat only and never runs work here, so its id stays with its audience; a Buddy chat whose
        // Buddy starts here is named, so the host may prepare the project's folder for it.
        conversationIds: state.conversations.filter(c => !isLeads(c) && !isSwarmBuddyChat(c) && (!c.audience || buddyChats.has(c.id)) && groupProject(state, c).id === p.id).map(c => c.id) })) } : {}),
    // A Buddy-only machine never joins the Swarm's grid: it serves nobody's models (machines.ts buddyOnly).
    ...(contribution.buddyOnly ? {} : hostLocalGrid(state)),
    reservations: reservations.map(({ harnessId, generation }) => ({ harnessId, generation })),
    // Sessions whose agents left as closed, which this host lists again if they reopen (closedAgents.ts restoreSessions). Ids only,
    // and only to the machine's own host. Absent when there are none.
    ...(removedHere.length ? { removedHarnessIds: removedHere } : {}),
    harnessIds: [...new Set([...state.agents.filter(a => a.machineId === machineId).map(a => a.harnessId), ...reservations.map(r => r.harnessId),
      ...(state.starts ?? []).filter(s => s.request.machineId === machineId && s.harnessId).map(s => s.harnessId!)])],
    // Asks the host to say what it launches beyond workers (machines.ts `capabilities`): a host never sends a field this
    // server did not ask for, so an older server, which would refuse every reading with it, never sees it.
    buddySleepWanted: true as const, capabilitiesWanted: true as const }
}

function assignments(tabId: string, state: SuperTabState, machineId: string, user: AuthUser) {
  return state.conversations.filter(activeWork).flatMap(group => {
    const work = group.assignment!
    return work.execution.machineId === machineId && work.execution.machineOwnerId === user.sub
      ? [{ tabId, assignmentId: work.id, harnessId: work.execution.harnessId }] : []
  })
}
