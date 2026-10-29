import { randomUUID } from 'node:crypto'
import { publishSwarmMember, subscribeSwarmMember, type SwarmMemberMsg } from './bus.js'
import { logger } from '../utils/logger.js'
import type { SwarmChanged } from '../superTabs/store.js'

/** Repeated so an app keeps reading only when told: it goes back to its own timers 5 minutes after it last heard it
 *  (desktop super_tabs/controller.dart kSwarmPushLease), which covers a server rolled back to one that does not push, and a Redis
 *  gone silent: the repeat goes through it. */
const PUSHES_REPEAT_MS = 4 * 60_000
/** The Lead's rule (2026-10-29): at most one push per Swarm a second, so a Swarm committing every second is one read a
 *  second per window, not one per commit. */
const COALESCE_MS = 1_000
type Part = 'main' | 'machine'
const PARTS: readonly Part[] = ['main', 'machine']

/**
 * Per key, the first event goes at once; those within the next second wait, merged, and go together at its end. A key
 * with nothing waiting goes quiet. `stop` drops whatever waits.
 */
function coalescer<T>(merge: (held: T, next: T) => T, emit: (key: string, value: T) => void) {
  const keys = new Map<string, { timer: NodeJS.Timeout; held: T | null }>()
  const open = (key: string) => {
    const timer = setTimeout(() => {
      const entry = keys.get(key)
      keys.delete(key)
      if (entry?.held) { emit(key, entry.held); open(key) }
    }, COALESCE_MS)
    timer.unref?.()
    keys.set(key, { timer, held: null })
  }
  return {
    add(key: string, value: T) {
      const entry = keys.get(key)
      if (entry) { entry.held = entry.held ? merge(entry.held, value) : value; return }
      emit(key, value)
      open(key)
    },
    stop() { for (const { timer } of keys.values()) clearTimeout(timer); keys.clear() },
  }
}
const mergeParts = (a: readonly Part[], b: readonly Part[]) => PARTS.filter(part => a.includes(part) || b.includes(part))

/**
 * WebSocket roadmap Phase 2a, client reads: a person's apps read the Swarm they show every 3 s (Desktop) or 15 s (browser),
 * and which Swarms they are in every 15 s, almost always to find nothing new. Each of their sockets, the daemon's
 * (lib/adapterAccountPushes.ts, relayed to the windows) or a browser's or phone's (lib/webWs.ts), now hears a
 * `swarm_changed` frame naming the Swarm, the commit's time and which stamps moved (`main`, or `machine` for a machine's
 * reading alone) when a commit changed a Swarm they are in; the app reads it then, with a long safety net.
 *
 * The frame with no payload says this server pushes; a client from before this ignores it and keeps its timers.
 *
 * `userId` is the socket's own signed-in account, never one the client names. The store names only the Swarm's people, so
 * a viewer who is not in the Swarm hears nothing. The frame carries nothing but the id, a time and the parts; the app reads
 * through the checked read, which decides what it may see.
 *
 * Resolves to the unsubscribe. Redis unreachable, it says nothing and never fails the socket.
 */
export async function relaySwarmChanges(userId: string, send: (frame: unknown) => unknown): Promise<() => void> {
  const tell = (payload: Partial<SwarmMemberMsg>) => { send({ type: 'swarm_changed', payload }) }
  const perSwarm = coalescer<SwarmMemberMsg>((held, next) => ({ tabId: held.tabId, lastChangedAt: Math.max(held.lastChangedAt, next.lastChangedAt),
    parts: mergeParts(held.parts, next.parts) }), (_tabId, msg) => tell(msg))
  // This socket's repeat goes through the person's channel (review of #2113): no Redis, no repeat, and the apps go back to
  // their timers. Each socket names its own, so the person's other sockets ignore it.
  const self = randomUUID()
  let unsubscribe: () => void
  try {
    unsubscribe = await subscribeSwarmMember(userId, msg => {
      const { tabId, lastChangedAt, parts, pushes } = (msg && typeof msg === 'object' ? msg : {}) as Record<string, unknown>
      if (pushes !== undefined) { if (pushes === self) tell({}); return }
      if (typeof tabId !== 'string' || typeof lastChangedAt !== 'number' || !Array.isArray(parts) || !parts.length
        || !parts.every(part => PARTS.includes(part as Part))) return
      perSwarm.add(tabId, { tabId, lastChangedAt, parts: mergeParts(parts as Part[], []) })
    })
  } catch (error) {
    // Not told that the server pushes, the apps keep their timers: nothing waits longer, only the saving is lost.
    logger.warn('[swarm] change pushes unavailable for this socket', { userId, error: error instanceof Error ? error.message : String(error) })
    return () => {}
  }
  tell({})
  const repeat = setInterval(() => {
    void publishSwarmMember(userId, { pushes: self }).then(heard => {
      if (!heard) logger.warn('[swarm] change push repeat reached no one; apps fall back to their timers', { userId })
    })
  }, PUSHES_REPEAT_MS)
  return () => {
    clearInterval(repeat)
    perSwarm.stop()
    unsubscribe()
  }
}

/** This process's commits, at most one publish per Swarm a second to every person of that second's commits. */
const announced = coalescer<SwarmChanged>((held, next) => ({ tabId: held.tabId, userIds: [...new Set([...held.userIds, ...next.userIds])],
  lastChangedAt: Math.max(held.lastChangedAt, next.lastChangedAt), parts: mergeParts(held.parts, next.parts) }),
(_tabId, { tabId, userIds, lastChangedAt, parts }) => {
  for (const userId of userIds) void publishSwarmMember(userId, { tabId, lastChangedAt, parts })
})

/** The store's `swarmChanged` on every server that writes Swarms (routes/superTabs.ts, worker.ts). Dropped when Redis is
 *  away; each app's safety-net read still finds the change. */
export function announceSwarmChanges(change: SwarmChanged): void {
  announced.add(change.tabId, change)
}
