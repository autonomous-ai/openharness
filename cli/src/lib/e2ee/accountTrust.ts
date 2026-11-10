/**
 * What this machine trusts, kept per account: when it moves from one account's device log to another's
 * (deviceLogSyncer `switchAccount`), the trust stores of the account it leaves go to
 * ${ADAPTER_DATA_DIR}/e2e/accounts/<acct>/ and the ones it kept for the account it joins come back.
 * Before this, signing out of A and in to B left A's browsers paired here, A's roster went out to B's
 * machines over `group_sync`, and A's keys counted as "already trusted" in B's log, so none of them was
 * ever shown as a new device.
 *
 * The Wi-Fi device's pairings (`role: 'device'` in paired.json) stay: the device belongs to this
 * computer, not to an account. identity.json is never touched.
 *
 * Every step is a rename, or a write of the copy before the original is cut: a crash part way leaves a
 * key in both places, never in neither.
 *
 * ponytail: no journal. A switch that dies between `stashTrust` and `unstashTrust` and is run again
 * stashes what was already restored under the account it leaves. The caller runs the switch once and
 * goes on whatever it throws, and each account's log brings its devices back on its own; a journal
 * (accounts/.switching) is the upgrade if that ever matters.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'

/** The stores moved whole: the trust group's roster and blocks, and the machines this one dials. */
const WHOLE = ['group.json', 'group-blocked.json', 'machinePeers.json']
const PAIRED = 'paired.json'
/** An account id is a path segment here. The backend's are Mongo ObjectIds; anything else is refused. */
const ACCT = /^[A-Za-z0-9_-]{1,64}$/

type Paired = { identityPub?: unknown; role?: unknown }

const defaultDir = (): string => join(env.ADAPTER_DATA_DIR, 'e2e')

function accountDir(dir: string, acct: string): string {
  if (!ACCT.test(acct)) throw new Error(`not an account id: ${JSON.stringify(acct.slice(0, 80))}`)
  return join(dir, 'accounts', acct)
}

function readList(file: string): Paired[] | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    return Array.isArray(raw) ? raw as Paired[] : null
  } catch { return null }
}

function writeAtomic(file: string, data: unknown): void {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}

/** Put away what `acct` trusts here; the live stores are left holding only the Wi-Fi device's pairings. */
export function stashTrust(acct: string, dir = defaultDir()): void {
  const kept = accountDir(dir, acct)
  mkdirSync(kept, { recursive: true, mode: 0o700 })
  for (const name of WHOLE) if (existsSync(join(dir, name))) renameSync(join(dir, name), join(kept, name))
  const live = readList(join(dir, PAIRED))
  const accounts = live?.filter((p) => p.role !== 'device') ?? []
  // Nothing of the account's left live: an earlier stash cut it already, and its copy stays as it is.
  if (!live || !accounts.length) return
  writeAtomic(join(kept, PAIRED), accounts)
  writeAtomic(join(dir, PAIRED), live.filter((p) => p.role === 'device'))
}

/** Bring back what `acct` trusted when this machine left it; nothing kept means it starts empty. */
export function unstashTrust(acct: string, dir = defaultDir()): void {
  const kept = accountDir(dir, acct)
  for (const name of WHOLE) if (existsSync(join(kept, name))) renameSync(join(kept, name), join(dir, name))
  const back = readList(join(kept, PAIRED))
  if (!back) return
  const devices = (readList(join(dir, PAIRED)) ?? []).filter((p) => p.role === 'device')
  const pubs = new Set(devices.map((p) => p.identityPub))
  writeAtomic(join(dir, PAIRED), [...devices, ...back.filter((p) => !pubs.has(p.identityPub))])
  rmSync(join(kept, PAIRED), { force: true })
}

/** Leave `from`'s trust for `to`'s. Both ids are checked before anything moves. */
export function switchAccountTrust(from: string, to: string, dir = defaultDir()): void {
  accountDir(dir, to)
  stashTrust(from, dir)
  unstashTrust(to, dir)
}
