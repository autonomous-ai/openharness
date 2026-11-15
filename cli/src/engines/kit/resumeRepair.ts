/**
 * A stopped conversation's history made resumable, as the engine's launch contract declares it
 * (facets/launch.ts `ResumeRepairContract`). Moved from engines/codex/portableHistory.ts, whose every write and
 * refusal this reproduces (engines/launchPrep.golden.spec.ts). A history is found by its session's id with the
 * kit's lookup (kit/sessionRecords.ts), which the session store uses too. A resume is session control: this runs
 * in core, with no worker.
 *
 * It reads a chunk at a time and gives the core's loop back between chunks, within the bounds below (core/AGENTS.md
 * rule 4). Read in line, a 200 MB rollout held the core's loop 0.7 s, and 2.4 s when it had something to repair; the
 * rollout of 3 October was 803 MB.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsync, lstatSync, openSync, read, realpathSync, renameSync, rmSync, write, type Stats } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
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

/** What a repair may cost. Past any of these the resume goes on without it, on the history as it is: the engine reads
 *  its own file, as it did before there was a repair. */
export interface RepairLimits {
  /** Both reads and the copies, checked before each read. The two flushes after the last read are not cut short. */
  deadlineMs: number
  /** The largest history read. Repairing one writes two more copies of it: the backup and the repaired history. */
  maxBytes: number
  /** The largest record, decoded in one piece on the core's loop. */
  maxRecordBytes: number
}

export const REPAIR_LIMITS: RepairLimits = {
  // A 200 MB rollout with an item to repair takes about 2 s on a Mac: both reads, both copies and their flushes.
  deadlineMs: 60_000,
  maxBytes: 1024 ** 3,
  // The largest record in 653 MB of rollouts on a working Mac was 11.6 MiB, and decoded in 20 ms.
  maxRecordBytes: 16 * 1024 ** 2,
}

/** Why a history resumes as it is: larger than the core reads (or one of its records is), out of time, or its resume
 *  was cancelled. Nothing of the history was changed. */
export type Unrepaired = 'too_large' | 'timed_out' | 'cancelled'

/** `repairedBytes` and `backupPath` are set only when items were repaired; `unrepaired` only when the history was not
 *  read through. */
export interface HistoryRepair { repairedItems: number; repairedBytes?: number; backupPath?: string; unrepaired?: Unrepaired }

/** Thrown between chunks: the repair stops and the history is left as it is. */
class Abandoned extends Error {
  constructor(readonly why: Unrepaired) { super(why) }
}

/** How much is read at once: the core's loop is given back after each, and holds at most this, or one record. */
const READ_BYTES = 1024 * 1024
const changedDuring = (contract: ResumeRepairContract) =>
  new ResumePreparationError('changed_during', `${contract.names.file} changed during resume preparation; retry after its writer stops`)

