import { describe, expect, it, vi } from 'vitest'
import { screenFor } from '../../engines/screens.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createScreens } from './screens.js'

const capture = '────────────\n❯\n────────────\n? for shortcuts'
const row = () => ({ agentId: 'agent', sessionId: 'session', engine: 'claude', active: true,
  runtimes: [], processIdentity: { pid: 10, startMarker: 'one' } }) as unknown as RegisteredSession
function setup() {
  let current: RegisteredSession | undefined = row()
  const answer = screenFor('claude').inspect(capture)
  const remote = vi.fn(async () => answer), inline = vi.fn(() => answer), handles = vi.fn(() => true)
  return { screen: createScreens({ resolve: () => current, transport: { read: remote }, inline, handles }),
    remote, inline, handles, answer, row: current, replace: (next?: RegisteredSession) => { current = next } }
}
describe('core screen evidence', () => {
  it('reads a bound worker without retaining or reusing its screen', async () => {
    const t = setup()
    expect(await t.screen.read(t.row, capture)).toEqual(t.answer)
    expect(await t.screen.question(t.row, capture)).toBeNull()
    expect(t.remote).toHaveBeenCalledTimes(2)
    expect(t.inline).not.toHaveBeenCalled()
    t.handles.mockReturnValue(false)
    expect(await t.screen.read(t.row, capture)).toEqual(t.answer)
    expect(t.inline).toHaveBeenCalledWith('claude', capture)
    t.inline.mockReturnValueOnce(undefined as never)
    expect(await t.screen.read(t.row, capture)).toBeNull()
  })
  it('refuses missing, oversized or foreign captures before consulting an adapter', async () => {
    const t = setup()
    expect(await t.screen.read(t.row, null)).toBeNull()
    expect(await t.screen.read(t.row, 'é'.repeat(256 * 1024))).toBeNull()
    expect(await t.screen.read({ ...t.row, agentId: '' }, capture)).toBeNull()
    expect(await t.screen.read({ ...t.row, sessionId: 'old' }, capture)).toBeNull()
    t.replace()
    expect(await t.screen.read(t.row, capture)).toBeNull()
    expect(t.remote).not.toHaveBeenCalled()
  })
  it('does not substitute inline parsing for a failed worker or close a question on failure', async () => {
    const t = setup(); t.remote.mockRejectedValue(new Error('worker stopped'))
    expect(await t.screen.read(t.row, capture)).toBeNull()
    await expect(t.screen.question(t.row, capture)).rejects.toThrow('ENGINE_UNAVAILABLE')
    expect(t.inline).not.toHaveBeenCalled()
  })
  it.each(['sessionId', 'engine', 'active', 'processIdentity', 'runtimes'] as const)('discards evidence after an in-place %s change', async field => {
    const t = setup()
    let finish!: (value: typeof t.answer) => void
    t.remote.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const read = t.screen.read(t.row, capture)
    Object.assign(t.row, { [field]: field === 'active' ? false : field === 'processIdentity' ? { pid: 20 } : field === 'runtimes' ? [{ paneId: 'new' }] : 'changed' })
    finish(t.answer)
    expect(await read).toBeNull()
  })
})
