/**
 * Questions: an agent asking the person something (AskUserQuestion, a permission dialog). The watcher
 * spots a dialog in the pane and puts it in front of the dial and the window on this computer; an answer
 * from any of them is keyed back into the pane; a dialog answered anywhere, or by hand, is closed on
 * every client down the same paths it was opened on.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 6: docs/design/2026-10-03-harnessd.md).
 * The socket's two handlers stay bound there: `answer` (question_response) and `monitorActivity`.
 */
import { AskQuestionController, QuestionWatcher, type QuestionAnswerPayload, type QuestionAnswerResult } from '../lib/questionController.js'
import type { SessionInputController } from '../lib/sessionInput.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { TerminalControl } from './terminals/control.js'
import { replayLegacyQuestions } from './questionObservation.js'

type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface QuestionPresentation {
  owner: object
  key: string
  requestId: string
  frame: Frame
  dial: boolean
  remote: boolean
}

/** One presentation per owner; the existing request index shares its entry, never another frame. */
export function createQuestionPresentations() {
  const owners = new Map<string, QuestionPresentation>()
  const requests = new Map<string, QuestionPresentation>()
  const frames = function* (remote = false): IterableIterator<Frame> {
    for (const entry of owners.values()) if (!remote || entry.remote) yield entry.frame
  }
  return {
    openQuestions: {
      get size() { return owners.size },
      has: (key: string) => owners.has(key),
      get: (key: string) => owners.get(key)?.frame,
      values: () => frames(),
    },
    snapshot: (audience: 'local' | 'remote') => frames(audience === 'remote'),
    current: (key: string) => owners.get(key),
    request: (requestId: string) => requests.get(requestId),
    set(owner: object, key: string, frame: Frame, audience: { dial: boolean; remote: boolean }, reinsert = false): boolean {
      const requestId = frame.payload.requestId
      if (typeof requestId !== 'string' || !requestId) return false
      const prior = owners.get(key), collision = requests.get(requestId)
      if (prior && prior.owner !== owner || collision && collision !== prior) return false
      if (prior) requests.delete(prior.requestId)
      // Native observations update in place; an explicitly retired/replaced service question moves last.
      if (reinsert) owners.delete(key)
      const entry = { owner, key, requestId, frame, ...audience }
      owners.set(key, entry)
      requests.set(requestId, entry)
      return true
    },
    remove(owner: object, key: string, requestId: string): QuestionPresentation | undefined {
      const current = owners.get(key)
      if (!current || current.owner !== owner || current.requestId !== requestId) return undefined
      owners.delete(key)
      requests.delete(requestId)
      return current
    },
  }
}
export type QuestionPresentations = ReturnType<typeof createQuestionPresentations>

/** A close uses the identity of the accepted question, including when its owner is being removed. */
export const questionClose = (frame: Frame): Frame => ({ type: 'commander_question_close', agentId: frame.agentId,
  dbSessionId: frame.dbSessionId, payload: { requestId: frame.payload.requestId } })

export interface QuestionDeps {
  questionControlFor: import('../lib/questionControl.js').QuestionControlFor
  readQuestion: import('../lib/questionController.js').QuestionWatcherDeps['readQuestion']
  resolve: (id: string) => RegisteredSession | undefined
  terminal: Pick<TerminalControl, 'captureTerminal' | 'submitTerminal' | 'keyTerminal'>
  /** Holds a pane, queue and terminal both, for the whole multi-step answer (Input.acquireTerminalControl). */
  acquireTerminalControl: (id: string, opts?: { forAnswer?: boolean }) => (() => void) | null
  /** The dial (`sendCommander`), the windows on this computer (`sendLocal`) and the owner's apps away from
   *  this desk, over the relay (`sendRemote`). */
  clients: { sendCommander(frame: Frame): void; sendLocal(frame: Frame): void; sendRemote(frame: Frame): void }
  agentIdFor: (sessionId: string) => string
  sessionTurnOpen: (sessionId: string) => boolean
  /** Real app/tool observation scopes and the existing commander/cable audience. */
  observed: (agentId: string) => boolean
  input: Pick<SessionInputController, 'setUserAction'>
  /** The person is no longer waited on there: a question closed, or the pane read clear after a wait hook
   *  (core/turns/turnHooks.ts). */
  waitOver: (sessionId: string) => void
}

