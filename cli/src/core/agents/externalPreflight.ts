/** Verify a resumable launch before asking an external terminal to quit. */
import { engineHooks } from '../../engines/hooks.js'
import { buildEngineCommandArgv, refusePermissionFlagIfUnsupported } from '../../lib/engineLaunch.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import type { ExternalResumeDeps } from './externalResume.js'
import type { LaunchOverridesDeps } from '../../lib/launchOverrides.js'

export function createExternalPreflight(deps: {
  native?: LaunchOverridesDeps['native']
  blocksFolder(cwd: string): boolean | undefined
  hooksDisabled: boolean
  hookPort: number
  installOpencodePlugin(port: number): Promise<boolean>
}): ExternalResumeDeps['preflight'] {
  return async (row, session, owner = () => true) => {
    const missing = workspaceMissing(session.cwd)
    if (missing) return missing
    if (deps.blocksFolder(session.cwd)) return { detail: 'Waiting for the workspace operation to finish.' }
    const changed = { detail: 'Waiting for the original external-resume request’s authority.' }
    if (!owner()) return changed
    const inspected = await deps.native?.(row.engine, row, { id: row.agentId, current: owner })
    if (!owner()) return changed
    if (inspected && !inspected.ok) return inspected
    const native = inspected?.ok ? inspected.launch : undefined
    const current = () => owner() && native?.current() !== false
    const refused = await refusePermissionFlagIfUnsupported(row.engine, row, undefined, native)
    if (!current()) return changed
    if (refused) return refused
    if (native && !await native.prepareHooks(deps.hooksDisabled ? 0 : deps.hookPort, owner)) return { detail: 'Waiting to confirm the external conversation’s native hooks.' }
    if (!native && row.engine === 'opencode' && !deps.hooksDisabled && !await deps.installOpencodePlugin(deps.hookPort)) {
      return { detail: 'Waiting for OpenCode’s launch support to become available.' }
    }
    if (!native && row.codexHome && !deps.hooksDisabled && !await engineHooks.codex.installIn(deps.hookPort, row.codexHome)) {
      return { detail: 'Waiting to confirm Codex’s hooks in the selected profile.' }
    }
    if (!current()) return changed
    buildEngineCommandArgv(row.engine, { ...(native ? { native } : {}), cwd: session.cwd, resumeSessionId: session.sessionId,
      bypassPermission: row.bypassPermission, permissionMode: row.permissionMode, extraArgs: session.launchArgs })
    return native ? { current } : null
  }
}
