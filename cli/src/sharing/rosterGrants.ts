/**
 * Who may watch this computer's harnesses because a shared tab lists them (step 1b of shared tabs across accounts):
 * every other account in the tab, its owner and its accepted members, gets a read-only observer grant to each harness
 * the tab lists on this machine under this account. Decided here from the rosters this computer verified against
 * their pins (messages/rosterStore.ts): the backend's listings are never enough to grant anything, and a roster that
 * lists this machine under another account (a foreign owner's word about a harness that is not theirs) grants nothing.
 * An invitation not yet accepted gets nothing: only someone who joined the tab watches it.
 *
 * The owner signs the roster, and could list a member's harness the member never asked to share, or list it again after
 * the member took it out (review of C1, 2026-10-16). So on a member's computer a harness counts only if this machine
 * asked for it in that tab (`consent`, messages/consentStore.ts); the owner's own harnesses, on its own machines, came
 * from its own desk and need no asking.
 */
import { consentKey } from '../messages/consentStore.js'
import type { Roster } from '../messages/roster.js'

export interface RosterGrant { agentId: string; email: string; tab: string; name: string; engine: string }

export function rosterGrants(rosters: Roster[], self: { machineId: string; accountId: string }, consent: ReadonlySet<string>): RosterGrant[] {
  return rosters.flatMap(roster => {
    const accounts = [roster.owner, ...roster.members]
    const owner = roster.owner.accountId === self.accountId
    return roster.harnesses
      .filter(h => h.machineId === self.machineId && h.accountId === self.accountId
        && (owner || consent.has(consentKey(roster.sharedTabId, h.machineId, h.agentId))))
      .flatMap(h => accounts.filter(a => a.accountId !== h.accountId)
        .map(a => ({ agentId: h.agentId, email: a.email, tab: roster.sharedTabId, name: h.name, engine: h.engine })))
  })
}
