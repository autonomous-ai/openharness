/**
 * Attach: start following a session. The first attach of a session reads its history into its engine's
 * normalizer — Claude Code and Codex from the end of the transcript (lib/attachTranscript.ts), the other
 * file engines whole, the database engines through a reader that then polls — replays only a turn still
 * open, and hands the tail the byte the read stopped at. A later attach of a session it already follows
 * only makes sure the tail is running. One attach per session at a time, a few sessions at a time.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 9: docs/design/2026-10-03-harnessd.md).
 */
import type { LiveFor } from '../../engines/facets/live.js'
import type { CursorTranscriptDiscovery } from '../../engines/cursor/discovery.js'
import { isOtherEngine, type InProcessModules } from '../../engines/inProcess.js'
import type { AgentEngine } from '../../engines/types.js'
import { pollsQuestions, type QuestionWatcher } from '../../lib/questionController.js'
import { attachTranscript, type AttachRead } from '../../lib/attachTranscript.js'
import { AttachTracker } from '../../lib/attachTracker.js'
import type { WifiFeed } from '../wifi.js'
import { sid } from '../../lib/log.js'
import { foldTranscript, TranscriptFold } from '../../engines/kit/transcriptFold.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeField, RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import type { ProfileHydration } from '../engines/runtimeProfiles.js'
import { tailFileCapped, WHOLE_READ_CAP_BYTES } from '../../lib/transcriptTail.js'
import type { TailHold, Watcher } from '../../watcher/watcher.js'
import type { SessionNormalizers } from './normalizers.js'
import type { RelaunchMarks } from './relaunch.js'
import { createSideReads } from './sideReads.js'
import { paneReadIdentity } from './readIdentity.js'
import type { LiveSessions, PreparedLive } from '../engines/liveSessions.js'
import { createReaderLoads } from './readerLoads.js'
import { createTurnReplacements } from './turnReplacement.js'

export interface AttachDeps {
  liveFor: LiveFor
  resolve: (agentId: string) => RegisteredSession | undefined
  remoteLive?: Pick<LiveSessions, 'handles' | 'current' | 'prepare' | 'install' | 'discard' | 'retry'>
  /** Whether the session's terminal is known to be gone (core/terminals/control.ts `terminalGone`). */
  terminalGone: (session: RegisteredSession) => Promise<boolean>
  normalizers: SessionNormalizers
  watcher: Pick<Watcher, 'addSession' | 'removeSession' | 'pollSession' | 'hold' | 'tails'>
  setInterpretationHold: (agentId: string, revision: number | undefined, reason?: string, create?: boolean) => boolean
  announceSession: (session: RegisteredSession) => void
  cursorDiscovery: Pick<CursorTranscriptDiscovery, 'add'>
  /** The Wi-Fi device's service, wherever it runs (core/wifi.ts): it proves its turns by the raw transcript. */
  device: () => Pick<WifiFeed, 'needsTranscript' | 'observeTranscript'> | undefined
  runtimeProfiles: Pick<RuntimeProfileManager, 'transcriptFields' | 'hydrate' | 'ingestConfig' | 'capturePane'> & {
    beginHydrate(session: RegisteredSession): ProfileHydration
    ingestPane(session: RegisteredSession, text: string, silent?: boolean): boolean | Promise<boolean>
  }
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
  /** The wait for optional code, before any reader has started writing. */
  readerLoadWaitMs?: number
  /** Where an engine's writing became live again after a relaunch (core/transcripts/relaunch.ts): the fold stops there. */
  relaunchMarks?: Pick<RelaunchMarks, 'read' | 'complete'>
  /** The most of a transcript an engine without its own reader from the end folds, from its end. */
  wholeReadCapBytes?: number
  /** The session attached with its last turn already over (core/turns/recaps.ts `settled`). */
  settled?: (sessionId: string) => void
}

