/**
 * A service's side of the relays when it runs in a process of its own (the core's side is core/relays.ts): what it hands
 * another service it asks the core to pass on (`relay`), and what the core passes it and its partners coming and going
 * come as `service_event`s (`relay`, `relay_peer`), which it hands to whoever listens here.
 */
import type { RelayCore } from '../core/api.js'

type Payload = Record<string, unknown>

/** `query` asks the core (`CoreConnection.query`, services/process.ts); it rejects when the link goes. */
export function relayLink(query: (query: string, payload: Payload) => Promise<Payload>, log: (line: string) => void = (line) => console.warn(line)) {
  const hearers = new Map<string, Set<(payload: unknown) => void>>()
  const peers = new Set<(service: string, up: boolean) => void>()
  const safely = (what: string, call: () => void): void => {
    try { call() } catch (error) { log(`[relays] a listener failed on ${what} · ${error instanceof Error ? error.message : String(error)}`) }
  }
  const relay: RelayCore = {
    // Never waited on: a sticky kind is its sender's whole latest word, so a word the core missed is said whole with the next.
    tell: (kind, payload) => { void query('relay', { kind, payload }).catch(() => {}) },
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
    /** A `service_event` from the core, handed to its listeners: true when it was the relays'. */
    heard(payload: Payload): boolean {
      if (payload.kind === 'relay' && typeof payload.relay === 'string') {
        const kind = payload.relay
        for (const hear of hearers.get(kind) ?? []) safely(kind, () => hear(payload.payload ?? null))
        return true
      }
      if (payload.kind === 'relay_peer' && typeof payload.service === 'string' && typeof payload.up === 'boolean') {
        const { service, up } = payload
        for (const hear of peers) safely(`${service} ${up ? 'up' : 'gone'}`, () => hear(service, up))
        return true
      }
      return false
    },
  }
}
