/**
 * What an agent is to the person who brought it (Swarm v3, task #4116; anh Dee 11-07): a PM that leads a project, or a
 * Regular agent, which no project holds and whose task decides where it works. The left pane's "My agents" lists the
 * reader's own by this, a crown beside a PM, each bold while its chat has news the reader has not read (their read marks).
 */
import type { Actor, Agent, Conversation, SuperTabState } from './model.js'
import { isAgentChat, ledProject, projectsOf } from './projects.js'

export type AgentKind = 'pm' | 'regular'
/** Members and Leads (task #4540; spec 2026-11-07-members-and-leads): a Lead leads a project, every other agent is a Member.
 *  Derived, never stored; `kind` stays beside it for clients until 2026-12-07. */
export type AgentRole = 'lead' | 'member'

/** The project each Lead leads, by its agent id, from one pass (projects.ts ledProject scans every conversation per call): a
 *  read derives every agent's role and main project from it. The first project in order, as ledProject picks. */
export function ledProjects(state: SuperTabState): Map<string, string> {
  const chats = new Map(state.conversations.map(c => [c.id, c]))
  const led = new Map<string, string>()
  for (const project of projectsOf(state)) {
    const leadId = chats.get(project.leadConversationId)?.leadId
    if (leadId && !led.has(leadId)) led.set(leadId, project.id)
  }
  return led
}

export function agentKind(state: SuperTabState, target: Agent): AgentKind {
  return ledProject(state, target.id) ? 'pm' : 'regular'
}

/** The chat [target]'s person talks to it in: its own chat (agent.new, and a PM's since
 *  Swarm v4, whose project chat is the channel only agents post in), else a PM's project chat (a PM from before); none for an
 *  agent started before chats of their own. */
export function agentChatId(state: SuperTabState, target: Agent, reads: (chat: Conversation) => boolean = () => true): string | null {
  // Another person's own chat with their agent is theirs alone: its id goes only to who reads it, as a change read sends it.
  const own = state.conversations.find(c => (c.id === target.chatId || isAgentChat(c) && c.agentIds.includes(target.id)) && reads(c))?.id
  return own ?? ledProject(state, target.id)?.leadConversationId ?? null
}

/** Whether [target] is in [actor]'s My agents (task #4192, anh Dee 11-07: his list showed about 30 rows, agents he never
 *  started among them): an agent they brought that runs on their own account, is running and is not
 *  finished or being stopped. A PM leading a project stays while its session restarts: its project chat is its person's. */
export function inMyAgents(state: SuperTabState, actor: Actor, target: Agent): boolean {
  if (actor.kind !== 'person' || target.contributorId !== actor.userId) return false
  if (target.workDecision === 'awaiting' || target.workDecision === 'stop') return false
  return (!target.downSince && !target.asleep) || !!ledProject(state, target.id)
}
