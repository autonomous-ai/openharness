/**
 * A program-owned harness (#4393): a harness a program on this computer started and keeps, proven by a token only it
 * holds. The lamp's task runner (`lamp-tasks`) is such a program: not an agent, and not the person at a terminal. It
 * keeps one session per engine and types each spoken task into it, signed in or signed out.
 *
 * The program names a file holding its token (`--program-token-file`): 0600, its own, 32 bytes or more. Only the
 * token's SHA-256 is kept, beside the harness's id, in the data folder (`program-harnesses.json`), never the token,
 * and never in the pane's environment. The record is keyed by the harness's id, which a daemon restart, a sign-in or
 * a sign-out leaves as it is: the machine id changes then (cli.ts `wantedDaemonIdentity`), the harness does not, so
 * the next `ensure` still finds it (lampOS #7258).
 *
 * The one decision about what the token allows is `programMay`, so the PM's later ruling (does a signed-in computer
 * also need `programs-reply`?) is one line to change.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockOwnerAlive, lockStartMarker, processLockIdentity, type LockGeneration } from '../lib/processLiveness.js'
import { atomicWriteFile, jsonObject, readState, requireState } from '../lib/secureState.js'
import { AgentClientError } from './daemon.js'

/** The least a token holds: 32 bytes, 256 bits, the issue's floor. */
export const PROGRAM_TOKEN_MIN_BYTES = 32
/** The most read of a token file: a token is a line, not a document. */
export const PROGRAM_TOKEN_MAX_BYTES = 4_096

export const PROGRAM_TOKEN_FLAG = '--program-token-file'

export interface ProgramToken {
  /** SHA-256 of the token, hex: all that is ever kept or compared. */
  hash: string
}

export interface TokenFileDeps {
  platform?: NodeJS.Platform
  uid?: () => number
}

const badToken = (path: string, why: string): AgentClientError =>
  new AgentClientError('BAD_TOKEN_FILE', `${path}: ${why}. A program token file is a regular file of yours, mode 0600, holding 32 or more bytes.`)

/**
 * Reads the token in [path] and returns its hash, or throws BAD_TOKEN_FILE. The file must be a regular file (a link is
 * refused, so a link to another's file proves nothing), owned by this user, readable by no one else, and hold at least
 * PROGRAM_TOKEN_MIN_BYTES once surrounding whitespace (a trailing newline) is taken off. On Windows, where a file has no
 * Unix mode, the owner and mode checks are the ACL's, not done here.
 */
export function readProgramToken(path: string, deps: TokenFileDeps = {}): ProgramToken {
  const platform = deps.platform ?? process.platform
  let info: ReturnType<typeof lstatSync>
  try { info = lstatSync(path) } catch { throw badToken(path, 'it cannot be read') }
  if (!info.isFile()) throw badToken(path, 'it is not a regular file')
  if (platform !== 'win32') {
    const uid = (deps.uid ?? process.getuid)?.()
    if (uid !== undefined && info.uid !== uid) throw badToken(path, 'it is not owned by you')
    if ((Number(info.mode) & 0o077) !== 0) throw badToken(path, `its mode is ${(Number(info.mode) & 0o777).toString(8)}, not 0600`)
  }
  if (Number(info.size) > PROGRAM_TOKEN_MAX_BYTES) throw badToken(path, 'it is too large')
  let raw: Buffer
  try { raw = readFileSync(path) } catch { throw badToken(path, 'it cannot be read') }
  const token = Buffer.from(raw.toString('utf8').trim(), 'utf8')
  if (token.length < PROGRAM_TOKEN_MIN_BYTES) throw badToken(path, `it holds ${token.length} bytes`)
  return { hash: createHash('sha256').update(token).digest('hex') }
}

/** Whether two token hashes are the same, in constant time. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * What a token holder may do that a program without one may not: reply to and resume its own harness without the
 * person's `programs-reply` switch, signed in or out. The issue's open question for the PM: signed in, is the token
 * enough? The proposal is yes, the harness being the program's own. A ruling otherwise is this function.
 */
export function programMay(_action: 'reply' | 'resume', _signedIn: boolean): boolean {
  return true
}

// ── The record ────────────────────────────────────────────────────────────────────────────────────

