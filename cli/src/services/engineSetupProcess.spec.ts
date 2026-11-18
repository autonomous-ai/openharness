import { afterEach, expect, it, vi } from 'vitest'
import { startEngineSetup } from './engineSetup.js'
import { runEngineSetupService } from './engineSetupProcess.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { writeBrowserShim } from './browserShim.js'

vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
vi.mock('./engineSetup.js', () => ({ startEngineSetup: vi.fn(() => ({ requests: {}, disconnect: vi.fn(), stop: vi.fn() })) }))
vi.mock('./browserShim.js', () => ({ writeBrowserShim: vi.fn(() => true) }))
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); vi.restoreAllMocks() })

function pendingSetup() {
  let options!: ServiceProcessOptions
  const probe = vi.fn(() => ({ output: null })), replies: Array<(value: Record<string, unknown>) => void> = []
  const service = runEngineSetupService({ dataDir: '/fixture', socketPath: '/fixture/socket', machineId: 'm', token: 't',
    start: () => ({ requests: { setup_probe: probe }, disconnect: vi.fn(), stop: vi.fn() }),
    run: value => { options = value; return { stop: vi.fn() } } })
  const connect = () => options.onConnected!({ query: () => new Promise(resolve => { replies.push(resolve) }) })
  return { probe, replies, service, connect, options: () => options }
}

it('keeps setup available after the optional shim deadline and ignores its late answer', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), f = pendingSetup()
  f.connect()
  const reply = f.options().requests.setup_probe!({}, { local: true, owner: true })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await reply).toEqual({ output: null })
  f.replies[0]({ command: 'late command' })
  await Promise.resolve()
  expect(writeBrowserShim).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledWith('[engine-setup] BROWSER_SHIM_TIMEOUT')
  await f.service.stop()
})

it('does not wait again after preparation and ignores a rejected query from a disconnected core', async () => {
  const f = pendingSetup(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let reject!: (error: Error) => void
  f.options().onConnected!({ query: () => new Promise((_resolve, failed) => { reject = failed }) })
  f.options().onDisconnected!()
  reject(new Error('old core'))
  await Promise.resolve()
  await Promise.resolve()
  expect(f.options().requests.setup_probe!({}, { local: true, owner: true })).toEqual({ output: null })
  expect(warn).not.toHaveBeenCalled()
  await f.service.stop()
})

it('ignores old-core and cancelled-request completions while preparing the next core shim', async () => {
  const f = pendingSetup(), closed = new AbortController()
  f.connect()
  const old = f.options().requests.setup_probe!({}, { local: true, owner: true }, closed.signal)
  closed.abort()
  f.options().onDisconnected!()
  f.connect()
  const next = f.options().requests.setup_probe!({}, { local: true, owner: true })
  f.replies[0]({ command: 'old core' })
  expect(await old).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  expect(writeBrowserShim).not.toHaveBeenCalled()
  f.replies[1]({ command: 'current core' })
  expect(await next).toEqual({ output: null })
  expect(writeBrowserShim).toHaveBeenCalledExactlyOnceWith('current core', '/fixture/bin/harness-browser')
  expect(f.probe).toHaveBeenCalledOnce()
  await f.service.stop()
})

it.each(['missing', 'empty', 'oversized', 'nul', 'write-failed', 'query-failed'] as const)('reports %s shim preparation without refusing native setup', async kind => {
  const f = pendingSetup(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  if (kind === 'query-failed') f.options().onConnected!({ query: async () => { throw new Error('private source path') } })
  else {
    f.connect()
    if (kind === 'write-failed') vi.mocked(writeBrowserShim).mockReturnValueOnce(false)
    f.replies[0](kind === 'missing' ? {} : { command: kind === 'empty' ? '' : kind === 'oversized' ? 'x'.repeat(16_385) : kind === 'nul' ? 'x\0y' : 'valid command' })
  }
  expect(await f.options().requests.setup_probe!({}, { local: true, owner: true })).toEqual({ output: null })
  expect(warn).toHaveBeenCalledWith('[engine-setup] BROWSER_SHIM_UNAVAILABLE')
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private source path')
  await f.service.stop()
})

it('prepares the optional browser shim from this core before the first launch setup request', async () => {
  let options!: ServiceProcessOptions, answer!: (value: Record<string, unknown>) => void
  const probe = vi.fn(() => ({ output: null }))
  const service = runEngineSetupService({ dataDir: '/fixture', socketPath: '/fixture/socket', machineId: 'm', token: 't',
    start: () => ({ requests: { setup_probe: probe }, disconnect: vi.fn(), stop: vi.fn() }),
    run: value => { options = value; return { stop: vi.fn() } } })
  options.onConnected?.({ query: () => new Promise(resolve => { answer = resolve }) })
  const reply = options.requests.setup_probe!({}, { local: true, owner: true })
  expect(probe).not.toHaveBeenCalled()
  answer({ command: "'/immutable/cli'" })
  await reply
  expect(writeBrowserShim).toHaveBeenCalledWith("'/immutable/cli'", '/fixture/bin/harness-browser')
  expect(probe).toHaveBeenCalledOnce()
  await service.stop()
})

it('uses the private setup handlers and cancels preparation and probes on disconnect or stop', async () => {
  let options!: ServiceProcessOptions
  const setup = { requests: { setup_probe: vi.fn(() => ({ output: null })) }, disconnect: vi.fn(), stop: vi.fn() }
  const start = vi.fn(() => setup), stop = vi.fn()
  const service = runEngineSetupService({ dataDir: '/fixture', socketPath: '/fixture/socket', machineId: 'm', token: 't', start,
    run: value => { options = value; return { stop } } })
  expect(start).toHaveBeenCalledWith('/fixture/native-installations')
  expect(options).toMatchObject({ name: 'engineSetup', socketPath: '/fixture/socket', machineId: 'm', token: 't' })
  expect(Object.keys(options.requests)).toEqual(Object.keys(setup.requests))
  options.onDisconnected!()
  expect(setup.disconnect).toHaveBeenCalledOnce(); expect(setup.stop).not.toHaveBeenCalled()
  await service.stop()
  expect(setup.stop).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce()
})

it('composes the actual setup and service lifecycle by default', () => {
  runEngineSetupService({ dataDir: '/fixture', socketPath: '/fixture/socket', machineId: 'm', token: 't' }).stop()
  expect(startEngineSetup).toHaveBeenCalledWith('/fixture/native-installations')
  expect(runServiceProcess).toHaveBeenCalledOnce()
})
