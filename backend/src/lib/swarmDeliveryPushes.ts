import { publishSwarmDeliveries, subscribeSwarmDeliveries } from './bus.js'
import { logger } from '../utils/logger.js'
import type { DeliveriesWaiting } from '../superTabs/store.js'

/** Repeated so a host keeps reading idle agents every 30 s: it goes back to each second 10 minutes after it last heard it
 *  (cli superTabs/host.ts PUSH_LEASE_MS), which covers a missed repeat and a server rolled back to one that does not push. */
const PUSHES_REPEAT_MS = 4 * 60_000

/**
 * Stability roadmap 2.4: every Swarm host read each running agent's deliveries each second, almost always to find nothing.
 * This socket's machine now hears when a delivery waits for one of its agents (superTabs/store.ts deliveriesWaiting, after
 * the write commits), as a connection-less `super_tab_deliveries` down frame naming the Swarm and agent; the daemon hands it
 * to its Swarm host, which reads that list at once (cli gateway.ts, superTabs/host.ts).
 *
 * The frame with no payload says this server pushes: the host then reads an idle agent's list only every 30 s, the safety
 * net for a push lost on the way. A daemon from before this ignores the frame and keeps reading each second.
 *
 * `machineId` is the machine the socket signed in as (adapterWs.ts), never one the client names, so a socket hears only its
 * own machine's work. The frame carries nothing but the two ids; the host reads the deliveries through the checked poll.
 *
 * Resolves to the unsubscribe. Redis unreachable, it says nothing and never fails the socket.
 */
export async function relaySwarmDeliveries(machineId: string, send: (frame: unknown) => unknown): Promise<() => void> {
  const tell = (payload: { tabId?: string; agentId?: string }) => { send({ t: 'down', connId: '', frame: { type: 'super_tab_deliveries', payload } }) }
  let unsubscribe: () => void
  try {
    unsubscribe = await subscribeSwarmDeliveries(machineId, msg => {
      const { tabId, agentId } = (msg && typeof msg === 'object' ? msg : {}) as Record<string, unknown>
      if (typeof tabId === 'string' && typeof agentId === 'string') tell({ tabId, agentId })
    })
  } catch (error) {
    // Not told that the server pushes, the host keeps reading each second: nothing waits longer, only the saving is lost.
    logger.warn('[swarm] delivery pushes unavailable for this socket', { machineId, error: error instanceof Error ? error.message : String(error) })
    return () => {}
  }
  tell({})
  const repeat = setInterval(() => tell({}), PUSHES_REPEAT_MS)
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
