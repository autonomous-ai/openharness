/**
 * Task #3262 (Amon, 11-05): Repair signed his Mac's Harness Team account in for him, but the account's device key log stayed
 * kelvin's. A Team sign-in was always adopted, and an adopted sign-in may never start the log over (a guard against a backend
 * that lies about the account), so the log froze, the account kept trusting only kelvin's devices and refused Amon's daemon.
 *
 * The device key log, its store and the sign-in's reading are the real ones here; only the backend and where trust is kept
 * are played (gateway/start.ts wires them to lib/e2ee/accountTrust.ts, which puts an account's trust away when it leaves).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ed25519 } from '@noble/curves/ed25519'
import { applyDevLogEntries, emptyDevLogState, nextDevLogEntry, signDevLogEntry, type DevLogEntry, type DevLogState } from '../lib/e2ee/deviceLog.js'
import { DeviceLogStore } from '../lib/e2ee/deviceLogStore.js'
import { DEVLOG_RESET_WINDOW_MS, DeviceLogSyncer, type DeviceLogFetched } from '../lib/e2ee/deviceLogSyncer.js'
import { signInOf, teamSignInEpoch } from '../lib/authSession.js'
import { handedTeamSignInEpoch } from './handoff.js'

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const key = (n: number) => { const priv = new Uint8Array(32).fill(n); return { priv, pub: b64(ed25519.getPublicKey(priv)) } }
/** The Team account's own machine key, kelvin's (A) daemon and Amon's (B) daemon on the same Mac. */
const team = key(1), daemonA = key(2), daemonB = key(3)
const A = 'acct-kelvin', B = 'acct-amon'

/** One account's device key log as the backend keeps it. */
class Log {
  entries: DevLogEntry[] = []
  state: DevLogState
  constructor(readonly acct: string) { this.state = emptyDevLogState(acct) }
  add(k: { priv: Uint8Array; pub: string }, machineId: string, label: string): void {
    const e = signDevLogEntry(nextDevLogEntry(this.state, { op: 'add', pub: k.pub, kind: 'machine', machineId, label, signer: k.pub }, 1_000), k.priv)
    this.state = applyDevLogEntries(this.state, [e]).state
    this.entries.push(e)
  }
  fetched(since: number): DeviceLogFetched {
    return { acct: this.acct, head: this.state.head, entries: this.entries.filter((e) => e.seq > since) }
  }
}

function teamAccount(start: number) {
  let now = start
  /** The backend: whichever account's log it serves, which a lying one may pick. */
  let serving: Log
  const logA = new Log(A), logB = new Log(B)
  logA.add(daemonA, 'a'.repeat(32), "kelvin's Mac")
  logB.add(daemonB, 'b'.repeat(32), "Amon's Mac")
  serving = logA
  let epoch = handedTeamSignInEpoch(now)
  /** What this Team account trusts now, and what each account it left trusted, put away (accountTrust.ts). */
  let trusted = new Set<string>()
  const putAway = new Map<string, Set<string>>()
  const store = new DeviceLogStore(join(mkdtempSync(join(tmpdir(), 'team-devlog-')), 'devlog.json'))
  const syncer = new DeviceLogSyncer({
    store,
    identity: () => team,
    self: () => ({ machineId: 't'.repeat(32), label: 'Mac · Team' }),
    signIn: () => signInOf(epoch),
    fetch: async (since) => serving.fetched(since),
    append: async () => null,
    switchAccount: (from, to) => { putAway.set(from, trusted); trusted = putAway.get(to) ?? new Set() },
    adopt: (members) => { for (const m of members) trusted.add(m.pub) },
    drop: (pub) => { trusted.delete(pub) },
    trustedNow: () => [...trusted],
    tombstoned: () => false,
    blocked: () => false,
    isTrusted: (pub) => trusted.has(pub),
    announce: () => {},
    signedOut: () => {},
    now: () => now,
    sleep: async () => {},
  })
  return {
    syncer, store, logA, logB, trusted: () => trusted, putAway,
    serve: (log: Log) => { serving = log },
    signIn: (next: string) => { epoch = next },
    at: (t: number) => { now = t },
    now: () => now,
  }
}

describe('a Harness Team account handed to another owner by Repair', () => {
  it('trusts the new owner\'s daemon and no longer the old owner\'s', async () => {
    const t = teamAccount(1_000_000)
    await t.syncer.refresh()
    expect(t.trusted().has(daemonA.pub)).toBe(true)
    // Repair by Amon: his setup run, behind his password, hands the Team account a new sign-in, and the backend serves his log.
    t.at(t.now() + 60 * 60_000)
    t.signIn(handedTeamSignInEpoch(t.now()))
    t.serve(t.logB)
    t.at(t.now() + 30_000)
    await t.syncer.refresh()
    expect(t.store.read().frozen).toBeNull()
    expect(t.trusted().has(daemonB.pub)).toBe(true)
    expect(t.trusted().has(daemonA.pub)).toBe(false)
    // What kelvin's account trusted is put away under its id: none of it is live for Amon's.
    expect(t.putAway.get(A)?.has(daemonA.pub)).toBe(true)
  })
})

describe('a backend that only says the Team account has a new owner', () => {
  const claimed = async (signIn: (t: ReturnType<typeof teamAccount>) => void) => {
    const t = teamAccount(1_000_000)
    await t.syncer.refresh()
    t.at(t.now() + 60 * 60_000)
    signIn(t)
    t.serve(t.logB)
    await t.syncer.refresh()
    expect(t.store.read().frozen).toMatchObject({ reason: 'invalid' })
    expect(t.trusted().has(daemonA.pub)).toBe(true)
    expect(t.trusted().has(daemonB.pub)).toBe(false)
  }
  it('moves no trust under the sign-in the account already has', async () => {
    await claimed(() => {})
  })
  it('moves no trust under a Team sign-in no setup run handed over', async () => {
    await claimed((t) => t.signIn(teamSignInEpoch(t.now())))
  })
  it('moves no trust once the handed sign-in is older than the reset window', async () => {
    await claimed((t) => { t.signIn(handedTeamSignInEpoch(t.now())); t.at(t.now() + DEVLOG_RESET_WINDOW_MS + 60_000) })
  })
})
