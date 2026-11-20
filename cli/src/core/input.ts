/**
 * Input: everything the core writes into an agent's pane. Messages, delivered turns and keys go through one
 * controller (`SessionInputController`, the shared writer and a per-pane queue while a turn is busy).
 * Correlated composer input retains that writer until the engine proves the composer available.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 5: docs/design/2026-10-03-harnessd.md);
 * what it reaches in the registry, the terminal, the deliveries and device features and the clients is passed
 * in. Every message uses the same session input operation; optional callers keep their receipts elsewhere.
 */
import type { SessionFailure } from './api.js'
import { adaptSlashCommand } from '../lib/goalCommand.js'
import { errorKind, sid } from '../lib/log.js'
import type { LiveEvent } from '../engines/kit/events.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { MoveGate } from '../lib/hostMove/gate.js'
import { OPENCLAW_NOT_READY, SessionInputController, type MessageReceipt, type SessionInputDelivery, type SessionInputDeps, type SessionInputProgress, type SessionInputRequest } from '../lib/sessionInput.js'
import { passingHold } from '../lib/messageHolds.js'
import { pasteComesAsKeys, pasteOnScreen } from '../lib/pasteOnScreen.js'
import type { ScreenReader } from '../lib/screenReader.js'
import type { SubmissionReader } from '../lib/submissionReader.js'
import type { ScreenReading } from '../engines/facets/screen.js'
import { TERMINAL_LEASE_REFUSED, terminalActionNotStarted, type TerminalActionResult } from '../lib/terminalTypes.js'
import type { TerminalControl } from './terminals/control.js'
import { launchBound } from './engines/sessionBinding.js'
import type { ShortTurnGuard } from './turns/shortTurnGuard.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface InputDeps {
  readScreen: ScreenReader
  /** Claude Code's and Codex's reading of a prompt typed into their pane, from their worker (core/engines/submissions.ts). */
  submission: SubmissionReader
  resolve: (id: string) => RegisteredSession | undefined
  activity?: (sessionId: string) => { epoch: string; revision: number } | undefined
  terminal: Pick<TerminalControl, 'captureTerminal' | 'validateTerminal' | 'submitTerminalAction' | 'keyTerminalAction' | 'pinTerminalControl'>
  /** The turns delivered under a caller's own id (core/deliveries.ts): the Wi-Fi device's, Agent Messages', the orchestrator's. */
  deliveries: {
    /** A delivery settled: its caller hears of it. */
    settled: (event: SessionInputDelivery) => void
    input?: (event: SessionInputProgress) => void
    /** Whether Agent Messages still wants one of its typed (`team:`) deliveries written. */
    canWrite: (deliveryId: string) => boolean
  }
  /** The app's unmodified session frames. */
  clients: { send(frame: Frame): void }
  failure(failure: SessionFailure): void
  agentIdFor: (sessionId: string) => string
  /** Command Code's turn opened on our paste, from outside its transcript, in its worker (core/engines/otherStreams.ts). */
  openTurn: (sessionId: string, text: string) => Promise<LiveEvent[]>
  /** An OpenClaw's run began with our paste: it is working from now (core/turns/activity.ts), on the lease any work is. */
  sending?: (sessionId: string) => void
  emit: (sessionId: string, events: LiveEvent[]) => void
  /** A prompt is about to be typed, and `capture` is the pane as read right before: what is on it belongs
   *  to the turns before the one it starts (the question watcher's, lib/askQuestion.ts `notePrompt`). */
  promptTyped?: (session: RegisteredSession, capture: string | null, screen: ScreenReading) => void
  /** The person sent text to an agent from a window or the phone (a `message` frame, by agent or session id): one
   *  another agent started is theirs from then on (services/agentCleanup.ts). */
  typed?: (id: string) => void
  /** While an agent changes host, its messages wait here and go to the pane it ends on (hostMove/gate.ts): the one
   *  gate the terminal streams hold its keystrokes in too. */
  moveGate?: MoveGate
  /** An agent whose turns keep ending at once has its automatic writes held a while (turns/shortTurnGuard.ts). */
  shortTurns?: Pick<ShortTurnGuard, 'holding'>
  /** Whether an engine's reader is starting: null when there is nothing to wait for, else whether it came up within its start
   *  wait (core/serviceLinks.ts `whenStarting`). */
  engineStarting?: (engine: string) => Promise<boolean> | null
  launchRevision?: (agentId: string) => number
  /** An agent's frame changed outside the registry (its `waitingFor`): pushed to every window again. */
  sync?: (id: string) => void
  /** An agent's first task on its row (lib/registry.ts): moved back from typed to waiting untyped before its OpenClaw box
   *  is cleared (`untypeFirstTask`), true once saved; typed again when that clear did not empty the box (`retypeFirstTask`),
   *  true once saved; and let go once a turn took it (`firstTaskTaken`), true once saved. */
  firstTask?: {
    untype(agentId: string, text: string): Promise<boolean>
    retype(agentId: string, text: string): Promise<boolean>
    taken(agentId: string, text?: string): Promise<boolean>
  }
}

