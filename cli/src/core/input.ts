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
import type { LiveEvent } from '../engines/kit/events.js'
import type { RegisteredSession } from '../lib/registry.js'
import { SessionInputController, type NativeSessionInputPort, type SessionInputDelivery, type SessionInputDeps } from '../lib/sessionInput.js'
import { createNativeInput, type NativeInputAdmission } from './turns/nativeInput.js'
import { outsideConsumers } from './turns/funnel.js'
import { passingHold } from '../lib/messageHolds.js'
import type { ScreenReader } from '../lib/screenReader.js'
import type { SubmissionReader } from '../lib/submissionReader.js'
import type { ScreenReading } from '../engines/facets/screen.js'
import { TERMINAL_LEASE_REFUSED, TerminalWriteHeld, terminalActionNotStarted, type TerminalActionResult, type TerminalWrite } from '../lib/terminalTypes.js'
import type { TerminalControl } from './terminals/control.js'
import { launchBound } from './engines/sessionBinding.js'
import { paneReadIdentity } from './transcripts/readIdentity.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface InputDeps {
  native?: NativeInputAdmission
  readScreen: ScreenReader
  /** Claude Code's and Codex's reading of a prompt typed into their pane, from their worker (core/engines/submissions.ts). */
  submission: SubmissionReader
  resolve: (id: string) => RegisteredSession | undefined
  byAgent: (agentId: string) => RegisteredSession | undefined
  terminal: Pick<TerminalControl, 'captureTerminal' | 'validateTerminal' | 'submitTerminalAction' | 'keyTerminalAction' | 'pinTerminalControl'>
    & Partial<Pick<TerminalControl, 'writer' | 'writeTicket'>>
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
  promptTyped?: (session: RegisteredSession, capture: string | null, screen: ScreenReading) => void
  /** The person sent text to an agent from a window or the phone (a `message` frame, by agent or session id): one
   *  another agent started is theirs from then on (services/agentCleanup.ts). */
  typed?: (id: string) => void
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
export function messageWriter({ readScreen, resolve, terminal: { captureTerminal, validateTerminal, submitTerminalAction, writeTicket }, promptTyped }: Pick<InputDeps, 'resolve' | 'terminal' | 'promptTyped' | 'readScreen'>) {
  return async (id: string, text: string, hold?: (session: RegisteredSession, screen: ScreenReading | null) => string | null,
    write?: TerminalWrite, requireComposer = false): Promise<TerminalActionResult> => {
    const found = resolve(id)
    if (!found) return terminalActionNotStarted('terminal agent is unavailable')
    const session = structuredClone(found)
    const owner = writeTicket?.(session.agentId)
    const allowed = () => (!write || write.allowed()) && (!owner || owner.allowed())
    if (!allowed()) return terminalActionNotStarted('terminal control revoked')
    // The engine first, then its screen. A check of the engine can wait, seconds, for an answer: a probe
    // a held event loop timed out, a restart still recording its new engine (TerminalBackendCoordinator
    // validateRuntime). Read before that wait, the screen was judged as it was then, and a permission
    // prompt opened meanwhile, or a new engine's first screen, took the paste and its Enter. An engine
    // not there is refused as a lease is, which the caller asks again.
    if (!await validateTerminal(session)) return terminalActionNotStarted(TERMINAL_LEASE_REFUSED)
    if (!allowed()) return terminalActionNotStarted('terminal control revoked')
    const capture = await captureTerminal(id)
    const screen = await readScreen(session, capture)
    if (!allowed()) return terminalActionNotStarted('terminal control revoked')
    if (!screen) return terminalActionNotStarted(hold?.(session, null) ?? 'screen_unreadable')
    const reason = hold?.(session, screen) ?? screen.messageHold
    if (reason) return terminalActionNotStarted(reason)
    let typed = false
    if (!write) promptTyped?.(session, capture, screen)
    return submitTerminalAction(id, text, {
      ...(write ? { allowed, dispatch: <T>(operation: () => Promise<T>): Promise<T> => write.dispatch(() => {
        if (!typed) { typed = true; promptTyped?.(session, capture, screen) }
        return operation()
      }) } : {}),
      beforeEnter: async () => {
        // A read that came back empty, or a composer caught between frames, is asked again for a moment
        // (a re-attach can blank one capture): only what is on screen holds the Enter back, never a
        // read that failed once. Still not read after that, it is held, as nothing says it is safe.
        for (let tries = 1; ; tries++) {
          // Read under the record as it now stands when it is the launch typed into, bound to its first
          // conversation since (sessionBinding.ts `launchBound`); under any other change, as typed, which
          // the reading's fence refuses.
          const next = await readScreen(launchBound(session, resolve(id)), await captureTerminal(id))
          if (!allowed()) return 'terminal control revoked'
          const before = next ? next.messageHold ?? (requireComposer && !next.pane.idle && !next.pane.draft ? 'screen_unreadable' : null) : 'screen_unreadable'
          if (before === 'popup_open') return null
          if (!before || !passingHold(before) || tries >= ENTER_CHECK_TRIES) return before
          await new Promise((settle) => setTimeout(settle, ENTER_CHECK_RETRY_MS))
        }
      },
    })
  }
}

/** How long the check before a message's Enter asks again after a read that says nothing: 3 s. */
const ENTER_CHECK_TRIES = 12
const ENTER_CHECK_RETRY_MS = 250

