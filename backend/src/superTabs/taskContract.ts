/**
 * The task contract (task #3389, Dee's Swarm redesign, 2026-11-05): a task an agent opens says its goal, how to tell it is
 * done (at least one check), its priority and who asked. People keep today's defaults; the server refuses an agent's create
 * that leaves one out, naming the fields and showing a whole create, so the fix is one resend. The code is new on purpose:
 * the refusals project instructions removed (removedRefusals.test.ts) stay removed.
 */
export const CONTRACT_FIELDS = ['goal', 'checks', 'priority', 'requester'] as const
export type ContractField = typeof CONTRACT_FIELDS[number]

/** What a create gave. `requester` is the person already resolved from requesterId, a proposal or a request message. */
export interface ContractGiven { goal: string; checks: number; priority: boolean; requester: boolean }

export const missingContract = (given: ContractGiven): ContractField[] => CONTRACT_FIELDS.filter(field =>
  field === 'goal' ? !given.goal.trim() : field === 'checks' ? given.checks < 1 : field === 'priority' ? !given.priority : !given.requester)

const EXAMPLE = '{"type":"conversation.create","title":"Short plain title","task":{"goal":"What to build","changes":"...","constraints":"...","owns":["path/"]},'
  + '"checks":[{"description":"Observable proof it is done","independent":false}],"priority":"P2","requesterId":"PERSON"}'

/** The refusal's text: what is missing, the next step, and an example. */
export const contractRefusal = (missing: readonly ContractField[]): string =>
  `Missing: ${missing.join(', ')}. A task an agent opens says its goal, at least one check that says when it is done, a priority (P1, P2 or P3) and the person who asked (requesterId). `
  + `Add ${missing.length === 1 ? 'it' : 'them'} and send the create again, for example ${EXAMPLE}`
