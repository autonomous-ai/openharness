/**
 * anh Dee's agent model (task #4697, card #4693 part A, 11-07 21:20): one Member per person and project, made on their first
 * accepted task there, which takes that project's tasks they ask for one at a time and sleeps between them; helpers only by
 * three checks; and every asked task needs its person's Accept.
 */
import type { SuperTabState } from './model.js'

/** Whether [personId] may choose Accept all: off for Claude and ChatGPT subscriptions until Anthropic and OpenAI confirm it in
 *  writing (anh Dee). Every engine on their own computers must be an API key, a known quota with no windows
 *  (costs/attempts.ts billingOf); an engine whose kind is not known yet counts as a subscription. */
export function mayAcceptAll(state: SuperTabState, personId: string): boolean {
  const engines = (state.machines ?? []).filter(m => m.contributorId === personId && !m.removal)
    .flatMap(m => m.engines.map(engine => m.observation?.quotas.find(q => q.engine === engine)))
  return engines.length > 0 && engines.every(q => !!q?.known && q.windows.length === 0)
}

export const ACCEPT_ALL_REFUSAL = 'Accept all stays off for Claude and ChatGPT subscriptions until Anthropic and OpenAI confirm it in writing. Accept each task.'
