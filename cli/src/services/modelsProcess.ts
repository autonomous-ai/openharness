/**
 * Models in its own process (`harness __service models`, with `HARNESSD_SERVICES=models`).
 *
 * The same service as in the core's process (services/models.ts), on a core API built here: grid's
 * set-up, its pin, the pictures, the Model Manager's local models and grid commands, and the requests the
 * apps send about models. Its downloads, installs, model scans and `grid` children are this process's
 * alone: a crash, a hang or a leak costs models, and the master starts it again.
 *
 * What the core used to read straight off the pictures while it builds a frame or takes a keystroke is
 * told to it instead: a glance at every grid, each time a picker would be told something new and each time
 * this process connects (`service_query glances`, core/modelsLink.ts). What the core asks of models
 * through its port arrives as requests under the port's member names, which only the core sends; what it
 * only tells models arrives as events. What models needs of the core — the sign-in it holds, the
 * account's grid name, this machine's name, an agent's Model/Effort choices, the pushes to the windows —
 * it asks for (`service_query`), each time it needs it: a service keeps no credential.
 */
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { ACCOUNT_BACKEND_OFF, CONVERSATIONS_OFF, AGENT_ACTIONS_OFF, DAEMON_UNKNOWN, DELIVERIES_OFF, emptyPorts, LANE_OFF, TERMINALS_OFF } from '../core/api.js'
import type { AgentGridTarget, GridGlance } from '../lib/gridAnnotation.js'
import { parseGridLaunchOverride } from '../lib/gridLaunch.js'
import { gridGlances, onGridModelsChanged } from '../lib/gridModels.js'
import type { RuntimeModelOption } from '../lib/runtimeProfile.js'
import { startModels } from './models.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { UNASKED } from './processCoreApi.js'

type Payload = Record<string, unknown>

export interface ModelsServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for models that read no grid and start nothing. */
  start?: typeof startModels
  /** Every grid at a glance, and being told when that changes: the pictures', unless a test says. */
  glances?: () => GridGlance[]
  onChanged?: (listener: () => void) => () => void
}

const isRecord = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * The core API models runs on in its own process: the sign-in, the account's grid and this machine's name
 * asked of the core as they are needed, an agent's Model/Effort choices likewise, and the two pushes to
 * the windows told to it. This machine's name is what the core said with the account's grid, which the
 * Model Manager asks for before every list. What models never asks (turns, questions, search) answers as
 * nothing, and it has no agents to send frames for: the core sends those itself.
 */
export function modelsCoreApi(dataDir: string, ask: (query: string, payload?: Payload) => Promise<Payload>): CoreApi {
  let machineName: string | null = null
  const told = (query: string, payload: Payload = {}): void => { void ask(query, payload).catch(() => {}) }
  return {
    dataDir,
    conversations: CONVERSATIONS_OFF,
    // Models opens no terminal.
    terminals: TERMINALS_OFF,
    machine: UNASKED.machine,
    agents: {
      all: () => [],
      live: () => [],
      displayName: () => '',
      byAgent: () => undefined,
      resolve: () => undefined,
      advertised: () => [],
      terminalAvailable: () => false,
      sync: () => {},
      runtimeModels: async (agentId) => {
        const answer = await ask('runtimeModels', agentId ? { agentId } : {})
        if (!Array.isArray(answer.models)) throw new Error(`the core did not list the models (${text(answer.error) || 'no answer'})`)
        return answer.models as RuntimeModelOption[]
      },
      runtimeProfile: () => null,
      setRuntime: () => {},
      fork: async () => ({ ok: false, error: 'UNSUPPORTED' }),
      ...AGENT_ACTIONS_OFF,
      activityText: UNASKED.activityText,
    },
    turns: { send: () => {}, stop: () => {}, recent: async () => [], asks: async () => [], ...DELIVERIES_OFF },
    questions: { answer: () => {}, answerReviewed: async () => false },
    transcripts: { databaseHistory: () => undefined, lastTurn: UNASKED.lastTurn },
    external: {
      sessions: { list: () => [], scan: async () => [] },
      open: { known: () => new Map(), fresh: async () => new Map() },
    },
    account: {
      mintGridName: async () => {
        const answer = await ask('mintGridName')
        if (answer.error) throw new Error(`the core could not mint a grid name (${text(answer.error)})`)
        return text(answer.name) || null
      },
      accessToken: async () => {
        const token = text((await ask('accessToken')).token)
        if (!token) throw new Error('no access token: this machine is signed out')
        return token
      },
      // Unanswered, it is no name, and models works one out (services/models.ts `privateGridName`).
      privateGridName: async () => {
        const answer = await ask('account').catch(() => null)
        if (!answer) return null
        machineName = text(answer.machineName) || null
        return text(answer.gridName) || null
      },
      machineName: () => machineName,
      // Models never reaches another machine: the fleet's lane is not its to seal.
      lane: LANE_OFF,
      ...ACCOUNT_BACKEND_OFF,
      ...UNASKED.account,
    },
    clients: {
      viewerChanged: () => {},
      viewerFrame: () => false,
      gridNamed: (name) => told('gridNamed', { name }),
      gridModelsChanged: () => told('gridModelsChanged'),
      dshInstallStatus: () => {},
      windows: () => {}, observer: () => false,
      ...UNASKED.clients,
    },
    daemon: DAEMON_UNKNOWN,
    wifi: UNASKED.wifi,
  }
}

