/** Local launch writes belong to one binding and lifecycle revision, never just to a pane id. */
import type { RegisteredSession } from '../../lib/registry.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'

const identity = (row: RegisteredSession | undefined) => row && JSON.stringify([
  row.registeredAt, row.boundAt, row.sessionId, row.engine, row.cwd, row.processIdentity,
  row.codexHome, row.dsh, row.dshRuntime, row.agent, row.gridLaunch, row.scmLaunch,
  row.subscriptionModel, row.permissionMode, row.bypassPermission, row.active,
  row.runtimes.map(terminalRouteKey).sort(), row.launch, row.externalResume,
])

export function createLaunchAuthority(deps: {
  byAgent(id: string): RegisteredSession | undefined
  revision(id: string): number
  cancelled(id: string): boolean
}) {
  return (id: string): (() => boolean) => {
    // The requested launch may be a stopped row or a projected terminal fallback. Its owner's
    // predicate grants that operation; this extra fence watches the live table as dispatch found it.
    const target = identity(deps.byAgent(id)), revision = deps.revision(id)
    return () => !deps.cancelled(id) && deps.revision(id) === revision && identity(deps.byAgent(id)) === target
  }
}
