/** Whether new Reviewers can still start for a project's builds, said once in its chat when they cannot or soon will not.
 *  Overnight 2026-10-30, 12 pull requests waited hours for a review: every Codex Reviewer was out of weekly quota, a Claude
 *  Reviewer may not check a Claude build (rules.ts judgeReview), and nobody was told until people noticed in the morning
 *  (Tony: "don't let the workflow get stuck"). Checked when an Engineer hands work over for review (commands.ts work.status). */
import { suspendedEngines } from './engineHealth.js'
import { MACHINE_FRESH_MS, type ContributedMachine } from './machines.js'
import type { Conversation, SuperTabState } from './model.js'
import { canReadProject, groupProject, projectRules } from './projects.js'
import { liftEffort, type MayRun } from './rules.js'
import type { RoutingPolicy } from './routingPolicy.js'
import { usernameOf } from './usernames.js'

/** What a Harness Team account says of an engine that spends its Mac owner's subscription through the owner's relay: the
 *  allowance is that subscription's, read on the Mac. The same sentence as cli superTabs/capacity.ts RELAYED_QUOTA, which
 *  writes it. */
export const RELAYED_QUOTA = "This account runs on its owner's subscription; its allowance is read on the owner's machine."
/** Weekly allowance left, in percent, at or below which an engine is close to running out: the route keeps the policy's
 *  reserve (10) back, so about one more day of reviews is left. */
const LOW_LEFT = 20
const ENGINES = ['claude', 'codex'] as const
const NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

export type Cause = 'out' | 'low'
export interface ReviewCapacityNotice { conversationId: string; text: string; mentions: string[]; source: { kind: 'review-capacity'; engine: string; cause: Cause } }

/** How a machine stands for a new Reviewer on an engine, best first. Words only: a person's own numbers stay theirs. */
const STANDING = ['usable', 'close to running out', 'out of quota', 'signed out', 'suspended', 'offline'] as const
type Standing = typeof STANDING[number]

/** The engine's quota reading for [pool]: its own, or for a Team account that spends its Mac's subscription, the Mac's. */
function quotaOf(state: SuperTabState, pool: ContributedMachine, engine: string, now: number) {
  const own = pool.observation?.quotas.find(q => q.engine === engine)
  if (own?.known || !pool.hostMachineId || pool.observation?.quotaReasons?.[engine] !== RELAYED_QUOTA) return own
  const mac = state.machines?.find(m => m.machineId === pool.hostMachineId && m.contributorId === pool.contributorId)
  return mac?.observation && now - mac.observation.receivedAt <= MACHINE_FRESH_MS ? mac.observation.quotas.find(q => q.engine === engine) : own
}

function standing(state: SuperTabState, pool: ContributedMachine, engine: string, now: number): Standing {
  const reading = pool.observation
  if (!reading || now - reading.receivedAt > MACHINE_FRESH_MS) return 'offline'
  if (reading.readiness?.engines?.find(e => e.engine === engine)?.signedIn === false) return 'signed out'
  if (suspendedEngines(pool, now)[engine]) return 'suspended'
  const quota = quotaOf(state, pool, engine, now)
  // A quota it cannot read stays usable, as a start there is (engineHealth.ts engineUnusable).
  if (!quota?.known) return 'usable'
  if (quota.windows.some(w => w.usedPercent >= 100)) return 'out of quota'
  const weekly = quota.windows.find(w => w.name === 'weekly')
  return weekly && 100 - weekly.usedPercent <= LOW_LEFT ? 'close to running out' : 'usable'
}

/** Each machine the project may start a Reviewer of [engine] on, as one: a Mac and its Harness Team account are one machine
 *  (machines.ts teamStartRequest), standing as the better of the two. */
function seats(state: SuperTabState, group: Conversation, engine: string, policy: RoutingPolicy, mayRun: MayRun, now: number) {
  const rules = projectRules(state, groupProject(state, group).id)
  const rows = policy.models.filter(row => row.enabled && row.engine === engine && row.quality >= 2)
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
 * for a build on a grid model, which either engine reviews. Tags the owners of those machines who read the project.
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
  const mentions = [...new Set(places.map(p => p.contributorId))].filter(reads)
  const who = mentions.map(id => `@${usernameOf(state, id) ?? person(id)!.email.split('@')[0]}`).join(' ')
  const fixes = `More ${NAME[engine]} quota, ${NAME[engine]} signed in on another machine, or another machine in the Swarm`
  const text = (cause === 'out'
    ? `Reviews of ${NAME[built]} builds cannot start a new Reviewer: ${NAME[engine]} is unavailable on every machine this project may use (${list}). ${fixes} would unblock them.`
    : `${NAME[engine]} quota for reviewing ${NAME[built]} builds is close to running out on every machine this project may use (${list}). ${fixes} would keep reviews going.`)
    + (who ? ` ${who} can fix it.` : '')
  return { conversationId: project.leadConversationId, text, mentions, source: { kind: 'review-capacity', engine, cause } }
}
