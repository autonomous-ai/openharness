/**
 * The Store's part of a launch (`StorePort`, core/api.ts): a harness package's workspace laid out at create, and each
 * session's runtime prepared, at create, at every relaunch and for a fork (docs/design/2026-10-08-launch-port.md,
 * (L3)). The packages are the Store's, so the code that reads and runs them is too: a launch in the core asks here,
 * in this process or beside the viewers in theirs (services/storeProcess.ts).
 *
 * Every failure is an answer, never a throw: a runtime that cannot be prepared fails the one launch that asked.
 */
import type { StorePort } from '../core/api.js'
import { installedDsh as installedDshNow } from '../dsh/installed.js'
import { materializeWorkspace } from '../dsh/materialize.js'
import { forkRuntimeKey, prepareHarnessLaunch } from '../dsh/runtime.js'

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function storeLaunchPort(installedDsh: typeof installedDshNow = installedDshNow): StorePort {
  const notInstalled = (dsh: string) => ({ ok: false as const, error: 'DSH_NOT_INSTALLED', detail: `${dsh} is not installed on this machine` })
  return {
    async dshMaterialize({ dsh, workspace, engine, account }) {
      const installed = installedDsh(dsh)
      if (!installed) return notInstalled(dsh)
      try {
        const { created, kept, warnings } = await materializeWorkspace(installed, workspace, account, engine)
        return { ok: true, created, kept, warnings }
      } catch (error) {
        return { ok: false, error: 'DSH_MATERIALIZE_FAILED', detail: message(error) }
      }
    },
    async dshLaunch({ dsh, workspace, engine, key, account, forkOf }) {
      const installed = installedDsh(dsh)
      if (!installed) return notInstalled(dsh)
      try {
        // A fork copies its source's saved runtime: the one its row names, else one made before rows named it.
        const sourceKey = forkOf ? forkRuntimeKey({ cwd: workspace, ...forkOf }) : null
        return { ok: true, launch: prepareHarnessLaunch(installed, workspace, engine, key, account, sourceKey) }
      } catch (error) {
        // `detail` as a create or a fork says it; `thrown` as a relaunch always did (launchOverrides.ts).
        return { ok: false, error: 'DSH_RUNTIME_FAILED', detail: message(error), thrown: String(error) }
      }
    },
  }
}
