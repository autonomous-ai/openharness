/** Whether new Reviewers can still start for a project's builds, said once in its chat when they cannot or soon will not.
 *  Overnight 2026-10-30, 12 pull requests waited hours for a review: every Codex Reviewer was out of weekly quota, a Claude
 *  Reviewer may not check a Claude build (rules.ts judgeReview), and nobody was told until people noticed in the morning
 *  (Tony: "don't let the workflow get stuck"). Checked when an Engineer hands work over for review (commands.ts work.status). */
import type { Conversation, SuperTabState } from './model.js'
import { canReadProject, groupProject, projectRules } from './projects.js'
import { canStart, STANDING, standing, type Standing } from './reviewSeats.js'
import { liftEffort, otherFamilyReviews, type MayRun } from './rules.js'
import type { RoutingPolicy } from './routingPolicy.js'
import { usernameOf } from './usernames.js'

export { RELAYED_QUOTA } from './reviewSeats.js'
const ENGINES = ['claude', 'codex'] as const
const NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

export type Cause = 'out' | 'low'
export interface ReviewCapacityNotice { conversationId: string; text: string; mentions: string[]; source: { kind: 'review-capacity'; engine: string; cause: Cause } }

/** Each machine the project may start a Reviewer of [engine] on, on a policy row of [quality] or more, as one: a Mac and its
 *  Harness Team account are one machine (machines.ts teamStartRequest), standing as the better of the two. */
function seats(state: SuperTabState, group: Conversation, engine: string, policy: RoutingPolicy, mayRun: MayRun, now: number, quality = 2) {
  const rules = projectRules(state, groupProject(state, group).id)
  const rows = policy.models.filter(row => row.enabled && row.engine === engine && row.quality >= quality)
  const byMac = new Map<string, { name: string; contributorId: string; standing: Standing }>()
  for (const pool of state.machines ?? []) {
    if (pool.buddyOnly || pool.removal || !pool.engines.includes(engine)) continue
    if (!rows.some(row => mayRun({ machineId: pool.machineId, engine, model: row.model, effort: liftEffort(rules, engine, row.effort) }, pool.contributorId))) continue
    const key = pool.hostMachineId ?? pool.machineId, here = standing(state, pool, engine, now), seen = byMac.get(key)
    if (!seen) byMac.set(key, { name: pool.name, contributorId: pool.contributorId, standing: here })
    else if (STANDING.indexOf(here) < STANDING.indexOf(seen.standing)) seen.standing = here
  }
  return [...byMac.values()]
}

/**
 * The notice for [group]'s review when no new Reviewer on another engine than its Builder's can start on any machine the
 * project may use (cause `out`), or when each is close to running out of weekly quota (`low`); null otherwise. Said once
 * per cause and engine: the project keeps which it last said, and forgets it once a machine is usable again. With no
 * machine of the other engine at all the Builder's own engine reviews at its top tier (rules.ts), so nothing is said; nor
 * for a build on a grid model, which either engine reviews. While a top-tier Reviewer of the Builder's own engine can start,
 * reviews fall back to it (rules.ts judgeReview), and the notice says so rather than that they cannot start. Tags the
 * owners of those machines who read the project and have a username.
 */
export function reviewCapacityNotice(state: SuperTabState, group: Conversation, policy: RoutingPolicy, mayRun: MayRun, now: number): ReviewCapacityNotice | null {
  const assignment = group.assignment
  if (!assignment) return null
  const worker = state.agents.find(a => a.id === assignment.agentId)
  if (worker?.gridModel) return null
  const built = worker?.configuration.engine ?? assignment.configuration.engine
  const engine = ENGINES.find(e => e !== built)
  if (!engine) return null
  const project = groupProject(state, group)
  const places = seats(state, group, engine, policy, mayRun, now)
  const said = project.reviewCapacity?.[engine]
  const forget = () => {
    if (!said) return
    const { [engine]: _gone, ...others } = project.reviewCapacity!
    if (Object.keys(others).length) project.reviewCapacity = others
    else delete project.reviewCapacity
  }
  if (!places.length || places.some(p => p.standing === 'usable')) { forget(); return null }
  const cause: Cause = places.some(p => p.standing === 'close to running out') ? 'low' : 'out'
  // Out after low is news; low after out is not, but is kept so running out again is.
  if (said === cause || (said === 'out' && cause === 'low')) { project.reviewCapacity = { ...project.reviewCapacity, [engine]: cause }; return null }
  project.reviewCapacity = { ...project.reviewCapacity, [engine]: cause }

  const person = (id: string) => state.people.find(p => p.id === id)
  const reads = (id: string) => { const p = person(id); return !!p && canReadProject(state, { kind: 'person', userId: p.id, email: p.email }, project) }
  // A machine of someone who cannot read this project is not named here.
  const list = places.map(p => `${reads(p.contributorId) ? p.name : 'another machine'}: ${p.standing}`).join('; ')
  // A tag is a username; someone without one is not tagged, never named by their email (review of #2275).
  const mentions = [...new Set(places.map(p => p.contributorId))].filter(id => reads(id) && usernameOf(state, id))
  const who = mentions.map(id => `@${usernameOf(state, id)}`).join(' ')
  const fixes = `More ${NAME[engine]} quota, ${NAME[engine]} signed in on another machine, a paused machine resumed, or another machine in the Swarm`
  // Reviews fall back only as the server's own judgement lets them (rules.ts judgeReview): it also counts an agent of the
  // other engine on a host outside the contributions, which the machines above leave out (re-review of #2275).
  const fallback = cause === 'out' && !otherFamilyReviews(state, { engine: built }, policy, mayRun, now)
    && seats(state, group, built, policy, mayRun, now, 3).some(p => canStart(p.standing))
  const text = (cause === 'low'
    ? `${NAME[engine]} quota for reviewing ${NAME[built]} builds is close to running out on every machine this project may use (${list}). ${fixes} would keep reviews going.`
    : fallback
      ? `Reviews of ${NAME[built]} builds fall back to ${NAME[built]} at its top tier: ${NAME[engine]} is unavailable on every machine this project may use (${list}). ${fixes} would bring back reviews on another engine.`
      : `Reviews of ${NAME[built]} builds cannot start a new Reviewer: ${NAME[engine]} is unavailable on every machine this project may use (${list}). ${fixes} would unblock them.`)
    + (who ? ` ${who} can fix it.` : '')
  return { conversationId: project.leadConversationId, text, mentions, source: { kind: 'review-capacity', engine, cause } }
}
