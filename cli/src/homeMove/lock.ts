import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * How often a start waiting for another start's move looks again: an owner killed changes nothing beside the lock, and
 * the data root it commits is not beside it either. The first look this far into a wait also says the wait.
 */
export const LOCK_LOOK_MS = 30_000

/** What a start that waits for the lock is told, and asks, besides the lock. */
export interface LockWait {
  /** Whether the move the lock is held for is committed: the start then goes on without the lock, while its owner finishes. */
  committed(): boolean
  /** Called once, LOCK_LOOK_MS into a wait. */
  long(): void
}

/** What the lock reads of this computer. */
export interface LockDeps {
  pid: number
  /** The clock tick [pid] started at, null when no process has it. */
  startTime(pid: number): number | null
  /** Calls [onChange] at each change among [folder]'s names. */
  watch(folder: string, onChange: () => void): { close(): void }
}

const OWNER = 'owner'

const thisProcess: LockDeps = {
  pid: process.pid,
  startTime: procStartTime,
  // A watch that breaks wakes the waiter once; its looks go on.
  watch: (folder, onChange) => watch(folder, onChange).on('error', onChange),
}

/**
 * Beside ~/.harness, outside both trees: the move renames the trees, never its own lock. Every start takes this one,
 * whatever XDG_STATE_HOME it reads, so two that read different roots never move at once.
 */
export function moveLockPath(legacy: string): string {
  return `${legacy}.move-lock`
}

/**
 * Runs [run] while this process holds the move lock: a folder holding `owner`, this process's pid and start time. A
 * lock another live process holds is waited for, with no limit while it lives and its move is not committed: a start
 * never goes on on a tree half moved. One whose owner is gone is taken over. Not held: the move [wait] was for is committed.
 */
export async function withMoveLock<T>(legacy: string, run: () => Promise<T>, wait: LockWait, deps: LockDeps = thisProcess): Promise<{ held: true; value: T } | { held: false }> {
  const lock = moveLockPath(legacy)
  const start = deps.startTime(deps.pid)
  // An owner with no start time reads as gone to every other start, which would take the lock over while this one moves.
  if (start === null) throw new Error('this process has no start time in /proc: the move lock is not taken')
  const me = JSON.stringify({ pid: deps.pid, start })
  if (!take(lock, deps.pid, me) && !await waitFor(lock, deps, me, wait)) return { held: false }
  try {
    return { held: true, value: await run() }
  } finally {
    release(lock, me)
  }
}

/**
 * Takes the lock once its owner is gone or lets go, looking again at each change beside it and every LOCK_LOOK_MS;
 * false once the move it is held for is committed.
 */
async function waitFor(lock: string, deps: LockDeps, me: string, wait: LockWait): Promise<boolean> {
  let wake = (): void => {}
  const watcher = deps.watch(dirname(lock), () => wake())
  let timer: NodeJS.Timeout | undefined
  const look = (): Promise<'look'> => new Promise((done) => { timer = setTimeout(done, LOCK_LOOK_MS, 'look') })
  let next = look()
  try {
    for (let said = false; ;) {
      // Looked at once the watch is on: a release before it is seen here, one after it wakes the wait below.
      if (take(lock, deps.pid, me)) return true
      const owner = ownerOf(lock)
      if (owner === null) continue
      if (!alive(owner, deps)) {
        drop(lock, owner, deps.pid)
        continue
      }
      if (wait.committed()) return false
      if (await Promise.race([new Promise<'changed'>((done) => { wake = () => done('changed') }), next]) === 'changed') continue
      if (!said) wait.long()
      said = true
      next = look()
    }
  } finally {
    watcher.close()
    clearTimeout(timer)
  }
}

/**
 * Puts this process's owner in the lock, whole: written to a draft, then linked in, which fails when an owner is there.
 * A folder a crash left with no owner is taken as it is.
 */
function take(lock: string, pid: number, me: string): boolean {
  try {
    mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error
  }
  const draft = join(lock, `${OWNER}.${pid}`)
  try {
    writeFileSync(draft, me, { mode: 0o600 })
    linkSync(draft, join(lock, OWNER))
    return true
  } catch (error) {
    // An owner is there, or the folder went with its release: look again.
    if (code(error) === 'EEXIST' || code(error) === 'ENOENT') return false
    throw error
  } finally {
    rmSync(draft, { force: true })
  }
}

/** The owner as written, null when there is none. */
function ownerOf(lock: string): string | null {
  try {
    return readFileSync(join(lock, OWNER), 'utf8')
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    throw error
  }
}

/** Its process runs, started when the owner says: a pid given to another process since is gone too. */
function alive(owner: string, deps: LockDeps): boolean {
  try {
    const { pid, start } = JSON.parse(owner) as { pid?: unknown; start?: unknown }
    return Number.isSafeInteger(pid) && typeof start === 'number' && deps.startTime(pid as number) === start
  } catch {
    return false
  }
}

/**
 * Removes an owner that is gone, only while it is still the one judged: moved aside in one step, then read, so an owner
 * that took the lock meanwhile is the one moved, and is put back.
 */
function drop(lock: string, owner: string, pid: number): void {
  const aside = join(lock, `${OWNER}.gone.${pid}`)
  try {
    renameSync(join(lock, OWNER), aside)
  } catch (error) {
    // Another start dropped it first.
    if (code(error) === 'ENOENT') return
    throw error
  }
  try {
    if (readFileSync(aside, 'utf8') !== owner) linkSync(aside, join(lock, OWNER))
  } finally {
    rmSync(aside, { force: true })
  }
}

/** Lets go of a lock that is still this process's; the folder goes too, with any draft a crash left in it. */
function release(lock: string, me: string): void {
  try {
    if (readFileSync(join(lock, OWNER), 'utf8') !== me) return
    rmSync(join(lock, OWNER))
    for (const name of readdirSync(lock)) if (name !== OWNER) rmSync(join(lock, name), { force: true })
    rmdirSync(lock)
  } catch {
    // Another start took it this instant, and its owner keeps the folder.
  }
}

/** Field 22 of /proc/<pid>/stat. The name before it, in parentheses, may hold any character, so fields count from its end. */
function procStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(join('/proc', String(pid), 'stat'), 'utf8')
    const start = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')[19])
    return Number.isSafeInteger(start) ? start : null
  } catch {
    return null
  }
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code