/** One input a program's reply typed, for `wait --after`: taken (`reply` answered `taken`), or `unconfirmed` when it
 *  may have been typed but its turn was not seen to start (`reply` answered TIMEOUT with `cancelled: false`). */
export interface ProgramInput { id: string; takenAt: number; unconfirmed?: true }

/** A harness a program owns, by its id. */
export interface ProgramHarness {
  agentId: string
  tokenHash: string
  /** The name the program gave it: the harness's own name changes once its agent titles the session. */
  name: string
  engine: string
  createdAt: number
  /** When its engine was last started or resumed for the program (`new`, `ensure`, `resume`). */
  startedAt: number
  /** The last inputs taken, newest last: a few, for `wait --after`. */
  inputs: ProgramInput[]
}

interface ProgramFile { v: 1; harnesses: Record<string, ProgramHarness> }

/** How many taken inputs a record keeps: a `wait --after` follows the input just given, never one ten tasks back. */
export const KEPT_INPUTS = 16

export const programFilePath = (dataDir: string): string => join(dataDir, 'program-harnesses.json')

function harnessOf(value: unknown): ProgramHarness | null {
  const v = value as Partial<ProgramHarness> | null
  if (!v || typeof v.agentId !== 'string' || !v.agentId || typeof v.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.tokenHash)
    || typeof v.name !== 'string' || typeof v.engine !== 'string') return null
  const inputs = Array.isArray(v.inputs) ? v.inputs.filter((i): i is ProgramInput => !!i && typeof i.id === 'string' && typeof i.takenAt === 'number')
    .map((i): ProgramInput => ({ id: i.id, takenAt: i.takenAt, ...(i.unconfirmed === true ? { unconfirmed: true } : {}) })) : []
  return { agentId: v.agentId, tokenHash: v.tokenHash, name: v.name, engine: v.engine,
    createdAt: Number(v.createdAt) || 0, startedAt: Number(v.startedAt) || 0, inputs: inputs.slice(-KEPT_INPUTS) }
}

function harnessesIn(file: Record<string, unknown> | null): ProgramHarness[] {
  const rows = (file as Partial<ProgramFile> | null)?.harnesses
  if (!rows || typeof rows !== 'object') return []
  return Object.values(rows).map(harnessOf).filter((h): h is ProgramHarness => !!h)
}

/**
 * The program-owned harnesses of one data folder. Reads are of a small file (one or two harnesses a computer); every
 * write takes the file's lock and replaces the file whole (write, then rename), so a reader never sees half of one.
 */
export class ProgramRecords {
  constructor(readonly dataDir: string) {}

  get path(): string { return programFilePath(this.dataDir) }

  all(): ProgramHarness[] {
    const read = readState(this.path, 'cache', jsonObject)
    return harnessesIn(read.state === 'ok' ? read.value : null)
  }

  get(agentId: string): ProgramHarness | null { return this.all().find((h) => h.agentId === agentId) ?? null }

