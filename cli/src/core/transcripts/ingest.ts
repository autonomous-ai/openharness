/**
 * Ingest: each transcript line the watcher delivers, through its engine's normalizer, into the funnel.
 * Lines arrive live, or as a history batch (a catch-up, emitted as a replay); a transcript rewritten in
 * place with too much history to replay is attached again from its end.
 *
 * The file engines' normalizers are created here lazily, on a session's first line; the database
 * engines' readers never are (they are attached, not tailed).
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 9: docs/design/2026-10-03-harnessd.md).
 */
import { AgyNormalizer } from '../../engines/agy/normalizer.js'
import { AmpNormalizer } from '../../engines/amp/normalizer.js'
import type { LiveFor, LiveParser } from '../../engines/facets/live.js'
import { CommandCodeNormalizer, commandCodeRunError, commandCodeRunErrorSummary } from '../../engines/commandcode/normalizer.js'
import { CopilotNormalizer } from '../../engines/copilot/normalizer.js'
import { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import { GrokNormalizer } from '../../engines/grok/normalizer.js'
import { MuseNormalizer } from '../../engines/muse/normalizer.js'
import { PiNormalizer } from '../../engines/pi/normalizer.js'
import type { WifiFeed } from '../wifi.js'
import { sid } from '../../lib/log.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import type { HistoryEvent, LineEvent, RewrittenEvent, Watcher } from '../../watcher/watcher.js'
import type { SessionNormalizers } from './normalizers.js'
import { createSideReads } from './sideReads.js'
import type { LiveFrame } from '../../engines/worker/liveProtocol.js'

export interface IngestDeps {
  liveFor: LiveFor
  has: (sessionId: string) => boolean
  bySession: (sessionId: string) => RegisteredSession | undefined
  tokenUsage: { changed(session: RegisteredSession): void }
  /** The Wi-Fi device's service, wherever it runs (core/wifi.ts): it proves its turns by the raw transcript. */
  device: () => Pick<WifiFeed, 'needsTranscript' | 'observeTranscript'> | undefined
  runtimeProfiles: Pick<RuntimeProfileManager, 'ingest'>
  normalizers: SessionNormalizers
  announceTurnAborted: (sessionId: string, engine: string, message: string, deviceMessage?: string) => void
  emit: (sessionId: string, events: LiveEvent[], opts?: { replay?: boolean }) => void
  attachSession: (session: RegisteredSession, reset: boolean) => Promise<boolean>
}

export function createIngest({
  liveFor, has, bySession, tokenUsage, device, runtimeProfiles, normalizers, announceTurnAborted, emit, attachSession,
}: IngestDeps) {
  const {
    liveParsers, cursorNormalizers, museNormalizers, ampNormalizers, grokNormalizers, agyNormalizers,
    copilotNormalizers, piNormalizers, commandcodeNormalizers,
  } = normalizers
  const sideRead = createSideReads()
  // JSONL watcher → normalize each appended line → stream up. ONE lineToEvents pass feeds BOTH
  // audiences: web (send, ServerEvents) and device (mirror.ingest → curated commander_event cards).
  /** One transcript line through its engine's normalizer. The events, not yet emitted — the two
   *  callers below differ only in what they know about the line's age. */
  const observeLine = (evt: Pick<LineEvent, 'sessionId' | 'engine' | 'text'>, profileAccepted = false): RegisteredSession | null => {
    if (!has(evt.sessionId)) return null // scope to terminal-registered sessions
    const session = bySession(evt.sessionId)
    if (!session || session.engine !== evt.engine) return null
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
  const ingestLine = (evt: LineEvent): ReturnType<CursorNormalizer['ingest']> | null => {
    const session = observeLine(evt)
    if (!session) return null
    let events: LiveEvent[]
    const adapter = liveFor(session.engine)
    if (adapter) {
      let parser = liveParsers.get(evt.sessionId)
      if (!parser || parser.engine !== session.engine || !('ingest' in parser)) { parser = adapter.create(session); liveParsers.set(evt.sessionId, parser) }
      const read = (parser as LiveParser).ingest(evt.text)
      events = read.events
      if (read.failure !== undefined) announceTurnAborted(evt.sessionId, session.engine, read.failure)
    } else if (session.engine === 'cursor') {
      let normalizer = cursorNormalizers.get(evt.sessionId)
      if (!normalizer) {
        normalizer = new CursorNormalizer('live', evt.sessionId)
        cursorNormalizers.set(evt.sessionId, normalizer)
      }
      events = normalizer.ingest(evt.text)
    } else if (session.engine === 'muse') {
      let normalizer = museNormalizers.get(evt.sessionId)
      if (!normalizer) { normalizer = new MuseNormalizer(); museNormalizers.set(evt.sessionId, normalizer) }
      events = normalizer.ingest(evt.text)
    } else if (session.engine === 'amp') {
      let normalizer = ampNormalizers.get(evt.sessionId)
      if (!normalizer) { normalizer = new AmpNormalizer(); ampNormalizers.set(evt.sessionId, normalizer) }
      events = normalizer.ingest(evt.text)
    } else if (session.engine === 'grok') {
      let normalizer = grokNormalizers.get(evt.sessionId)
      if (!normalizer) { normalizer = new GrokNormalizer(); grokNormalizers.set(evt.sessionId, normalizer) }
      events = normalizer.ingest(evt.text)
    } else if (session.engine === 'agy') {
      let normalizer = agyNormalizers.get(evt.sessionId)
      if (!normalizer) { normalizer = new AgyNormalizer(); agyNormalizers.set(evt.sessionId, normalizer) }
      events = normalizer.ingest(evt.text)
    } else if (session.engine === 'copilot') {
      let normalizer = copilotNormalizers.get(evt.sessionId)
      if (!normalizer) { normalizer = new CopilotNormalizer(); copilotNormalizers.set(evt.sessionId, normalizer) }
      events = normalizer.ingest(evt.text)
    } else if (session.engine === 'pi') {
      let normalizer = piNormalizers.get(evt.sessionId)
      if (!normalizer) { normalizer = new PiNormalizer('live'); piNormalizers.set(evt.sessionId, normalizer) }
      events = normalizer.ingest(evt.text)
    } else if (session.engine === 'commandcode') {
      let normalizer = commandcodeNormalizers.get(evt.sessionId)
      if (!normalizer) { normalizer = new CommandCodeNormalizer('live'); commandcodeNormalizers.set(evt.sessionId, normalizer) }
      events = normalizer.ingest(evt.text)
      // Command Code fires no Stop hook for a failed turn: this record IS the notification. `ingest`
      // already closed the turn (its turn_ended is in `events`, emitted just below) — announce the
      // reason first so the web/device show the error ahead of the turn closing.
      const runError = commandCodeRunError(evt.text)
      if (runError !== null) {
        announceTurnAborted(evt.sessionId, 'commandcode', runError, commandCodeRunErrorSummary(runError))
      }
    } else {
      events = []
    }
    return events
  }
  /** Feed what the watcher delivers through `ingestLine` into the funnel. */
  const wireWatcher = (watcher: Pick<Watcher, 'on'>): void => {
    watcher.on('line', (evt: LineEvent) => {
      // This runs from a void-discarded async read, so a throw here would be an unhandledRejection. A
      // single malformed line must never take the daemon down — contain it per line and move on.
      try {
        const events = ingestLine(evt)
        if (events) emit(evt.sessionId, events)
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
        type Events = ReturnType<CursorNormalizer['ingest']>
        const all: Events = []
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
    emit(sessionId, frame.events, { replay: frame.replay })
  }
  return { ingestLine, wireWatcher, acceptFrame }
}
