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
import { readAccountUsage, type AccountUsageDeps, type AccountUsageReading } from '../lib/accountUsage.js'
import { profileHome } from '../lib/claudeProfiles.js'
import { internalOnThrow } from './requestErrors.js'

/** The request usage answers for the apps, declared in core/api.ts for the core to route. */
export { USAGE_REQUESTS } from '../core/api.js'

export interface UsageDeps {
  /** The vendors' answers. Injected so a spec reads no real home, Keychain or network. */
  read: (profile?: Pick<AccountUsageDeps, 'claudeHome' | 'codexHome' | 'only'>) => Promise<AccountUsageReading[]>
}

/** The reader's arguments for one profile the machine knows (by the shared id rule, lib/claudeProfiles.ts profileHome), or null. */
function readerOf(core: CoreApi, engine: unknown, id: unknown): Pick<AccountUsageDeps, 'claudeHome' | 'codexHome' | 'only'> | null {
  if (typeof id !== 'string' || (engine !== 'claude' && engine !== 'codex')) return null
  const home = profileHome(engine, id, core.daemon.machineId())
  if (home === null) return null
  return home === 'default' ? { only: engine } : engine === 'claude' ? { claudeHome: home } : { codexHome: home }
}

export function startUsage(core: CoreApi, deps: UsageDeps = { read: readAccountUsage }): ServiceRequests {
  return {
    // Two vendor round trips (up to 8s each, lib/accountUsage.ts). Answered when they settle, never in the
    // connection's line: it is asked on connect beside the requests the terminal needs, and with no
    // network it held them past the app's timeout while it was the socket's.
    // With a profile it answers for that one account only, and only to the machine's owner: the
    // default reading is already open to guests, a second account's is not.
    usage_read: internalOnThrow('usage_read', (payload, asker) => {
      const wanted = (payload as { profile?: { engine?: unknown; id?: unknown } } | undefined)?.profile
      let home: Pick<AccountUsageDeps, 'claudeHome' | 'codexHome' | 'only'> | undefined
      if (wanted) {
        if (!asker.owner) return { error: 'OWNER_REQUIRED' }
        const found = readerOf(core, wanted.engine, wanted.id)
        if (!found) return { error: 'PROFILE_UNKNOWN' }
        home = found
      }
      return deps.read(home).then(
        (providers) => ({ providers }),
        () => ({ error: 'USAGE_READ_FAILED' }),
      )
    }),
  }
}

/** Explicit inline compatibility uses the same port and validators as the worker. */
export function startUsageInCore(core: CoreApi, ports: CorePorts): ServiceRequests {
  const reader = createAgentUsage(join(core.dataDir, 'agent-token-usage'))
  ports.usage = { read: target => reader.read({ target }), stop: reader.stop }
  return startUsage(core)
}