/**
 * The one way a message reaches an agent's pane: a person's from the app or the phone (the relay hands
 * the phone's over as the same `message` frame), the orchestrator's, Agent Messages', and the Device's alike.
 * The pane is read right before the paste, by the caller that holds the pane's write lock, and nothing
 * is typed into a dialog, a menu or a view a message does not belong in (messageHold.ts): the reason
 * comes back instead, with nothing written. `hold` adds a caller's own check of the same reading (a
 * delivery from Agent Messages, which waits for a draft too). The pane is read again once the text is in, right before its
 * Enter: a dialog opened in between (a long or multi-line paste waits up to 1.5 s for the engine to take
 * it, mid-turn) keeps the Enter from being pressed, which would answer it, and the text waits in the
 * composer, unsent (sessionInput.ts says so). A list of suggestions opened by the message itself is no
 * reason. `submitTerminalAction` is called here and nowhere else in this file, and input.spec.ts keeps
 * it so.
 */
export function messageWriter({ readScreen, resolve, terminal: { captureTerminal, validateTerminal, submitTerminalAction }, promptTyped }: Pick<InputDeps, 'resolve' | 'terminal' | 'promptTyped' | 'readScreen'>) {
  return async (id: string, text: string, hold?: (session: RegisteredSession, screen: ScreenReading | null, capture: string | null) => string | null, current: () => boolean = () => true, onPaste?: () => void): Promise<TerminalActionResult> => {
    if (!current()) return terminalActionNotStarted('caller_gone')
    const session = resolve(id)
    if (!session) return terminalActionNotStarted('terminal agent is unavailable')
    // The engine first, then its screen. A check of the engine can wait, seconds, for an answer: a probe
    // a held event loop timed out, a restart still recording its new engine (TerminalBackendCoordinator
    // validateRuntime). Read before that wait, the screen was judged as it was then, and a permission
    // prompt opened meanwhile, or a new engine's first screen, took the paste and its Enter. An engine
    // not there is refused as a lease is, which the caller asks again.
    if (!await validateTerminal(session)) return terminalActionNotStarted(TERMINAL_LEASE_REFUSED)
    if (!current()) return terminalActionNotStarted('caller_gone')
    const capture = await captureTerminal(id)
    if (!current()) return terminalActionNotStarted('caller_gone')
    const screen = await readScreen(session, capture)
    if (!current()) return terminalActionNotStarted('caller_gone')
    if (!screen) return terminalActionNotStarted(hold?.(session, null, capture) ?? 'screen_unreadable')
    const reason = hold?.(session, screen, capture) ?? screen.messageHold
    if (reason) return terminalActionNotStarted(reason)
    promptTyped?.(session, capture, screen)
    onPaste?.()
    return submitTerminalAction(id, text, {
      allowed: current,
      beforeEnter: async () => {
        if (!current()) return 'caller_gone'
        if (pasteComesAsKeys(session.engine)) {
          const landed = await pasteOnScreen(async () => {
            const now = await captureTerminal(id)
            return { draft: (await readScreen(launchBound(session, resolve(id)), now))?.pane.draft === true, screen: now }
          }, capture)
          if (!landed) console.warn(`[inject] ${sid(id)} the paste did not show in its composer in time; pressing Enter anyway`)
        }
        // A read that came back empty, or a composer caught between frames, is asked again for a moment
        // (a re-attach can blank one capture): only what is on screen holds the Enter back, never a
        // read that failed once. Still not read after that, it is held, as nothing says it is safe.
        for (let tries = 1; ; tries++) {
          // Read under the record as it now stands when it is the launch typed into, bound to its first
          // conversation since (sessionBinding.ts `launchBound`); under any other change, as typed, which
          // the reading's fence refuses.
          const capture = await captureTerminal(id)
          const next = await readScreen(launchBound(session, resolve(id)), capture)
          if (!current()) return 'caller_gone'
          const before = next ? next.messageHold : 'screen_unreadable'
          if (before === 'popup_open') return null
          if (!before) return null
          if (!passingHold(before) || tries >= ENTER_CHECK_TRIES) {
            // The screen's size, never its rows: they hold the person's typed message and the transcript.
            const read = capture === null ? 'unread' : `${capture.split('\n').length} rows, ${capture.length} chars`
            console.warn(`[inject] ${sid(id)} Enter held · ${before} · screen ${read}`)
            return before
          }
          await new Promise((settle) => setTimeout(settle, ENTER_CHECK_RETRY_MS))
        }
      },
    })
  }
}