function sameFile(a: Stats, b: Stats): boolean {
  return b.isFile() && a.ino === b.ino && a.dev === b.dev && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

const readAt = (fd: number, buffer: Buffer, length: number, position: number) => new Promise<number>((resolve, reject) => {
  read(fd, buffer, 0, length, position, (error, count) => { if (error) reject(error); else resolve(count) })
})
const writeAt = (fd: number, bytes: Buffer, offset: number) => new Promise<number>((resolve, reject) => {
  write(fd, bytes, offset, bytes.length - offset, null, (error, count) => { if (error) reject(error); else resolve(count) })
})
const flush = (fd: number) => new Promise<void>((resolve, reject) => {
  fsync(fd, (error) => { if (error) reject(error); else resolve() })
})

/** The backup, the exact bytes of each chunk read, and the prepared history, its lines as repaired: both written once a
 *  chunk is done, as the lines a chunk gave are views of its buffer, which the next read reuses. */
function copies(contract: ResumeRepairContract, backup: number, output: number) {
  let lines: Buffer[] = []
  const writeAll = async (fd: number, bytes: Buffer): Promise<void> => {
    let written = 0
    while (written < bytes.length) {
      const count = await writeAt(fd, bytes, written)
      if (!count) throw new ResumePreparationError('other', `Could not write the prepared ${contract.names.history}`)
      written += count
    }
  }
  return {
    add: (line: Buffer) => { lines.push(line) },
    write: async (read: Buffer) => {
      const repaired = Buffer.concat(lines)
      lines = []
      await writeAll(backup, read)
      await writeAll(output, repaired)
    },
  }
}

/** A history can exceed V8's single-string limit. Decode complete JSONL records, preserving raw bytes for
 * unchanged records and hashing the whole file without holding it in memory. Reads are bounded to the
 * captured length so an unexpected writer cannot make preparation run forever. `step` runs before each read: it
 * stops the scan once its repair is out of time or no longer wanted. */
async function scanHistory(contract: ResumeRepairContract, fd: number, size: number, sessionId: string, limits: RepairLimits,
  step: () => void, sink?: ReturnType<typeof copies>) {
  const repair = historyRepair(contract, sessionId)
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(READ_BYTES)
  let fragments: Buffer[] = []
  let fragmentBytes = 0
  let position = 0
  let repairedBytes = 0
  const line = (bytes: Buffer) => {
    if (bytes.length > limits.maxRecordBytes) throw new Abandoned('too_large')
    const newline = bytes.at(-1) === 10
    const original = bytes.subarray(0, bytes.length - (newline ? 1 : 0)).toString('utf8')
    const repaired = repair.line(original, !newline)
    const output = repaired === original ? bytes : Buffer.from(repaired + (newline ? '\n' : ''))
    repairedBytes += output.length
    sink?.add(output)
  }
  while (position < size) {
    step()
    const count = await readAt(fd, chunk, Math.min(chunk.length, size - position), position)
    if (!count) throw changedDuring(contract)
    position += count
    hash.update(chunk.subarray(0, count))
    let start = 0
    let end: number
    while ((end = chunk.indexOf(10, start)) >= 0 && end < count) {
      const part = chunk.subarray(start, end + 1)
      if (fragments.length) {
        fragments.push(part)
        line(Buffer.concat(fragments, fragmentBytes + part.length))
        fragments = []
        fragmentBytes = 0
      } else line(part)
      start = end + 1
    }
    // Copy the trailing fragment before the next read reuses the chunk buffer. In particular,
    // a multibyte UTF-8 codepoint split across reads is decoded only after its line is complete.
    // A record longer than the bound is not gathered at all.
    if (start < count) {
      fragmentBytes += count - start
      if (fragmentBytes > limits.maxRecordBytes) throw new Abandoned('too_large')
      fragments.push(Buffer.from(chunk.subarray(start, count)))
    }
    await sink?.write(chunk.subarray(0, count))
  }
  if (fragments.length) line(Buffer.concat(fragments))
  await sink?.write(Buffer.alloc(0))
  return { repairedItems: repair.finish(), repairedBytes, digest: hash.digest('hex'), partialTail: repair.partialTail() }
}

/**
 * Repair the history of `sessionId`, at `transcriptPath` or found by its id in `sessionRoots`. Call only after
 * the session's engine has stopped, before launching its resume. A private backup precedes an atomic
 * replacement.
 *
 * `repairedBytes` (set only when items were repaired) is the on-disk length of the rewritten history. A live
 * tailer of this same file must move its offset there before the engine relaunches: the repair shrinks the
 * file mid-history, which an append-only byte tail would otherwise mistake for a truncation and replay in full.
 * The history is replaced as the last step before the promise settles, with nothing in between, so its caller
 * moves the tail before anything else can read the file.
 *
 * `current` is the resume's own: once it is false the repair stops, and nothing is replaced. Past `limits` the
 * history resumes as it is (`unrepaired`), and so it does when the resume was cancelled.
 */
export async function repairHistory(contract: ResumeRepairContract, sessionId: string, transcriptPath: string | null | undefined, sessionRoots: readonly string[],
  current: () => boolean, limits: RepairLimits = REPAIR_LIMITS): Promise<HistoryRepair> {
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
  if (before.size > limits.maxBytes) return { repairedItems: 0, unrepaired: 'too_large' }
  const until = performance.now() + limits.deadlineMs
  const step = () => {
    if (!current()) throw new Abandoned('cancelled')
    if (performance.now() > until) throw new Abandoned('timed_out')
  }
  const input = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const unchanged = () => {
      if (!sameFile(before, fstatSync(input)) || !sameFile(before, lstatSync(file!))) throw changedDuring(contract)
    }
    unchanged()
    const inspected = await scanHistory(contract, input, before.size, sessionId, limits, step)
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
      const copied = await scanHistory(contract, input, before.size, sessionId, limits, step, copies(contract, backup, output))
      if (copied.digest !== inspected.digest) throw changedDuring(contract)
      await flush(backup)
      await flush(output)
      // The replacement is the one step that cannot be taken back: a resume cancelled during the flushes leaves the
      // history as it was. From here to the return nothing awaits.
      if (!current()) throw new Abandoned('cancelled')
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
  } catch (error) {
    if (error instanceof Abandoned) return { repairedItems: 0, unrepaired: error.why }
    throw error
  } finally { closeSync(input) }
}
