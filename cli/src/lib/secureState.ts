import {
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, win32 } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { errorKind } from './log.js'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

function ownerUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

function isMissing(error: unknown): boolean {
  // ENOTDIR: a folder on the way is a file, so nothing can be there.
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Windows: the folders state may live in. POSIX mode bits mean nothing on NTFS (Node reports every directory as
 * 0o666 or 0o777, so the checks below refused them all, and the registry could not be saved). What protects a
 * folder there is its ACL, and the user's profile (`os.homedir()`) is one only its owner, SYSTEM and the
 * administrators can write; new folders and files in it inherit that. So state must be in the profile, or in the
 * data folder the person configured themselves (`ADAPTER_DATA_DIR`), whose ACL is then theirs to choose. Node
 * cannot set an ACL: state is created with the same modes as on Unix, which Windows ignores but for read-only.
 */
export function windowsStateRoots(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const configured = environment.ADAPTER_DATA_DIR?.trim()
  return [home, ...(configured ? [configured] : [])].filter(Boolean)
}

/** Whether the real path [target] is one of [roots] or below one, compared as Windows does (case-insensitively). */
export function insideWindowsRoots(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = win32.relative(root, target)
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !win32.isAbsolute(rel))
  })
}

/**
 * One file system call of a state write. The rules (names, modes, flags, flushes, the retry, the clean-up) are written
 * once, as generators of these steps, and run by one of two drivers: `runSync` with node:fs's synchronous calls, or
 * `runAsync` with fs/promises and a timer, so the async form keeps every rule and never blocks its event loop.
 */
type Handle = number | FileHandle
type Step =
  | { call: 'open'; path: string; flags: number | string; mode?: number }
  | { call: 'write'; handle: Handle; data: string | Uint8Array }
  | { call: 'stat' | 'flush' | 'close'; handle: Handle }
  | { call: 'chmod'; handle: Handle; mode: number }
  // `copyNew` never replaces a file (COPYFILE_EXCL).
  | { call: 'rename' | 'link' | 'copyNew'; from: string; to: string }
  | { call: 'remove' | 'realpath'; path: string }
  | { call: 'pause'; ms: number }
type Steps<T> = Generator<Step, T, unknown>

/** One step; its caller knows what the call answers. */
function* step<T = void>(call: Step): Steps<T> {
  return (yield call) as T
}

function callSync(s: Step): unknown {
  switch (s.call) {
    case 'open': return openSync(s.path, s.flags, s.mode)
    case 'write': return writeFileSync(s.handle as number, s.data)
    case 'stat': return fstatSync(s.handle as number)
    case 'chmod': return fchmodSync(s.handle as number, s.mode)
    case 'flush': return fsyncSync(s.handle as number)
    case 'close': return closeSync(s.handle as number)
    case 'rename': return renameSync(s.from, s.to)
    case 'link': return linkSync(s.from, s.to)
    case 'copyNew': return copyFileSync(s.from, s.to, constants.COPYFILE_EXCL)
    case 'remove': return rmSync(s.path, { force: true })
    case 'realpath': return realpathSync.native(s.path)
    case 'pause': return pauseSync(s.ms)
  }
}

function callAsync(s: Step): Promise<unknown> {
  switch (s.call) {
    case 'open': return fs.open(s.path, s.flags, s.mode)
    case 'write': return (s.handle as FileHandle).writeFile(s.data)
    case 'stat': return (s.handle as FileHandle).stat()
    case 'chmod': return (s.handle as FileHandle).chmod(s.mode)
    case 'flush': return (s.handle as FileHandle).sync()
    case 'close': return (s.handle as FileHandle).close()
    case 'rename': return fs.rename(s.from, s.to)
    case 'link': return fs.link(s.from, s.to)
    case 'copyNew': return fs.copyFile(s.from, s.to, constants.COPYFILE_EXCL)
    case 'remove': return fs.rm(s.path, { force: true })
    case 'realpath': return fs.realpath(s.path)
    case 'pause': return sleep(s.ms)
  }
}

