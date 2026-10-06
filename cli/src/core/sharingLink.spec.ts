import { describe, expect, it, vi } from 'vitest'
import { createSharingLink } from './sharingLink.js'

describe('Share in its own process, as the core sees it', () => {
  it('hands it each observer\'s frame as a call, which wakes it while it is off, and the relay gone as a notice', async () => {
    const call = vi.fn(async () => ({}))
    const notify = vi.fn(() => true)
    const port = createSharingLink({ call, notify })
    await port.observer('observer:ken', 'observer_open', { shareId: 's' })
    expect(call).toHaveBeenCalledWith('observer', { connId: 'observer:ken', type: 'observer_open', payload: { shareId: 's' } })
    port.linkDown()
    expect(notify).toHaveBeenCalledWith({ type: 'service_event', payload: { kind: 'linkDown' } })
    expect(port.stop()).toBeUndefined()
  })
})
