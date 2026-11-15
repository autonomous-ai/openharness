/**
 * The other engines' live streams on their worker's link: the private requests the core makes of `engine-others`
 * (engines/others/streamRequests.ts) and what it checks of every answer (core/engines/otherStreams.ts). Only the core's
 * own call reaches them: they are no client's route.
 *
 * A stream is one session's live conversation, the worker's to read: its transcript's tail, or its store's poll,
 * through its engine's own parser (docs/design/2026-11-15-core-plan/engines.md, "Design S"). The worker hands the core
 * what each record made, frame by frame, numbered: the events, a failure to announce, what it says of the profile, and
 * the turn it left. The core holds one wait for all of them at a time, and acknowledges what it took with the next.
 */
import type { LiveEvent } from '../kit/events.js'
import type { ProfileEvidence } from '../facets/runtime.js'
import { liveEvent, liveStamp, type LiveStamp } from './liveProtocol.js'
import { record } from './protocol.js'

export const STREAM_VERSION = 1
export const STREAM_OPEN = 'engine_stream_open'
export const STREAM_STORE = 'engine_stream_store'
export const STREAM_OP = 'engine_stream_op'
export const STREAMS_WAIT = 'engine_streams_wait'
/** How long the worker holds a wait with nothing to say: the core's whole cost at rest is one request this often. */
export const STREAMS_WAIT_MS = 25_000
/** An open folds up to 64 MB of a transcript, or a whole conversation of a store, as an attach in the core used to. */
export const STREAM_OPEN_WAIT_MS = 30_000
/** An op works in memory, or reads once what is new. */
export const STREAM_OP_WAIT_MS = 5_000
/** The frames one answer carries at most: the rest go with the next. One frame past it goes alone, in parts. */
export const STREAM_ANSWER_BYTES = 3 * 1024 * 1024
/** What a stream keeps unacknowledged before it gives up on the core taking it: the core opens it again. */
export const STREAM_KEPT_BYTES = 32 * 1024 * 1024
/** The profile evidence a fold hands over, its newest at most: what a long history ends on is what the chips show. */
export const STREAM_EVIDENCE = 256
/** The streams a worker holds at most, every agent of theirs on the machine. */
export const STREAMS_MAX = 512
/** Collection bounds apply even to replies reassembled from parts. */
export const STREAM_FRAMES_MAX = 65_536
export const STREAM_EVENTS_MAX = 65_536

export type StreamOp = 'close' | 'abort' | 'cancel' | 'open' | 'drain' | 'tail' | 'task' | 'pane' | 'release' | 'forget'

/** A stream's turn as the worker last left it: the identity changes with every turn's start and end. */
export interface StreamTurn { identity: string; turnOpen: boolean }

/** What one record, or one batch of them, made. */
export interface StreamFrame {
  serial: number
  events: LiveEvent[]
  /** A batch of records already on disk when the tail read them: history, a turn still open at its end included. */
  replay?: true
  /** Announced before the events, which may end the turn. */
  failure?: string
  /** The failure in the device's words, when the engine has some. */
  failureSummary?: string
  evidence?: ProfileEvidence[]
  /** What the agent says while its store cannot be read (OpenClaw's named states); null clears the stream's own. */
  hold?: string | null
  /** The transcript was rewritten in place with too much history to replay: its session is attached again. */
  rewritten?: true
  /** Where the transcript's next record starts, once this frame is taken: a stream opened again resumes there. */
  offset?: number
  stamp?: LiveStamp | null
  turn: StreamTurn
}

/** What a stream's open folded, and what it made while it opened (a store's hydration). */
export interface StreamOpened {
  turn: StreamTurn
  /** The fold ended in a turn left open (before an abandoned one was closed). */
  historyTurnOpen: boolean
  /** The fold's last turn start: the one event an attach replays of its history, for a turn still open. */
  lastStarted: LiveEvent | null
  /** Whether the fold's last turn boundary is an end, and whether that end was an abort: a turn over before the attach. */
  lastEnded: { aborted: boolean } | null
  /** The fold, when it was the conversation's live first turn rather than its history. */
  initial: LiveEvent[]
  lines: number
  evidence: ProfileEvidence[]
  /** The turn the fold left open began before its engine was started again: closed as history. */
  abandoned: boolean
  frames: StreamFrame[]
  /** Its fold cannot know that a turn ended: the core reads the pane (agy's). */
  paneCheck?: true
  offset?: number
  stamp?: LiveStamp | null
}

