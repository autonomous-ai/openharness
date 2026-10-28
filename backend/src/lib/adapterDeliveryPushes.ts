import { publishSuperTabDeliveries, subscribeSuperTabDeliveries } from './bus.js'
import { redisPollMarks } from './pollMarks.js'
import type { PollMarks } from '../superTabs/store.js'

/** How often a socket says again that this server pushes: hosts stop trusting the push 10 minutes after they last heard it
 *  (cli superTabs/host.ts PUSH_LEASE_MS), so an older server or a rollback goes back to their read each second. */
export const ANNOUNCE_EVERY_MS = 4 * 60_000

/**
 * Stability roadmap 2.4 (2026-10-28): every running agent's host read its Swarm deliveries each second. A machine's daemon
 * socket now hears, on its own machine's channel, when a delivery waits for one of its agents (superTabs/store.ts
 * `deliveryWaiting`), and hands the daemon only the Swarm and agent to read now. The read checks authority as before; this
 * frame grants nothing. The frame with no names says this server pushes: sent at once and every ANNOUNCE_EVERY_MS.
 *
 * `machineId` is the machine the socket signed in as (lib/adapterWs.ts), never one the daemon names.
 *
 * Resolves to the stop for the subscription and the announcements.
 */
export async function relayDeliveryPushes(machineId: string, send: (frame: unknown) => unknown): Promise<() => void> {
  const frame = (payload: Record<string, string>) => send({ t: 'down', connId: '', frame: { type: 'super_tab_deliveries', payload } })
  const unsubscribe = await subscribeSuperTabDeliveries(machineId, msg => {
    const { tabId, agentId } = (typeof msg === 'object' && msg !== null ? msg : {}) as Record<string, unknown>
    if (typeof tabId === 'string' && typeof agentId === 'string') frame({ tabId, agentId })
  })
  frame({})
  const timer = setInterval(() => frame({}), ANNOUNCE_EVERY_MS)
  timer.unref?.()
  return () => { clearInterval(timer); unsubscribe() }
}

/** The Swarm store's hooks for delivering over the daemon socket (routes/superTabs.ts): each new delivery is published on its
 *  agent's machine channel, which that machine's socket relays above, on whichever server holds it; and the quiet poll
 *  remembers full polls in Redis, for older hosts that still poll each second. A publish never throws (bus.ts). */
export function deliveryStoreHooks(): { deliveryWaiting: (machineId: string, tabId: string, agentId: string) => void; pollMarks: PollMarks } {
  return {
    deliveryWaiting: (machineId, tabId, agentId) => { void publishSuperTabDeliveries(machineId, { tabId, agentId }) },
    pollMarks: redisPollMarks(),
  }
}

