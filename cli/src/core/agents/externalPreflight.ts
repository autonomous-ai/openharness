/** Verify a resumable launch before asking an external terminal to quit. */
import { engineHooks } from '../../engines/hooks.js'
import { buildEngineCommandArgv, refusePermissionFlagIfUnsupported } from '../../lib/engineLaunch.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import type { ExternalResumeDeps } from './externalResume.js'

export function createExternalPreflight(deps: {
  blocksFolder(cwd: string): boolean | undefined
  hooksDisabled: boolean
  hookPort: number
  installOpencodePlugin(port: number): Promise<boolean>
}): ExternalResumeDeps['preflight'] {
  return async (row, session) => {
    const missing = workspaceMissing(session.cwd)
    if (missing) return missing
    if (deps.blocksFolder(session.cwd)) return { detail: 'Waiting for the workspace operation to finish.' }
    const refused = await refusePermissionFlagIfUnsupported(row.engine, row)
    if (refused) return refused
    if (row.engine === 'opencode' && !deps.hooksDisabled && !await deps.installOpencodePlugin(deps.hookPort)) {
      return { detail: 'Waiting for OpenCode’s launch support to become available.' }
    }
    if (row.codexHome && !deps.hooksDisabled) engineHooks.codex.installIn(deps.hookPort, row.codexHome)
    buildEngineCommandArgv(row.engine, { cwd: session.cwd, resumeSessionId: session.sessionId,
      bypassPermission: row.bypassPermission, permissionMode: row.permissionMode, extraArgs: session.launchArgs })
    return null
  }
}
