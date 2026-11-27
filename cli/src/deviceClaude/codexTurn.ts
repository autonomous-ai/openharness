/**
 * A Codex turn's own setting, read from the session's rollout: who reviews its permission asks and its collaboration
 * mode. No field of a hook's input says whether a dialog follows, and Codex runs the hook before its automatic review, so
 * `harness device codex asked` reads these to post only when the person is asked. Codex 0.172.0 writes the turn's
 * `turn_context` line at the turn's first step, before its hooks run, and again after a compaction. The hook runs in the
 * background, so it can read the rollout after the turn ended: an end event of the turn's after its last `turn_context`
 * line reads as not found, as nothing waits on the person then.
 *
 * The path comes from the hook's input, so only a regular file inside the session's Codex home is read, at most
 * CODEX_REVIEWER_READ_BYTES back from its end, and of it two fields alone leave this file. Every failure reads as not
 * found, silently: a rollout not read rings nothing.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

/** The spike found the line 4 to 10 KB from the end in short turns and 3.16 MB after 40 commands with large output. */
export const CODEX_REVIEWER_READ_BYTES = 16 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const NEWLINE = 0x0a
/** Only a line holding one of these is parsed. Inside a JSON string their quotes are escaped, so a tool's output never
 *  holds one. */
const MARKER = '"type":"turn_context"'
/** The `event_msg` payloads Codex 0.172.0 writes at a turn's end: TurnComplete (`task_complete`, alias `turn_complete`)
 *  and TurnAborted, persisted by rollout/src/policy.rs. */
const END_TYPES: ReadonlySet<unknown> = new Set(['task_complete', 'turn_complete', 'turn_aborted'])
const END_MARKERS = [...END_TYPES].map((type) => `"type":"${type}"`)
const ENDED = 'ended'

export interface TurnSetting {
  /** `approvals_reviewer`: `user` or `auto_review` in Codex 0.172.0. */
  reviewer: string | null
  /** `collaboration_mode.mode`: `default` or `plan`. */
  mode: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const textOf = (value: unknown): string | null => typeof value === 'string' ? value : null

/** The line's two fields when it is [turnId]'s `turn_context` record, ENDED when it is the event of [turnId]'s end,
 *  else null. */
function settingOf(line: Buffer, turnId: string): TurnSetting | typeof ENDED | null {
  if (!line.includes(MARKER) && !END_MARKERS.some((marker) => line.includes(marker))) return null
  let record: unknown
  try {
    record = JSON.parse(line.toString('utf8'))
  } catch {
    // A line Codex is still writing, or not a record.
    return null
  }
  if (!isRecord(record)) return null
  const { payload } = record
  // An abort Codex writes with no turn_id is no turn's in particular.
  if (!isRecord(payload) || payload.turn_id !== turnId) return null
  if (record.type === 'event_msg') return END_TYPES.has(payload.type) ? ENDED : null
  if (record.type !== 'turn_context') return null
  const mode = isRecord(payload.collaboration_mode) ? payload.collaboration_mode.mode : undefined
  return { reviewer: textOf(payload.approvals_reviewer), mode: textOf(mode) }
}

/** The rollout opened read-only with its size, when [path] names a regular file inside [home]; else null. */
function openRollout(path: string, home: string): { fd: number; size: number } | null {
  // Codex names the rollout by its absolute path; a relative one would be read from wherever the hook happens to run.
  if (!isAbsolute(path)) return null
  let named: Stats, real: string
  try {
    named = lstatSync(path)
    // A link, a folder or a FIFO is never opened.
    if (!named.isFile()) return null
    // The native form on both sides: it spells a Windows 8.3 short name or a subst drive as the long, real path.
    real = realpathSync.native(path)
    const inHome = relative(realpathSync.native(home), real)
    if (inHome === '' || inHome.startsWith('..') || isAbsolute(inHome)) return null
  } catch {
    return null
  }
  let fd: number
  try {
    // Windows defines neither flag: there the open is a plain read-only one, after the same lstat.
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return null
  }
  try {
    // What was opened is checked again: the name can have been swapped since its lstat.
    const opened = fstatSync(fd)
    if (opened.isFile() && opened.dev === named.dev && opened.ino === named.ino) return { fd, size: opened.size }
  } catch {
    // Read as not found, below.
  }
  closeSync(fd)
  return null
}

/** Fills [buffer] from [position]; false when the file ends first (it shrank under the read). */
function readFully(fd: number, buffer: Buffer, position: number): boolean {
  for (let filled = 0; filled < buffer.length;) {
    const read = readSync(fd, buffer, filled, buffer.length - filled, position + filled)
    if (!read) return false
    filled += read
  }
  return true
}

/** The setting of the last `turn_context` line for [turnId] that starts within the bound, read backwards from the end,
 *  or ENDED when the turn's end comes after it. */
function lastSetting(fd: number, size: number, turnId: string): TurnSetting | typeof ENDED | null {
  // One byte before the bound is read too: its newline tells a line that starts exactly at the bound from part of one.
  const floor = Math.max(0, size - CODEX_REVIEWER_READ_BYTES - 1)
  // The pieces of the line that runs on past the chunk in hand, in the file's order.
  let after: Buffer[] = []
  for (let end = size; end > floor;) {
    const start = Math.max(floor, end - CHUNK_BYTES)
    const chunk = Buffer.allocUnsafe(end - start)
    if (!readFully(fd, chunk, start)) return null
    let lineEnd = chunk.length
    for (let at = chunk.lastIndexOf(NEWLINE); at !== -1; at = at > 0 ? chunk.lastIndexOf(NEWLINE, at - 1) : -1) {
      const head = chunk.subarray(at + 1, lineEnd)
      const setting = settingOf(after.length ? Buffer.concat([head, ...after]) : head, turnId)
      if (setting) return setting
      after = []
      lineEnd = at
    }
    after.unshift(chunk.subarray(0, lineEnd))
    end = start
  }
  // What is left is a whole line only when it starts the file; past the bound, it is part of one.
  return floor === 0 ? settingOf(Buffer.concat(after), turnId) : null
}

/** [turnId]'s setting in the rollout at [transcriptPath], a file of [codexHome]'s; null when it is not found within the
 *  bound, the turn has ended or the file may not be read. Never throws. */
export function readTurnSetting(transcriptPath: string, turnId: string, codexHome: string): TurnSetting | null {
  const rollout = openRollout(transcriptPath, codexHome)
  if (!rollout) return null
  try {
    const setting = lastSetting(rollout.fd, rollout.size, turnId)
    return setting === ENDED ? null : setting
  } catch {
    return null
  } finally {
    closeSync(rollout.fd)
  }
}
