/**
 * One Swarm's rows for a machine's host (design 4.10): exactly what `GET /hosts/:m`, `/pools` and `/assignments` gave
 * before parts (the store's old host reads, which this replaced), built from a reassembled state, with `revision`
 * replaced by `lastChangedAt` and the Leads conversation id added to agent rows.
 */
import type { AuthUser } from '../../lib/ssoAuth.js'
import { activeWork, agent, isLeads, SuperTabError, conversation, type Agent, type SuperTabState } from '../model.js'
import { isSwarmBuddyChat } from '../buddies.js'
import { hostLocalGrid, machineContribution, teamAccountSwarm, type MachineCleanup } from '../machines.js'
import { agentProjectId, agentSetRole, canWatchAgent, isConfidential, groupProject, ledProject, projectsOf, skillModeOf, startProject, skillSetOf, watchClosed } from '../projects.js'
import type { HostAgentRow, HostPool, HostRosterRow, HostTabRows } from './contract.js'
import { hostEtag } from './hostEtag.js'
import { coordinatorNameOf, roleNameOf } from '../instructions.js'

export interface HostLookups {
  /** The Swarm's people with their account emails (observers). */
  people: Array<{ id: string; email: string }>
  /** Its agents whose session is confidential in another Swarm (confidential.ts): nobody but its machine's person watches them. */
  confidential: Set<string>
  /** Throws a SuperTabError when the agent's machine grant is gone (store.ts agentGrant). */
  agentGrant(target: Agent): Promise<void>
  /** This Mac's Harness Team accounts, which join wherever the Mac was added. */
  teams: Array<{ machineId: string }>
  githubApp: boolean
}

/** Removed machines whose host has not yet said it cleaned up (store.ts cleanups). */
const cleanups = (state: SuperTabState): MachineCleanup[] => [
  ...(state.machines ?? []).flatMap(m => m.removal ? [{ machineId: m.machineId, removalId: m.removal.id, machineOwnerId: m.contributorId }] : []),
  ...(state.machineCleanups ?? [])]

export async function hostTab(tabId: string, state: SuperTabState, machineId: string, user: AuthUser, lastChangedAt: number | null, lookups: HostLookups): Promise<HostTabRows> {
  const rows = { tabId, lastChangedAt, roster: await roster(tabId, state, machineId, user, lastChangedAt, lookups),
    pool: pool(tabId, state, machineId, user, lookups.githubApp), assignments: assignments(tabId, state, machineId, user) }
  return { ...rows, etag: hostEtag(rows) }
}

async function roster(tabId: string, state: SuperTabState, machineId: string, user: AuthUser, lastChangedAt: number | null, lookups: HostLookups): Promise<HostRosterRow[]> {
  const rows: HostRosterRow[] = []
  // Where its owner added this Mac and its team account is missing, this host adds that account (cli/src/superTabs/host.ts),
  // in a Swarm the team account is tried in (teamAccountSwarm).
  const mac = !teamAccountSwarm(state) ? undefined
    : state.machines?.find(m => m.machineId === machineId && m.contributorId === user.sub && m.scope === 'swarm' && !m.removal && !m.buddyOnly)
  for (const team of mac ? lookups.teams : []) {
    if (state.machines?.some(m => m.machineId === team.machineId) || state.machineCleanups?.some(c => c.machineId === team.machineId)) continue
    rows.push({ tabId, joinTeam: { machineId: team.machineId, name: mac!.name, maxAgents: mac!.maxAgents } })
  }
  for (const target of state.agents.filter(a => a.machineId === machineId && a.machineOwnerId === user.sub)) {
    try { agent(state, target.id); await lookups.agentGrant(target) } catch (error) { if (error instanceof SuperTabError) continue; throw error }
    rows.push(agentRow(tabId, state, machineId, user, lastChangedAt, lookups, target))
  }
  for (const { agentId: id, harnessId } of (state.closingSessions ?? []).filter(c => c.machineId === machineId && c.machineOwnerId === user.sub)) {
    rows.push({ tabId, agent: { id, harnessId, machineId }, closeSession: true, active: false })
  }
  rows.push(...cleanups(state).filter(c => c.machineId === machineId && c.machineOwnerId === user.sub)
    .map(({ removalId }) => ({ tabId, cleanup: { machineId, removalId } })))
  return rows
}

