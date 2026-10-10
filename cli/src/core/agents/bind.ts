/**
 * Binding: a session to its agent (`handleRegistered`, after the registry took a hook's or a discovery's
 * registration) and a running engine process to the session it is in (`bindObservedAgent`, from the
 * reconciler's scans: a resume named on the command line, a session the process changed to without a
 * hook, or one repaired by looking for it).
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 10: docs/design/2026-10-03-harnessd.md).
 */
import { stat } from 'node:fs/promises'
import { transcriptOf, processSessionOf } from '../../engines/identities.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'
import { cursorDataDir } from '../../engines/cursor/contract.js'
import { continuationOf } from '../../engines/sessionFiles.js'
import { sessionStoreOf } from '../../engines/sessionStoreContracts.js'
import type { TurnRecaps } from '../turns/recaps.js'
import { paneReadIdentity } from '../transcripts/readIdentity.js'
import type { AutonomousDeviceInput } from '../deviceInput.js'
import { isRecentlyDeleted } from '../../lib/deletedSessions.js'
import { transcriptIsFirstTurn } from '../../lib/firstTurnReplay.js'
import { sid } from '../../lib/log.js'
import { projectDisplayName, type registry, type RegisteredSession } from '../../lib/registry.js'
import type { SessionInputController } from '../../lib/sessionInput.js'
import { findLiveSession, findResumedTranscript } from '../../lib/sessionRepair.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import type { SwarmPromptScopes } from '../../teams/promptScope.js'

/** Between session-binding attempts for a process whose engine store is not resolvable yet. */
const REPAIR_RETRY_MS = 60_000
/** A NEW process is waiting for a session that is about to appear. Muse makes
 *  this concrete — its session is only claimable once the user has typed, because a file with no turn in
 *  it cannot be told apart from the ones muse opens for itself. Backing off a full minute there costs the
 *  FIRST message: the pane answers while web and device show nothing. So keep sweeping for a while first,
 *  then settle into the slow rhythm for processes that will never resolve. */
const REPAIR_EAGER_ATTEMPTS = 24   // ≈2 min at the 5s sweep

/** Birth time of a transcript in ms, or 0 when it cannot be read (treated as "not newer than the agent").
 *  A filesystem that keeps no birth time reports 0 for it: the change time, then the write time, stand in. */
export async function statBirthMs(path: string, statFile: (path: string) => Promise<{ birthtimeMs: number; ctimeMs: number; mtimeMs: number }> = stat): Promise<number> {
  const st = await statFile(path).catch(() => null)
  if (!st) return 0
  const birth = st.birthtimeMs || st.ctimeMs || st.mtimeMs
  return Number.isFinite(birth) ? birth : 0
}

/** What the registry says about a registration it just took. */
export type RegisteredMeta = {
  isNew: boolean
  evicted: string | null
  rebound: string | null
  orphaned?: { agentId: string; sessionId: string } | null
  hookEvent?: string
}

export interface BindDeps {
  registry: Pick<typeof registry, 'inheritName' | 'unbindSession' | 'byAgent' | 'byProcess' | 'register' | 'has' | 'bySession'>
  mirror: Pick<TurnRecaps, 'inheritSummary'>
  forgetSession: (id: string, opts?: { force?: boolean; keepAgent?: boolean; agentId?: string }) => void
  /** The app. */
  clients: { send(frame: { type: string; payload: Record<string, unknown> }): void }
  attachSession: (session: RegisteredSession, reset?: boolean, replayCursorFromStart?: boolean, replayFromStart?: boolean) => Promise<boolean>
  announceSession: (session: RegisteredSession) => void
  stoppedAgents: Pick<StoppedAgentStore, 'save' | 'finishResume' | 'get'>
  syncRecapPool: () => void
  teams: Pick<SwarmPromptScopes, 'forget'>
  input: Pick<SessionInputController, 'forget'>
  deviceInput: Pick<AutonomousDeviceInput, 'forget'>
  /** Where Copilot, Grok and agy keep their sessions. */
  homes: { copilot: string; grok: string; agy: string }
}

