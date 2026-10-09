import { join } from 'node:path'
import { createAgentUsage } from './agentUsage.js'
import type { CorePorts } from '../core/api.js'
/**
 * This machine's Claude and Codex rate limits, read with its own credentials (`usage_read`): how the
 * desktop reads an account on a machine it does not run on, which may be signed in to another
 * subscription. The vendors' answers go back as they came (lib/accountUsage.ts says why). Moved out of
 * the socket's switch as it was (docs/design/2026-10-06-core-boundary-next.md, step 4).
 */
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { readAccountUsage, type AccountUsageReading } from '../lib/accountUsage.js'
import { internalOnThrow } from './requestErrors.js'

/** The request usage answers for the apps, declared in core/api.ts for the core to route. */
export { USAGE_REQUESTS } from '../core/api.js'

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

/** Explicit inline compatibility uses the same port and validators as the worker. */
export function startUsageInCore(core: CoreApi, ports: CorePorts): ServiceRequests {
  const reader = createAgentUsage(join(core.dataDir, 'agent-token-usage'))
  ports.usage = { read: target => reader.read({ target }), stop: reader.stop }
  return startUsage(core)
}
