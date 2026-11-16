import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { createStoreOf } from './stores.js'


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

  it('leaves an unavailable location unknown, never an empty conversation', async () => {
    const store = createStoreOf({ opencode: '', kilo: '', devin: '', openclaw: async () => null }, async () => { throw new Error('ENGINE_UNAVAILABLE') })
    await expect(store(session('hermes'))).rejects.toThrow('ENGINE_UNAVAILABLE')
  })
})
