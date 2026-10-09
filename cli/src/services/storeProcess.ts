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
import type { CoreApi, ServiceRequest, ServiceRequests, StorePort } from '../core/api.js'
import type { DshMaterializeRequest, DshLaunchRequest } from '../dsh/launchWire.js'
import { PROCESS_ENGINES, type AgentEngine } from '../engines/types.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'
import { startStore } from './store.js'
import { storeLaunchPort } from './storeLaunch.js'

export interface StoreServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for a Store that clones and installs nothing. */
  start?: (core: CoreApi) => ServiceRequests
  launch?: StorePort
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** Internal port calls accept only the context package preparation actually reads. */
export function dshMaterializeRequestIn(value: Record<string, unknown>): DshMaterializeRequest | null {
  if (!text(value.dsh) || !text(value.workspace) || !PROCESS_ENGINES.some(engine => engine === value.engine)) return null
  if (!record(value.account)) return null
  const name = value.account.privateGrid
  if (name !== undefined && name !== null && typeof name !== 'string') return null
  return { dsh: value.dsh, workspace: value.workspace, engine: value.engine as AgentEngine,
    account: name === undefined ? {} : { privateGrid: name } }
}

export function dshLaunchRequestIn(value: Record<string, unknown>): DshLaunchRequest | null {
  const base = dshMaterializeRequestIn(value)
  if (!base || !text(value.key)) return null
  if (value.forkOf === undefined) return { ...base, key: value.key }
  const fork = value.forkOf
  if (!record(fork) || !text(fork.agentId) || !(fork.dshRuntime === null || text(fork.dshRuntime))) return null
  return { ...base, key: value.key, forkOf: { agentId: fork.agentId, dshRuntime: fork.dshRuntime } }
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
  const launch = options.launch ?? storeLaunchPort()
  /** Answered once the core has heard that what is installed changed: whatever it was, it may have. */
  const changing = (handle: ServiceRequest): ServiceRequest => async (payload, asker) => {
    const answer = await handle(payload, asker)
    await core?.query('installed').catch(() => {})
    return answer
  }
  const requests: Record<string, ServiceRequest> = Object.fromEntries(Object.entries(answers).map(([type, handle]) => [type, CHANGES.includes(type) ? changing(handle) : handle]))
  requests.dshMaterialize = async payload => {
    const request = dshMaterializeRequestIn(payload)
    return request ? { ...await launch.dshMaterialize(request) } : { ok: false, error: 'INVALID_DSH', detail: 'Invalid harness workspace request' }
  }
  requests.dshLaunch = async payload => {
    const request = dshLaunchRequestIn(payload)
    return request ? { ...await launch.dshLaunch(request) } : { ok: false, error: 'INVALID_DSH', detail: 'Invalid harness launch request' }
  }
  return (options.run ?? runServiceProcess)({
    name: 'store',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests,
    onConnected: (connection) => {
      core = connection
      // startStore has prepared the bundled harnesses before this link opens. A reconnect repeats the
      // notice so a restarted core refreshes its installed index before restoring those agents.
      void connection.query('prepared').catch(() => {})
    },
  })
}
