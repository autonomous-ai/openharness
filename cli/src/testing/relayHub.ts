/**
 * A relay for a test (core/relays.ts is the real one): what a service hands on is kept in `told`, and a word or a partner
 * coming and going is said to it with `say` and `peer`, as the core would.
 */
import type { RelayCore } from '../core/api.js'

export function relayHub() {
  const hearers = new Map<string, Set<(payload: unknown) => void>>()
  const peers = new Set<(service: string, up: boolean) => void>()
  const told: Array<[kind: string, payload: unknown]> = []
  const relay: RelayCore = {
    tell: (kind, payload) => { told.push([kind, payload]) },
    on: (kind, hear) => {
      const set = hearers.get(kind) ?? new Set()
      set.add(hear)
      hearers.set(kind, set)
      return () => { set.delete(hear) }
    },
    onPeer: (hear) => {
      peers.add(hear)
      return () => { peers.delete(hear) }
    },
  }
  return {
    relay,
    told,
    say: (kind: string, payload: unknown): void => { for (const hear of hearers.get(kind) ?? []) hear(payload) },
    peer: (service: string, up: boolean): void => { for (const hear of peers) hear(service, up) },
  }
}