/** Runs [steps] with the synchronous calls: a call that throws is thrown into the steps, where the rules catch it. */
function runSync<T>(steps: Steps<T>): T {
  let next = steps.next()
  while (!next.done) {
    let result: unknown
    try { result = callSync(next.value) } catch (error) { next = steps.throw(error); continue }
    next = steps.next(result)
  }
  return next.value
}

/** `runSync`, each call awaited instead. */
async function runAsync<T>(steps: Steps<T>): Promise<T> {
  let next = steps.next()
  while (!next.done) {
    let result: unknown
    try { result = await callAsync(next.value) } catch (error) { next = steps.throw(error); continue }
    next = steps.next(result)
  }
  return next.value
}

/** The Windows check for a state path: resolved through junctions and links, it must be inside the roots. */
function* insideWindowsRootsSteps(path: string, kind: 'directory' | 'file'): Steps<void> {
  const real = yield* step<string>({ call: 'realpath', path })
  const roots: string[] = []
  for (const root of windowsStateRoots()) {
    try { roots.push(yield* step<string>({ call: 'realpath', path: root })) } catch { /* a root that is not there holds nothing */ }
  }
  if (!insideWindowsRoots(real, roots)) {
    throw new Error(`state ${kind} ${path} is outside your user profile (${homedir()}), so its contents cannot be`
      + ' trusted. Keep Harness state in your profile, or set ADAPTER_DATA_DIR to the folder you want it in.')
  }
}

function requireInsideWindowsRoots(path: string, kind: 'directory' | 'file'): void {
  runSync(insideWindowsRootsSteps(path, kind))
}

/**
 * Windows: a state file a credential is read from (the hook credential, the daemon token, lib/windows/pipeAuth.ts).
 * The file must not be a link or junction itself (Node's lstat reports both as symbolic links), and resolved, it
 * must be inside the state roots. Windows' open has no O_NOFOLLOW (the constant is undefined there). So this check
 * is what keeps a link planted in the data folder from handing the daemon another file. Throws otherwise.
 */
export function requireWindowsStateFile(file: string): void {
  if (lstatSync(file).isSymbolicLink()) {
    throw new Error(`state file ${file} is a link or junction; a credential is never read through one`)
  }
  requireInsideWindowsRoots(file, 'file')
}

/**
 * Make a rename or create in [directory] durable: fsync the directory, opened with [flags] (`'r'` by default).
 * Windows cannot: Node opens a directory read-only there, and flushing such a handle is EPERM, so every state
 * save failed after its rename. NTFS journals the rename itself; the file's data was flushed before it.
 */
export function syncStateDirectory(directory: string, flags: number | string = 'r'): void {
  runSync(syncDirectorySteps(directory, flags))
}

function* syncDirectorySteps(directory: string, flags: number | string): Steps<void> {
  if (!directorySyncSupported()) return
  const handle = yield* step<Handle>({ call: 'open', path: directory, flags })
  try { yield* step({ call: 'flush', handle }) } finally { yield* step({ call: 'close', handle }) }
}

/**
 * Whether a directory handle can be flushed here, for a caller that holds one open to check what it is before the
 * flush (`syncStateDirectory` opens its own): not on Windows, for the same reason.
 */
export function directorySyncSupported(): boolean {
  return process.platform !== 'win32'
}

function secureWindowsStateDirectory(directory: string, create: boolean): void {
  if (create) mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  if (!statSync(directory).isDirectory()) throw new Error('state directory has unsafe owner or type')
  requireInsideWindowsRoots(directory, 'directory')
}

