/**
 * A person switches their Buddy between their own subscription and a model the Swarm's grid serves, and back (task #2354,
 * docs/plans/2026-11-03-buddy-model-switch-design.md). The person asks here; the Buddy's machine carries it out through its
 * own daemon's model switch (cli superTabs/buddyModel.ts) and reports; the outcome is one line in the person's Buddy chat.
 *
 * The models offered are exactly those a routed start may run on (machines.ts servedLocalModels): on this Swarm's grid, in a
 * fresh reading of a machine in its Machines list. Never a model of another grid a member reads, which only that member's
 * machine can reach.
 */
import { isSwarmBuddy, swarmBuddyChatId } from './buddies.js'
import { machineOffline, servedLocalModels } from './machines.js'
import { fail, person, type Actor, type Agent, type SuperTabState } from './model.js'
import { usernameOf } from './usernames.js'

/** What a host that switches a Buddy's model says it does (cli superTabs/machines.ts CAPABILITIES). */
export const BUDDY_MODEL_CAPABILITY = 'buddyModel'

/** A model as the person was shown it: its name, who serves it (machines by name, a saved API by its member), and the smallest
 *  window a serving machine reported, so the conversation is measured against the tightest one the grid may pick. */
function served(state: SuperTabState, gridModel: string, now: number) {
  const readings = servedLocalModels(state, now).filter(l => l.model === gridModel)
  if (!readings.length) return null
  const servedBy = [...new Set(readings.map(l => {
    const pool = state.machines!.find(m => m.machineId === l.machineId)!
    if (l.kind !== 'api') return pool.name ?? 'a machine'
    const sharer = state.people.find(p => p.id === pool.contributorId)
    return `${usernameOf(state, pool.contributorId) ?? sharer?.email ?? 'a member'}'s saved API`
  }))]
  const windows = readings.flatMap(l => typeof l.contextWindow === 'number' ? [l.contextWindow] : [])
  return { name: readings.find(l => l.name)?.name ?? gridModel, servedBy, ...(windows.length ? { contextWindow: Math.min(...windows) } : {}) }
}

/** The person's own running Buddy for the Swarm: never a thread session, never someone else's. */
function ownBuddy(state: SuperTabState, actor: Actor): Agent {
  if (actor.kind !== 'person') fail('BUDDY_PERSON', 'A person switches their own Buddy.', 403)
  const me = person(state, actor.userId)
  return state.agents.find(a => isSwarmBuddy(a) && a.buddyOf!.personId === me.id && a.buddyOf!.generation === me.generation && !a.buddySession)
    ?? fail('NO_BUDDY', 'You have no Buddy running.', 404)
}

export function askBuddyModel(state: SuperTabState, actor: Actor, gridModel: string | null, requestId: string, now: number): void {
  const buddy = ownBuddy(state, actor)
  const pool = state.machines?.find(m => m.machineId === buddy.machineId)
  // A Buddy-only machine never joins the Swarm's grid (read/hostRows.ts), so nothing shared there can reach it.
  if (!pool || pool.buddyOnly) fail('BUDDY_MODEL_MACHINE', `Add ${pool?.name ?? 'your computer'} to the Swarm's Machines to use shared models.`, 409)
  if (machineOffline(pool, now)) fail('MACHINE_OFFLINE', `Wait for a fresh reading from ${pool.name ?? 'your computer'}.`)
  if (!pool.observation!.capabilities?.includes(BUDDY_MODEL_CAPABILITY)) fail('HOST_OUTDATED', `Update Harness on ${pool.name ?? 'your computer'} to switch your Buddy's model.`, 409)
  if (buddy.modelRequest) fail('BUDDY_SWITCHING', 'Your Buddy is already switching.', 409)
  const shown = gridModel === null ? {} : served(state, gridModel, now)
  if (!shown) fail('BUDDY_MODEL_UNAVAILABLE', 'Nobody in the Swarm serves that model now.', 409)
  buddy.modelRequest = { id: requestId, gridModel, ...shown, requestedBy: actor.kind === 'person' ? actor.userId : '', at: new Date(now).toISOString() }
}

const windowWords = (tokens: number) => `${Math.round(tokens / 1024)}K`
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/[.\s]+$/, '').trim()

/** What the Buddy is on now, as its owner reads it. */
function current(state: SuperTabState, buddy: Agent, now: number): string {
  if (!buddy.gridModel) return 'your subscription'
  return served(state, buddy.gridModel, now)?.name ?? buddy.gridModel
}

/** The Buddy's machine reports the switch it carried out: the Buddy is on the model, or stays where it was. */
export function buddyModelResult(state: SuperTabState, actor: Actor,
  command: { agentId: string; requestId: string; ok: boolean; fresh?: boolean; error?: string }, now = Date.now()): { conversationId: string; text: string } {
  const buddy = state.agents.find(a => a.id === command.agentId)
  if (!buddy || actor.kind !== 'agent' || actor.agentId !== buddy.id || !isSwarmBuddy(buddy)) fail('BUDDY_FORBIDDEN', 'Only the Buddy\'s machine reports its switch.', 403)
  const request = buddy.modelRequest
  if (!request || request.id !== command.requestId) fail('STALE_SWITCH', 'This is not the switch your Buddy was asked for.', 409)
  delete buddy.modelRequest
  const conversationId = swarmBuddyChatId({ id: buddy.buddyOf!.personId, generation: buddy.buddyOf!.generation })
  if (!command.ok) {
    return { conversationId, text: `Couldn't switch your Buddy: ${clean(command.error ?? '') || 'it failed'}. It is still on ${current(state, buddy, now)}.` }
  }
  if (request.gridModel === null) {
    delete buddy.gridModel
    return { conversationId, text: 'Your Buddy is back on your subscription.' }
  }
  buddy.gridModel = request.gridModel
  const name = request.name ?? request.gridModel
  if (command.fresh) {
    const window = request.contextWindow ? ` (${windowWords(request.contextWindow)})` : ''
    return { conversationId, text: `Your Buddy started a fresh session on ${name}: this conversation is too long for it${window}. `
      + 'Switch back to your subscription to continue the earlier one.' }
  }
  const servers = request.servedBy ?? []
  const by = servers.every(s => s.endsWith("'s saved API")) ? servers.join(', ') : `served by ${servers.join(', ')}`
  return { conversationId, text: `Your Buddy now runs on ${name}${servers.length ? `, ${by}` : ''}.` }
}

/** A switch the Buddy's machine never reported within this long is dropped: the Buddy stays where it was. */
export const BUDDY_MODEL_LEASE_MS = 10 * 60_000

export function expiredModelRequests(state: SuperTabState, now: number): Array<{ buddy: Agent; requestId: string; conversationId: string; text: string }> {
  const out: Array<{ buddy: Agent; requestId: string; conversationId: string; text: string }> = []
  for (const buddy of state.agents) {
    const request = buddy.modelRequest
    if (!request || !buddy.buddyOf || now < Date.parse(request.at) + BUDDY_MODEL_LEASE_MS) continue
    delete buddy.modelRequest
    out.push({ buddy, requestId: request.id, conversationId: swarmBuddyChatId({ id: buddy.buddyOf.personId, generation: buddy.buddyOf.generation }),
      text: `Couldn't switch your Buddy: its computer didn't answer. It is still on ${current(state, buddy, now)}.` })
  }
  return out
}