export function createAttach({
  liveFor, resolve, remoteLive, terminalGone, normalizers, watcher, cursorDiscovery, device, runtimeProfiles, captureTerminal, emit,
  announceTurnAborted, questionWatcher, terminalLabel, dbs, devinHome, hermesDb, concurrency, relaunchMarks,
  wholeReadCapBytes = WHOLE_READ_CAP_BYTES, settled, readerLoadWaitMs, setInterpretationHold, announceSession,
}: AttachDeps) {
  const {
    liveParsers, cursorNormalizers, opencodeReaders, kiloReaders, museNormalizers, ampNormalizers,
    grokNormalizers, agyNormalizers, copilotNormalizers, piNormalizers, hermesReaders, devinReaders, commandcodeNormalizers,
  } = normalizers
  const sideRead = createSideReads()
  const readerLoads = createReaderLoads(readerLoadWaitMs)
  const turnReplacements = createTurnReplacements(normalizers)
  const recoveryRetries = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingAttaches = new Map<string, number>()
  const admissionStops = new Map<string, { sessionId: string }>()
  const captureAdmissionStop = (session: RegisteredSession): (() => boolean) => {
    const agentId = session.agentId
    let token = admissionStops.get(agentId)
    if (token?.sessionId !== session.sessionId) {
      token = { sessionId: session.sessionId }
      admissionStops.set(agentId, token)
    }
    const captured = token
    return () => admissionStops.get(agentId) === captured
  }
  const lifetimes = new Map<string, object>()
  const forget = (sessionId: string): void => {
    readerLoads.forget(sessionId)
    lifetimes.delete(sessionId)
    turnReplacements.forget(sessionId)
    for (const [agentId, token] of admissionStops) if (token.sessionId === sessionId) admissionStops.delete(agentId)
    clearTimeout(recoveryRetries.get(sessionId))
    recoveryRetries.delete(sessionId)
  }
  const explainRecovery = (session: RegisteredSession, reason?: string): boolean => {
    if (!setInterpretationHold(session.agentId, session.evidenceRevision, reason)) return false
    announceSession(resolve(session.agentId)!)
    return true
  }
  const beforeCancel = (session: RegisteredSession): void => {
    admissionStops.delete(session.agentId)
    if (session.identityHold || session.interpretationHold) turnReplacements.stage(session)
    else if (session.transcriptPath || turnReplacements.retains(session)) {
      const reason = turnReplacements.cancel(session)
      if (reason && session.transcriptPath) holdInterpretation(session, `Waiting for transcript interpretation: ${reason}.`)
    }
  }
  const holdInterpretation = (session: RegisteredSession, reason: string): void => {
    turnReplacements.stage(session)
    if (setInterpretationHold(session.agentId, session.evidenceRevision, reason, true)) {
      const latest = resolve(session.agentId)!
      // The control obligation already exists. A failed status notification must
      // never make its caller replay that Stop after a later explicit Cancel.
      try { announceSession(latest) }
      catch (error) { console.warn('[agent] interpretation hold notification failed', error) }
      void attachSession(latest, true).catch(error => console.warn(`[agent] recovery held: ${String(error)}`))
    }
  }
  const holdStop = (session: RegisteredSession, force = false): boolean => {
    if (!session.identityHold && !session.interpretationHold && !force) return false
    turnReplacements.stage(session).stop()
    holdInterpretation(session, 'Stop could not be matched to its turn; Cancel can resolve this hold.')
    return true
  }
  const afterStop = (session: RegisteredSession): void => { turnReplacements.stop(session) }
  const holdAdmissionStop = (session: RegisteredSession, unmatched: boolean): boolean => {
    // A catch hook can supply the first transcript path, or arrive before a
    // parser exists. Retain that completion before any recovered fold starts.
    if (!unmatched && normalizers.sessionTurnState(session.sessionId) !== undefined
      && !session.identityHold && !session.interpretationHold && !pendingAttaches.has(session.sessionId)
      && !relaunchMarks?.read(session.sessionId)) return false
    return holdStop(session, true)
  }
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
    current: () => boolean,
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
    // Only a terminal known to be gone refuses an attach, never a probe that could not answer. A failed
    // attach costs the agent its binding (agents/bind.ts) or its place among the active (discovery.ts),
    // and a probe in flight when the machine slept times out at the wake before its answer is read: the
    // session of an agent still at work was unbound that way two seconds after a laptop woke (round 29,
    // e2e/clockjump.e2e.ts). A terminal that really is gone is retired by the reconciler's confirmed scans.
    if (!current() || await terminalGone(session) || !current()) return false
    // Bound only the wait for optional code, before any interpretation writes. A late import gets one
    // fenced retry; a missing import holds the transcript intact until an update or restart fixes it.
    const other = isOtherEngine(session.engine) ? await readerLoads.read(
      session.engine, session.sessionId, paneReadIdentity(session), current, async stillHeld => {
        if (current()) await attachSession(session, true, replayCursorFromStart, replayFromStart, stillHeld).catch(error => console.error(
          `[agent] ${sid(session.agentId)} reader retry failed: ${error instanceof Error ? error.message : error}`))
      }) : null
    if (!current()) return false
    if (isOtherEngine(session.engine) && !other) {
      console.warn(`[agent] ${sid(session.agentId)} transcript held · engine=${session.engine} · its reader is unavailable or still loading`)
      return true
    }
    const engine = <Name extends keyof InProcessModules>(name: Name): InProcessModules[Name] | null =>
      session.engine === name ? other as InProcessModules[Name] | null : null
    // Reading does not consume the boundary. A stale profile or unavailable worker can abandon this
    // attach before installing anything; the next attach must still know the old engine's turn died.
    const relaunch = relaunchMarks?.read(session.sessionId)
    const relaunchedAt = relaunch?.offset
    const remote = remoteLive?.handles(session.engine) ? remoteLive : undefined
    if (!relaunch && !reset && normalizers.hasState(session.sessionId) && (!remote || remote.current(session))) {
      if (session.transcriptPath) {
        const unseen = neverFoldedHistory.delete(session.sessionId)
        await watcher.addSession(
          { ...session, transcriptPath: session.transcriptPath },
          { fromStart: replayFromStart || unseen || (session.engine === 'cursor' && replayCursorFromStart) },
        )
      }
      console.log(`[agent] ${sid(session.agentId)} re-attached · engine=${session.engine} · terminal=${terminalLabel(session)} · session=${sid(session.sessionId)}`)
      return true
    }
    const initialEvents: LiveEvent[] = []
    // Folding the transcript in below is deliberately silent — old turns must never replay live. But
    // when the history ENDS mid-turn the turn is still running, and dropping its `turn_started` costs
    // the whole turn: the recaps' mirror (lib/commander.ts onTurnEnded) returns early while turnOpen is false, so the close
    // that follows produces no recap and no `done`. Keep the last start and replay exactly that one.
    //
    // The exception is a transcript BORN AFTER its agent — the file is then the live first turn rather
    // than history, and swallowing it loses the whole thing without a trace. `replayLive` routes the same
    // fold to `initialEvents`, which is emitted below. Cursor has always done this for its own discovery
    // path; the flag simply makes it available to every engine.
    //
    // Never for a conversation its engine was just relaunched on (a resume, a restart, a restore after
    // the machine came back): everything before its relaunch mark existed before this launch, and is
    // history. A restore is not a resume to `bind.ts`, so a transcript under ten minutes old
    // (lib/firstTurnReplay.ts) went out live again after a daemon restart: its turns, and their recaps
    // and notifications, a second time (found end to end, e2e/machine.e2e.ts).
    const replayLive = !session.interpretationHold && relaunchedAt === undefined && (
      (replayFromStart && !replayedFirstTurn.has(session.sessionId))
      || (session.engine === 'cursor' && replayCursorFromStart))
    const historyEvents: LiveEvent[] = []
    let historyTurnOpen = false
    let historyExplicitlyClosed = false
    let historySuperseded = false
    let historyCurrent: (() => boolean) | undefined
    let observed = false
    sideRead('device', session.sessionId, () => { observed = !!device()?.needsTranscript(session.agentId, session.sessionId, session.engine) })
    const observe = observed && !session.interpretationHold
      ? (line: string): void => { if (current()) sideRead('device', session.sessionId, () => device()?.observeTranscript(session.agentId, session.sessionId, session.engine, line)) }
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
    const adapter = remote ? undefined : liveFor(session.engine)
    const parser = adapter?.create(session)
    const fields = (line: string): readonly RuntimeField[] => runtimeProfiles.transcriptFields(session, line)
    const rules = adapter?.attachRules?.(fields)
    const fromEndFold = parser && rules
      ? { rules, ingest: (line: string) => {
        const events = parser.ingest(line).events
        if (events.some(event => event.type === 'turn_started' || event.type === 'turn_ended')) historyExplicitlyClosed = false
        return events
      }, turnOpen: () => parser.turnOpen }
      : null
    let fromEnd: AttachRead | null = null
    let prepared: PreparedLive | null = null
    let profileHydration: ProfileHydration | null = null
    const replacement = session.interpretationHold ? turnReplacements.stage(session) : undefined
    const recoveryPlan = replacement?.plan()
    const closes = recoveryPlan?.closes.length ? [
      ...(relaunch?.engineStarted ? [{ offset: relaunch.offset, reason: 'abandoned' as const }] : []),
      ...recoveryPlan.closes,
    ].sort((a, b) => a.offset - b.offset) : undefined
    let recoveryInstall = () => replacement!.commit(recoveryPlan!)
    let recoveryReady = false
    // A reset keeps the normalizer it meant to replace when its read failed, or outlasted the hold on the
    // tail — which then let go, and delivery went back to that normalizer: it has seen every record since,
    // this one has not.
    const keepLiveNormalizer = (why: string): boolean => {
      console.warn(`[agent] ${sid(session.agentId)} ${session.interpretationHold ? 'transcript held' : 'kept its live normalizer'} · the re-read ${why}`)
      if (session.interpretationHold && current()) explainRecovery(session, `Waiting for transcript interpretation: the re-read ${why}.`)
      handover.hold?.release()
      handover.next = null
      if (relaunch) remote?.retry(session)
      return true
    }
    // A surviving shell can leave its old tail installed. Its cursor is the old engine's delivery
    // position; a newly started engine's history ends at the launch boundary instead.
    const historyEnd = () => closes ? undefined : relaunch?.engineStarted ? relaunch.offset : handover.hold?.offset ?? relaunchedAt
    if (remote) {
      if (session.transcriptPath) handover.hold = await watcher.hold(session.sessionId, session.transcriptPath)
      const live = replayLive && handover.hold === null
      try {
        const profile = runtimeProfiles.beginHydrate(session)
        profileHydration = profile
        prepared = await remote.prepare(session, { live, end: historyEnd(), ...(closes ? { closes } : {}) }, frame => {
          if (frame.profile && !profile.ingestFrames) sideRead('runtime profile', session.sessionId, () => profile.ingest(frame.raw))
          if (frame.observe && observe) observe(frame.raw)
        }, profile.ingestFrames)
        if (current() && profile.config) await profile.config()
      } catch {
        if (prepared) remote.discard(prepared)
        remote.retry(session)
        return handover.hold ? keepLiveNormalizer('could not reach its engine worker') : true
      }
      if (handover.hold?.expired) { remote.discard(prepared); return keepLiveNormalizer('outlasted its hold on the tail') }
      fromEnd = { next: prepared.page.cursor.offset, records: prepared.records, content: prepared.content }
      handover.next = fromEnd.next
      historyTurnOpen = !live && prepared.state.handle.turnOpen
      historyExplicitlyClosed = !!prepared.page.cursor.closed
      if (prepared.page.lastStarted) historyEvents.push(prepared.page.lastStarted)
    } else if (session.transcriptPath && fromEndFold) {
      // A session already being tailed — a reset — is re-read while its old normalizer is still the one
      // being fed: hold its tail, so the read stops exactly where delivery stopped and delivery resumes,
      // into the new normalizer, from where the read stopped (released by `attachSession`).
      handover.hold = await watcher.hold(session.sessionId, session.transcriptPath)
      // Lines a held tail already delivered were seen live; replaying them live again would repeat them.
      const live = replayLive && handover.hold === null
      const stream = new TranscriptFold(fromEndFold.ingest, fromEndFold.turnOpen, live)
      const profile = runtimeProfiles.beginHydrate(session)
      profileHydration = profile
      const read = await attachTranscript(session.transcriptPath, fromEndFold.rules, {
        // Ids named for this window cannot repeat ones another fold of the session sent.
        start: (span) => parser!.windowStart(span.turnFrom),
        profile: (line) => profile.ingest(line),
        fold: (line) => stream.push(line),
        close: reason => { parser!.closeTurn(reason); historyExplicitlyClosed = true },
        observe,
      }, { fromStart: live, end: historyEnd(), closes })
      if ((session.interpretationHold && read.failed) || (handover.hold && (read.failed || handover.hold.expired))) {
        return keepLiveNormalizer(read.failed ? 'could not read the transcript' : 'outlasted its hold on the tail')
      }
      if (!current()) return false
      try { await profile.config?.() }
      catch { return keepLiveNormalizer('could not read its runtime profile') }
      fromEnd = read
      handover.next = read.next
      historyTurnOpen = take(stream.finish())
      console.log(`[agent] ${sid(session.agentId)} read the transcript from its end · turn @${read.turnFrom} · profile @${read.profileFrom} · ${read.end} bytes${handover.hold ? ' · took over its tail' : ''}`)
    }
    // An engine without a reader from the end folds its transcript from the start, bounded: one huge
    // transcript read whole would take every agent's daemon down (the October 3 crash, on Codex). Its
    // oldest history past the cap is not folded; its last turns, which say whether it is working, are.
    let lines: string[] = []
    if (session.transcriptPath && !fromEnd) {
      const read = await tailFileCapped(session.transcriptPath, wholeReadCapBytes)
      if (read.truncated) console.warn(`[agent] ${sid(session.agentId)} transcript over ${Math.round(wholeReadCapBytes / 1024 / 1024)} MB · folded from its newest ${Math.round(wholeReadCapBytes / 1024 / 1024)} MB`)
      lines = read.lines
    }
    if (!current()) {
      if (prepared) remote!.discard(prepared)
      return false
    }
    if (!fromEnd) {
      if (closes) throw new Error('the native reader cannot yet replay ordered cancellation boundaries')
      if (observe) for (const line of lines) observe(line)
      sideRead('runtime profile', session.sessionId, () => runtimeProfiles.hydrate(session, lines))
    }
    if (!profileHydration?.config) await runtimeProfiles.ingestConfig(session, true)
    if (!current()) {
      if (prepared) remote!.discard(prepared)
      return false
    }
    // From here to the release in `attachSession` nothing is awaited for a held tail, so the hold cannot
    // expire between installing the new normalizer and handing it the tail.
    if (handover.hold?.expired) {
      if (prepared) remote!.discard(prepared)
      return keepLiveNormalizer('outlasted its hold on the tail')
    }
    const fold = (ingest: (line: string) => LiveEvent[], turnOpenAfter: () => boolean): boolean =>
      take(foldTranscript(ingest, lines, turnOpenAfter, { live: replayLive }))
    if (prepared) {
      const install = () => remote!.install(prepared!)
      if (!(session.interpretationHold ? install() : profileHydration?.commitWith ? profileHydration.commitWith(install) : install())) {
        remote!.discard(prepared); remote!.retry(session)
        return keepLiveNormalizer('was superseded while reading')
      }
      if (!session.interpretationHold && !profileHydration?.commitWith) profileHydration?.commit()
      const publish = () => { liveParsers.set(session.sessionId, prepared!.state.handle); return true }
      if (replacement) recoveryInstall = () => replacement.commit(recoveryPlan!, prepared!.state.handle)
      else publish()
    } else if (parser) {
      if (!fromEnd) historyTurnOpen = fold((line) => parser.ingest(line).events, () => parser.turnOpen)
      const install = () => { liveParsers.set(session.sessionId, parser); return true }
      if (replacement) recoveryInstall = () => replacement.commit(recoveryPlan!, parser)
      else if (profileHydration?.commitWith) {
        if (!profileHydration.commitWith(install)) return keepLiveNormalizer('was superseded while reading')
      } else { install(); profileHydration?.commit() }
    } else if (engine('cursor')) {
      const normalizer = new (engine('cursor')!).CursorNormalizer('live', session.sessionId)
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      cursorNormalizers.set(session.sessionId, normalizer)
      await runtimeProfiles.capturePane(session, captureTerminal, 100, true)
    } else if (engine('opencode')) {
      // OpenCode has no transcript file — poll its SQLite DB. The reader hydrates silently, then
      // streams new activity into the funnel (the same one the file engines use).
      const reader = new (engine('opencode')!).OpencodeReader({
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
      await runtimeProfiles.capturePane(session, captureTerminal, 100, true)
    } else if (engine('kilo')) {
      // Kilo is opencode's fork and keeps the same store shape, so it is polled the same way — but from
      // its OWN db and through its own reader, so the two can diverge without one breaking the other.
      const reader = new (engine('kilo')!).KiloReader({
        dbPath: dbs.kilo,
        sessionId: session.sessionId,
        onEvents: (events) => emit(session.sessionId, events),
        onFatal: (err) => console.warn(`[kilo] ${sid(session.sessionId)} ${err.message}`),
      })
      kiloReaders.set(session.sessionId, reader)
      await reader.start()
    } else if (engine('muse')) {
      // Same JSONL tail as claude/pi; only the record shape differs.
      const normalizer = new (engine('muse')!).MuseNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      museNormalizers.set(session.sessionId, normalizer)
    } else if (engine('amp')) {
      // A JSONL tail like claude/muse — except the file is written by the adapter's own Amp plugin,
      // because Amp is the one engine that keeps no conversation on disk.
      const normalizer = new (engine('amp')!).AmpNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      ampNormalizers.set(session.sessionId, normalizer)
    } else if (engine('grok')) {
      const normalizer = new (engine('grok')!).GrokNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      grokNormalizers.set(session.sessionId, normalizer)
      await runtimeProfiles.capturePane(session, captureTerminal, 60, true)
    } else if (engine('agy')) {
      const agy = engine('agy')!
      // A JSONL tail like claude/grok. agy announces its model only in the hook payload and its pane
      // footer, so the pane is read once on attach to fill the chip before the first turn.
      const normalizer = new agy.AgyNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      agyNormalizers.set(session.sessionId, normalizer)
      // agy's transcript has no end-of-turn record - only its Stop hook does - so a fold of a FINISHED
      // conversation still reports the last turn as open, and after a daemon restart nothing is ever
      // coming to close it. The pane is the one place the answer exists; ask it.
      const agentId = session.agentId, sessionId = session.sessionId, identity = paneReadIdentity(session)
      const revision = normalizer.turnRevision
      let observedRevision = revision
      let current = true
      historyCurrent = () => paneReadIdentity(resolve(agentId)) === identity
        && agyNormalizers.get(sessionId) === normalizer && normalizer.turnRevision === observedRevision
      const capturing = captureTerminal(agentId, 60)
      await Promise.all([
        runtimeProfiles.capturePane(session, () => capturing, 60, true),
        capturing.then(capture => {
          // Turn closing owns its own authority: accepting a chip update is not a prerequisite.
          current = paneReadIdentity(resolve(agentId)) === identity && agyNormalizers.get(sessionId) === normalizer
          if (!current) return
          if (normalizer.turnRevision !== revision) { historySuperseded = true; return }
          if (historyTurnOpen && capture && agy.agyPaneIdle(capture)) {
            normalizer.closeTurn()
            historyTurnOpen = false
          }
          observedRevision = normalizer.turnRevision
        }),
      ])
      if (!current || paneReadIdentity(resolve(agentId)) !== identity || agyNormalizers.get(sessionId) !== normalizer) {
        if (agyNormalizers.get(sessionId) === normalizer) agyNormalizers.delete(sessionId)
        return keepLiveNormalizer('changed binding while its pane was read')
      }
      if (normalizer.turnRevision !== observedRevision) historySuperseded = true
    } else if (engine('copilot')) {
      const copilot = engine('copilot')!
      // A JSONL tail like claude/agy. Its turn lifecycle comes from the agentStop hook, not the file —
      // which is exactly why a fold cannot be trusted on its own: `copilot --resume` replays a finished
      // conversation, the fold opens a turn on its last `user.message`, and no hook is coming to close
      // it. Ask the records where the last activity actually ended.
      const normalizer = new copilot.CopilotNormalizer()
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      copilotNormalizers.set(session.sessionId, normalizer)
      if (historyTurnOpen && !copilot.copilotHistoryTurnOpen(lines)) {
        normalizer.closeTurn()
        historyTurnOpen = false
      }
    } else if (engine('pi')) {
      const normalizer = new (engine('pi')!).PiNormalizer('live')
      // Hydrate state silently; never replay history live — except a turn left open, below.
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      piNormalizers.set(session.sessionId, normalizer)
    } else if (engine('hermes')) {
      // Hermes has no transcript file — poll its SQLite store, like opencode.
      const reader = new (engine('hermes')!).HermesReader({
        dbPath: await hermesDb(session),
        sessionId: session.sessionId,
        onEvents: (events) => emit(session.sessionId, events),
        onFatal: (err) => console.warn(`[hermes] ${sid(session.sessionId)} ${err.message}`),
      })
      hermesReaders.set(session.sessionId, reader)
      await reader.start()
    } else if (engine('devin')) {
      // Devin has no transcript file either — poll its SQLite store, like hermes/opencode.
      const reader = new (engine('devin')!).DevinReader({
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
      await runtimeProfiles.capturePane(session, captureTerminal, 60, true)
    } else if (engine('commandcode')) {
      const normalizer = new (engine('commandcode')!).CommandCodeNormalizer('live')
      // Hydrate state silently; never replay history live — except a turn left open, below.
      historyTurnOpen = fold((line) => normalizer.ingest(line), () => normalizer.turnOpen)
      commandcodeNormalizers.set(session.sessionId, normalizer)
    }
    if (!current()) return false
    // Close the old engine's turn before starting the tail: addSession may synchronously deliver a
    // new turn written after resume. Closing afterward would abandon that new turn instead.
    const abandonedHistory = !closes && !historySuperseded && historyTurnOpen && relaunch?.engineStarted
    if (abandonedHistory) {
      console.log(`[agent] ${sid(session.agentId)} left the turn open at attach as history · it began before its engine was started again`)
      const folds: Array<Map<string, { closeTurn(): unknown }>> = [cursorNormalizers, museNormalizers, ampNormalizers,
        grokNormalizers, agyNormalizers, copilotNormalizers, piNormalizers, commandcodeNormalizers]
      for (const fold of folds) fold.get(session.sessionId)?.closeTurn()
      const closing = prepared?.state.handle ?? parser ?? liveParsers.get(session.sessionId)
      closing?.closeTurn('abandoned')
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
        await watcher.addSession({ ...session, transcriptPath: session.transcriptPath }, {
          ...(fromEnd ? { fromOffset: fromEnd.next } : {}),
          ...(session.interpretationHold ? { deliveryAllowed: () => recoveryReady } : {}),
        })
      }
    } else if (session.engine !== 'cursor') {
      // No transcript to fold: whatever this session writes later is its FIRST content, so the re-attach
      // that brings the path must read the file whole rather than from its end.
      neverFoldedHistory.add(session.sessionId)
    }
    if (!current()) return false
    if (session.interpretationHold) {
      if (closes && fromEnd!.next < closes.at(-1)!.offset) return keepLiveNormalizer('did not reach its cancellation boundary')
      replacement!.check(recoveryPlan!)
      // Both parser and tail are installed. Reads held during watcher installation kept their cursors;
      // resume them only now, after clearing the obligation under the same evidence revision.
      if (profileHydration?.commitWith) {
        if (!profileHydration.commitWith(recoveryInstall)) return keepLiveNormalizer('was superseded during watcher installation')
      } else {
        if (!recoveryInstall()) return keepLiveNormalizer('was superseded during watcher installation')
        profileHydration?.commit()
      }
      if (!explainRecovery(session)) return keepLiveNormalizer('lost its binding while clearing the hold')
      if (relaunch) relaunchMarks!.complete(session.sessionId, relaunch)
      recoveryReady = true
      void watcher.pollSession(session.sessionId).catch(error => console.warn(
        `[agent] ${sid(session.agentId)} recovered tail read failed: ${error instanceof Error ? error.message : error}`))
    }
    if (!session.interpretationHold && relaunch) relaunchMarks!.complete(session.sessionId, relaunch)
    // Marked on the FOLD, not on the emission. A live fold that happened to produce nothing — the file
    // was still empty when this attach ran — would otherwise leave the session unmarked, and the next
    // `reset` attach (claude fires `SessionStart` on compact, which resets) would fold the by-then
    // complete transcript and emit it live on top of everything the watcher had already streamed. That
    // is the same duplicate-turn class this whole change exists to remove.
    // Any fold of a transcript with content counts too: the watcher now tails it from the end, so a later
    // replay could only send history out again as if it were live.
    if (replayLive || lines.length || fromEnd?.content) replayedFirstTurn.add(session.sessionId)
    // Installing the file watcher also yields. The final history consumer must still own the capture.
    if (historyCurrent && !historyCurrent()) historySuperseded = true
    if (!historySuperseded && initialEvents.length) {
      emit(session.sessionId, initialEvents)
      console.log(`[agent] ${sid(session.agentId)} replayed the first turn its transcript already held · ${initialEvents.length} events`)
    }
    console.log(`[agent] ${sid(session.agentId)} attached · engine=${session.engine} · terminal=${terminalLabel(session)} · session=${sid(session.sessionId)} · lines=${fromEnd ? fromEnd.records : lines.length}`)
    // A first prompt that lands while this attach is running is already in the transcript we just
    // folded, so its turn_started was consumed as history and the live turn would end up untracked.
    // Replay that one event, after the attach log, so the recovery is visible in order.
    // Not for a tail this attach took over: everything before the hold was delivered live, the turn's
    // start included. Claude Code announces its session again when it compacts, often in the middle of
    // a long turn, and replaying the start showed every window that turn starting twice
    // (e2e/compaction.e2e.ts).
    // Nor for a turn left open before a new engine was started on the conversation (a resume, or a restore
    // that rebuilt the pane): that turn died with the engine before, and announcing it showed the
    // interrupted message starting anew (core/transcripts/relaunch.ts).
    if (!session.interpretationHold && !historySuperseded && historyTurnOpen && !handover.hold && !abandonedHistory) {
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
    // The last turn was over before this attach read it (it ended while the daemon was stopped: an update, a
    // restart, a dial being flashed): its end went into history, and nothing recapped it. On 2026-10-07 a
    // Codex answer landed nine seconds into a restart and the dial showed the agent blank. The recaps recap
    // such a turn as history, once; one they already hold is left alone.
    // A fold from the end keeps only the last turn's start as history (lib/normalize.ts TranscriptFold), so a turn
    // that is no longer open is one that ended; a fold from the start keeps its end too, and says if it was killed.
    const last = historyEvents.findLast((event) => event.type === 'turn_started' || event.type === 'turn_ended')
    if (!historyExplicitlyClosed && !historySuperseded && !historyTurnOpen && last && !(last.type === 'turn_ended' && last.payload.aborted)) settled?.(session.sessionId)
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
    retryCurrent?: () => boolean,
  ): Promise<boolean> => {
    // Compaction and ordinary SessionStart also reconstruct parsers. A prior explicit closure still
    // belongs to this conversation and must survive those resets, not only native-evidence recovery.
    if (reset && turnReplacements.retains(session) && !session.identityHold && !session.interpretationHold
      && paneReadIdentity(resolve(session.agentId)) === paneReadIdentity(session)) {
      if (setInterpretationHold(session.agentId, session.evidenceRevision, 'Reapplying retained turn control.', true)) {
        session = { ...resolve(session.agentId)! }
        announceSession(session)
      } else return Promise.resolve(true)
    }
    // An unavailable identity is still the agent's binding, but grants no interpretation authority.
    // Snapshot the mutable row before yielding so a later bind cannot redirect this read's writes.
    session = { ...session, interpretationHold: resolve(session.agentId)?.interpretationHold }
    const authority = paneReadIdentity(session)
    const lifetime = lifetimes.get(session.sessionId) ?? {}
    lifetimes.set(session.sessionId, lifetime)
    const current = () => lifetimes.get(session.sessionId) === lifetime && paneReadIdentity(resolve(session.agentId)) === authority
    if (!current()) return Promise.resolve(false)
    if (session.identityHold) return Promise.resolve(true)
    // Every caller observes this obligation, including an ordinary hook racing discovery's reset.
    if (session.interpretationHold) { reset = true; replayFromStart = false; replayCursorFromStart = false }
    readerLoads.supersede(session.sessionId, authority)
    // Location is core control, outside the optional reader pool. Four stalled readers must not
    // prevent a fifth Cursor session finding its file. add records its candidate synchronously, so
    // forget's remove revokes it even while the first filesystem lookup is pending.
    if (session.engine === 'cursor' && !session.transcriptPath) {
      void cursorDiscovery.add(session.sessionId).catch(error => console.error(
        `[cursor-discovery] lookup failed: ${error instanceof Error ? error.message : error}`))
    }
    const key = session.sessionId
    pendingAttaches.set(key, (pendingAttaches.get(key) ?? 0) + 1)
    return attaches.attach(session, reset, async () => {
      // A normal attach may have taken the import's result while this retry waited for its slot.
      if (retryCurrent && !retryCurrent()) return false
      // A tail an attach holds (a Claude Code or Codex reset, see attachSessionNow) is released only
      // here, after the whole attach — the new normalizer installed and any open turn said to be open —
      // so delivery resumes into it, in order. Released on every exit, however the attach ends.
      const handover = { hold: null as TailHold | null, next: null as number | null }
      try {
        if (session.interpretationHold) {
          if (!current()) return false
          // Another queued recovery may already have fulfilled this same obligation.
          if (!resolve(session.agentId)?.interpretationHold) return true
          turnReplacements.stage(session)
          await watcher.removeSession(session.sessionId)
          if (!current()) return false
        }
        const attached = await attachSessionNow(session, current, reset, replayCursorFromStart, replayFromStart, handover)
        // A hold that arrived during the read is not evidence that the terminal disappeared.
        return attached || !!resolve(session.agentId)?.identityHold || !!resolve(session.agentId)?.interpretationHold
      } catch (error) {
        if (!session.interpretationHold) throw error
        if (current()) explainRecovery(session, `Waiting for transcript interpretation: ${error instanceof Error ? error.message : error}`)
        return true
      } finally {
        handover.hold?.release(handover.next)
        const obligation = () => {
          const latest = resolve(session.agentId)
          return lifetimes.get(session.sessionId) === lifetime && latest?.sessionId === session.sessionId && latest.evidenceRevision === session.evidenceRevision
            && !latest.identityHold && latest.interpretationHold ? latest : undefined
        }
        if (obligation() && !recoveryRetries.has(session.sessionId)) {
          // One bounded, revision-fenced retry per conversation. An unavailable reader is still work
          // to do even when its attach returned true to preserve the live binding.
          recoveryRetries.set(session.sessionId, setTimeout(() => {
            recoveryRetries.delete(session.sessionId)
            const latest = obligation()
            if (latest) void attachSession(latest, true)
          }, 1_000))
          recoveryRetries.get(session.sessionId)!.unref()
        }
      }
    }, authority).finally(() => {
      const pending = pendingAttaches.get(key)! - 1
      if (pending) pendingAttaches.set(key, pending)
      else pendingAttaches.delete(key)
    })
  }
  return { attachSession, attaches, neverFoldedHistory, replayedFirstTurn, forget, beforeCancel, afterStop, holdStop, holdAdmissionStop, holdInterpretation, captureAdmissionStop }
}

export type Attach = ReturnType<typeof createAttach>