/** How long the check before a message's Enter asks again after a read that says nothing: 3 s. */
const ENTER_CHECK_TRIES = 12
const ENTER_CHECK_RETRY_MS = 250

/**
 * What holds a message from an OpenClaw pane as read: one the pane cannot send yet (Gateway not connected, history not
 * loaded, a run going) OpenClaw puts back in its input box, where nothing sends it. So it is typed only into a pane
 * ready with an empty box, its idle reading (engines/openclaw/runtimeProfile.ts), and waits for one (lib/sessionInput.ts).
 */
function openclawHold(session: RegisteredSession, screen: ScreenReading | null): string | null {
  return session.engine === 'openclaw' && !screen?.pane.idle ? OPENCLAW_NOT_READY : null
}

/**
 * What holds a pane's own command (OpenClaw's `/session`) from the pane as read: text in its input box, the person's or a
 * message OpenClaw refused, which the command's Enter would send with it, or a pane not read, which may hold some. Not
 * whether the pane can send a message: the command is what makes one whose history failed to load able to.
 */
function commandHold(_session: RegisteredSession, screen: ScreenReading | null, capture: string | null): string | null {
  return capture === null ? 'screen_unreadable' : screen?.pane.draft ? 'box_not_empty' : null
}

/** What holds a typed delivery from the pane as read: the same draft and dialog checks as a person's own message. */
function paneHold(screen: ScreenReading | null): string | null {
  return screen ? screen.teamHold : 'team_waiting_unavailable'
}

/** The pane as a typed delivery's write first reads it (`beforeTeamWrite`), and what holds it there. Before the pane is read, an
 *  agent the short-turn guard holds: its deliveries are asked again every second. */
async function readTeamHold(deps: Pick<InputDeps, 'readScreen' | 'shortTurns' | 'terminal'>,
  session: RegisteredSession): Promise<{ capture: string | null; screen: ScreenReading | null; hold: string | null }> {
  if (deps.shortTurns?.holding(session.sessionId)) return { capture: null, screen: null, hold: 'team_waiting_control' }
  const capture = await deps.terminal.captureTerminal(session.agentId)
  const screen = await deps.readScreen(session, capture)
  return { capture, screen, hold: paneHold(screen) }
}

