import { describe, expect, it, vi } from 'vitest'
import { watchIn, watchLink } from './watchLink.js'

describe('the core\'s read-only view of terminals, from a service in its own process', () => {
  it('asks the core for each viewer\'s frames and its end, in order, and a frame the core could not take is lost quietly', async () => {
    const query = vi.fn(async () => ({}))
    const { watch } = watchLink(query)
    await watch.frame('observer:ken', 'terminal_open', { agentId: 'a1' })
    await watch.close('observer:ken')
    expect(query.mock.calls).toEqual([
      ['watch_frame', { viewer: 'observer:ken', type: 'terminal_open', payload: { agentId: 'a1' } }],
      ['watch_close', { viewer: 'observer:ken' }],
    ])
    const gone = watchLink(async () => { throw new Error('the link went') })
    await expect(gone.watch.frame('v', 'terminal_ack', {})).resolves.toBeUndefined()
    await expect(gone.watch.close('v')).resolves.toBeUndefined()
  })

  it('hands what the core says a viewer is shown to each listener, until it stops listening', () => {
    const link = watchLink(async () => ({}))
    const heard = vi.fn()
    const stop = link.watch.onOutput(heard)
    link.watch.onOutput(() => { throw new Error('one listener failing') })
    expect(link.heard({ kind: 'watch', viewer: 'v', output: { type: 'terminal_opened', payload: { streamId: 's' } } })).toBe(true)
    expect(link.heard({ kind: 'watch', viewer: 'v', output: { binary: 'aGk=' } })).toBe(true)
    stop()
    link.heard({ kind: 'watch', viewer: 'v', output: { binary: 'aGk=' } })
    expect(heard.mock.calls).toEqual([['v', { type: 'terminal_opened', payload: { streamId: 's' } }], ['v', { binary: 'aGk=' }]])
  })

  it('takes nothing else for what a viewer is shown', () => {
    expect(watchLink(async () => ({})).heard({ kind: 'delivery' })).toBe(false)
    for (const payload of [
      { kind: 'watch', output: { binary: 'x' } },
      { kind: 'watch', viewer: 'v' },
      { kind: 'watch', viewer: 'v', output: { type: 'x' } },
      { kind: 'watch', viewer: 'v', output: { payload: {} } },
    ]) expect(watchIn(payload)).toBeNull()
  })
})
