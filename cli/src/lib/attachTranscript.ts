/**
 * What a Claude Code or Codex transcript says about where its session stands, read from the END.
 *
 * Attaching to a session — the daemon starting, a pane opening, a reset — asks the transcript three
 * things: is a turn open and what was its prompt (the Working state, the recap and alert its end will
 * bring, the question watcher), which model, effort and mode the chips show, and, while a device
 * delivery is pending, the records that prove it landed. Every answer sits at the end of the file.
 * Reading the whole history for them cost memory in proportion to the conversation: on 2026-10-03 an
 * 803 MB Codex rollout held 1.9 GB of heap on its own, and the daemon died at its 4 GB limit seconds
 * after every start.
 *
 * So the file is walked backward to the last turn opener — further only as far as the newest record
 * that set each runtime field, and for a continuing `/goal` the goal before it — and then streamed
 * forward from there, one record at a time. Resuming the conversation itself stays the engine's job:
 * nothing here loads history to show it.
 *
 * Why folding from the opener is the whole-history fold: an opener resets every turn-scoped piece of
 * the normalizer's state, so the fold from it ends where the fold from byte 0 does. What is not
 * turn-scoped is handled explicitly — the runtime profile (`profileFrom`, `head`) and Codex's goal
 * objective (`seed`). Reaching back for those is bounded (`ATTACH_REACH_BYTES`), so no attach reads a
 * whole file for them. What still differs, by design, and is pinned by the tests:
 *  - the running count behind thinking-block ids restarts at the opener: ids stay unique within the
 *    turn and stable across re-attaches to it;
 *  - Codex remembers the last `/goal` objective across ordinary turns. Only a goal opener looks back for
 *    it, so when the open turn is an ordinary one, the next goal turn reads `/goal x` rather than
 *    `Continuing goal: x`. Finding it would mean reading back to BOF on every Codex attach.
 */
import { stat } from 'node:fs/promises'
import { codexGoalOf, startsCodexTurn } from '../engines/codex/normalizer.js'
import { startsClaudeTurn } from './normalize.js'
import { scanRecordsBackward, streamRecords } from './transcriptTail.js'
import type { RuntimeField } from './runtimeProfile.js'

export interface AttachRules {
  /** The record the engine's fold opens a turn on, judged from the record alone. */
  startsTurn(line: string): boolean
  /** Byte strings every turn opener contains: a record with none of them is not decoded to ask. */
  turnMarkers: readonly Buffer[]
  /** The runtime fields one record sets (`RuntimeProfileManager.transcriptFields`). */
  fields(line: string): readonly RuntimeField[]
  /** Byte strings every field-setting record contains; absent means every record is asked. */
  fieldMarkers?: readonly Buffer[]
  /** The fields the transcript is read for. */
  required: readonly RuntimeField[]
  /** For an opener whose meaning depends on an older record, the test for that record (Codex `/goal`). */
  seedFor?(opener: string): ((line: string) => boolean) | null
  /** Byte strings every seed record contains. */
  seedMarkers?: readonly Buffer[]
}

export interface AttachSpan {
  /** The file length the walk started from. Anything after it is the tail's to read. */
  end: number
  /** Where the last turn opens: the fold and the device start here. */
  turnFrom: number
  /** Where the runtime profile's replay starts — at or before `turnFrom`. */
  profileFrom: number
  /** The file's first record, for the profile when it lies before `profileFrom` (Codex `session_meta`). */
  head: string | null
  /** The older record the opener's meaning depends on, folded before it (Codex `/goal`). */
  seed: string | null
}

export interface AttachConsumers {
  /** The runtime profile — every record from `profileFrom`, the head first. */
  profile(line: string): void
  /** The turn fold — the seed, then every record from `turnFrom`. */
  fold(line: string): void
  /** The device's transcript observer — every record from `turnFrom`. */
  observe?(line: string): void
}

/** The first record is only ever wanted for its metadata (Codex `session_meta`, a few KB). */
export const HEAD_RECORD_LIMIT = 4 * 1024 * 1024

/** How far before the opener the walk looks for a runtime field or a seed. Both sit just before it in
 *  practice (Codex's `turn_context` is two records back); this only caps the rare session where one
 *  was never written, which would otherwise be read back to BOF on every attach. */
export const ATTACH_REACH_BYTES = 64 * 1024 * 1024

const hasAny = (bytes: Buffer, markers: readonly Buffer[] | undefined): boolean =>
  !markers || markers.some((marker) => bytes.includes(marker))

/** A record with no line ending yet is whole only if it parses; half a record belongs to the tail. */
export function isWholeRecord(line: string): boolean {
  try { JSON.parse(line); return true } catch { return false }
}

const wholeFile = (end: number): AttachSpan => ({ end, turnFrom: 0, profileFrom: 0, head: null, seed: null })

/**
 * Walk back from the end to everything an attach needs. `fromStart` is for a transcript that IS its
 * first turn (born after its agent), which is replayed whole. Null when the file shrank under the walk.
 */
