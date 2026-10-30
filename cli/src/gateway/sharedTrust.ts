/**
 * Machines shared across accounts (docs/plans/2026-10-15-share-machine-plan.md), as the gateway's trust
 * stores hold them. The shared-machines service (services/sharedMachines.ts) works out what should be
 * trusted and says it whole each time; this makes the stores say exactly that:
 *
 * - `pins`: the machines shared WITH this account, each under the key its owner's device key log names.
 *   Pinned in machinePeers.json so a window here reaches one through the relay as it does the account's
 *   own (lib/remoteRelay.ts).
 * - `keys`: the machines of the accounts THIS machine is shared with. Trusted in paired.json under role
 *   `web`, each with the account it is shared with (`sharedWith`): its sessions are that GUEST's, which
 *   the core lets use its own space and nothing of the owner's
 *   (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
 *
 * Each is marked `shared`, which keeps it out of the trust group (lib/e2ee/groupSyncer.ts) and lets this
 * take back what it gave and nothing else. Something the account itself already trusts or pins is never
 * touched: sharing adds to the account's own trust, it never changes it. Taking a key back is the same
 * untrust as an unpair: its sessions close and the group key turns over.
 */
import type { MachinePeerStore } from '../lib/e2ee/machinePeers.js'
import type { LinkedPeer } from '../lib/e2ee/manager.js'
import type { PairedClient } from '../lib/e2ee/store.js'

/** One machine and its key, as the service names it. */
export interface SharedPeer { machineId: string; pub: string; label: string; email?: string }

/** What the service wants trusted; the most of each it may ask for. A part left out is left as it is:
 *  the service says only what it could read this time. */
export interface SharedTrustDesired { pins?: SharedPeer[]; keys?: SharedPeer[] }
export const SHARED_TRUST_MAX = 1000

export interface SharedTrustDeps {
  peers: Pick<MachinePeerStore, 'get' | 'pin' | 'unlink' | 'list'>
  paired: () => PairedClient[]
  trust: (peer: LinkedPeer) => void
  untrust: (pub: string) => void
  /** Close the relay sessions to a machine whose pin went or changed. */
  dropSessions: (machineId: string) => void
  /** This machine's own key, never trusted as another's. */
  selfPub: () => string
}

const PUB_RE = /^[A-Za-z0-9+/]{43}=$/
const MACHINE_RE = /^[A-Za-z0-9_-]{1,128}$/
const EMAIL_RE = /^[^\s@]{1,128}@[^\s@]{1,128}$/

/** The valid peers of a list the service sent, at most SHARED_TRUST_MAX, each machine and key once. */
export function sharedPeers(raw: unknown): SharedPeer[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: SharedPeer[] = []
  for (const item of raw.slice(0, SHARED_TRUST_MAX)) {
    const p = item as Partial<SharedPeer> | null
    if (!p || typeof p.pub !== 'string' || !PUB_RE.test(p.pub) || typeof p.machineId !== 'string' || !MACHINE_RE.test(p.machineId)) continue
    if (seen.has(p.machineId) || seen.has(p.pub)) continue
    seen.add(p.machineId); seen.add(p.pub)
    const email = typeof p.email === 'string' && EMAIL_RE.test(p.email.trim()) ? p.email.trim().toLowerCase() : undefined
    out.push({ machineId: p.machineId, pub: p.pub, label: typeof p.label === 'string' ? p.label.slice(0, 120) : '', ...(email ? { email } : {}) })
  }
  return out
}

/** Make the stores hold exactly `desired` among what sharing put there; how many of each it holds now. */
export function applySharedTrust(deps: SharedTrustDeps, desired: SharedTrustDesired): { pins: number; keys: number } {
  const self = deps.selfPub()
  return {
    pins: desired.pins ? applyPins(deps, desired.pins.filter((p) => p.pub !== self)) : deps.peers.list().filter((p) => p.shared).length,
    keys: desired.keys ? applyKeys(deps, desired.keys.filter((k) => k.pub !== self)) : deps.paired().filter((p) => p.shared).length,
  }
}

function applyPins(deps: SharedTrustDeps, desired: SharedPeer[]): number {
  const pins = new Map(desired.map((p) => [p.machineId, p]))
  for (const held of deps.peers.list()) {
    if (!held.shared || pins.get(held.machineId)?.pub === held.pub) continue
    deps.peers.unlink(held.machineId)
    deps.dropSessions(held.machineId)
  }
  let pinned = 0
  for (const want of pins.values()) {
    const held = deps.peers.get(want.machineId)
    if (held && !held.shared) continue // the account's own machine: its pin is the trust group's
    if (!held || held.pub !== want.pub) deps.peers.pin(want.machineId, want.pub, want.label, Date.now(), true)
    pinned++
  }
  return pinned
}

function applyKeys(deps: SharedTrustDeps, desired: SharedPeer[]): number {
  const keys = new Map(desired.map((k) => [k.pub, k]))
  const paired = deps.paired()
  for (const held of paired) if (held.shared && !keys.has(held.identityPub)) deps.untrust(held.identityPub)
  let trusted = 0
  for (const want of keys.values()) {
    const held = paired.find((p) => p.identityPub === want.pub)
    if (held && !held.shared) continue // trusted as the account's own already
    deps.trust({ pub: want.pub, machineId: want.machineId, kind: 'machine', label: want.label, shared: true, ...(want.email ? { sharedWith: want.email } : {}) })
    trusted++
  }
  return trusted
}

/** Whether `pub` is trusted here only because of sharing. */
export function isSharedKey(paired: PairedClient[], pub: string): boolean {
  return paired.some((p) => p.identityPub === pub && p.shared === true)
}