  /** The harnesses [tokenHash] owns by [name] (case-blind), newest first. */
  named(name: string, tokenHash: string): ProgramHarness[] {
    const wanted = name.trim().toLowerCase()
    return this.all().filter((h) => h.name.toLowerCase() === wanted && sameHash(h.tokenHash, tokenHash)).sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Changes the file under its lock: [change] gets the rows by id and returns nothing; they are written back whole. */
  update(change: (rows: Map<string, ProgramHarness>) => void): void {
    withFileLockSync(`${this.path}.lock`, () => {
      // A file that cannot be read now throws (StateFileUnreadable): read as none, the write would forget every harness.
      const rows = new Map(harnessesIn(requireState(this.path, jsonObject, 'cache')).map((h) => [h.agentId, h]))
      change(rows)
      const file: ProgramFile = { v: 1, harnesses: Object.fromEntries(rows) }
      mkdirSync(this.dataDir, { recursive: true })
      atomicWriteFile(this.path, JSON.stringify(file), 'cache')
    })
  }

  put(harness: ProgramHarness): void { this.update((rows) => { rows.set(harness.agentId, harness) }) }

  started(agentId: string, at: number): void {
    this.update((rows) => { const h = rows.get(agentId); if (h) rows.set(agentId, { ...h, startedAt: at }) })
  }

  taken(agentId: string, input: ProgramInput): void {
    this.update((rows) => {
      const h = rows.get(agentId)
      if (h) rows.set(agentId, { ...h, inputs: [...h.inputs, input].slice(-KEPT_INPUTS) })
    })
  }

  /** Forgets [agentId]: its harness was deleted, or forgotten (`close --forget`). */
  forget(agentId: string): void { this.update((rows) => { rows.delete(agentId) }) }

  /** Forgets every record whose harness is no longer on this computer at all ([known] holds every id, stopped too). */
  prune(known: ReadonlySet<string>): void {
    if (!this.all().some((h) => !known.has(h.agentId))) return
    this.update((rows) => { for (const id of [...rows.keys()]) if (!known.has(id)) rows.delete(id) })
  }
}

/**
 * Whether [agentId] is a harness [tokenHash] owns, as the records in [dataDir] say. The one check every verb that takes
 * a token makes (and `close --forget` makes before it deletes anything).
 */
export function ownedBy(dataDir: string, agentId: string, tokenHash: string): boolean {
  const h = new ProgramRecords(dataDir).get(agentId)
  return !!h && sameHash(h.tokenHash, tokenHash)
}

// ── Locks ─────────────────────────────────────────────────────────────────────────────────────────

const LOCK_STEP_MS = 10
const OWNERLESS_STALE_MS = 1_000
const pause = new Int32Array(new SharedArrayBuffer(4))

function lockText(lock: string): string | null {
  try { return readFileSync(lock, 'utf8') } catch { return null }
}

/** Removes [lock] when the process it names is gone (or it named no one for too long): whether to try again now. */
function takeOver(lock: string): boolean {
  const seen = lockText(lock)
  if (seen === null) return true
  let owner: (LockGeneration & { pid?: unknown }) | null = null
  try { owner = JSON.parse(seen) } catch { /* names no one */ }
  const pid = Number(owner?.pid)
  const stale = (() => { try { return Date.now() - statSync(lock).mtimeMs > OWNERLESS_STALE_MS } catch { return true } })()
  if (pid > 0 ? lockOwnerAlive(pid, lockStartMarker(owner)) : !stale) return false
  if (lockText(lock) === seen) rmSync(lock, { force: true })
  return true
}

function tryLock(lock: string, mine: string): boolean {
  let fd: number
  try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return false
  }
  // not a state file: the lock's owner; a lock that names no one is taken over once stale
  try { writeFileSync(fd, mine) } finally { closeSync(fd) }
  return true
}

const lockOwner = (): string => JSON.stringify({ pid: process.pid, ...processLockIdentity(process.pid) })

function withFileLockSync<T>(lock: string, body: () => T, waitMs = 2_000): T {
  const mine = lockOwner()
  const deadline = Date.now() + waitMs
  for (;;) {
    if (tryLock(lock, mine)) break
    if (takeOver(lock)) continue
    if (Date.now() >= deadline) throw new AgentClientError('BUSY', 'The program harness record is busy. Try again.')
    Atomics.wait(pause, 0, 0, LOCK_STEP_MS)
  }
  try { return body() } finally { rmSync(lock, { force: true }) }
}

/**
 * Runs [body] holding the lock for program harness [name] in [dataDir]: two `ensure`s for one name at once, from two
 * processes, become one after the other, so the second finds the harness the first made and never starts a second
 * one, nor is told NAME_TAKEN by it. A lock whose process died is taken over. Waits up to [waitMs].
 */
export async function withProgramLock<T>(dataDir: string, name: string, body: () => Promise<T>, waitMs = 120_000): Promise<T> {
  mkdirSync(dataDir, { recursive: true })
  const key = createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 16)
  const lock = join(dataDir, `program-ensure-${key}.lock`)
  const mine = lockOwner()
  const deadline = Date.now() + waitMs
  for (;;) {
    if (tryLock(lock, mine)) break
    if (takeOver(lock)) continue
    if (Date.now() >= deadline) throw new AgentClientError('BUSY', `Another ensure of "${name}" is still running. Try again.`)
    await new Promise((done) => setTimeout(done, 25))
  }
  try { return await body() } finally { rmSync(lock, { force: true }) }
}
