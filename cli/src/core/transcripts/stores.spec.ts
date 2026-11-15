import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { hermesDbForSession } from '../../lib/hermesHome.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createStoreOf, hermesDb } from './stores.js'

vi.mock('../../lib/hermesHome.js', () => ({ hermesDbForSession: vi.fn(async () => '/profiles/work/state.db') }))

const session = (engine: string, over: Partial<RegisteredSession> = {}) => ({ agentId: 'a1', sessionId: 's1', engine, ...over }) as RegisteredSession

describe('the store a conversation kept in a database is in', () => {
  const openclaw = vi.fn(async (key: string) => key.startsWith('agent:') ? '/state/agents/main/agent/openclaw.sqlite' : null)
  const storeOf = createStoreOf({ opencode: '/stores/opencode.db', kilo: '/stores/kilo.db', devin: '/stores/sessions.db', openclaw },
    async (s) => `/homes/${s.agentId}/state.db`)

  it('OpenCode, Kilo and Devin: the one store each keeps on this machine', async () => {
    expect(await storeOf(session('opencode'))).toBe('/stores/opencode.db')
    expect(await storeOf(session('kilo'))).toBe('/stores/kilo.db')
    expect(await storeOf(session('devin'))).toBe('/stores/sessions.db')
  })

  it('Hermes: the home its session lives in; OpenClaw: its TUI\'s state folder, by the pid and the folder it was bound with', async () => {
    expect(await storeOf(session('hermes'))).toBe('/homes/a1/state.db')
    expect(await storeOf(session('openclaw', { sessionId: 'agent:main:one', processIdentity: { pid: 77 } as never, openclawStateDir: '/state' })))
      .toBe('/state/agents/main/agent/openclaw.sqlite')
    expect(openclaw).toHaveBeenCalledWith('agent:main:one', { pid: 77, stateDir: '/state' })
    expect(await storeOf(session('openclaw', { sessionId: 'not-a-key' }))).toBeNull()
    expect(openclaw).toHaveBeenLastCalledWith('not-a-key', { pid: 0, stateDir: undefined })
  })

  it('none for an engine that keeps its conversation in a file', async () => {
    for (const engine of ['claude', 'codex', 'pi', 'terminal']) expect(await storeOf(session(engine))).toBeNull()
  })

  it('a Hermes session\'s store is its home\'s, found by Hermes\'s code; the default home\'s without it', async () => {
    const hermes = session('hermes')
    expect(await createStoreOf({ opencode: '', kilo: '', devin: '', openclaw: async () => null })(hermes)).toBe('/profiles/work/state.db')
    expect(await hermesDb(hermes)).toBe('/profiles/work/state.db')
    expect(hermesDbForSession).toHaveBeenLastCalledWith(hermes)
    vi.resetModules()
    vi.doMock('../../engines/hermes/inProcess.js', () => { throw new Error('Hermes is gone') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { hermesDb: lazily } = await import('./stores.js')
    expect(await lazily(hermes)).toBe(join(env.HERMES_HOME, 'state.db'))
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[engine hermes\] unavailable · /))
    vi.doUnmock('../../engines/hermes/inProcess.js')
    error.mockRestore()
  })
})
