/**
 * A window here watching a harness someone shared with this account, through the gateway (step 10, R3).
 * The Share relay (sharing/relay.ts) holds its own socket to the backend, signed in with the account's
 * token, so it runs where the relay's sockets run: here, not in the core. What a window is told when it
 * cannot watch is what the local socket told it when the Share relay ran in the core: 4403 for a share
 * that ended or was never there, so the app stops trying; 1013 for one out of reach just now.
 */
import type { WindowRelay } from '../core/api.js'
import { RelayConnectError } from '../lib/relayFrames.js'
import { SharingEndedError, type HarnessShareRelay } from '../sharing/relay.js'

/** The close for a share that ended, and for one that could not be reached. */
export const SHARE_ENDED = 4403
export const SHARE_UNREACHABLE = 1013

export function shareWindows(relay: Pick<HarnessShareRelay, 'acquire'>): NonNullable<WindowRelay['acquireShare']> {
  return async (machineId, shareId, sink, onClosed) => {
    try {
      return await relay.acquire(machineId, shareId, sink, onClosed)
    } catch (error) {
      throw new RelayConnectError(error instanceof Error ? error.message : 'Sharing unavailable',
        error instanceof SharingEndedError ? SHARE_ENDED : SHARE_UNREACHABLE)
    }
  }
}