export function secureStateDirectory(directory: string, create = true): void {
  if (process.platform === 'win32') {
    secureWindowsStateDirectory(directory, create)
    return
  }
  if (create) mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const fd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const stat = fstatSync(fd)
    const uid = ownerUid()
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
      throw new Error('state directory has unsafe owner or type')
    }
    const mode = stat.mode & 0o777
    // Refuse — deliberately do NOT chmod and carry on. If another account could write here, it could
    // already have planted the registry, the token or the hook credential, and tightening afterwards
    // would leave us trusting whatever it left behind. Three tests pin this (registry.spec.ts,
    // hookAuth.spec.ts, terminalConfigSnapshot.spec.ts); the fix belongs at creation time, and every
    // site that makes a directory under ADAPTER_DATA_DIR now passes mode 0o700 so Ubuntu's default
    // umask 0002 can no longer produce a 0775 one. This branch is what a PRE-EXISTING 0775 directory
    // (made by an older build on Ubuntu) lands in, so the message has to say what to do about it.
    if ((mode & 0o022) !== 0) {
      throw new Error(`state directory ${directory} is group/world writable, so its contents cannot be`
        + ` trusted. If you did not set that mode yourself, delete it; otherwise: chmod 700 ${directory}`)
    }
    if (mode !== PRIVATE_DIRECTORY_MODE) {
      fchmodSync(fd, PRIVATE_DIRECTORY_MODE)
      if ((fstatSync(fd).mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw new Error('state directory permissions could not be tightened')
      }
    }
  } finally {
    closeSync(fd)
  }
}

function* inspectSteps(handle: Handle, maxBytes: number): Steps<void> {
  const stat = yield* step<Stats>({ call: 'stat', handle })
  const uid = ownerUid()
  if (!stat.isFile() || (uid !== null && stat.uid !== uid)) {
    throw new Error('state file has unsafe owner or type')
  }
  if (stat.size > maxBytes) throw new Error('state file exceeds its size limit')
  // Windows: the mode is not what protects it (see windowsStateRoots); the callers checked where it is.
  if (process.platform === 'win32') return
  const mode = stat.mode & 0o777
  // Same reasoning as secureStateDirectory: a file another account could have rewritten is not made
  // trustworthy by tightening it now. Every writer under ADAPTER_DATA_DIR already passes mode 0o600.
  if ((mode & 0o022) !== 0) throw new Error('state file is group/world writable')
  if (mode !== PRIVATE_FILE_MODE) {
    yield* step({ call: 'chmod', handle, mode: PRIVATE_FILE_MODE })
    if (((yield* step<Stats>({ call: 'stat', handle })).mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error('state file permissions could not be tightened')
    }
  }
}

export function readPrivateStateFile(file: string, maxBytes = Number.MAX_SAFE_INTEGER): string {
  if (process.platform === 'win32') requireInsideWindowsRoots(file, 'file')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    runSync(inspectSteps(fd, maxBytes))
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function hardenPrivateStateFileIfPresent(
  file: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): boolean {
  return runSync(hardenSteps(file, maxBytes))
}

function* hardenSteps(file: string, maxBytes: number): Steps<boolean> {
  let handle: Handle
  try {
    if (process.platform === 'win32') yield* insideWindowsRootsSteps(file, 'file')
    handle = yield* step<Handle>({ call: 'open', path: file, flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK })
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  try {
    yield* inspectSteps(handle, maxBytes)
    return true
  } finally {
    yield* step({ call: 'close', handle })
  }
}

/**
 * What a state file is to its reader. `'trust'`: keys, pins, credentials, and the registry's own files; a write
 * refuses a target another account could have rewritten (`hardenPrivateStateFileIfPresent`). `'cache'`: anything
 * that can be rebuilt, replaced whatever its mode.
 */
export type StateKind = 'trust' | 'cache'

/**
 * `mode` is the new file's (0o600 unless given). `exclusive` publishes only when the file is not there yet. `durable`
 * flushes a cache write as a trust write is flushed: the last save before its process stops.
 */
export interface AtomicWriteOptions { mode?: number; exclusive?: boolean; durable?: boolean }

export const RENAME_TRIES = 10
export const RENAME_WAIT_MS = 100
// Windows refuses a rename over a file another process holds open (a scanner, a reader), for a moment.
const RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
// A file system without hard links (FAT, some network shares) refuses `link` with one of these. EISDIR: Windows on exFAT
// and FAT answers ERROR_INVALID_FUNCTION, which libuv maps to it.
const LINK_REFUSED = new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EISDIR'])

/** The new file is in place, but its folder has not confirmed it is durable. */
export class AtomicWriteUnconfirmed extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }) }
}

