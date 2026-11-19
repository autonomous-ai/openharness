import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { attachLocalWsServer, type LocalWsServer } from './localWsServer.js'

const loading = vi.hoisted(() => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  return { started: false, gate, release }
})
vi.mock('./lib/legacyDeviceWindowState.js', async importOriginal => {
  loading.started = true
  await loading.gate
  return importOriginal()
})

let server: http.Server | undefined, local: LocalWsServer | undefined, window: WebSocket | undefined
afterEach(async () => {
  loading.release()
  window?.terminate()
  await local?.close()
  await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
})

it('loads the compatibility owner only for desk traffic and retains an accepted unread frame when its window closes during loading', async () => {
  const unread = vi.fn(), panes = vi.fn(), terminal = vi.fn(), pendingTabs = vi.fn()
  server = http.createServer()
  local = attachLocalWsServer(server, { machineId: 'machine', onAppUnread: unread, onAppPanes: panes,
    onAppSwarms: vi.fn(), onAppTabPending: pendingTabs, backend: {
    registerLocalClient: () => true, unregisterLocalClient: async () => {},
    handleLocalFrame: terminal, handleLocalBinary: async () => {},
  } })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  window = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`)
  await new Promise<void>(resolve => window!.once('open', resolve))
  const connected = new Promise<void>(resolve => window!.once('message', () => resolve()))
  window.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'machine', localProtocolVersion: 1 } }))
  await connected
  window.send(JSON.stringify({ type: 'terminal_resize', payload: { cols: 90, rows: 25 } }))
  await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce())
  expect(loading.started).toBe(false)
  const items = [{ agentId: 'agent', machineId: 'machine', question: false, text: 'Synthetic recap' }]
  window.send(JSON.stringify({ type: 'app_panes', payload: { agentIds: ['agent'] } }))
  window.send(JSON.stringify({ type: 'app_swarms', payload: { swarms: [{ id: 'tab', name: 'Tab', agentIds: ['agent'] }] } }))
  window.send(JSON.stringify({ type: 'app_unread', payload: { items } }))
  await vi.waitFor(() => expect(loading.started).toBe(true))
  await vi.waitFor(() => expect(pendingTabs).toHaveBeenCalledWith(expect.any(String), true))
  window.send(JSON.stringify({ type: 'terminal_resize', payload: { cols: 91, rows: 25 } }))
  await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(2))
  const closed = new Promise<void>(resolve => window!.once('close', () => resolve()))
  window.close()
  await closed
  loading.release()
  await vi.waitFor(() => expect(unread).toHaveBeenCalledExactlyOnceWith(items))
  expect(panes.mock.calls).toEqual([[['agent'], true], [[], false]])
  expect(local.legacyDeviceSnapshot()).toEqual({ desk: [], foreground: false, swarms: null, unread: items })
  expect(pendingTabs).toHaveBeenLastCalledWith(expect.any(String), false)
})