export function createBinding({
  registry, mirror, forgetSession, clients, attachSession, announceSession, stoppedAgents, syncRecapPool, teams,
  input, deviceInput, homes,
}: BindDeps) {
  /**
   * Forks whose engine session has not reported in yet, agentId → the SOURCE's sessionId. A fork's tile
   * should open with the source's last recap on it, the way its pane opens with the source's transcript
   * — but the mirror keys by session, and the fork's session id is the engine's to name, minutes later
   * over a hook. Settled the moment it binds, below.
   */
  const pendingForkInherit = new Map<string, string>()
  /** Whether a stop, restart, retarget or resume owns the agent right now (`whileChanging`). */
  let changing: (agentId: string) => boolean = () => false

  const handleRegistered = async (entry: RegisteredSession, meta: RegisteredMeta): Promise<void> => {
    const authority = paneReadIdentity(entry)
    const current = () => paneReadIdentity(registry.byAgent(entry.agentId)) === authority
    if (!current()) return
    const forkSource = pendingForkInherit.get(entry.agentId)
    if (forkSource && entry.sessionId) {
      pendingForkInherit.delete(entry.agentId)
      mirror.inheritSummary(forkSource, entry.sessionId)
    }
    if (meta.rebound) {
      registry.inheritName(meta.rebound, entry.sessionId)
      mirror.inheritSummary(meta.rebound, entry.sessionId)
      forgetSession(meta.rebound, { force: true, keepAgent: true })
      clients.send({ type: 'session_reset', payload: { staleSessionId: meta.rebound } })
      console.log(`[agent] ${sid(entry.agentId)} rebound ${sid(meta.rebound)} → ${sid(entry.sessionId)}`)
    } else if (meta.evicted) {

      forgetSession(meta.evicted, { force: true })
    }
    // The agent this bind emptied out — `claude --resume` in a second pane, with
    // the first one's engine already gone. The registry dropped it; without this
    // the app kept showing it until someone hit Reload machines by hand, and
    // opening it landed on TERMINAL FROZEN because it has nothing left to open.
    //
    // Not part of the chain above: a rebound bind can orphan an agent too, so
    // this has to be asked independently of which branch ran.
    if (meta.orphaned) {
      forgetSession(meta.orphaned.agentId, {
        force: true,
        agentId: meta.orphaned.agentId,
      })
    }

    // Registration is complete before any optional history reader runs. In particular a stalled
    // module cannot withhold a resumed agent's record, name or announcement. Capture this fact before
    // finishResume changes the stopped record used to decide whether history may be replayed below.
    const resumedConversation = !!entry.resumeOnly && stoppedAgents.get(entry.agentId)?.sessionId === entry.sessionId
    try {
      stoppedAgents.save(entry)
    } catch (error) {
      console.error(`[agent] ${sid(entry.agentId)} could not save the record it resumes from: ${error instanceof Error ? error.message : error}`)
    }
    if (entry.resumeOnly) stoppedAgents.finishResume(entry.agentId)
    syncRecapPool()
    if (meta.isNew) {
      registry.inheritName(entry.agentId, entry.sessionId)
      announceSession(entry)
      clients.send({
        type: 'session_synced',
        payload: {
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          title: projectDisplayName(entry),
          createdAt: new Date(entry.boundAt ?? Date.now()).toISOString(),
        },
      })
    }

    // agy is excluded for the same reason as cursor, arriving by a different road: it has no
    // session-start event at all. The closest thing is `PreInvocation`, which fires before EVERY model
    // round-trip — four to seven times in one measured turn — and each one re-folded the transcript and
    // re-emitted `turn_started` for a turn already open (measured: two turn_started, one turn_ended).
    // Its first bind is covered by `meta.isNew`, and registry derives the transcript path from the
    // conversation id, so nothing here depends on a later announcement carrying it.
    // Copilot joins cursor and agy for a third reason: it announces the SAME turn twice. Its
    // `userPromptSubmitted` and `sessionStart` hooks both register (measured 2.5s apart, and in that
    // order — sessionStart fires AFTER the first prompt), so treating the second as a reset re-folded
    // the transcript and emitted a second `turn_started` for one exchange.
    const reset = meta.isNew
      || (entry.engine !== 'cursor' && entry.engine !== 'agy' && entry.engine !== 'copilot'
        && meta.hookEvent === 'SessionStart')
    // Deliberately NOT gated on `meta.isNew`. `isNew` is false in exactly the case this is meant to catch:
    // a session announced once BEFORE its transcript exists and registered again when the file appears —
    // the second announcement is the only one that can carry the path, and it reports `isNew=false`
    // (measured: `[hooks] 019fff7f SessionStart · engine=codex · isNew=false`, whose whole first turn was
    // then folded away as history and never reached web or device).
    //
    // `statBirthMs >= registeredAt` is what actually separates the two cases. Measured on one machine,
    // same claude session, transcript birth relative to each timestamp:
    //
    //             first turn      resumed (`claude --continue`)
    //   registeredAt   +18.1s          -81.5s      ← separates cleanly
    //   boundAt         -0.5s          -81.6s      ← negative for BOTH; useless as a test
    //
    // so the birth-vs-`registeredAt` comparison stays, and comparing against `boundAt` instead — the
    // obvious-looking alternative, since `boundAt` is when this session was bound — does not work: the
    // transcript is created a moment BEFORE the hook binds it.
    //
    // And only while the file is new (`transcriptIsFirstTurn`): a long session's transcript was born after
    // its agent too, and after a daemon restart its next SessionStart replayed the whole history live.
    //
    // And never for the conversation a resume put back: its transcript existed before the row did,
    // whatever its birth says against the row's ORIGINAL `registeredAt`, which a resume keeps. Replaying
    // it sent the whole first turn out again as live, and a turn the stopped process had left open was
    // announced as running with nothing left to end it (found end to end: stop in the middle of a first
    // turn, resume, and the agent read as working for good). A new session started in the agent after
    // the resume is not this conversation, and is judged like any other.
    const bornAfterAgent = !resumedConversation && transcriptIsFirstTurn(
      entry,
      entry.transcriptPath ? await statBirthMs(entry.transcriptPath) : 0,
      { rebound: !!meta.rebound, now: Date.now() },
    )
    if (!current()) return
    const attached = await attachSession(entry, reset, entry.engine === 'cursor', bornAfterAgent)
    // The registry mutates rows in place. This completion cannot unbind or re-announce a later
    // conversation, nor an agent that Stop has already retired.
    if (!current()) return
    if (!attached) {
      // A terminal reads as gone while a stop or a restart ends its engine. A registration that comes in
      // then, such as the old engine's own SessionStart arriving late on a loaded machine, is still the
      // agent's conversation, and the operation owns what happens to it. Unbound, a stop that had just
      // signalled the engine found the conversation changed and gave up, leaving an active agent with no
      // engine; and a second restart queued behind a first found no conversation to resume and started a
      // fresh one (e2e/races.e2e.ts). The binding stands while one of them runs: a stop retires it, and a
      // restart's new engine registers it again.
      // The October 6 TUI picker exit/resume incident: a verified engine exited while its startup
      // attach was pending. Unbinding here erased the conversation before discovery retired it, so
      // Open started a fresh one under the saved title. Keep that verified id for the existing lifecycle.
      if (!changing(entry.agentId) && !entry.processIdentity) registry.unbindSession(entry.sessionId)
      announceSession(entry)
      return
    }
  }

  const lastRepairAttempt = new Map<string, number>()
  const repairAttempts = new Map<string, number>()
  // Binding is committed before optional interpretation starts. A missing reader must not hold the
  // discovery pass (and therefore readiness) or prevent another process from being bound.
  const followRegistered = (entry: RegisteredSession, meta: RegisteredMeta): void => {
    void handleRegistered(entry, meta).catch(error => console.error(
      `[agent] ${sid(entry.agentId)} transcript attachment is unavailable: ${error instanceof Error ? error.message : error}`))
  }
  const ownTranscript = (engine: 'cursor' | 'grok' | 'agy' | 'copilot', sessionId: string, cwd: string): Promise<string | null> =>
    transcriptOf(engine, engine === 'cursor' ? cursorDataDir() : homes[engine], sessionId, cwd)
  const bindObservedAgent = async (observed: DiscoveredTerminalAgent): Promise<void> => {
    const agent = registry.byProcess(observed.engine, observed.processIdentity)
    if (!agent) return
    const authority = paneReadIdentity(agent)
    const current = () => !changing(agent.agentId) && !isRecentlyDeleted(agent.agentId)
      && paneReadIdentity(registry.byProcess(observed.engine, observed.processIdentity)) === authority
    // Only native reads are contained here. A rejected lookup cannot end the serial
    // discovery/readiness pass or bind an unwritten session as if evidence were absent.
    const read = async <T>(work: () => Promise<T>): Promise<{ value: T } | null> => {
      try { return { value: await work() } }
      catch (error) {
        if (current()) console.log(`[discovery] ${sid(agent.agentId)} binding held · ${error instanceof Error ? error.message : error}`)
        return null
      }
    }
    const mayClaim = (id: string): boolean => {
      if (isRecentlyDeleted(id)) return false
      const owner = registry.bySession(id)
      if (!owner || owner.agentId === agent.agentId) return true
      const observedStarted = Date.parse(observed.processIdentity.startMarker)
      const ownerStarted = Date.parse(owner.processIdentity?.startMarker ?? '')
      return !Number.isFinite(ownerStarted) || (Number.isFinite(observedStarted) && observedStarted > ownerStarted)
    }

    // Copilot can change session WITHOUT changing process: `/resume` inside the CLI opens another one,
    // and the pane then shows a conversation the daemon is not streaming. Every other engine here
    // starts a new process for that, which is why this path used to stop at `agent.sessionId`.
    //
    // The switch leaves exactly one trace — the `inuse.<pid>.lock` Copilot takes on the new session
    // directory. It writes nothing to the transcript and fires no hook until the next prompt.
    if (agent.resumeOnly && agent.launch && agent.launch.state !== 'ready') return
    if (agent.sessionId) {
      if (observed.engine === 'copilot') {
        const process = await read(() => processSessionOf('copilot', homes.copilot, observed.processIdentity.pid))
        if (!process) return
        const next = process.value
        if (!next || next === agent.sessionId || isRecentlyDeleted(next)) return
        const located = await read(async () => {
          const path = await transcriptOf('copilot', homes.copilot, next)
          if (await processSessionOf('copilot', homes.copilot, observed.processIdentity.pid) !== next) {
            throw new IdentityReadUnavailable('the process conversation changed during transcript lookup')
          }
          return path
        })
        if (!located) return
        const transcript = located.value
        if (!current() || !mayClaim(next)) return
        console.log(`[discovery] ${sid(agent.agentId)} switched copilot session ${sid(agent.sessionId)} → ${sid(next)} (/resume)`)
        const rotated = registry.register({
          engine: 'copilot',
          sessionId: next,
          transcriptPath: transcript ?? undefined,
          cwd: observed.cwd,
          source: 'copilot-resume',
          runtimes: observed.runtimes,
          primaryRuntimeKey: observed.primaryRuntimeKey,
          processIdentity: observed.processIdentity,
          hookEvent: 'CopilotResume',
        })
        if (rotated?.isNew) followRegistered(rotated.entry, rotated)
        return
      }
      // Claude can also change session WITHOUT any hook firing: a long conversation's transcript
      // rolls over to a new file on its own (compaction/a resume chain), and if the turn that follows
      // lands on a pooled/"spare" worker process rather than one spawned fresh in the pane, no
      // SessionStart/UserPromptSubmit ever reaches us for it — the agent is left bound to a transcript
      // that has gone quiet forever while the real conversation continues one file over. Checked on
      // the same cadence this reconciler already re-observes every live process, so it costs nothing
      // extra to ask. Its session store declares the marker (`continuation`), read in core with the kit.
      const store = sessionStoreOf(observed.engine)
      if (store?.continuation && agent.transcriptPath) {
        const located = await read(() => continuationOf(observed.engine, agent.transcriptPath!))
        if (!located) return
        const continuation = located.value
        if (!continuation || continuation.sessionId === agent.sessionId
          || registry.has(continuation.sessionId) || isRecentlyDeleted(continuation.sessionId)) return
        if (!current()) return
        console.log(`[discovery] ${sid(agent.agentId)} ${observed.engine} session continued ${sid(agent.sessionId)} → ${sid(continuation.sessionId)}`)
        const rotated = registry.register({
          engine: observed.engine,
          sessionId: continuation.sessionId,
          transcriptPath: continuation.transcriptPath,
          cwd: observed.cwd,
          source: `${observed.engine}-continuation`,
          runtimes: observed.runtimes,
          primaryRuntimeKey: observed.primaryRuntimeKey,
          processIdentity: observed.processIdentity,
          hookEvent: `${store.label}Continuation`,
        })
        if (rotated?.isNew) followRegistered(rotated.entry, rotated)
        return
      }
      return
    }

    let sessionId = observed.resumeSessionId
    let transcriptPath: string | undefined
    let hermesHome: string | undefined
    let source = 'terminal-resume'
    if (sessionId) {
      if (!mayClaim(sessionId)) return
      const located = await read(async () => observed.engine === 'cursor' || observed.engine === 'grok' || observed.engine === 'agy' || observed.engine === 'copilot'
        ? await ownTranscript(observed.engine, sessionId!, observed.cwd) ?? undefined
        : observed.engine === 'claude' || observed.engine === 'codex'
          ? await findResumedTranscript(observed.engine, sessionId!, { codexHome: agent.codexHome ?? undefined }) ?? undefined
          : undefined)
      if (!located) return
      transcriptPath = located.value
      // The registry refuses a claude/codex session without its file, so a resume of a transcript this
      // machine does not have is not a session — the hook that follows the user's next prompt will say.
      if ((observed.engine === 'cursor' || observed.engine === 'grok' || observed.engine === 'claude' || observed.engine === 'codex')
        && !transcriptPath) return
    } else {
      const attempts = repairAttempts.get(agent.agentId) ?? 0
      const lastAttempt = lastRepairAttempt.get(agent.agentId) ?? 0
      if (attempts >= REPAIR_EAGER_ATTEMPTS && Date.now() - lastAttempt < REPAIR_RETRY_MS) return
      lastRepairAttempt.set(agent.agentId, Date.now())
      repairAttempts.set(agent.agentId, attempts + 1)
      const startedAtMs = Date.parse(observed.processIdentity.startMarker)
      if (!Number.isFinite(startedAtMs)) return
      // agy cannot be found by directory — its repair reads the presence lock the process holds open.
      //
      const located = await read(() => findLiveSession(observed.engine, observed.cwd, startedAtMs, {
        bornOnly: true,
        pid: observed.processIdentity.pid,
        expectedProcess: observed.processIdentity,
        codexHome: agent.codexHome ?? undefined,
        hermesHome: agent.hermesHome ?? undefined,
      }))
      if (!located) return
      const found = located.value
      if (!found || registry.has(found.sessionId) || isRecentlyDeleted(found.sessionId)) return
      sessionId = found.sessionId
      transcriptPath = found.transcriptPath
      // Which Hermes home the repair found it in, so the row starts life reading the right store
      // rather than looking it up again on its first poll.
      hermesHome = found.hermesHome
      source = 'process-repair'
    }

    if (!current() || !mayClaim(sessionId)) return
    const previousOwner = registry.bySession(sessionId)
    const result = registry.register({
      engine: observed.engine,
      sessionId,
      transcriptPath,
      ...(hermesHome ? { hermesHome } : {}),
      cwd: observed.cwd,
      source,
      runtimes: observed.runtimes,
      primaryRuntimeKey: observed.primaryRuntimeKey,
      processIdentity: observed.processIdentity,
      hookEvent: source === 'terminal-resume' ? 'TerminalResumeDiscovery' : 'ProcessRepair',
    })
    if (!result || !result.isNew) return
    if (previousOwner && previousOwner.agentId !== result.entry.agentId) {
      teams.forget(previousOwner.agentId)
      input.forget(previousOwner.agentId)
      deviceInput.forget(previousOwner.agentId)
      announceSession(previousOwner)
    }
    lastRepairAttempt.delete(agent.agentId)
    repairAttempts.delete(agent.agentId)
    followRegistered(result.entry, result)
    console.log(`[discovery] bound ${observed.engine} session ${sid(result.entry.sessionId)} via ${observed.primaryRuntimeKey}`)
  }
  return {
    pendingForkInherit, handleRegistered, bindObservedAgent,
    /** Set by cli.ts once the lifecycle operations exist: they are made long after the binding. */
    whileChanging: (test: (agentId: string) => boolean): void => { changing = test },
  }
}
