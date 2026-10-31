/** Whether new agents can still start for a project's work, said once in its chat when they cannot or soon will not.
 *  Overnight 2026-10-30, 12 pull requests waited hours for a review while every Codex Reviewer was out of weekly quota, and
 *  nobody was told until people noticed in the morning (Tony: "don't let the workflow get stuck"). The notice states the fact
 *  only: no machine the project may use can start either engine (project instructions, phase 4: no policy, quality or rules,
 *  and no next step). Checked when work is handed over for review (commands.ts work.status). */
import type { Conversation, SuperTabState } from './model.js'
import { canReadProject, groupProject } from './projects.js'
import { STANDING, standing, type Standing } from './reviewSeats.js'
import { usernameOf } from './usernames.js'

export { RELAYED_QUOTA } from './reviewSeats.js'
const ENGINES = ['claude', 'codex'] as const
/** The key the project keeps what it last said under. Before 2026-10-30 it kept one per engine (`claude`, `codex`); those
 *  are dropped the next time it writes. */
const ANY = 'any'

export type Cause = 'out' | 'low'
export interface ReviewCapacityNotice { conversationId: string; text: string; mentions: string[]; source: { kind: 'review-capacity'; engine: string; cause: Cause } }

/** Each machine the project may start an agent on ([teamOk]: machines.ts teamWorkCheck), of either engine it has, as one: a
 *  Mac and its Harness Team account are one machine (machines.ts teamStartRequest), standing as the best of its engines and
 *  accounts. */
function seats(state: SuperTabState, now: number, teamOk: (machineId: string, contributorId: string) => boolean) {
  const byMac = new Map<string, { name: string; contributorId: string; standing: Standing }>()
  for (const pool of state.machines ?? []) {
    if (pool.buddyOnly || pool.removal || !teamOk(pool.machineId, pool.contributorId)) continue
    for (const engine of ENGINES) {
      if (!pool.engines.includes(engine)) continue
      const key = pool.hostMachineId ?? pool.machineId, here = standing(state, pool, engine, now), seen = byMac.get(key)
      if (!seen) byMac.set(key, { name: pool.name, contributorId: pool.contributorId, standing: here })
      else if (STANDING.indexOf(here) < STANDING.indexOf(seen.standing)) seen.standing = here
    }
  }
  return [...byMac.values()]
}

/**
 * The notice for [group]'s hand-over when no new agent of either engine can start on any machine the project may use
 * (cause `out`), or when each one that could is close to running out of weekly quota (`low`); null otherwise. Said once
 * per cause: the project keeps which it last said, and forgets it once a machine is usable again. With no machine at all
 * the project may use nothing is said, as before: a Swarm whose agents run on hosts outside the contributions reports
 * no readings to judge. Tags the owners of those machines who read the project and have a username.
 */
export function reviewCapacityNotice(state: SuperTabState, group: Conversation, now: number,
  teamOk: (machineId: string, contributorId: string) => boolean): ReviewCapacityNotice | null {
  if (!group.assignment) return null
  const project = groupProject(state, group)
  const places = seats(state, now, teamOk)
  const said = project.reviewCapacity?.[ANY]
  // Written only when it changes, so an ordinary Ready for review writes nothing to the project.
  if (!places.length || places.some(p => p.standing === 'usable')) { if (project.reviewCapacity) delete project.reviewCapacity; return null }
  const cause: Cause = places.some(p => p.standing === 'close to running out') ? 'low' : 'out'
  if (said !== cause || Object.keys(project.reviewCapacity ?? {}).length !== 1) project.reviewCapacity = { [ANY]: cause }
  // Out after low is news; low after out is not, but is kept so running out again is.
  if (said === cause || (said === 'out' && cause === 'low')) return null

  const person = (id: string) => state.people.find(p => p.id === id)
  const reads = (id: string) => { const p = person(id); return !!p && canReadProject(state, { kind: 'person', userId: p.id, email: p.email }, project) }
  // A machine of someone who cannot read this project is not named here.
  const list = places.map(p => `${reads(p.contributorId) ? p.name : 'another machine'}: ${p.standing}`).join('; ')
  // A tag is a username; someone without one is not tagged, never named by their email (review of #2275).
  const mentions = [...new Set(places.map(p => p.contributorId))].filter(id => reads(id) && usernameOf(state, id))
  const who = mentions.map(id => `@${usernameOf(state, id)}`).join(' ')
  const text = (cause === 'low'
    ? `Quota for new agents is close to running out on every machine this project may use (${list}).`
    : `No new agent can start: no machine this project may use can run Claude Code or Codex now (${list}).`)
    + (who ? ` ${who} can fix it.` : '')
  return { conversationId: project.leadConversationId, text, mentions, source: { kind: 'review-capacity', engine: ANY, cause } }
}