const pauseCell = new Int32Array(new SharedArrayBuffer(4))
/** A blocking wait, for the retries here and in a store that waits on another process's write. */
export function pauseSync(ms: number): void {
  Atomics.wait(pauseCell, 0, 0, ms)
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? ''
}

function* renameOverSteps(temporary: string, file: string): Steps<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      yield* step({ call: 'rename', from: temporary, to: file })
      return
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= RENAME_TRIES || !RENAME_BUSY.has(errorCode(error))) throw error
    }
    yield* step({ call: 'pause', ms: RENAME_WAIT_MS })
  }
}

/** Puts the complete [temporary] at [file] unless a file is there: false when one is (another creator won). */
function* publishOnceSteps(temporary: string, file: string): Steps<boolean> {
  try {
    yield* step({ call: 'link', from: temporary, to: file })
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    if (!LINK_REFUSED.has(errorCode(error))) throw error
  }
  try {
    yield* step({ call: 'copyNew', from: temporary, to: file })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
  // A copy is a new file, which the temporary's flush did not cover. Windows flushes only a handle open for writing.
  try {
    const handle = yield* step<Handle>({ call: 'open', path: file, flags: constants.O_RDWR | constants.O_NOFOLLOW })
    try { yield* step({ call: 'flush', handle }) } finally { yield* step({ call: 'close', handle }) }
  } catch (error) {
    throw new AtomicWriteUnconfirmed(error)
  }
  return true
}

/**
 * Writes [file] whole or not at all: a reader in any process sees the old complete file or the new one. A temporary
 * file in the same folder is written and renamed over it (linked, for `exclusive`). A trust write, an exclusive one
 * and a `durable` one flush the temporary file before and the folder after; a cache write flushes neither, so a power
 * cut can leave it empty, which its reader sets aside (`readState`). True when written. False only for `exclusive`,
 * when the file is already there.
 */
export function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  kind: StateKind,
  options: AtomicWriteOptions = {},
): boolean {
  return runSync(writeSteps(file, data, kind, options))
}

/** `atomicWriteFile` for the paths that must not block their event loop: the same rules, run with fs/promises. */
export function atomicWriteFileAsync(
  file: string,
  data: string | Uint8Array,
  kind: StateKind,
  options: AtomicWriteOptions = {},
): Promise<boolean> {
  return runAsync(writeSteps(file, data, kind, options))
}

function* writeSteps(file: string, data: string | Uint8Array, kind: StateKind, options: AtomicWriteOptions): Steps<boolean> {
  if (kind === 'trust') yield* hardenSteps(file, Number.MAX_SAFE_INTEGER)
  // The rename alone keeps a reader from half a file; the flushes made a full recap save cost 90-143 ms instead of 12
  // (2026-11-19). An exclusive file is made once and never written again (the computer id the backend binds this
  // computer to): no later write would put back what a power cut lost, so it is flushed whatever its kind.
  const durable = kind === 'trust' || options.exclusive === true || options.durable === true
  const mode = options.mode ?? PRIVATE_FILE_MODE
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let published = false
  try {
    const handle = yield* step<Handle>({
      call: 'open', path: temporary, flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode,
    })
    try {
      yield* step({ call: 'write', handle, data })
      // open's mode is narrowed by the umask: the file gets exactly its own.
      yield* step({ call: 'chmod', handle, mode })
      if (durable) yield* step({ call: 'flush', handle })
    } finally { yield* step({ call: 'close', handle }) }
    if (options.exclusive) {
      if (!(yield* publishOnceSteps(temporary, file))) return false
    } else {
      yield* renameOverSteps(temporary, file)
    }
    published = true
    if (durable) yield* syncDirectorySteps(dirname(file), 'r')
    return true
  } catch (error) {
    if (published) throw new AtomicWriteUnconfirmed(error)
    throw error
  } finally {
    // A link or a copy leaves the temporary file's own name behind. Its removal must not replace what the write answers
    // (Windows refuses it while a scanner holds the file): one left behind is read by nobody.
    if (options.exclusive || !published) {
      try { yield* step({ call: 'remove', path: temporary }) } catch { /* left for nobody to read */ }
    }
  }
}

