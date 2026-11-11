/**
 * One Swarm's rows for a machine's host (design 4.10): exactly what `GET /hosts/:m`, `/pools` and `/assignments` gave
 * before parts (the store's old host reads, which this replaced), built from a reassembled state, with `revision`
 * replaced by `lastChangedAt` and the Leads conversation id added to agent rows.
 */
import type { AuthUser } from '../../lib/ssoAuth.js'
import { activeWork, agent, isLeads, SuperTabError, type Agent, type Assignment, type Conversation, type SuperTabState } from '../model.js'
import { hostLocalGrid, machineContribution, machineLimitReached, type MachineCleanup } from '../machines.js'
import { agentProjectIdFrom, canWatchAgent, confidentialSets, isAgentChat, isConfidential, groupProject, ledProjectFrom, projectsOf, startProject, watchClosed, type ConfidentialSets, type SwarmProject } from '../projects.js'
import type { HostAgentRow, HostPool, HostRosterRow, HostTabRows } from './contract.js'
import { hostEtag } from './hostEtag.js'

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

/** What a roster row reads of the conversations about one agent, read for all of a machine's agents in one pass (whereabouts). */
interface Whereabouts {
  /** In a conversation not archived. */
  active: boolean
  /** It holds active work. */
  working: boolean
  /** Its active work waiting on a person, on this machine. */
  waiting: Assignment | undefined
  /** Its project, as agentProjectId reads it. */
  projectId: string
  /** The project it leads, as ledProject reads it. */
  led: SwarmProject | undefined
}

/** [agents]' whereabouts, from one pass over the Swarm's conversations: each row once read them in several passes of its own, and
 *  each observer's check another, so a read cost about (its agents) x (the Swarm's conversations) x (its people) (PSW-B review,
 *  2026-11-11). Each value is what the per-agent reads it replaces (agentProjectId, ledProject) would answer. */
function whereabouts(state: SuperTabState, agents: Agent[], machineId: string): Map<string, Whereabouts> {
  const found = new Map(agents.map(a => [a.id, { active: false, waiting: undefined as Assignment | undefined,
    work: undefined as Conversation | undefined, group: undefined as Conversation | undefined, led: new Set<string>() }]))
  for (const c of state.conversations) {
    const work = c.assignment && activeWork(c) ? found.get(c.assignment.agentId) : undefined
    if (work) {
      work.work ??= c
      if (!work.waiting && c.assignment!.execution.machineId === machineId && ['needs_human', 'blocked'].includes(c.assignment!.status)) work.waiting = c.assignment!
    }
    const leader = c.leadId ? found.get(c.leadId) : undefined
    if (leader) leader.led.add(c.id)
    for (const id of c.agentIds) {
      const member = found.get(id)
      if (!member) continue
      if (!c.archived) member.active = true
      if (!isAgentChat(c)) member.group ??= c
    }
  }
  return new Map(agents.map(a => {
    const { active, waiting, work, group, led } = found.get(a.id)!
    return [a.id, { active, working: !!work, waiting, projectId: agentProjectIdFrom(state, a, { work, group }), led: ledProjectFrom(state, led) }]
  }))
}

async function roster(tabId: string, state: SuperTabState, machineId: string, user: AuthUser, lastChangedAt: number | null, lookups: HostLookups): Promise<HostRosterRow[]> {
  const rows: HostRosterRow[] = []
  // Once per read: each row asks it for each person (task #4504). The state is this read's own, so nothing changes it meanwhile.
  const sets = confidentialSets(state)
  const here = state.agents.filter(a => a.machineId === machineId && a.machineOwnerId === user.sub)
  const where = whereabouts(state, here, machineId)
  for (const target of here) {
    try { agent(state, target.id); await lookups.agentGrant(target) } catch (error) { if (error instanceof SuperTabError) continue; throw error }
    rows.push(agentRow(tabId, state, machineId, user, lastChangedAt, lookups, target, sets, where.get(target.id)!))
  }
  for (const { agentId: id, harnessId } of (state.closingSessions ?? []).filter(c => c.machineId === machineId && c.machineOwnerId === user.sub)) {
    rows.push({ tabId, agent: { id, harnessId, machineId }, closeSession: true, active: false })
  }
  rows.push(...cleanups(state).filter(c => c.machineId === machineId && c.machineOwnerId === user.sub)
    .map(({ removalId }) => ({ tabId, cleanup: { machineId, removalId } })))
  return rows
}

