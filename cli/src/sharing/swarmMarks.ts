/**
 * The Swarm's marks on Share that hold whether the Swarm is on or not (`HARNESS_SWARM`, harnessd/services.ts): which
 * grants are a Super Tab's, and which sessions its rosters marked confidential (a Lead, or in a private chat). The Swarm
 * writes them (superTabs/observers.ts); Share reads them here, without loading the Swarm's code.
 *
 * With the Swarm off, Share runs on `withoutSwarm`: no Super Tab roster is in force, so its observers watch nothing
 * (their invitations are kept, as for a host that stalled, and viewing is withheld), and a confidential session keeps
 * refusing every share, ordinary ones too. Turning the Swarm off must not reopen what a roster closed (final review of
 * the observers, Critical 1): that mark is the one piece of the Swarm's saved state still read while it is off.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessGrant } from './grants.js'

const PREFIX = 'super:'
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v)

/** The Super Tab a grant is for, or null for an ordinary share. */
export function superTabOf(grant: Pick<HarnessGrant, 'tab'>): string | null {
  return grant.tab?.startsWith(PREFIX) ? grant.tab.slice(PREFIX.length) : null
}

/** Where the Swarm keeps what the last roster wants watched, and the sessions marked confidential. */
export function observerSnapshotFile(dataDir: string, machineId: string): string {
  return join(dataDir, 'super-tabs', `observers-${machineId}.json`)
}

/** The sessions the last snapshot recorded as confidential (a Lead, or in a private chat, in some Swarm). */
export function savedConfidential(file: string, machineId: string): string[] {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return []
    const { machineId: owner, confidential } = saved as { machineId?: unknown; confidential?: unknown }
    return owner === machineId && Array.isArray(confidential) ? confidential.filter(identifier) : []
  } catch { return [] }
}

/** Share's observers with the Swarm off (services/sharing.ts): none of a Super Tab's, and no confidential session's. */
export function withoutSwarm(dataDir: string, machine: () => string) {
  return {
    known: (): null => null,
    allows: (grant: HarnessGrant): boolean => !superTabOf(grant)
      && !savedConfidential(observerSnapshotFile(dataDir, machine()), machine()).includes(grant.agentId),
    /** The Swarm off is no restart: no roster is coming, so a refused viewer is not told to retry. */
    paused: (_grant: HarnessGrant): boolean => false,
  }
}