export async function locateAttachSpan(
  filePath: string,
  rules: AttachRules,
  fromStart = false,
  reach = ATTACH_REACH_BYTES,
): Promise<AttachSpan | null> {
  const { size: end } = await stat(filePath)
  if (fromStart || end === 0) return wholeFile(end)
  let turnFrom: number | null = null
  let profileFrom = end
  let seed: string | null = null
  let seedTest: ((line: string) => boolean) | null = null
  const missing = new Set(rules.required)
  const whole = await scanRecordsBackward(filePath, end, (bytes, offset) => {
    let decoded: string | null = null
    const line = (): string => (decoded ??= bytes.toString('utf8'))
    if (turnFrom !== null && turnFrom - offset > reach) {
      // Past the reach: what is still missing was not written near enough to matter.
      missing.clear()
      seedTest = null
      return true
    }
    if (turnFrom === null && hasAny(bytes, rules.turnMarkers) && rules.startsTurn(line())) {
      turnFrom = offset
      seedTest = rules.seedFor?.(line()) ?? null
    } else if (seedTest && hasAny(bytes, rules.seedMarkers) && seedTest(line())) {
      seed = line()
      seedTest = null
    }
    if (missing.size && hasAny(bytes, rules.fieldMarkers)) {
      const set = rules.fields(line())
      if (set.some((field) => missing.has(field))) {
        for (const field of set) missing.delete(field)
        profileFrom = offset
      }
    }
    return turnFrom !== null && !missing.size && !seedTest
  })
  if (!whole) return null
  // No opener anywhere: the whole file is the turn, as the whole-history fold would have it.
  const opener = turnFrom ?? 0
  const from = Math.min(profileFrom, opener)
  let head: string | null = null
  if (from > 0) {
    await streamRecords(filePath, 0, Math.min(end, HEAD_RECORD_LIMIT), (line) => {
      head = line
      return true
    }, isWholeRecord)
  }
  return { end, turnFrom: opener, profileFrom: from, head, seed }
}

export interface AttachRead {
  /** Where the transcript's tail picks up: just past the last whole record replayed. */
  next: number
  /** Records replayed from the opener on. */
  records: number
  /** The file held something past `profileFrom` — a whole record, or one still being written. */
  content: boolean
}

/**
 * Feed the span to its consumers, one record at a time. If the file shrank meanwhile, what it still
 * held was replayed and the tail picks up at the span's end.
 */
export async function replayAttachSpan(
  filePath: string,
  span: AttachSpan,
  consumers: AttachConsumers,
): Promise<AttachRead> {
  if (span.head !== null) consumers.profile(span.head)
  if (span.seed !== null) consumers.fold(span.seed)
  let records = 0
  const read = await streamRecords(filePath, span.profileFrom, span.end, (line, offset) => {
    consumers.profile(line)
    if (offset < span.turnFrom) return
    records++
    consumers.observe?.(line)
    consumers.fold(line)
  }, isWholeRecord)
  return { next: read?.next ?? span.end, records, content: records > 0 || !!read?.partial }
}

/** Locate, then replay; a file that shrank under the walk is retried once and then replayed whole. */
export async function attachTranscript(
  filePath: string,
  rules: AttachRules,
  consumers: AttachConsumers,
  fromStart = false,
): Promise<AttachSpan & AttachRead> {
  const span = await locateAttachSpan(filePath, rules, fromStart)
    ?? await locateAttachSpan(filePath, rules, fromStart)
    ?? wholeFile((await stat(filePath)).size)
  return { ...span, ...await replayAttachSpan(filePath, span, consumers) }
}

const bytes = (...markers: string[]): Buffer[] => markers.map((marker) => Buffer.from(marker))

/**
 * Claude Code: a turn opens on a real user prompt, always a `"type":"user"` record. The chips read
 * only the model from the transcript — the attach takes effort from Claude's settings straight after —
 * and `Set model to` is matched case-insensitively, so field records are asked for without a byte test.
 */
export function claudeAttachRules(fields: (line: string) => readonly RuntimeField[]): AttachRules {
  return { startsTurn: startsClaudeTurn, turnMarkers: bytes('"user"'), fields, required: ['model'] }
}

/**
 * Codex: a turn opens on a user message (`user_message`, or `UserMessage` inside `item_completed`) or a
 * `/goal` injection. Model, effort and mode arrive together in `turn_context` and
 * `thread_settings_applied`, written just before the turn's first message. A continuing goal's label
 * depends on the goal before it.
 */
export function codexAttachRules(fields: (line: string) => readonly RuntimeField[]): AttachRules {
  return {
    startsTurn: startsCodexTurn,
    turnMarkers: bytes('user_message', 'UserMessage', 'codex_internal_context'),
    fields,
    fieldMarkers: bytes('turn_context', 'thread_settings_applied'),
    required: ['model', 'effort', 'mode'],
    seedFor: (opener) => (codexGoalOf(opener) === null ? null : (line) => codexGoalOf(line) !== null),
    seedMarkers: bytes('codex_internal_context'),
  }
}
