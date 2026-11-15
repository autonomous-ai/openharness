import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startEngineSetup } from './engineSetup.js'
import { createNativeSetupLink } from '../engines/kit/nativeSetupLink.js'
import { executableIdentity } from '../engines/kit/nativeExecutable.js'
import type { NativeSetup } from '../engines/kit/nativeSetup.js'

const owner = { local: true, owner: true }
const environment = { HOME: '/fixture', PATH: '/fixture/bin' }
const recipe = { command: 'unused', source: 'fixture', executable: { names: [] } }
let root: string, file: string, setup: NativeSetup, service: ReturnType<typeof startEngineSetup>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-setup-')); file = join(root, 'engine'); writeFileSync(file, 'fixture')
  setup = {
    probe: vi.fn(async () => null),
    downloading: vi.fn(async () => false), opencodeMajor: vi.fn(async () => 2), hermesKeepsRecord: vi.fn(async () => true),
    installations: { status: vi.fn(async () => null), ensure: vi.fn(async (_engine, _recipe, _environment, _request, current, authorize) => {
      const allowed = await authorize!()
      return allowed && current() ? { complete: false as const, running: true as const, detail: 'Installing.' } : { complete: false as const, detail: 'Refused.' }
    }) },
  }
  service = startEngineSetup('/fixture', setup)
})
afterEach(() => { service.stop(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })
const request = (type: string, payload: Record<string, unknown> = {}, closed?: AbortSignal) => Promise.resolve(service.requests[type]!(payload, owner, closed))
const prepare = (id = 'r1') => request('setup_prepare', { engine: 'codex', environment, request: id })

it('allows only the core to call private setup handlers', async () => {
  for (const handler of Object.values(service.requests)) for (const asker of [{ local: false, owner: true }, { local: true, owner: false }, { local: true, owner: true, connection: 'client-window' }]) {
    expect(await handler!({}, asker)).toEqual({ error: 'SETUP_OWNER_REQUIRED' })
  }
  expect(setup.probe).not.toHaveBeenCalled()
})

it('reads downloads and versions without returning an executable or location choice', async () => {
  expect(service.requests.setup_capture).toBeUndefined()
  expect(await request('setup_download', { engine: 'codex' })).toEqual({ downloading: false })
  expect(await request('setup_download')).toEqual({ downloading: false })
  expect(await request('setup_version', { engine: 'opencode' })).toEqual({ major: 2 })
  expect(await request('setup_version', { engine: 'hermes' })).toEqual({ keepsRecord: true })
  expect(await request('setup_version', { engine: 'hermes', command: file, environment })).toEqual({ keepsRecord: true })
  expect(setup.hermesKeepsRecord).toHaveBeenLastCalledWith({ command: file }, environment)
  for (const value of [{}, { engine: 'hermes', command: 3 }, { engine: 'hermes', environment: null }]) {
    expect(await request('setup_version', value)).toEqual({ keepsRecord: null })
  }
})

it('checks probe inputs and the executable again after the reply', async () => {
  const payload = { command: file, identity: executableIdentity(file), environment, kind: 'help' }
  vi.mocked(setup.probe).mockResolvedValue({ code: 0, stdout: '--help', stderr: '' })
  expect(await request('setup_probe', payload)).toMatchObject({ output: { code: 0 } })
  for (const invalid of [{ environment: null }, { environment: [] }, { environment: { SECRET: 'x' } }, { environment: { HOME: 1 } },
    { environment: { HOME: 'x\0' } }, { environment: { HOME: 'x'.repeat(70_000) } }, { command: 3 }, { identity: '' }, { kind: 'run' }]) {
    expect(await request('setup_probe', { ...payload, ...invalid })).toEqual({ output: null })
  }
  vi.mocked(setup.probe).mockImplementationOnce(async () => { writeFileSync(file, 'changed'); return { code: 0, stdout: '--help', stderr: '' } })
  expect(await request('setup_probe', payload)).toEqual({ output: null })
})

it('reads existing obligations without creating a preparation', async () => {
  expect(await request('setup_status', { engine: 'codex', request: 'r1' })).toEqual({ installation: null })
  const closed = new AbortController()
  await request('setup_status', { engine: 'codex', request: 'r1' }, closed.signal)
  const current = vi.mocked(setup.installations.status).mock.calls.at(-1)![2]
  expect(current()).toBe(true); closed.abort(); expect(current()).toBe(false)
  for (const payload of [{}, { engine: 'codex', request: 1 }]) expect(await request('setup_status', payload)).toMatchObject({ installation: { complete: false } })
})

it('prepares without installing and binds once-only commit to its request and worker', async () => {
  const prepared = await prepare()
  expect(prepared.preparation).toEqual(expect.any(String))
  for (const payload of [{}, { ...prepared, engine: 'codex', request: 'r2' }, { ...prepared, engine: 'claude', request: 'r1' }]) {
    expect(await request('setup_commit', payload)).toMatchObject({ installation: { complete: false } })
  }
  const commit = { ...prepared, engine: 'codex', request: 'r1', allowed: true }
  expect(await request('setup_commit', commit)).toMatchObject({ installation: { running: true } })
  expect(await request('setup_commit', commit)).toMatchObject({ installation: { running: true } })
  expect(setup.installations.ensure).toHaveBeenCalledOnce()
  service.stop()
  expect(await request('setup_commit', commit)).toMatchObject({ installation: { complete: false } })
})

it('cancels a delayed preparation before commit and fences a launch cancelled after commit', async () => {
  let current = true
  const link = createNativeSetupLink(async (type, payload) => {
    const answer = await request(type, payload)
    if (type === 'setup_prepare') current = false
    return answer
  })
  expect(await link.installations.ensure('codex', recipe, environment, 'r1', () => current)).toMatchObject({ complete: false })
  const first = vi.mocked(setup.installations.ensure).mock.results[0]!.value
  expect(await first).toEqual({ complete: false as const, detail: 'Refused.' })
  current = true
  const afterCommit = createNativeSetupLink(async (type, payload) => {
    const answer = await request(type, payload)
    if (type === 'setup_commit') current = false
    return answer
  })
  expect(await afterCommit.installations.ensure('codex', recipe, environment, 'r2', () => current)).toMatchObject({ complete: false })
  expect(await vi.mocked(setup.installations.ensure).mock.results[1]!.value).toMatchObject({ running: true })
})

it('bounds pending preparation, expires unanswered commits and frees finished entries', async () => {
  vi.useFakeTimers()
  const pending = await Promise.all(Array.from({ length: 8 }, (_, i) => prepare(`r${i}`)))
  expect(await prepare('full')).toMatchObject({ installation: { complete: false } })
  expect(setup.installations.ensure).toHaveBeenCalledTimes(8)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await request('setup_commit', { ...pending[0], engine: 'codex', request: 'r0', allowed: true })).toMatchObject({ installation: { complete: false } })
  const again = await prepare('again')
  expect(await request('setup_commit', { ...again, engine: 'codex', request: 'again', allowed: false })).toEqual({ installation: { complete: false as const, detail: 'Refused.' } })
  expect((await prepare('next')).preparation).toEqual(expect.any(String))
})