/** `atomicWriteFile` of `JSON.stringify(value, null, 2)`. */
export function atomicWriteJson(file: string, value: unknown, kind: StateKind, options?: AtomicWriteOptions): boolean {
  return atomicWriteFile(file, JSON.stringify(value, null, 2), kind, options)
}

/** `atomicWriteFileAsync` of `JSON.stringify(value, null, 2)`. */
export function atomicWriteJsonAsync(file: string, value: unknown, kind: StateKind, options?: AtomicWriteOptions): Promise<boolean> {
  return atomicWriteFileAsync(file, JSON.stringify(value, null, 2), kind, options)
}

// An older build still writes in place, so during an update a reader can find its file mid-write for a moment.
export const READ_TRIES = 5
export const READ_WAIT_MS = 20
// Enough for every state file one process reads; a broken one then costs its readers one stat after the first read.
const REMEMBERED_FILES = 64

/**
 * `unreadable`: bytes were read and could not be parsed, or, with `readFailed`, the read itself failed (`failure` is its
 * code: EMFILE, EIO, EACCES, Windows' EBUSY or EPERM). That read read nothing to judge, so it is never remembered or set
 * aside, and the next read tries again.
 */
export type StateRead<T> = { state: 'ok'; value: T } | { state: 'missing' } | { state: 'unreadable'; failure: string; readFailed?: true }

/** A file a write would replace that cannot be read. The message holds the file's base name only. */
export class StateFileUnreadable extends Error {
  override readonly name = 'StateFileUnreadable'
  constructor(readonly base: string, readonly failure: string, readFailed = false) {
    super(readFailed ? `${base} could not be read (${failure}), so it was not changed.`
      : `${base} cannot be read (${failure}). Move it aside to start over.`)
  }
}

/** A trust file and its reader's parse, for whoever names the unreadable ones. */
export interface TrustFile { file: string; parse(text: string): unknown }

interface Unreadable {
  identity: string
  failure: string
  /** It could not be set aside: not tried again on every read. */
  stuck?: boolean
}
// Files whose bytes could not be parsed, by path, oldest first.
const unreadableFiles = new Map<string, Unreadable>()
// What the last line about each file said, by path, oldest first: a line is said once, until what it says changes.
const toldFiles = new Map<string, string>()

/** What a file is remembered by: a write in place or a rename over it changes it. Undefined when it cannot be looked at. */
function identityOf(file: string): string | undefined {
  try {
    const { dev, ino, size, mtimeMs } = statSync(file)
    return `${dev}:${ino}:${size}:${mtimeMs}`
  } catch {
    return undefined
  }
}

function remember(file: string, identity: string | undefined, failure: string): void {
  unreadableFiles.delete(file)
  if (identity === undefined) return
  unreadableFiles.set(file, { identity, failure })
  if (unreadableFiles.size > REMEMBERED_FILES) unreadableFiles.delete(unreadableFiles.keys().next().value!)
}

/** Logs [line], unless the last line about [file] said the same [what]. */
function tell(file: string, what: string, line: string): void {
  if (toldFiles.get(file) === what) return
  toldFiles.delete(file)
  toldFiles.set(file, what)
  if (toldFiles.size > REMEMBERED_FILES) toldFiles.delete(toldFiles.keys().next().value!)
  console.warn(line)
}

function readOnce<T>(file: string, parse: (text: string) => T): StateRead<T> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) return { state: 'missing' }
    return { state: 'unreadable', failure: errorCode(error) || 'unreadable', readFailed: true }
  }
  try {
    return { state: 'ok', value: parse(text) }
  } catch (error) {
    // A fixed word, never the error's message: JSON.parse quotes the file in it.
    return { state: 'unreadable', failure: error instanceof SyntaxError ? 'not valid JSON' : 'unexpected content' }
  }
}

