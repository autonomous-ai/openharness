/**
 * Attach: start following a session. The first attach of a session reads its history into its engine's
 * normalizer — Claude Code and Codex from the end of the transcript (lib/attachTranscript.ts), the other
 * file engines whole, the database engines through a reader that then polls — replays only a turn still
 * open, and hands the tail the byte the read stopped at. A later attach of a session it already follows
 * only makes sure the tail is running. One attach per session at a time, a few sessions at a time.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 9: docs/design/2026-10-03-harnessd.md).
 */
import { AgyNormalizer } from '../../engines/agy/normalizer.js'
import { agyPaneIdle } from '../../engines/agy/runtimeProfile.js'
import { AmpNormalizer } from '../../engines/amp/normalizer.js'
import { CodexNormalizer } from '../../engines/codex/normalizer.js'
import { codexSubagentResolverFor } from '../../engines/codex/subagent.js'
import { CommandCodeNormalizer } from '../../engines/commandcode/normalizer.js'
import { CopilotNormalizer, copilotHistoryTurnOpen } from '../../engines/copilot/normalizer.js'
import type { CursorTranscriptDiscovery } from '../../engines/cursor/discovery.js'
import { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import { DevinReader } from '../../engines/devin/reader.js'
import { GrokNormalizer } from '../../engines/grok/normalizer.js'
import { HermesReader } from '../../engines/hermes/reader.js'
import { KiloReader } from '../../engines/kilo/reader.js'
import { MuseNormalizer } from '../../engines/muse/normalizer.js'
import { OpencodeReader } from '../../engines/opencode/reader.js'
import { PiNormalizer } from '../../engines/pi/normalizer.js'
import type { AgentEngine } from '../../engines/types.js'
import { pollsQuestions, type QuestionWatcher } from '../../lib/askQuestion.js'
import { attachTranscript, claudeAttachRules, codexAttachRules, type AttachRead } from '../../lib/attachTranscript.js'
import { AttachTracker } from '../../lib/attachTracker.js'
import type { AutonomousDeviceService } from '../../lib/autonomous-device/service.js'
import { sid } from '../../lib/log.js'
import { foldTranscript, lineToEvents, newTurnState, TranscriptFold, type LiveEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeField, RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import { tailFile } from '../../lib/transcriptTail.js'
import type { TailHold, Watcher } from '../../watcher/watcher.js'
import type { SessionNormalizers } from './normalizers.js'

export interface AttachDeps {
  validateTerminal: (session: RegisteredSession) => Promise<boolean>
  normalizers: SessionNormalizers
  watcher: Pick<Watcher, 'addSession' | 'hold' | 'tails'>
  cursorDiscovery: Pick<CursorTranscriptDiscovery, 'add'>
  /** The Harness device service, once it exists: some subscriptions read the raw transcript. */
  device: () => Pick<AutonomousDeviceService, 'needsTranscript' | 'observeTranscript'> | undefined
  runtimeProfiles: Pick<RuntimeProfileManager, 'transcriptFields' | 'beginHydrate' | 'hydrate' | 'ingestConfig' | 'ingestPane'>
  captureTerminal: (target: string, historyLines?: number) => Promise<string | null>
  emit: (sessionId: string, events: LiveEvent[], opts?: { resumed?: boolean }) => void
  announceTurnAborted: (sessionId: string, engine: string, message: string) => void
  questionWatcher: Pick<QuestionWatcher, 'start'>
  /** How a session's terminal is named in the log. */
  terminalLabel: (session: RegisteredSession) => string
  /** The database engines' stores. */
  dbs: { opencode: string; kilo: string; devin: string }
  devinHome: string
  /** Hermes keeps a store per profile: the one this session's lives in. */
  hermesDb: (session: RegisteredSession) => Promise<string>
  /** How many sessions attach at once. */
  concurrency: number
}

export function createAttach({
  validateTerminal, normalizers, watcher, cursorDiscovery, device, runtimeProfiles, captureTerminal, emit,
  announceTurnAborted, questionWatcher, terminalLabel, dbs, devinHome, hermesDb, concurrency,
}: AttachDeps) {
  const {
    turnStates, codexNormalizers, cursorNormalizers, opencodeReaders, kiloReaders, museNormalizers, ampNormalizers,
    grokNormalizers, agyNormalizers, copilotNormalizers, piNormalizers, hermesReaders, devinReaders, commandcodeNormalizers,
  } = normalizers
  /**
   * Sessions that attached before their transcript existed, so nothing was folded and nothing has ever
   * been streamed for them.
   *
   * `bornAfterAgent` was supposed to cover this and does not always fire — measured on pi, whose agent is
   * discovered the instant the engine starts but whose session file only materialises once the first
   * answer is written: the re-attach that finally brought the path tailed from the file's END, so the
   * entire first turn — prompt, tools and answer — was read as history and never reached web or device.
   * A session that folded NOTHING can replay its whole file live without double-showing anything, which
   * is the one case where starting at byte 0 is unambiguously right.
   */
  const neverFoldedHistory = new Set<string>()
  /**
   * Sessions whose first turn has already been replayed live by an attach, or whose transcript an attach
   * has already folded.
   *
   * NOT the same question as `neverFoldedHistory` above, which is why they stay two sets: that one asks
   * "where should the watcher start reading?", this one asks "has this session's file already been
   * emitted?". A `reset` attach (`meta.isNew` or a repeat `SessionStart`) re-enters the folding branch for
   * a session that may already have streamed, and without this the whole transcript would go out a second
   * time.
   */
  const replayedFirstTurn = new Set<string>()
  const attachSessionNow = async (
    session: RegisteredSession,
    reset = false,
    replayCursorFromStart = false,
    /**
     * Tail the transcript from byte 0 instead of from its current end.
     *
     * The watcher normally starts at the end, because a session is registered the moment the engine
     * starts and the file is empty — end and start are the same place. That stops being true when an
     * agent exists BEFORE its session: the user types their first message in the terminal, THAT is what
     * makes the engine open a session, and by the time the hook binds it the prompt (and the first of the
     * answer) is already on disk. Starting at the end skipped it, so the web showed neither the message
     * nor the response. Only ever set for a session that was born after its agent — a resumed one keeps
     * tailing from the end, since its history belongs to `session_get`, not to the live stream.
     */
    replayFromStart = false,
    /** A tail being taken over (see `attachSession`): the hold on it, and where the read that replaces
     *  its normalizer stopped — the byte the tail resumes from. */
    handover: { hold: TailHold | null; next: number | null } = { hold: null, next: null },
  ): Promise<boolean> => {
    if (!await validateTerminal(session)) return false
    if (!reset && normalizers.hasState(session.sessionId)) {
      if (session.transcriptPath) {
        const unseen = neverFoldedHistory.delete(session.sessionId)
        await watcher.addSession(
          { ...session, transcriptPath: session.transcriptPath },
          { fromStart: replayFromStart || unseen || (session.engine === 'cursor' && replayCursorFromStart) },
        )
      }
      else if (session.engine === 'cursor') await cursorDiscovery.add(session.sessionId)
      console.log(`[agent] ${sid(session.agentId)} re-attached · engine=${session.engine} · terminal=${terminalLabel(session)} · session=${sid(session.sessionId)}`)
      return true
    }
    const initialEvents: LiveEvent[] = []
    // Folding the transcript in below is deliberately silent — old turns must never replay live. But
    // when the history ENDS mid-turn the turn is still running, and dropping its `turn_started` costs
    // the whole turn: CommanderMirror.onTurnEnded returns early while turnOpen is false, so the close
    // that follows produces no recap and no `done`. Keep the last start and replay exactly that one.
    //
    // The exception is a transcript BORN AFTER its agent — the file is then the live first turn rather
    // than history, and swallowing it loses the whole thing without a trace. `replayLive` routes the same
    // fold to `initialEvents`, which is emitted below. Cursor has always done this for its own discovery
    // path; the flag simply makes it available to every engine.
    const replayLive = (replayFromStart && !replayedFirstTurn.has(session.sessionId))
      || (session.engine === 'cursor' && replayCursorFromStart)
    const historyEvents: LiveEvent[] = []
    let historyTurnOpen = false
    const observe = device()?.needsTranscript(session.agentId, session.sessionId, session.engine)
      ? (line: string): void => device()?.observeTranscript(session.agentId, session.sessionId, session.engine, line)
      : undefined
    // Returns `turnOpen` rather than assigning it: every engine folds exactly once, and a second call
    // quietly overwriting the first is the kind of mistake a returned value makes impossible to write.
    const take = (out: { history: LiveEvent[]; live: LiveEvent[]; turnOpen: boolean }): boolean => {
      // One at a time, not `push(...arr)`: spreading passes every element as a separate argument and Node
      // throws RangeError somewhere past 100k of them. Real transcripts are nowhere near that (measured:
      // 1194 events out of a 25.6 MB rollout) — but the per-line spread this replaced had no ceiling at
      // all, and re-introducing one for no gain would be a poor trade.
      for (const event of out.history) historyEvents.push(event)
      for (const event of out.live) initialEvents.push(event)
      return out.turnOpen
    }
    // Claude Code and Codex read their transcript from the END: the last turn, plus the few older records
    // the chips and a continuing /goal still need — never the whole conversation, which on a long session
    // cost the daemon more memory than it has (lib/attachTranscript.ts). Their normalizers exist before
    // the read because they fold as the records stream in. The other engines still fold everything.
    const codexNormalizer = session.engine === 'codex'
      ? new CodexNormalizer('live', codexSubagentResolverFor(session.codexHome))
      : null
    const claudeState = session.engine === 'claude' ? newTurnState() : null
    const fields = (line: string): readonly RuntimeField[] => runtimeProfiles.transcriptFields(session, line)
    const fromEndFold = codexNormalizer
      ? { rules: codexAttachRules(fields), ingest: (line: string) => codexNormalizer.ingest(line), turnOpen: () => codexNormalizer.turnOpen }
      : claudeState
        ? { rules: claudeAttachRules(fields), ingest: (line: string) => lineToEvents(line, claudeState), turnOpen: () => claudeState.turnOpen }
        : null
    let fromEnd: AttachRead | null = null
    // A reset keeps the normalizer it meant to replace when its read failed, or outlasted the hold on the
    // tail — which then let go, and delivery went back to that normalizer: it has seen every record since,
    // this one has not.
    const keepLiveNormalizer = (why: string): boolean => {
      console.warn(`[agent] ${sid(session.agentId)} kept its live normalizer · the re-read ${why}`)
      handover.hold?.release()
      handover.next = null
      return true
    }
    if (session.transcriptPath && fromEndFold) {
      // A session already being tailed — a reset — is re-read while its old normalizer is still the one
      // being fed: hold its tail, so the read stops exactly where delivery stopped and delivery resumes,
      // into the new normalizer, from where the read stopped (released by `attachSession`).
      handover.hold = await watcher.hold(session.sessionId, session.transcriptPath)
      // Lines a held tail already delivered were seen live; replaying them live again would repeat them.
      const live = replayLive && handover.hold === null
      const stream = new TranscriptFold(fromEndFold.ingest, fromEndFold.turnOpen, live)
      const profile = runtimeProfiles.beginHydrate(session)
      const read = await attachTranscript(session.transcriptPath, fromEndFold.rules, {
        // Ids named for this window cannot repeat ones another fold of the session sent.
        start: (span) => {
          const prefix = `${span.turnFrom.toString(36)}-`
          if (codexNormalizer) codexNormalizer.thinkingPrefix = `thinking-codex-${prefix}`
          if (claudeState) claudeState.thinkingPrefix = `thinking-live-${prefix}`
        },
        profile: (line) => profile.ingest(line),
        fold: (line) => stream.push(line),
        observe,
      }, { fromStart: live, end: handover.hold?.offset })
      if (handover.hold && (read.failed || handover.hold.expired)) {
        return keepLiveNormalizer(read.failed ? 'could not read the transcript' : 'outlasted its hold on the tail')
      }
      profile.commit()
      fromEnd = read
      handover.next = read.next
      historyTurnOpen = take(stream.finish())
      console.log(`[agent] ${sid(session.agentId)} read the transcript from its end · turn @${read.turnFrom} · profile @${read.profileFrom} · ${read.end} bytes${handover.hold ? ' · took over its tail' : ''}`)
    }
    const lines = session.transcriptPath && !fromEnd ? await tailFile(session.transcriptPath, Infinity) : []
    if (!fromEnd) {
      if (observe) for (const line of lines) observe(line)
      runtimeProfiles.hydrate(session, lines)
    }
    await runtimeProfiles.ingestConfig(session, true)
    // From here to the release in `attachSession` nothing is awaited for a held tail, so the hold cannot
    // expire between installing the new normalizer and handing it the tail.
    if (handover.hold?.expired) return keepLiveNormalizer('outlasted its hold on the tail')
    const fold = (ingest: (line: string) => LiveEvent[], turnOpenAfter: () => boolean): boolean =>
      take(foldTranscript(ingest, lines, turnOpenAfter, { live: replayLive }))
    if (codexNormalizer) {
      // Folded above, from the end, when there is a rollout; without one there is nothing to fold.
      codexNormalizers.set(session.sessionId, codexNormalizer)
    } else if (session.engine === 'cursor') {
      const normalizer = new CursorNormalizer('live', session.sessionId)
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      cursorNormalizers.set(session.sessionId, normalizer)
      const capture = await captureTerminal(session.agentId, 100)
      if (capture) runtimeProfiles.ingestPane(session, capture, true)
    } else if (session.engine === 'opencode') {
      // OpenCode has no transcript file — poll its SQLite DB. The reader hydrates silently, then
      // streams new activity into the funnel (the same one the file engines use).
      const reader = new OpencodeReader({
        dbPath: dbs.opencode,
        sessionId: session.sessionId,
        onEvents: (events) => emit(session.sessionId, events),
        onFatal: (err) => console.warn(`[opencode] ${sid(session.sessionId)} ${err.message}`),
      })
      opencodeReaders.set(session.sessionId, reader)
      await reader.start()
      // The composer footer is the ONLY place OpenCode names its model and reasoning level, so
      // without this a freshly opened agent showed empty chips until the five-minute reconcile came
      // round — which is exactly how long it looked broken for.
      const ocPane = await captureTerminal(session.agentId, 100)
      if (ocPane) runtimeProfiles.ingestPane(session, ocPane, true)
    } else if (session.engine === 'kilo') {
      // Kilo is opencode's fork and keeps the same store shape, so it is polled the same way — but from
      // its OWN db and through its own reader, so the two can diverge without one breaking the other.
      const reader = new KiloReader({
        dbPath: dbs.kilo,
        sessionId: session.sessionId,
        onEvents: (events) => emit(session.sessionId, events),
        onFatal: (err) => console.warn(`[kilo] ${sid(session.sessionId)} ${err.message}`),
      })
      kiloReaders.set(session.sessionId, reader)
      await reader.start()
    } else if (session.engine === 'muse') {
      // Same JSONL tail as claude/pi; only the record shape differs.
      const normalizer = new MuseNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      museNormalizers.set(session.sessionId, normalizer)
    } else if (session.engine === 'amp') {
      // A JSONL tail like claude/muse — except the file is written by the adapter's own Amp plugin,
      // because Amp is the one engine that keeps no conversation on disk.
      const normalizer = new AmpNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      ampNormalizers.set(session.sessionId, normalizer)
    } else if (session.engine === 'grok') {
      const normalizer = new GrokNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      grokNormalizers.set(session.sessionId, normalizer)
      const capture = await captureTerminal(session.agentId, 60)
      if (capture) runtimeProfiles.ingestPane(session, capture, true)
    } else if (session.engine === 'agy') {
      // A JSONL tail like claude/grok. agy announces its model only in the hook payload and its pane
      // footer, so the pane is read once on attach to fill the chip before the first turn.
      const normalizer = new AgyNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      agyNormalizers.set(session.sessionId, normalizer)
      const capture = await captureTerminal(session.agentId, 60)
      if (capture) runtimeProfiles.ingestPane(session, capture, true)
      // agy's transcript has no end-of-turn record - only its Stop hook does - so a fold of a FINISHED
      // conversation still reports the last turn as open, and after a daemon restart nothing is ever
      // coming to close it. The pane is the one place the answer exists; ask it.
      if (historyTurnOpen && capture && agyPaneIdle(capture)) {
        normalizer.closeTurn()
        historyTurnOpen = false
      }
    } else if (session.engine === 'copilot') {
      // A JSONL tail like claude/agy. Its turn lifecycle comes from the agentStop hook, not the file —
      // which is exactly why a fold cannot be trusted on its own: `copilot --resume` replays a finished
      // conversation, the fold opens a turn on its last `user.message`, and no hook is coming to close
      // it. Ask the records where the last activity actually ended.
      const normalizer = new CopilotNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      copilotNormalizers.set(session.sessionId, normalizer)
      if (historyTurnOpen && !copilotHistoryTurnOpen(lines)) {
        normalizer.closeTurn()
        historyTurnOpen = false
      }
    } else if (session.engine === 'pi') {
      const normalizer = new PiNormalizer('live')
      // Hydrate state silently; never replay history live — except a turn left open, below.
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      piNormalizers.set(session.sessionId, normalizer)
    } else if (session.engine === 'hermes') {
      // Hermes has no transcript file — poll its SQLite store, like opencode.
      const reader = new HermesReader({
        dbPath: await hermesDb(session),
        sessionId: session.sessionId,
        onEvents: (events) => emit(session.sessionId, events),
        onFatal: (err) => console.warn(`[hermes] ${sid(session.sessionId)} ${err.message}`),
      })
      hermesReaders.set(session.sessionId, reader)
      await reader.start()
    } else if (session.engine === 'devin') {
      // Devin has no transcript file either — poll its SQLite store, like hermes/opencode.
      const reader = new DevinReader({
        dbPath: dbs.devin,
        devinHome,
        sessionId: session.sessionId,
        onEvents: (events) => emit(session.sessionId, events),
        // Devin has no StopFailure: a turn that dies on a provider error writes no assistant row and
        // fires no Stop hook, so surface the failure and close the turn ourselves — otherwise the web
        // sits on the typing indicator forever.
        onTurnAborted: (message) => {
          announceTurnAborted(session.sessionId, 'devin', message)
          emit(session.sessionId, [{ type: 'turn_ended', payload: {} }])
        },
        onFatal: (err) => console.warn(`[devin] ${sid(session.sessionId)} ${err.message}`),
      })
      devinReaders.set(session.sessionId, reader)
      await reader.start()
      // Devin's model/effort exist ONLY in its pane footer, so read it now. Without this the chip stayed
      // on Auto until the 5-minute reconcile happened to run — the attach itself said nothing about it.
      const devinPane = await captureTerminal(session.agentId, 60)
      if (devinPane) runtimeProfiles.ingestPane(session, devinPane, true)
    } else if (session.engine === 'commandcode') {
      const normalizer = new CommandCodeNormalizer('live')
      // Hydrate state silently; never replay history live — except a turn left open, below.
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      commandcodeNormalizers.set(session.sessionId, normalizer)
    } else {
      const state = claudeState ?? newTurnState()
      if (!fromEnd) historyTurnOpen = fold((line) => lineToEvents(line, state), () => state.turnOpen)
      turnStates.set(session.sessionId, state)
    }
    if (session.transcriptPath) {
      neverFoldedHistory.delete(session.sessionId)
      // Deliberately NOT `fromStart`, even when the caller asked for it: this branch has just folded the
      // file into the normalizer above, so replaying it from byte 0 emits every line a second time.
      // Measured: a claude turn opened, closed after 44ms and opened again, because the fold replayed the
      // open turn and the watcher then re-read the same bytes. `fromStart` belongs to the re-attach path,
      // which folds nothing. A transcript read from its end hands the tail the exact byte it stopped at.
      // A held tail is already this session's, and resumes from there when the hold is released.
      if (!handover.hold || !watcher.tails(session.sessionId, session.transcriptPath)) {
        await watcher.addSession({ ...session, transcriptPath: session.transcriptPath }, fromEnd ? { fromOffset: fromEnd.next } : {})
      }
    } else if (session.engine === 'cursor') {
      await cursorDiscovery.add(session.sessionId)
    } else {
      // No transcript to fold: whatever this session writes later is its FIRST content, so the re-attach
      // that brings the path must read the file whole rather than from its end.
      neverFoldedHistory.add(session.sessionId)
    }
    // Marked on the FOLD, not on the emission. A live fold that happened to produce nothing — the file
    // was still empty when this attach ran — would otherwise leave the session unmarked, and the next
    // `reset` attach (claude fires `SessionStart` on compact, which resets) would fold the by-then
    // complete transcript and emit it live on top of everything the watcher had already streamed. That
    // is the same duplicate-turn class this whole change exists to remove.
    // Any fold of a transcript with content counts too: the watcher now tails it from the end, so a later
    // replay could only send history out again as if it were live.
    if (replayLive || lines.length || fromEnd?.content) replayedFirstTurn.add(session.sessionId)
    if (initialEvents.length) {
      emit(session.sessionId, initialEvents)
      console.log(`[agent] ${sid(session.agentId)} replayed the first turn its transcript already held · ${initialEvents.length} events`)
    }
    console.log(`[agent] ${sid(session.agentId)} attached · engine=${session.engine} · terminal=${terminalLabel(session)} · session=${sid(session.sessionId)} · lines=${fromEnd ? fromEnd.records : lines.length}`)
    // A first prompt that lands while this attach is running is already in the transcript we just
    // folded, so its turn_started was consumed as history and the live turn would end up untracked.
    // Replay that one event, after the attach log, so the recovery is visible in order.
    if (historyTurnOpen) {
      const opened = historyEvents.findLast((event) => event.type === 'turn_started')
      if (opened) {
        console.log(`[agent] ${sid(session.agentId)} resumed the turn already open at attach`)
        emit(session.sessionId, [opened], { resumed: true })
      }
    }
    // Watch this pane for a question from ATTACH, not only from the next turn_started.
    //
    // A turn-scoped start assumes the agent exists before its turn does, and for some engines it does not:
    // OpenCode registers itself when its FIRST message creates the session, i.e. the turn is already
    // running by the time the daemon knows the agent — so its question opened and nothing announced it
    // (measured: the dialog sat on the pane, the device saw nothing). Command Code has the mirror problem,
    // asking AFTER the turn ends. The watcher is idempotent, no-ops without a device, and dies with the
    // session, so starting it early costs nothing.
    if (pollsQuestions(session.engine)) questionWatcher.start(session.sessionId)
    return true
  }

  /** One attach per session, a few sessions at a time, and a record of what is being read — see lib/attachTracker. */
  const attaches = new AttachTracker<AgentEngine>({
    concurrency,
    onSlow: (session, elapsedMs) => console.warn(
      `[agent] ${sid(session.agentId)} attach still running · engine=${session.engine} · session=${sid(session.sessionId)} · ${Math.round(elapsedMs / 1000)}s`,
    ),
  })
  const attachSession = (
    session: RegisteredSession,
    reset = false,
    replayCursorFromStart = false,
    replayFromStart = false,
  ): Promise<boolean> =>
    attaches.attach(session, reset, async () => {
      // A tail an attach holds (a Claude Code or Codex reset, see attachSessionNow) is released only
      // here, after the whole attach — the new normalizer installed and any open turn said to be open —
      // so delivery resumes into it, in order. Released on every exit, however the attach ends.
      const handover = { hold: null as TailHold | null, next: null as number | null }
      try {
        return await attachSessionNow(session, reset, replayCursorFromStart, replayFromStart, handover)
      } finally {
        handover.hold?.release(handover.next)
      }
    })
  return { attachSession, attaches, neverFoldedHistory, replayedFirstTurn }
}

export type Attach = ReturnType<typeof createAttach>
