/**
 * Ingest: each transcript line the watcher delivers, through its engine's parser, into the funnel; and each frame the
 * other engines' worker made of theirs (core/engines/otherStreams.ts). Lines arrive live, or as a history batch (a
 * catch-up, emitted as a replay); a transcript rewritten in place with too much history to replay is attached again
 * from its end.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 9: docs/design/2026-10-03-harnessd.md). The other
 * fourteen engines' normalizers left for their worker (docs/design/2026-11-15-core-plan/engines.md, step 1b).
 */
import type { LiveFor, LiveParser, LiveTurn } from '../../engines/facets/live.js'
import { keepsStore } from '../../engines/otherEngines.js'
import { OPENCLAW_STATES } from '../../engines/openclaw/contract.js'
import type { StreamFrame } from '../../engines/worker/otherStreamProtocol.js'
import type { WifiFeed } from '../wifi.js'
import { sid } from '../../lib/log.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import type { HistoryEvent, LineEvent, RewrittenEvent, Watcher } from '../../watcher/watcher.js'
import type { SessionNormalizers } from './normalizers.js'
import { createSideReads } from './sideReads.js'
import type { LiveFrame } from '../../engines/worker/liveProtocol.js'

/** What an OpenClaw store that cannot be read, or holds no session for a pane that is working, says on its agent: the
 *  holds its stream sets, and the only ones it clears. */
const OPENCLAW_STORE_HOLDS = new Set<string>([OPENCLAW_STATES.unsupported, OPENCLAW_STATES.harnessNode, OPENCLAW_STATES.noSessions])

/** What a transcript read says beside its events: the core's turn rules take it (core/turns/turnHooks.ts). */
export interface TranscriptRead { replay?: boolean; resumed?: true; at?: number; over?: true; turn?: LiveTurn }

export interface IngestDeps {
  liveFor: LiveFor
  has: (sessionId: string) => boolean
  bySession: (sessionId: string) => RegisteredSession | undefined
  tokenUsage: { changed(session: RegisteredSession): void }
  /** The Wi-Fi device's service, wherever it runs (core/wifi.ts): it proves its turns by the raw transcript. */
  device: () => Pick<WifiFeed, 'needsTranscript' | 'observeTranscript'> | undefined
  runtimeProfiles: Pick<RuntimeProfileManager, 'ingest' | 'evidence'>
  normalizers: Pick<SessionNormalizers, 'liveParsers'>
  announceTurnAborted: (sessionId: string, engine: string, message: string, deviceMessage?: string) => void
  emit: (sessionId: string, events: LiveEvent[], read?: TranscriptRead) => void
  attachSession: (session: RegisteredSession, reset: boolean) => Promise<boolean>
  /** What the agent says while its engine's store cannot be read (OpenClaw's named states); undefined clears it. */
  setIdentityHold: (agentId: string, reason?: string) => boolean
  announceSession: (session: RegisteredSession) => void
}