/** What `SessionInputController` is given: every write takes the device's pane lock first. */
export function sessionInputDeps(
  deps: InputDeps,
  deviceInput: () => Pick<AutonomousDeviceInput, 'legacyWrite'> & Partial<Pick<AutonomousDeviceInput, 'writes'>>,
  native?: NativeSessionInputPort,
): SessionInputDeps {
  const { resolve, terminal, deliveries, device, clients, agentIdFor, commandcode, emit } = deps
  const { captureTerminal, validateTerminal, keyTerminalAction } = terminal
  const writeMessage = messageWriter(deps)
  return {
    native,
    readScreen: deps.readScreen,
    submission: deps.submission,
    getSession: (id) => resolve(id),
    onDelivery: (event) => {
      device()?.delivery(event)
      deliveries.settled(event)
    },
    beforeTeamWrite: async session => {
      const capture = await captureTerminal(session.agentId)
      const screen = await deps.readScreen(session, capture)
      return screen ? screen.teamHold : 'team_waiting_unavailable'
    },
    validateRuntime: validateTerminal,
    write: id => terminal.writeTicket?.(id) ?? deviceInput().writes?.ticket(resolve(id)?.agentId ?? id),
    // Typed into the pane as it stands, a draft or a running turn included, under the pane's write lock.
    inject: (id, text, write) => deviceInput().legacyWrite(id, ticket => writeMessage(id, text, undefined, ticket), write),
    // An Agent Messages turn waits for a ready composer, and for its mailbox to still want it written.
    injectTeam: (id, text, deliveryId, write) => deviceInput().legacyWrite(id, async ticket => {
      if (!resolve(id)) return terminalActionNotStarted('team_waiting_unavailable')
      return writeMessage(id, text, (session, screen) => (screen ? screen.teamHold : 'team_waiting_unavailable')
        ?? (deliveries.canWrite(deliveryId) ? null : 'team_waiting_control'), ticket)
    }, write),
    sendKey: (id, key, write) => deviceInput().legacyWrite(id, ticket => keyTerminalAction(id, key, ticket?.allowed, ticket), write),
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
    writer: deps.terminal.writer,
    write: deps.terminal.writeTicket,
    inject: (id, text, write) => messageWriter(deps)(id, text, undefined, write),
    sendKey: (id, key, write) => keyTerminalAction(id, key, write?.allowed, write),
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
  const nativeWriter = messageWriter(deps)
  const nativeNotify = outsideConsumers({ prefix: 'native-input' })
  const nativeInput = deps.native && createNativeInput({
    admission: { ...deps.native, prepare: async original => {
      const check = () => {
        if (input.controlHeld(original.agentId)) throw new TerminalWriteHeld('Waiting for the current terminal control interaction.')
      }
      check()
      const permit = await deps.native!.prepare(original)
      return { verify: () => { permit.verify(); check() } }
    } },
    resolve,
    reserve: id => deviceInput.writes.reserve(id),
    run: (id, write, operation, signal) => deviceInput.legacyWrite(id, operation, write, signal),
    canWrite: id => !id.startsWith('team:') || deps.deliveries.canWrite(id),
    write: (id, text, write) => nativeWriter(id, text, (_session, screen) =>
      !screen ? 'Waiting for the native composer to be readable.'
        : screen.pane.draft ? 'A draft is present in the native composer. Send or clear it there before this queued message.'
          : screen.messageHold ?? (!screen.pane.idle ? 'Waiting for the native composer to be ready.' : screen.teamHold), write, true),
    delivery: event => {
      nativeNotify('devices', () => deps.device()?.delivery(event))
      nativeNotify('deliveries', () => deps.deliveries.settled(event))
    },
  })
  const input: SessionInputController = new SessionInputController(sessionInputDeps(deps, () => deviceInput, nativeInput))
  const deviceInput: AutonomousDeviceInput = new AutonomousDeviceInput(deviceInputDeps(deps, () => input))
  const acquireTerminalControl = (id: string, opts?: { forAnswer?: boolean; original?: RegisteredSession }): (() => void) | null => {
    const found = resolve(id)
    if (opts?.original && paneReadIdentity(opts.original) !== paneReadIdentity(found)) return null
    const original = found && structuredClone(found)
    const agentId = original?.agentId ?? id
    const releaseInput = input.acquireControl(agentId, opts)
    if (!releaseInput) return null
    const native = deps.native?.owns(agentId) ? deps.native : undefined
    if (native && !original) { releaseInput(); return null }
    const releaseTerminal = pinTerminalControl(agentId, native ? { prepare: async () => {
      try { return await native.prepare(original!, opts?.forAnswer ? 'answer' : 'control') }
      catch (error) {
        nativeNotify('hold', () => native.held(agentId, error instanceof Error ? error.message : String(error)))
        throw error
      }
    } } : undefined)
    if (!releaseTerminal) {
      releaseInput()
      return null
    }
    return () => {
      releaseTerminal()
      releaseInput()
    }
  }
  const submitAgent = (id: string, content: string, deliveryId?: string): void => {
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
    input.submit(record?.agentId ?? sessionId, adapted, deliveryId)
  }
  const messageRequest = createMessageRequest(submitAgent, deps.typed)
  return { input, deviceInput, nativeInput, acquireTerminalControl, submitAgent, messageRequest }
}

/**
 * Takes a `message` frame: text a person typed for an agent, into its pane. Nothing is answered: the
 * transcript lines the text produces drive the turn back to every window (mirror-all), with no synthetic
 * events here. A `tabId` an older window still sends is not read.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
export function createMessageRequest(submit: (id: string, content: string) => void, typed?: (id: string) => void) {
  return (payload: Record<string, unknown>): void => {
    const content = payload.content as string | undefined
    const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
    if (!content || !target) return
    // A `message` frame is a person's: the windows' and the phone's composer. Agents and experiments deliver theirs
    // under a delivery id (`turns.deliver`), which never comes this way.
    typed?.(target)
    // From the relay this is only reached sealed: text typed into an agent is never taken from the relay
    // in the clear.
    submit(target, content)
  }
}

export type Input = ReturnType<typeof createInput>
