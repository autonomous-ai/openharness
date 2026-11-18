import { linkSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** How long a start waits for another start's move: one that takes longer is left to finish, and this start goes on. */
export const LOCK_WAIT_MS = 30_000

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
  // A watch that breaks wakes the waiter once; the limit bounds the rest of its wait.
  watch: (folder, onChange) => watch(folder, onChange).on('error', onChange),
}

/** Beside the state root, outside both trees: the move renames the trees, never its own lock. */
export function moveLockPath(stateRoot: string): string {
  return `${stateRoot}.move-lock`
}

/**
 * Runs [run] while this process holds the move lock: a folder holding `owner`, this process's pid and start time. A
 * lock another live process holds is waited for, LOCK_WAIT_MS at most; one whose owner is gone is taken over.
 */
export async function withMoveLock<T>(stateRoot: string, run: () => Promise<T>, deps: LockDeps = thisProcess): Promise<{ held: true; value: T } | { held: false }> {
  const lock = moveLockPath(stateRoot)
  // The XDG base may not be there yet: made owner-only, as the XDG spec asks.
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 })
  const me = JSON.stringify({ pid: deps.pid, start: deps.startTime(deps.pid) })
  if (!take(lock, deps.pid, me) && !await waitFor(lock, deps, me)) return { held: false }
  try {
    return { held: true, value: await run() }
  } finally {
    release(lock, me)
  }
}

/** Takes the lock once its owner is gone or lets go, looking again at each change beside it; false after the limit. */
async function waitFor(lock: string, deps: LockDeps, me: string): Promise<boolean> {
  let wake = (): void => {}
  const watcher = deps.watch(dirname(lock), () => wake())
  let timer: NodeJS.Timeout | undefined
  const limit = new Promise<'late'>((done) => { timer = setTimeout(done, LOCK_WAIT_MS, 'late') })
  try {
    for (let late = false; ;) {
      // Looked at once the watch is on: a release before it is seen here, one after it wakes the wait below.
      if (take(lock, deps.pid, me)) return true
      const owner = ownerOf(lock)
      if (owner === null) continue
      if (!alive(owner, deps)) {
        drop(lock, owner)
        continue
      }
      if (late) return false
      late = await Promise.race([new Promise<'changed'>((done) => { wake = () => done('changed') }), limit]) === 'late'
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

/** Removes an owner that is gone, only while it is still the one judged: a lock that changed hands meanwhile stays. */
function drop(lock: string, owner: string): void {
  if (ownerOf(lock) === owner) rmSync(join(lock, OWNER), { force: true })
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