/** What `SessionInputController` is given: every write takes its shared pane writer first. */
export function sessionInputDeps(
  deps: InputDeps,
): SessionInputDeps {
  const { resolve, terminal, deliveries, clients, agentIdFor, openTurn, emit, firstTask } = deps
  const { captureTerminal, validateTerminal, keyTerminalAction } = terminal
  const writeMessage = messageWriter(deps)
  return {
    ...(deps.moveGate ? { moveGate: deps.moveGate } : {}),
    ...(firstTask ? {
      untypeFirstTask: (id: string, text: string) => firstTask.untype(id, text),
      retypeFirstTask: (id: string, text: string) => firstTask.retype(id, text),
      // The frame read starting from the row's typed task until now: the windows hear it no longer is. One the row keeps,
      // OpenClaw's store or the binding pass's bound settles (core/agents/bind.ts).
      onFirstTaskTaken: (id: string, text?: string) => {
        void (text === undefined ? firstTask.taken(id) : firstTask.taken(id, text)).then((taken) => { if (taken) deps.sync?.(id) },
          (error: unknown) => console.error(`[agent] ${sid(id)} first task typed kept · ${errorKind(error)}`))
      },
    } : {}),
    readScreen: deps.readScreen,
    submission: deps.submission,
    getSession: (id) => resolve(id),
    onDelivery: (event) => {
      deliveries.settled(event)
    },
    onInput: (event) => {
      const activity = event.phase === 'dispatching' && event.sessionId && resolve(event.agentId)?.sessionId === event.sessionId
        ? deps.activity?.(event.sessionId) : undefined
      deliveries.input?.({ ...event, ...(activity ? { activity: { epoch: activity.epoch, revision: activity.revision } } : {}) })
    },
    beforeTeamWrite: async (session) => (await readTeamHold(deps, session)).hold,
    validateRuntime: validateTerminal,
    // Both messages and engine commands use the shared writer and retain the caller's authority.
    inject: (id, text, current, onPaste) => writeMessage(id, text, openclawHold, current, onPaste),
    injectCommand: (id, line, current) => writeMessage(id, line, commandHold, current),
    // An Agent Messages turn waits for a ready composer, and for its mailbox to still want it written.
    injectTeam: async (id, text, deliveryId, current, onPaste) => {
      if (!resolve(id)) return terminalActionNotStarted('team_waiting_unavailable')
      return writeMessage(id, text, (_session, screen) => paneHold(screen)
        ?? (deliveries.canWrite(deliveryId) ? null : 'team_waiting_control'), current, onPaste)
    },
    sendKey: keyTerminalAction,
    capture: captureTerminal,
    engineStarting: (session) => deps.engineStarting?.(session.engine) ?? null,
    launchRevision: deps.launchRevision,
    // The app hears that the message waits, and why: it shows the agent as starting until the message is typed or refused (`error`).
    onWaitChanged: (id) => deps.sync?.(id),
    onWaiting: (sessionId, reason) => {
      clients.send({ type: 'message_waiting', agentId: agentIdFor(sessionId), dbSessionId: sessionId, payload: { reason } })
    },
    onError: (sessionId, message) => {
      const agentId = agentIdFor(sessionId)
      clients.send({ type: 'error', agentId, dbSessionId: sessionId, payload: { message } })
      const engine = resolve(sessionId)?.engine
      deps.failure({ agentId, sessionId, ...(engine ? { engine } : {}), message })
    },
    // Command Code writes its transcript only once the turn is OVER, so a turn that calls no tool has
    // nothing to announce it: measured on 1.28.4, "hi" produced turn_started and turn_ended 1ms apart
    // and neither web nor device ever showed the agent working. Our own paste is the one moment a turn
    // is known to have started — and the only one that also knows the text.
    onSubmitted: (id, content) => {
      // `id` is whatever the caller addressed the agent by — in the inject path it is the AGENT id, not
      // the session id, and the normalizer map is keyed by session. Resolve before looking anything up.
      const session = resolve(id)
      // OpenClaw draws the run at once (`sending`), and its first row comes only when its Gateway writes it, 15-45 s on a
      // slow one: until then nothing else tells the agent's frame it works, and `ps` read it idle.
      if (session?.engine === 'openclaw' && session.sessionId) deps.sending?.(session.sessionId)
      if (session?.engine !== 'commandcode' || !session.sessionId) return
      const sessionId = session.sessionId
      void openTurn(sessionId, content).then(events => { if (events.length) emit(sessionId, events) })
    },
  }
}

