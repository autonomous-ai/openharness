import { createCloudOwners } from '../testing/cloudOwners.js'
import { cloudFactory } from '../testing/sessionFactories.js'
import { prepareCloudQuestion, cloudQuestionClose } from '../cloud/questions.js'
import { parseEngineQuestionPane } from '../engines/screens.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { createQuestionPresentations, createQuestionResponse, createQuestions, type QuestionDeps } from './questions.js'
import { AskQuestionController, questionRequestId } from '../lib/questionController.js'

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
    clients: { sendCommander: vi.fn(), sendLocal: vi.fn(), sendRemote: vi.fn() },
    agentIdFor: (sessionId) => agents.get(sessionId)?.agentId ?? sessionId,
    sessionTurnOpen: (sessionId) => sessionId === 'busy',
    observed: () => true,
    input: { setUserAction: vi.fn() },
    waitOver: vi.fn(),
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

  it.each(['permission', 'capture replacement', 'interpretation replacement', 'confirmed'] as const)('keeps the ordinary response provider guarded for %s', async mode => {
    const row = { agentId: 'a', sessionId: 's', engine: 'claude', active: true } as RegisteredSession
    const question = { kind: 'question' as const, question: 'Continue?', rows: [{ number: '1', label: 'Yes', checked: false }],
      multi: false, typeRow: null, ...(mode === 'permission' ? { permission: true } : {}) }
    const apply = vi.fn(async () => true), release = vi.fn(), sendKey = vi.fn(async () => true), sendText = vi.fn(async () => true)
    let reads = 0
    const controller = new AskQuestionController({ getSession: () => row, questionControlFor: () => ({ apply }),
      capture: async () => { if (mode === 'capture replacement') row.sessionId = 'replacement'; return 'captured' },
      readQuestion: async () => { if (mode === 'interpretation replacement') row.sessionId = 'replacement'; return reads++ ? null : question },
      sendKey, sendText, acquireControl: () => release, wait: async () => {} })
    const payload = { agentId: 'a', requestId: questionRequestId('s', question), answers: { 'Continue?': 'Yes' }, allowPermissions: false }
    const result = await new Promise<Record<string, unknown>>(resolve => createQuestionResponse(answer => controller.answer(answer))(payload, resolve))
    expect(result).toMatchObject(mode === 'confirmed' ? { ok: true } : { error: mode === 'permission' ? 'ANSWER_FAILED' : 'STALE_QUESTION' })
    expect(apply).toHaveBeenCalledTimes(mode === 'confirmed' ? 1 : 0)
    expect(sendKey).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('knows the AskUserQuestion open for a session, and since when; not a permission prompt, not one answered', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    const { asking } = setup()
    const watcher = given(asking.questionWatcher)
    watcher.onQuestion('s1', 'r1', [{ q: 'Ship it?', options: [] }])
    expect(asking.pendingQuestion('s1')).toEqual({ openedAt: 1234, text: 'Ship it?' })
    watcher.onQuestionGone('s1', 'r1')
    expect(asking.pendingQuestion('s1')).toBeNull()
    watcher.onQuestion('s1', 'r2', [], { permission: {}, dialog: 'Run printf hi?' })
    expect(asking.pendingQuestion('s1')).toBeNull()
  })

  it('replaces an ordinary native wait with a permission notice without retaining stale input permission', () => {
    const { asking, deps } = setup(), watcher = given(asking.questionWatcher)
    watcher.onQuestion('s1', 'r1', [{ key: 'q', q: 'Choose?', options: ['Yes'], multi: false }])
    expect(asking.pendingQuestion('s1')).not.toBeNull()
    watcher.onQuestion('s1', 'r2', [], { permission: true, dialog: 'Permission?' })
    expect(asking.pendingQuestion('s1')).toBeNull()
    vi.mocked(deps.input.setUserAction).mockClear()
    watcher.onQuestionGone('s1', 'r1')
    expect(asking.openQuestions.get('s1')?.payload.requestId).toBe('r2')
    expect(asking.monitorActivity('s1')).toBe('needsInput')
    expect(deps.input.setUserAction).not.toHaveBeenCalled()
  })

  it('keeps the newer native question and wait state when the old request closes late', () => {
    let now = 1
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { deps, asking } = setup()
    const watcher = given(asking.questionWatcher)
    watcher.onQuestion('s1', 'r1', [{ q: 'First question', options: ['Yes'] }])
    now = 2
    watcher.onQuestion('s1', 'r2', [{ q: 'New question', options: ['No'] }])
    const current = asking.openQuestions.get('s1')
    vi.mocked(deps.input.setUserAction).mockClear()
    vi.mocked(deps.waitOver).mockClear()
    for (const send of Object.values(deps.clients)) vi.mocked(send).mockClear()
    watcher.onQuestionGone('s1', 'r1')
    expect(asking.openQuestions.get('s1')).toBe(current)
    expect(asking.pendingQuestion('s1')).toEqual({ openedAt: 2, text: 'New question' })
    expect(asking.monitorActivity('s1')).toBe('needsInput')
    expect([...asking.snapshot('remote')]).toEqual([current])
    expect(deps.input.setUserAction).not.toHaveBeenCalled()
    expect(deps.waitOver).not.toHaveBeenCalled()
    for (const send of Object.values(deps.clients)) expect(send).not.toHaveBeenCalled()
    watcher.onQuestionGone('s1', 'r2')
    expect(asking.openQuestions.has('s1')).toBe(false)
    expect(asking.pendingQuestion('s1')).toBeNull()
    expect(deps.input.setUserAction).toHaveBeenCalledWith('a1', false)
  })

  it('logs fixed native question events without question or identifier canaries', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { asking } = setup()
    const watcher = given(asking.questionWatcher)
    watcher.onQuestion('session-canary', 'request-canary', [{ q: 'question-content-canary', options: ['choice-canary'] }],
      { permission: true, dialog: 'permission-content-canary' })
    watcher.onQuestionGone('session-canary', 'request-canary')
    expect(log.mock.calls).toEqual([['[question] asked'], ['[question] closed']])
    expect(JSON.stringify(log.mock.calls)).not.toContain('canary')
  })

  it('keeps actual native and service question routing, replay order and accepted close audiences in one store', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { deps, asking } = setup(), watcher = given(asking.questionWatcher)
    const answer = vi.fn(async () => ({ ok: true })), port = { answer }
    const cloud = createCloudOwners({ ownsFactory: cloudFactory, native: () => false, port: () => port as never,
      clients: { send: vi.fn(), sendCommander: deps.clients.sendCommander, sendLocal: deps.clients.sendLocal },
      questions: asking.presentations, log: () => {} })
    cloud.doors.publish([{ agentId: 'cloud_1', agent: 'fo', name: 'Service', state: 'idle', activity: null,
      repository: null, branch: null, links: [], messages: 0, createdAt: '0', updatedAt: '0' }])
    watcher.onQuestion('s1', 'native_one', [{ q: 'Native first', options: ['Yes'] }])
    const first = prepareCloudQuestion('cloud_1', 'cloud_q_one', { text: 'Service first', choices: [] })
    expect(cloud.doors.ask('cloud_1', 'cloud_q_one', first)).toEqual({ ok: true })
    watcher.onQuestion('s2', 'native_two', [{ q: 'Native second', options: ['No'] }])
    const ids = (audience: 'local' | 'remote') => [...asking.snapshot(audience)].map(frame => frame.payload.requestId)
    expect(ids('local')).toEqual(['native_one', 'cloud_q_one', 'native_two'])
    expect(ids('remote')).toEqual(['native_one', 'native_two'])
    const second = prepareCloudQuestion('cloud_1', 'cloud_q_two', { text: 'Service second', choices: ['Yes'] })
    expect(cloud.doors.ask('cloud_1', 'cloud_q_two', second)).toEqual({ ok: true })
    watcher.onQuestion('s1', 'native_three', [{ q: 'Native changed', options: ['Yes'] }])
    expect(ids('local')).toEqual(['native_three', 'native_two', 'cloud_q_two'])
    expect(ids('remote')).toEqual(['native_three', 'native_two'])
    expect([...asking.openQuestions.values()]).toEqual([...asking.snapshot('local')])
    expect(asking.presentations.request('native_one')).toBeUndefined()
    const nativeAnswer = vi.spyOn(asking.questions, 'answer').mockResolvedValue({ ok: true })
    const route = (payload: Parameters<typeof asking.answer>[0]) => cloud.answer(payload) ?? asking.answer(payload)
    expect(await route({ requestId: 'native_three', answers: { answer: 'Yes' } })).toEqual({ ok: true })
    expect(await route({ requestId: 'cloud_q_two', answers: { answer: 'Yes' } })).toEqual({ ok: true })
    expect(nativeAnswer).toHaveBeenCalledOnce()
    expect(answer).toHaveBeenCalledWith('cloud_1', 'cloud_q_two', { answer: 'Yes' })
    // A retired native request still reaches the existing controller's remembered/screen-proof path.
    await route({ requestId: 'native_one', answers: { answer: 'Yes' } })
    expect(nativeAnswer).toHaveBeenCalledTimes(2)
    const narrow = { ...second, dial: false }
    expect(cloud.doors.ask('cloud_1', 'cloud_q_two', narrow)).toEqual({ ok: true })
    vi.mocked(deps.clients.sendCommander).mockClear()
    cloud.doors.unask('cloud_1', 'cloud_q_one', cloudQuestionClose('cloud_1', 'cloud_q_one'))
    expect(asking.openQuestions.has('cloud_1')).toBe(true)
    cloud.doors.unask('cloud_1', 'cloud_q_two', cloudQuestionClose('cloud_1', 'cloud_q_two'))
    expect(deps.clients.sendCommander).toHaveBeenCalledWith(second.close)
    expect(ids('local')).toEqual(['native_three', 'native_two'])
  })

  it('refuses a conflicting owner or request before native or service question effects', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, asking } = setup(), watcher = given(asking.questionWatcher)
    const cloud = createCloudOwners({ ownsFactory: cloudFactory, native: () => false, port: () => null,
      clients: { send: vi.fn(), sendCommander: deps.clients.sendCommander, sendLocal: deps.clients.sendLocal },
      questions: asking.presentations, log: () => {} })
    cloud.doors.publish([{ agentId: 'cloud_1', agent: 'fo', name: 'Service', state: 'idle', activity: null,
      repository: null, branch: null, links: [], messages: 0, createdAt: '0', updatedAt: '0' }])
    watcher.onQuestion('s1', 'cloud_q_collision', [{ q: 'Native', options: ['Yes'] }])
    expect(cloud.doors.ask('cloud_1', 'cloud_q_collision', prepareCloudQuestion('cloud_1', 'cloud_q_collision', { text: 'Service', choices: [] })))
      .toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
    expect(cloud.doors.unask('cloud_1', 'cloud_q_collision', cloudQuestionClose('cloud_1', 'cloud_q_collision')))
      .toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
    cloud.doors.ask('cloud_1', 'cloud_q_owned', prepareCloudQuestion('cloud_1', 'cloud_q_owned', { text: 'Owned', choices: [] }))
    const current = asking.openQuestions.get('cloud_1')
    vi.mocked(deps.input.setUserAction).mockClear()
    watcher.onQuestion('cloud_1', 'other', [{ q: 'Wrong owner', options: [] }])
    watcher.onQuestionGone('cloud_1', 'cloud_q_owned')
    expect(asking.openQuestions.get('cloud_1')).toBe(current)
    expect(deps.input.setUserAction).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith('[question] QUESTION_ID_CONFLICT')
    // The common request index cannot redirect one owner through another owner's current request.
    watcher.onQuestion('s2', 'cloud_q_collision', [{ q: 'Wrong request', options: [] }])
    expect(asking.openQuestions.has('s2')).toBe(false)
  })

  it('preserves a native question when a service publishes the same owner key', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { asking, deps } = setup(), watcher = given(asking.questionWatcher)
    watcher.onQuestion('cloud_1', 'native_request', [{ q: 'Native', options: ['Yes'] }])
    const native = asking.openQuestions.get('cloud_1')
    const cloud = createCloudOwners({ ownsFactory: cloudFactory, native: () => false, port: () => null,
      clients: { send: vi.fn(), sendCommander: deps.clients.sendCommander, sendLocal: deps.clients.sendLocal },
      questions: asking.presentations, log: () => {} })
    cloud.doors.publish([{ agentId: 'cloud_1', agent: 'fo', name: 'Service', state: 'idle', activity: null,
      repository: null, branch: null, links: [], messages: 0, createdAt: '0', updatedAt: '0' }])
    vi.mocked(deps.clients.sendLocal).mockClear()
    expect(cloud.doors.ask('cloud_1', 'cloud_q_one', prepareCloudQuestion('cloud_1', 'cloud_q_one', { text: 'Service', choices: [] })))
      .toEqual({ ok: false, error: 'SESSION_OWNER_INVALID' })
    cloud.doors.publish([])
    expect(asking.openQuestions.get('cloud_1')).toBe(native)
    expect(asking.presentations.request('native_request')?.frame).toBe(native)
    expect(deps.clients.sendLocal).not.toHaveBeenCalled()
  })

  it('rejects malformed and stale presentation mutations without changing the accepted owner', () => {
    const store = createQuestionPresentations(), owner = {}, other = {}
    const frame = { type: 'commander_question', agentId: 'agent', dbSessionId: 'session', payload: { requestId: 'r1' } }
    expect(store.set(owner, 'session', { ...frame, payload: {} }, { dial: true, remote: true })).toBe(false)
    expect(store.set(owner, 'session', { ...frame, payload: { requestId: '' } }, { dial: true, remote: true })).toBe(false)
    expect(store.set(owner, 'session', frame, { dial: true, remote: true })).toBe(true)
    expect(store.remove(other, 'session', 'r1')).toBeUndefined()
    expect(store.remove(owner, 'session', 'old')).toBeUndefined()
    expect(store.openQuestions.get('session')).toBe(frame)
    expect(store.remove(owner, 'session', 'r1')?.frame).toBe(frame)
    expect(store.remove(owner, 'session', 'r1')).toBeUndefined()
  })

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
    expect(watcher.hasDevice('s1')).toBe(true)
    const driving = vi.spyOn(asking.questions, 'isDriving').mockReturnValue(true)
    expect(watcher.isDriving('s1')).toBe(true)
    expect(driving).toHaveBeenCalledWith('s1')
  })

  // An agent's `harness wait` or `watch` follows a harness by what is pushed (core/toolWatches.ts): with no window, dial or
  // app here, its question was never looked for, and the wait read the screen itself every 3 s to see it.
  it('looks for a question on the screen of a harness a tool follows, though nobody else is here', () => {
    const followed = new Set<string>()
    const { asking } = setup({ observed: (agentId) => followed.has(agentId) })
    const watcher = given(asking.questionWatcher)
    expect(watcher.hasDevice('s1')).toBe(false)
    followed.add('a1')
    expect(watcher.hasDevice('s1')).toBe(true)
    expect(watcher.hasDevice('s2')).toBe(false)
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
    given(asking.questionWatcher).onQuestion('s1', 'r1', [{ q: 'Question', options: [] }])
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
    expect(deps.input.setUserAction).toHaveBeenCalledWith('a1', true)
    expect(remember).toHaveBeenCalledWith('r1', 's1')
    const asked = vi.mocked(deps.clients.sendLocal).mock.calls[0][0]
    expect(asked).toMatchObject({ type: 'commander_question', agentId: 'a1', dbSessionId: 's1', payload: { requestId: 'r1', questions: shaped } })
    // A question is always news: the person is needed.
    expect(asked.payload.notification).toEqual({ id: 'r1', kind: 'needsYou' })
    expect(vi.mocked(deps.clients.sendCommander).mock.calls).toEqual([[waiting('s1', 'a1')], [asked]])
    // The owner's apps away from this desk hear the same question, over the relay.
    expect(vi.mocked(deps.clients.sendRemote).mock.calls.at(-1)).toEqual([asked])
    expect(asking.openQuestions.get('s1')).toBe(asked)
    expect(log.mock.calls[0][0]).toBe('[question] asked')
    // A question with nothing shaped still goes out, and still says so.
    given(asking.questionWatcher).onQuestion('s1', 'r2', [])
    expect(log.mock.calls[1][0]).toBe('[question] asked')
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
    vi.mocked(deps.input.setUserAction).mockClear()
    log.mockClear()
    asking.hearQuestions(answered)
    given(asking.questionWatcher).onQuestion('s1', 'r1', [{ q: 'Question', options: [] }])
    log.mockClear()
    given(asking.questionWatcher).onQuestionGone('s1', 'r1')
    const closed = { type: 'commander_question_close', agentId: 'a1', dbSessionId: 's1', payload: { requestId: 'r1' } }
    expect(answered).toHaveBeenCalledWith('answered', 's1', 'r1')
    expect(deps.input.setUserAction).toHaveBeenCalledWith('a1', false)
    expect(deps.clients.sendCommander).toHaveBeenCalledWith(closed)
    expect(deps.clients.sendLocal).toHaveBeenCalledWith(closed)
    expect(deps.clients.sendRemote).toHaveBeenCalledWith(closed)
    expect(asking.openQuestions.has('s1')).toBe(false)
    expect(log.mock.calls[0][0]).toBe('[question] closed')
  })

  // A hook said the agent waits on the person (core/turns/turnHooks.ts): the watcher says when it no longer does.
  it('a reconnect reset keeps the snapshot question closable before a driving answer can be polled again', async () => {
    vi.useFakeTimers()
    let observed = true
    const { deps, asking } = setup({ observed: () => observed, readQuestion: async () => ({
      kind: 'question', question: 'Drink?', multi: false, typeRow: null,
      rows: [{ number: '1', label: 'Coffee', checked: false }],
    }) })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      asking.questionWatcher.start('s1')
      await vi.advanceTimersByTimeAsync(1_500)
      const [open] = [...asking.snapshot('local')]
      expect(open).toMatchObject({ type: 'commander_question', agentId: 'a1', dbSessionId: 's1' })
      observed = false
      await vi.advanceTimersByTimeAsync(20_000)
      asking.questionWatcher.reset()
      expect([...asking.snapshot('local')]).toEqual([open])
      observed = true
      vi.spyOn(asking.questions, 'isDriving').mockReturnValue(true)
      await vi.advanceTimersByTimeAsync(1_500)
      asking.questionWatcher.stop('s1')
      const closed = { type: 'commander_question_close', agentId: 'a1', dbSessionId: 's1', payload: { requestId: (open.payload as { requestId: string }).requestId } }
      for (const send of [deps.clients.sendCommander, deps.clients.sendLocal, deps.clients.sendRemote]) {
        expect(vi.mocked(send).mock.calls.filter(([frame]) => frame.type === 'commander_question_close')).toEqual([[closed]])
      }
      expect([...asking.snapshot('local')]).toEqual([])
      expect(asking.pendingQuestion('s1')).toBeNull()
      expect(deps.waitOver).toHaveBeenCalledExactlyOnceWith('s1')
      asking.questionWatcher.stop('s1')
      expect(deps.waitOver).toHaveBeenCalledOnce()
    } finally { asking.questionWatcher.stopAll(); vi.useRealTimers() }
  })

  it('tells the turn hooks when a question closes and when the pane reads clear', async () => {
    vi.useFakeTimers()
    try {
      const waitOver = vi.fn()
      const { asking } = setup({ waitOver })
      vi.spyOn(console, 'log').mockImplementation(() => {})
      given(asking.questionWatcher).onQuestionGone('s1', 'r1')
      expect(waitOver).toHaveBeenCalledExactlyOnceWith('s1')
      // A dialog answered before any poll found it: two polls in a row read the pane with none.
      asking.questionWatcher.start('s1')
      asking.questionWatcher.awaitDialog('s1')
      await vi.advanceTimersByTimeAsync(1_500 * 2)
      expect(waitOver.mock.calls).toEqual([['s1'], ['s1']])
      asking.questionWatcher.stopAll()
    } finally { vi.useRealTimers() }
  })

  it('tells an app that connects every question still open, then which are open at all', () => {
    const { deps, asking } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const remote = vi.mocked(deps.clients.sendRemote)
    // Nothing open: only the list, empty, so an app that was here before lets go of what it held.
    asking.reannounceRemote()
    expect(remote.mock.calls).toEqual([[{ type: 'commander_questions_open', payload: { requestIds: [] } }]])
    given(asking.questionWatcher).onQuestion('s1', 'r1', [{ q: 'Ship it?', options: [] }])
    given(asking.questionWatcher).onQuestion('s2', 'r2', [{ q: 'Which branch?', options: [] }])
    given(asking.questionWatcher).onQuestionGone('s2', 'r2')
    const asked = asking.openQuestions.get('s1')
    remote.mockClear()
    asking.reannounceRemote()
    expect(remote.mock.calls).toEqual([[asked], [{ type: 'commander_questions_open', payload: { requestIds: ['r1'] } }]])
  })

  it('never tells the relay a question it did not ask: a cloud agent\'s shares the open list, not the relay', () => {
    const { deps, asking } = setup()
    asking.presentations.set({}, 'cloud-a', { type: 'commander_question', agentId: 'cloud-a', payload: { requestId: 'cloud_q_1' } }, { dial: true, remote: false })
    asking.reannounceRemote()
    expect(vi.mocked(deps.clients.sendRemote).mock.calls).toEqual([[{ type: 'commander_questions_open', payload: { requestIds: [] } }]])
  })

  it('gives actual local and remote replay adapters the current owner iterator with their original audiences', () => {
    const { asking } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    given(asking.questionWatcher).onQuestion('s1', 'pane', [{ q: 'Pane question', options: [] }])
    const pane = asking.openQuestions.get('s1')
    const cloudOwner = {}, cloud = { type: 'commander_question', agentId: 'cloud-a', payload: { requestId: 'cloud_q_1' } }
    asking.presentations.set(cloudOwner, 'cloud-a', cloud, { dial: true, remote: false })
    const local = asking.snapshot('local')
    expect(local.next().value).toBe(pane)
    // The iterator sees the current owner, not a copied array made before a close.
    asking.presentations.remove(cloudOwner, 'cloud-a', 'cloud_q_1')
    expect(local.next().done).toBe(true)
    asking.presentations.set(cloudOwner, 'cloud-a', cloud, { dial: true, remote: false })
    expect([...asking.snapshot('local')]).toEqual([pane, cloud])
    expect([...asking.snapshot('remote')]).toEqual([pane])
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
