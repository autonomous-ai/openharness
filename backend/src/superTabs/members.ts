/**
 * anh Dee's agent model (task #4697, card #4693 part A, 11-07 21:20): one Member per person and project, made on their first
 * accepted task there, which takes that project's tasks they ask for one at a time and sleeps between them; helpers only by
 * three checks; and every asked task needs its person's Accept.
 */
import { openTasks } from './dispatch.js'
import { agentProjectId } from './projects.js'
import { QUOTA_FLOOR_PERCENT } from './crewRules.js'
import { availableSlots, downSince, machineSlots, type ContributedMachine } from './machines.js'
import { ownedPath, pathsOverlap } from './ownedPaths.js'
import { activeWork, occupiesAgent, type Agent, type AgentStart, type Conversation, type SuperTabState } from './model.js'

/** Whether [personId] may choose Accept all: off for Claude and ChatGPT subscriptions until Anthropic and OpenAI confirm it in
 *  writing (anh Dee). Every engine on their own computers must be an API key, a known quota with no windows
 *  (costs/attempts.ts billingOf); an engine whose kind is not known yet counts as a subscription. */
export function mayAcceptAll(state: SuperTabState, personId: string): boolean {
  const engines = (state.machines ?? []).filter(m => m.contributorId === personId && !m.removal)
    .flatMap(m => m.engines.map(engine => m.observation?.quotas.find(q => q.engine === engine)))
  return engines.length > 0 && engines.every(q => !!q?.known && q.windows.length === 0)
}

export const ACCEPT_ALL_REFUSAL = 'Accept all stays off for Claude and ChatGPT subscriptions until Anthropic and OpenAI confirm it in writing. Accept each task.'

/** [personId]'s Member in [projectId] (task #4697): their running agent with that main project, else its start still pending.
 *  A helper is no Member, and nor is an agent that is stopping or from an earlier membership. */
export function memberOf(state: SuperTabState, personId: string, projectId: string): { agent?: Agent; start?: AgentStart } | undefined {
  const person = state.people.find(p => p.id === personId)
  if (!person) return undefined
  const agent = state.agents.find(a => a.regular && a.mainProjectId === projectId && a.contributorId === personId && !a.helperOf
    && a.membershipGeneration === person.generation && a.workDecision !== 'stop')
  if (agent) return { agent }
  const start = (state.starts ?? []).find(s => s.request.member?.projectId === projectId && s.contributorId === personId
    && !s.request.helperOf && !s.harnessId && !s.error)
  return start ? { start } : undefined
}

/** The computer [personId]'s Member runs on: their own, listed, reporting and running Regular agents, never a Team account,
 *  a Buddy-only record or one shared with them (v3: an agent starts only on its own person's computer). */
export function memberMachine(state: SuperTabState, personId: string, capability: string): ContributedMachine | undefined {
  return (state.machines ?? []).find(m => m.contributorId === personId && !m.buddyOnly && !m.removal && !m.paused && !m.hostMachineId
    && !!m.observation && m.observation.sessionKind !== 'team' && !!m.observation.capabilities?.includes(capability))
}

/** The host capability of #4698: its Member reports the project set up (agent.setUp) before it is handed work. */
export const MEMBER_SET_UP_CAPABILITY = 'memberSetUp'

const RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/** [personId]'s tasks waiting in [projectId], in the order their Member takes them: priority (P0 first, P2 when unset), then
 *  age (the lower task number). Only what may start now (dispatch.ts openTasks): accepted, not paused, nobody on it. */
export function memberQueue(state: SuperTabState, projectId: string, personId: string, now: number): Conversation[] {
  return openTasks(state, projectId, now).filter(g => !g.reviewOf && g.requesterId === personId)
    .sort((a, b) => (RANK[a.priority ?? 'P2'] ?? 2) - (RANK[b.priority ?? 'P2'] ?? 2) || (a.number ?? 0) - (b.number ?? 0))
}

/** Whether [group] is another person's ask, never [agent]'s to take on its own (task #4697): it goes to its person's Member, so
 *  one person's work never runs under another person's login (AGENTS.md, Secure). */
export const askedByAnother = (state: SuperTabState, group: Conversation, agent: Agent): boolean =>
  !!group.requesterId && group.requesterId !== agent.contributorId && state.people.some(p => p.id === group.requesterId)

/** Whether [agent] holds no task now, and is not stopping, gone or still launching (an asleep one is free: its assignment wakes
 *  it). */
export const freeAgent = (state: SuperTabState, agent: Agent, now: number): boolean =>
  agent.workDecision !== 'stop' && (!!agent.asleep || !downSince(state, agent, now))
  && !(state.starts ?? []).some(s => s.harnessId === agent.harnessId && s.request.machineId === agent.machineId && !s.poolSettled && !s.error)
  && !state.conversations.some(c => c.assignment?.agentId === agent.id && occupiesAgent(c))

/** Whether [agent] has set [projectId] up, on a host that reports it; any other host's Member is ready once it runs. */
export function setUpReady(state: SuperTabState, agent: Agent, projectId: string): boolean {
  const host = (state.machines ?? []).find(m => m.machineId === agent.machineId)
  if (!host?.observation?.capabilities?.includes(MEMBER_SET_UP_CAPABILITY)) return true
  return agent.setUp?.projectId === projectId && !agent.setUp.failed
}

const ownCrewIn = (state: SuperTabState, personId: string, projectId: string): boolean =>
  state.agents.some(a => a.crew && a.contributorId === personId && a.workDecision !== 'stop' && agentProjectId(state, a) === projectId)

