/**
 * Input: everything the core writes into an agent's pane. Messages, team turns and keys go through one
 * controller (`SessionInputController`, a per-pane queue while a turn is busy); the Harness device's own
 * route (`AutonomousDeviceInput`) owns the pane writer lock, and every write from the controller takes it
 * first (`legacyWrite`), so a person answering on a device and the core never interleave in one pane.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 5: docs/design/2026-10-03-harnessd.md);
 * what it reaches in the registry, the terminal, the teams and device features and the clients is passed
 * in. The two controllers' dependencies are built by `sessionInputDeps` and `deviceInputDeps`, each given
 * the other controller lazily: each one calls into the other.
 */
import { AutonomousDeviceInput, type DeviceInputDeps } from './deviceInput.js'
import type { WifiFeed } from './wifi.js'
import type { CommandCodeNormalizer } from '../engines/commandcode/normalizer.js'
import { deviceErrorText } from './cardText.js'
import { adaptSlashCommand } from '../lib/goalCommand.js'
import { sid } from '../lib/log.js'
import type { LiveEvent } from '../lib/normalize.js'
import type { RegisteredSession } from '../lib/registry.js'
import { SessionInputController, type SessionInputDelivery, type SessionInputDeps } from '../lib/sessionInput.js'
import { messageHold, passingHold } from '../lib/messageHold.js'
import { TERMINAL_LEASE_REFUSED, terminalActionNotStarted, type TerminalActionResult } from '../lib/terminalTypes.js'
import { teamWriteHold } from '../lib/teamWriteHold.js'
import type { TerminalControl } from './terminals/control.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface InputDeps {
  resolve: (id: string) => RegisteredSession | undefined
  byAgent: (agentId: string) => RegisteredSession | undefined
  terminal: Pick<TerminalControl, 'captureTerminal' | 'validateTerminal' | 'submitTerminalAction' | 'keyTerminalAction' | 'pinTerminalControl'>
  /** The teams and orchestrator features. */
  teams: {
    /** Before a paste: record where the prompt came from (the teams' prompt scopes, `ports.teams`). */
    prepare: (agentId: string, content: string, tabId?: string, deliveryId?: string) => () => void
    /** A delivery settled: the orchestrator hears of it, then the team. */
    delivery: (event: SessionInputDelivery) => void
    /** Whether a team delivery still holds control of its pane. */
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
}

/**
 * The one way a message reaches an agent's pane: a person's from the app or the phone (the relay hands
 * the phone's over as the same `message` frame), the orchestrator's, a team's, and the Device's alike.
 * The pane is read right before the paste, by the caller that holds the pane's write lock, and nothing
 * is typed into a dialog, a menu or a view a message does not belong in (messageHold.ts): the reason
 * comes back instead, with nothing written. `hold` adds a caller's own check of the same reading (a
 * team's, which waits for a draft too). The pane is read again once the text is in, right before its
 * Enter: a dialog opened in between (a long or multi-line paste waits up to 1.5 s for the engine to take
 * it, mid-turn) keeps the Enter from being pressed, which would answer it, and the text waits in the
 * composer, unsent (sessionInput.ts says so). A list of suggestions opened by the message itself is no
 * reason. `submitTerminalAction` is called here and nowhere else in this file, and input.spec.ts keeps
 * it so.
 */
