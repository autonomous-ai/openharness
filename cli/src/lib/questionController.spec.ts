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

  describe('a native step that failed', () => {
    const question = { kind: 'question' as const, question: 'Drink?', multi: false, typeRow: null,
      rows: [{ number: '1', label: 'Tea', checked: false }, { number: '2', label: 'Coffee', checked: false }] }
    const answer = { agentId: 'agent', answers: { 'Drink?': 'Coffee' } }
    const run = async (failure: 'refused' | 'uncertain' | undefined, views: PaneView[], applies = [false]) => {
      const current = row(), release = vi.fn(), sendKey = vi.fn(async () => true), sendText = vi.fn(async () => true)
      const apply = vi.fn(async () => false)
      for (const value of applies) apply.mockResolvedValueOnce(value)
      const readQuestion = vi.fn(async (): Promise<PaneView> => views.at(-1)!)
      for (const view of views) readQuestion.mockResolvedValueOnce(view)
      const controller = new AskQuestionController({ getSession: () => current, capture: async () => capture, readQuestion, sendKey, sendText,
        acquireControl: () => release, wait: async () => {}, questionControlFor: () => ({ apply, failure: () => failure }) })
      const result = await controller.answer(answer)
      expect(sendKey).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledOnce()
      return { result, apply }
    }

    it('says busy, with nothing typed, when the step was refused before any write', async () => {
      expect((await run('refused', [question])).result).toEqual({ ok: false, error: 'ANSWER_BUSY', detail: expect.stringContaining('Nothing was typed') })
    })

    it('reports the answer taken when a step that wrote failed and the dialog then closed', async () => {
      // Found by the chaos run: the worker was killed after the last key, and the answer was reported failed.
      const { result, apply } = await run('uncertain', [question, null])
      expect(result).toEqual({ ok: true })
      expect(apply).toHaveBeenCalledOnce()
    })

    it('types nothing more, and reports it stuck, when a step that wrote failed and the dialog stayed', async () => {
      const { result, apply } = await run('uncertain', [question])
      expect(result).toMatchObject({ ok: false, error: 'ANSWER_FAILED', detail: 'The question did not take the answer.' })
      expect(apply).toHaveBeenCalledOnce()
    })

    it('keeps the old failure when the port does not say why', async () => {
      expect((await run(undefined, [question])).result).toMatchObject({ ok: false, error: 'ANSWER_FAILED', detail: expect.stringContaining('could not be typed') })
    })

    it('checks the pane once after an uncertain submit of the review: gone is submitted, still there is not', async () => {
      const review: PaneView = { kind: 'review', submitRow: '1' }
      expect((await run('uncertain', [question, review, null], [true, false])).result).toEqual({ ok: true })
      const stayed = await run('uncertain', [question, review, review], [true, false])
      expect(stayed.result).toMatchObject({ ok: false, error: 'ANSWER_FAILED', detail: 'The answers could not be submitted.' })
      expect(stayed.apply).toHaveBeenCalledTimes(2)
      expect((await run('refused', [question, review], [true, false])).result).toMatchObject({ error: 'ANSWER_BUSY' })
      expect((await run(undefined, [question, review], [true, false])).result).toMatchObject({ detail: 'The answers could not be submitted.' })
    })
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