/**
 * Read and parse, with the retry and the memory of bytes that could not be parsed (a read that failed is not remembered).
 * Logs nothing, moves nothing.
 */
export function probeState<T>(file: string, parse: (text: string) => T): StateRead<T> {
  const known = unreadableFiles.get(file)
  if (known && known.identity === identityOf(file)) return { state: 'unreadable', failure: known.failure }
  for (let attempt = 1; ; attempt++) {
    // Taken before the read: a write after it changes it, so a file that became whole is never remembered as broken.
    const identity = identityOf(file)
    const read = readOnce(file, parse)
    if (read.state !== 'unreadable') {
      unreadableFiles.delete(file)
      toldFiles.delete(file)
      return read
    }
    if (attempt === READ_TRIES) {
      remember(file, read.readFailed ? undefined : identity, read.failure)
      return read
    }
    pauseSync(READ_WAIT_MS)
  }
}

/**
 * `probeState`, then what failed. A read that failed is logged once and answered as it is, whatever the kind: nothing
 * is moved. Bytes that cannot be parsed: a trust file is logged once and left as it is (its store fails closed); a
 * cache file is set aside, logged, and answered as missing, unless a writer replaced it since: that file is read.
 */
export function readState<T>(file: string, kind: StateKind, parse: (text: string) => T): StateRead<T> {
  const base = basename(file)
  for (let round = 1; ; round++) {
    const read = probeState(file, parse)
    if (read.state !== 'unreadable') return read
    if (read.readFailed) {
      tell(file, read.failure, `[state] ${base} could not be read (${read.failure}); left as it is, read again next time.`)
      return read
    }
    const memory = unreadableFiles.get(file)
    if (kind === 'trust') {
      tell(file, `${memory?.identity}:${read.failure}`, `[state] ${base} cannot be read (${read.failure}); left as it is. Move it aside to start over.`)
      return read
    }
    if (memory?.stuck) return { state: 'missing' }
    // Only the bytes that failed are set aside: a file put there since they were read (an older build writing in place)
    // is read again. One that keeps changing, or cannot be looked at, is left for the next read.
    if (!memory || memory.identity !== identityOf(file)) {
      if (memory && round < READ_TRIES) continue
      return read
    }
    if (setAsideUnreadable(file)) {
      console.warn(`[state] ${base} could not be read (${read.failure}); kept as ${base}.unreadable, starting empty.`)
    }
    return { state: 'missing' }
  }
}

/**
 * A file a write depends on: its value, or null when missing (a cache file that cannot be parsed is set aside, then
 * missing). A thrown StateFileUnreadable when it cannot be read: a trust file that cannot be parsed, or any file the
 * read failed on, which the write then leaves as it is.
 */
export function requireState<T>(file: string, parse: (text: string) => T, kind: StateKind = 'trust'): T | null {
  const read = readState(file, kind, parse)
  if (read.state === 'unreadable') throw new StateFileUnreadable(basename(file), read.failure, read.readFailed)
  return read.state === 'ok' ? read.value : null
}

/** Rename to `<file>.unreadable`, over an older one. Never throws: a failure is one log line. True when set aside. */
function setAsideUnreadable(file: string): boolean {
  try {
    runSync(renameOverSteps(file, `${file}.unreadable`))
    unreadableFiles.delete(file)
    return true
  } catch (error) {
    console.warn(`[state] ${basename(file)} could not be set aside (${errorKind(error)})`)
    const memory = unreadableFiles.get(file)
    if (memory) memory.stuck = true
    return false
  }
}

/** The text as a JSON array; valid JSON of another type is not this file's content either. */
export function jsonArray(text: string): unknown[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value)) throw new TypeError('not a JSON array')
  return value
}

/** The text as a JSON object: not null, not an array. */
export function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('not a JSON object')
  return value as Record<string, unknown>
}
