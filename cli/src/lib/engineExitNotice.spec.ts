import { describe, it, expect, vi } from 'vitest'
import { ENGINE_EXIT_NOTICE, EngineExitNoticeScanner, createEngineExitObserver } from './engineExitNotice.js'
import type { RegisteredSession } from './registry.js'

function fixture() {
  let row: RegisteredSession | undefined = { agentId: 'a', engine: 'claude', sessionId: 'conversation',
    launch: { state: 'ready' }, tmuxPane: '%1', processIdentity: { pid: 10, startMarker: 'first', executable: 'claude' } } as RegisteredSession
  const deps = {
    current: () => row,
    blocked: vi.fn(() => false),
    pane: vi.fn(async () => ({ dead: false, engineExit: 130, command: 'zsh', exitStatus: null })),
    process: vi.fn(async () => ({ state: 'gone' as const, reason: 'exited' })),
    retain: vi.fn(() => { row = undefined }),
  }
  return { deps, observe: createEngineExitObserver(deps), row: () => row }
}

describe('engine exit notification', () => {
  it('recognizes every split of a live marker without retaining unrelated output', () => {
    for (let at = 1; at < ENGINE_EXIT_NOTICE.length; at++) {
      const scan = new EngineExitNoticeScanner()
      expect(scan.push(Buffer.from('x'.repeat(100_000)))).toBe(false)
      expect(scan.push(Buffer.from(ENGINE_EXIT_NOTICE.slice(0, at)))).toBe(false)
      expect(scan.push(Buffer.from(ENGINE_EXIT_NOTICE.slice(at)))).toBe(true)
      expect(scan.push(Buffer.from('ordinary output'))).toBe(false)
    }
  })
  it('retains only a confirmed exit and coalesces multiple viewers', async () => {
    const f = fixture()
    await Promise.all([f.observe('a'), f.observe('a')])
    expect(f.deps.pane).toHaveBeenCalledTimes(1)
    expect(f.deps.retain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'conversation' }), true)
    await f.observe('a')
    expect(f.deps.retain).toHaveBeenCalledTimes(1)
  })
  it.each(['before', 'during pane probe', 'during process probe'])('leaves an explicit stop or restart in charge %s', async phase => {
    const f = fixture()
    const block = () => { f.deps.blocked.mockReturnValue(true) }
    if (phase === 'before') block()
    else if (phase === 'during pane probe') f.deps.pane.mockImplementation(async () => {
      block(); return { dead: false, engineExit: 130, command: 'zsh', exitStatus: null }
    })
    else f.deps.process.mockImplementation(async () => { block(); return { state: 'gone', reason: 'stopped' } })
    await f.observe('a')
    expect(f.deps.retain).not.toHaveBeenCalled()
    expect(f.row()?.sessionId).toBe('conversation')
    // A failed stop can release the route; a later confirmed exit still retires it.
    f.deps.blocked.mockReturnValue(false)
    f.deps.pane.mockResolvedValue({ dead: false, engineExit: 130, command: 'zsh', exitStatus: null })
    f.deps.process.mockResolvedValue({ state: 'gone', reason: 'exited' })
    await f.observe('a')
    expect(f.deps.retain).toHaveBeenCalledTimes(1)
  })
  it.each(['alive', 'unknown'])('cannot close a %s process even with an exit marker', async state => {
    const f = fixture()
    f.deps.process.mockResolvedValue({ state, reason: 'not confirmed' } as any)
    await f.observe('a')
    expect(f.deps.retain).not.toHaveBeenCalled()
  })
  it('ignores forged output when the wrapper has not marked an exit', async () => {
    const f = fixture()
    f.deps.pane.mockResolvedValue({ dead: false, engineExit: null, command: 'claude', exitStatus: null } as any)
    await f.observe('a')
    expect(f.deps.process).not.toHaveBeenCalled()
    expect(f.deps.retain).not.toHaveBeenCalled()
  })
  it.each(['tmuxPane', 'sessionId', 'engine', 'processIdentity', 'launch'])('does not archive a replacement %s', async key => {
    const f = fixture()
    f.deps.process.mockImplementation(async () => {
      Object.assign(f.row()!, { [key]: key === 'processIdentity' ? { pid: 10, startMarker: 'replacement', executable: 'claude' }
        : key === 'launch' ? { state: 'starting' } : 'replacement' })
      return { state: 'gone', reason: 'old process exited' }
    })
    await f.observe('a')
    expect(f.deps.retain).not.toHaveBeenCalled()
  })
  it('keeps launch errors visible and survives probe errors', async () => {
    const f = fixture()
    f.row()!.launch = { state: 'starting' }
    await f.observe('a')
    expect(f.deps.pane).not.toHaveBeenCalled()
    f.row()!.launch = { state: 'ready' }
    f.deps.pane.mockRejectedValueOnce(new Error('unavailable'))
    await f.observe('a')
    expect(f.deps.retain).not.toHaveBeenCalled()
    await f.observe('a')
    expect(f.deps.retain).toHaveBeenCalledTimes(1)
  })
})
