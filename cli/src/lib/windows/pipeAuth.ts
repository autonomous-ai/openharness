/**
 * The credential of the daemon's Windows pipe (docs/superpowers/specs/2026-10-16-windows-native-cli-design.md §2).
 *
 * Node cannot set a named pipe's DACL. The default DACL lets every account open the pipe for reading, and once the
 * daemon is gone any account can create a pipe of that name. So reaching `\\.\pipe\harness-<id>` proves nothing,
 * unlike the Unix socket (lib/localSocket.ts). Each request proves the daemon's token instead, as the pty host's
 * hello does (ptyHost/protocol.ts). The client sends `<nonce>.<HMAC-SHA256(token, 0x01‖nonce)>` and the daemon
 * answers with HMAC-SHA256(token, 0x00‖nonce). The token never travels.
 *
 * The nonce starts with the pipe's id. An auth taken by whatever squatted on a dead daemon's name then opens
 * nothing at the next daemon's pipe, whose nonce window starts empty.
 *
 * Nothing here depends on the transport: the same checks run over a Unix socket in the tests on macOS and Linux.
 * The one exception is the token file at the end (daemonTokenPath): it reads and writes the daemon's data folder.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, openSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { readPrivateStateFile, requireWindowsStateFile, secureStateDirectory, syncStateDirectory } from '../secureState.js'

export const PIPE_AUTH_HEADER = 'x-harness-auth'
export const PIPE_PROOF_HEADER = 'x-harness-proof'

const HEX64 = /^[0-9a-f]{64}$/
const AUTH_RE = /^([0-9a-f]{64})\.([0-9a-f]{64})$/
const PIPE_ID = /^[0-9a-f]{32}$/
/** `harness-<id>` as the whole last part of the name: `\\.\pipe\harness-<id>`, or a test socket's `/…/harness-<id>`. */
const PIPE_ID_RE = /(?:^|[\\/])harness-([0-9a-f]{32})$/
/** A pipe on this computer named harness-<id>, nothing else: not a file, not `\\host\pipe\` (an SMB connection). */
const LOCAL_PIPE_RE = /^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/

function mac(token: Buffer, separator: number, nonce: string): string {
  return createHmac('sha256', token).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** What a client sends in `x-harness-auth` for [nonce]. */
export function pipeAuthValue(token: Buffer, nonce: string): string {
  return `${nonce}.${mac(token, 0x01, nonce)}`
}

/** What the daemon answers in `x-harness-proof` for [nonce]: only a process that knows the token can give it. */
export function pipeProofValue(token: Buffer, nonce: string): string {
  return mac(token, 0x00, nonce)
}

/**
 * What the data folder claim answers for [nonce] (windows/dataFolderClaim.ts), so a start that finds the claim's name
 * taken can tell a Harness core from whatever else took it. Its own separator: that answer is never a pipe auth or
 * a pipe proof, whatever nonce a caller sends.
 */
export function claimProofValue(token: Buffer, nonce: string): string {
  return mac(token, 0x02, nonce)
}

/** Whether [proof] is the claim's answer for [token] and [nonce]. */
export function claimProven(proof: unknown, token: Buffer, nonce: string): boolean {
  return typeof proof === 'string' && HEX64.test(proof) && sameHex(proof, claimProofValue(token, nonce))
}

/** The nonces a daemon took most recently: an auth is accepted once. Bounded; the oldest is forgotten first. */
export class NonceWindow {
  private readonly seen = new Set<string>()
  constructor(readonly capacity = 4_096) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`A nonce window's capacity must be a whole number of at least 1, not ${capacity}`)
  }

  /** Whether [nonce] is new here; it is remembered either way. */
  admit(nonce: string): boolean {
    if (this.seen.has(nonce)) return false
    this.seen.add(nonce)
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value as string)
    return true
  }

  get size(): number {
    return this.seen.size
  }
}

/**
 * The nonce of a valid `x-harness-auth` [header], or null. Valid: well formed, this token's HMAC, a nonce that begins
 * with [pipeId] when one is given, and not seen before. The HMAC is checked before the window, so refused headers
 * never fill it. A [pipeId] that is not a whole id (32 lowercase hex digits; pipeIdOf) refuses every header: an empty
 * or partial one would bind nothing. A server always passes its own pipe's id.
 */
export function checkPipeAuth(token: Buffer, header: string | undefined, seen: NonceWindow, pipeId?: string): { nonce: string } | null {
  if (typeof header !== 'string') return null
  const match = AUTH_RE.exec(header)
  if (!match) return null
  const nonce = match[1]!
  if (pipeId !== undefined && !(PIPE_ID.test(pipeId) && nonce.slice(0, 32) === pipeId)) return null
  if (!sameHex(match[2]!, mac(token, 0x01, nonce))) return null
  return seen.admit(nonce) ? { nonce } : null
}

/** Whether an answer's [headers] prove [token] for [nonce]. */
export function pipeProven(headers: IncomingHttpHeaders, token: Buffer, nonce: string): boolean {
  const proof = headers[PIPE_PROOF_HEADER]
  return typeof proof === 'string' && HEX64.test(proof) && sameHex(proof, pipeProofValue(token, nonce))
}

