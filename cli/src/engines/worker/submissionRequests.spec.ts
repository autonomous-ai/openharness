import { afterEach, describe, expect, it, vi } from 'vitest'
import { submissionFor } from '../submissions.js'
import type { EngineSubmission } from '../facets/submission.js'
import { engineSubmissionRequests } from './submissionRequests.js'
import { SUBMISSION_CAPABILITIES, SUBMISSION_ECHO, SUBMISSION_IN_FLIGHT, SUBMISSION_READ, SUBMISSION_TEXT_BYTES, SUBMISSION_WAIT_MS } from './submissionProtocol.js'

const who = { owner: true, local: true }
const capture = '\n\u001b[1m›\u001b[0m hello\n\n  ? for shortcuts'
const fail = (error: string) => ({ version: 1, error })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('read-only engine submission workers', () => {
  it.each(['claude', 'codex'] as const)('%s answers with its own reading, loaded once and only when first asked', async engine => {
    const load = vi.fn(async () => submissionFor(engine)!)
    const requests = engineSubmissionRequests(engine, { load })
    expect(await requests[SUBMISSION_CAPABILITIES]({ version: 1 }, who)).toEqual({ version: 1, submission: 1, engine })
    expect(load).not.toHaveBeenCalled()
    expect(await requests[SUBMISSION_READ]({ version: 1, capture, prompt: 'hello' }, who)).toEqual({ version: 1, answer: { draft: true, composer: true, nativeDraft: 'pending' } })
    expect(await requests[SUBMISSION_READ]({ version: 1, capture: '› \n', prompt: 'hello', requestId: 'core-route-2' }, who))
      .toEqual({ version: 1, answer: { draft: false, composer: true, nativeDraft: 'clear' } })
    const recorded = '<pasted_content id="ab">\nhello\n</pasted_content id="ab">'
    expect(await requests[SUBMISSION_ECHO]({ version: 1, recorded }, who))
      .toEqual({ version: 1, answer: engine === 'claude' ? { start: 25, end: 30 } : { start: 0, end: recorded.length } })
    expect(load).toHaveBeenCalledOnce()
  })

  it('accepts only private local core requests with bounded text', async () => {
    const load = vi.fn(async () => submissionFor('claude')!)
    const requests = engineSubmissionRequests('claude', { load })
    const read = { version: 1, capture, prompt: 'hello' }
    for (const asker of [{ owner: false, local: true }, { owner: true, local: false }, { ...who, connection: 'client' }]) {
      expect(await requests[SUBMISSION_READ](read, asker)).toEqual(fail('ENGINE_INVALID_REQUEST'))
    }
    for (const payload of [{ ...read, version: 2 }, { ...read, prompt: 42 }, { ...read, capture: 'é'.repeat(256 * 1024) },
      { ...read, prompt: 'x'.repeat(SUBMISSION_TEXT_BYTES + 1) }, { ...read, pane: '%1' }, { ...read, requestId: 7 },
      { ...read, requestId: 'x'.repeat(201) }]) {
      expect(await requests[SUBMISSION_READ](payload, who)).toEqual(fail('ENGINE_INVALID_REQUEST'))
    }
    for (const payload of [{ version: 1, recorded: 7 }, { version: 1, recorded: 'hello', capture }]) {
      expect(await requests[SUBMISSION_ECHO](payload, who)).toEqual(fail('ENGINE_INVALID_REQUEST'))
    }
    expect(await requests[SUBMISSION_ECHO]({ version: 1, recorded: 'hello' }, who, AbortSignal.abort())).toEqual(fail('ENGINE_UNAVAILABLE'))
    expect(load).not.toHaveBeenCalled()
  })

  it('bounds concurrent readings, recycles a stalled worker, and retries an import that failed', async () => {
    vi.useFakeTimers()
    const recycle = vi.fn()
    let finish!: (value: EngineSubmission) => void
    const requests = engineSubmissionRequests('codex', { recycle, load: () => new Promise(resolve => { finish = resolve }) })
    const send = () => requests[SUBMISSION_ECHO]({ version: 1, recorded: 'hello' }, who)
    const pending = Array.from({ length: SUBMISSION_IN_FLIGHT }, send)
    expect(await send()).toEqual(fail('ENGINE_BUSY'))
    await vi.advanceTimersByTimeAsync(SUBMISSION_WAIT_MS)
    for (const reading of pending) expect(await reading).toEqual(fail('ENGINE_UNAVAILABLE'))
    expect(recycle).toHaveBeenCalled()
    finish(submissionFor('codex')!)
    vi.useRealTimers()
    const load = vi.fn().mockRejectedValueOnce(new Error('import failed')).mockResolvedValue(submissionFor('codex'))
    const retry = engineSubmissionRequests('codex', { load })
    expect(await retry[SUBMISSION_ECHO]({ version: 1, recorded: 'hello' }, who)).toEqual(fail('ENGINE_UNAVAILABLE'))
    expect(await retry[SUBMISSION_ECHO]({ version: 1, recorded: 'hello' }, who)).toEqual({ version: 1, answer: { start: 0, end: 5 } })
  })

  it('drops work for a closed connection and rejects a faulty reader\'s answers', async () => {
    const closed = new AbortController()
    const requests = engineSubmissionRequests('claude', { load: async () => { closed.abort(); return submissionFor('claude')! } })
    expect(await requests[SUBMISSION_READ]({ version: 1, capture, prompt: 'hello' }, who, closed.signal)).toEqual(fail('ENGINE_UNAVAILABLE'))
    const faulty = (reader: Partial<EngineSubmission>) => engineSubmissionRequests('claude', { load: async () => ({ ...submissionFor('claude')!, ...reader }) })
    expect(await faulty({ echo: () => ({ start: 0, end: 99 }) })[SUBMISSION_ECHO]({ version: 1, recorded: 'hello' }, who)).toEqual(fail('ENGINE_INVALID_REPLY'))
    expect(await faulty({ read: () => ({ draft: true }) as never })[SUBMISSION_READ]({ version: 1, capture, prompt: 'hello' }, who)).toEqual(fail('ENGINE_INVALID_REPLY'))
    expect(await faulty({ read: () => ({ draft: true, composer: true, nativeDraft: 'clear', note: 'x'.repeat(8192) }) as never })[SUBMISSION_READ]({ version: 1, capture, prompt: 'hello' }, who)).toEqual(fail('ENGINE_REPLY_TOO_LARGE'))
    expect(await faulty({ echo: () => { throw new Error('bad decoder') } })[SUBMISSION_ECHO]({ version: 1, recorded: 'hello' }, who)).toEqual(fail('ENGINE_UNAVAILABLE'))
  })
})
