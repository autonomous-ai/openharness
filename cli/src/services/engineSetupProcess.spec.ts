import { afterEach, expect, it, vi } from 'vitest'
import { startEngineSetup } from './engineSetup.js'
import { runEngineSetupService } from './engineSetupProcess.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'

vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
vi.mock('./engineSetup.js', () => ({ startEngineSetup: vi.fn(() => ({ requests: {}, disconnect: vi.fn(), stop: vi.fn() })) }))
afterEach(() => vi.clearAllMocks())

it('uses the private setup handlers and cancels preparation and probes on disconnect or stop', async () => {
  let options!: ServiceProcessOptions
  const setup = { requests: { setup_probe: vi.fn(() => ({ output: null })) }, disconnect: vi.fn(), stop: vi.fn() }
  const start = vi.fn(() => setup), stop = vi.fn()
  const service = runEngineSetupService({ dataDir: '/fixture', socketPath: '/fixture/socket', machineId: 'm', token: 't', start,
    run: value => { options = value; return { stop } } })
  expect(start).toHaveBeenCalledWith('/fixture/native-installations')
  expect(options).toMatchObject({ name: 'engineSetup', socketPath: '/fixture/socket', machineId: 'm', token: 't', requests: setup.requests })
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