export type MemberPick = { kind: 'assign'; conversationId: string; agentId: string } | { kind: 'start' | 'helper'; conversationId: string }

export type HelperCheck = { ok: true } | { ok: false; reason: 'overlap' | 'room' | 'quota' }
export const HELPER_REFUSALS: Record<'overlap' | 'room' | 'quota', string> = {
  overlap: 'This task touches code its Member\'s work is on, or names none to tell: it waits for the Member.',
  room: 'Its Member\'s computer has no room for another agent under its limit: it waits.',
  quota: 'Its Member\'s quota is at the floor, or not known: it waits.',
}

/** The paths owned by the work [member] and its helpers have running, or null when one names none to compare. */
function runningPaths(state: SuperTabState, member: Agent): string[] | null {
  const team = new Set(state.agents.filter(a => a.id === member.id || a.helperOf?.agentId === member.id).map(a => a.id))
  const paths = state.conversations.filter(c => activeWork(c) && team.has(c.assignment!.agentId)).map(c => (c.task?.owns ?? []).map(ownedPath))
  return paths.some(p => !p.length || p.includes(null)) ? null : paths.flat() as string[]
}

/** Whether a helper may start for [task] while [member] is busy (anh Dee, task #4697), all three: the task's code overlaps none of
 *  the work running (a task naming no code to compare cannot be told apart, so it waits), the Member's computer has room under
 *  its limit, and its engine's quota there is known with every window above the floor. [planned]: what this pass already plans. */
export function helperCheck(state: SuperTabState, member: Agent, task: Conversation, now: number,
  planned: { paths: string[]; slots: number } = { paths: [], slots: 0 }): HelperCheck {
  const mine = (task.task?.owns ?? []).map(ownedPath)
  const running = runningPaths(state, member)
  if (!mine.length || mine.includes(null) || running === null
    || mine.some(p => [...running, ...planned.paths].some(r => pathsOverlap(p!, r)))) return { ok: false, reason: 'overlap' }
  const pool = (state.machines ?? []).find(m => m.machineId === member.machineId)
  if (!pool || availableSlots(state, pool, machineSlots(state, pool)) - planned.slots <= 0) return { ok: false, reason: 'room' }
  const quota = pool.observation?.quotas.find(q => q.engine === member.configuration.engine)
  if (!quota?.known || quota.windows.some(w => 100 - w.usedPercent <= QUOTA_FLOOR_PERCENT)) return { ok: false, reason: 'quota' }
  return { ok: true }
}

const ownPaths = (task: Conversation): string[] => (task.task?.owns ?? []).map(ownedPath).filter((p): p is string => !!p)

/** What [projectId]'s dispatch pass does for the people whose tasks wait there (store.ts), each person's tasks in queue order: a
 *  helper in a task's own conversation takes it; else the free, set-up Member takes the first; while it is busy, a free helper
 *  takes one touching no running code, or a helper is started where helperCheck allows; a person with no Member yet gets one
 *  started (their first task may need no Accept). Anything else waits. */
export function memberPlan(state: SuperTabState, projectId: string, now: number): MemberPick[] {
  const people = new Set(openTasks(state, projectId, now).filter(g => !g.reviewOf && g.requesterId && state.people.some(p => p.id === g.requesterId))
    .map(g => g.requesterId!))
  const out: MemberPick[] = []
  for (const personId of people) {
    const queue = memberQueue(state, projectId, personId, now)
    if (!queue.length) continue
    const member = memberOf(state, personId, projectId)
    // A person whose own crew agent works in this project keeps it taking their asks (crew.ts), until the migration
    // (#4693 part D) makes it their Member: never two agents of theirs racing for one task.
    if (!member && ownCrewIn(state, personId, projectId)) continue
    if (!member) { out.push({ kind: 'start', conversationId: queue[0]!.id }); continue }
    const lead = member.agent
    if (!lead) continue
    const helpers = state.agents.filter(a => a.helperOf?.agentId === lead.id && a.workDecision !== 'stop')
    const used = new Set<string>(), planned = { paths: [] as string[], slots: 0 }
    const take = (task: Conversation, agent: Agent) => { out.push({ kind: 'assign', conversationId: task.id, agentId: agent.id }); used.add(agent.id); planned.paths.push(...ownPaths(task)) }
    const memberFree = freeAgent(state, lead, now) && setUpReady(state, lead, projectId)
    // Helpers are only for while the Member holds a task: one still setting up, or asleep, is not busy.
    const memberBusy = state.conversations.some(c => c.assignment?.agentId === lead.id && occupiesAgent(c))
    for (const task of queue) {
      // Its helper is starting: it takes this task once it runs.
      if ((state.starts ?? []).some(s => s.request.helperOf && s.request.conversationId === task.id && !s.error && (!s.harnessId || !s.poolSettled))) continue
      const own = helpers.find(h => !used.has(h.id) && task.agentIds.includes(h.id) && freeAgent(state, h, now))
      if (own) { take(task, own); continue }
      if (memberFree && !used.has(lead.id)) { take(task, lead); continue }
      const idle = helpers.find(h => !used.has(h.id) && freeAgent(state, h, now))
      if (idle && memberBusy && helperCheck(state, lead, task, now, planned).ok) { take(task, idle); continue }
      if (!idle && memberBusy && helperCheck(state, lead, task, now, planned).ok) {
        out.push({ kind: 'helper', conversationId: task.id }); planned.slots++; planned.paths.push(...ownPaths(task))
      }
    }
  }
  return out
}
