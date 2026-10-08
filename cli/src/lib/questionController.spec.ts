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
    const controller = new AskQuestionController({ getSession: () => current,
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
