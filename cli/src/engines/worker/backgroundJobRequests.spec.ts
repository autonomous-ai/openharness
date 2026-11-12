import { describe, expect, it, vi } from 'vitest'
import { backgroundJobFor } from '../backgroundJobs.js'
import { engineBackgroundJobRequests } from './backgroundJobRequests.js'
import { BACKGROUND_JOB_CAPABILITIES, BACKGROUND_JOB_ENV_BYTES, BACKGROUND_JOB_IN_FLIGHT, BACKGROUND_JOB_STOP, BACKGROUND_JOB_WAIT_MS } from './backgroundJobProtocol.js'

const who = { owner: true, local: true }
const stop = { version: 1, bin: '/opt/claude/claude', sessionId: 's1', env: { CLAUDE_CONFIG_DIR: '/custom' } }
const fail = (error: string) => ({ version: 1, error })

describe('Claude Code\'s worker stops a background job holding a session core resumes (#4146)', () => {
  it('stops it with what core sent, loaded once and only when first asked', async () => {
    const run = vi.fn(async () => ({ job: 'bg-1', stopped: true }))
    const load = vi.fn(async () => run)
    const requests = engineBackgroundJobRequests({ load })
    expect(await requests[BACKGROUND_JOB_CAPABILITIES]({ version: 1 }, who)).toEqual({ version: 1, backgroundJob: 1, engine: 'claude' })
    expect(load).not.toHaveBeenCalled()
    expect(await requests[BACKGROUND_JOB_STOP]({ ...stop, requestId: 'core-route-1' }, who)).toEqual({ version: 1, answer: { job: 'bg-1', stopped: true } })
    run.mockResolvedValueOnce(null as never)
    expect(await requests[BACKGROUND_JOB_STOP](stop, who)).toEqual({ version: 1, answer: null })
    expect(run).toHaveBeenCalledWith({ bin: stop.bin, sessionId: 's1', env: stop.env })
    expect(load).toHaveBeenCalledOnce()
  })

  it('takes only core\'s private local request, with a binary, a session and a bounded environment', async () => {
    const run = vi.fn(async () => null)
    const requests = engineBackgroundJobRequests({ load: async () => run })
    expect(await requests[BACKGROUND_JOB_STOP](stop, { owner: true, local: false })).toEqual(fail('ENGINE_INVALID_REQUEST'))
    for (const bad of [{ ...stop, bin: '' }, { ...stop, bin: 'claude\0' }, { ...stop, sessionId: '' }, { ...stop, sessionId: 'x'.repeat(201) },
      { ...stop, env: 'PATH=/bin' }, { ...stop, env: { PATH: 1 } }, { ...stop, env: { BIG: 'x'.repeat(BACKGROUND_JOB_ENV_BYTES) } }, { ...stop, extra: true }]) {
      expect(await requests[BACKGROUND_JOB_STOP](bad, who)).toEqual(fail('ENGINE_INVALID_REQUEST'))
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses an answer out of shape, and recycles a worker whose stop outlives its bound', async () => {
    const requests = engineBackgroundJobRequests({ load: async () => async () => ({ job: 'bg-1', stopped: 'yes' }) as never })
    expect(await requests[BACKGROUND_JOB_STOP](stop, who)).toEqual(fail('ENGINE_INVALID_REPLY'))
    vi.useFakeTimers()
    try {
      const recycle = vi.fn()
      const stuck = engineBackgroundJobRequests({ load: async () => () => new Promise(() => {}), recycle })
      const answers = Array.from({ length: BACKGROUND_JOB_IN_FLIGHT + 1 }, () => stuck[BACKGROUND_JOB_STOP](stop, who))
      expect(await answers.at(-1)).toEqual(fail('ENGINE_BUSY'))
      await vi.advanceTimersByTimeAsync(BACKGROUND_JOB_WAIT_MS)
      expect(await answers[0]).toEqual(fail('ENGINE_UNAVAILABLE'))
      expect(recycle).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('is Claude Code\'s alone inline', () => {
    expect(backgroundJobFor('claude')).toBeTypeOf('function')
    expect(backgroundJobFor('codex')).toBeUndefined()
  })
})
