import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLegacyDeviceWindowLoader } from './legacyDeviceWindowLoader.js'
import { createLegacyDeviceWindowState } from './legacyDeviceWindowState.js'
import { OpenTabProtection } from './openTabProtection.js'
import type { RegisteredSession } from './registry.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const frame = (type: string, payload: unknown = {}) => ({ type, payload })
const tab = () => frame('app_swarms', { swarms: [{ id: 'tab', name: 'Tab', agentIds: ['agent'] }] })
const flush = () => vi.advanceTimersByTimeAsync(0)
function fixture() {
  let resolve!: (module: { createLegacyDeviceWindowState: typeof createLegacyDeviceWindowState }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ createLegacyDeviceWindowState: typeof createLegacyDeviceWindowState }>((yes, no) => { resolve = yes; reject = no })
  const load = vi.fn(() => promise), log = vi.fn(), refused = vi.fn(), pending = vi.fn()
  const live = new Set(['one', 'two'])
  const guard = new OpenTabProtection({ machineId: () => 'machine', sessions: () => [],
    readDesk: async () => ({ status: 200, body: { success: true, data: { revision: 1, tabs: [] } } }) })
  const hooks = { onAppPanes: vi.fn(), onAppSwarms: vi.fn(), onAppUnread: vi.fn(), onAgentSeen: vi.fn(),
    onAppTabAgents: (connection: string, ids: string[] | null) => guard.updateWindow(connection, ids) }
  const loader = createLegacyDeviceWindowLoader({ hooks, live: connection => live.has(connection),
    pending: (connection, value) => { pending(connection, value); guard.pendingWindow(connection, value) }, load, log, refused })
  const send = (connection: string, value: ReturnType<typeof frame>, bytes = Buffer.from(JSON.stringify(value))) => loader.receive(connection, value, bytes)
  return { loader, hooks, guard, live, load, log, refused, pending, send, resolve: () => resolve({ createLegacyDeviceWindowState }), reject }
}
const agent = { agentId: 'agent', runtimes: [] } as unknown as RegisteredSession

it('bounds first-use ownership, holds cleanup and drains accepted frames across windows in arrival order', async () => {
  const f = fixture(), order: string[] = []
  f.hooks.onAppUnread.mockImplementation(() => { order.push('unread') })
  f.hooks.onAgentSeen.mockImplementation(() => { order.push('seen') })
  expect(f.load).not.toHaveBeenCalled(); expect(f.loader.snapshot()).toBeUndefined()
  f.send('one', tab())
  f.send('one', frame('app_unread', { items: [{ agentId: 'agent', machineId: 'machine' }] }))
  f.send('two', frame('agent_seen', { agentId: 'agent' }))
  await expect(f.guard.assertHidden(agent)).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
  await flush(); expect(f.load).toHaveBeenCalledOnce()
  f.resolve(); await flush()
  expect(order).toEqual(['unread', 'seen'])
  await expect(f.guard.assertHidden(agent)).rejects.toMatchObject({ code: 'SESSION_IN_TAB' })
  expect(f.pending.mock.calls).toEqual([['one', true], ['one', false]])
  f.send('two', frame('app_panes', { agentIds: ['other'] }))
  expect(f.loader.snapshot()?.desk).toEqual(['other']); expect(f.load).toHaveBeenCalledOnce()
  f.loader.stop(); f.loader.stop()
})

it('retains accepted unread after physical close but cannot resurrect its pane or tab membership', async () => {
  const f = fixture()
  f.send('one', frame('app_panes', { agentIds: ['agent'] })); f.send('one', tab())
  f.send('one', frame('app_unread', { items: [{ agentId: 'agent', machineId: 'machine' }] }))
  f.live.delete('one'); f.loader.closed('one')
  f.resolve(); await flush()
  expect(f.loader.snapshot()).toMatchObject({ desk: [], foreground: false, swarms: null, unread: [{ agentId: 'agent', machineId: 'machine' }] })
  await expect(f.guard.assertHidden(agent)).resolves.toBeUndefined()
  f.loader.stop()
})

it('refuses a whole overflowing attempt, ignores its late import and permits only one subsequent attempt', async () => {
  const f = fixture()
  f.send('one', tab())
  for (let n = 0; n < 128; n++) f.send('one', frame('app_panes'))
  expect(f.log).toHaveBeenCalledWith('[local-ws] LEGACY_DESK_LOAD_LIMIT')
  expect(f.refused).toHaveBeenCalledWith('one', 'LEGACY_DESK_LOAD_LIMIT')
  f.resolve(); await flush(); expect(f.loader.snapshot()).toBeUndefined()
  await expect(f.guard.assertHidden(agent)).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
  f.send('one', tab()); await flush()
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.loader.snapshot()?.swarms?.active).toBe('tab')
  expect(f.pending).toHaveBeenLastCalledWith('one', false)
  f.loader.stop()
})

