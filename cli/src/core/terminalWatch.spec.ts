import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import type { TerminalStreamSink } from '../lib/terminalTypes.js'
import type { TerminalStreamManager } from '../lib/terminalStreamManager.js'
import { createTerminalWatch, KEPT_VIEWERS, type TerminalWatchDeps } from './terminalWatch.js'

type Manager = ConstructorParameters<typeof TerminalStreamManager>[0]

/** A stream manager the spec drives: it records what it was handed and how it was built. */
function manager() {
  const built: Manager[] = []
  const handled: Array<[string, string, Record<string, unknown>]> = []
  const closed: string[] = []
  const stop = vi.fn(async () => {})
  const make = (deps: Manager) => {
    built.push(deps)
    return {
      handleFrame: vi.fn(async (viewer: string, type: string, payload: Record<string, unknown>) => { handled.push([viewer, type, payload]); return true }),
      closeConnection: vi.fn(async (viewer: string) => { closed.push(viewer) }),
      stop,
    }
  }
  return { built, handled, closed, stop, make }
}

const setup = (over: Partial<TerminalWatchDeps> = {}) => {
  const m = manager()
  const tell = vi.fn(() => true)
  const agent = { agentId: 'agent-1' } as RegisteredSession
  const watch = createTerminalWatch({
    terminals: { openStream: vi.fn() } as never,
    resolve: (id) => (id === 'agent-1' ? agent : undefined),
    tell,
    watchers: new Set(['sharing']),
    manager: m.make as never,
    ...over,
  })
  return { watch, tell, m, agent }
}

describe('a read-only view of agents\' terminals', () => {
  it('builds no stream manager until its first viewer, and a read-only one then', async () => {
    const { watch, m, agent } = setup()
    expect(m.built).toHaveLength(0)
    await watch.watch.close('observer:none')
    await watch.stop()
    await watch.watch.frame('observer:ken', 'terminal_open', { agentId: 'agent-1' })
    expect(m.built).toHaveLength(1)
    expect(m.built[0]).toMatchObject({ readOnly: true, streamingAvailable: true })
    expect(m.built[0].resolveAgent('agent-1')).toBe(agent)
    expect(m.handled).toEqual([['observer:ken', 'terminal_open', { agentId: 'agent-1' }]])
    await watch.watch.frame('observer:ken', 'terminal_ack', {})
    expect(m.built).toHaveLength(1)
    await watch.stop()
    expect(m.stop).toHaveBeenCalledOnce()
  })

  it('shows a viewer in this process what it is shown, frames and bytes, through each listener until it stops', async () => {
    const { watch, m } = setup()
    const shown: unknown[] = []
    const stop = watch.watch.onOutput((viewer, output) => shown.push([viewer, output]))
    watch.watch.onOutput(() => { throw new Error('one listener failing') })
    await watch.watch.frame('observer:ken', 'terminal_open', {})
    const deps = m.built[0]
    expect(deps.sendTarget('observer:ken', 'terminal_opened', { streamId: 's' })).toBe(true)
    // A terminal's output bytes (kind 2), as the stream manager hands them over.
    expect(deps.sendBinaryTarget('observer:ken', { kind: 2, streamId: '00000000-0000-4000-8000-000000000001', seq: 1, bytes: new Uint8Array([104, 105]), compressed: false } as never)).toBe(true)
    expect(shown[0]).toEqual(['observer:ken', { type: 'terminal_opened', payload: { streamId: 's' } }])
    expect(shown[1]).toEqual(['observer:ken', { binary: expect.any(String) }])
    // A frame the local encoding cannot carry is not sent.
    expect(deps.sendBinaryTarget('observer:ken', { kind: 2, streamId: '00000000-0000-4000-8000-000000000001', seq: -1, bytes: new Uint8Array(), compressed: false } as never)).toBe(false)
    stop()
  })

  it('tells a process\'s viewer what it is shown, and nothing to a viewer no one has', async () => {
    const { watch, tell, m } = setup()
    expect(await watch.answer('sharing', 'watch_frame', { viewer: 'observer:ken', type: 'terminal_open', payload: { agentId: 'agent-1' } })).toEqual({})
    expect(m.handled).toEqual([['observer:ken', 'terminal_open', { agentId: 'agent-1' }]])
    await watch.answer('sharing', 'watch_frame', { viewer: 'observer:ken', type: 'terminal_ack' })
    expect(m.handled[1]).toEqual(['observer:ken', 'terminal_ack', {}])
    const deps = m.built[0]
    expect(deps.sendTarget('observer:ken', 'terminal_opened', {})).toBe(true)
    expect(tell).toHaveBeenCalledWith('sharing', 'observer:ken', { type: 'terminal_opened', payload: {} })
    // No listener and no process: shown to no one.
    expect(deps.sendTarget('observer:nobody', 'terminal_opened', {})).toBe(false)
    expect(await watch.answer('sharing', 'watch_close', { viewer: 'observer:ken' })).toEqual({})
    expect(m.closed).toEqual(['observer:ken'])
    expect(deps.sendTarget('observer:ken', 'terminal_opened', {})).toBe(false)
  })

  it('takes a viewer\'s terminal frames from a watcher alone, and nothing that is not one', async () => {
    const { watch, m } = setup()
    expect(await watch.answer('gateway', 'watch_frame', { viewer: 'v', type: 'terminal_open' })).toEqual({ error: 'NOT_A_WATCHER' })
    expect(await watch.answer('sharing', 'watch_frame', { type: 'terminal_open' })).toEqual({ error: 'INVALID_VIEWER' })
    expect(await watch.answer('sharing', 'watch_frame', { viewer: 'v', type: 'message' })).toEqual({ error: 'INVALID_FRAME' })
    expect(await watch.answer('sharing', 'live', {})).toBeNull()
    expect(m.handled).toEqual([])
  })

  it('stops showing a process\'s viewers when it goes, and remembers the owners of the last viewers only', async () => {
    const { watch, m, tell } = setup({ watchers: new Set(['sharing', 'other']) })
    await watch.answer('sharing', 'watch_frame', { viewer: 'v1', type: 'terminal_open' })
    await watch.answer('other', 'watch_frame', { viewer: 'v2', type: 'terminal_open' })
    await watch.gone('sharing')
    expect(m.closed).toEqual(['v1'])
    for (let i = 0; i < KEPT_VIEWERS; i++) await watch.answer('sharing', 'watch_frame', { viewer: `x${i}`, type: 'terminal_ack' })
    m.built[0].sendTarget('v2', 'terminal_opened', {})
    expect(tell).not.toHaveBeenCalledWith('other', 'v2', expect.anything())
  })

  it('builds the real stream manager when given none', async () => {
    const watch = createTerminalWatch({ terminals: { openStream: vi.fn() } as never, resolve: () => undefined, tell: () => true, watchers: new Set(['sharing']) })
    const sink: TerminalStreamSink[] = []
    await watch.watch.frame('observer:ken', 'terminal_capabilities', {})
    await watch.stop()
    expect(sink).toEqual([])
  })
})
