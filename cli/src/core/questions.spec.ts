import { parseEngineQuestionPane } from '../engines/screens.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { createQuestionResponse, createQuestions, type QuestionDeps } from './questions.js'

const agents = new Map<string, RegisteredSession>([
  ['s1', { agentId: 'a1', sessionId: 's1', engine: 'claude' } as RegisteredSession],
  ['a1', { agentId: 'a1', sessionId: 's1', engine: 'claude' } as RegisteredSession],
])

function setup(over: Partial<QuestionDeps> = {}) {
  const deps: QuestionDeps = {
    questionControlFor: () => undefined,
    readQuestion: (session, capture) => parseEngineQuestionPane(session.engine, capture),
    resolve: (id) => agents.get(id),
    terminal: {
      captureTerminal: vi.fn(async () => 'pane'),
      submitTerminal: vi.fn(async () => true),
      keyTerminal: vi.fn(async () => true),
    },
    acquireTerminalControl: vi.fn(() => () => {}),
    clients: { sendCommander: vi.fn(), sendLocal: vi.fn() },
    agentIdFor: (sessionId) => agents.get(sessionId)?.agentId ?? sessionId,
    sessionTurnOpen: (sessionId) => sessionId === 'busy',
    someoneCanAnswer: () => true,
    deviceInput: { setUserAction: vi.fn() },
    ...over,
  }
  return { deps, asking: createQuestions(deps) }
}

/** What a controller was constructed with. */
const given = (controller: object) => (controller as unknown as { deps: Record<string, (...args: unknown[]) => unknown> }).deps

const waiting = (sessionId: string, agentId = sessionId) => ({
  type: 'commander_event', agentId, dbSessionId: sessionId, payload: { kind: 'processing', text: 'Waiting for your answer' },
})

describe('questions', () => {
  afterEach(() => vi.restoreAllMocks())

  it('drives the pane through the terminal it was given, holding it for the whole answer', () => {
    const { deps, asking } = setup()
    const controller = given(asking.questions)
    expect((controller.getSession('s1') as RegisteredSession).agentId).toBe('a1')
    expect(controller.capture).toBe(deps.terminal.captureTerminal)
    expect(controller.sendText).toBe(deps.terminal.submitTerminal)
    expect(controller.sendKey).toBe(deps.terminal.keyTerminal)
    expect(controller.acquireControl).toBe(deps.acquireTerminalControl)
    const watcher = given(asking.questionWatcher)
    expect((watcher.getSession('a1') as RegisteredSession).sessionId).toBe('s1')
    expect(watcher.capture).toBe(deps.terminal.captureTerminal)
    expect(watcher.hasDevice()).toBe(true)
    const driving = vi.spyOn(asking.questions, 'isDriving').mockReturnValue(true)
    expect(watcher.isDriving('s1')).toBe(true)
    expect(driving).toHaveBeenCalledWith('s1')
  })

  it('keeps the dial working while an answer is on its way, and returns the answer\'s result', async () => {
    const { deps, asking } = setup()
    const answer = vi.spyOn(asking.questions, 'answer').mockResolvedValue({ ok: true })
    expect(await asking.answer({ sessionId: 's1', requestId: 'r1', answers: {} })).toEqual({ ok: true })
    await asking.answer({ agentId: 'a2', requestId: 'r2' })
    await asking.answer({ sessionId: '', requestId: 'r3' })
    await asking.answer({ requestId: 'r4' })
    expect(vi.mocked(deps.clients.sendCommander).mock.calls).toEqual([[waiting('s1', 'a1')], [waiting('a2')]])
    expect(answer).toHaveBeenCalledTimes(4)
  })

  it('reports an agent as needing input while it asks, working while its turn is open, idle otherwise', () => {
    const { asking } = setup()
    asking.openQuestions.set('s1', {})
    expect(asking.monitorActivity('s1')).toBe('needsInput')
    expect(asking.monitorActivity('busy')).toBe('working')
    expect(asking.monitorActivity('quiet')).toBe('idle')
  })

  it('shows a question on the dial and the window on this computer, and remembers it for windows that come later', () => {
    const { deps, asking } = setup()
    const remember = vi.spyOn(asking.questions, 'remember')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const shaped = [{ q: 'Ship it?', options: [] }]
    // Before the recaps hear questions, one is nobody else's news; after, they hear each.
    given(asking.questionWatcher).onQuestion('s1', 'r0', shaped)
    vi.mocked(deps.clients.sendCommander).mockClear()
    vi.mocked(deps.clients.sendLocal).mockClear()
    log.mockClear()
    const heard = vi.fn()
    asking.hearQuestions(heard)
    given(asking.questionWatcher).onQuestion('s1', 'r1', shaped)
    expect(heard).toHaveBeenCalledWith('asked', 's1', 'r1')
    expect(deps.deviceInput.setUserAction).toHaveBeenCalledWith('a1', true)
    expect(remember).toHaveBeenCalledWith('r1', 's1')
    const asked = vi.mocked(deps.clients.sendLocal).mock.calls[0][0]
    expect(asked).toMatchObject({ type: 'commander_question', agentId: 'a1', dbSessionId: 's1', payload: { requestId: 'r1', questions: shaped } })
    // A question is always news: the person is needed.
    expect(asked.payload.notification).toEqual({ id: 'r1', kind: 'needsYou' })
    expect(vi.mocked(deps.clients.sendCommander).mock.calls).toEqual([[waiting('s1', 'a1')], [asked]])
    expect(asking.openQuestions.get('s1')).toBe(asked)
    expect(log.mock.calls[0][0]).toContain('asking the user · "Ship it?" · req=r1')
    // A question with nothing shaped still goes out, and still says so.
    given(asking.questionWatcher).onQuestion('s1', 'r2', [])
    expect(log.mock.calls[1][0]).toContain('asking the user · "" · req=r2')
  })

  it.each([true, false])('preserves permission metadata only for approval dialogs (%s)', permission => {
    const { deps, asking } = setup()
    given(asking.questionWatcher).onQuestion('s1', 'r1', [], { permission, dialog: 'Run printf hi?' })
    const frame = vi.mocked(deps.clients.sendCommander).mock.calls[1][0]
    expect(frame.payload.permission).toEqual(permission ? { dialog: 'Run printf hi?', resolution: 'desktop' } : undefined)
    expect(deps.clients.sendLocal).toHaveBeenCalledWith(frame)
    expect(asking.openQuestions.get('s1')).toBe(frame)
  })

  it('closes a question answered elsewhere on every client it was shown on', () => {
    const { deps, asking } = setup()
    const answered = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    // Before the recaps hear questions, an answer is closed all the same.
    given(asking.questionWatcher).onQuestionGone('s1', 'r0')
    vi.mocked(deps.clients.sendCommander).mockClear()
    vi.mocked(deps.clients.sendLocal).mockClear()
    vi.mocked(deps.deviceInput.setUserAction).mockClear()
    log.mockClear()
    asking.hearQuestions(answered)
    asking.openQuestions.set('s1', {})
    given(asking.questionWatcher).onQuestionGone('s1', 'r1')
    const closed = { type: 'commander_question_close', agentId: 'a1', dbSessionId: 's1', payload: { requestId: 'r1' } }
    expect(answered).toHaveBeenCalledWith('answered', 's1', 'r1')
    expect(deps.deviceInput.setUserAction).toHaveBeenCalledWith('a1', false)
    expect(deps.clients.sendCommander).toHaveBeenCalledWith(closed)
    expect(deps.clients.sendLocal).toHaveBeenCalledWith(closed)
    expect(asking.openQuestions.has('s1')).toBe(false)
    expect(log.mock.calls[0][0]).toContain('answered elsewhere · closing on every client · req=r1')
  })
})

