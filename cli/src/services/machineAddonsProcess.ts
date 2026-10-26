/**
 * Add-ons for a device that is this machine, in their own process (`harness __service machineAddons`, in the devices'
 * process): the same handler as in the core's process (services/machineAddons.ts). It asks the core only where this
 * daemon runs (`daemon`), for this machine's account id; what it holds is RAM, bounded as v1's add-ons are.
 */
import type { DaemonAddress } from '../core/api.js'
import { startMachineAddons } from './machineAddons.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { daemonIn, processCoreApi } from './processCoreApi.js'

export interface MachineAddonsServiceOptions {
  dataDir: string
  socketPath: string
  /** The computer's id, which the owner's other machines don't know this machine by: never the device's name. */
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
}

export function runMachineAddonsService(options: MachineAddonsServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  let daemon: DaemonAddress | null = null
  let reading: Promise<void> | null = null
  // The account's machine id, as the core says it: asked once a core connects, and again by a request before then.
  const known = (): Promise<void> => {
    if (daemon?.machineId()) return Promise.resolve()
    const connection = core
    if (!connection) return Promise.reject(new Error('Core disconnected'))
    return reading ??= connection.query('daemon', {}).then((address) => {
      if (core === connection) daemon = daemonIn(address)
    }).finally(() => { reading = null })
  }
  const requests = startMachineAddons(processCoreApi(options.dataDir, 'machineAddons', { daemon: () => daemon }))
  return (options.run ?? runServiceProcess)({
    name: 'machineAddons',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: {
      machine_addon: async (payload, asker, closed) => {
        await known().catch(() => {})
        // Never as `''`: a device named nothing would take no proposal and be listed as no machine.
        if (!daemon?.machineId()) return { error: { code: 'UNAVAILABLE', message: 'This machine\'s id is not known yet. Try again in a moment.' } }
        return requests.machine_addon!(payload, asker, closed)
      },
    },
    onConnected: (connection) => { core = connection; void known().catch(() => {}) },
    onDisconnected: () => { core = null },
  })
}