export function createInput(deps: InputDeps) {
  const { resolve, terminal: { pinTerminalControl } } = deps
  const input: SessionInputController = new SessionInputController(sessionInputDeps(deps))
  const acquireTerminalControl = (id: string, opts?: { forAnswer?: boolean }): (() => void) | null => {
    const agentId = resolve(id)?.agentId ?? id
    const releaseInput = input.acquireControl(agentId, opts)
    if (!releaseInput) return null
    const releaseTerminal = pinTerminalControl(agentId)
    if (!releaseTerminal) {
      releaseInput()
      return null
    }
    return () => {
      releaseTerminal()
      releaseInput()
    }
  }
  // A held delivery is retried by the backend every second; it is the same message, so the receive is
  // logged once per delivery id instead of once per attempt. Bounded: an id that has scrolled out is
  // logged again rather than remembered for the life of the daemon.
  const loggedDeliveries = new Set<string>()
  const firstReceipt = (deliveryId: string | undefined): boolean => {
    if (!deliveryId) return true
    if (loggedDeliveries.has(deliveryId)) return false
    loggedDeliveries.add(deliveryId)
    if (loggedDeliveries.size > 256) {
      // Above 256 entries the set always has a first one; the type says `undefined` because an empty set has none.
      loggedDeliveries.delete(loggedDeliveries.values().next().value!)
    }
    return true
  }
  const submitAgent = (id: string, content: string, deliveryId?: string, receipt?: MessageReceipt, request?: SessionInputRequest): void => {
    const record = resolve(id)
    const sessionId = record?.sessionId ?? id
    const engine = record?.engine ?? 'claude'
    // The backend prepends `/goal ` or `/loop ` without knowing the engine (on the routed path it has
    // not picked an agent yet when the mode is chosen). This is the one place that always knows, so the
    // per-engine adaptation happens here — an unknown slash command would otherwise land as a visible
    // error in the user's terminal instead of running their turn.
    const adapted = adaptSlashCommand(content, engine)
    const log = firstReceipt(deliveryId)
    if (log && adapted !== content) {
      console.log(`[msg] ${sid(sessionId)} slash-command adapted for engine=${engine}`)
    }
    if (log) console.log(`[msg] ${sid(sessionId)} recv · engine=${engine} · bytes=${Buffer.byteLength(adapted, 'utf8')}`)
    const target = record?.agentId ?? sessionId
    input.submitInput(target, { when: deliveryId ? 'turn' : 'composer', ...request, content: adapted, deliveryId, receipt })
  }
  const submitInput = (id: string, request: SessionInputRequest): void => submitAgent(id, request.content, request.deliveryId, request.receipt, request)
  const messageRequest = createMessageRequest((id, content, receipt) => submitAgent(id, content, undefined, receipt), deps.typed)
  return { input, acquireTerminalControl, submitAgent, submitInput, messageRequest }
}

/**
 * Takes a `message` frame: text a person typed for an agent, into its pane. Nothing is answered: the
 * transcript lines the text produces drive the turn back to every window (mirror-all), with no synthetic
 * events here. A `tabId` an older window still sends is not read.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
export function createMessageRequest(submit: (id: string, content: string, receipt?: MessageReceipt) => void, typed?: (id: string) => void) {
  // [receipt]: what became of it, for the request's measurement (lib/sessionInput.ts `MessageReceipt`).
  return (payload: Record<string, unknown>, receipt?: MessageReceipt): void => {
    const content = payload.content as string | undefined
    const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
    if (!content || !target) { receipt?.('invalid'); return }
    // A `message` frame is a person's: the windows' and the phone's composer. Agents and experiments deliver theirs
    // under a delivery id (`turns.deliver`), which never comes this way.
    typed?.(target)
    // From the relay this is only reached sealed: text typed into an agent is never taken from the relay
    // in the clear.
    submit(target, content, receipt)
  }
}

export type Input = ReturnType<typeof createInput>
