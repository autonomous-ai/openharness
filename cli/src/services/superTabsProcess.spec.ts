import { expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runSuperTabsService } from './superTabsProcess.js'

vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
const owner = { owner: true, local: true }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(withPort = true) {
  let api!: CoreApi, wire!: ServiceProcessOptions
  const port = { connected: vi.fn(), disconnected: vi.fn(), stop: vi.fn(), swarmRole: vi.fn(async () => null) }
  const stopped = vi.fn()
  const process = runSuperTabsService({ dataDir: '/not-a-real-data-dir', socketPath: '/not-a-real-socket', machineId: 'm', token: 't',
    run: options => { wire = options; return { stop: stopped } },
    start: (core, ports) => {
      api = core
      if (withPort) ports.superTabs = port
      return { super_tabs: payload => ({ value: payload.action, agents: core.agents.live().map(a => a.agentId), machine: core.daemon.machineId() }) }
    },
  })
  return { process, port, stopped, wire: () => wire, api: () => api }
}

it('refreshes native identity before requests and backend calls; disconnecting withdraws the host', async () => {
  const t = setup()
  await expect(t.api().account.backend('GET', '/api/super-tabs')).rejects.toThrow('Core disconnected')
  const query = vi.fn(async (name: string) => name === 'shown' ? { agents: [{ agentId: 'one' }] }
    : name === 'daemon' ? { command: 'harness', port: 14001, machineId: 'm' }
    : { status: 200, body: { success: true, data: {} } })
  t.wire().onConnected!({ query })
  expect(await t.wire().requests.super_tabs!({ action: 'status' }, owner)).toEqual({ value: 'status', agents: ['one'], machine: 'm' })
  await flush()
  expect(t.port.connected).toHaveBeenCalledOnce()
  expect(await t.api().account.backend('GET', '/api/super-tabs')).toEqual({ status: 200, body: { success: true, data: {} } })
  t.wire().onEvent!({ kind: 'delivery', event: { deliveryId: 'd', sessionId: 'one', state: 'queued' } })
  t.wire().onDisconnected!()
  expect(t.port.disconnected).toHaveBeenCalledOnce()
  expect(t.api().agents.live()).toEqual([])
  expect(t.api().daemon.machineId()).toBe('')
  await expect(t.wire().requests.super_tabs!({}, owner)).rejects.toThrow('Core disconnected')
  t.process.stop()
  expect(t.port.stop).toHaveBeenCalledOnce()
  expect(t.stopped).toHaveBeenCalledOnce()
})

it('does not revive an old identity when a pending read returns after disconnect', async () => {
  const t = setup()
  let resolve!: (value: Record<string, unknown>) => void
  const answer = new Promise<Record<string, unknown>>(done => { resolve = done })
  t.wire().onConnected!({ query: () => answer })
  t.wire().onDisconnected!()
  resolve({ agents: [{ agentId: 'old' }], command: 'harness', port: 14001, machineId: 'old' })
  await flush()
  expect(t.api().agents.live()).toEqual([])
  expect(t.port.connected).not.toHaveBeenCalled()
  t.process.stop()
})

it('can stop a failed port and tolerates missing identity without adopting an old roster', async () => {
  const t = setup(false)
  t.wire().onConnected!({ query: async () => ({}) })
  await flush()
  expect(await t.wire().requests.super_tabs!({}, owner)).toEqual({ value: undefined, agents: [], machine: '' })
  t.wire().onDisconnected!(); t.process.stop()
  expect(t.stopped).toHaveBeenCalledOnce()
})

it('does not start a host when disconnect occurs between a successful identity read and its continuation', async () => {
  const t = setup()
  t.wire().onConnected!({ query: async () => ({ command: 'harness', port: 14001, machineId: 'm', agents: [] }) })
  for (let step = 0; step < 10 && !t.api().daemon.machineId(); step++) await Promise.resolve()
  expect(t.api().daemon.machineId()).toBe('m')
  t.wire().onDisconnected!()
  await flush()
  expect(t.port.connected).not.toHaveBeenCalled()
  t.process.stop()
})

it('uses the real service wrapper and process runner by default without connecting in the fixture', () => {
  const handle = runSuperTabsService({ dataDir: '/not-a-real-data-dir', socketPath: '/not-a-real-socket', machineId: 'm', token: 't' })
  expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'superTabs' }))
  handle.stop()
})
