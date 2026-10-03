import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmSync, writeSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { resolveCodexRollout } from './rollout.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Match the relay's portable_reasoning_item contract. Plaintext engine reasoning has no
 * vendor-stored id; encrypted vendor reasoning must keep its original fields. */
function repairReasoning(item: unknown): boolean {
  if (!object(item) || item.type !== 'reasoning' || item.encrypted_content) return false
  let changed = false
  if ('id' in item) {
    delete item.id
    changed = true
  }
  if (Array.isArray(item.content) && item.content.length) {
    const text = item.content.map((part) => object(part) && typeof part.text === 'string' ? part.text : '').join('')
    item.content = []
    if (text && (!Array.isArray(item.summary) || !item.summary.length)) {
      item.summary = [{ type: 'summary_text', text }]
    }
    changed = true
  }
  return changed
}

/** Shared by the string helper and the file reader, which retains only one record at a time. */
function historyRepair(sessionId: string) {
  let sawMeta = false
  let repairedItems = 0
  let lineNumber = 0
  const line = (line: string): string => {
    lineNumber++
    if (!line.trim()) return line
    let record: unknown
    try { record = JSON.parse(line) } catch {
      // JSON.parse's own error can quote conversation text; keep it out of daemon logs.
      throw new Error(`invalid JSON in Codex rollout at line ${lineNumber}`)
    }
    if (!object(record)) throw new Error('invalid Codex rollout record')
    if (!sawMeta) {
      if (record.type !== 'session_meta' || !object(record.payload) || record.payload.id !== sessionId) {
        throw new Error('Codex rollout does not belong to the session being resumed')
      }
      sawMeta = true
    }
    const items = record.type === 'response_item' ? [record.payload]
      : record.type === 'compacted' && object(record.payload) && Array.isArray(record.payload.replacement_history)
        ? record.payload.replacement_history : []
    let changed = false
    for (const item of items) {
      if (repairReasoning(item)) { repairedItems++; changed = true }
    }
    return changed ? JSON.stringify(record) + (line.endsWith('\r') ? '\r' : '') : line
  }
  return { line, finish: () => {
    if (!sawMeta) throw new Error('Codex rollout has no session metadata')
    return repairedItems
  } }
}

/** Only replayed API items are repaired. Other records (including readable event history) and
 * unchanged lines retain their exact bytes. Invalid JSON aborts the whole repair. */
export function portableCodexHistory(history: string, sessionId: string): { history: string; repairedItems: number } {
  const repair = historyRepair(sessionId)
  const lines = history.split('\n').map(repair.line)
  return { history: lines.join('\n'), repairedItems: repair.finish() }
}

const READ_BYTES = 64 * 1024
const changedDuringPreparation = () => new Error('Codex rollout changed during resume preparation; retry after its writer stops')

function sameFile(a: Stats, b: Stats): boolean {
  return b.isFile() && a.ino === b.ino && a.dev === b.dev && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

/** A rollout can exceed V8's single-string limit. Decode complete JSONL records, preserving raw
 * bytes for unchanged records and hashing the whole file without holding it in memory. Reads are
 * bounded to the captured length so an unexpected writer cannot make preparation run forever. */
function scanHistory(fd: number, size: number, sessionId: string, emit?: (original: Buffer, repaired: Buffer) => void) {
  const repair = historyRepair(sessionId)
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(READ_BYTES)
  let fragments: Buffer[] = []
  let position = 0
  let repairedBytes = 0
  const line = (bytes: Buffer) => {
    const newline = bytes.at(-1) === 10
    const original = bytes.subarray(0, bytes.length - (newline ? 1 : 0)).toString('utf8')
    const repaired = repair.line(original)
    const output = repaired === original ? bytes : Buffer.from(repaired + (newline ? '\n' : ''))
    repairedBytes += output.length
    emit?.(bytes, output)
  }
  while (position < size) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position)
    if (!count) throw changedDuringPreparation()
    position += count
    hash.update(chunk.subarray(0, count))
    let start = 0
    let end: number
    while ((end = chunk.indexOf(10, start)) >= 0 && end < count) {
      const part = chunk.subarray(start, end + 1)
      if (fragments.length) {
        fragments.push(part)
        line(Buffer.concat(fragments))
        fragments = []
      } else line(part)
      start = end + 1
    }
    // Copy the trailing fragment before the next read reuses the chunk buffer. In particular,
    // a multibyte UTF-8 codepoint split across reads is decoded only after its line is complete.
    if (start < count) fragments.push(Buffer.from(chunk.subarray(start, count)))
  }
  if (fragments.length) line(Buffer.concat(fragments))
  return { repairedItems: repair.finish(), repairedBytes, digest: hash.digest('hex') }
}

