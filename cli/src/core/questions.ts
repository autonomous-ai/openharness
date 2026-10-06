/**
 * Questions: an agent asking the person something (AskUserQuestion, a permission dialog). The watcher
 * spots a dialog in the pane and puts it in front of the dial and the window on this computer; an answer
 * from any of them is keyed back into the pane; a dialog answered anywhere, or by hand, is closed on
 * every client down the same paths it was opened on.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 6: docs/design/2026-10-03-harnessd.md).
 * The socket's two handlers stay bound there: `answer` (question_response) and `monitorActivity`.
 */
import { AgentNotifications } from '../lib/agentNotifications.js'
import { AskQuestionController, QuestionWatcher, type QuestionAnswerPayload, type QuestionAnswerResult } from '../lib/askQuestion.js'
import type { AutonomousDeviceInput } from './deviceInput.js'
import { preview, sid } from '../lib/log.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { TerminalControl } from './terminals/control.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface QuestionDeps {
  resolve: (id: string) => RegisteredSession | undefined
  terminal: Pick<TerminalControl, 'captureTerminal' | 'submitTerminal' | 'keyTerminal'>
  /** Holds a pane, queue and terminal both, for the whole multi-step answer (Input.acquireTerminalControl). */
  acquireTerminalControl: (id: string, opts?: { forAnswer?: boolean }) => (() => void) | null
  /** The dial (`sendCommander`) and the window on this computer (`sendLocal`). */
  clients: { sendCommander(frame: Frame): void; sendLocal(frame: Frame): void }
  agentIdFor: (sessionId: string) => string
  sessionTurnOpen: (sessionId: string) => boolean
  /** Whether anyone could answer right now: a device watching, or a window on this computer. */
  someoneCanAnswer: () => boolean
  deviceInput: Pick<AutonomousDeviceInput, 'setUserAction'>
}