const text = (value: unknown, max = 1024 * 1024): value is string => typeof value === 'string' && value.length <= max
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function streamTurn(value: unknown): value is StreamTurn {
  return record(value) && text(value.identity, 512) && typeof value.turnOpen === 'boolean'
}

export function profileEvidence(value: unknown): value is ProfileEvidence {
  if (!record(value)) return false
  const short = (v: unknown) => v === undefined || text(v, 512)
  return Object.keys(value).every(key => ['cliVersion', 'model', 'effort', 'effortUnset', 'confirms', 'refresh', 'workspace'].includes(key))
    && short(value.cliVersion) && short(value.model) && short(value.effort) && short(value.effortUnset)
    && (value.confirms === undefined || value.confirms === true) && (value.refresh === undefined || value.refresh === true)
    && (value.workspace === undefined || value.workspace === null || text(value.workspace, 4096))
}

const evidenceList = (value: unknown, max: number): boolean => Array.isArray(value) && value.length <= max && value.every(profileEvidence)

export function streamEvents(value: unknown): value is LiveEvent[] {
  return Array.isArray(value) && value.length <= STREAM_EVENTS_MAX && value.every(liveEvent)
}

export function streamFrame(value: unknown): value is StreamFrame {
  return record(value) && count(value.serial) && value.serial > 0 && streamEvents(value.events)
    && (value.replay === undefined || value.replay === true)
    && (value.failure === undefined || text(value.failure, 4096)) && (value.failureSummary === undefined || text(value.failureSummary, 4096))
    && (value.evidence === undefined || evidenceList(value.evidence, STREAM_EVIDENCE))
    && (value.hold === undefined || value.hold === null || text(value.hold, 512))
    && (value.rewritten === undefined || value.rewritten === true)
    && (value.offset === undefined || count(value.offset)) && (value.stamp === undefined || liveStamp(value.stamp)) && streamTurn(value.turn)
}

export function streamOpened(value: unknown): value is StreamOpened {
  return record(value) && streamTurn(value.turn) && typeof value.historyTurnOpen === 'boolean'
    && (value.lastStarted === null || (liveEvent(value.lastStarted) && value.lastStarted.type === 'turn_started'))
    && (value.lastEnded === null || (record(value.lastEnded) && typeof value.lastEnded.aborted === 'boolean'))
    && streamEvents(value.initial) && count(value.lines)
    && evidenceList(value.evidence, STREAM_EVIDENCE) && typeof value.abandoned === 'boolean'
    && Array.isArray(value.frames) && value.frames.length <= STREAM_FRAMES_MAX && value.frames.every(streamFrame)
    && (value.paneCheck === undefined || value.paneCheck === true) && (value.offset === undefined || count(value.offset)) && (value.stamp === undefined || liveStamp(value.stamp))
}

/** Count decoded bytes before traversing event payloads, including fields their schemas do not use. */
export function boundedStreamReply(value: unknown, limit = 64 * 1024 * 1024): boolean {
  let bytes = 0, nodes = 0
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 1_000_000 || depth > 32) return false
    if (typeof item === 'string') bytes += Buffer.byteLength(item)
    else if (item !== null && typeof item === 'object') {
      const entries = Object.entries(item)
      if (entries.length > STREAM_FRAMES_MAX) return false
      for (const [key, child] of entries) {
        bytes += Buffer.byteLength(key) + 4
        if (bytes > limit || !visit(child, depth + 1)) return false
      }
    } else bytes += 8
    return bytes <= limit
  }
  return visit(value, 0)
}
