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
 *
 * And it answers the core's port calls (`StorePort`, core/api.ts): a harness package's workspace and each
 * session's runtime, for a launch (services/storeLaunch.ts). Not the apps': no app request names them.
 */
import type { CoreApi, ServiceRequest, ServiceRequests, StorePort } from '../core/api.js'
import { DSH_ID_RE } from '../dsh/manifest.js'
import type { DshAccount } from '../dsh/launch.js'
import type { DshLaunchRequest, DshMaterializeRequest } from '../dsh/launchWire.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
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
  /** Swapped in tests for launches that prepare nothing. */
  launches?: StorePort
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** What the core sends of the account: its private grid, or none. */
function accountIn(value: unknown): DshAccount | null {
  if (!isRecord(value)) return null
  if (value.privateGrid === undefined || value.privateGrid === null) return {}
  return typeof value.privateGrid === 'string' ? { privateGrid: value.privateGrid } : null
}

/** A create's workspace request, as the core sends it; null when it is not one. */
export function dshMaterializeRequestIn(payload: Record<string, unknown>): DshMaterializeRequest | null {
  const account = accountIn(payload.account)
  if (!nonEmpty(payload.dsh) || !DSH_ID_RE.test(payload.dsh) || !nonEmpty(payload.workspace) || !account) return null
  if (!(ENGINES as readonly string[]).includes(payload.engine as string)) return null
  return { dsh: payload.dsh, workspace: payload.workspace, engine: payload.engine as AgentEngine, account }
}

/** A session's runtime request, as the core sends it; null when it is not one. */
export function dshLaunchRequestIn(payload: Record<string, unknown>): DshLaunchRequest | null {
  const base = dshMaterializeRequestIn(payload)
  if (!base || !nonEmpty(payload.key)) return null
  const forkOf = payload.forkOf
  if (forkOf === undefined) return { ...base, key: payload.key }
  if (!isRecord(forkOf) || !nonEmpty(forkOf.agentId) || !(forkOf.dshRuntime === null || nonEmpty(forkOf.dshRuntime))) return null
  return { ...base, key: payload.key, forkOf: { agentId: forkOf.agentId, dshRuntime: forkOf.dshRuntime } }
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
  // The core's port calls: a launch's part, never asked by an app (STORE_REQUESTS names none of them).
  const launches = options.launches ?? storeLaunchPort()
  const unreadable = { ok: false, error: 'DSH_RUNTIME_FAILED', detail: 'This launch could not be read.' }
  requests.dshMaterialize = async (payload) => {
    const request = dshMaterializeRequestIn(payload)
    return request ? { ...await launches.dshMaterialize(request) } : unreadable
  }
  requests.dshLaunch = async (payload) => {
    const request = dshLaunchRequestIn(payload)
    return request ? { ...await launches.dshLaunch(request) } : unreadable
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
