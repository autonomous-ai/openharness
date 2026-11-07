/** Which Buddies a message wakes: those it is delivered to. No agent relays news to its person (anh Dee, 11-07, task #4623):
 *  their card shows accepted, working and shipped (task #4547), and every question for them is a Decision. */
import { isBuddy } from './buddies.js'
import { type Agent, type MessageDraft, type SuperTabState } from './model.js'

/** Every Buddy hearing input, in its own chat too: the agent guard meets a concurrent sleep (#3824), and the person's
 *  guard meets loss of the membership that permits the delivery (parts/touches.ts). */
export function buddiesHearing(state: SuperTabState, messages: readonly MessageDraft[]): Agent[] {
  const ids = new Set(messages.flatMap(m => m.recipients))
  return state.agents.filter(a => ids.has(a.id) && isBuddy(a))
}