export function createIngest({
  liveFor, has, bySession, tokenUsage, device, runtimeProfiles, normalizers, announceTurnAborted, emit, attachSession,
  setIdentityHold, announceSession,
}: IngestDeps) {
  const { liveParsers } = normalizers
  const sideRead = createSideReads()
  // JSONL watcher → normalize each appended line → stream up. ONE lineToEvents pass feeds BOTH
  // audiences: web (send, ServerEvents) and device (mirror.ingest → curated commander_event cards).
  /** One transcript line through its engine's normalizer. The events, not yet emitted — the two
   *  callers below differ only in what they know about the line's age. */
  const observeLine = (evt: Pick<LineEvent, 'sessionId' | 'engine' | 'text'>, profileAccepted = false): RegisteredSession | null => {
    if (!has(evt.sessionId)) return null // scope to terminal-registered sessions
    const session = bySession(evt.sessionId)
    if (!session || session.identityHold || session.interpretationHold || session.engine !== evt.engine) return null
    tokenUsage.changed(session)
    sideRead('device', evt.sessionId, () => {
      const service = device()
      if (service?.needsTranscript(session.agentId, evt.sessionId, session.engine)) {
        service.observeTranscript(session.agentId, evt.sessionId, session.engine, evt.text)
      }
    })
    if (!profileAccepted) sideRead('runtime profile', evt.sessionId, () => runtimeProfiles.ingest(session, evt.text))
    return session
  }
  /** A line's events, and what its parser says beside them (nothing for an engine the core does not parse). */
  const readLine = (evt: LineEvent): { events: LiveEvent[]; read?: TranscriptRead } | null => {
    const session = observeLine(evt)
    if (!session) return null
    const adapter = liveFor(session.engine)
    if (!adapter) return { events: [] }
    let parser = liveParsers.get(evt.sessionId)
    if (!parser || parser.engine !== session.engine || !('ingest' in parser)) { parser = adapter.create(session); liveParsers.set(evt.sessionId, parser) }
    const read = (parser as LiveParser).ingest(evt.text)
    if (read.failure !== undefined) announceTurnAborted(evt.sessionId, session.engine, read.failure)
    return { events: read.events, read: { at: read.at, over: read.over, turn: parser.snapshot() } }
  }
  const ingestLine = (evt: LineEvent): LiveEvent[] | null => readLine(evt)?.events ?? null
  /** Feed what the watcher delivers through `ingestLine` into the funnel. */
  const wireWatcher = (watcher: Pick<Watcher, 'on'>): void => {
    watcher.on('line', (evt: LineEvent) => {
      // This runs from a void-discarded async read, so a throw here would be an unhandledRejection. A
      // single malformed line must never take the daemon down — contain it per line and move on.
      try {
        const line = readLine(evt)
        if (line) emit(evt.sessionId, line.events, line.read)
      } catch (err) {
        console.error(`[cli] line handler error (session ${evt.sessionId}):`, err instanceof Error ? err.message : err)
      }
    })
    // A transcript catch-up is history, including an unfinished last turn.
    // Its content still streams, but only fresh events or live inspection can
    // establish Working; replay cannot create a new completion notification.
    // A transcript rewritten in place with too much history to replay: its tail already starts at the new
    // end, and the session is attached again, from that end, so its turn state is rebuilt from the file.
    watcher.on('rewritten', (event: RewrittenEvent) => {
      const session = bySession(event.sessionId)
      if (!session || session.transcriptPath !== event.transcriptPath) return
      console.log(`[watcher] ${sid(event.sessionId)} transcript rewritten in place — attaching it again from its end`)
      void attachSession(session, true).catch((err) => console.error(`[cli] re-attach after rewrite failed (session ${sid(event.sessionId)}):`, err instanceof Error ? err.message : err))
    })
    watcher.on('history', (batch: HistoryEvent) => {
      try {
        const all: LiveEvent[] = []
        for (const evt of batch.lines) {
          const events = ingestLine(evt)
          if (events) all.push(...events)
        }
        if (!all.length) return
        // Every line in this batch was already on disk. An unclosed last turn
        // is not a fresh prompt; live runtime inspection can establish activity.
        emit(batch.sessionId, all, { replay: true })
      } catch (err) {
        console.error(`[cli] history handler error (session ${batch.sessionId}):`, err instanceof Error ? err.message : err)
      }
    })
  }
  const acceptFrame = (sessionId: string, engine: RegisteredSession['engine'], frame: LiveFrame, profileAccepted = false): void => {
    if (!observeLine({ sessionId, engine, text: frame.raw }, profileAccepted)) return
    if (frame.failure !== undefined) announceTurnAborted(sessionId, engine, frame.failure)
    emit(sessionId, frame.events, { replay: frame.replay, at: frame.at, over: frame.over, turn: frame.turn })
  }
  /**
   * A frame the other engines' worker made of one of their sessions: a file engine's taken as each of its lines was
   * (only while the session is bound to it and not held), a database engine's as its reader's events were.
   */
  const acceptStreamFrame = (session: RegisteredSession, frame: StreamFrame): void => {
    const latest = bySession(session.sessionId)
    if (!latest || latest.engine !== session.engine) return
    if (!keepsStore(session.engine)) {
      if (!has(session.sessionId) || latest.identityHold || latest.interpretationHold) return
      tokenUsage.changed(latest)
    }
    if (frame.hold !== undefined) {
      // A hold another reason set is that reason's to clear.
      const hold = frame.hold ?? undefined
      if (latest.identityHold ? OPENCLAW_STORE_HOLDS.has(latest.identityHold) : hold !== undefined) {
        if (setIdentityHold(latest.agentId, hold)) announceSession(bySession(session.sessionId)!)
      }
    }
    if (frame.evidence) {
      const evidence = frame.evidence
      sideRead('runtime profile', session.sessionId, () => runtimeProfiles.evidence(latest, evidence))
    }
    if (frame.failure !== undefined) {
      if (frame.failureSummary !== undefined) announceTurnAborted(session.sessionId, session.engine, frame.failure, frame.failureSummary)
      else announceTurnAborted(session.sessionId, session.engine, frame.failure)
    }
    if (!frame.events.length) return
    if (frame.replay) emit(session.sessionId, frame.events, { replay: true })
    else emit(session.sessionId, frame.events)
  }
  return { ingestLine, wireWatcher, acceptFrame, acceptStreamFrame }
}
