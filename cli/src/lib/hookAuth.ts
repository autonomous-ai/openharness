import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireWindowsStateFile, secureStateDirectory, syncStateDirectory } from './secureState.js'

const FILE_NAME = 'hook-credential'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function hookCredentialPath(dataDir: string): string {
  return join(dataDir, FILE_NAME)
}

function secureDataDirectory(dataDir: string): boolean {
  try {
    secureStateDirectory(dataDir, false)
    return true
  } catch {
    return false
  }
}

export function readHookCredential(dataDir: string): string | null {
  let fd: number | null = null
  try {
    if (!secureDataDirectory(dataDir)) return null
    const file = hookCredentialPath(dataDir)
    // Windows: the file itself must be a real file in the profile (secureState.ts); its open follows links.
    if (process.platform === 'win32') requireWindowsStateFile(file)
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (!stat.isFile() || stat.size > 128) return null
    if (uid !== null && stat.uid !== uid) return null
    // Windows reports every file as 0o666 (or 0o444), so this check refused the credential the daemon had written,
    // the next create was EEXIST and the daemon's second start ended in safe mode (Task 23, the VM E2E). There the
    // file's protection is the folder's ACL, which secureDataDirectory checked by location (secureState.ts).
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) return null
    const value = readFileSync(fd, 'utf8').trim()
    return TOKEN_RE.test(value) ? value : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export function loadOrCreateHookCredential(dataDir: string): string {
  const existing = readHookCredential(dataDir)
  if (existing) return existing
  try {
    secureStateDirectory(dataDir)
  } catch {
    throw new Error('hook credential directory has unsafe owner, mode, or type')
  }
  const value = randomBytes(32).toString('base64url')
  const file = hookCredentialPath(dataDir)
  let fd: number
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    const raced = readHookCredential(dataDir)
    if (raced) return raced
    throw error
  }
  try {
    writeFileSync(fd, `${value}\n`)
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncStateDirectory(dataDir)
  return value
}

export function hookCredentialMatches(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
}
