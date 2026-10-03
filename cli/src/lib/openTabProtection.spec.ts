import { expect, it } from 'vitest'
import { OpenTabProtection } from './openTabProtection.js'
import type { RegisteredSession } from './registry.js'

const session = (agentId: string, paneId = `%${agentId}`) => ({ agentId, runtimes: [{ backend: 'tmux', paneId }] }) as RegisteredSession
function fixture(tabs: unknown[] = []) {
  const sessions = [session('foreground'), session('background'), session('companion'), session('hidden'), session('alias', '%background')]
  let reply = { status: 200, body: { success: true, data: { revision: 1, tabs } } }
  const guard = new OpenTabProtection({ machineId: () => 'here', sessions: () => sessions, readDesk: async () => reply })
  return { guard, sessions, setReply: (value: any) => { reply = value } }
}
it('keeps foreground, background, local utility tabs and aliases of their terminal', async () => {
  const { guard, sessions } = fixture([{ panes: [{ machineId: 'here', agentId: 'foreground' }] },
    { panes: [{ machineId: 'here', agentId: 'background' }, { machineId: 'elsewhere', agentId: 'hidden' }] }])
  guard.updateWindow('window', ['companion'])
  await guard.refresh()
  expect(sessions.filter(s => guard.isHidden(s)).map(s => s.agentId)).toEqual(['hidden'])
})
it('keeps another window’s tabs when one window disconnects', async () => {
  const { guard } = fixture()
  guard.updateWindow('one', ['companion']); guard.updateWindow('two', ['companion'])
  guard.updateWindow('one', null)
  await expect(guard.assertHidden(session('companion'))).rejects.toMatchObject({ code: 'SESSION_IN_TAB' })
  guard.updateWindow('two', null)
  await expect(guard.assertHidden(session('companion'))).resolves.toBeUndefined()
})
it.each([
  { status: 503, body: {} },
  { status: 200, body: { success: true, data: {} } },
  { status: 200, body: { success: true, data: { revision: 2, tabs: [{ panes: [{}] }] } } },
])('refuses cleanup when the shared workspace cannot be read completely', async reply => {
  const { guard, setReply } = fixture(); setReply(reply)
  await expect(guard.assertHidden(session('hidden'))).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
})
it('rechecks shared tabs and rejects late reads from an older revision', async () => {
  const { guard, setReply } = fixture()
  await guard.assertHidden(session('hidden'))
  setReply({ status: 200, body: { success: true, data: { revision: 2, tabs: [{ panes: [{ machineId: 'here', agentId: 'hidden' }] }] } } })
  await expect(guard.assertHidden(session('hidden'))).rejects.toMatchObject({ code: 'SESSION_IN_TAB' })
  setReply({ status: 200, body: { success: true, data: { revision: 1, tabs: [] } } })
  await expect(guard.refresh()).rejects.toMatchObject({ code: 'TABS_UNAVAILABLE' })
  expect(guard.isHidden(session('hidden'))).toBe(false)
})
