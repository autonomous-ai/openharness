import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionModelControl } from './nativeSessionModel.js'
import { OPENCODE_SESSION_MODEL } from '../opencode/contract.js'
import { applyOpencodeSessionModel } from '../launchControl.js'
import { LAUNCH_LOCATION_VARIABLES, nativeOpencodeStore } from './nativeLocations.js'

const exec = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: exec }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })
const model = { providerID: 'fixture', modelID: 'model' }

describe('native mutation process dispatch', () => {
  it('carries the public apply API executable and absent native locations through the actual child options', async () => {
    vi.stubEnv('XDG_DATA_HOME', '/fixture/ambient-data')
    vi.stubEnv('OPENCODE_DB', '/fixture/ambient.db')
    vi.stubEnv('OPENCODE_CONFIG', '/fixture/ambient-config.json')
    const environment = { HOME: '/fixture/captured-home', PATH: '/fixture/bin' }
    const executable = { command: '/fixture/captured/opencode', identity: 'captured', current: () => true }
    exec.mockImplementation((_file, args: string[], _options, done) => {
      const result = args[1] === 'model.list' ? [{ providerID: 'fixture', id: 'model' }]
        : { data: { id: 'ses_captured', model: { providerID: 'fixture', id: 'model' } } }
      queueMicrotask(() => done(null, JSON.stringify(result), ''))
      return { stdin: { end: vi.fn() } }
    })
    expect(await applyOpencodeSessionModel({ opencodeMajor: 2, dbPath: nativeOpencodeStore(environment), sessionId: 'ses_captured', model, checkCatalog: true },
      { executable, environment, retryDelayMs: 0 })).toEqual({ ok: true })
    expect(exec.mock.calls.map(call => call[1][1])).toEqual(['model.list', 'session.switchModel', 'session.get'])
    for (const [command, , options] of exec.mock.calls) {
      expect(command).toBe(executable.command)
      expect(options.env).toMatchObject(environment)
      for (const key of ['XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_CONFIG']) expect(options.env).not.toHaveProperty(key)
    }
    expect(LAUNCH_LOCATION_VARIABLES).toContain('OPENCODE_DB')
    expect(nativeOpencodeStore(environment)).toBe('/fixture/captured-home/.local/share/opencode/opencode.db')
    expect(nativeOpencodeStore({ ...environment, XDG_DATA_HOME: '/fixture/data', OPENCODE_DATA_DIR: '/fixture/ignored' })).toBe('/fixture/data/opencode/opencode.db')
    expect(nativeOpencodeStore({ ...environment, OPENCODE_DB: '/fixture/selected.db' })).toBe('/fixture/selected.db')
    expect(() => nativeOpencodeStore({ ...environment, OPENCODE_DB: 'relative.db' })).toThrow('Unconfirmed')
  })

  it('does not reconcile an uncertain native write through a newly captured store environment', async () => {
    const control = createSessionModelControl(OPENCODE_SESSION_MODEL, () => '/fixture/bin/opencode')
    const run = vi.fn(async () => { throw Error('unavailable after dispatch') })
    const input = { major: 2, dbPath: '/fixture/label.db', sessionId: 'ses_fixture', model }
    const environment = { HOME: '/fixture/home', XDG_DATA_HOME: '/fixture/original' }
    expect(await control.applySessionModel(input, { run, environment, retryDelayMs: 0 })).toMatchObject({ effect: 'uncertain' })
    run.mockClear()
    for (const env of [{ ...environment, XDG_DATA_HOME: '/fixture/replacement' }, { ...environment, OPENCODE_DB: '/fixture/other.db' }]) {
      expect(await control.applySessionModel(input, { run, environment: env, retryDelayMs: 0 }))
        .toMatchObject({ effect: 'uncertain', detail: expect.stringContaining('original store and folder') })
    }
    expect(run).not.toHaveBeenCalled()
  })

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