it('contains failed, completed and disconnected preparations without starting an installer', async () => {
  vi.mocked(setup.installations.ensure).mockResolvedValueOnce({ complete: true }).mockRejectedValueOnce(Error('fixture'))
  expect(await prepare()).toEqual({ installation: { complete: true } })
  expect(await prepare('r2')).toMatchObject({ installation: { complete: false } })
  const closed = new AbortController(); closed.abort()
  expect(await request('setup_prepare', { engine: 'codex', environment, request: 'closed' }, closed.signal)).toMatchObject({ installation: { complete: false } })
  for (const payload of [{}, { engine: 'codex', environment, request: '' }, { engine: 'codex', environment: null, request: 'r' },
    { engine: 'terminal', environment, request: 'r' }]) expect(await request('setup_prepare', payload)).toMatchObject({ installation: { complete: false } })
  const pending = await prepare('disconnect')
  service.disconnect()
  expect(await request('setup_commit', { ...pending, engine: 'codex', request: 'disconnect', allowed: true })).toMatchObject({ installation: { complete: false } })
})

it('owns protected probes only in its process and cancels them on disconnect', async () => {
  const executors = await import('../engines/kit/setupProbe.js')
  const local = await import('./nativeSetup.js')
  const execute = vi.fn() as unknown as ReturnType<typeof executors.createSetupProbeExecutor>['execute'], close = vi.fn(), warmOnce = vi.fn()
  const reset = vi.fn(() => execute)
  const probes = vi.spyOn(executors, 'createSetupProbeExecutor').mockReturnValue({ execute, close, warmOnce, reset })
  const create = vi.spyOn(local, 'createLocalNativeSetup').mockReturnValue(setup)
  const actual = startEngineSetup('/fixture')
  expect(create).toHaveBeenCalledWith('/fixture', execute)
  expect(warmOnce).not.toHaveBeenCalled()
  expect(await actual.requests.setup_download!({}, owner)).toEqual({ downloading: false })
  expect(warmOnce).not.toHaveBeenCalled()
  expect(await actual.requests.setup_download!({ engine: 'codex' }, owner)).toEqual({ downloading: false })
  expect(warmOnce).toHaveBeenCalledOnce()
  actual.disconnect(); expect(reset).toHaveBeenCalledOnce()
  expect(create).toHaveBeenCalledTimes(2)
  actual.stop(); expect(close).toHaveBeenCalledOnce()
  probes.mockRestore(); create.mockRestore()
})