function agentRow(tabId: string, state: SuperTabState, machineId: string, user: AuthUser, lastChangedAt: number | null, lookups: HostLookups, target: Agent,
  sets: ConfidentialSets, { active, working, waiting, projectId, led }: Whereabouts): HostAgentRow {
  const closed = lookups.confidential.has(target.id)
  return {
    tabId, tabName: state.name, lastChangedAt, paused: state.paused,
    // `active` lets the host release members that are only in archived groups to automatic cleanup.
    active,
    attention: waiting ? { assignmentId: waiting.id, status: waiting.status, result: waiting.result?.slice(0, 500) ?? null } : null,
    // No task resumes after a usage limit since Swarm v4 (work.resume is retired, 2026-11-10): an older host still reads the
    // field (cli superTabs/limitResume.ts, gone from the CLI since #3864), so it stays, always empty, until 2026-12-09.
    resume: null,
    agent: target,
    // The Swarm owner's host adds the machine any live agent of theirs runs on, in any Swarm they own: a Lead, or a plain v4 agent, which
    // leads nothing (a Personal Swarm may hold nothing else, and never got its machine). Since #4120 a machine takes only its own person's
    // agents, so this adds no one else's work to it. Not where machine.contribute would refuse it (#2637). Never
    // a machine its person took out of the Swarm (removedMachines): an older host adds it back on this word alone (cli host.ts); a person
    // who wants it back adds it.
    joinSwarm: state.ownerId === user.sub && target.contributorId === user.sub
      && active
      && !state.machines?.some(m => m.machineId === machineId) && !state.removedMachines?.some(r => r.machineId === machineId)
      && !machineLimitReached(state, user.sub),
    skillMode: 'default',
    lead: !!led,
    // Swarm v4 restarts no PM on the server's word (timeChecks.ts): an older host still reads the field, so it stays, always empty.
    owed: null,
    // Removed (model.ts leadsRemoved); an older CLI still reads the field, so it stays, always empty.
    leadsConversationId: null,
    // The conversation it leads: the chat its host rebuilds its start prompt from when it switches it (cli leadSwitchRequest.ts).
    // A field of its own: an older host reads leadsConversationId as "only this conversation's deliveries" (cli host.ts).
    ledConversationId: led?.leadConversationId ?? null,
    stopRequested: target.workDecision === 'stop' && !working,
    observers: lookups.people.filter(p => p.id !== user.sub && canWatchAgent(state, { kind: 'person', userId: p.id, email: p.email }, target, closed, sets, projectId))
      .map(p => ({ email: p.email, userId: p.id })),
    // The host refuses every share of a confidential session, ordinary ones too, and remembers it (cli observers.ts).
    confidential: isConfidential(state, target, closed, sets),
    // But for this Swarm's current Lead: its listed observers watch it while this row is in force (Ken, 2026-10-28).
    membersWatch: isConfidential(state, target, closed, sets) && !watchClosed(state, target, closed, sets),
  }
}

function pool(tabId: string, state: SuperTabState, machineId: string, user: AuthUser): HostPool | null {
  let contribution
  try { contribution = machineContribution(state, machineId) } catch (error) { if (error instanceof SuperTabError) return null; throw error }
  if (!contribution || contribution.contributorId !== user.sub) return null
  const pending = (state.starts ?? []).filter(s => s.request.machineId === machineId && s.poolGeneration === contribution.generation
    && (!s.harnessId || !s.poolSettled) && !s.error)
  // No host sees a Product Manager's start (leadStart.ts) but one that said it starts one.
  // Nor a Regular agent (commands.ts agent.new, task #4116), which an older host would launch in a project folder it lacks.
  const starts = pending.filter(s => !s.request.leadFor && !s.request.regular)
  const regularStarts = pending.filter(s => s.request.regular)
  const leadStarts = pending.filter(s => s.request.leadFor)
  const reservations = (state.harnessReservations ?? []).filter(r => r.machineId === machineId)
  const removedHere = (state.removedSessions ?? []).filter(r => r.machineId === machineId).map(r => r.harnessId)
  return { tabId, paused: state.paused, machine: contribution, starts, ...(leadStarts.length ? { leadStarts } : {}),
    ...(regularStarts.length ? { regularStarts } : {}),
    ...(contribution.scope === 'swarm' ? { projects: projectsOf(state).filter(p => pending.some(s => startProject(state, s.request)?.id === p.id))
      .map(p => ({ id: p.id, leadConversationId: p.leadConversationId, repository: p.repository,
        // A private conversation is chat only and never runs work here, so its id stays with its audience.
        conversationIds: state.conversations.filter(c => !isLeads(c) && !c.audience && groupProject(state, c).id === p.id).map(c => c.id) })) } : {}),
    ...hostLocalGrid(state),
    reservations: reservations.map(({ harnessId, generation }) => ({ harnessId, generation })),
    // Sessions whose agents left as closed, which this host lists again if they reopen (closedAgents.ts restoreSessions). Ids only,
    // and only to the machine's own host. Absent when there are none.
    ...(removedHere.length ? { removedHarnessIds: removedHere } : {}),
    harnessIds: [...new Set([...state.agents.filter(a => a.machineId === machineId).map(a => a.harnessId), ...reservations.map(r => r.harnessId),
      ...(state.starts ?? []).filter(s => s.request.machineId === machineId && s.harnessId).map(s => s.harnessId!)])],
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
