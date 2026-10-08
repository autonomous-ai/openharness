/**
 * A lock directory whose owner record says which process holds it: the mechanics of the daemon's spawn
 * lock (daemonSpawnLock.ts), shared with the agent install lock (agentInstall.ts) rather than written a
 * second time.
 *
 * The lock is a directory made with `mkdir` (0700) and an `owner.json` written with O_EXCL (0600): the
 * holder's pid, its start marker (processLiveness.ts), a token and when it was taken. It is stale, and
 * removed, when its owner is gone: the pid is not running, or is running as another process than the
 * one that took it (`lockOwnerAlive`). One with no owner record, or a record that names no one (a crash
 * or a full disk between the create and the write), is debris once it is older than `ownerlessStaleMs`;
 * younger, it is a lock being made. A stale lock is removed only after reading it again, so one that
 * changed hands meanwhile survives. Anything at the path that this code would not have made (a
 * symlink, another account's directory, a loose mode) is refused, never trusted or removed.
 *
 * There is deliberately no age bound on a live owner: a holder is a holder for as long as its process
 * is the one that took it.
 */
import { randomUUID } from 'crypto'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { lockOwnerAlive, lockStartMarker, processLockIdentity } from './processLiveness.js'
import { secureStateDirectory } from './secureState.js'

const OWNER_FILE = 'owner.json'

/** What an owner record holds; the fields a caller adds ride along as they were written. */
export interface OwnedLockRecord {
  readonly pid: number
  readonly startMarker: string
  readonly generationMarker?: string
  readonly token: string
  readonly since: number
  readonly fields: Readonly<Record<string, unknown>>
}

export interface OwnedLock {
  readonly dir: string
  /**
   * The owner record, or null when there is no readable one, which callers must NOT take as "free":
   * it is also what a lock mid-creation looks like. Throws for something at the path this code would
   * not have made.
   */
  read(): OwnedLockRecord | null
  /** Create the lock for this process with [fields] in its record. The token, or null when it is held. */
  tryCreate(fields: Record<string, unknown>): string | null
  /** Remove the lock if [token] still holds it, or if it is a directory this process made but never wrote. */
  releaseOwnedBy(token: string): void
  /** Remove a lock whose [owner] is gone, after reading it again. True when it was removed. */
  reclaimIfStale(owner: OwnedLockRecord): boolean
  /** Remove a lock that names no one once it is clearly debris. True when it was removed. */
  reclaimIfOwnerless(): boolean
}

function uid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/**
 * [dir] is the lock, inside [parent], the private state directory it is made in. [label] names it in
 * the errors for something at its path that is not one of its locks.
 */
export function ownedLock(opts: { dir: string; parent: string; label: string; ownerlessStaleMs: number }): OwnedLock {
  const { dir, parent, label, ownerlessStaleMs } = opts
  const ownerPath = join(dir, OWNER_FILE)

  const read = (): OwnedLockRecord | null => {
    const me = uid()
    try {
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (me !== null && stat.uid !== me) || (stat.mode & 0o777) !== 0o700) {
        throw new Error(`${label} ${dir} has an unsafe owner, mode, or type`)
      }
      const file = lstatSync(ownerPath)
      if (!file.isFile() || file.isSymbolicLink() || (me !== null && file.uid !== me) || (file.mode & 0o777) !== 0o600) {
        throw new Error(`${label} owner ${ownerPath} has an unsafe owner, mode, or type`)
      }
      const raw = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<string, unknown>
      const pid = Number(raw.pid)
      if (!Number.isSafeInteger(pid) || pid <= 0 || typeof raw.token !== 'string' || !raw.token) return null
      return {
        pid,
        startMarker: typeof raw.startMarker === 'string' ? raw.startMarker : '',
        generationMarker: typeof raw.generationMarker === 'string' ? raw.generationMarker : undefined,
        token: raw.token,
        since: Number.isFinite(Number(raw.since)) ? Number(raw.since) : 0,
        fields: raw,
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(label)) throw error
      return null
    }
  }

  const releaseOwnedBy = (token: string): void => {
    try {
      const saved = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: unknown }
      if (saved.token === token) rmSync(dir, { recursive: true, force: true })
    } catch {
      // A directory we created but never got to write an owner into is ours to remove; anything else
      // belongs to someone.
      try {
        lstatSync(ownerPath)
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ENOENT') rmSync(dir, { recursive: true, force: true })
      }
    }
  }

  const tryCreate = (fields: Record<string, unknown>): string | null => {
    secureStateDirectory(parent)
    const token = randomUUID()
    let created = false
    let opened = false
    try {
      mkdirSync(dir, { mode: 0o700 })
      created = true
      const fd = openSync(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      opened = true
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, ...processLockIdentity(process.pid), token, since: Date.now(), ...fields }))
        fsyncSync(fd)
      } finally { closeSync(fd) }
      return token
    } catch (error) {
      // The owner file is this call's (O_EXCL), so the directory is too, however little of the record
      // reached the disk. A full disk cut it short on 2026-10-05 (e2e/updateHostile.e2e.ts): left there,
      // empty, it named no one that could ever let go, and every update, start and stop after it waited
      // out its 45 s and gave up, long after the space came back.
      if (opened) rmSync(dir, { recursive: true, force: true })
      else if (created) releaseOwnedBy(token)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return null
    }
  }

  const reclaimIfStale = (owner: OwnedLockRecord): boolean => {
    if (lockOwnerAlive(owner.pid, lockStartMarker(owner))) return false
    try {
      const current = read()
      if (current && current.pid === owner.pid && lockStartMarker(current) === lockStartMarker(owner)
        && current.token === owner.token && !lockOwnerAlive(owner.pid, lockStartMarker(owner))) {
        rmSync(dir, { recursive: true, force: true })
        return true
      }
    } catch { /* changed or vanished under us; let the loop look again */ }
    return false
  }

  const reclaimIfOwnerless = (): boolean => {
    try {
      const stat = lstatSync(dir)
      let since = stat.mtimeMs
      try { since = Math.max(since, lstatSync(ownerPath).mtimeMs) } catch { /* no owner file */ }
      if (Date.now() - since > ownerlessStaleMs) {
        rmSync(dir, { recursive: true, force: true })
        return true
      }
    } catch { /* gone already */ }
    return false
  }

  return { dir, read, tryCreate, releaseOwnedBy, reclaimIfStale, reclaimIfOwnerless }
}
