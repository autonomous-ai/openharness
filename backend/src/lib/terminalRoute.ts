/**
 * Where a frame an adapter sends for one viewer goes (spec docs/superpowers/specs/2026-10-31-terminal-relay-direct-design.md).
 * Every terminal frame, binary hop or JSON, is for exactly one viewer connection, yet it was published to the machine's
 * channel: every process holding any viewer of that machine decoded it and all but one dropped it, and the adapter's own
 * process got it back from Redis even when it held the viewer itself.
 *
 * Per connection, on this adapter socket:
 * - the viewer is on this process: delivered here, no Redis;
 * - else, with TERMINAL_POD_ROUTES on and the viewer's process recorded (hub.ts): published to that process alone, once
 *   the record is read; until then, and for good without a record (a process on the previous release, a failed lookup),
 *   the machine's channels, as before (see createConnectionRoutes for why the one switch keeps order).
 */
import * as registry from './registry.js'
import { deliverTerminalUpLocal, deliverUpLocal, podRoutesOn } from './hub.js'
import { connOwner, publishPodHop, publishPodJson, publishTerminalUp, publishUp } from './bus.js'
import { recordRelay } from './relayStats.js'
import type { UpBusMsg } from './tunnel.js'

/** Routes one adapter socket keeps, most recently used last. An adapter socket lives for days while Desktop attaches a new
 *  connection on every agent switch; an active connection is only forgotten after this many others were used since. */
export const MAX_ROUTES = 2_000

type Route = { to: 'local' } | { to: 'machine' } | { to: 'process'; owner: string }

export interface ConnectionRoutes {
  /** A binary terminal hop (output, keyframe, sync) for `connId`. */
  hop(packet: Uint8Array, connId: string): void
  /** A JSON up frame addressed to one connection (`targetConnId`). */
  targeted(msg: UpBusMsg & { targetConnId: string }): void
  /** The adapter socket closed: forget every route. */
  close(): void
}

/**
 * A connection's route: local if its viewer is here (for good: a `connId` never moves). Otherwise the machine's channels
 * while its owner is looked up, then, if another process owns it, that process's channels. That one switch keeps order:
 * both channels are published from the same Redis connection, the owner reads both on the same subscriber connection
 * (`up:`/`uppod:`, `termup:`/`termpod:`), and it holds a viewer of the machine, so it listens to the machine's channels.
 * Nothing waits for the lookup, so the machine's untargeted frames sent after a targeted one cannot overtake it.
 */
export function createConnectionRoutes(machineId: string): ConnectionRoutes {
  const routes = new Map<string, Route>()
  const looking = new Set<string>()
  let closed = false

  const keep = (connId: string, route: Route) => {
    routes.delete(connId)
    routes.set(connId, route)
    if (routes.size > MAX_ROUTES) routes.delete(routes.keys().next().value!)
  }
  const route = (connId: string): Route => {
    const known = routes.get(connId)
    if (known) { keep(connId, known); return known }
    if (registry.clientsFor(machineId).some(c => c.connId === connId)) {
      const local: Route = { to: 'local' }
      keep(connId, local)
      return local
    }
    const machine: Route = { to: 'machine' }
    if (!podRoutesOn()) { keep(connId, machine); return machine }
    if (!looking.has(connId)) {
      looking.add(connId)
      void connOwner(connId).then(owner => {
        looking.delete(connId)
        if (closed) return
        keep(connId, owner && owner !== registry.PROCESS_ID ? { to: 'process', owner } : machine)
      }, () => { looking.delete(connId); if (!closed) keep(connId, machine) })
    }
    return machine
  }

  return {
    hop(packet, connId) {
      if (closed) return
      const r = route(connId)
      if (r.to === 'local') { deliverTerminalUpLocal(machineId, packet); recordRelay('termup', 'local'); return }
      if (r.to === 'process') { void publishPodHop(r.owner, machineId, packet).then(n => recordRelay('pod hop', 'published', n)); return }
      void publishTerminalUp(machineId, packet).then(n => recordRelay('termup', 'published', n))
    },
    targeted(msg) {
      if (closed) return
      const r = route(msg.targetConnId)
      if (r.to === 'local') { deliverUpLocal(machineId, msg); recordRelay('up targeted', 'local'); return }
      if (r.to === 'process') { void publishPodJson(r.owner, machineId, msg).then(n => recordRelay('pod json', 'published', n)); return }
      void publishUp(machineId, msg).then(n => recordRelay('up targeted', 'published', n))
    },
    close() {
      closed = true
      routes.clear()
      looking.clear()
    },
  }
}