/** An agent's grid as the core sent it for a prewarm, or null when it is not one. */
const targetIn = (value: unknown): AgentGridTarget | null =>
  isRecord(value) && typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl, model: typeof value.model === 'string' ? value.model : null } : null

export function runModelsService(options: ModelsServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  const ask = (query: string, payload: Payload = {}): Promise<Payload> =>
    core ? core.query(query, payload) : Promise.reject(new Error('not connected to the core'))
  const ports = emptyPorts()
  const requests = (options.start ?? startModels)(modelsCoreApi(options.dataDir, ask), ports)
  if (!ports.models) throw new Error('models did not start')
  const models = ports.models

  /** What the current connection was last told of the grids, so a change is said once. */
  let told = ''
  const glances = options.glances ?? gridGlances
  const tellGlances = (): void => {
    const connection = core
    if (!connection) return
    const now = glances()
    const said = JSON.stringify(now)
    if (said === told) return
    told = said
    // Lost only with the connection, or the core not keeping it; the next change or connection says it again.
    void connection.query('glances', { glances: now }).then((answer) => { if (answer.kept !== true && core === connection) told = '' }, () => {})
  }
  ;(options.onChanged ?? onGridModelsChanged)(tellGlances)

  // The core's own calls into models, under its port's member names: no client's request reaches these.
  const portCalls: ServiceRequests = {
    ensure: async (payload) => ({ ...await models.ensure({ ownGrid: payload.ownGrid === true }) }),
    launchTarget: async (payload) => ({ target: await models.launchTarget({ model: text(payload.model), grid: text(payload.grid) }) }),
    moveTarget: async (payload) => ({ ...await models.moveTarget({ gridName: text(payload.gridName) || null, model: text(payload.model) }) }),
    privateGridName: async () => ({ name: await models.privateGridName() }),
    lists: async () => ({ ...await models.lists() }),
  }

  const run = options.run ?? runServiceProcess
  return run({
    name: 'models',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: { ...requests, ...portCalls },
    onEvent: (payload) => {
      if (payload.kind === 'prewarm') {
        const grid = targetIn(payload.grid)
        if (grid) models.prewarm(grid)
      } else if (payload.kind === 'moved') {
        const launch = parseGridLaunchOverride(payload.launch)
        if (launch.state === 'ok') models.moved(launch.override)
      } else if (payload.kind === 'machines') {
        models.machines(isRecord(payload.body) ? payload.body : null, text(payload.computerId))
      } else if (payload.kind === 'signedOut') {
        models.signedOut()
      }
    },
    onConnected: (connection) => {
      core = connection
      told = ''
      // A core that restarted has heard nothing yet: tell it every grid, and ask for the machine list it
      // read before this process could hear it.
      tellGlances()
      void connection.query('machines').then((answer) => {
        if (core === connection && typeof answer.computerId === 'string') models.machines(isRecord(answer.body) ? answer.body : null, answer.computerId)
      }, () => {})
    },
  })
}
