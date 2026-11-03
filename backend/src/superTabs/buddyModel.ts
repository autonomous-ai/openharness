/**
 * A person switches their Buddy between their own subscription and a model the Swarm's grid serves, and back (task #2354,
 * docs/plans/2026-11-03-buddy-model-switch-design.md). The person asks here; the Buddy's machine carries it out through its
 * own daemon's model switch (cli superTabs/buddyModel.ts) and reports; the outcome is one line in the person's Buddy chat.
 *
 * The models offered are exactly those a routed start may run on (machines.ts servedLocalModels): on this Swarm's grid, in a
 * fresh reading of a machine in its Machines list. Never a model of another grid a member reads, which only that member's
 * machine can reach.
 *
 * Whoever serves the model is told whose Buddy runs on it, and their limits hold (PRODUCT.md, Contribution): a model that
 * hits a limit, keeps failing or is no longer served sends the Buddy back to its owner's subscription.
 */
import { isSwarmBuddy, openSwarmBuddyChat, swarmBuddyChatId } from './buddies.js'
import { machineOffline, servedLocalModels } from './machines.js'
import { fail, person, type Actor, type Agent, type SuperTabState } from './model.js'
import { usernameOf } from './usernames.js'

/** What a host that switches a Buddy's model says it does (cli superTabs/machines.ts CAPABILITIES). */
export const BUDDY_MODEL_CAPABILITY = 'buddyModel'
/** A switch the Buddy's machine never reported within this long is dropped: the Buddy stays where it was. */
export const BUDDY_MODEL_LEASE_MS = 10 * 60_000
/** How long nobody serves the model a Buddy runs on before it is sent home: a machine's reading may lapse for a moment. */
export const BUDDY_MODEL_GONE_MS = 2 * 60_000

/** One line the switch writes: in a Buddy chat, naming the machines a Buddy reading it must not learn (store.ts
 *  withoutMachineNames). */
export interface ModelLine { conversationId: string; text: string; machines: string[] }

const personName = (state: SuperTabState, id: string) =>
  usernameOf(state, id) ?? state.people.find(p => p.id === id)?.email ?? 'A member'

/** Who serves [gridModel] now on the Swarm's grid: each serving machine's name and its member, and whether it is an API. */
function servers(state: SuperTabState, gridModel: string, now: number) {
  return servedLocalModels(state, now).filter(l => l.model === gridModel).map(l => {
    const pool = state.machines!.find(m => m.machineId === l.machineId)!
    return { reading: l, machine: pool.name ?? 'a machine', personId: pool.contributorId, api: l.kind === 'api' }
  })
}

/** A model as the person was shown it: its name, who serves it (machines by name, a saved API by its member), and the smallest
 *  window a serving machine reported, so the conversation is measured against the tightest one the grid may pick. */
function served(state: SuperTabState, gridModel: string, now: number) {
  const found = servers(state, gridModel, now)
  if (!found.length) return null
  const servedBy = [...new Set(found.map(s => s.api ? `${personName(state, s.personId)}'s saved API` : s.machine))]
  const windows = found.flatMap(s => typeof s.reading.contextWindow === 'number' ? [s.reading.contextWindow] : [])
  return { name: found.find(s => s.reading.name)?.reading.name ?? gridModel, servedBy,
    ...(windows.length ? { contextWindow: Math.min(...windows) } : {}) }
}

/** The person's own running Buddy for the Swarm: never a thread session, never someone else's. */
function ownBuddy(state: SuperTabState, actor: Actor): Agent {
  if (actor.kind !== 'person') fail('BUDDY_PERSON', 'A person switches their own Buddy.', 403)
  const me = person(state, actor.userId)
  return mainBuddy(state, me.id, me.generation) ?? fail('NO_BUDDY', 'You have no Buddy running.', 404)
}
const mainBuddy = (state: SuperTabState, personId: string, generation: string) =>
  state.agents.find(a => isSwarmBuddy(a) && a.buddyOf!.personId === personId && a.buddyOf!.generation === generation && !a.buddySession)

