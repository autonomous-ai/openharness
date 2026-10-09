/** Package files and scripts run in the Store. Core never loads this implementation to launch a session. */
import type { StorePort } from '../core/api.js'
import { installedDsh as lookup } from '../dsh/installed.js'
import { materializeWorkspace } from '../dsh/materialize.js'
import { forkRuntimeKey, prepareHarnessLaunch } from '../dsh/runtime.js'

const detail = (error: unknown) => error instanceof Error ? error.message : String(error)

export function storeLaunchPort(installedDsh: typeof lookup = lookup): StorePort {
  const missing = (id: string) => ({ ok: false as const, error: 'DSH_NOT_INSTALLED', detail: `${id} is not installed on this machine` })
  return {
    async dshMaterialize({ dsh, workspace, engine, account }) {
      const installed = installedDsh(dsh)
      if (!installed) return missing(dsh)
      try {
        return { ok: true, ...await materializeWorkspace(installed, workspace, account, engine) }
      } catch (error) {
        return { ok: false, error: 'DSH_MATERIALIZE_FAILED', detail: detail(error) }
      }
    },
    async dshLaunch({ dsh, workspace, engine, key, account, forkOf }) {
      const installed = installedDsh(dsh)
      if (!installed) return missing(dsh)
      try {
        const sourceKey = forkOf ? forkRuntimeKey({ cwd: workspace, ...forkOf }) : null
        return { ok: true, launch: prepareHarnessLaunch(installed, workspace, engine, key, account, sourceKey) }
      } catch (error) {
        return { ok: false, error: 'DSH_RUNTIME_FAILED', detail: detail(error), thrown: String(error) }
      }
    },
  }
}
