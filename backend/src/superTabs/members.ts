/**
 * anh Dee's agent model (task #4697, card #4693 part A, 11-07 21:20): one Member per person and project, made on their first
 * accepted task there, which takes that project's tasks they ask for one at a time and sleeps between them; helpers only by
 * three checks; and every asked task needs its person's Accept.
 */
import { openTasks } from './dispatch.js'
import { downSince, type ContributedMachine } from './machines.js'
import { occupiesAgent, type Agent, type AgentStart, type Conversation, type SuperTabState } from './model.js'

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

export type MemberPick = { kind: 'assign'; conversationId: string; agentId: string } | { kind: 'start'; conversationId: string }

/** What [projectId]'s dispatch pass does for the people whose tasks wait there (store.ts): each person's free, set-up Member
 *  is handed their next task; a person with none yet gets one started (their first task may need no Accept). */
export function memberPlan(state: SuperTabState, projectId: string, now: number): MemberPick[] {
  const people = new Set(openTasks(state, projectId, now).filter(g => !g.reviewOf && g.requesterId && state.people.some(p => p.id === g.requesterId))
    .map(g => g.requesterId!))
  const out: MemberPick[] = []
  for (const personId of people) {
    const [next] = memberQueue(state, projectId, personId, now)
    if (!next) continue
    const member = memberOf(state, personId, projectId)
    if (!member) out.push({ kind: 'start', conversationId: next.id })
    else if (member.agent && freeAgent(state, member.agent, now) && setUpReady(state, member.agent, projectId)) {
      out.push({ kind: 'assign', conversationId: next.id, agentId: member.agent.id })
    }
  }
  return out
}
