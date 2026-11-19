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
 * key in both places, never in neither. The whole files always move, as one unit, never parsed: left behind, the account
 * left's roster, blocks and pins went on to the next one, and a switch back put an older block list over the newer.
 * paired.json is split, so it is read: one that cannot be read throws StateFileUnreadable once the whole files have
 * moved, and is left as it is, never read as empty and written over.
 *
 * ponytail: no journal. A switch that dies between `stashTrust` and `unstashTrust` and is run again
 * stashes what was already restored under the account it leaves. The caller runs the switch once and
 * goes on whatever it throws, and each account's log brings its devices back on its own; a journal
 * (accounts/.switching) is the upgrade if that ever matters.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { atomicWriteJson, jsonArray, requireState, StateFileUnreadable } from '../secureState.js'

/** The stores moved whole: the trust group's roster and blocks, and the machines this one dials. */
const WHOLE = ['group.json', 'group-blocked.json', 'machinePeers.json']
const PAIRED = 'paired.json'
/** An account id is a path segment here. The backend's are Mongo ObjectIds; anything else is refused. */
const ACCT = /^[A-Za-z0-9_-]{1,64}$/
/** A machine holds a handful of accounts; whoever lists the kept folders reads no more than this. */
const KEPT_ACCOUNTS = 64

type Paired = { identityPub?: unknown; role?: unknown }

const defaultDir = (): string => join(env.ADAPTER_DATA_DIR, 'e2e')

function accountDir(dir: string, acct: string): string {
  if (!ACCT.test(acct)) throw new Error(`not an account id: ${JSON.stringify(acct.slice(0, 80))}`)
  return join(dir, 'accounts', acct)
}

/** The paired set in [file], null when there is none; throws StateFileUnreadable when it cannot be read. */
function readPaired(file: string): Paired[] | null {
  return requireState(file, jsonArray) as Paired[] | null
}

/** The folders `stashTrust` kept, one per account: at most KEPT_ACCOUNTS. None when they cannot be listed, said by the
 *  error's code: `harness status` lists them, and must not end on a folder it cannot read. */
export function keptAccountDirs(dir = defaultDir()): string[] {
  const accounts = join(dir, 'accounts')
  try {
    return readdirSync(accounts, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ACCT.test(entry.name))
      .slice(0, KEPT_ACCOUNTS)
      .map((entry) => join(accounts, entry.name))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.warn(`[state] the trust kept per account cannot be listed (${code ?? 'unknown'})`)
    return []
  }
}

/** Every whole file in `from` renamed into `to`. */
function moveWhole(from: string, to: string): void {
  for (const name of WHOLE) if (existsSync(join(from, name))) renameSync(join(from, name), join(to, name))
}

/** Put away what `acct` trusts here; the live stores are left holding only the Wi-Fi device's pairings. */
export function stashTrust(acct: string, dir = defaultDir()): void {
  const kept = accountDir(dir, acct)
  mkdirSync(kept, { recursive: true, mode: 0o700 })
  moveWhole(dir, kept)
  const live = readPaired(join(dir, PAIRED))
  const accounts = live?.filter((p) => p.role !== 'device') ?? []
  // Nothing of the account's left live: an earlier stash cut it already, and its copy stays as it is.
  if (!live || !accounts.length) return
  // The copy below replaces the kept one: it must be readable, or it is left and the split is refused.
  readPaired(join(kept, PAIRED))
  atomicWriteJson(join(kept, PAIRED), accounts, 'trust')
  atomicWriteJson(join(dir, PAIRED), live.filter((p) => p.role === 'device'), 'trust')
}

/** Bring back what `acct` trusted when this machine left it; nothing kept means it starts empty. */
export function unstashTrust(acct: string, dir = defaultDir()): void {
  const kept = accountDir(dir, acct)
  moveWhole(kept, dir)
  const back = readPaired(join(kept, PAIRED))
  if (!back) return
  // The live set is replaced only when a kept copy comes back: only then must it be readable.
  const live = readPaired(join(dir, PAIRED))
  const devices = (live ?? []).filter((p) => p.role === 'device')
  const pubs = new Set(devices.map((p) => p.identityPub))
  atomicWriteJson(join(dir, PAIRED), [...devices, ...back.filter((p) => !pubs.has(p.identityPub))], 'trust')
  rmSync(join(kept, PAIRED), { force: true })
}

/** Leave `from`'s trust for `to`'s. Both ids are checked before anything moves. */
export function switchAccountTrust(from: string, to: string, dir = defaultDir()): void {
  const joined = accountDir(dir, to)
  try {
    stashTrust(from, dir)
  } catch (err) {
    // paired.json was not split, so `to`'s is not merged into it (that would drop what it still holds of `from`). The
    // whole files of `to` still come back: left kept, the next switch would put the ones live now over them.
    if (err instanceof StateFileUnreadable) moveWhole(joined, dir)
    throw err
  }
  unstashTrust(to, dir)
}
