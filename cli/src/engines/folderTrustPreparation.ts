/** Core keeps eligibility and file publication; setup owns the optional trust/MCP interpretation. */
import { realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launchHomeOf } from '../lib/engineHomes.js'
import { launchContract } from './launches.js'
import type { AgentEngine } from './types.js'
import { NativeFiles } from './kit/nativeFiles.js'
import { homeIsAbsolute, homeIsNetworkOrDevice } from './kit/homeAdoption.js'
import { publishNativeFiles } from './kit/nativeHookPublication.js'
import { hookFileVersion } from './kit/nativeHookFiles.js'
import type { NativeSetup } from './kit/nativeSetup.js'
import { boundedTrustInput, trustDestinations, type NativeTrustInput } from './kit/nativeTrustWire.js'

export type PrepareFolderTrust = (input: {
  engine: AgentEngine; cwd: string; profile?: string | null; environment?: NodeJS.ProcessEnv
} & (
  /** Only callers that already hold the empty-project decision may ask for this. */
  { empty: true; source?: never }
  /** A core-approved Harness worktree may inherit this source's existing native trust. */
  | { source: string; empty?: never }
), current: () => boolean) => Promise<boolean>

export function createFolderTrustPreparation(setup: Pick<NativeSetup, 'prepareTrust'>): PrepareFolderTrust {
  return async (input, current) => {
    const contract = launchContract(input.engine), trust = contract?.trust
    if (!contract || !trust || input.engine !== 'claude' && input.engine !== 'codex') return false
    if ((input.empty === true) === (typeof input.source === 'string')) return false
    if (!setup.prepareTrust) { console.warn('[trust] FOLDER_TRUST_UNAVAILABLE'); return false }
    try {
      const home = launchHomeOf(trust.home, input.profile, input.environment)
      const userHome = contract.inheritedMcp ? launchHomeOf(contract.inheritedMcp.user.home, input.profile, input.environment) : undefined
      if ([home, input.cwd, ...(input.source ? [input.source] : []), ...(userHome ? [userHome] : [])]
        .some(path => Buffer.byteLength(path) > 4096 || path.includes('\0') || !homeIsAbsolute(path) || homeIsNetworkOrDevice(path))) return false
      const identity = (path: string) => {
        const info = statSync(path)
        if (!info.isDirectory()) throw Error('Workspace unavailable')
        return `${info.dev}:${info.ino}:${realpathSync(path)}`
      }
      const workspace = identity(input.cwd), source = input.source ? identity(input.source) : undefined
      // Retain metadata for the interpretation's fixed read dependencies. A worker reply
      // cannot grant inherited trust after a new repository boundary or user decision appeared.
      const evidence = new NativeFiles()
      if (input.source && trust.format === 'json') {
        for (let above = input.source, depth = 0; ; above = dirname(above), depth++) {
          if (depth >= 64) return false
          if (evidence.locate(join(above, trust.repositoryBoundary), true) || dirname(above) === above) break
        }
      }
      const userSettings = contract.inheritedMcp ? evidence.locate(join(userHome!, contract.inheritedMcp.user.file), true) : null
      const userVersion = userSettings ? hookFileVersion(userSettings.info) : undefined
      const verifyEvidence = evidence.paths.retain()
      const empty = new NativeFiles()
      if (input.empty && empty.entries(input.cwd).length !== 0) return false
      let trustPublished = false
      const active = () => {
        try {
          if (!current() || identity(input.cwd) !== workspace || input.source && identity(input.source) !== source) return false
          verifyEvidence()
          if (userSettings && hookFileVersion(statSync(userSettings.path, { bigint: true })) !== userVersion) return false
          verifyEvidence()
          // The following MCP publication may create .claude itself. Until trust has actually
          // published, any change to the empty workspace still revokes this operation.
          if (input.empty && !trustPublished) empty.verify()
          return true
        } catch { return false }
      }
      const selected: Omit<NativeTrustInput, 'files'> = { engine: input.engine, cwd: input.cwd, home,
        ...(userHome ? { userHome } : {}),
        ...(input.source ? { source: input.source } : {}),
      }
      const confirmed = await publishNativeFiles(trustDestinations(selected).map(file => ({ file, mode: 0o600 })),
        async (files, request, latest) => {
          const captured = { ...selected, files }
          return boundedTrustInput(captured) ? setup.prepareTrust!(captured, request, latest) : null
        }, { current: active, timeoutMs: 5000, retainConflicts: true, published: index => { if (index === 0) trustPublished = true } })
      if (!confirmed) console.warn('[trust] FOLDER_TRUST_UNAVAILABLE')
      return confirmed
    } catch { console.warn('[trust] FOLDER_TRUST_UNAVAILABLE'); return false }
  }
}
