/**
 * Cloud agents in their own process (`harness __service cloud`), an experiment: the same service as in the
 * core's process (services/cloud.ts), answering two askers:
 * - the apps' requests, `cloud_transcript` and `cloud_agents`;
 * - the core, through its port (core/cloudLink.ts): `create`, `deliver`, `answer`, `rename` and `stopHarness`, named as the
 *   port's members so that a test's fault names the same member whichever process it runs in.
 *
 * What it tells the core (its harnesses, their questions) is asked of the core over its link
 * (services/processCoreApi.ts `cloud`), and told again whole each time it connects: a core that restarted
 * knows none of it.
 */
import { emptyPorts } from '../core/api.js'
import { startCloudOn } from './cloud.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'

export interface CloudProcessOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for a service with fake makers. */
  start?: typeof startCloudOn
}

type Payload = Record<string, unknown>
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const answers = (value: unknown): Record<string, string> => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))

export function runCloudService(options: CloudProcessOptions): ServiceProcess {
  let core: CoreConnection | null = null
  const ask = (query: string, payload: Payload): Promise<Payload> => (core ? core.query(query, payload) : Promise.reject(new Error('the core is not connected')))
  const ports = emptyPorts()
  const service = (options.start ?? startCloudOn)(processCoreApi(options.dataDir, 'cloud', { ask }), ports)
  const port = ports.cloud!
  return (options.run ?? runServiceProcess)({
    name: 'cloud',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: {
      ...service.requests,
      // The port's members, asked only by the core (core/cloudLink.ts).
      create: (payload) => port.create(payload),
      deliver: (payload) => port.deliver(text(payload.agentId), text(payload.text)),
      answer: (payload) => port.answer(text(payload.agentId), text(payload.questionId), answers(payload.answers)),
      rename: (payload) => port.rename(text(payload.agentId), text(payload.name)),
      stopHarness: (payload) => port.stopHarness(text(payload.agentId)),
    },
    onConnected: (connection) => { core = connection; void service.republish() },
    onDisconnected: () => { core = null; service.disconnected() },
  })
}
