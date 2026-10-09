/** Package files and scripts run in the Store. Core never loads this implementation to launch a session. */
import type { StorePort } from '../core/api.js'
import { join } from 'node:path'
import { dshRootDir, installedDsh as lookup } from '../dsh/installed.js'
import { materializeWorkspace } from '../dsh/materialize.js'
import { forkRuntimeKey, prepareHarnessLaunch } from '../dsh/runtime.js'
import { dshPreparations, type PrepareDsh } from '../dsh/preparation.js'
import { prepareInstructionWrites } from '../scm/scmProjects.js'

const detail = (error: unknown) => error instanceof Error ? error.message : String(error)

export function storeLaunchPort(installedDsh: typeof lookup = lookup,
  prepare: PrepareDsh = dshPreparations(join(dshRootDir(), '.preparations'))): StorePort {
  const missing = (id: string) => ({ ok: false as const, error: 'DSH_NOT_INSTALLED', detail: `${id} is not installed on this machine` })
  return {
    async dshMaterialize(request) {
      const { dsh, workspace, engine, account } = request
      const installed = installedDsh(dsh)
      if (!installed) return missing(dsh)
      try {
        return await prepare(workspace, { kind: 'materialize', ...request, package: installed }, async () => {
          try {
            // Admission to the durable preparation precedes SCM edits too. Core must not open
            // tracked instruction files for writing while this service is unavailable.
            await prepareInstructionWrites(workspace)
            const { created, kept, warnings } = await materializeWorkspace(installed, workspace, account, engine)
            return { ok: true as const, created, kept, warnings }
          }
          catch (error) { return { ok: false as const, error: 'DSH_MATERIALIZE_FAILED', detail: detail(error) } }
        }, true)
      } catch (error) {
        return { ok: false, error: 'DSH_UNAVAILABLE', unavailable: 'store', holdScope: 'workspace', detail: detail(error) }
      }
    },
    async dshLaunch(request) {
      const { dsh, workspace, engine, key, account, forkOf } = request
      const installed = installedDsh(dsh)
      if (!installed) return missing(dsh)
      try {
        return await prepare(workspace, { kind: 'launch', ...request, package: installed }, async () => {
          try {
            // Admission to the durable preparation precedes SCM edits too. Core must not open
            // tracked instruction files for writing while this service is unavailable.
            await prepareInstructionWrites(workspace)
            const sourceKey = forkOf ? forkRuntimeKey({ cwd: workspace, ...forkOf }) : null
            return { ok: true as const, launch: prepareHarnessLaunch(installed, workspace, engine, key, account, sourceKey) }
          } catch (error) { return { ok: false as const, error: 'DSH_RUNTIME_FAILED', detail: detail(error), thrown: String(error) } }
        })
      } catch (error) {
        return { ok: false, error: 'DSH_UNAVAILABLE', unavailable: 'store', holdScope: 'workspace', detail: detail(error) }
      }
    },
  }
}
