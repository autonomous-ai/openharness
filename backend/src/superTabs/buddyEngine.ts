/** A person's explicit engine switch keeps their Buddy's identity and private chat. The host uses the same durable handoff
 * as Change agent; a backend request alone never changes the engine the Buddy is recorded as running. */
import { isSwarmBuddy, swarmBuddyChatId } from './buddies.js'
import { machineOffline } from './machines.js'
import { fail, person, type Actor, type Agent, type SuperTabState } from './model.js'

export const BUDDY_ENGINE_CAPABILITY = 'buddyEngine'
export const buddyEngineName = (engine: string): string => engine === 'claude' ? 'Claude Code' : engine === 'codex' ? 'Codex' : engine
export const buddyEngineChat = (buddy: Agent): string => swarmBuddyChatId({ id: buddy.buddyOf!.personId, generation: buddy.buddyOf!.generation })

export function askBuddyEngine(state: SuperTabState, actor: Actor, engine: string, id: string, now: number): void {
  if (actor.kind !== 'person') fail('BUDDY_PERSON', 'A person switches their own Buddy.', 403)
  const me = person(state, actor.userId)
  const buddy = state.agents.find(a => isSwarmBuddy(a) && !a.buddySession && a.buddyOf!.personId === me.id && a.buddyOf!.generation === me.generation)
    ?? fail('NO_BUDDY', 'You have no Buddy running.', 404)
  if (buddy.switchRequest || buddy.switchLanded || buddy.modelRequest) fail('BUDDY_SWITCHING', 'Your Buddy is already switching.', 409)
  const pool = state.machines?.find(m => m.machineId === buddy.machineId && m.contributorId === me.id && !m.removal && !m.hostMachineId)
  if (!pool || buddy.machineOwnerId !== me.id || pool.observation?.sessionKind === 'team') {
    fail('BUDDY_OWN_MACHINE', 'A Buddy switches only on your own machine.', 403)
  }
  if (machineOffline(pool, now)) fail('MACHINE_OFFLINE', `Wait for a fresh reading from ${pool.name}.`, 409)
  if (!pool.observation?.capabilities?.includes(BUDDY_ENGINE_CAPABILITY)) fail('HOST_OUTDATED', `Update Harness on ${pool.name} to switch your Buddy's engine.`, 409)
  const offered = pool.observation.readiness?.engines?.find(e => e.engine === engine)
  if (offered?.installed !== true || offered.signedIn !== true) fail('BUDDY_ENGINE_UNAVAILABLE', `${buddyEngineName(engine)} must be installed and signed in on your Buddy's machine.`, 409)
  if (buddy.configuration.engine === engine && !buddy.gridModel) return
  buddy.switchRequest = { id, engine, profileId: 'default', requestedBy: me.id, at: new Date(now).toISOString() }
}

/** Only a claimed, still-live request can rebind a Buddy; ordinary pane replacements cannot change its account or role. */
export function checkBuddyRebind(buddy: Agent, engine: string, profileId: string | undefined, now: number): void {
  const request = buddy.switchRequest
  if (!isSwarmBuddy(buddy) || buddy.buddySession || !request?.claimedUntil || Date.parse(request.claimedUntil) <= now
    || request.engine !== engine || (profileId && profileId !== 'default')) {
    fail('STALE_SWITCH', 'Only your Buddy\'s claimed engine switch can replace its session.', 409)
  }
}
