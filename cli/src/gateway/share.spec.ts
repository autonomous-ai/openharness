/**
 * The Share relay through the gateway: a window that cannot watch a shared harness is told why in the
 * words and the close the local socket gave it when the Share relay ran in the core (sharing/relay.ts's
 * errors, mapped where the relay now runs). Each case fails if the mapping was lost in the move.
 */
import { describe, expect, it, vi } from 'vitest'
import { RelayConnectError } from '../lib/relayFrames.js'
import { SharingEndedError } from '../sharing/relay.js'
import { SHARE_ENDED, SHARE_UNREACHABLE, shareWindows } from './share.js'

const sink = { sendFrame: () => true, sendBinary: () => true }

describe('a window watching a shared harness, through the gateway', () => {
  it('watches through the Share relay, with the window\'s own sink and close', async () => {
    const session = { send: vi.fn(async () => {}), sendBinary: vi.fn(async () => {}), detach: vi.fn() }
    const acquire = vi.fn(async () => session)
    const onClosed = vi.fn()
    expect(await shareWindows({ acquire })('owner-machine', 'share-1', sink, onClosed)).toBe(session)
    expect(acquire).toHaveBeenCalledWith('owner-machine', 'share-1', sink, onClosed)
  })

  it('is told 4403 for a share that ended, so it stops trying, and 1013 for one out of reach just now', async () => {
    const failing = (error: unknown) => shareWindows({ acquire: async () => { throw error } })('m', 's', sink, () => {})
    const ended = await failing(new SharingEndedError('Sharing ended or invitation expired')).catch((error: unknown) => error)
    expect(ended).toBeInstanceOf(RelayConnectError)
    expect(ended).toMatchObject({ message: 'Sharing ended or invitation expired', closeCode: SHARE_ENDED })
    expect(SHARE_ENDED).toBe(4403)
    expect(await failing(new Error('The owner’s machine is offline.')).catch((error: unknown) => error))
      .toMatchObject({ message: 'The owner’s machine is offline.', closeCode: SHARE_UNREACHABLE })
    expect(SHARE_UNREACHABLE).toBe(1013)
    expect(await failing('down').catch((error: unknown) => error)).toMatchObject({ message: 'Sharing unavailable', closeCode: 1013 })
  })
})
