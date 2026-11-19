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
import { mkdirSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { errorKind } from '../log.js'
import { atomicWriteFile, atomicWriteJson, jsonArray, readState, requireState, type TrustFile } from '../secureState.js'
import { b64d, fingerprint } from './core.js'

const DIR = join(env.ADAPTER_DATA_DIR, 'e2e')
const FILE = join(DIR, 'machinePeers.json')
// Machines the backend said were deleted (remoteRelay.ts): kept out of this file until the machine list shows them again.
// Not per account (accountTrust.ts leaves it in place): a deleted machine id is gone for every account.
const GONE_FILE = join(DIR, 'machinePeers-gone.json')
const GONE_MAX = 256
// Marks the file could not take (a full or read-only disk, review of #2101), for every store in this process: they still
// keep the trust group from pinning the machine again and the relay from dialling it, until the daemon restarts.
const goneInMemory = new Set<string>()
// And the other way: machines listed again whose mark the file could not drop (review of #2101, Batch S).
const backInMemory = new Set<string>()

export interface MachinePeer {
  machineId: string
  pub: string // base64 Ed25519 pubkey of the peer machine's own identity
  label: string
  linkedAt: number
  /** Another account's machine shared with this one (gateway/sharedTrust.ts): dialed like the account's
   *  own, but never a member of the trust group, which never exchanges rosters with it. */
  shared?: true
}

/** Both files, for whoever names the trust files that cannot be read. */
export function machinePeerFiles(): TrustFile[] {
  return [{ file: FILE, parse: jsonArray }, { file: GONE_FILE, parse: jsonArray }]
}

function peersIn(list: unknown[] | null): Map<string, MachinePeer> {
  const peers = new Map<string, MachinePeer>()
  for (const p of (list ?? []) as MachinePeer[]) {
    if (p?.machineId && p?.pub) peers.set(p.machineId, p)
  }
  return peers
}

/** The pins. A file that cannot be read pins nobody: a machine not pinned is neither dialled nor trusted. */
function readAll(): Map<string, MachinePeer> {
  const read = readState(FILE, 'trust', jsonArray)
  return peersIn(read.state === 'ok' ? read.value : null)
}

/** The pins a change starts from. A file that cannot be read throws StateFileUnreadable: written over, every pin in it
 *  but the one changed would be lost. */
function readForChange(): Map<string, MachinePeer> {
  return peersIn(requireState(FILE, jsonArray))
}

function writeAll(peers: Map<string, MachinePeer>): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  atomicWriteJson(FILE, [...peers.values()], 'trust')
}

/** Throws StateFileUnreadable while the file cannot be read: the marks in it are not known, so it is not written over. */
function writeGone(gone: Set<string>): void {
  requireState(GONE_FILE, jsonArray)
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  atomicWriteFile(GONE_FILE, JSON.stringify([...gone].slice(-GONE_MAX)), 'trust')
}

export class MachinePeerStore {
  get(machineId: string): MachinePeer | null {
    return readAll().get(machineId) ?? null
  }

  pin(machineId: string, pub: string, label: string, at = Date.now(), shared = false): void {
    const peers = readForChange()
    peers.set(machineId, { machineId, pub, label, linkedAt: at, ...(shared ? { shared: true as const } : {}) })
    writeAll(peers)
  }

  unlink(machineId: string): boolean {
    const peers = readForChange()
    if (!peers.delete(machineId)) return false
    writeAll(peers)
    return true
  }

  /** The backend said [machineId] was deleted: drop its pin, and remember it so the trust group does not pin it again.
   *  Throws when the mark or the unpin cannot be written; the mark holds in memory for this process all the same. */
  markGone(machineId: string): void {
    backInMemory.delete(machineId)
    const gone = this.gone()
    gone.delete(machineId)
    gone.add(machineId)
    try { writeGone(gone) } catch (err) { goneInMemory.add(machineId); throw err }
    this.unlink(machineId)
  }

  /** Machines marked gone. */
  gone(): Set<string> {
    const read = readState(GONE_FILE, 'trust', jsonArray)
    // None yet, or unreadable: the marks in memory still hold.
    const kept = read.state === 'ok' ? read.value.filter((id): id is string => typeof id === 'string') : []
    return new Set([...kept.filter((id) => !backInMemory.has(id)), ...goneInMemory])
  }

  /** The account's machine list names [listed]: any of them marked gone is back (re-added, or shared again). True when one was.
   *  Never throws: it runs in the machine-list callback, and a file it cannot rewrite leaves them back in memory. */
  restore(listed: Iterable<string>): boolean {
    const gone = this.gone()
    const back: string[] = []
    for (const id of listed) {
      if (!gone.delete(id)) continue
      goneInMemory.delete(id)
      back.push(id)
    }
    if (!back.length) return false
    try {
      writeGone(gone)
    } catch (err) {
      for (const id of back) backInMemory.add(id)
      console.warn(`[relay] could not record ${back.length} machine(s) as back on the list, kept in memory: ${errorKind(err)}`)
    }
    return true
  }

  list(): Array<MachinePeer & { fingerprint: string }> {
    return [...readAll().values()]
      .map((p) => ({ ...p, fingerprint: fingerprint(b64d(p.pub)) }))
      .sort((a, b) => b.linkedAt - a.linkedAt)
  }
}
