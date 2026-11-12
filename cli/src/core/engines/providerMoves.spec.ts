import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_MOVE, PROVIDER_MOVE_CAPABILITIES, PROVIDER_MOVE_ENV_BYTES } from '../../engines/worker/providerMoveProtocol.js'
import { createProviderMoves } from './providerMoves.js'

const ask = { sessionId: 's1', toGrid: true, args: ['-m', 'big'], command: '/native/codex', env: { CODEX_HOME: '/codex', UNSET: undefined }, cwd: '/work' }

/** Codex's worker on its link, answering its capability and each move with [answer]. */
function setup(answer: unknown = { threadId: 'fork-1' }) {
  const call = vi.fn(async (_service: string, method: string, _payload: Record<string, unknown>) =>
    method === PROVIDER_MOVE_CAPABILITIES ? { version: 1, providerMove: 1, engine: 'codex' } : { version: 1, answer })
  const inline = vi.fn(async () => ({ threadId: 'fork-inline' }))
  const handles = vi.fn(() => true)
  const moves = createProviderMoves({ call, handles, inline: engine => engine === 'codex' ? inline : undefined })
  moves.connected('engine-codex')
  return { call, inline, handles, moves }
}

describe('a retarget\'s provider move, in Codex\'s worker (#4145)', () => {
  it('asks Codex\'s worker with the launch\'s arguments, executable and set environment, and returns the fork', async () => {
    const t = setup()
    expect(await t.moves.move('codex', ask)).toBe('fork-1')
    expect(t.call).toHaveBeenLastCalledWith('engine-codex', PROVIDER_MOVE, { version: 1, sessionId: 's1', toGrid: true, args: ['-m', 'big'],
      command: '/native/codex', env: { CODEX_HOME: '/codex' }, cwd: '/work' }, expect.any(Number))
    expect(t.inline).not.toHaveBeenCalled()
  })

  it('throws the engine\'s reason, or why it could not ask, so the retarget continues in a plain fork', async () => {
    await expect(setup({ refused: 'Codex did not answer thread/fork' }).moves.move('codex', ask)).rejects.toThrow('Codex did not answer thread/fork')
    await expect(setup({ threadId: '' }).moves.move('codex', ask)).rejects.toThrow('ENGINE_INVALID_REPLY')
    const down = setup()
    down.moves.disconnected('engine-codex')
    down.call.mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' } as never)
    await expect(down.moves.move('codex', ask)).rejects.toThrow('ENGINE_UNAVAILABLE')
    const huge = setup()
    await expect(huge.moves.move('codex', { ...ask, env: { BIG: 'x'.repeat(PROVIDER_MOVE_ENV_BYTES) } })).rejects.toThrow('ENGINE_INVALID_REQUEST')
    expect(huge.call).not.toHaveBeenCalled()
  })

  it('moves in line only in explicit inline mode, and an engine with none there throws', async () => {
    const t = setup()
    t.handles.mockReturnValue(false)
    const { cwd: _cwd, ...noFolder } = ask
    expect(await t.moves.move('codex', noFolder)).toBe('fork-inline')
    expect(t.inline).toHaveBeenCalledWith({ sessionId: 's1', toGrid: true, args: ['-m', 'big'], command: '/native/codex', env: { CODEX_HOME: '/codex' } })
    await expect(t.moves.move('claude', ask)).rejects.toThrow('claude has no provider move here')
    expect(t.call).not.toHaveBeenCalled()
  })
})