/** Whether the Buddy's machine can carry a switch out now: in the Swarm's Machines list, reporting, and able to. */
function switchable(state: SuperTabState, buddy: Agent, now: number): { ok: true } | { ok: false; code: string; message: string } {
  const pool = state.machines?.find(m => m.machineId === buddy.machineId)
  const name = pool?.name ?? 'your computer'
  // A Buddy-only machine never joins the Swarm's grid (read/hostRows.ts), so nothing shared there can reach it.
  if (!pool || pool.buddyOnly) return { ok: false, code: 'BUDDY_MODEL_MACHINE', message: `Add ${name} to the Swarm's Machines to use shared models.` }
  if (machineOffline(pool, now)) return { ok: false, code: 'MACHINE_OFFLINE', message: `Wait for a fresh reading from ${name}.` }
  if (!pool.observation!.capabilities?.includes(BUDDY_MODEL_CAPABILITY)) return { ok: false, code: 'HOST_OUTDATED', message: `Update Harness on ${name} to switch your Buddy's model.` }
  return { ok: true }
}

export function askBuddyModel(state: SuperTabState, actor: Actor, gridModel: string | null, requestId: string, now: number): void {
  const buddy = ownBuddy(state, actor)
  const can = switchable(state, buddy, now)
  if (!can.ok) fail(can.code, can.message, 409)
  if (buddy.modelRequest) fail('BUDDY_SWITCHING', 'Your Buddy is already switching.', 409)
  const shown = gridModel === null ? {} : served(state, gridModel, now)
  if (!shown) fail('BUDDY_MODEL_UNAVAILABLE', 'Nobody in the Swarm serves that model now.', 409)
  // The grid its machine moves it onto (agent_retarget's gridName): the Swarm's own, the one the models were checked on.
  buddy.modelRequest = { id: requestId, gridModel, ...(gridModel === null ? {} : { gridName: state.localModels!.grid }), ...shown,
    requestedBy: buddy.buddyOf!.personId, at: new Date(now).toISOString() }
}

/** Sends [buddy]'s main Buddy home to its owner's subscription by itself, unless it is on it, already switching, or its machine
 *  cannot carry it out (then its own lines say so: its model fails in its terminal, and the person can switch it). */
export function sendBuddyHome(state: SuperTabState, from: Agent, reason: 'limit' | 'failing' | 'gone', requestId: string, now: number): void {
  if (!from.buddyOf) return
  const buddy = mainBuddy(state, from.buddyOf.personId, from.buddyOf.generation)
  if (!buddy?.gridModel || buddy.modelRequest || !switchable(state, buddy, now).ok) return
  buddy.modelRequest = { id: requestId, gridModel: null, name: current(state, buddy, now), reason,
    requestedBy: buddy.buddyOf!.personId, at: new Date(now).toISOString() }
}

const windowWords = (tokens: number) => `${Math.round(tokens / 1024)}K`
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/[.\s]+$/, '').trim()
const HOME_WORDS = { limit: 'hit a limit', failing: 'keeps failing' } as const

/** What the Buddy is on now, as its owner reads it. */
function current(state: SuperTabState, buddy: Agent, now: number): string {
  if (!buddy.gridModel) return 'your subscription'
  return served(state, buddy.gridModel, now)?.name ?? buddy.gridModelName ?? buddy.gridModel
}

/** The Buddy's machine reports the switch it carried out: the Buddy is on the model, or stays where it was. The first line is
 *  the owner's; then one for each other member who serves the model it landed on. */