function agentRow(tabId: string, state: SuperTabState, machineId: string, user: AuthUser, lastChangedAt: number | null, lookups: HostLookups, target: Agent): HostAgentRow {
  const closed = lookups.confidential.has(target.id)
  const waiting = state.conversations.find(c => activeWork(c) && c.assignment!.agentId === target.id &&
    c.assignment!.execution.machineId === machineId && ['needs_human', 'blocked'].includes(c.assignment!.status))?.assignment
  // A task it lost to a usage limit that gave a reset time, while nobody has handed it on: its host resumes it then
  // (cli superTabs/limitResume.ts), and the backend still decides (commands.ts work.resume).
  const marked = target.lostTask
  const lost = marked?.resumeAt ? state.conversations.find(c => c.id === marked.conversationId)?.assignment : undefined
  const resume = marked?.resumeAt && lost?.id === marked.assignmentId && lost.status === 'lost' && lost.lost?.at === marked.at
    ? { conversationId: marked.conversationId, assignmentId: marked.assignmentId, lostAt: marked.at, at: marked.resumeAt } : null
  const home = projectsOf(state).find(p => p.id === agentProjectId(state, target))
  const custom = home && skillSetOf(home) === 'custom' ? home : null
  const chosen = custom ? agentSetRole(state, custom, target) : null
  return {
    tabId, tabName: state.name, lastChangedAt, paused: state.paused,
    // `active` lets the host release members that are only in archived groups to automatic cleanup.
    active: state.conversations.some(c => !c.archived && c.agentIds.includes(target.id)),
    attention: waiting ? { assignmentId: waiting.id, status: waiting.status, result: waiting.result?.slice(0, 500) ?? null } : null,
    resume,
    agent: target,
    // A Buddy-only record is not the machine in the Swarm: the owner's Lead there still joins it, which makes the record an ordinary
    // machine (commands.ts machine.contribute ifMissing; security review 2 of #2234).
    joinSwarm: state.ownerId === user.sub && target.contributorId === user.sub && !state.machines?.some(m => m.machineId === machineId && !m.buddyOnly)
      && state.conversations.some(c => !c.archived && c.leadId === target.id),
    skillMode: home ? skillModeOf(home) : 'orchestration',
    // What the host installs as the agent's instructions, read again when the revision moves (project instructions, phase 3).
    roleName: roleNameOf(state, target),
    instructions: home ? { projectId: home.id, revision: home.instructionsRevision ?? 0, hash: home.instructionsHash ?? null,
      coordinatorName: coordinatorNameOf(home) } : null,
    ...(custom ? { role: chosen && { ...chosen, projectId: custom.id } } : {}),
    lead: !!ledProject(state, target.id),
    leadsConversationId: state.leadsConversationId ?? null,
    stopRequested: target.workDecision === 'stop' && !state.conversations.some(c => activeWork(c) && c.assignment?.agentId === target.id),
    observers: lookups.people.filter(p => p.id !== user.sub && canWatchAgent(state, { kind: 'person', userId: p.id, email: p.email }, target, closed))
      .map(p => ({ email: p.email, userId: p.id })),
    // The host refuses every share of a confidential session, ordinary ones too, and remembers it (cli observers.ts).
    confidential: isConfidential(state, target, closed),
    // But for this Swarm's current Lead: its listed observers watch it while this row is in force (Ken, 2026-10-28).
    membersWatch: isConfidential(state, target, closed) && !watchClosed(state, target, closed),
  }
}

function pool(tabId: string, state: SuperTabState, machineId: string, user: AuthUser, githubApp: boolean): HostPool | null {
  let contribution
  try { contribution = machineContribution(state, machineId) } catch (error) { if (error instanceof SuperTabError) return null; throw error }
  if (!contribution || contribution.contributorId !== user.sub) return null
  const pending = (state.starts ?? []).filter(s => s.request.machineId === machineId && s.poolGeneration === contribution.generation
    && (!s.harnessId || !s.poolSettled) && !s.error)
  // A host from before Buddies reads only `starts`, and would launch a Buddy as a Builder: it never sees one. Nor a Product
  // Manager (leadStart.ts), which goes only to a host that said it starts one.
  const starts = pending.filter(s => !s.request.buddyOf && !s.request.leadFor), buddyStarts = pending.filter(s => s.request.buddyOf)
  const leadStarts = pending.filter(s => s.request.leadFor)
  const buddyChats = new Set(buddyStarts.map(s => s.request.conversationId))
  const reservations = (state.harnessReservations ?? []).filter(r => r.machineId === machineId)
  return { tabId, paused: state.paused, machine: contribution, starts, ...(buddyStarts.length ? { buddyStarts } : {}), ...(leadStarts.length ? { leadStarts } : {}),
    ...(contribution.scope === 'swarm' ? { projects: projectsOf(state).filter(p => pending.some(s => startProject(state, s.request)?.id === p.id))
      .map(p => ({ id: p.id, leadConversationId: p.leadConversationId, repository: p.repository,
        // A private conversation is chat only and never runs work here, so its id stays with its audience; a Buddy chat whose
        // Buddy starts here is named, so the host may prepare the project's folder for it.
        conversationIds: state.conversations.filter(c => !isLeads(c) && !isSwarmBuddyChat(c) && (!c.audience || buddyChats.has(c.id)) && groupProject(state, c).id === p.id).map(c => c.id) })) } : {}),
    // A Buddy-only machine never joins the Swarm's grid: it serves nobody's models (machines.ts buddyOnly).
    ...(contribution.buddyOnly ? {} : hostLocalGrid(state)),
    reservations: reservations.map(({ harnessId, generation }) => ({ harnessId, generation })),
    harnessIds: [...new Set([...state.agents.filter(a => a.machineId === machineId).map(a => a.harnessId), ...reservations.map(r => r.harnessId),
      ...(state.starts ?? []).filter(s => s.request.machineId === machineId && s.harnessId).map(s => s.harnessId!)])],
    ...(githubApp ? { githubApp: true as const } : {}),
    // Asks the host to say what it launches beyond workers (machines.ts `capabilities`): a host never sends a field this
    // server did not ask for, so an older server, which would refuse every reading with it, never sees it.
    capabilitiesWanted: true as const }
}

function assignments(tabId: string, state: SuperTabState, machineId: string, user: AuthUser) {
  return state.conversations.filter(activeWork).flatMap(group => {
    const work = group.assignment!
    return work.execution.machineId === machineId && work.execution.machineOwnerId === user.sub
      ? [{ tabId, assignmentId: work.id, harnessId: work.execution.harnessId }] : []
  })
}
