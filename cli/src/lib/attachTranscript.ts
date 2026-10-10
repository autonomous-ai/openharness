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
 * So the file is walked backward to where the last turn's work began, and further only for the few
 * older records that turn still depends on, then streamed forward from there one record at a time.
 * Resuming the conversation itself stays the engine's job: nothing here loads history to show it.
 *
 * Why folding from there is the whole-history fold: a turn's beginning resets the normalizer's
 * turn-scoped state (for Codex the task's beginning, which also covers messages sent mid-task), so the
 * fold from it ends where the fold from byte 0 does. What outlives a turn is reached for explicitly
 * and bounded (`ATTACH_REACH_BYTES`): the runtime profile (`profileFrom`, `head`), the goal a
 * continuing Codex `/goal` is labelled against, and the earlier Claude tool calls whose results land
 * in the turn — already, or live, for a call still running when it opened (`seeds`). By design, and pinned by the tests:
 *  - thinking-block ids carry the window's start offset (`start`), so no two folds of one session can
 *    send the same id, and re-folding the same turn names each block as it was named before;
 *  - Codex remembers the last `/goal` objective across ordinary turns. Only a goal opener looks back for
 *    it, so when the open turn is an ordinary one, the next goal turn reads `/goal x` rather than
 *    `Continuing goal: x`. Finding it would mean reading back to BOF on every Codex attach;
 *  - a forked Codex rollout reports its own CLI version, from its first record, where the whole fold
 *    ended on the copied parent's `session_meta`.
 */
import { stat } from 'node:fs/promises'
import { scanRecordsBackward, streamRecords } from './transcriptTail.js'
import type { RuntimeField } from './runtimeProfile.js'
import { closeFileIdentity, replayCloses, type TranscriptClose } from './transcriptControls.js'

export interface AttachRules {
  /** The record the engine's fold opens a turn on, judged from the record alone. */
  startsTurn(line: string): boolean
  /** Byte strings every turn opener contains: a record with none of them is not decoded to ask. */
  turnMarkers: readonly Buffer[]
  /** Where a turn's work begins when that is before its opener (Codex `task_started`), and where the
   *  previous turn's ended, past which none is looked for. */
  turnBegin?: { begins(line: string): boolean; ends(line: string): boolean; markers: readonly Buffer[] }
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
  /** Ids a record defines and earlier ids it refers to (a Claude tool call and its result). */
  links?(line: string): { defines: readonly string[]; references: readonly string[] }
  /** Byte strings every record with links contains. */
  linkMarkers?: readonly Buffer[]
}

export interface AttachSpan {
  /** The file length the walk started from. Anything after it is the tail's to read. */
  end: number
  /** Where the last turn's work begins: the fold and the device observer start here. */
  turnFrom: number
  /** Where the runtime profile's replay starts — at or before `turnFrom`. */
  profileFrom: number
  /** The file's first record, for the profile when it lies before `profileFrom` (Codex `session_meta`). */
  head: string | null
  /** Older records the fold needs before the turn, oldest first. */
  seeds: string[]
}

export interface AttachConsumers {
  /** Called once the span is known, before anything is fed. */
  start?(span: AttachSpan): void
  /** The runtime profile — the head, then every record from `profileFrom`. */
  profile(line: string): void
  /** The turn fold — the seeds, then every record from `turnFrom`. */
  fold(line: string): void
  close?(reason: TranscriptClose['reason']): void
  /** The device's transcript observer — every record from `turnFrom`. */
  observe?(line: string): void
}

export interface AttachRead {
  /** Where the transcript's tail picks up: just past the last whole record replayed. */
  next: number
  /** Records replayed from `turnFrom` on. */
  records: number
  /** The file held something past `profileFrom` — a whole record, or one still being written. */
  content: boolean
}

/** What attaching read: the span, the replay, and whether the file could be read through at all. */
export interface AttachResult extends AttachSpan, AttachRead {
  /** The file could not be read through, so the fold holds less than the history: a reset should keep
   *  the normalizer it meant to replace, which has seen every record. */
  failed: boolean
}

/** The first record is only ever wanted for its metadata (Codex `session_meta`, a few KB). */
export const HEAD_RECORD_LIMIT = 4 * 1024 * 1024

/** How far before a turn the walk reaches for what the turn depends on. Those records sit just before
 *  it in practice (Codex's `turn_context` is two records back); this only caps the rare session where
 *  one was never written, which would otherwise be read back to BOF on every attach. */
export const ATTACH_REACH_BYTES = 64 * 1024 * 1024

const hasAny = (bytes: Buffer, markers: readonly Buffer[] | undefined): boolean =>
  !markers || markers.some((marker) => bytes.includes(marker))

/** A record with no line ending yet is whole only if it parses; half a record belongs to the tail. */
export function isWholeRecord(line: string): boolean {
  try { JSON.parse(line); return true } catch { return false }
}

const wholeFile = (end: number): AttachSpan => ({ end, turnFrom: 0, profileFrom: 0, head: null, seeds: [] })

export interface LocateOptions {
  /** A transcript that IS its first turn (born after its agent) is replayed whole. */
  fromStart?: boolean
  /** Read only up to here — where a tail that is being taken over stopped. Defaults to the file size. */
  end?: number
  /** See `ATTACH_REACH_BYTES`. */
  reach?: number
  closes?: readonly TranscriptClose[]
}

/** Walk back from the end to everything an attach needs. Null when the file shrank under the walk. */
export async function locateAttachSpan(filePath: string, rules: AttachRules, options: LocateOptions = {}): Promise<AttachSpan | null> {
  const { size } = await stat(filePath)
  const end = Math.min(options.end ?? size, options.closes?.[0]?.offset ?? size, size)
  const reach = options.reach ?? ATTACH_REACH_BYTES
  if (options.fromStart || end === 0) return wholeFile(end)
  let opener: number | null = null
  let begin: number | null = null
  let seekingBegin = !!rules.turnBegin
  let profileFrom = end
  let seedTest: ((line: string) => boolean) | null = null
  const seeds: Array<{ offset: number; line: string }> = []
  const missing = new Set(rules.required)
  // Calls the turn's results answer that it does not make itself.
  const unresolved = new Set<string>()
  // Every call answered after the point reached: a call before the turn without an answer is still
  // running, and its result will arrive live, naming it.
  const answered = new Set<string>()
  let seekingCalls = false
  const whole = await scanRecordsBackward(filePath, end, (bytes, offset) => {
    let decoded: string | null = null
    const line = (): string => (decoded ??= bytes.toString('utf8'))
    // Past the reach: what is still sought was not written near enough to matter.
    if (opener !== null && opener - offset > reach) return true
    if (opener === null) {
      // Inside the turn: note the earlier calls its results answer, and the ones it makes itself.
      if (rules.links && hasAny(bytes, rules.linkMarkers)) {
        const { defines, references } = rules.links(line())
        for (const id of defines) unresolved.delete(id)
        // A result with no id cannot be matched to any call; it is not worth a walk.
        for (const id of references) if (id) { unresolved.add(id); answered.add(id) }
      }
      if (hasAny(bytes, rules.turnMarkers) && rules.startsTurn(line())) {
        opener = offset
        seedTest = rules.seedFor?.(line()) ?? null
        // A call still running when the turn opened is in the turn before it.
        seekingCalls = !!rules.links
      }
    } else {
      if (seekingBegin && hasAny(bytes, rules.turnBegin!.markers)) {
        if (rules.turnBegin!.begins(line())) { begin = offset; seekingBegin = false }
        else if (rules.turnBegin!.ends(line())) seekingBegin = false
      }
      if (seedTest && hasAny(bytes, rules.seedMarkers) && seedTest(line())) {
        seeds.push({ offset, line: line() })
        seedTest = null
      }
      const previousOpener = seekingCalls && hasAny(bytes, rules.turnMarkers) && rules.startsTurn(line())
      if ((seekingCalls || unresolved.size) && hasAny(bytes, rules.linkMarkers)) {
        const { defines, references } = rules.links!(line())
        const wanted = defines.filter((id) => unresolved.has(id) || (seekingCalls && !!id && !answered.has(id)))
        if (wanted.length) {
          for (const id of wanted) unresolved.delete(id)
          seeds.push({ offset, line: line() })
        }
        for (const id of references) if (id) answered.add(id)
      }
      if (previousOpener) seekingCalls = false
    }
    if (missing.size && hasAny(bytes, rules.fieldMarkers)) {
      const set = rules.fields(line())
      if (set.some((field) => missing.has(field))) {
        for (const field of set) missing.delete(field)
        profileFrom = offset
      }
    }
    return opener !== null && !seekingBegin && !missing.size && !seedTest && !unresolved.size && !seekingCalls
  }, undefined, undefined, closeFileIdentity(options.closes))
  if (!whole) return null
  // No opener anywhere: the whole file is the turn, as the whole-history fold would have it.
  const turnFrom = begin ?? opener ?? 0
  const from = Math.min(profileFrom, turnFrom)
  let head: string | null = null
  if (from > 0) {
    await streamRecords(filePath, 0, Math.min(end, HEAD_RECORD_LIMIT), (record) => {
      head = record
      return true
    }, isWholeRecord, undefined, closeFileIdentity(options.closes))
  }
  return {
    end,
    turnFrom,
    profileFrom: from,
    head,
    // A record found while reaching back that the fold reads anyway is not fed twice.
    seeds: seeds.filter((seed) => seed.offset < turnFrom).sort((a, b) => a.offset - b.offset).map((seed) => seed.line),
  }
}

/**
 * Feed the span to its consumers, one record at a time. If the file shrank meanwhile, what it still
 * held was replayed and the tail picks up at the span's end. A consumer that throws on a record loses
 * that record, as a live line it threw on would be lost, and the replay goes on: stopping would leave
 * the tail nowhere exact to start.
 */
export async function replayAttachSpan(
  filePath: string,
  span: AttachSpan,
  consumers: AttachConsumers,
  closes: readonly TranscriptClose[] = [],
): Promise<AttachRead> {
  let failures = 0
  let firstFailure: unknown = null
  const feed = (consume: (line: string) => void, line: string): void => {
    try { consume(line) } catch (error) { if (failures++ === 0) firstFailure = error }
  }
  const { profile, fold, observe } = consumers
  const closeThrough = replayCloses(closes, reason => consumers.close!(reason))
  consumers.start?.(span)
  if (span.head !== null) feed(profile, span.head)
  for (const seed of span.seeds) feed(fold, seed)
  let records = 0
  const read = await streamRecords(filePath, span.profileFrom, span.end, (line, offset) => {
    closeThrough(offset)
    feed(profile, line)
    if (offset < span.turnFrom) return
    records++
    if (observe) feed(observe, line)
    feed(fold, line)
  }, isWholeRecord, undefined, closeFileIdentity(closes))
  if (!read && closes.length) throw new Error('ENGINE_CONTROL_BOUNDARY_CHANGED')
  if (read) closeThrough(read.next)
  if (failures) console.warn(`[attach] ${filePath}: ${failures} record(s) could not be taken in: ${String(firstFailure)}`)
  return { next: read?.next ?? span.end, records, content: records > 0 || !!read?.partial }
}

/** How far a file reaches, up to `end`; 0 for one that is not there. */
async function reach(filePath: string, end: number | undefined): Promise<number> {
  try {
    const { size } = await stat(filePath)
    return end === undefined ? size : Math.min(end, size)
  } catch { return 0 }
}

/**
 * Locate, then replay. A file that shrank under the walk is walked once more and then replayed whole.
 * One that is not there — moved, archived or deleted since it was announced — is an empty history, as
 * it always was. A file that cannot be read through (`failed`) leaves the history unread, not
 * unwritten: the tail resumes where the read was meant to end — never at byte 0, from where it would
 * deliver old turns as new ones, and not at a later end, past a record written while it read. A record
 * the engine was still writing right there, if the read failed before reaching it, is lost to both.
 */
export async function attachTranscript(
  filePath: string,
  rules: AttachRules,
  consumers: AttachConsumers,
  options: Omit<LocateOptions, 'reach'> = {},
): Promise<AttachResult> {
  let span: AttachSpan | null = null
  try {
    span = await locateAttachSpan(filePath, rules, options)
      ?? await locateAttachSpan(filePath, rules, options)
      ?? wholeFile(Math.min(options.end ?? Infinity, (await stat(filePath)).size))
    if (options.closes?.length) span.end = Math.min(options.end ?? Infinity, (await stat(filePath)).size)
    return { ...span, ...await replayAttachSpan(filePath, span, consumers, options.closes), failed: false }
  } catch (error) {
    console.warn(`[attach] ${filePath} could not be read: ${String(error)}`)
    const end = span ? span.end : await reach(filePath, options.end)
    return { ...(span ?? wholeFile(end)), next: end, records: 0, content: end > 0, failed: true }
  }
}
