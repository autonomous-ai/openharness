/**
 * One whole session as turns, for a reader that is not the search index: the agent handoff.
 *
 * The same pipeline the indexer runs (`indexer.ts` `pass` / `historyPass`) — the engine's own line
 * normalizer into a `TurnCollector` — but from the first line to the last, with no store and no resume
 * offsets. So it gets the same cleaning for free: only the person's words as asks, secrets blanked, the
 * agent's text, and one line per tool call; no tool output, no reasoning. Each message's text is bounded
 * before the collector sees it: long whitespace-free runs cut (`omitLongRuns`), then at most its first and
 * last 16 000 characters.
 *
 * The daemon's thread is shared with every terminal it streams, so the read yields to the event loop
 * every few milliseconds, as the indexer does, and stops at a caller's deadline.
 */

import { performance } from 'node:perf_hooks'

import type { LiveEvent } from '../normalize.js'
import { forEachLine, lineNormalizer, lineTime, skipPredicate } from '../transcriptReader.js'
import { TurnCollector, type IndexedTurn } from './turns.js'

export interface TurnSource {
  engine: string
  sessionId: string
  /** The transcript file, for an engine that writes one. */
  transcriptPath: string | null
  /** The whole history, for an engine that keeps it in a database (OpenCode, Kilo, Hermes, Devin). */
  readHistory?: () => Promise<readonly LiveEvent[]>
}

export class SessionTurnsError extends Error {
  constructor(readonly code: 'NO_HISTORY' | 'NO_NORMALIZER' | 'DEADLINE') {
    super(`session turns: ${code}`)
    this.name = 'SessionTurnsError'
  }
}

export interface ReadOptions {
  /** How long to hold the thread between yields (ms). */
  sliceMs?: number
  /** Epoch ms after which the read gives up with `DEADLINE`. */
  deadline?: number
  /** Asked between lines and batches: true gives up with `DEADLINE` (a caller with its own clock). */
  shouldStop?: () => boolean
}

const HISTORY_BATCH = 200

/** The longest whitespace-free run a handoff keeps: anything longer is a blob, never a word or a path. */
export const RUN_CAP = 512
const LONG_RUN = new RegExp(String.raw`(?<!\S)\S{${RUN_CAP + 1},}`, 'g')

/**
 * How a run that ends in a secret's label ends: `password: `, `"api_key":`, `&token=`, `Bearer`. The value comes
 * after a space, in the next run, so dropping the label with its run would free the value from the shared
 * redaction. Bounded: at most 64 characters are looked at, so the match is linear.
 *
 * Its label words must cover those of the shared redaction's patterns (`logBundle.ts:111-113`) and be kept in
 * step with them: a label word added there and missing here is cut off with its run, and its value then leaks.
 */
const LABEL_END = /(?:token|secret|password|passphrase|credential|api[_-]?key|access[_-]?key|auth)\w{0,40}["']?\s*[:=]\s*["']?$|Bearer$/i
const LABEL_WINDOW = 64

/**
 * A whitespace-free run longer than `RUN_CAP` replaced by a count, keeping a short suffix that is a label (above)
 * so the redaction after this still sees label and value. Linear. The shared redaction (`logBundle.ts`) is cubic
 * on a long run of `?key?key…`, so no text reaches it before this has bounded its runs.
 */
export function omitLongRuns(text: string): string {
  if (text.length <= RUN_CAP) return text
  return text.replace(LONG_RUN, (run) => {
    const label = LABEL_END.exec(run.slice(-LABEL_WINDOW))
    return `<${run.length} characters omitted>${label ? label[0] : ''}`
  })
}

/** Most of one event's text a handoff reads: the start and the end (a turn's budgets downstream keep no more). */
const EVENT_HEAD = 16_000
const EVENT_TAIL = 16_000

/** `text` run-capped, then, when still over the event budget, its start and its end around a cut mark with spaces in it. */
function boundedText(text: string): string {
  const capped = omitLongRuns(text)
  if (capped.length <= EVENT_HEAD + EVENT_TAIL) return capped
  let head = EVENT_HEAD
  const last = capped.charCodeAt(head - 1)
  if (last >= 0xd800 && last <= 0xdbff) head -= 1
  let tail = capped.length - EVENT_TAIL
  const first = capped.charCodeAt(tail)
  if (first >= 0xdc00 && first <= 0xdfff) tail += 1
  return `${capped.slice(0, head)}\n… <${tail - head} characters omitted> …\n${capped.slice(tail)}`
}

/** An event with its message text bounded (the text the collector redacts); other events as they are. */
function boundedEvent(event: LiveEvent): LiveEvent {
  switch (event.type) {
    case 'turn_started': return { ...event, payload: { ...event.payload, userMessage: boundedText(event.payload.userMessage) } }
    case 'user_message': return { ...event, payload: { ...event.payload, content: boundedText(event.payload.content) } }
    case 'text_delta': return { ...event, payload: { ...event.payload, content: boundedText(event.payload.content) } }
    default: return event
  }
}

/**
 * Every turn of the session, oldest first: from the transcript file when the engine writes one, else from
 * `readHistory`. Throws `SessionTurnsError` — `DEADLINE` past `deadline` / `shouldStop`, `NO_NORMALIZER` for a
 * file no normalizer reads, `NO_HISTORY` with neither source. Filesystem errors from the transcript propagate.
 */
export async function readSessionTurns(source: TurnSource, options: ReadOptions = {}): Promise<IndexedTurn[]> {
  const { deadline } = options
  const sliceMs = options.sliceMs ?? 12
  let sliceStart = performance.now()
  const pace = async (): Promise<void> => {
    if (performance.now() - sliceStart < sliceMs) return
    await new Promise<void>((resolve) => setImmediate(resolve))
    sliceStart = performance.now()
  }
  let expired = false
  const pastDeadline = (): boolean => {
    if ((deadline !== undefined && Date.now() > deadline) || options.shouldStop?.()) expired = true
    return expired
  }

  const collector = new TurnCollector(0)
  const normalize = source.transcriptPath ? lineNormalizer(source.engine, source.sessionId) : null
  if (source.transcriptPath && normalize) {
    let lastAt: number | null = null
    await forEachLine(source.transcriptPath, 0, async ({ text, offset }) => {
      const at = lineTime(text) ?? lastAt
      if (at !== null && (lastAt === null || at > lastAt)) lastAt = at
      collector.feed(normalize(text).map(boundedEvent), offset, at)
      await pace()
    }, { skip: skipPredicate(source.engine), shouldStop: pastDeadline })
    if (expired) throw new SessionTurnsError('DEADLINE')
  } else if (source.transcriptPath) {
    throw new SessionTurnsError('NO_NORMALIZER')
  } else if (source.readHistory) {
    const events = await source.readHistory()
    for (let at = 0; at < events.length; at += HISTORY_BATCH) {
      if (pastDeadline()) throw new SessionTurnsError('DEADLINE')
      collector.feed(events.slice(at, at + HISTORY_BATCH).map(boundedEvent), 0, null)
      await pace()
    }
    if (pastDeadline()) throw new SessionTurnsError('DEADLINE')
  } else {
    throw new SessionTurnsError('NO_HISTORY')
  }
  const { closed, open } = collector.finish()
  return open ? [...closed, open] : closed
}
