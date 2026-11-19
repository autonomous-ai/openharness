import { expect, it, vi } from 'vitest'
import { createLegacyDeviceWindowState } from './legacyDeviceWindowState.js'

const width = 512 * 1024
const panes = (id: string) => ({ agentIds: [id] })
const tabs = (id: string) => ({ swarms: [{ id, name: id, agentIds: [id] }] })
const unread = { items: [{ agentId: 'agent', machineId: 'machine', text: 'kept' }] }
const refusal = { code: 'LEGACY_DESK_STATE_LIMIT' }
function fixture() {
  const hooks = { onAppPanes: vi.fn(), onAppSwarms: vi.fn(), onAppUnread: vi.fn(), onAgentSeen: vi.fn() }
  const owner = createLegacyDeviceWindowState(hooks)
  const send = (connection: string, type: string, payload: Record<string, unknown>, bytes = Buffer.byteLength(JSON.stringify({ type, payload }))) =>
    owner.receive(connection, type, payload, bytes)
  return { owner, hooks, send }
}

it('refuses a first pane report before changing foreground, while existing reporters can add their second roster', () => {
  const f = fixture()
  for (let i = 0; i < 128; i++) f.send(`window-${i}`, 'app_swarms', tabs(String(i)))
  expect(f.owner.snapshot().foreground).toBe(true)
  expect(() => f.send('new', 'app_panes', panes('new'))).toThrow(expect.objectContaining(refusal))
  expect(f.owner.snapshot()).toMatchObject({ desk: [], foreground: true })
  expect(f.send('new', 'agent_seen', { agentId: 'agent' })).toBe(true)
  expect(f.hooks.onAgentSeen).toHaveBeenCalledExactlyOnceWith('agent', undefined)
  expect(f.send('new', 'app_swarms', {})).toBe(false)
  expect(f.send('window-0', 'app_panes', panes('existing'))).toBe(true)
  expect(f.owner.snapshot().desk).toEqual(['existing'])
})

it('keeps accepted reporter order and content when an older report grows past the byte ceiling', () => {
  const f = fixture()
  for (let i = 0; i < 16; i++) f.send(`window-${i}`, 'app_panes', panes(String(i)), width)
  expect(() => f.send('window-0', 'app_panes', panes('refused'), width + 1)).toThrow(expect.objectContaining(refusal))
  expect(f.owner.snapshot().desk).toEqual(['15'])
  expect(f.send('extra', 'agent_seen', { agentId: 'agent' })).toBe(true)
  expect(f.send('extra', 'app_swarms', {})).toBe(false)
  for (let i = 15; i > 0; i--) f.owner.closed(`window-${i}`)
  expect(f.owner.snapshot().desk).toEqual(['0'])
})

it('keeps admitted charges after hook failure and releases them once even when the close hook fails', () => {
  const f = fixture()
  for (let i = 0; i < 15; i++) f.send(`window-${i}`, 'app_panes', panes(String(i)), width)
  f.hooks.onAppPanes.mockImplementation(() => { throw new Error('callback failure') })
  expect(() => f.send('latest', 'app_panes', panes('latest'), width)).toThrow('callback failure')
  expect(() => f.send('extra', 'app_panes', panes('extra'))).toThrow(expect.objectContaining(refusal))
  expect(() => f.owner.closed('latest')).toThrow('callback failure')
  expect(() => f.owner.closed('latest')).not.toThrow()
  f.hooks.onAppPanes.mockReset()
  expect(f.send('replacement', 'app_panes', panes('replacement'), width)).toBe(true)
  expect(() => f.send('extra', 'app_panes', panes('extra'))).toThrow(expect.objectContaining(refusal))
})

it('keeps unread charged after its reporting socket closes and releases its replaced charge', () => {
  const f = fixture()
  f.send('reader', 'app_unread', unread, width)
  for (let i = 0; i < 15; i++) f.send(`window-${i}`, 'app_panes', panes(String(i)), width)
  f.owner.closed('reader'); f.owner.closed('reader')
  expect(f.owner.snapshot().unread[0].text).toBe('kept')
  expect(() => f.send('extra', 'app_panes', panes('extra'))).toThrow(expect.objectContaining(refusal))
  f.send('other-reader', 'app_unread', { items: [] })
  expect(f.send('extra', 'app_panes', panes('extra'))).toBe(true)
})

it.each([NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1])('refuses invalid byte accounting %s without poisoning later admission', bytes => {
  const f = fixture()
  expect(() => f.send('window', 'app_panes', panes('refused'), bytes)).toThrow(expect.objectContaining(refusal))
  expect(f.owner.snapshot()).toMatchObject({ desk: [], foreground: true })
  expect(f.send('window', 'app_panes', panes('accepted'))).toBe(true)
  expect(f.owner.snapshot().desk).toEqual(['accepted'])
})


it('releases a reporter slot once across duplicate closes', () => {
  const f = fixture()
  for (let i = 0; i < 128; i++) f.send(`window-${i}`, 'app_panes', panes(String(i)))
  f.owner.closed('window-0'); f.owner.closed('window-0')
  expect(f.send('replacement', 'app_panes', panes('replacement'))).toBe(true)
  expect(() => f.send('extra', 'app_panes', panes('extra'))).toThrow(expect.objectContaining(refusal))
})
