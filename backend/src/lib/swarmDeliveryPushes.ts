import { publishSwarmDeliveries, subscribeSwarmDeliveries } from './bus.js'
import { logger } from '../utils/logger.js'
import type { DeliveriesWaiting } from '../superTabs/store.js'

/** Each minute this socket renews its host's push lease (`__deliveries_lease`, cli superTabs/host.ts PUSH_LEASE_MS, 2.5 min),
 *  and every LEASES_PER_WORD of them also says it pushes (the empty `super_tab_deliveries` frame), on which a host reads every
 *  list once. Both go through the machine's own channel, as the host-changes repeat does (swarmHostPushes.ts): a host reads an
 *  idle worker's list only when told (task #2800), so a Redis gone silent must end its lease within minutes and put it back
 *  to reading each second (review of #2977, Important 1), and a repeat nobody heard is logged. An older daemon drops the `__`
 *  frame and keeps its lease on the 4-minute word, as before. */
const LEASE_REPEAT_MS = 60_000
const LEASES_PER_WORD = 4

/**
 * Stability roadmap 2.4: every Swarm host read each running agent's deliveries each second, almost always to find nothing.
 * This socket's machine now hears when a delivery waits for one of its agents (superTabs/store.ts deliveriesWaiting, after
 * the write commits), as a connection-less `super_tab_deliveries` down frame naming the Swarm and agent; the daemon hands it
 * to its Swarm host, which reads that list at once (cli gateway.ts, superTabs/host.ts).
 *
 * The frame with no payload says this server pushes: the host then reads an idle worker's list only when told (a Lead's every
 * 30 s), and this server tells it again of any delivery still queued after 10 s (superTabs/deliveryRepush.ts), the safety net
 * for a push lost on the way (task #2800). A daemon from before this ignores the frame and keeps reading each second.
 *
 * `machineId` is the machine the socket signed in as (adapterWs.ts), never one the client names, so a socket hears only its
 * own machine's work. The frame carries nothing but the two ids; the host reads the deliveries through the checked poll.
 *
 * Resolves to the unsubscribe. Redis unreachable, it says nothing and never fails the socket.
 */
export async function relaySwarmDeliveries(machineId: string, send: (frame: unknown) => unknown): Promise<() => void> {
  const tell = (payload: { tabId?: string; agentId?: string }) => { send({ t: 'down', connId: '', frame: { type: 'super_tab_deliveries', payload } }) }
  let unsubscribe: () => void, leases = 0
  try {
    unsubscribe = await subscribeSwarmDeliveries(machineId, msg => {
      const { tabId, agentId, terminal, pushes } = (msg && typeof msg === 'object' ? msg : {}) as Record<string, unknown>
      if (pushes === true) {
        send({ t: 'down', connId: '', frame: { type: '__deliveries_lease', payload: {} } })
        if (++leases % LEASES_PER_WORD === 0) tell({})
        return
      }
      if (typeof tabId !== 'string' || typeof agentId !== 'string') return
      // A terminal request waiting for this machine (announceSwarmTerminal): a `__` control frame, which an older daemon drops.
      if (terminal === true) send({ t: 'down', connId: '', frame: { type: '__terminal_waiting', payload: { tabId, agentId } } })
      else tell({ tabId, agentId })
    })
  } catch (error) {
    // Not told that the server pushes, the host keeps reading each second: nothing waits longer, only the saving is lost.
    logger.warn('[swarm] delivery pushes unavailable for this socket', { machineId, error: error instanceof Error ? error.message : String(error) })
    return () => {}
  }
  tell({})
  const repeat = setInterval(() => {
    void publishSwarmDeliveries(machineId, { pushes: true }).then(heard => {
      if (!heard) logger.warn('[swarm] delivery push repeat reached no one; hosts fall back to reading each second', { machineId })
    })
  }, LEASE_REPEAT_MS)
  return () => {
    clearInterval(repeat)
    unsubscribe()
  }
}

/** The store's `deliveriesWaiting` on every server that writes Swarm messages (routes/superTabs.ts, worker.ts): the server
 *  holding the machine's socket tells it. Dropped when Redis is away; the host's 30 s read still finds the delivery. */
export function announceSwarmDeliveries({ machineId, tabId, agentId }: DeliveriesWaiting): void {
  void publishSwarmDeliveries(machineId, { tabId, agentId })
}

/** The store's `terminalWaiting`: a terminal request for one of this machine's agents, on the same channel as deliveries, so
 *  the daemon picks it up at once rather than on its next poll (spec 2026-11-02 poll cost, Part 4.2). Dropped when Redis is
 *  away; the daemon's fallback poll still finds it within the 10 s pickup deadline. */
export function announceSwarmTerminal({ machineId, tabId, agentId }: DeliveriesWaiting): void {
  void publishSwarmDeliveries(machineId, { tabId, agentId, terminal: true })
}
