/**
 * A stopped conversation's history made resumable, as the engine's launch contract declares it
 * (facets/launch.ts `ResumeRepairContract`). Moved from engines/codex/portableHistory.ts, whose every write and
 * refusal this reproduces (engines/launchPrep.golden.spec.ts). A history is found by its session's id with the
 * kit's lookup (kit/sessionRecords.ts), which the session store uses too. The supervised worker stages its copies;
 * core owns final publication and Watcher ordering. The dated inline compatibility entry alone publishes here.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsync, lstatSync, openSync, read, realpathSync, renameSync, rmSync, write, type Stats } from 'node:fs'
import { join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ResumeRepairContract } from '../facets/launch.js'
import { REPAIR_LIMITS, ResumePreparationError, type HistoryRepair, type RepairLimits, type Unrepaired } from '../facets/resumeRepair.js'
import { repairFile, sameRepairFile, type RepairFile, type RepairPrepared } from '../worker/resumeRepairProtocol.js'
export { REPAIR_LIMITS, ResumePreparationError, type HistoryRepair, type RepairLimits, type Unrepaired } from '../facets/resumeRepair.js'
import { staysInside } from '../../lib/pathContainment.js'
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

/** Shared by the string helper and the file reader, which retains only one record at a time. */
function historyRepair(contract: ResumeRepairContract, sessionId: string) {
  const repair = REPAIRS[contract.repair]
  const { record: named } = contract.names
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
      throw new ResumePreparationError('invalid_json', `invalid JSON in ${named} at line ${lineNumber}`)
    }
    if (!object(record)) throw new ResumePreparationError('invalid_json', `invalid ${named} record`)
    if (!sawFirst) {
      // The id is never empty (the caller returns before), so a record with no such field never matches.
      if (record.type !== contract.first.type || valueAt(record, contract.first.id) !== sessionId) {
        throw new ResumePreparationError('foreign_session', `${named} does not belong to the session being resumed`)
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
    if (!sawFirst) throw new ResumePreparationError('foreign_session', `${named} has no session metadata`)
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

/** Thrown between chunks: the repair stops and the history is left as it is. */
class Abandoned extends Error {
  constructor(readonly why: Unrepaired) { super(why) }
}

/** One chunk or one bounded record is retained, never a whole history. */
const READ_BYTES = 1024 * 1024
const changedDuring = (contract: ResumeRepairContract) =>
  new ResumePreparationError('changed_during', `${contract.names.record} changed during resume preparation; retry after its writer stops`)

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
    if (repairedBytes > limits.maxBytes) throw new Abandoned('too_large')
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
export function locateRepairHistory(contract: ResumeRepairContract, sessionId: string, transcriptPath: string | null | undefined, sessionRoots: readonly string[]) {
  const byId = () => sessionRoots.reduce<string | null>((found, sessions) => found ?? findSessionFile(sessionId, sessions, contract.sessions), null)
  let file = transcriptPath || byId()
  // A missing history still follows the engine's existing resume/fresh fallback.
  if (!file) return null
  let before: ReturnType<typeof lstatSync>
  try { before = lstatSync(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // The registry may still point at a history that was moved; the engine resolves the session by id.
    file = byId()
    if (!file) return null
    before = lstatSync(file)
  }
  const real = realpathSync(file)
  const inside = sessionRoots.some((sessions) => {
    let root: string
    try { root = realpathSync(sessions) } catch { return false }
    return staysInside(relative(root, real))
  })
  if (!before.isFile() || before.isSymbolicLink() || !inside
    || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new ResumePreparationError('not_owned_file', `${contract.names.record} is outside the session profile or is not an owned regular file`)
  }
  return { file, before }
}

/** A stage is private worker output. Only the legacy inline caller omits it and publishes here. */
export async function repairHistory(contract: ResumeRepairContract, sessionId: string, transcriptPath: string | null | undefined, sessionRoots: readonly string[],
  current: () => boolean, limits: RepairLimits = REPAIR_LIMITS, stage?: { directory: string; original: RepairFile }): Promise<HistoryRepair | RepairPrepared> {
  const located = locateRepairHistory(contract, sessionId, transcriptPath, sessionRoots)
  if (!located) return { repairedItems: 0 }
  const { file, before } = located
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
      if (stage && !sameRepairFile(stage.original, repairFile(fstatSync(input, { bigint: true })))) throw changedDuring(contract)
    }
    unchanged()
    const inspected = await scanHistory(contract, input, before.size, sessionId, limits, step)
    unchanged()
    if (inspected.partialTail) console.log(`[resume] ${contract.names.record} ended in a partial line; kept as is`)
    if (!inspected.repairedItems) return { repairedItems: 0 }

    const suffix = randomUUID()
    const backupPath = stage ? join(stage.directory, 'backup') : `${file}${contract.backup}${suffix}`
    const temporary = stage ? join(stage.directory, 'history') : `${file}${contract.temporary}${suffix}`
    let backup: number | undefined
    let output: number | undefined
    let verifiedBackup = false
    let staged = false
    let createdOutput = false
    try {
      backup = openSync(backupPath, 'wx', 0o600)
      output = openSync(temporary, 'wx', 0o600)
      createdOutput = true
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
      if (stage) {
        // Windows finalizes a write's change time on close. Facts cross the process boundary only afterwards.
        closeSync(output); output = undefined
        closeSync(backup); backup = undefined
        const answer: RepairPrepared = { repairedItems: copied.repairedItems, repairedBytes: copied.repairedBytes,
          directoryKey: repairFile(lstatSync(stage.directory, { bigint: true })).key,
          backup: repairFile(lstatSync(backupPath, { bigint: true })), history: repairFile(lstatSync(temporary, { bigint: true })) }
        staged = true
        return answer
      }
      verifiedBackup = true
      renameSync(temporary, file)
      return { repairedItems: copied.repairedItems, repairedBytes: copied.repairedBytes, backupPath }
    } finally {
      if (output !== undefined) closeSync(output)
      if (createdOutput && !staged) rmSync(temporary, { force: true })
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
