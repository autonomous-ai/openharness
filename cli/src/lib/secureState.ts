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
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, win32 } from 'node:path'
import { errorKind } from './log.js'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

function ownerUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
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

function realRoots(): string[] {
  return windowsStateRoots().flatMap((root) => {
    try { return [realpathSync.native(root)] } catch { return [] }
  })
}

/** The Windows check for a state path: resolved through junctions and links, it must be inside the roots. */
function requireInsideWindowsRoots(path: string, kind: 'directory' | 'file'): void {
  const real = realpathSync.native(path)
  if (!insideWindowsRoots(real, realRoots())) {
    throw new Error(`state ${kind} ${path} is outside your user profile (${homedir()}), so its contents cannot be`
      + ' trusted. Keep Harness state in your profile, or set ADAPTER_DATA_DIR to the folder you want it in.')
  }
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
  if (!directorySyncSupported()) return
  const fd = openSync(directory, flags)
  try { fsyncSync(fd) } finally { closeSync(fd) }
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

function inspectPrivateStateFile(fd: number, maxBytes: number): void {
  const stat = fstatSync(fd)
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
    fchmodSync(fd, PRIVATE_FILE_MODE)
    if ((fstatSync(fd).mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error('state file permissions could not be tightened')
    }
  }
}

export function readPrivateStateFile(file: string, maxBytes = Number.MAX_SAFE_INTEGER): string {
  if (process.platform === 'win32') requireInsideWindowsRoots(file, 'file')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function hardenPrivateStateFileIfPresent(
  file: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): boolean {
  let fd: number
  try {
    if (process.platform === 'win32') requireInsideWindowsRoots(file, 'file')
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return true
  } finally {
    closeSync(fd)
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
// A file system without hard links (FAT, some network shares) refuses `link` with one of these.
const LINK_REFUSED = new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'])

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

function renameOver(temporary: string, file: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temporary, file)
      return
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= RENAME_TRIES || !RENAME_BUSY.has(errorCode(error))) throw error
    }
    pauseSync(RENAME_WAIT_MS)
  }
}

/** Puts the complete [temporary] at [file] unless a file is there: false when one is (another creator won). */
function publishOnce(temporary: string, file: string): boolean {
  try {
    linkSync(temporary, file)
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    if (!LINK_REFUSED.has(errorCode(error))) throw error
  }
  try {
    copyFileSync(temporary, file, constants.COPYFILE_EXCL)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
  // A copy is a new file, which the temporary's flush did not cover. Windows flushes only a handle open for writing.
  try {
    const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
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
  if (kind === 'trust') hardenPrivateStateFileIfPresent(file)
  // The rename alone keeps a reader from half a file; the flushes made a full recap save cost 90-143 ms instead of 12
  // (2026-11-19). An exclusive file is made once and never written again (the computer id the backend binds this
  // computer to): no later write would put back what a power cut lost, so it is flushed whatever its kind.
  const durable = kind === 'trust' || options.exclusive === true || options.durable === true
  const mode = options.mode ?? PRIVATE_FILE_MODE
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let published = false
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try {
      writeFileSync(fd, data)
      // open's mode is narrowed by the umask: the file gets exactly its own.
      fchmodSync(fd, mode)
      if (durable) fsyncSync(fd)
    } finally { closeSync(fd) }
    if (options.exclusive) {
      if (!publishOnce(temporary, file)) return false
    } else {
      renameOver(temporary, file)
    }
    published = true
    if (durable) syncStateDirectory(dirname(file))
    return true
  } catch (error) {
    if (published) throw new AtomicWriteUnconfirmed(error)
    throw error
  } finally {
    // A link or a copy leaves the temporary file's own name behind.
    if (options.exclusive || !published) rmSync(temporary, { force: true })
  }
}

/** `atomicWriteFile` of `JSON.stringify(value, null, 2)`. */
export function atomicWriteJson(file: string, value: unknown, kind: StateKind, options?: AtomicWriteOptions): boolean {
  return atomicWriteFile(file, JSON.stringify(value, null, 2), kind, options)
}

// An older build still writes in place, so during an update a reader can find its file mid-write for a moment.
export const READ_TRIES = 5
export const READ_WAIT_MS = 20
// Enough for every state file one process reads; a broken one then costs its readers one stat after the first read.
const REMEMBERED_FILES = 64

export type StateRead<T> = { state: 'ok'; value: T } | { state: 'missing' } | { state: 'unreadable'; failure: string }

/** A trust file that cannot be read, which a write would replace. The message holds the file's base name only. */
export class StateFileUnreadable extends Error {
  override readonly name = 'StateFileUnreadable'
  constructor(readonly base: string, readonly failure: string) {
    super(`${base} cannot be read (${failure}). Move it aside to start over.`)
  }
}

/** A trust file and its reader's parse, for whoever names the unreadable ones. */
export interface TrustFile { file: string; parse(text: string): unknown }

interface Unreadable {
  identity: string
  failure: string
  /** Its trust line is logged. */
  said?: boolean
  /** It could not be set aside: not tried again on every read. */
  stuck?: boolean
}
// By path, oldest first.
const unreadableFiles = new Map<string, Unreadable>()

/** What a file is remembered by: a write in place or a rename over it changes it. Undefined when missing. */
function identityOf(file: string): string | undefined {
  try {
    const { dev, ino, size, mtimeMs } = statSync(file)
    return `${dev}:${ino}:${size}:${mtimeMs}`
  } catch (error) {
    // A folder that cannot be searched stays so: it is remembered by its error.
    return isMissing(error) ? undefined : errorCode(error) || 'unreadable'
  }
}

function remember(file: string, identity: string | undefined, failure: string): void {
  unreadableFiles.delete(file)
  if (identity === undefined) return
  unreadableFiles.set(file, { identity, failure })
  if (unreadableFiles.size > REMEMBERED_FILES) unreadableFiles.delete(unreadableFiles.keys().next().value!)
}

function readOnce<T>(file: string, parse: (text: string) => T): StateRead<T> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) return { state: 'missing' }
    return { state: 'unreadable', failure: errorCode(error) || 'unreadable' }
  }
  try {
    return { state: 'ok', value: parse(text) }
  } catch (error) {
    // A fixed word, never the error's message: JSON.parse quotes the file in it.
    return { state: 'unreadable', failure: error instanceof SyntaxError ? 'not valid JSON' : 'unexpected content' }
  }
}