describe('question_response', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keys the answer through the questions\' own answer, and says what became of it once typed', async () => {
    const { asking } = setup()
    const typed = vi.spyOn(asking.questions, 'answer').mockResolvedValue({ ok: true })
    const replies: Array<Record<string, unknown>> = []
    asking.questionResponse({ agentId: 'a1', requestId: 'q_1', answers: { q: 'Tea' } }, (result) => { replies.push(result) })
    expect(typed).toHaveBeenCalledWith({ agentId: 'a1', requestId: 'q_1', answers: { q: 'Tea' } })
    await vi.waitFor(() => expect(replies).toStrictEqual([{ ok: true }]))
  })

  it('answers outside the connection\'s line: a refusal, in its fields, or a failure, once the dialog is done', async () => {
    let finish!: (result: { ok: false; error: 'STALE_QUESTION'; detail: string }) => void
    const replies: Array<Record<string, unknown>> = []
    const respond = createQuestionResponse(() => new Promise((resolve) => { finish = resolve }))
    respond({ agentId: 'a1', requestId: 'q_0badf00d', answers: { q: 'Yes' } }, (result) => { replies.push(result) })
    expect(replies).toEqual([])
    finish({ ok: false, error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toStrictEqual({ error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' })
    expect(Object.keys(replies[0])).toEqual(['error', 'detail'])
    createQuestionResponse(async () => { throw new Error('tmux gone') })({ requestId: 'q_2' }, (result) => { replies.push(result) })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies[1]).toStrictEqual({ error: 'ANSWER_FAILED', detail: 'The answer could not be entered.' })
  })

  it('says nothing for an answer nobody took', async () => {
    const reply = vi.fn()
    createQuestionResponse(() => undefined)({ requestId: 'q_3' }, reply)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(reply).not.toHaveBeenCalled()
  })
})
