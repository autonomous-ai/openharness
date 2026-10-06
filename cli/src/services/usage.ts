/**
 * This machine's Claude and Codex rate limits, read with its own credentials (`usage_read`). The desktop
 * reads the account on the computer it runs on directly; this is how it reads one on a machine it does
 * not, which may be signed in to a different subscription entirely. The vendor's answer goes back as it
 * came: lib/accountUsage.ts says why the parsing stays on the client. The core never calls it, so it has
 * no port.
 *
 * Moved out of the socket's request switch as it was (docs/design/2026-10-06-core-boundary-next.md,
 * step 4).
 */
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { readAccountUsage, type AccountUsageReading } from '../lib/accountUsage.js'
import { internalOnThrow } from './requestErrors.js'

/** The request usage answers for the apps. */
export const USAGE_REQUESTS = ['usage_read'] as const

export interface UsageDeps {
  /** The vendors' answers. Injected so a spec reads no real home, Keychain or network. */
  read: () => Promise<AccountUsageReading[]>
}

export function startUsage(_core: CoreApi, deps: UsageDeps = { read: readAccountUsage }): ServiceRequests {
  return {
    // Two vendor round trips (up to 8s each, lib/accountUsage.ts). Answered when they settle, never in the
    // connection's line: it is asked on connect beside the requests the terminal needs, and with no
    // network it held them past the app's timeout while it was the socket's.
    usage_read: internalOnThrow('usage_read', () => deps.read().then(
      (providers) => ({ providers }),
      () => ({ error: 'USAGE_READ_FAILED' }),
    )),
  }
}
