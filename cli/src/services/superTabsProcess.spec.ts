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

// The host posts an agent's answer when its turn ends: the core tells this process each live end, which names the turn by its
// prompt, and the answer's text is asked of the core, which has it as the turn was said (core/turns/ends.ts).
it('hears each turn end the core tells it, and asks the core for the answer of the turn it names', async () => {
  const t = setup()
  const ends: unknown[] = []
  t.api().turns.onEnd(end => { ends.push(end) })
  const end = { agentId: 'one', sessionId: 's1', aborted: false, prompt: 'a'.repeat(32), turnId: 3 }
  t.wire().onEvent!({ kind: 'turn_end', event: end })
  expect(ends).toEqual([end])
  const query = vi.fn(async (name: string, payload: Record<string, unknown>) => name === 'turn_answer' ? { answer: payload.sessionId === 's1' ? 'Shipped.' : null } : {})
  t.wire().onConnected!({ query })
  expect(await t.api().turns.answerOf(end)).toBe('Shipped.')
  expect(query).toHaveBeenCalledWith('turn_answer', { sessionId: 's1', prompt: end.prompt, turnId: 3 })
  expect(await t.api().turns.answerOf({ ...end, sessionId: 's2' })).toBeNull()
  t.process.stop()
})

it('has no answer to give while the core is away', async () => {
  const t = setup()
  await expect(t.api().turns.answerOf({ sessionId: 's1', prompt: 'a'.repeat(32), turnId: 3 })).rejects.toThrow('Core disconnected')
  t.process.stop()
})

// Stability roadmap 2.4: the server's word that work waits reaches the host in this process as the core's notice.
it('hands the account\'s notices the core tells it to the host, and nothing else', () => {
  const t = setup()
  const heard: unknown[] = []
  const unsubscribe = t.api().account.onNotice(notice => { heard.push(notice) })
  t.wire().onEvent!({ kind: 'notice', notice: { type: 'super_tab_deliveries', tabId: 'tab', agentId: 'agent' } })
  t.wire().onEvent!({ kind: 'notice', notice: 'not a notice' })
  t.wire().onEvent!({ kind: 'delivery', event: { deliveryId: 'd', sessionId: 'one', state: 'queued' } })
  expect(heard).toEqual([{ type: 'super_tab_deliveries', tabId: 'tab', agentId: 'agent' }])
  unsubscribe()
  t.wire().onEvent!({ kind: 'notice', notice: { type: 'super_tab_deliveries' } })
  expect(heard).toHaveLength(1)
  t.process.stop()
})

// After a restart that cut a message off in the middle of typing, the host asks whether the agent took it, by the last turn its
// engine wrote (superTabs/host.ts): the transcript is the core's to read, so this process asks it.
it('reads an agent\'s last turn from the core, and fails on an answer it cannot read', async () => {
  const t = setup()
  await expect(t.api().transcripts.lastTurn('session-1')).rejects.toThrow('Core disconnected')
  const turns: Record<string, unknown> = { 'session-1': { userMessage: 'Build it.', assistantText: 'Built.', extra: 1 }, 'session-2': null,
    'session-3': { userMessage: 'Build it.' } }
  const query = vi.fn(async (name: string, payload: Record<string, unknown>) => name === 'last_turn'
    ? (String(payload.sessionId) in turns ? { turn: turns[String(payload.sessionId)] } : { error: 'NOT_SUPER_TABS' }) : {})
  t.wire().onConnected!({ query })
  expect(await t.api().transcripts.lastTurn('session-1')).toEqual({ userMessage: 'Build it.', assistantText: 'Built.' })
  expect(query).toHaveBeenCalledWith('last_turn', { sessionId: 'session-1' })
  expect(await t.api().transcripts.lastTurn('session-2')).toBeNull()
  await expect(t.api().transcripts.lastTurn('session-3')).rejects.toThrow('The core did not say the last turn.')
  await expect(t.api().transcripts.lastTurn('session-4')).rejects.toThrow('The core did not say the last turn.')
  t.process.stop()
})
