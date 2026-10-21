import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { win32 } from 'node:path'

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