it('caps encoded bytes as well as frame count without retaining the refused payload', async () => {
  const f = fixture()
  const value = frame('app_unread', { padding: 'x'.repeat(512 * 1024 - 100) })
  for (let n = 0; n < 17; n++) f.send('one', value)
  expect(f.log).toHaveBeenCalledExactlyOnceWith('[local-ws] LEGACY_DESK_LOAD_LIMIT')
  f.resolve(); await flush(); expect(f.hooks.onAppUnread).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0); f.loader.stop()
})

it('expires without terminal work or an automatic retry, and invalid later reports cannot release lost tab evidence', async () => {
  const f = fixture()
  f.send('one', tab()); await flush()
  await vi.advanceTimersByTimeAsync(5000)
  expect(f.log).toHaveBeenCalledExactlyOnceWith('[local-ws] LEGACY_DESK_LOAD_TIMEOUT')
  expect(f.load).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  f.send('one', frame('app_swarms', {})); f.resolve(); await flush()
  await expect(f.guard.assertHidden(agent)).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
  f.send('one', tab())
  expect(f.pending).toHaveBeenLastCalledWith('one', false)
  f.loader.stop()
})

it('contains import failures, bounds retries and releases cleanup holds on physical close', async () => {
  const f = fixture()
  f.send('one', tab()); f.reject(new Error('private')); await flush()
  f.send('two', tab()); await flush()
  f.send('one', tab()); await flush()
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.log.mock.calls).toEqual([['[local-ws] LEGACY_DESK_LOAD_FAILED'], ['[local-ws] LEGACY_DESK_LOAD_FAILED']])
  f.live.delete('one'); f.live.delete('two'); f.loader.closed('one'); f.loader.closed('two')
  await expect(f.guard.assertHidden(agent)).resolves.toBeUndefined()
  expect(vi.getTimerCount()).toBe(0); f.loader.stop()
})

it('stops loading without releasing unknown membership before the physical window closes', async () => {
  const f = fixture()
  f.send('one', tab()); f.loader.stop(); f.loader.stop()
  f.resolve(); await flush(); f.send('one', tab())
  expect(f.loader.snapshot()).toBeUndefined(); expect(vi.getTimerCount()).toBe(0)
  await expect(f.guard.assertHidden(agent)).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
  f.live.delete('one'); f.loader.closed('one')
  await expect(f.guard.assertHidden(agent)).resolves.toBeUndefined()
  expect(f.refused).not.toHaveBeenCalled()
})

it('keeps cleanup conservative after delivery failure and removes all closed membership despite a failed presentation callback', async () => {
  const f = fixture()
  f.send('one', frame('app_panes', { agentIds: ['agent'] })); f.send('one', tab())
  f.hooks.onAppSwarms.mockImplementation(() => { throw new Error('private') })
  f.resolve(); await flush()
  expect(f.log).toHaveBeenCalledWith('[local-ws] LEGACY_DESK_DELIVERY_FAILED · Error')
  await expect(f.guard.assertHidden(agent)).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
  f.hooks.onAppPanes.mockImplementation(() => { throw new Error('private') })
  f.live.delete('one'); f.loader.closed('one')
  expect(f.log).toHaveBeenCalledWith('[local-ws] LEGACY_DESK_CLOSE_FAILED · Error')
  expect(f.loader.snapshot()).toMatchObject({ desk: [], swarms: null })
  await expect(f.guard.assertHidden(agent)).resolves.toBeUndefined()
  f.loader.stop()
})

it.each(['provider', 'factory'])('contains a synchronous %s failure and names it without private error content', async mode => {
  const f = fixture()
  if (mode === 'provider') f.load.mockImplementation(() => { throw new Error('private') })
  else f.load.mockResolvedValue({ createLegacyDeviceWindowState: () => { throw new Error('private') } })
  f.send('one', tab()); await flush()
  expect(f.log.mock.calls).toEqual([['[local-ws] LEGACY_DESK_LOAD_FAILED']])
  expect(f.loader.snapshot()).toBeUndefined(); f.loader.stop()
})