export function messageWriter({ resolve, terminal: { captureTerminal, validateTerminal, submitTerminalAction } }: Pick<InputDeps, 'resolve' | 'terminal'>) {
  return async (id: string, text: string, hold?: (session: RegisteredSession, capture: string | null) => string | null): Promise<TerminalActionResult> => {
    const session = resolve(id)
    if (!session) return terminalActionNotStarted('terminal agent is unavailable')
    // The engine first, then its screen. A check of the engine can wait, seconds, for an answer: a probe
    // a held event loop timed out, a restart still recording its new engine (TerminalBackendCoordinator
    // validateRuntime). Read before that wait, the screen was judged as it was then, and a permission
    // prompt opened meanwhile, or a new engine's first screen, took the paste and its Enter. An engine
    // not there is refused as a lease is, which the caller asks again.
    if (!await validateTerminal(session)) return terminalActionNotStarted(TERMINAL_LEASE_REFUSED)
    const capture = await captureTerminal(id)
    const reason = hold?.(session, capture) ?? messageHold(session.engine, capture)
    if (reason) return terminalActionNotStarted(reason)
    return submitTerminalAction(id, text, {
      beforeEnter: async () => {
        // A read that came back empty, or a composer caught between frames, is asked again for a moment
        // (a re-attach can blank one capture): only what is on screen holds the Enter back, never a
        // read that failed once. Still not read after that, it is held, as nothing says it is safe.
        for (let tries = 1; ; tries++) {
          const before = messageHold(session.engine, await captureTerminal(id))
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
  deviceInput: () => Pick<AutonomousDeviceInput, 'legacyWrite'>,
): SessionInputDeps {
  const { resolve, terminal, teams, device, clients, agentIdFor, commandcode, emit } = deps
  const { captureTerminal, validateTerminal, keyTerminalAction } = terminal
  const writeMessage = messageWriter(deps)
  return {
    beforeSubmit: (id, text, tabId, deliveryId) => teams.prepare(id, text, tabId, deliveryId),
    getSession: (id) => resolve(id),
    onDelivery: (event) => {
      device()?.delivery(event)
      teams.delivery(event)
    },
    beforeTeamWrite: async session => {
      const capture = await captureTerminal(session.agentId)
      return teamWriteHold(session.engine, capture)
    },
    validateRuntime: validateTerminal,
    // Typed into the pane as it stands, a draft or a running turn included, under the pane's write lock.
    inject: (id, text) => deviceInput().legacyWrite(id, () => writeMessage(id, text)),
    // A team's turn waits for a ready composer, and for its delivery to still hold the pane.
    injectTeam: (id, text, deliveryId) => deviceInput().legacyWrite(id, async () => {
      if (!resolve(id)) return terminalActionNotStarted('team_waiting_unavailable')
      return writeMessage(id, text, (session, capture) => teamWriteHold(session.engine, capture)
        ?? (teams.canWrite(deliveryId) ? null : 'team_waiting_control'))
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
    // Whatever a message is not typed into, the Device's waits for it to close, rather than be refused.
    isAwaitingUser: async session => {
      const pane = await captureTerminal(session.agentId)
      return pane === null || messageHold(session.engine, pane) !== null
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
  const submitAgent = (id: string, content: string, deliveryId?: string, tabId?: string): void => {
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
    input.submit(record?.agentId ?? sessionId, adapted, deliveryId, tabId)
  }
  const messageRequest = createMessageRequest(submitAgent)
  return { input, deviceInput, acquireTerminalControl, submitAgent, messageRequest }
}

/**
 * Takes a `message` frame: text a person typed for an agent, into its pane, in the tab's scope when the
 * frame names one. Nothing is answered: the transcript lines the text produces drive the turn back to
 * every window (mirror-all), with no synthetic events here.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
/** A tab's id as Tab collaboration takes it (teams/model.ts `Id`): a message from a tab is in its swarm's scope. */
const TAB_ID = /^[A-Za-z0-9_-]{1,128}$/

export function createMessageRequest(submit: (id: string, content: string, deliveryId?: string, tabId?: string) => void) {
  return (payload: Record<string, unknown>): void => {
    const content = payload.content as string | undefined
    const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
    if (!content || !target) return
    // From the relay this is only reached sealed: text typed into an agent is never taken from the relay
    // in the clear.
    if (typeof payload.tabId === 'string' && TAB_ID.test(payload.tabId)) submit(target, content, undefined, payload.tabId)
    else submit(target, content)
  }
}

export type Input = ReturnType<typeof createInput>