/** A new pipe name for a daemon that is starting: `\\.\pipe\harness-<128 random bits as hex>`. */
export function newPipePath(): string {
  return `\\\\.\\pipe\\harness-${randomBytes(16).toString('hex')}`
}

/** The 32-hex id that ends a Harness pipe name, or null for an endpoint that is not one. */
export function pipeIdOf(endpoint: string): string | null {
  return PIPE_ID_RE.exec(endpoint)?.[1] ?? null
}

/**
 * Whether [path] may be dialled as the daemon's pipe. On Windows only a local pipe named harness-<id>: a file, a
 * longer name, or another computer's pipe (`\\host\pipe\…`, an outbound SMB connection that can carry this user's
 * NTLM credentials) is none. Elsewhere only the tests record a pipe, a Unix socket whose name is harness-<id>.
 */
export function isPipePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? LOCAL_PIPE_RE.test(path) : pipeIdOf(path) !== null
}

/** A nonce for one request to [endpoint]: its pipe id, then 128 random bits, as 64 hex digits. */
export function newPipeNonce(endpoint: string): string {
  const id = pipeIdOf(endpoint)
  if (!id) throw new Error(`${endpoint} is not a Harness pipe`)
  return id + randomBytes(16).toString('hex')
}

export const DAEMON_TOKEN_FILE = 'daemon-token'
/** A whole token file: 64 hex digits and a newline. */
const TOKEN_FILE_BYTES = 65
/** A short file older than this was left by a crash or an old writer; a younger one may be a writer mid-write. */
const STALE_MS = 10_000
/** How long a start waits for a young short file to be filled before it gives up. */
const WAIT_MS = 2_000
const POLL_MS = 50
const TOKEN_TEXT = /^[0-9a-f]{64}\n?$/

export function daemonTokenPath(dataDir: string): string {
  return join(dataDir, DAEMON_TOKEN_FILE)
}

/**
 * The daemon's token in [dataDir], or null when there is none or it cannot be trusted. On Unix the folder and the file
 * pass secureState's owner and mode checks. On Windows the folder must be inside the profile, and the file must be a
 * real file there, not a link (requireWindowsStateFile). The profile's ACL is the protection, as for the hook
 * credential. The file is exactly 64 lowercase hex digits and an optional newline.
 */
export function readDaemonToken(dataDir: string): Buffer | null {
  try {
    secureStateDirectory(dataDir, false)
    const file = daemonTokenPath(dataDir)
    if (process.platform === 'win32') requireWindowsStateFile(file)
    const text = readPrivateStateFile(file, 128)
    return TOKEN_TEXT.test(text) ? Buffer.from(text.slice(0, 64), 'hex') : null
  } catch {
    return null
  }
}

/** Age in ms of a regular file shorter than a whole token (a crash cut it short), or null when it is anything else. */
function shortFileAge(file: string): number | null {
  try {
    const entry = lstatSync(file)
    return entry.isFile() && entry.size < TOKEN_FILE_BYTES ? Date.now() - entry.mtimeMs : null
  } catch {
    return null
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Publish [token] at [file] whole or not at all: write a temp file beside it (owner-only, flushed), then hard-link it
 * into place. The link fails with EEXIST when another start got there first, and a reader never sees a part of a token.
 * Returns whether this call published it.
 */
function publish(dataDir: string, file: string, token: Buffer): boolean {
  const temp = join(dataDir, `.${DAEMON_TOKEN_FILE}.${process.pid}.${randomBytes(6).toString('hex')}`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try {
      writeFileSync(fd, `${token.toString('hex')}\n`)
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(temp, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    syncStateDirectory(dataDir)
    return true
  } finally {
    // Best effort: on Windows an antivirus or indexer may still hold the temp file. A token already published must
    // not fail the start, and an earlier error must not be hidden by this one; a leftover temp file is harmless.
    try { unlinkSync(temp) } catch { /* left behind */ }
  }
}

/**
 * The daemon's token, made on the first start: 32 random bytes, published whole with a hard link, so two starts at
 * once agree on the winner's. A short file left by a crash or an old writer is replaced once it is older than
 * STALE_MS; a younger one is waited on for up to WAIT_MS. Any other file that cannot be read as a token (a link, one
 * another account could write, one outside the profile) is refused: the daemon does not start on it.
 */
export function ensureDaemonToken(dataDir: string): Buffer {
  const existing = readDaemonToken(dataDir)
  if (existing) return existing
  secureStateDirectory(dataDir)
  const file = daemonTokenPath(dataDir)
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    const token = randomBytes(32)
    if (publish(dataDir, file, token)) return token
    const winner = readDaemonToken(dataDir)
    if (winner) return winner
    const age = shortFileAge(file)
    if (age === null) break
    if (age >= STALE_MS) {
      // Look again just before removing: a writer may have replaced it since.
      const again = shortFileAge(file)
      if (again !== null && again >= STALE_MS) rmSync(file, { force: true })
    } else if (Date.now() >= deadline) {
      break
    } else {
      sleep(POLL_MS)
    }
  }
  throw new Error(`the daemon token ${file} cannot be read or replaced`)
}