function writeAll(fd: number, bytes: Buffer): void {
  let written = 0
  while (written < bytes.length) {
    const count = writeSync(fd, bytes, written, bytes.length - written)
    if (!count) throw new Error('Could not write the prepared Codex history')
    written += count
  }
}

export interface CodexResumeSource {
  engine: string
  sessionId: string
  transcriptPath?: string | null
  codexHome?: string | null
}

/** Call only after the session's engine has stopped, before launching `codex resume`.
 * Retargeting to the native subscription bypasses Grid, so response-side relay cleanup cannot
 * repair items already persisted here. A private backup precedes an atomic replacement.
 *
 * `repairedBytes` (set only when items were repaired) is the on-disk length of the rewritten
 * rollout. A live tailer of this same file must move its offset there before the engine relaunches:
 * the repair shrinks the file mid-history, which an append-only byte tail would otherwise mistake
 * for a truncation and replay in full. */
export function prepareCodexResume(source: CodexResumeSource): { repairedItems: number; repairedBytes?: number; backupPath?: string } {
  if (source.engine !== 'codex' || !source.sessionId) return { repairedItems: 0 }
  const sessions = join(source.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
  let file = source.transcriptPath || resolveCodexRollout(source.sessionId, sessions)
  // A missing history still follows the engine's existing resume/fresh fallback.
  if (!file) return { repairedItems: 0 }
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // The registry may still point at a rollout that was moved; Codex resolves the session by id.
    file = resolveCodexRollout(source.sessionId, sessions)
    if (!file) return { repairedItems: 0 }
    before = lstatSync(file)
  }
  const rel = relative(realpathSync(sessions), realpathSync(file))
  if (!before.isFile() || before.isSymbolicLink() || isAbsolute(rel) || rel === '..' || rel.startsWith('../')
    || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new Error('Codex rollout is outside the session profile or is not an owned regular file')
  }
  const input = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const unchanged = () => {
      if (!sameFile(before, fstatSync(input)) || !sameFile(before, lstatSync(file!))) throw changedDuringPreparation()
    }
    unchanged()
    const inspected = scanHistory(input, before.size, source.sessionId)
    unchanged()
    if (!inspected.repairedItems) return { repairedItems: 0 }

    const suffix = randomUUID()
    const backupPath = `${file}.reasoning-backup-${suffix}`
    const temporary = `${file}.reasoning-tmp-${suffix}`
    let backup: number | undefined
    let output: number | undefined
    let verifiedBackup = false
    try {
      backup = openSync(backupPath, 'wx', 0o600)
      output = openSync(temporary, 'wx', 0o600)
      // Re-read into private files only after every record has validated. The digest proves the
      // backup and repaired output came from the exact bytes inspected, even across chunk reads.
      const copied = scanHistory(input, before.size, source.sessionId, (original, repaired) => {
        writeAll(backup!, original)
        writeAll(output!, repaired)
      })
      if (copied.digest !== inspected.digest) throw changedDuringPreparation()
      fsyncSync(backup)
      fsyncSync(output)
      unchanged()
      verifiedBackup = true
      renameSync(temporary, file)
      return { repairedItems: copied.repairedItems, repairedBytes: copied.repairedBytes, backupPath }
    } finally {
      if (output !== undefined) { closeSync(output); rmSync(temporary, { force: true }) }
      if (backup !== undefined) {
        closeSync(backup)
        if (!verifiedBackup) rmSync(backupPath, { force: true })
      }
    }
  } finally { closeSync(input) }
}
