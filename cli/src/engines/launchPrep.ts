/**
 * What a launch prepares in the person's files before the engine starts: the folder trust an engine asks
 * about, and a conversation's history made resumable. Composed from each engine's launch contract (data,
 * engines/{claude,codex}/launch.ts) and the kit's mechanics (kit/folderTrust.ts, kit/resumeRepair.ts), so the
 * launch paths (core/agents/create.ts, launches.ts, launch.ts) name no engine. Both run in core, in line: a
 * launch is session control and waits on no engine worker (docs/design/2026-10-08-engine-launch.md).
 */
import { join } from 'node:path'
import { homeRoots, launchHomeOf } from '../lib/engineHomes.js'
import { homeIsNetworkOrDevice } from './kit/homeAdoption.js'
import { recordAcceptanceIn, recordTrustIn, trustsIn } from './kit/folderTrust.js'
import { recordInheritedMcp } from './kit/inheritedMcp.js'
import { repairHistory } from './kit/resumeRepair.js'
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
          if (settled.length) console.log(`[launch] ${engine}: continues without the MCP servers ${settled.join(', ')} it found above ${path}, as its question does by default`)
        } catch { /* the engine asks, as before */ }
      }
      return recorded
    },
  }
}

/** Record that full mode's one-time warning is accepted in `engine`'s settings, as its "Yes" would (`bypassAcceptance`); null
 *  for an engine with no such warning. A network or device home is never opened, as for trust. */
export function acceptFullMode(engine: AgentEngine, environment?: NodeJS.ProcessEnv): 'accepted' | 'already' | 'skipped' | null {
  const contract = launchContract(engine)?.bypassAcceptance
  if (!contract) return null
  const home = launchHomeOf(contract.home, null, environment)
  return homeIsNetworkOrDevice(home) ? 'skipped' : recordAcceptanceIn(join(home, contract.file), contract.key)
}

/** The session a resume relaunches. `codexHome` is the agent's own engine home, the row's profile. */
export interface ResumeSource {
  engine: string
  sessionId: string
  transcriptPath?: string | null
  codexHome?: string | null
}

/**
 * Make a stopped conversation's history resumable, before the engine is launched on it. `repairedBytes`,
 * set only when something was repaired, is the history's new length: a tail of that file moves there.
 */
export function prepareResume(source: ResumeSource): { repairedItems: number; repairedBytes?: number; backupPath?: string } {
  const contract = launchContract(source.engine)?.resumeRepair
  if (!contract || !source.sessionId) return { repairedItems: 0 }
  // The agent's own profile, else every home the person moved too (lib/engineHomes.ts): a rollout in a moved
  // CODEX_HOME was refused as outside the profile, so a restart or reopen failed after Codex had stopped.
  const { home, folder } = contract.sessions
  const roots = (source.codexHome ? [source.codexHome] : homeRoots(home.setting)).map((root) => join(root, folder))
  return repairHistory(contract, source.sessionId, source.transcriptPath, roots)
}

/** What `prepareResume` repairs in `engine`'s history, in the daemon's log's words. */
export function repairedItemsName(engine: string): string {
  return launchContract(engine)?.resumeRepair?.names.items ?? 'items'
}