/** Read and parse, with the retry and the memory of an unreadable file. Logs nothing, moves nothing. */
export function probeState<T>(file: string, parse: (text: string) => T): StateRead<T> {
  const known = unreadableFiles.get(file)
  if (known && known.identity === identityOf(file)) return { state: 'unreadable', failure: known.failure }
  for (let attempt = 1; ; attempt++) {
    // Taken before the read: a write after it changes it, so a file that became whole is never remembered as broken.
    const identity = identityOf(file)
    const read = readOnce(file, parse)
    if (read.state !== 'unreadable') {
      unreadableFiles.delete(file)
      return read
    }
    if (attempt === READ_TRIES) {
      remember(file, identity, read.failure)
      return read
    }
    pauseSync(READ_WAIT_MS)
  }
}

/**
 * `probeState`, then the kind: a trust file is logged once and left as it is (its store fails closed); a cache file
 * is set aside, logged, and answered as missing.
 */
export function readState<T>(file: string, kind: StateKind, parse: (text: string) => T): StateRead<T> {
  const read = probeState(file, parse)
  if (read.state !== 'unreadable') return read
  const base = basename(file)
  const memory = unreadableFiles.get(file)
  if (kind === 'trust') {
    if (!memory?.said) console.warn(`[state] ${base} cannot be read (${read.failure}); left as it is. Move it aside to start over.`)
    if (memory) memory.said = true
    return read
  }
  if (!memory?.stuck && setAsideUnreadable(file)) {
    console.warn(`[state] ${base} could not be read (${read.failure}); kept as ${base}.unreadable, starting empty.`)
  }
  return { state: 'missing' }
}

/** A trust file a write depends on: its value, null when missing, a thrown StateFileUnreadable otherwise. */
export function requireState<T>(file: string, parse: (text: string) => T): T | null {
  const read = readState(file, 'trust', parse)
  if (read.state === 'unreadable') throw new StateFileUnreadable(basename(file), read.failure)
  return read.state === 'ok' ? read.value : null
}

/** Rename to `<file>.unreadable`, over an older one. Never throws: a failure is one log line. True when set aside. */
export function setAsideUnreadable(file: string): boolean {
  try {
    renameOver(file, `${file}.unreadable`)
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
