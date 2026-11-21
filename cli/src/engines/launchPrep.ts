/**
 * Folder trust before launch, from the engine's declared contract. History repair is prepared in the supervised
 * worker; its explicit inline/older-master implementation lives in resumePreparation.ts, outside core's closure.
 */
import { join } from 'node:path'
import { launchHomeOf } from '../lib/engineHomes.js'
import { hashOf } from '../lib/log.js'
import { homeIsNetworkOrDevice } from './kit/homeAdoption.js'
import { recordTrustIn, trustsIn } from './kit/folderTrust.js'
import { recordInheritedMcp } from './kit/inheritedMcp.js'
import { launchContract } from './launches.js'
import type { AgentEngine } from './types.js'

/** An engine's answer to "do you trust this folder?", read and recorded where the engine keeps it. */
export interface FolderTrust {
  /** Whether the engine already trusts `path`. */
  trusts(path: string): boolean
  /** Record trust in `path`: never removes anything, and leaves a file it cannot safely extend alone. */
  record(path: string): 'trusted' | 'already' | 'skipped'
}

/**
 * The folder trust of `engine` launched now, in `profile` (an agent's own engine home) where its home takes
 * one; null for an engine that asks no such question. The home is found at each call, as the person's shell
 * may have moved it since.
 */
export function folderTrust(engine: AgentEngine, profile?: string | null, environment?: NodeJS.ProcessEnv): FolderTrust | null {
  const contract = launchContract(engine)
  const trust = contract?.trust
  if (!trust) return null
  const home = (): string => launchHomeOf(trust.home, profile, environment)
  const file = (): string => join(home(), trust.file)
  // Windows: a network or device home counts as no trust file. Opening it could start an outbound connection.
  const network = (): boolean => homeIsNetworkOrDevice(home())
  return {
    trusts: (path) => !network() && trustsIn(trust, file(), path),
    record: (path) => {
      if (network()) return 'skipped'
      const recorded = recordTrustIn(trust, file(), path)
      // The folder's other question, asked as the engine starts there: the MCP servers it inherits from above. A folder
      // Harness trusts for its agent is one whose questions are Harness's, so it is answered here too, by its default.
      const mcp = contract.inheritedMcp
      if (mcp) {
        try {
          const settled = recordInheritedMcp(mcp, path, launchHomeOf(mcp.user.home, profile, environment))
          if (settled.length) console.log(`[launch] ${engine}: continues without the MCP servers ${settled.join(', ')} it found above ${hashOf(path)}, as its question does by default`)
        } catch { /* the engine asks, as before */ }
      }
      return recorded
    },
  }
}

/** What `prepareResume` repairs in `engine`'s history, in the daemon's log's words. */
export function repairedItemsName(engine: string): string {
  return launchContract(engine)?.resumeRepair?.names.items ?? 'items'
}
