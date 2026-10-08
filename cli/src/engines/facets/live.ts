import type { AttachRules } from '../../lib/attachTranscript.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeField } from '../../lib/runtimeProfile.js'
import type { LiveEvent } from '../kit/events.js'

/** A value, not an engine's mutable parser state. Identity changes with both parser and turn. */
export interface LiveTurn {
  readonly identity: string
  readonly turnOpen: boolean
  readonly continued: boolean
}

export interface LiveRead {
  events: LiveEvent[]
  /** Announced before this record's events, which may include its turn end. */
  failure?: string
}

/** Stateful interpretation owned by an engine. Core never edits a parser's fields. */
export interface LiveParser {
  /** The binding this parser interprets. A session id reused by another engine needs a fresh parser. */
  readonly engine: string
  readonly turnOpen: boolean
  ingest(line: string): LiveRead
  snapshot(): LiveTurn
  closeTurn(reason: 'cancel' | 'abandoned' | 'hook'): void
  windowStart(offset: number): void
}

export interface EngineLive {
  create(session: Pick<RegisteredSession, 'engine' | 'codexHome'>): LiveParser
  /** Absent for the legacy fallback that folds its whole, bounded file. */
  attachRules?(fields: (line: string) => readonly RuntimeField[]): AttachRules
}

export type LiveFor = (engine: string) => EngineLive | undefined