export function buddyModelResult(state: SuperTabState, actor: Actor,
  command: { agentId: string; requestId: string; ok: boolean; fresh?: boolean; error?: string }, now: number): ModelLine[] {
  const buddy = state.agents.find(a => a.id === command.agentId)
  if (!buddy || actor.kind !== 'agent' || actor.agentId !== buddy.id || !isSwarmBuddy(buddy)) fail('BUDDY_FORBIDDEN', 'Only the Buddy\'s machine reports its switch.', 403)
  const request = buddy.modelRequest
  if (!request || request.id !== command.requestId) fail('STALE_SWITCH', 'This is not the switch your Buddy was asked for.', 409)
  delete buddy.modelRequest
  const owner = buddy.buddyOf!
  const conversationId = swarmBuddyChatId({ id: owner.personId, generation: owner.generation })
  const mine = (text: string, machines: string[] = []): ModelLine[] => [{ conversationId, text, machines }]
  if (!command.ok) {
    return mine(`Couldn't switch your Buddy: ${clean(command.error ?? '') || 'it failed'}. It is still on ${current(state, buddy, now)}.`,
      buddy.gridModel ? servers(state, buddy.gridModel, now).map(s => s.machine) : [])
  }
  delete buddy.gridModelUnservedSince
  if (request.gridModel === null) {
    delete buddy.gridModel
    delete buddy.gridModelName
    const left = request.name ?? 'Its model'
    return mine(request.reason === 'gone' ? `Nobody serves ${left} now, so your Buddy is back on your subscription.`
      : request.reason ? `${left} ${HOME_WORDS[request.reason]}, so your Buddy is back on your subscription.`
        : 'Your Buddy is back on your subscription.')
  }
  buddy.gridModel = request.gridModel
  const name = request.name ?? request.gridModel
  buddy.gridModelName = name
  const found = servers(state, request.gridModel, now)
  const machines = found.filter(s => !s.api).map(s => s.machine)
  let text: string
  if (command.fresh) {
    const window = request.contextWindow ? ` (${windowWords(request.contextWindow)})` : ''
    text = `Your Buddy started a fresh session on ${name}: this conversation is too long for it${window}. Switch back to your subscription to continue the earlier one.`
  } else {
    const shown = request.servedBy ?? []
    const by = shown.every(s => s.endsWith("'s saved API")) ? shown.join(', ') : `served by ${shown.join(', ')}`
    text = `Your Buddy now runs on ${name}${shown.length ? `, ${by}` : ''}.`
  }
  // Seen (PRODUCT.md, Contribution): each other member serving it hears whose Buddy runs on their capacity, in their own chat.
  const told = new Set<string>([owner.personId])
  const theirs: ModelLine[] = []
  for (const s of found) {
    if (told.has(s.personId)) continue
    told.add(s.personId)
    const member = state.people.find(p => p.id === s.personId)
    if (!member) continue
    // No machine named: their own Buddy reads this chat, and a Buddy reads no machines.
    theirs.push({ conversationId: openSwarmBuddyChat(state, member).id, machines: [],
      text: `${personName(state, owner.personId)}'s Buddy now runs on ${name}, ${s.api ? 'on your saved API' : 'which your machine serves'}.` })
  }
  return [...mine(text, machines), ...theirs]
}

/** Requests nobody answered within their lease, dropped, each with the line its owner reads. */
export function expiredModelRequests(state: SuperTabState, now: number): Array<{ buddy: Agent; requestId: string } & ModelLine> {
  const out: Array<{ buddy: Agent; requestId: string } & ModelLine> = []
  for (const buddy of state.agents) {
    const request = buddy.modelRequest
    if (!request || !buddy.buddyOf || now < Date.parse(request.at) + BUDDY_MODEL_LEASE_MS) continue
    delete buddy.modelRequest
    out.push({ buddy, requestId: request.id, conversationId: swarmBuddyChatId({ id: buddy.buddyOf.personId, generation: buddy.buddyOf.generation }),
      machines: buddy.gridModel ? servers(state, buddy.gridModel, now).map(s => s.machine) : [],
      text: `Couldn't switch your Buddy: its computer didn't answer. It is still on ${current(state, buddy, now)}.` })
  }
  return out
}

/** Buddies on a model nobody has served for BUDDY_MODEL_GONE_MS are sent home; one served again is unmarked. */
export function unservedBuddyModels(state: SuperTabState, now: number, requestId: (buddy: Agent) => string): void {
  for (const buddy of state.agents) {
    if (!buddy.gridModel || buddy.buddySession || !isSwarmBuddy(buddy)) continue
    if (servers(state, buddy.gridModel, now).length) { delete buddy.gridModelUnservedSince; continue }
    buddy.gridModelUnservedSince ??= now
    if (now - buddy.gridModelUnservedSince < BUDDY_MODEL_GONE_MS) continue
    sendBuddyHome(state, buddy, 'gone', requestId(buddy), now)
    if (buddy.modelRequest) delete buddy.gridModelUnservedSince
  }
}

/** A Buddy thread session's model (commands.ts message.send newSession): the shared one its Buddy runs on while it is served, or
 *  its owner's subscription with Claude Code's own default, never a grid model's name handed to Claude Code as its own. */
export function sessionModel(state: SuperTabState, main: Agent, now: number): { gridModel?: string; gridName?: string; model?: string; effort?: string } {
  if (main.gridModel) {
    return servers(state, main.gridModel, now).length ? { gridModel: main.gridModel, gridName: state.localModels!.grid } : {}
  }
  return { ...(main.configuration.model ? { model: main.configuration.model } : {}), ...(main.configuration.effort ? { effort: main.configuration.effort } : {}) }
}
