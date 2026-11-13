/**
 * What one service hands another through the core, unread (core/api.ts `RELAYS`): the Swarm's cards and waits for the
 * dials. The core passes each kind on between the two services it names alone, up to `RELAY_MAX_BYTES`, and the receiver
 * checks it (cable/swarmCardsIn.ts, cable/swarmWaits.ts): the core reads none of it. It keeps a sticky kind's latest word and
 * says it again to a receiver that connects, so a devices process that restarts has the cards and the waits back without
 * the Swarm's service saying them again. And it tells each service when one it relays with connects or goes (`onPeer`):
 * the Swarm's service stops reading cards for devices that went, and the devices say again what they want of a Swarm's
 * service that restarted.
 *
 * The other way, a service asks another's requests through the core (`RELAY_ASKS`): the devices' requests of the Swarm's
 * cards, by their action, and no other action, as this computer's owner.
 *
 * Until 2026-11-13 the Swarm's door in the core checked the cards and the waits itself (superTabs/inCore/cards.ts,
 * attention.ts) and kept which cards the devices wanted: the core held Swarm code for a feature of the dial.
 */
import { RELAY_ASKS, RELAY_MAX_BYTES, RELAYS, type RelayCore } from './api.js'

type Payload = Record<string, unknown>

/** The Swarm's names for its kinds before 2026-11-13, which a Swarm process from an older build still sends while it runs
 *  beside a newer core (a master without process.execve keeps its services running). They go on or after 2026-12-13. */
const KINDS_BEFORE: Readonly<Record<string, { kind: string; field: string }>> = {
  super_tab_cards: { kind: 'swarm_cards', field: 'items' },
  super_tab_card_recap: { kind: 'swarm_card_recap', field: 'recap' },
  super_tab_attention: { kind: 'swarm_waits', field: 'items' },
}

export interface RelaysDeps {
  /** Whether [service] runs in a process of its own; else it is in this one, and hears through `RelayCore`. */
  ownProcess(service: string): boolean
  /** A `service_event` for [service]'s own process; false when it is not connected to hear it. */
  notify(service: string, payload: Payload): boolean
  /** A request of [type] as this computer's owner asks it, to whichever service answers it. */
  route(type: string, payload: Payload): Promise<Payload>
  log?: (line: string) => void
}

/** The services [service] relays with, either way. */
const partners = (service: string): Set<string> => {
  const found = new Set<string>()
  for (const { from, to } of Object.values(RELAYS)) {
    if (from === service) found.add(to)
    if (to === service) found.add(from)
  }
  for (const [asker, { to }] of Object.entries(RELAY_ASKS)) {
    if (asker === service) found.add(to)
    if (to === service) found.add(asker)
  }
  return found
}

export function createRelays(deps: RelaysDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  /** The latest word of each sticky kind, said again to its receiver as it connects. */
  const kept = new Map<string, unknown>()
  /** The services in this process that hear each kind, and those that hear their partners come and go. */
  const hearers = new Map<string, Set<(payload: unknown) => void>>()
  const peers = new Set<(service: string, up: boolean) => void>()
  const safely = (what: string, call: () => void): void => {
    try { call() } catch (error) { log(`[relays] a listener failed on ${what} · ${error instanceof Error ? error.message : String(error)}`) }
  }

  const deliver = (kind: string, payload: unknown): void => {
    const { to } = RELAYS[kind]!
    if (deps.ownProcess(to)) { deps.notify(to, { kind: 'relay', relay: kind, payload }); return }
    for (const hear of hearers.get(kind) ?? []) safely(kind, () => hear(payload))
  }

  /** [from]'s [kind]: passed on when [from] is its sender and it is not too large; null says its last word is gone. */
  const pass = (from: string, kind: string, payload: unknown): boolean => {
    const relay = Object.hasOwn(RELAYS, kind) ? RELAYS[kind]! : null
    if (!relay || relay.from !== from) return false
    let bytes = Infinity
    try { bytes = Buffer.byteLength(JSON.stringify(payload ?? null)) } catch { /* A cycle or a bigint is no word to pass on. */ }
    if (bytes > RELAY_MAX_BYTES) {
      log(`[relays] ${kind} from ${from} is ${bytes} bytes, over ${RELAY_MAX_BYTES}: not passed on`)
      return false
    }
    if (relay.sticky) {
      if (payload === null || payload === undefined) kept.delete(kind)
      else kept.set(kind, payload)
    }
    deliver(kind, payload ?? null)
    return true
  }

  const told = (service: string, up: boolean): void => {
    for (const partner of partners(service)) {
      if (deps.ownProcess(partner)) deps.notify(partner, { kind: 'relay_peer', service, up })
      else for (const hear of peers) safely(`${service} ${up ? 'up' : 'gone'}`, () => hear(service, up))
    }
  }

  /** The core's `relay`, for the services in this process: each kind has one sender, which `RELAYS` names. */
  const api: RelayCore = {
    tell: (kind, payload) => { if (Object.hasOwn(RELAYS, kind)) pass(RELAYS[kind]!.from, kind, payload) },
    on: (kind, hear) => {
      const set = hearers.get(kind) ?? new Set()
      set.add(hear)
      hearers.set(kind, set)
      // A receiver here that starts after its sender spoke hears the sticky word it missed, as one in its own process
      // does when it connects: the devices start late in the core's process, and the Swarm's waits are said only on a change.
      if (kept.has(kind)) safely(kind, () => hear(kept.get(kind)))
      return () => { set.delete(hear) }
    },
    onPeer: (hear) => {
      peers.add(hear)
      return () => { peers.delete(hear) }
    },
  }

  return {
    api,

    /** A service in its own process handing one of its kinds on (`service_query` `relay`), or null when the query is not one. */
    answer(service: string, query: string, payload: Payload): Payload | null {
      const before = Object.hasOwn(KINDS_BEFORE, query) ? KINDS_BEFORE[query]! : null
      if (query !== 'relay' && !before) return null
      const kind = before ? before.kind : typeof payload.kind === 'string' ? payload.kind : ''
      return pass(service, kind, before ? payload[before.field] : payload.payload) ? {} : { error: 'NOT_A_RELAY' }
    },

    /** [service]'s request of another's, by its action, when `RELAY_ASKS` lists it; else refused. */
    ask(service: string, payload: Payload): Promise<Payload> {
      const asked = Object.hasOwn(RELAY_ASKS, service) ? RELAY_ASKS[service]! : null
      if (!asked || typeof payload.action !== 'string' || !asked.actions.includes(payload.action)) return Promise.resolve({ error: 'INVALID_REQUEST' })
      return deps.route(asked.type, payload).catch((): Payload => ({ error: 'SERVICE_UNAVAILABLE' }))
    },

    /** A service in its own process connected: it hears its sticky kinds' latest words, and its partners hear that it is up. */
    connected(service: string): void {
      for (const [kind, payload] of kept) if (RELAYS[kind]!.to === service) deps.notify(service, { kind: 'relay', relay: kind, payload })
      told(service, true)
    },

    /** A service in its own process went: its partners hear it. */
    disconnected(service: string): void {
      told(service, false)
    },

    /** The account ended: no sender's last word is kept, and each receiver hears that every sticky kind is gone, kept here
     *  or not: a devices process that outlived a core still shows the last account's cards. */
    reset(): void {
      kept.clear()
      for (const [kind, { sticky }] of Object.entries(RELAYS)) if (sticky) deliver(kind, null)
    },
  }
}

export type Relays = ReturnType<typeof createRelays>
