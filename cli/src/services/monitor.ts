/**
 * The machine monitor: this machine's CPU and memory, each agent's processes and what its workspace and
 * transcript hold (`machine_resources`), and the same readings for the rows `agents_list` draws when a
 * window asks for the monitor, which the core reads through `ports.monitor`. Sampling spawns `ps`, `du`
 * and `ioreg`, so it is answered when it settles, never in the connection's line.
 *
 * Moved out of the socket's request switch as it was (docs/design/2026-10-06-core-boundary-next.md,
 * step 4): one sample and one cache for both, as when the socket held the readers.
 */
import type { CoreApi, CorePorts, ServiceRequests } from '../core/api.js'
import { createHarnessResourcesReader } from '../lib/harnessResources.js'
import { createHarnessStorageReader } from '../lib/harnessTelemetry.js'
import { readMachineResources } from '../lib/machineResources.js'
import { internalOnThrow } from './requestErrors.js'

/** The request the monitor answers for the apps. */
export const MONITOR_REQUESTS = ['machine_resources'] as const

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
