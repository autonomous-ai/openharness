import { describe, expect, it, vi } from 'vitest'
import { providerMoveFor } from '../providerMoves.js'
import { moveCodexConversation } from '../codex/providerMove.js'
import { engineProviderMoveRequests } from './providerMoveRequests.js'
import { PROVIDER_MOVE, PROVIDER_MOVE_CAPABILITIES, PROVIDER_MOVE_ENV_BYTES, PROVIDER_MOVE_IN_FLIGHT, PROVIDER_MOVE_WAIT_MS } from './providerMoveProtocol.js'

vi.mock('../codex/providerMove.js', () => ({ moveCodexConversation: vi.fn(async () => 'fork-1') }))

const who = { owner: true, local: true }
const move = { version: 1, sessionId: 's1', toGrid: true, args: ['-m', 'big'], command: '/native/codex', env: { CODEX_HOME: '/codex' }, cwd: '/work' }
const fail = (error: string) => ({ version: 1, error })

describe('Codex\'s worker forks a conversation for its new provider (#4145)', () => {
  it('moves it with what core sent, loaded once and only when first asked', async () => {
    const run = vi.fn(async () => ({ threadId: 'fork-1' }))
    const load = vi.fn(async () => run)
    const requests = engineProviderMoveRequests({ load })
    expect(await requests[PROVIDER_MOVE_CAPABILITIES]({ version: 1 }, who)).toEqual({ version: 1, providerMove: 1, engine: 'codex' })
    expect(load).not.toHaveBeenCalled()
    expect(await requests[PROVIDER_MOVE]({ ...move, requestId: 'core-route-1' }, who)).toEqual({ version: 1, answer: { threadId: 'fork-1' } })
    const { cwd: _cwd, ...noFolder } = move
    run.mockResolvedValueOnce({ refused: 'Codex exited during the move' } as never)
    expect(await requests[PROVIDER_MOVE](noFolder, who)).toEqual({ version: 1, answer: { refused: 'Codex exited during the move' } })
    expect(run).toHaveBeenLastCalledWith({ sessionId: 's1', toGrid: true, args: ['-m', 'big'], command: '/native/codex', env: { CODEX_HOME: '/codex' } })
    expect(load).toHaveBeenCalledOnce()
  })

  it('takes only core\'s private local request, with a session, a destination, bounded arguments and environment', async () => {
    const run = vi.fn(async () => ({ threadId: 'fork-1' }))
    const requests = engineProviderMoveRequests({ load: async () => run })
    expect(await requests[PROVIDER_MOVE](move, { owner: true, local: false })).toEqual(fail('ENGINE_INVALID_REQUEST'))
    for (const bad of [{ ...move, sessionId: '' }, { ...move, toGrid: 'yes' }, { ...move, command: '' }, { ...move, cwd: 'a\0b' },
      { ...move, args: 'app-server' }, { ...move, args: [1] }, { ...move, args: Array(257).fill('-c') },
      { ...move, env: { BIG: 'x'.repeat(PROVIDER_MOVE_ENV_BYTES) } }, { ...move, extra: true }]) {
      expect(await requests[PROVIDER_MOVE](bad, who)).toEqual(fail('ENGINE_INVALID_REQUEST'))
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses an answer out of shape, and recycles a worker whose move outlives its bound', async () => {
    for (const odd of [{ threadId: 'x'.repeat(201) }, { refused: 'x'.repeat(501) }, { threadId: 'a', refused: 'b' }, null]) {
      const requests = engineProviderMoveRequests({ load: async () => async () => odd as never })
      expect(await requests[PROVIDER_MOVE](move, who)).toEqual(fail('ENGINE_INVALID_REPLY'))
    }
    vi.useFakeTimers()
    try {
      const recycle = vi.fn()
      const stuck = engineProviderMoveRequests({ load: async () => () => new Promise(() => {}), recycle })
      const answers = Array.from({ length: PROVIDER_MOVE_IN_FLIGHT + 1 }, () => stuck[PROVIDER_MOVE](move, who))
      expect(await answers.at(-1)).toEqual(fail('ENGINE_BUSY'))
      await vi.advanceTimersByTimeAsync(PROVIDER_MOVE_WAIT_MS)
      expect(await answers[0]).toEqual(fail('ENGINE_UNAVAILABLE'))
      expect(recycle).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('is Codex\'s alone inline: it forks with the launch\'s executable, and says a failure as the engine\'s reason', async () => {
    expect(providerMoveFor('claude')).toBeUndefined()
    const inline = providerMoveFor('codex')!
    const { command: _command, ...rest } = move
    expect(await inline({ ...rest, version: undefined } as never)).toEqual({ threadId: 'fork-1' })
    const given = vi.mocked(moveCodexConversation).mock.lastCall![0]
    expect(given.argv(['app-server']).at(-1)).toBe('app-server')
    vi.mocked(moveCodexConversation).mockRejectedValueOnce(new Error('Codex refused the request'))
    expect(await inline(move as never)).toEqual({ refused: 'Codex refused the request' })
    vi.mocked(moveCodexConversation).mockRejectedValueOnce('gone')
    expect(await inline(move as never)).toEqual({ refused: 'gone' })
  })
})
