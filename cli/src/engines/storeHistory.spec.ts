import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'

const session = (engine: string) => ({ agentId: 'a1', sessionId: 's1', engine }) as RegisteredSession

afterEach(() => { vi.doUnmock('../lib/databaseHistory.js'); vi.resetModules(); vi.restoreAllMocks() })

describe('a database engine\'s conversation, for a service in the core\'s own process', () => {
  it('is read through the engines\' own readers, loaded only once one is asked for', async () => {
    const read = vi.fn((s: RegisteredSession) => async () => [{ type: 'text_delta', payload: { content: s.engine } }])
    let loaded = 0
    vi.doMock('../lib/databaseHistory.js', () => { loaded++; return { databaseHistory: read } })
    const { databaseHistory } = await import('./storeHistory.js')
    for (const engine of ['claude', 'codex', 'pi', 'cursor']) expect(databaseHistory(session(engine))).toBeUndefined()
    const thunk = databaseHistory(session('kilo'))!
    expect(loaded).toBe(0)
    expect(await thunk()).toEqual([{ type: 'text_delta', payload: { content: 'kilo' } }])
    expect(await databaseHistory(session('hermes'))!()).toEqual([{ type: 'text_delta', payload: { content: 'hermes' } }])
    expect(loaded).toBe(1)
    read.mockReturnValueOnce(undefined as never)
    expect(await databaseHistory(session('openclaw'))!()).toEqual([])
  })

  it('reads nothing when those readers could not be loaded, and says so once', async () => {
    vi.doMock('../lib/databaseHistory.js', () => { throw new Error('the readers are gone') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { databaseHistory } = await import('./storeHistory.js')
    expect(await databaseHistory(session('opencode'))!()).toEqual([])
    expect(await databaseHistory(session('devin'))!()).toEqual([])
    expect(error.mock.calls.filter(([line]) => /^\[engine databaseHistory\] unavailable · /.test(String(line)))).toHaveLength(1)
  })
})
