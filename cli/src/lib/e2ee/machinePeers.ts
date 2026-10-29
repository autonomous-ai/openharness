/**
 * Persistence for the "this machine trusts machine X" relation — a third E2EE trust relation distinct
 * from browser↔this-machine (`E2eeStore`/`paired.json`). Established via `harness remote-password set`
 * (on the peer, a persistent shared secret) + `harness link connect <machineId>` (here, which proves
 * knowledge of that secret via a password-authenticated CPace exchange — see passwordPake.ts), never
 * via the live 6-digit CPace pairing code — see relayClient.ts for the session this pin then
 * bootstraps. Same file-permission conventions as `E2eeStore`: ${ADAPTER_DATA_DIR}/e2e/, 0700 dir /
 * 0600 file.
 *
 * Deliberately NOT cached in memory: `harness link connect` runs as its own short-lived process,
 * independent of the daemon — the daemon's `RemoteRelayPool` must see a link the moment `link connect`
 * writes it, not only after a restart. The file is tiny and read rarely (once per fresh relay dial),
 * so reading fresh every time costs nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { b64d, fingerprint } from './core.js'

const DIR = join(env.ADAPTER_DATA_DIR, 'e2e')
const FILE = join(DIR, 'machinePeers.json')
// Machines the backend said were deleted (remoteRelay.ts): kept out of this file until the machine list shows them again.
// Not per account (accountTrust.ts leaves it in place): a deleted machine id is gone for every account.
const GONE_FILE = join(DIR, 'machinePeers-gone.json')
const GONE_MAX = 256

export interface MachinePeer {
  machineId: string
  pub: string // base64 Ed25519 pubkey of the peer machine's own identity
  label: string
  linkedAt: number
  /** Another account's machine shared with this one (gateway/sharedTrust.ts): dialed like the account's
   *  own, but never a member of the trust group, which never exchanges rosters with it. */
  shared?: true
}

function readAll(): Map<string, MachinePeer> {
  const peers = new Map<string, MachinePeer>()
  try {
    const arr = JSON.parse(readFileSync(FILE, 'utf-8')) as MachinePeer[]
    for (const p of arr) {
      if (p?.machineId && p?.pub) peers.set(p.machineId, p)
    }
  } catch { /* none yet */ }
  return peers
}

function writeAll(peers: Map<string, MachinePeer>): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(FILE, JSON.stringify([...peers.values()], null, 2), { mode: 0o600 })
}

function writeGone(gone: Set<string>): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(GONE_FILE, JSON.stringify([...gone].slice(-GONE_MAX)), { mode: 0o600 })
}

export class MachinePeerStore {
  get(machineId: string): MachinePeer | null {
    return readAll().get(machineId) ?? null
  }

  pin(machineId: string, pub: string, label: string, at = Date.now(), shared = false): void {
    const peers = readAll()
    peers.set(machineId, { machineId, pub, label, linkedAt: at, ...(shared ? { shared: true as const } : {}) })
    writeAll(peers)
  }

  unlink(machineId: string): boolean {
    const peers = readAll()
    if (!peers.delete(machineId)) return false
    writeAll(peers)
    return true
  }

  /** The backend said [machineId] was deleted: drop its pin, and remember it so the trust group does not pin it again. */
  markGone(machineId: string): void {
    this.unlink(machineId)
    const gone = this.gone()
    gone.delete(machineId)
    gone.add(machineId)
    writeGone(gone)
  }

  /** Machines marked gone. */
  gone(): Set<string> {
    try {
      const raw = JSON.parse(readFileSync(GONE_FILE, 'utf-8')) as unknown
      return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [])
    } catch { return new Set() }
  }

  /** The account's machine list names [listed]: any of them marked gone is back (re-added, or shared again). True when one was. */
  restore(listed: Iterable<string>): boolean {
    const gone = this.gone()
    let back = false
    for (const id of listed) back = gone.delete(id) || back
    if (back) writeGone(gone)
    return back
  }

  list(): Array<MachinePeer & { fingerprint: string }> {
    return [...readAll().values()]
      .map((p) => ({ ...p, fingerprint: fingerprint(b64d(p.pub)) }))
      .sort((a, b) => b.linkedAt - a.linkedAt)
  }
}
