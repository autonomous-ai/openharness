import { publishSwarmHost, subscribeSwarmHost } from './bus.js'
import { logger } from '../utils/logger.js'
import type { HostsChanged } from '../superTabs/store.js'

/** Repeated so a host keeps reading only when told: it goes back to each second 5 minutes after it last heard it (cli
 *  superTabs/hostFeed.ts HOST_PUSH_LEASE_MS), which covers a server rolled back to one that does not push, or switched off. */
const PUSHES_REPEAT_MS = 4 * 60_000

/** The rollout switch: off unless SWARM_HOST_PUSH=on. Off, no socket says it pushes, so every host reads each second as
 *  before, and no commit is published. */
const hostPushesOn = () => process.env.SWARM_HOST_PUSH === 'on'

/**
 * WebSocket roadmap Phase 2a: every Swarm host read its changes each second (cli superTabs/hostFeed.ts), almost always to
 * find nothing. This socket's machine now hears when a commit changed what its host reads (superTabs/store.ts hostsChanged,
 * after the write commits), as a connection-less `swarm_host_changed` down frame naming the Swarm and the commit's time; the
 * daemon hands it to its Swarm host, which reads its changes at once (cli gateway.ts, superTabs/host.ts).
 *
 * The frame with no payload says this server pushes: the host then reads its changes only when told, and in full every
 * minute, the safety net for a push lost on the way. A daemon from before this ignores the frame and keeps reading each second.
 *
 * `machineId` is the machine the socket signed in as (adapterWs.ts), never one the client names, so a socket hears only of
 * its own machine's Swarms. The frame carries nothing but the Swarm's id and a time; the host reads through the checked read.
 *
 * Resolves to the unsubscribe. Redis unreachable, it says nothing and never fails the socket.
 */
export async function relaySwarmHostChanges(machineId: string, send: (frame: unknown) => unknown): Promise<() => void> {
  if (!hostPushesOn()) return () => {}
  const tell = (payload: { tabId?: string; lastChangedAt?: number }) => { send({ t: 'down', connId: '', frame: { type: 'swarm_host_changed', payload } }) }
  let unsubscribe: () => void
  try {
    unsubscribe = await subscribeSwarmHost(machineId, msg => {
      const { tabId, lastChangedAt } = (msg && typeof msg === 'object' ? msg : {}) as Record<string, unknown>
      if (typeof tabId === 'string' && typeof lastChangedAt === 'number') tell({ tabId, lastChangedAt })
    })
  } catch (error) {
    // Not told that the server pushes, the host keeps reading each second: nothing waits longer, only the saving is lost.
    logger.warn('[swarm] host pushes unavailable for this socket', { machineId, error: error instanceof Error ? error.message : String(error) })
    return () => {}
  }
  tell({})
  const repeat = setInterval(() => tell({}), PUSHES_REPEAT_MS)
  return () => {
    clearInterval(repeat)
    unsubscribe()
  }
}

/** The store's `hostsChanged` on every server that writes Swarms (routes/superTabs.ts, worker.ts): the server holding each
 *  machine's socket tells it. Dropped when Redis is away; the host's full read each minute still finds the change. */
export function announceSwarmHostChanges({ tabId, machineIds, lastChangedAt }: HostsChanged): void {
  if (!hostPushesOn()) return
  for (const machineId of machineIds) void publishSwarmHost(machineId, { tabId, lastChangedAt })
}
