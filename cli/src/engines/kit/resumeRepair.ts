/**
 * A stopped conversation's history made resumable, as the engine's launch contract declares it
 * (facets/launch.ts `ResumeRepairContract`). Moved from engines/codex/portableHistory.ts, whose every write and
 * refusal this reproduces (engines/launchPrep.golden.spec.ts). A history is found by its session's id with the
 * kit's lookup (kit/sessionRecords.ts), which the session store uses too. A resume is session control: this runs
 * in core, with no worker.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmSync, writeSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { ResumeRepairContract } from '../facets/launch.js'
import type { ResumePreparationKind } from '../../lib/productHealthContract.js'
import { findSessionFile } from './sessionRecords.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The relay's portable_reasoning_item contract. Plaintext engine reasoning has no vendor-stored id;
 * encrypted vendor reasoning must keep its original fields.
 */
function portableReasoning(item: unknown): boolean {
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

const REPAIRS: Record<ResumeRepairContract['repair'], (item: unknown) => boolean> = { 'portable-reasoning': portableReasoning }

/** The value at `path` in `record`, every step before the last an object; undefined where one is not. */
function valueAt(record: JsonObject, path: readonly string[]): unknown {
  let value: unknown = record
  for (const [index, key] of path.entries()) {
    if (index && !object(value)) return undefined
    value = (value as JsonObject)[key]
  }
  return value
}

/**
 * Why a history could not be prepared, by which check refused it: the resume reply and its counters carry the kind
 * (lib/resumeAgentService.ts). On 2026-10-26, 10 of 17 failed resumes were a preparation failure and nothing said
 * which. The message names the file and a line number only, never conversation text.
 */
export class ResumePreparationError extends Error {
  constructor(readonly kind: ResumePreparationKind, message: string) {
    super(message)
    this.name = 'ResumePreparationError'
  }
}

/** Shared by the string helper and the file reader, which retains only one record at a time. */
function historyRepair(contract: ResumeRepairContract, sessionId: string) {
  const repair = REPAIRS[contract.repair]
  const { file } = contract.names
  let sawFirst = false
  let repairedItems = 0
  let lineNumber = 0
  let partialTail = false
  /** `last`: the final line, with no newline after it. */
  const line = (line: string, last = false): string => {
    lineNumber++
    if (!line.trim()) return line
    let record: unknown
    try { record = JSON.parse(line) } catch {
      // An interrupted engine leaves its last record half written, and refusing it refused the whole
      // conversation (Oct 26 report). It is kept byte for byte: the engine reads its own file as it left it.
      if (last) { partialTail = true; return line }
      // JSON.parse's own error can quote conversation text; keep it out of daemon logs.
      throw new ResumePreparationError('invalid_json', `invalid JSON in ${file} at line ${lineNumber}`)
    }
    if (!object(record)) throw new ResumePreparationError('invalid_json', `invalid ${file} record`)
    if (!sawFirst) {
      // The id is never empty (the caller returns before), so a record with no such field never matches.
      if (record.type !== contract.first.type || valueAt(record, contract.first.id) !== sessionId) {
        throw new ResumePreparationError('foreign_session', `${file} does not belong to the session being resumed`)
      }
      sawFirst = true
    }
    const rule = contract.items.find((candidate) => candidate.type === record.type)
    const at = rule ? valueAt(record, rule.at) : undefined
    const items = !rule ? [] : rule.list ? (Array.isArray(at) ? at : []) : [at]
    let changed = false
    for (const item of items) {
      if (repair(item)) { repairedItems++; changed = true }
    }
    return changed ? JSON.stringify(record) + (line.endsWith('\r') ? '\r' : '') : line
  }
  return { line, partialTail: () => partialTail, finish: () => {
    if (!sawFirst) throw new ResumePreparationError('foreign_session', `${file} has no session metadata`)
    return repairedItems
  } }
}

/** Only replayed items are repaired. Other records (including readable event history) and unchanged lines
 *  retain their exact bytes. Invalid JSON aborts the whole repair, except in a final line with no newline. */
export function repairHistoryText(contract: ResumeRepairContract, history: string, sessionId: string): { history: string; repairedItems: number } {
  const repair = historyRepair(contract, sessionId)
  const parts = history.split('\n')
  const lines = parts.map((line, index) => repair.line(line, index === parts.length - 1))
  return { history: lines.join('\n'), repairedItems: repair.finish() }
}

const READ_BYTES = 64 * 1024
const changedDuring = (contract: ResumeRepairContract) =>
  new ResumePreparationError('changed_during', `${contract.names.file} changed during resume preparation; retry after its writer stops`)

function sameFile(a: Stats, b: Stats): boolean {
  return b.isFile() && a.ino === b.ino && a.dev === b.dev && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

/** A history can exceed V8's single-string limit. Decode complete JSONL records, preserving raw bytes for
 * unchanged records and hashing the whole file without holding it in memory. Reads are bounded to the
 * captured length so an unexpected writer cannot make preparation run forever. */
function scanHistory(contract: ResumeRepairContract, fd: number, size: number, sessionId: string, emit?: (original: Buffer, repaired: Buffer) => void) {
  const repair = historyRepair(contract, sessionId)
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(READ_BYTES)
  let fragments: Buffer[] = []
  let position = 0
  let repairedBytes = 0
  const line = (bytes: Buffer) => {
    const newline = bytes.at(-1) === 10
    const original = bytes.subarray(0, bytes.length - (newline ? 1 : 0)).toString('utf8')
    const repaired = repair.line(original, !newline)
    const output = repaired === original ? bytes : Buffer.from(repaired + (newline ? '\n' : ''))
    repairedBytes += output.length
    emit?.(bytes, output)
  }
  while (position < size) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position)
    if (!count) throw changedDuring(contract)
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
  return { repairedItems: repair.finish(), repairedBytes, digest: hash.digest('hex'), partialTail: repair.partialTail() }
}

function writeAll(contract: ResumeRepairContract, fd: number, bytes: Buffer): void {
  let written = 0
  while (written < bytes.length) {
    const count = writeSync(fd, bytes, written, bytes.length - written)
    if (!count) throw new ResumePreparationError('other', `Could not write the prepared ${contract.names.history}`)
    written += count
  }
}

/**
 * Repair the history of `sessionId`, at `transcriptPath` or found by its id in `sessionRoots`. Call only after
 * the session's engine has stopped, before launching its resume. A private backup precedes an atomic
 * replacement.
 *
 * `repairedBytes` (set only when items were repaired) is the on-disk length of the rewritten history. A live
 * tailer of this same file must move its offset there before the engine relaunches: the repair shrinks the
 * file mid-history, which an append-only byte tail would otherwise mistake for a truncation and replay in full.
 */
export function repairHistory(contract: ResumeRepairContract, sessionId: string, transcriptPath: string | null | undefined, sessionRoots: readonly string[]):
  { repairedItems: number; repairedBytes?: number; backupPath?: string } {
  const byId = () => sessionRoots.reduce<string | null>((found, sessions) => found ?? findSessionFile(sessionId, sessions, contract.sessions), null)
  let file = transcriptPath || byId()
  // A missing history still follows the engine's existing resume/fresh fallback.
  if (!file) return { repairedItems: 0 }
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // The registry may still point at a history that was moved; the engine resolves the session by id.
    file = byId()
    if (!file) return { repairedItems: 0 }
    before = lstatSync(file)
  }
  const real = realpathSync(file)
  const inside = sessionRoots.some((sessions) => {
    let root: string
    try { root = realpathSync(sessions) } catch { return false }
    const rel = relative(root, real)
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')
  })
  if (!before.isFile() || before.isSymbolicLink() || !inside
    || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new ResumePreparationError('not_owned_file', `${contract.names.file} is outside the session profile or is not an owned regular file`)
  }
  const input = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const unchanged = () => {
      if (!sameFile(before, fstatSync(input)) || !sameFile(before, lstatSync(file!))) throw changedDuring(contract)
    }
    unchanged()
    const inspected = scanHistory(contract, input, before.size, sessionId)
    unchanged()
    if (inspected.partialTail) console.log(`[resume] ${contract.names.file} ended in a partial line; kept as is`)
    if (!inspected.repairedItems) return { repairedItems: 0 }

    const suffix = randomUUID()
    const backupPath = `${file}${contract.backup}${suffix}`
    const temporary = `${file}${contract.temporary}${suffix}`
    let backup: number | undefined
    let output: number | undefined
    let verifiedBackup = false
    try {
      backup = openSync(backupPath, 'wx', 0o600)
      output = openSync(temporary, 'wx', 0o600)
      // Re-read into private files only after every record has validated. The digest proves the
      // backup and repaired output came from the exact bytes inspected, even across chunk reads.
      const copied = scanHistory(contract, input, before.size, sessionId, (original, repaired) => {
        writeAll(contract, backup!, original)
        writeAll(contract, output!, repaired)
      })
      if (copied.digest !== inspected.digest) throw changedDuring(contract)
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
