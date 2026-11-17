/**
 * The record an engine keeps of the session its terminal is on (Hermes: `<home>/terminal-sessions/<terminal id>`,
 * `hermes_cli/terminal_breadcrumbs.py`), read without trusting it. The file lives in the agent's home, which a
 * sandbox controls: it may be a symlink to another agent's record or to `/etc/passwd`, a FIFO, or 10 MB of JSON. So
 * it is looked at, opened without following a link or waiting for a writer, checked to be the file looked at, and
 * read within the limit. Nothing is ever written. It names no engine: the engine's rule is passed in.
 */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { observeNativeFile } from './nativeFileObservation.js'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'
import { NativePaths } from './nativePaths.js'

export interface TerminalRecordRule {
  directory: string
  maxBytes: number
  id: RegExp
  names: readonly { of: 'tty' | 'tmuxPane'; prefix: string }[]
  unsafe: RegExp
  keep: number
  session: string
  time: string
}

export interface Terminal { tty: string | null; tmuxPane: string | null }

export type TerminalRecordRead =
  | { state: 'none' }
  | { state: 'ignored'; reason: 'not a regular file' | 'oversized' | 'malformed' | 'unreadable' | 'stale' }
  | { state: 'record'; sessionId: string; at: number }

/** The names the engine gives this terminal's record, in the order it prefers them. */
export function terminalRecordNames(rule: TerminalRecordRule, terminal: Terminal): string[] {
  const names: string[] = []
  for (const { of, prefix } of rule.names) {
    const value = terminal[of]
    // Hermes names no terminal by an empty one (`if name:`).
    if (!value) continue
    names.push(prefix + value.trim().replace(/^\/+|\/+$/g, '').replace(rule.unsafe, '-').slice(0, rule.keep))
  }
  return names
}

/** What is at each name now, so a record is read again only once it changed: one `lstat` per name. */
export async function terminalRecordStamp(rule: TerminalRecordRule, home: string, names: readonly string[]): Promise<string> {
  const stamps = await Promise.all(names.map(name => lstat(join(home, rule.directory, name))
    .then(info => `${info.ino}:${info.size}:${info.mtimeMs}`, () => '-')))
  return stamps.join('|')
}

/** The first record that counts, in the names' order; else why the first one met did not; else none. */
export async function readTerminalRecord(rule: TerminalRecordRule, home: string, names: readonly string[], sinceMs: number): Promise<TerminalRecordRead> {
  let first: TerminalRecordRead = NONE
  for (const name of names) {
    const read = await readOne(rule, join(home, rule.directory, name), sinceMs)
    if (read.state === 'record') return read
    if (first.state === 'none') first = read
  }
  return first
}

const NONE: TerminalRecordRead = { state: 'none' }
// No folder, or a file where the folder should be: Hermes could write no record there.
const ABSENT = new Set(['ENOENT', 'ENOTDIR'])
// Where the platform has no such flag, the identity check after the open is what refuses a swapped-in link.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
// Hermes reads it as `utf-8-sig`: strict, a leading byte-order mark dropped. The decoder does both.
const UTF8 = new TextDecoder('utf-8', { fatal: true })

async function readOne(rule: TerminalRecordRule, file: string, sinceMs: number): Promise<TerminalRecordRead> {
  let bytes: Buffer
  try {
    const seen = await lstat(file)
    if (!seen.isFile()) return ignored('not a regular file')
    if (seen.size > rule.maxBytes) return ignored('oversized')
    const handle = await open(file, READ_FLAGS)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.ino !== seen.ino || opened.dev !== seen.dev) return ignored('not a regular file')
      // One byte past the limit tells a file that grew since it was looked at.
      bytes = Buffer.alloc(rule.maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > rule.maxBytes) return ignored('oversized')
      bytes = bytes.subarray(0, length)
    } finally {
      await handle.close().catch(() => {})
    }
  } catch (error) {
    return ABSENT.has((error as NodeJS.ErrnoException).code ?? '') ? NONE : ignored('unreadable')
  }
  return terminalRecordValue(rule, bytes, sinceMs)
}

function terminalRecordValue(rule: TerminalRecordRule, bytes: Buffer, sinceMs: number): TerminalRecordRead {
  let value: unknown
  try { value = JSON.parse(UTF8.decode(bytes)) } catch { return ignored('malformed') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ignored('malformed')
  const session = (value as Record<string, unknown>)[rule.session], time = (value as Record<string, unknown>)[rule.time]
  if (typeof session !== 'string' || !rule.id.test(session) || typeof time !== 'number' || !Number.isFinite(time)) return ignored('malformed')
  // A tty is used again: a record an earlier process left in it is not this process's.
  if (time * 1000 < sinceMs) return ignored('stale')
  return { state: 'record', sessionId: session, at: time * 1000 }
}

/** Retained exact records before Stop; after its first signal only a current conflicting claim revokes escalation. */
export function terminalRecordEvidence(rule: TerminalRecordRule, home: string, names: readonly string[], sinceMs: number, sessionId: string) {
  if (names.length > rule.names.length || !Number.isFinite(sinceMs)) return nativeUnavailable('the native terminal identity is unavailable')
  const paths = new NativePaths(new NativeEvidenceBudget())
  paths.resolveSync(join(home, rule.directory), true)
  const verifyRoute = paths.retain()
  const capture = () => {
    const files = []
    for (const name of names) {
      const file = observeNativeFile(join(home, rule.directory, name), { maxBytes: rule.maxBytes, missingOkay: true })
      files.push(file)
      if (file.bytes !== undefined) break // Lower-priority names cannot override the terminal's preferred record.
    }
    return files
  }
  const matches = (files: ReturnType<typeof capture>) => {
    for (const file of files) {
      if (!file.bytes) continue // Older Hermes and its TUI need not keep a terminal record.
      const read = terminalRecordValue(rule, file.bytes, sinceMs)
      if (read.state !== 'record') return nativeUnavailable('the native terminal record is unavailable')
      if (read.sessionId !== sessionId) nativeUnavailable('the native terminal changed conversations')
    }
  }
  const files = capture()
  matches(files)
  return { verify(afterEffect = false): void {
    verifyRoute()
    if (afterEffect) { matches(capture()); verifyRoute() }
    else for (const file of files) file.verify()
  } }
}

function ignored(reason: Extract<TerminalRecordRead, { state: 'ignored' }>['reason']): TerminalRecordRead {
  return { state: 'ignored', reason }
}
