/**
 * The Harness Store in its own process (`harness __service store`), beside the viewers in theirs
 * (harnessd/services.ts `SERVICE_HOSTS`): the same requests as in the core's process (services/store.ts).
 * A clone, a toolchain's setup and its doctor take minutes and run their own processes: here they cost
 * the viewers' process at most, never the core. Installs are
 * locked across processes (dsh/lock.ts), so one the Wi-Fi device starts from the core's never runs beside
 * one started here.
 *
 * It tells the core two things (core/storeLink.ts):
 * - how an install or update is going (`installStatus`), which the core pushes to the apps as
 *   `dsh_install_status`; one said while the core is away is lost, as a line of progress may be;
 * - that what is installed changed (`installed`), before it answers the request that changed it: the
 *   core keeps the installed index for two seconds (dsh/installed.ts), and the create that follows an
 *   install must find what was just installed.
 */
import type { CoreApi, ServiceRequest, ServiceRequests } from '../core/api.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'
import { startStore } from './store.js'

export interface StoreServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for a Store that clones and installs nothing. */
  start?: (core: CoreApi) => ServiceRequests
}

/** The requests that change what is installed here. */
const CHANGES = ['dsh_install', 'dsh_update', 'dsh_remove']

export function runStoreService(options: StoreServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  const base = processCoreApi(options.dataDir, 'store')
  const api: CoreApi = {
    ...base,
    clients: { ...base.clients, dshInstallStatus: (status) => { void core?.query('installStatus', { status }).catch(() => {}) } },
  }
  const answers = (options.start ?? startStore)(api)
  /** Answered once the core has heard that what is installed changed: whatever it was, it may have. */
  const changing = (handle: ServiceRequest): ServiceRequest => async (payload, asker) => {
    const answer = await handle(payload, asker)
    await core?.query('installed').catch(() => {})
    return answer
  }
  const requests: ServiceRequests = Object.fromEntries(Object.entries(answers).map(([type, handle]) => [type, CHANGES.includes(type) ? changing(handle) : handle]))
  return (options.run ?? runServiceProcess)({
    name: 'store',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests,
    onConnected: (connection) => { core = connection },
  })
}
