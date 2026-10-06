/**
 * The machine monitor: this machine's totals, each agent's processes and what its workspace and transcript
 * hold (`machine_resources`), and the same readers for `agents_list`'s rows through `ports.monitor`: one
 * sample and one cache for both, as when the socket held them. Moved out of the socket's switch as it was
 * (docs/design/2026-10-06-core-boundary-next.md, step 4).
 */
import type { CoreApi, CorePorts, ServiceRequests } from '../core/api.js'
import { createHarnessResourcesReader } from '../lib/harnessResources.js'
import { createHarnessStorageReader } from '../lib/harnessTelemetry.js'
import { readMachineResources } from '../lib/machineResources.js'
import { internalOnThrow } from './requestErrors.js'

/** The request the monitor answers for the apps, declared in core/api.ts for the core to route. */
export { MONITOR_REQUESTS } from '../core/api.js'

export interface MonitorDeps {
  /** The machine's own totals. */
  machine: () => ReturnType<typeof readMachineResources>
  /** Each live agent's processes. */
  resources: ReturnType<typeof createHarnessResourcesReader>
  /** What each agent's workspace and transcript hold. */
  storage: ReturnType<typeof createHarnessStorageReader>
}

export function startMonitor(core: CoreApi, ports: CorePorts, deps: MonitorDeps = {
  machine: readMachineResources,
  resources: createHarnessResourcesReader(() => core.agents.advertised()),
  storage: createHarnessStorageReader(),
}): ServiceRequests {
  ports.monitor = { resources: () => deps.resources(), storage: (agents, invalidate) => deps.storage(agents, invalidate) }
  return {
    // Sampling CPU must not hold up typing or other machine requests.
    machine_resources: internalOnThrow('machine_resources', (payload) => (payload.harnesses === true
      ? deps.resources().then(async (harnesses) => {
        if (payload.storage !== true) return { harnesses }
        const storage = await deps.storage(core.agents.advertised())
        return { harnesses: { ...harnesses, agents: harnesses.agents.map((row) => ({ ...row, ...storage.get(row.agentId) })) } }
      })
      : deps.machine())
      .then((resources) => ({ ...resources }), () => ({ error: 'UNAVAILABLE' }))),
  }
}
