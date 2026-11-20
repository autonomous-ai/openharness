import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  atomicWriteFile, pauseSync, READ_TRIES, READ_WAIT_MS, requireWindowsStateFile, secureStateDirectory, StateFileUnreadable,
  type TrustFile,
} from './secureState.js'

const FILE_NAME = 'hook-credential'
/**
 * What an engine's hook shows over TCP: it opens `/api/hook/*` and nothing else. A hook that can only post to a port
 * hands its token to whoever holds that port (audit H1, docs/security/2026-11-02-team-account-boundary.md), so that
 * token must not be the credential that drives the local API and its shell.
 */
const HOOK_TOKEN_FILE = 'hook-token'
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

export function hookTokenPath(dataDir: string): string {
  return join(dataDir, HOOK_TOKEN_FILE)
}

export function readHookCredential(dataDir: string): string | null {
  return readSecret(dataDir, hookCredentialPath(dataDir))
}

export function loadOrCreateHookCredential(dataDir: string): string {
  return loadOrCreateSecret(dataDir, hookCredentialPath(dataDir))
}

export function loadOrCreateHookToken(dataDir: string): string {
  return loadOrCreateSecret(dataDir, hookTokenPath(dataDir))
}

/** Both files, for whoever names the trust files that cannot be read. */
export function hookSecretFiles(dataDir: string): TrustFile[] {
  return [{ file: hookCredentialPath(dataDir), parse: parseSecret }, { file: hookTokenPath(dataDir), parse: parseSecret }]
}

function parseSecret(text: string): string {
  const value = text.trim()
  if (!TOKEN_RE.test(value)) throw new TypeError('not a hook credential')
  return value
}

function readSecret(dataDir: string, file: string): string | null {
  let fd: number | null = null
  try {
    if (!secureDataDirectory(dataDir)) return null
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
    return parseSecret(readFileSync(fd, 'utf8'))
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function loadOrCreateSecret(dataDir: string, file: string): string {
  const existing = readSecret(dataDir, file)
  if (existing) return existing
  try {
    secureStateDirectory(dataDir)
  } catch {
    throw new Error('hook credential directory has unsafe owner, mode, or type')
  }
  const value = randomBytes(32).toString('base64url')
  if (atomicWriteFile(file, `${value}\n`, 'trust', { exclusive: true })) return value
  // Another daemon made it first. An older build fills its file after creating it, so it may still be empty.
  for (let attempt = 1; ; attempt++) {
    const raced = readSecret(dataDir, file)
    if (raced) return raced
    if (attempt === READ_TRIES) throw new StateFileUnreadable(basename(file), 'unexpected content')
    pauseSync(READ_WAIT_MS)
  }
}

export function hookCredentialMatches(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
}