export function createQuestions({
  resolve, terminal, acquireTerminalControl, clients, agentIdFor, sessionTurnOpen, someoneCanAnswer, deviceInput,
}: QuestionDeps) {
  const { captureTerminal, submitTerminal, keyTerminal } = terminal
  // AskUserQuestion bridge: mirrors the question to the device's question screen, and keys the device's
  // answer back into the CLI's own terminal dialog.
  const questions = new AskQuestionController({
    getSession: (id) => resolve(id),
    capture: captureTerminal,
    sendText: submitTerminal,
    sendKey: keyTerminal,
    acquireControl: acquireTerminalControl,
  })
  // Command Code ENDS its turn in order to ask (its Stop hook fires, the dialog goes up, and the answer
  // opens a NEW turn). With the turn closed the device tile falls back to the PREVIOUS task's recap — so
  // mid-question the screen showed a finished summary while the user was still being asked. Keep the tile
  // visibly working for as long as the exchange lasts. The device's own busy-timeout watchdog bounds this,
  // so an abandoned question cannot pin the tile forever.
  const showAwaitingAnswer = (sessionId: string): void => {
    clients.sendCommander({
      type: 'commander_event',
      agentId: agentIdFor(sessionId),
      dbSessionId: sessionId,
      payload: { kind: 'processing', text: 'Waiting for your answer' },
    })
  }
  const answer = (payload: QuestionAnswerPayload): Promise<QuestionAnswerResult> => {
    // Hold the working state across the gap too: the CLI needs a moment to move to the next question, and
    // that gap is exactly where the stale recap used to flash back.
    const target = payload.sessionId || payload.agentId
    if (typeof target === 'string' && target) showAwaitingAnswer(target)
    // Returned so the client that answered hears a refusal — STALE_QUESTION when the dialog changed
    // before its answer arrived — as `question_response_result`.
    return questions.answer(payload)
  }
  // What is still being asked, by session — handed to a window that connects later (openQuestions below).
  const openQuestions = new Map<string, Record<string, unknown>>()
  const monitorActivity = (sessionId: string): 'needsInput' | 'working' | 'idle' => openQuestions.has(sessionId)
    ? 'needsInput' : sessionTurnOpen(sessionId) ? 'working' : 'idle'
  const agentNotifications = new AgentNotifications()
  const questionWatcher = new QuestionWatcher({
    getSession: (id) => resolve(id),
    capture: captureTerminal,
    hasDevice: () => someoneCanAnswer(),
    isDriving: (sessionId) => questions.isDriving(sessionId),
    onQuestion: (sessionId, requestId, shaped, detail) => {
      deviceInput.setUserAction(agentIdFor(sessionId), true)
      questions.remember(requestId, sessionId)
      showAwaitingAnswer(sessionId)
      const asked = {
        type: 'commander_question',
        agentId: agentIdFor(sessionId),
        dbSessionId: sessionId,
        payload: { requestId, questions: shaped, notification: agentNotifications.asked(sessionId, requestId),
          // Robot clients need to distinguish a permission notice from an answerable question.
          ...(detail?.permission ? { permission: { dialog: detail.dialog, resolution: 'desktop' } } : {}),
        },
      }
      clients.sendCommander(asked)
      // ...and to the window on this computer. `sendCommander` is `webEligible: false`, so until this
      // second call the app could not learn that an agent was blocked even though the question had
      // already been shaped for the dial.
      //
      // `sendLocal`, not `send`: the question and its option labels are user content, and the only
      // audience `send` would add beyond loopback is the cloud leg, where this frame would travel
      // PLAINTEXT — `commander_question` is deliberately absent from ENCRYPTED_UP_TYPES, and putting it
      // there means re-deriving an interop hash pinned by the browser client and the device firmware in
      // two other repositories. Loopback needs no envelope, and it costs nothing that is reachable
      // today: a remote machine's watcher is gated on ITS OWN audience, which a window attached over
      // here is not part of either way.
      clients.sendLocal(asked)
      openQuestions.set(sessionId, asked)
      console.log(`[question] ${sid(sessionId)} asking the user · "${preview(shaped[0]?.q ?? '')}" · req=${requestId}`)
    },
    // Answered somewhere else — the app, or the pane by hand. Every client drawing it is told to stop
    // waiting, down the SAME path the question itself took, so the dial and the WiFi device cannot
    // disagree about whether a question is still open.
    onQuestionGone: (sessionId, requestId) => {
      agentNotifications.answered(sessionId, requestId)
      deviceInput.setUserAction(agentIdFor(sessionId), false)
      const closed = {
        type: 'commander_question_close',
        agentId: agentIdFor(sessionId),
        dbSessionId: sessionId,
        payload: { requestId },
      }
      clients.sendCommander(closed)
      // Down the SAME two paths the question took, so no client is left drawing a dialog that another
      // one already answered. This is the mechanism behind "answer anywhere": the dial is cabled to
      // this very computer, so the dial and this window are always the same machine's audience.
      clients.sendLocal(closed)
      openQuestions.delete(sessionId)
      console.log(`[question] ${sid(sessionId)} answered elsewhere · closing on every client · req=${requestId}`)
    },
  })
  const questionResponse = createQuestionResponse(answer)
  return { questions, showAwaitingAnswer, answer, questionResponse, openQuestions, monitorActivity, agentNotifications, questionWatcher }
}

/**
 * Answers `question_response`: a person answered an agent's question on a device or in a window. There
 * is no control channel into an interactive CLI, so `answer` keys it straight into that session's tmux
 * dialog, and what became of it goes back through `reply`.
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
export function createQuestionResponse(answer: (payload: QuestionAnswerPayload) => Promise<QuestionAnswerResult> | void) {
  return (payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void): void => {
    const p = payload as { requestId?: string; sessionId?: string; agentId?: string; answers?: Record<string, string> }
    const answered = answer(p)
    // Detached: driving a dialog takes seconds of keystrokes and repaints. The outcome goes back
    // under the QUESTION's requestId, so the client that answered can say why nothing happened —
    // STALE_QUESTION when the dialog changed before the answer arrived and nothing was typed.
    if (answered) {
      void answered
        .then((result) => reply(result.ok ? { ok: true } : { error: result.error, detail: result.detail }))
        .catch(() => reply({ error: 'ANSWER_FAILED', detail: 'The answer could not be entered.' }))
    }
  }
}

export type Questions = ReturnType<typeof createQuestions>
