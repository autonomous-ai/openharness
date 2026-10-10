import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionModelControl } from './nativeSessionModel.js'
import { OPENCODE_SESSION_MODEL } from '../opencode/contract.js'

const exec = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: exec }))
afterEach(() => vi.clearAllMocks())
const model = { providerID: 'fixture', modelID: 'model' }

describe('native mutation process dispatch', () => {
  it.each([null, 1])('does not bypass an unresolved API write when a later version probe says %s', async major => {
    const control = createSessionModelControl(OPENCODE_SESSION_MODEL, () => '/fixture/bin/opencode')
    const run = vi.fn(async () => { throw Error('native service unavailable after write') })
    const input = { dbPath: '/fixture/opencode.db', sessionId: 'ses_fixture', model }
    expect(await control.applySessionModel({ ...input, major: 2 }, { run, retryDelayMs: 0 })).toMatchObject({ ok: false })
    // An assertion, rather than an executable, records any attempted SQL fallback.
    exec.mockImplementation((_file, _args, _options, done) => { queueMicrotask(() => done(null, '5000\n1\n1\n', '')); return {} })
    const fallback = control.applySessionModel({ ...input, major }, { run, retryDelayMs: 0 }).catch(error => ({ error }))
    const result = await fallback
    expect(exec).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, effect: 'uncertain' })
    expect(run.mock.calls).toHaveLength(3)
  })

  it('does not dispatch after ownership is revoked during asynchronous binary resolution', async () => {
    let release!: (binary: string) => void, current = true
    const binary = vi.fn(() => new Promise<string>(done => { release = done }))
    const control = createSessionModelControl(OPENCODE_SESSION_MODEL, binary)
    const pending = control.switchSessionModel('ses_fixture', model, { current: () => current })
    await vi.waitFor(() => expect(binary).toHaveBeenCalledOnce())
    current = false
    release('/fixture/bin/opencode')
    expect(await pending).toMatchObject({ ok: false, code: 'AGENT_CHANGED' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('keeps one executable through uncertain-write retries, bounds children and closes stdin', async () => {
    const end = vi.fn(), binary = vi.fn(async () => '/fixture/bin/opencode')
    let unavailable = true
    exec.mockImplementation((_file, args: string[], _options, done) => {
      queueMicrotask(() => {
        if (unavailable) done(Error('reply lost'), '', 'fixture transport unavailable')
        else done(null, JSON.stringify({ data: { id: 'ses_fixture', model: { providerID: 'fixture', id: 'model' } } }), '')
      })
      return { stdin: { end } }
    })
    const control = createSessionModelControl(OPENCODE_SESSION_MODEL, binary)
    expect(await control.switchSessionModel('ses_fixture', model, { retryDelayMs: 0 }))
      .toMatchObject({ ok: false, effect: 'uncertain', detail: expect.stringContaining('fixture transport unavailable') })
    binary.mockResolvedValue('/fixture/replaced/opencode')
    unavailable = false
    expect(await control.switchSessionModel('ses_fixture', model, { retryDelayMs: 0 })).toEqual({ ok: true })
    expect(binary).toHaveBeenCalledOnce()
    expect(exec.mock.calls.map(call => call[0])).toEqual(Array(4).fill('/fixture/bin/opencode'))
    expect(exec.mock.calls.map(call => call[1][1])).toEqual(['session.switchModel', 'session.get', 'session.get', 'session.get'])
    for (const [, , options] of exec.mock.calls) expect(options).toMatchObject({ timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
    expect(end).toHaveBeenCalledTimes(4)
  })
})
