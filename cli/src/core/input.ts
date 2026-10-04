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
import { AutonomousDeviceInput, type DeviceInputDeps } from '../lib/autonomous-device/input.js'
import type { AutonomousDeviceService } from '../lib/autonomous-device/service.js'
import type { CommandCodeNormalizer } from '../engines/commandcode/normalizer.js'
import { parseEngineQuestionPane } from '../lib/askQuestion.js'
import { deviceErrorText } from '../lib/deviceErrors.js'
import { adaptSlashCommand } from '../lib/goalCommand.js'
import { sid } from '../lib/log.js'
import type { LiveEvent } from '../lib/normalize.js'
import type { RegisteredSession } from '../lib/registry.js'
import { SessionInputController, type SessionInputDelivery, type SessionInputDeps } from '../lib/sessionInput.js'
import { terminalActionNotStarted } from '../lib/terminalTypes.js'
import { teamWriteHold } from '../teams/preflight.js'
import type { TerminalControl } from './terminals/control.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface InputDeps {
  resolve: (id: string) => RegisteredSession | undefined
  byAgent: (agentId: string) => RegisteredSession | undefined
  terminal: Pick<TerminalControl, 'captureTerminal' | 'validateTerminal' | 'submitTerminalAction' | 'keyTerminalAction' | 'pinTerminalControl'>
  /** The teams and orchestrator features. */
  teams: {
    /** Before a paste: record where the prompt came from (BackendSocket.swarmPromptScopes.prepare). */
    prepare: (agentId: string, content: string, tabId?: string, deliveryId?: string) => () => void
    /** A delivery settled: the orchestrator hears of it, then the team. */
    delivery: (event: SessionInputDelivery) => void
    /** Whether a team delivery still holds control of its pane. */
    canWrite: (deliveryId: string) => boolean
  }
  /** The Harness device service, once it exists. */
  device: () => Pick<AutonomousDeviceService, 'delivery' | 'inputDispatched' | 'inputStatus' | 'agentGone'> | undefined
  /** The app (`send`) and the dial (`sendCommander`). */
  clients: { send(frame: Frame): void; sendCommander(frame: Frame): void }
  agentIdFor: (sessionId: string) => string
  /** Command Code's normalizer for a session, which opens its turn on our paste. */
  commandcode: (sessionId: string) => CommandCodeNormalizer | undefined
  emit: (sessionId: string, events: LiveEvent[]) => void
}

/** What `SessionInputController` is given: every write takes the device's pane lock first. */
export function sessionInputDeps(
  { resolve, terminal, teams, device, clients, agentIdFor, commandcode, emit }: InputDeps,
  deviceInput: () => Pick<AutonomousDeviceInput, 'legacyWrite'>,
): SessionInputDeps {
  const { captureTerminal, validateTerminal, submitTerminalAction, keyTerminalAction } = terminal
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
    inject: (id, text) => deviceInput().legacyWrite(id, () => submitTerminalAction(id, text)),
    injectTeam: (id, text, deliveryId) => deviceInput().legacyWrite(id, async () => {
      const session = resolve(id)
      const reason = session ? teamWriteHold(session.engine, await captureTerminal(id)) : 'team_waiting_unavailable'
      if (reason) return { state: 'failed', dispatch: 'not_started', reason }
      if (!teams.canWrite(deliveryId)) return terminalActionNotStarted('team_waiting_control')
      return submitTerminalAction(id, text)
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
  { resolve, byAgent, terminal, device }: InputDeps,
  input: () => Pick<SessionInputController, 'acquireControl' | 'submit' | 'cancelDelivery'>,
): DeviceInputDeps {
  const { captureTerminal, validateTerminal, submitTerminalAction, keyTerminalAction } = terminal
  return {
    getSession: id => resolve(id),
    validateRuntime: validateTerminal,
    inject: submitTerminalAction,
    sendKey: keyTerminalAction,
    capture: captureTerminal,
    isAwaitingUser: async session => {
      const pane = await captureTerminal(session.agentId)
      return pane === null || parseEngineQuestionPane(session.engine, pane) !== null
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
  return { input, deviceInput, acquireTerminalControl, submitAgent }
}

export type Input = ReturnType<typeof createInput>
