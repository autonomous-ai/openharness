/**
 * Add-ons for a device that is this Harness machine (lib/autonomous-device/machineAddons.ts, openharness#1654): the
 * device's own service over this machine's loopback routes, and the owner's machines over the machine link, both
 * through the one `machine_addon` request. In the edge host, or in the core's process with the services there.
 */
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { MachineAddons } from '../lib/autonomous-device/machineAddons.js'

export { MACHINE_ADDON_REQUESTS } from '../core/api.js'

export function startMachineAddons(core: CoreApi): ServiceRequests {
  return new MachineAddons({ machineId: () => core.daemon.machineId() }).requests()
}