export function createQuestions({
  questionControlFor, readQuestion, resolve, terminal, acquireTerminalControl, clients, agentIdFor, sessionTurnOpen, observed, input,
  waitOver,
}: QuestionDeps) {
  const { captureTerminal, submitTerminal, keyTerminal } = terminal
  // AskUserQuestion bridge: mirrors the question to the device's question screen, and keys the device's
  // answer back into the CLI's own terminal dialog.
  const questions = new AskQuestionController({
    questionControlFor,
    getSession: (id) => resolve(id),
    capture: captureTerminal,
    readQuestion,
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
  const presentations = createQuestionPresentations(), nativeOwner = {}
  const openQuestions = presentations.openQuestions
  // The AskUserQuestions open by session, and when each was seen open: what lets the input close one for a person's message
  // (core/input.ts `beforeTeamWrite`). A permission prompt is not one.
  const pending = new Map<string, { openedAt: number; text: string }>()
  const pendingQuestion = (sessionId: string): { openedAt: number; text: string } | null => pending.get(sessionId) ?? null
  const monitorActivity = (sessionId: string): 'needsInput' | 'working' | 'idle' => openQuestions.has(sessionId)
    ? 'needsInput' : sessionTurnOpen(sessionId) ? 'working' : 'idle'
  // Who hears that a question was asked or answered: the recaps, which do not announce a turn waiting on
  // the person as done (services/recaps.ts). Told once they exist; a question before then is nobody's news.
  let heard: ((kind: 'asked' | 'answered', sessionId: string, requestId: string) => void) | null = null
  const hearQuestions = (listener: typeof heard): void => { heard = listener }
  const questionWatcher = new QuestionWatcher({
    getSession: (id) => resolve(id),
    capture: captureTerminal,
    readQuestion,
    // A tool cannot answer, but the agent waiting on this harness tells the person: with no window, dial or app here
    // the question was never looked for, and `harness wait` read the screen itself every 3 s to find it.
    hasDevice: (sessionId) => observed(agentIdFor(sessionId)),
    isDriving: (sessionId) => questions.isDriving(sessionId),
    onQuestion: (sessionId, requestId, shaped, detail) => {
      const asked = {
        type: 'commander_question',
        agentId: agentIdFor(sessionId),
        dbSessionId: sessionId,
        // A question is always news: the person is needed (lib/agentNotifications.ts `asked`, which the
        // recaps keep to hold back the turn's own "done").
        payload: { requestId, questions: shaped, notification: { id: requestId, kind: 'needsYou' },
          // Robot clients need to distinguish a permission notice from an answerable question.
          ...(detail?.permission ? { permission: { dialog: detail.dialog, resolution: 'desktop' } } : {}),
        },
      }
      if (!presentations.set(nativeOwner, sessionId, asked, { dial: true, remote: true })) {
        console.warn('[question] QUESTION_ID_CONFLICT'); return
      }
      input.setUserAction(agentIdFor(sessionId), true)
      questions.remember(requestId, sessionId)
      if (!detail?.permission) pending.set(sessionId, { openedAt: Date.now(), text: shaped[0]?.q ?? '' })
      else pending.delete(sessionId)
      showAwaitingAnswer(sessionId)
      heard?.('asked', sessionId, requestId)
      clients.sendCommander(asked)
      // ...and to the window on this computer. `sendCommander` is `webEligible: false`, so until this
      // second call the app could not learn that an agent was blocked even though the question had
      // already been shaped for the dial. Loopback needs no envelope. `sendLocal`, not `send`: the tool
      // connections (`hn`, scripts) were never sent a question, and still are not.
      clients.sendLocal(asked)
      // ...and to the owner's apps away from this desk, over the relay (2026-10-21), so a phone hears an
      // agent waiting on it. Sealed all the same: the gateway seals `commander_question` for the web
      // audience as it does for the devices (lib/e2ee/manager.ts `SEALED_FOR_WEB`), without core.ts and
      // its pinned hash, since every app opens by the envelope. Only the owner's apps, and a guest's for the
      // guest's own harness (gateway.ts `broadcast`), can open it.
      clients.sendRemote(asked)
      console.log('[question] asked')
    },
    // Answered somewhere else — the app, or the pane by hand. Every client drawing it is told to stop
    // waiting, down the SAME path the question itself took, so the dial and the WiFi device cannot
    // disagree about whether a question is still open.
    onQuestionGone: (sessionId, requestId) => {
      const current = presentations.current(sessionId)
      if (current && (current.owner !== nativeOwner || current.requestId !== requestId)) return
      presentations.remove(nativeOwner, sessionId, requestId)
      heard?.('answered', sessionId, requestId)
      pending.delete(sessionId)
      waitOver(sessionId)
      input.setUserAction(agentIdFor(sessionId), false)
      const closed = questionClose(current?.frame ?? { type: 'commander_question', agentId: agentIdFor(sessionId),
        dbSessionId: sessionId, payload: { requestId } })
      clients.sendCommander(closed)
      // Down the SAME two paths the question took, so no client is left drawing a dialog that another
      // one already answered. This is the mechanism behind "answer anywhere": the dial is cabled to
      // this very computer, so the dial and this window are always the same machine's audience.
      clients.sendLocal(closed)
      clients.sendRemote(closed)
      console.log('[question] closed')
    },
    onClear: waitOver,
  })
  /**
   * An app away from this desk gained a session: it is told every question still open, then which are open
   * at all, so one that was here before lets go of a question answered while it was away — as a window on
   * this computer is when it attaches (localWsServer.ts). Over the relay this reaches every app connected,
   * and each takes a question it already holds as the same wait continuing, never as news.
   */
  const snapshot = presentations.snapshot
  const reannounceRemote = (): void => replayLegacyQuestions(snapshot('remote'), frame => clients.sendRemote(frame as Frame))
  const questionResponse = createQuestionResponse(answer)
  return { questions, showAwaitingAnswer, answer, questionResponse, openQuestions, presentations, pendingQuestion, monitorActivity, hearQuestions, questionWatcher, snapshot, reannounceRemote }
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