it.each(['broken', 'null', '[]', '{"type":7}'])('refuses damaged queued bytes %s without an unhandled rejection or releasing unknown tabs', async bytes => {
  const f = fixture()
  f.send('one', tab(), Buffer.from(bytes)); f.resolve(); await flush()
  expect(f.log).toHaveBeenCalledWith(`[local-ws] LEGACY_DESK_FRAME_INVALID · ${bytes === 'broken' ? 'SyntaxError' : 'Error'}`)
  await expect(f.guard.assertHidden(agent)).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
  f.send('one', tab())
  expect(f.pending).toHaveBeenLastCalledWith('one', false); f.loader.stop()
})

it('contains error-reply failure and ignores a late rejected import after stopping', async () => {
  const f = fixture()
  f.refused.mockImplementation(() => { throw new Error('private') })
  f.send('one', tab()); f.reject(new Error('private')); await flush()
  expect(f.log).toHaveBeenCalledWith('[local-ws] LEGACY_DESK_REPLY_FAILED · Error')
  f.loader.stop()
  const stopped = fixture()
  stopped.send('one', tab()); stopped.loader.stop(); stopped.reject(new Error('late')); await flush()
  expect(stopped.log).not.toHaveBeenCalled()
})

it('does not warn for normal stop and uses the default logger for a real load refusal', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const loader = createLegacyDeviceWindowLoader({ hooks: {}, live: () => false, pending: () => {}, refused: () => {},
    load: async () => { throw new Error('private') } })
  const value = frame('app_panes')
  loader.receive('gone', value, Buffer.from(JSON.stringify(value))); await flush()
  expect(warn).toHaveBeenCalledExactlyOnceWith('[local-ws] LEGACY_DESK_LOAD_FAILED')
  loader.stop()
})

it('ignores an initially invalid roster without inventing a cleanup hold and parses agent_seen identity inside the owner', async () => {
  const f = fixture()
  f.send('one', frame('app_swarms', {})); f.resolve(); await flush()
  await expect(f.guard.assertHidden(agent)).resolves.toBeUndefined()
  f.send('one', frame('agent_seen', { agentId: 'agent', readToken: 'invalid token' }))
  f.send('one', frame('agent_seen', {}))
  expect(f.hooks.onAgentSeen).not.toHaveBeenCalled()
  f.send('one', frame('agent_seen', { agentId: 'agent' }))
  expect(f.hooks.onAgentSeen).toHaveBeenCalledExactlyOnceWith('agent', undefined)
  f.loader.stop()
})

it('holds a newly failed live roster after loading while a failed notification leaves tab authority alone', async () => {
  const f = fixture()
  f.send('one', tab()); f.resolve(); await flush()
  f.hooks.onAppSwarms.mockImplementation(() => { throw new Error('private') })
  f.send('one', tab())
  await expect(f.guard.assertHidden(agent)).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
  f.hooks.onAppUnread.mockImplementation(() => { throw new Error('private') })
  f.send('two', frame('app_unread', {}))
  expect(f.pending).not.toHaveBeenCalledWith('two', true)
  expect(f.refused).toHaveBeenCalledWith('two', 'LEGACY_DESK_DELIVERY_FAILED')
  f.loader.stop()
})

it('holds an overflowing tab reporter and bounds refusal after both real attempts fail', async () => {
  const f = fixture()
  for (let n = 0; n < 128; n++) f.send('one', frame('app_panes'))
  f.send('two', tab())
  expect(f.refused).toHaveBeenCalledWith('two', 'LEGACY_DESK_LOAD_LIMIT')
  await expect(f.guard.assertHidden(agent)).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
  f.send('two', tab()); f.reject(new Error('private')); await flush()
  f.send('one', frame('app_unread'))
  expect(f.load).toHaveBeenCalledTimes(2)
  expect(f.refused).toHaveBeenLastCalledWith('one', 'LEGACY_DESK_LOAD_FAILED')
  f.loader.stop()
})

it('releases closed damaged frames and refuses damaged notifications without holding another window', async () => {
  const f = fixture()
  f.send('one', tab(), Buffer.from('null'))
  f.send('two', frame('app_unread'), Buffer.from('null'))
  f.live.delete('one'); f.loader.closed('one'); f.resolve(); await flush()
  await expect(f.guard.assertHidden(agent)).resolves.toBeUndefined()
  expect(f.refused).not.toHaveBeenCalledWith('one', expect.anything())
  expect(f.refused).toHaveBeenCalledWith('two', 'LEGACY_DESK_FRAME_INVALID')
  f.loader.stop()
})
