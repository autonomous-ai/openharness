import { describe, expect, it, vi } from 'vitest'
import { BACKGROUND_JOB_CAPABILITIES, BACKGROUND_JOB_ENV_BYTES, BACKGROUND_JOB_STOP } from '../../engines/worker/backgroundJobProtocol.js'
import { createBackgroundJobs } from './backgroundJobs.js'

const ask = { bin: '/opt/claude/claude', sessionId: 'abcdef12-3456', env: { CLAUDE_CONFIG_DIR: '/custom', UNSET: undefined } }

/** Claude Code's worker on its link, answering its capability and each stop with [answer]. */
function setup(answer: unknown = { job: 'bg-1', stopped: true }) {
  const call = vi.fn(async (_service: string, method: string, _payload: Record<string, unknown>) =>
    method === BACKGROUND_JOB_CAPABILITIES ? { version: 1, backgroundJob: 1, engine: 'claude' } : { version: 1, answer })
  const inline = vi.fn(async () => ({ job: 'bg-2', stopped: false }))
  const handles = vi.fn(() => true)
  const jobs = createBackgroundJobs({ call, handles, inline: engine => engine === 'claude' ? inline : undefined })
  jobs.connected('engine-claude')
  const lines: string[] = []
  return { call, inline, handles, jobs, lines, log: (line: string) => lines.push(line) }
}

describe('stopping a Claude Code background job before a resume (#4146)', () => {
  it('asks Claude Code\'s worker with the launch\'s binary, session and set environment, and says what it stopped', async () => {
    const t = setup()
    await t.jobs.stop('claude', ask, t.log)
    expect(t.call).toHaveBeenLastCalledWith('engine-claude', BACKGROUND_JOB_STOP,
      { version: 1, bin: ask.bin, sessionId: ask.sessionId, env: { CLAUDE_CONFIG_DIR: '/custom' } }, expect.any(Number))
    expect(t.lines).toEqual(['stopped background job bg-1 holding session abcdef12'])
    expect(t.inline).not.toHaveBeenCalled()
  })

  it('says a job it could not stop, and nothing when none held the session', async () => {
    const refused = setup({ job: 'bg-1', stopped: false })
    await refused.jobs.stop('claude', ask, refused.log)
    expect(refused.lines).toEqual(['could not stop background job bg-1 holding session abcdef12 — resuming anyway'])
    const none = setup(null)
    await none.jobs.stop('claude', ask, none.log)
    expect(none.lines).toEqual([])
  })

  it('never holds the resume: a worker that is down, a reply out of shape or a request too large is said and resumed past', async () => {
    const down = setup()
    down.jobs.disconnected('engine-claude')
    down.call.mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' } as never)
    await down.jobs.stop('claude', ask, down.log)
    expect(down.lines).toEqual(['could not ask whether a background job holds session abcdef12 (ENGINE_UNAVAILABLE) — resuming anyway'])
    const odd = setup({ job: '', stopped: 'yes' })
    await odd.jobs.stop('claude', ask, odd.log)
    expect(odd.lines).toEqual(['could not ask whether a background job holds session abcdef12 (ENGINE_INVALID_REPLY) — resuming anyway'])
    const huge = setup()
    await huge.jobs.stop('claude', { ...ask, env: { BIG: 'x'.repeat(BACKGROUND_JOB_ENV_BYTES) } }, huge.log)
    expect(huge.lines).toEqual(['could not ask whether a background job holds session abcdef12 (ENGINE_INVALID_REQUEST) — resuming anyway'])
    expect(huge.call).not.toHaveBeenCalled()
  })

  it('stops in line only in explicit inline mode, and an engine with none there says nothing', async () => {
    const t = setup()
    t.handles.mockReturnValue(false)
    await t.jobs.stop('claude', ask, t.log)
    expect(t.inline).toHaveBeenCalledWith({ bin: ask.bin, sessionId: ask.sessionId, env: { CLAUDE_CONFIG_DIR: '/custom' } })
    expect(t.lines).toEqual(['could not stop background job bg-2 holding session abcdef12 — resuming anyway'])
    await t.jobs.stop('codex', ask, t.log)
    expect(t.lines).toHaveLength(1)
    t.inline.mockRejectedValueOnce(new Error('spawn EMFILE'))
    await t.jobs.stop('claude', ask, t.log)
    expect(t.lines[1]).toBe('could not ask whether a background job holds session abcdef12 (ENGINE_UNAVAILABLE) — resuming anyway')
    expect(t.call).not.toHaveBeenCalled()
  })
})