it('refuses authorization when the preparing connection closes before commit', async () => {
  const closed = new AbortController()
  const pending = await request('setup_prepare', { engine: 'codex', environment, request: 'closed' }, closed.signal)
  closed.abort()
  expect(await request('setup_commit', { ...pending, engine: 'codex', request: 'closed', allowed: true })).toEqual({ installation: { complete: false, detail: 'Refused.' } })
})

it('rejects an expired preparation even before the delayed timer gets CPU', async () => {
  vi.useFakeTimers()
  const pending = await prepare('expired')
  vi.setSystemTime(Date.now() + 30_001)
  expect(await request('setup_commit', { ...pending, engine: 'codex', request: 'expired', allowed: true })).toEqual({ installation: { complete: false, detail: 'Waiting for engine setup.' } })
  expect(await vi.mocked(setup.installations.ensure).mock.results[0]!.value).toEqual({ complete: false, detail: 'Refused.' })
})

it.each(['expiry', 'disconnect'] as const)('retains pending installation slots through %s until actual settlement', async failure => {
  vi.useFakeTimers()
  const release: Array<() => void> = [], dispatched = vi.fn()
  vi.mocked(setup.installations.ensure).mockImplementation(async (_engine, _recipe, _environment, _request, current, authorize) => {
    await new Promise<void>(done => release.push(done))
    if (await authorize!() && current()) dispatched()
    return { complete: false, detail: 'Settled.' }
  })
  const pending = Array.from({ length: 8 }, (_, index) => prepare(`pending-${index}`))
  expect(release).toHaveLength(8)
  if (failure === 'expiry') await vi.advanceTimersByTimeAsync(30_001)
  else service.disconnect()
  let ninth: Record<string, unknown> | undefined
  const more = prepare('ninth').then(reply => { ninth = reply })
  await Promise.resolve()
  expect(setup.installations.ensure).toHaveBeenCalledTimes(8)
  await more; expect(ninth).toMatchObject({ installation: { complete: false } })
  release[0]!(); await pending[0]
  await vi.mocked(setup.installations.ensure).mock.results[0]!.value
  expect(dispatched).not.toHaveBeenCalled()
  const admitted = prepare('after-settlement')
  expect(setup.installations.ensure).toHaveBeenCalledTimes(9)
  service.stop()
  for (const done of release) done()
  await Promise.all([...pending, admitted]); expect(dispatched).not.toHaveBeenCalled()
})

it('bounds every retained read across disconnect until actual filesystem settlement', async () => {
  const release: Array<() => void> = []
  vi.mocked(setup.installations.status).mockImplementation(() => new Promise(resolve => release.push(() => resolve(null))))
  const pending = Array.from({ length: 8 }, (_, index) => request('setup_status', { engine: 'codex', request: `read-${index}` }))
  expect(release).toHaveLength(8)
  expect(await request('setup_version', { engine: 'opencode' })).toMatchObject({ error: 'SETUP_BUSY' })
  service.disconnect()
  expect(await request('setup_download', { engine: 'codex' })).toMatchObject({ error: 'SETUP_BUSY' })
  release[0]!(); await pending[0]
  expect(await request('setup_version', { engine: 'opencode' })).toEqual({ major: 2 })
  for (const done of release) done()
  await Promise.all(pending)
})

it('bounds duplicate commit waiters without dispatching an installation more than once', async () => {
  let settle!: () => void
  const dispatched = vi.fn(), done = new Promise<void>(resolve => { settle = resolve })
  vi.mocked(setup.installations.ensure).mockImplementation(async (_engine, _recipe, _environment, _request, current, authorize) => {
    if (await authorize!() && current()) dispatched()
    await done
    return { complete: true }
  })
  const pending = await prepare('duplicate')
  const commit = { ...pending, engine: 'codex', request: 'duplicate', allowed: true }
  const waiting = Array.from({ length: 8 }, () => request('setup_commit', commit))
  expect(await request('setup_commit', commit)).toMatchObject({ error: 'SETUP_BUSY' })
  expect(dispatched).toHaveBeenCalledOnce(); expect(setup.installations.ensure).toHaveBeenCalledOnce()
  settle()
  expect(await Promise.all(waiting)).toEqual(Array(8).fill({ installation: { complete: true } }))
  expect(await request('setup_commit', commit)).toEqual({ installation: { complete: true } })
  expect(dispatched).toHaveBeenCalledOnce(); expect(setup.installations.ensure).toHaveBeenCalledOnce()
})
