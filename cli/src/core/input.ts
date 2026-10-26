/**
 * Input: everything the core writes into an agent's pane. Messages, delivered turns and keys go through one
 * controller (`SessionInputController`, a per-pane queue while a turn is busy); the Harness device's own
 * route (`AutonomousDeviceInput`) owns the pane writer lock, and every write from the controller takes it
 * first (`legacyWrite`), so a person answering on a device and the core never interleave in one pane.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 5: docs/design/2026-10-03-harnessd.md);
 * what it reaches in the registry, the terminal, the deliveries and device features and the clients is passed
 * in. The two controllers' dependencies are built by `sessionInputDeps` and `deviceInputDeps`, each given
 * the other controller lazily: each one calls into the other.
 */
import { AutonomousDeviceInput, type DeviceInputDeps } from './deviceInput.js'
import type { WifiFeed } from './wifi.js'
import type { CommandCodeNormalizer } from '../engines/commandcode/normalizer.js'
import { deviceErrorText } from './cardText.js'
import { adaptSlashCommand } from '../lib/goalCommand.js'
import { sid } from '../lib/log.js'
import { redactSecretsInText } from '../lib/logBundle.js'
import type { LiveEvent } from '../engines/kit/events.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { MoveGate } from '../lib/hostMove/gate.js'
import { SessionInputController, type MessageReceipt, type SessionInputDelivery, type SessionInputDeps } from '../lib/sessionInput.js'
import { passingHold } from '../lib/messageHolds.js'
import type { ScreenReader } from '../lib/screenReader.js'
import type { SubmissionReader } from '../lib/submissionReader.js'
import type { ScreenReading } from '../engines/facets/screen.js'
import { TERMINAL_LEASE_REFUSED, terminalActionNotStarted, type TerminalActionResult } from '../lib/terminalTypes.js'
import type { TerminalControl } from './terminals/control.js'
import { launchBound } from './engines/sessionBinding.js'
import { inputContextIn } from '../lib/nativeTurnObservations.js'
import { teamHold } from '../engines/kit/screen.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface InputDeps {
  readScreen: ScreenReader
  /** Claude Code's and Codex's reading of a prompt typed into their pane, from their worker (core/engines/submissions.ts). */
  submission: SubmissionReader
  resolve: (id: string) => RegisteredSession | undefined
  byAgent: (agentId: string) => RegisteredSession | undefined
  terminal: Pick<TerminalControl, 'captureTerminal' | 'validateTerminal' | 'submitTerminalAction' | 'keyTerminalAction' | 'pinTerminalControl'>
  /** The turns delivered under a caller's own id (core/deliveries.ts): the Wi-Fi device's, Agent Messages', the orchestrator's. */
  deliveries: {
    /** A delivery settled: its caller hears of it. */
    settled: (event: SessionInputDelivery) => void
    /** Whether Agent Messages still wants one of its typed (`team:`) deliveries written. */
    canWrite: (deliveryId: string) => boolean
  }
  /** The Wi-Fi device's service, wherever it runs (core/wifi.ts). */
  device: () => Pick<WifiFeed, 'delivery' | 'inputDispatched' | 'inputStatus' | 'agentGone'> | undefined
  /** The app (`send`) and the dial (`sendCommander`). */
  clients: { send(frame: Frame): void; sendCommander(frame: Frame): void }
  agentIdFor: (sessionId: string) => string
  /** Command Code's normalizer for a session, which opens its turn on our paste. */
  commandcode: (sessionId: string) => CommandCodeNormalizer | undefined
  emit: (sessionId: string, events: LiveEvent[]) => void
  /** A prompt is about to be typed, and `capture` is the pane as read right before: what is on it belongs
   *  to the turns before the one it starts (the question watcher's, lib/askQuestion.ts `notePrompt`). */
  promptTyped?: (session: RegisteredSession, capture: string | null, screen: ScreenReading, inputContext?: string) => void
  /** The person sent text to an agent from a window or the phone (a `message` frame, by agent or session id): one
   *  another agent started is theirs from then on (services/agentCleanup.ts). */
  typed?: (id: string) => void
  /** While an agent changes host, its messages wait here and go to the pane it ends on (hostMove/gate.ts): the one
   *  gate the terminal streams hold its keystrokes in too. */
  moveGate?: MoveGate
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
  return async (id: string, text: string, hold?: (session: RegisteredSession, screen: ScreenReading | null, capture: string | null) => string | null, inputContext?: string): Promise<TerminalActionResult> => {
    const session = resolve(id)
    if (!session) return terminalActionNotStarted('terminal agent is unavailable')
    // The engine first, then its screen. A check of the engine can wait, seconds, for an answer: a probe
    // a held event loop timed out, a restart still recording its new engine (TerminalBackendCoordinator
    // validateRuntime). Read before that wait, the screen was judged as it was then, and a permission
    // prompt opened meanwhile, or a new engine's first screen, took the paste and its Enter. An engine
    // not there is refused as a lease is, which the caller asks again.
    if (!await validateTerminal(session)) return terminalActionNotStarted(TERMINAL_LEASE_REFUSED)
    const capture = await captureTerminal(id)
    const screen = await readScreen(session, capture)
    if (!screen) return terminalActionNotStarted(hold?.(session, null, capture) ?? 'screen_unreadable')
    const reason = hold?.(session, screen, capture) ?? screen.messageHold
    if (reason) return terminalActionNotStarted(reason)
    if (inputContext) promptTyped?.(session, capture, screen, inputContext)
    else promptTyped?.(session, capture, screen)
    return submitTerminalAction(id, text, {
      beforeEnter: async () => {
        // A read that came back empty, or a composer caught between frames, is asked again for a moment
        // (a re-attach can blank one capture): only what is on screen holds the Enter back, never a
        // read that failed once. Still not read after that, it is held, as nothing says it is safe.
        for (let tries = 1; ; tries++) {
          // Read under the record as it now stands when it is the launch typed into, bound to its first
          // conversation since (sessionBinding.ts `launchBound`); under any other change, as typed, which
          // the reading's fence refuses.
          const capture = await captureTerminal(id)
          const next = await readScreen(launchBound(session, resolve(id)), capture)
          const before = next ? next.messageHold : 'screen_unreadable'
          if (before === 'popup_open') return null
          if (!before) return null
          if (!passingHold(before) || tries >= ENTER_CHECK_TRIES) {
            // The screen itself, as read: DESKTOP-0TFH0OJ (2026-10-25) held three Swarm messages' Enter as
            // `prompt_hidden` while the same pane, read by hand a minute later, showed Claude Code's composer.
            console.warn(`[inject] ${sid(id)} Enter held · ${before} · screen ${heldScreen(capture)}`)
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

/** The bottom of a capture for the log: escape sequences and odd spaces kept visible (JSON), secrets redacted,
 *  each row cut, so a composer the reader missed can be read back from the log. */
export function heldScreen(capture: string | null): string {
  if (capture === null) return 'unread'
  const rows = capture.split('\n')
  while (rows.length && !rows.at(-1)!.trim()) rows.pop()
  return JSON.stringify(rows.slice(-HELD_SCREEN_ROWS).map((row) => redactSecretsInText(row).slice(0, HELD_SCREEN_ROW_CHARS)))
}
const HELD_SCREEN_ROWS = 15
const HELD_SCREEN_ROW_CHARS = 400

/** What `SessionInputController` is given: every write takes the device's pane lock first. */
export function sessionInputDeps(
  deps: InputDeps,
  deviceInput: () => Pick<AutonomousDeviceInput, 'legacyWrite'>,
): SessionInputDeps {
  const { resolve, terminal, deliveries, device, clients, agentIdFor, commandcode, emit } = deps
  const { captureTerminal, validateTerminal, keyTerminalAction } = terminal
  const writeMessage = messageWriter(deps)
  // Swarm chat uses the native input queue, while Agent Messages still waits for idle.
  // Both paths keep the same draft and dialog checks under the pane's writer lock.
  const deliveryHold = (session: RegisteredSession, screen: ScreenReading | null, capture: string | null, deliveryId?: string): string | null => {
    if (!screen) return 'team_waiting_unavailable'
    return deliveryId?.startsWith('team:service:superTabs:') && deps.submission.policy(session.engine)?.typesWhileBusy
      ? teamHold(session.engine, capture ?? '', screen.pane, screen.question, true) : screen.teamHold
  }
  return {
    ...(deps.moveGate ? { moveGate: deps.moveGate } : {}),
    readScreen: deps.readScreen,
    submission: deps.submission,
    getSession: (id) => resolve(id),
    onDelivery: (event) => {
      device()?.delivery(event)
      deliveries.settled(event)
    },
    beforeTeamWrite: async (session, deliveryId) => {
      const capture = await captureTerminal(session.agentId)
      const screen = await deps.readScreen(session, capture)
      return deliveryHold(session, screen, capture, deliveryId)
    },
    validateRuntime: validateTerminal,
    // Typed into the pane as it stands, a draft or a running turn included, under the pane's write lock.
    inject: (id, text, inputContext) => deviceInput().legacyWrite(id, () => writeMessage(id, text, undefined, inputContext)),
    // An Agent Messages turn waits for a ready composer, and for its mailbox to still want it written.
    injectTeam: (id, text, deliveryId) => deviceInput().legacyWrite(id, async () => {
      if (!resolve(id)) return terminalActionNotStarted('team_waiting_unavailable')
      return writeMessage(id, text, (session, screen, capture) => deliveryHold(session, screen, capture, deliveryId)
        ?? (deliveries.canWrite(deliveryId) ? null : 'team_waiting_control'))
    }),
    sendKey: (id, key) => deviceInput().legacyWrite(id, () => keyTerminalAction(id, key)),
    capture: captureTerminal,
    onError: (sessionId, message) => {
      clients.send({ type: 'error', agentId: agentIdFor(sessionId), dbSessionId: sessionId, payload: { message } })
      const engine = resolve(sessionId)?.engine
      clients.sendCommander({ type: 'commander_event', agentId: agentIdFor(sessionId), dbSessionId: sessionId, payload: { kind: 'error', text: deviceErrorText(message, engine) } })
    },
    // Command Code writes its transcript only once the turn is OVER, so a turn that calls no tool has
    // nothing to announce it: measured on 1.28.4, "hi" produced turn_started and turn_ended 1ms apart
    // and neither web nor device ever showed the agent working. Our own paste is the one moment a turn
    // is known to have started — and the only one that also knows the text.
    onSubmitted: (id, content) => {
      // `id` is whatever the caller addressed the agent by — in the inject path it is the AGENT id, not
      // the session id, and the normalizer map is keyed by session. Resolve before looking anything up.
      const session = resolve(id)
      if (session?.engine !== 'commandcode' || !session.sessionId) return
      const normalizer = commandcode(session.sessionId)
      if (!normalizer) return
      emit(session.sessionId, normalizer.openTurn(content))
    },
  }
}

/** What `AutonomousDeviceInput` is given: the terminal directly, and the controller for queued input. */
export function deviceInputDeps(
  deps: InputDeps,
  input: () => Pick<SessionInputController, 'acquireControl' | 'submit' | 'cancelDelivery'>,
): DeviceInputDeps {
  const { resolve, byAgent, terminal, device } = deps
  const { captureTerminal, validateTerminal, keyTerminalAction } = terminal
  return {
    getSession: id => resolve(id),
    validateRuntime: validateTerminal,
    // The Device holds the pane's write lock itself while it writes.
    inject: messageWriter(deps),
    sendKey: keyTerminalAction,
    capture: captureTerminal,
    submission: deps.submission,
    // Whatever a message is not typed into, the Device's waits for it to close, rather than be refused.
    isAwaitingUser: async session => {
      const pane = await captureTerminal(session.agentId)
      const screen = await deps.readScreen(session, pane)
      return pane === null || !screen || screen.messageHold !== null
    },
    acquireControl: id => input().acquireControl(id, { forAnswer: true }),
    legacySubmit: (id, text, deliveryId) => input().submit(id, text, deliveryId),
    legacyCancel: id => input().cancelDelivery(id),
    onDelivery: event => device()?.delivery(event),
    onDispatch: (id, deliveryId, text) => device()?.inputDispatched(id, deliveryId, text, byAgent(id)?.sessionId),
    onInputStatus: event => device()?.inputStatus(event),
    onForget: id => device()?.agentGone(id),
  }
}

export function createInput(deps: InputDeps) {
  const { resolve, terminal: { pinTerminalControl } } = deps
  const input: SessionInputController = new SessionInputController(sessionInputDeps(deps, () => deviceInput))
  const deviceInput: AutonomousDeviceInput = new AutonomousDeviceInput(deviceInputDeps(deps, () => input))
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
  const submitAgent = (id: string, content: string, deliveryId?: string, inputContext?: string, receipt?: MessageReceipt): void => {
    const record = resolve(id)
    const sessionId = record?.sessionId ?? id
    const engine = record?.engine ?? 'claude'
    // The backend prepends `/goal ` or `/loop ` without knowing the engine (on the routed path it has
    // not picked an agent yet when the mode is chosen). This is the one place that always knows, so the
    // per-engine adaptation happens here — an unknown slash command would otherwise land as a visible
    // error in the user's terminal instead of running their turn.
    const adapted = adaptSlashCommand(content, engine)
    if (adapted !== content) {
      console.log(`[msg] ${sid(sessionId)} slash-command adapted for engine=${engine}`)
    }
    console.log(`[msg] ${sid(sessionId)} recv · engine=${engine} · bytes=${Buffer.byteLength(adapted, 'utf8')}`)
    const target = record?.agentId ?? sessionId
    if (receipt) input.submit(target, adapted, deliveryId, inputContext, receipt)
    else if (inputContext) input.submit(target, adapted, deliveryId, inputContext)
    else input.submit(target, adapted, deliveryId)
  }
  const messageRequest = createMessageRequest((id, content, context, receipt) => submitAgent(id, content, undefined, context, receipt), deps.typed)
  return { input, deviceInput, acquireTerminalControl, submitAgent, messageRequest }
}

/**
 * Takes a `message` frame: text a person typed for an agent, into its pane. Nothing is answered: the
 * transcript lines the text produces drive the turn back to every window (mirror-all), with no synthetic
 * events here. A `tabId` an older window still sends is not read.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
export function createMessageRequest(submit: (id: string, content: string, inputContext?: string, receipt?: MessageReceipt) => void, typed?: (id: string) => void) {
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
    const context = inputContextIn(payload.inputContext)
    if (receipt) submit(target, content, context ?? undefined, receipt)
    else if (context) submit(target, content, context)
    else submit(target, content)
  }
}

export type Input = ReturnType<typeof createInput>
