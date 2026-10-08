import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screenFor } from '../engines/screens.js'
import type { PaneView } from '../engines/facets/screen.js'
import type { RegisteredSession } from './registry.js'
import { AskQuestionController, QuestionWatcher } from './questionController.js'

const capture = readFileSync(new URL('./__fixtures__/permission-claude.txt', import.meta.url), 'utf8')
const view = screenFor('claude').inspect(capture).question
const row = () => ({ agentId: 'agent', sessionId: 'session', engine: 'claude', active: true }) as RegisteredSession
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('asynchronous question evidence', () => {
  it('binds native control before capture and snapshots the reviewed answer', async () => {
    const current = row(), release = vi.fn(), apply = vi.fn(async () => true), questionControlFor = vi.fn(() => ({ apply }))
    const sendKey = vi.fn(async () => true), sendText = vi.fn(async () => true)
    const question = { kind: 'question' as const, question: 'Drink?', multi: false, typeRow: null,
      rows: [{ number: '1', label: 'Tea', checked: false }, { number: '2', label: 'Coffee', checked: false }] }
    const payload = { agentId: 'agent', answers: { 'Drink?': 'Coffee' }, expectedQuestions: [{ key: 'Drink?', q: 'Drink?', options: ['Tea', 'Coffee'], multi: false }] }
    const readQuestion = vi.fn(async (): Promise<PaneView> => question).mockResolvedValueOnce(question).mockResolvedValueOnce(null)
    const controller = new AskQuestionController({ getSession: () => current, questionControlFor, readQuestion, sendKey, sendText,
      acquireControl: () => release, capture: async () => {
        expect(questionControlFor).toHaveBeenCalledOnce()
        payload.answers['Drink?'] = 'Tea'; payload.expectedQuestions[0].options = ['changed']
        return capture
      } })
    expect(await controller.answer(payload)).toEqual({ ok: true })
    expect(apply).toHaveBeenCalledWith({ kind: 'select', row: question.rows[1], enterSubmits: undefined })
    expect(sendKey).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not use the local writer after the bound native driver fails', async () => {
    const current = row(), sendKey = vi.fn(async () => true), sendText = vi.fn(async () => true), release = vi.fn()
    const controller = new AskQuestionController({ getSession: () => current, capture: async () => capture,
      readQuestion: async () => view, sendKey, sendText, acquireControl: () => release,
      questionControlFor: () => ({ apply: async () => { throw new Error('worker went away') } }) })
    if (!view || view.kind !== 'question') throw new Error('missing recorded fixture')
    expect(await controller.answer({ agentId: 'agent', answers: { [view.question]: view.rows[0].label } })).toMatchObject({ ok: false, error: 'ANSWER_FAILED' })
    expect(sendKey).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases its lease and types nothing when the control port cannot be bound', async () => {
    const current = row(), sendKey = vi.fn(async () => true), sendText = vi.fn(async () => true), release = vi.fn()
    let bind: () => undefined = () => { throw new Error('no control port') }
    const controller = new AskQuestionController({ getSession: () => current, capture: async () => capture,
      readQuestion: async () => view, sendKey, sendText, acquireControl: () => release, questionControlFor: () => bind() })
    if (!view || view.kind !== 'question') throw new Error('missing recorded fixture')
    const answer = { agentId: 'agent', answers: { [view.question]: view.rows[0].label } }
    expect(await controller.answer(answer)).toMatchObject({ ok: false, error: 'ANSWER_FAILED' })
    expect(sendKey).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
    // Nothing is left marked as driving this terminal: the next answer is entered, not refused as busy.
    bind = () => undefined
    expect(await controller.answer(answer)).not.toMatchObject({ error: 'ANSWER_BUSY' })
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('keeps a previously announced question while the screen reader is unavailable', async () => {
    vi.useFakeTimers()
    const current = row(), onQuestion = vi.fn(), onQuestionGone = vi.fn()
    const readQuestion = vi.fn(async (): Promise<PaneView> => view)
    const watcher = new QuestionWatcher({ getSession: () => current, capture: async () => capture,
      hasDevice: () => true, readQuestion, onQuestion, onQuestionGone })
    watcher.start(current.sessionId)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(onQuestion).toHaveBeenCalledOnce()
    readQuestion.mockRejectedValue(new Error('worker unavailable'))
    await vi.advanceTimersByTimeAsync(6_000)
    expect(onQuestionGone).not.toHaveBeenCalled()
    readQuestion.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(onQuestionGone).toHaveBeenCalledOnce()
    watcher.stopAll()
  })
  it.each(['replace', 'stop'] as const)('holds one pending interpretation and discards it after %s', async change => {
    vi.useFakeTimers()
    const current = row(), pending = deferred<PaneView>(), onQuestion = vi.fn()
    const readQuestion = vi.fn(() => pending.promise)
    const watcher = new QuestionWatcher({ getSession: () => current, capture: async () => capture,
      hasDevice: () => true, readQuestion, onQuestion })
    watcher.start(current.sessionId)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(readQuestion).toHaveBeenCalledOnce()
    if (change === 'stop') watcher.stop(current.sessionId)
    else current.sessionId = 'replacement'
    pending.resolve(view)
    await vi.advanceTimersByTimeAsync(0)
    expect(onQuestion).not.toHaveBeenCalled()
    watcher.stopAll()
  })
  it.each(['unavailable', 'rebound', 'capture-rebound'] as const)('types no answer after %s and releases its input lease', async change => {
    const current = row(), release = vi.fn(), sendKey = vi.fn(async () => true), sendText = vi.fn(async () => true)
    const controller = new AskQuestionController({ questionControlFor: () => undefined, getSession: () => current,
      capture: async () => { if (change === 'capture-rebound') current.sessionId = 'replacement'; return capture },
      sendKey, sendText, acquireControl: () => release,
      readQuestion: async () => {
        if (change === 'unavailable') throw new Error('worker failed')
        current.sessionId = 'replacement'
        return view
      } })
    const result = await controller.answer({ agentId: 'agent', answers: { 'question': 'No' } })
    expect(result).toMatchObject({ ok: false, error: change === 'unavailable' ? 'ANSWER_FAILED' : 'STALE_QUESTION' })
    expect(sendKey).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
})
