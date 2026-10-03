import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuestionWatcher } from './askQuestion.js'
import type { RegisteredSession } from './registry.js'

const QUESTION = readFileSync(join(__dirname, '__fixtures__/question-single.txt'), 'utf8')
const NEXT = readFileSync(join(__dirname, '__fixtures__/question-multi.txt'), 'utf8')
const watchers: QuestionWatcher[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(capture = vi.fn(async (_target: string): Promise<string | null> => QUESTION)) {
  const sessions = new Map<string, RegisteredSession>()
  const add = (id: string) => {
    const session = { sessionId: id, agentId: `agent-${id}`, engine: 'claude', active: true,
      tmuxPane: `%${sessions.size}`, processIdentity: { pid: 100 + sessions.size, startMarker: 'original', executable: '/bin/claude' } } as RegisteredSession
    sessions.set(id, session)
    return session
  }
  add('s1')
  const state = { audience: true, driving: false }
  const onQuestion = vi.fn()
  const onQuestionGone = vi.fn()
  const watcher = new QuestionWatcher({ getSession: id => sessions.get(id), capture,
    hasDevice: () => state.audience, isDriving: () => state.driving, onQuestion, onQuestionGone })
  watchers.push(watcher)
  return { watcher, sessions, add, state, capture, onQuestion, onQuestionGone }
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}) })
afterEach(() => { for (const watcher of watchers.splice(0)) watcher.stopAll(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('question polling resources and capture lifetime', () => {
  it('uses one clock for staggered sessions and releases it when the last watcher stops', async () => {
    const h = harness()
    h.watcher.start('s1')
    await vi.advanceTimersByTimeAsync(100)
    h.add('s2'); h.watcher.start('s2')
    await vi.advanceTimersByTimeAsync(100)
    h.add('s3'); h.watcher.start('s3')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_300)
    expect(h.capture.mock.calls.map(([target]) => target)).toEqual(['agent-s1', 'agent-s2', 'agent-s3'])
    h.watcher.stop('s1'); h.watcher.stop('s2')
    expect(vi.getTimerCount()).toBe(1)
    h.watcher.stop('s3')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not overlap a slow poll or delay other sessions behind it', async () => {
    const slow = deferred<string | null>()
    const h = harness(vi.fn(async target => target === 'agent-s1' ? slow.promise : QUESTION))
    h.add('s2'); h.watcher.start('s1'); h.watcher.start('s2')
    await vi.advanceTimersByTimeAsync(4_500)
    expect(h.capture.mock.calls.filter(([target]) => target === 'agent-s1')).toHaveLength(1)
    expect(h.capture.mock.calls.filter(([target]) => target === 'agent-s2')).toHaveLength(3)
    expect(h.onQuestion.mock.calls.map(([id]) => id)).toEqual(['s2'])
    slow.resolve(QUESTION)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.onQuestion.mock.calls.map(([id]) => id)).toEqual(['s2', 's1'])
  })

  it.each(['stop', 'stopAll'] as const)('discards a poll that completes after %s', async method => {
    const slow = deferred<string | null>()
    const h = harness(vi.fn(async () => slow.promise))
    h.watcher.start('s1')
    await vi.advanceTimersByTimeAsync(1_500)
    if (method === 'stop') h.watcher.stop('s1'); else h.watcher.stopAll()
    slow.resolve(QUESTION)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.onQuestion).not.toHaveBeenCalled()
    expect(h.onQuestionGone).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a stop/restart discards the old poll without starting a second concurrent capture', async () => {
    const slow = deferred<string | null>()
    const h = harness(vi.fn(async (): Promise<string | null> => QUESTION).mockImplementationOnce(() => slow.promise))
    h.watcher.start('s1')
    await vi.advanceTimersByTimeAsync(1_500)
    h.watcher.stop('s1'); h.watcher.start('s1')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.capture).toHaveBeenCalledTimes(1)
    slow.resolve(NEXT)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.onQuestion).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.onQuestion).toHaveBeenCalledOnce()
    expect(h.onQuestion.mock.calls[0][2][0].q).toBe('Which drink would you like?')
  })

  it.each(['audience', 'driving'] as const)('rechecks %s after awaiting capture', async changed => {
    const slow = deferred<string | null>()
    const h = harness(vi.fn(async () => slow.promise))
    h.watcher.start('s1')
    await vi.advanceTimersByTimeAsync(1_500)
    if (changed === 'audience') h.state.audience = false; else h.state.driving = true
    slow.resolve(QUESTION)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.onQuestion).not.toHaveBeenCalled()
  })

  it.each(['process', 'reused pid', 'pane', 'runtime', 'engine', 'inactive', 'removed'] as const)('rejects a capture when the session is %s before it returns', async changed => {
    const slow = deferred<string | null>()
    const h = harness(vi.fn(async (): Promise<string | null> => QUESTION).mockImplementationOnce(() => slow.promise))
    h.watcher.start('s1')
    await vi.advanceTimersByTimeAsync(1_500)
    const session = h.sessions.get('s1')!
    if (changed === 'process') session.processIdentity = { pid: 500, startMarker: 'replacement', executable: '/bin/claude' }
    if (changed === 'reused pid') session.processIdentity!.startMarker = 'replacement'
    if (changed === 'pane') session.tmuxPane = '%50'
    if (changed === 'runtime') session.runtimes = [{ backend: 'tmux', paneId: '%50' }]
    if (changed === 'engine') session.engine = 'codex'
    if (changed === 'inactive') session.active = false
    if (changed === 'removed') h.sessions.delete('s1')
    slow.resolve(QUESTION)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.onQuestion).not.toHaveBeenCalled()
    if (changed === 'inactive' || changed === 'removed') {
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.capture).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('a failed read is not evidence a question closed, and breaks consecutive empty reads', async () => {
    const capture = vi.fn(async (): Promise<string | null> => '')
      .mockResolvedValueOnce(QUESTION).mockResolvedValueOnce('')
      .mockResolvedValueOnce(null).mockResolvedValueOnce('')
    const h = harness(capture)
    h.watcher.start('s1')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.onQuestion).toHaveBeenCalledOnce()
    expect(h.onQuestionGone).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.onQuestionGone).toHaveBeenCalledOnce()
  })

  it('releases the pending poll after a rejected capture and retries on the next tick', async () => {
    const h = harness(vi.fn(async (): Promise<string | null> => QUESTION).mockRejectedValueOnce(new Error('capture failed')))
    h.watcher.start('s1')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.capture).toHaveBeenCalledTimes(2)
    expect(h.onQuestion).toHaveBeenCalledOnce()
  })

  it('a rejected turn-start read does not suppress a question or escape as an unhandled rejection', async () => {
    const h = harness(vi.fn(async (): Promise<string | null> => QUESTION).mockRejectedValueOnce(new Error('baseline failed')))
    h.watcher.start('s1'); h.watcher.noteTurnStart('s1')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.capture).toHaveBeenCalledTimes(2)
    expect(h.onQuestion).toHaveBeenCalledOnce()
  })

  it.each(['stop', 'stopAll', 'next turn'] as const)('a late turn-start read cannot suppress a later question after %s', async changed => {
    const slow = deferred<string | null>()
    const h = harness(vi.fn(async (): Promise<string | null> => QUESTION)
      .mockImplementationOnce(() => slow.promise).mockResolvedValueOnce(''))
    h.watcher.start('s1'); h.watcher.noteTurnStart('s1')
    if (changed === 'stop') h.watcher.stop('s1')
    if (changed === 'stopAll') h.watcher.stopAll()
    h.watcher.start('s1'); h.watcher.noteTurnStart('s1')
    await vi.advanceTimersByTimeAsync(0)
    slow.resolve(QUESTION)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.onQuestion).toHaveBeenCalledOnce()
  })
})
