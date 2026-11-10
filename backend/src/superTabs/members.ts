/**
 * anh Dee's agent model (task #4697, card #4693 part A, 11-07 21:20): one Member per person and project, made on their first
 * accepted task there, which takes that project's tasks they ask for one at a time and sleeps between them. Swarm v4 retired
 * task approval (2026-11-10), so none starts now; one started before still takes only what its person accepted.
 */
import { type Agent, type Conversation, type SuperTabState } from './model.js'

/** Whether [personId] may choose Accept all: off for Claude and ChatGPT subscriptions until Anthropic and OpenAI confirm it in
 *  writing (anh Dee). Every engine on their own computers must be an API key, a known quota with no windows
 *  (costs/attempts.ts billingOf); an engine whose kind is not known yet counts as a subscription. */
function mayAcceptAll(state: SuperTabState, personId: string): boolean {
  const engines = (state.machines ?? []).filter(m => m.contributorId === personId && !m.removal)
    .flatMap(m => m.engines.map(engine => m.observation?.quotas.find(q => q.engine === engine)))
  return engines.length > 0 && engines.every(q => !!q?.known && q.windows.length === 0)
}

/** Whether [group]'s requester accepted it (security review 1 of #3575): their Accept, or the Accept all they may choose (API
 *  accounts alone). Only then does their Member take it, or an agent start on their computer for it: anyone may name them
 *  requester, and a person who never chose a mode has nothing staged to accept. */
function acceptedByRequester(state: SuperTabState, group: Conversation): boolean {
  const person = state.people.find(p => p.id === group.requesterId)
  if (!person) return false
  if (group.taskApproval) return group.taskApproval.state === 'approved' && group.taskApproval.personId === person.id
  return person.approvalMode === 'autoApprove' && mayAcceptAll(state, person.id)
}



/** Whether [group] is another person's accepted ask, never [agent]'s to take on its own (task #4697): it goes to its person's
 *  Member, so one person's work never runs under another person's login (AGENTS.md, Secure). An ask they have not accepted
 *  stays with the crew as before, until Accept on every task (follow-up of #4697). */
export const askedByAnother = (state: SuperTabState, group: Conversation, agent: Agent): boolean =>
  !!group.requesterId && group.requesterId !== agent.contributorId && acceptedByRequester(state, group)
