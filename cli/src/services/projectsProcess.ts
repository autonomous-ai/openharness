/**
 * The project and folder readers in their own process (`harness __service projects`, in the edge host):
 * the same handlers as in the core's process (services/projects.ts), on the live agents the core names
 * as each request starts (`service_query live`). An agent's branch and pull request, a project's
 * repository and preview, a folder's subfolders and a media file are read here: the git runs, the disk
 * reads and their time are this process's alone.
 */
import type { ServiceRequests } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { agentsIn, processCoreApi } from './processCoreApi.js'
import { startProjects } from './projects.js'

export interface ProjectsServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for readers that run no git and read no disk. */
  start?: typeof startProjects
}

export function runProjectsService(options: ProjectsServiceOptions): ServiceProcess {
  let live: RegisteredSession[] = []
  let core: CoreConnection | null = null
  /** The live agents now. A core that cannot say leaves the last ones it said. */
  const refresh = async (): Promise<void> => {
    live = agentsIn(await core?.query('live').catch(() => null)) ?? live
  }
  const answers = (options.start ?? startProjects)(processCoreApi(options.dataDir, 'projects', { live: () => live }))
  // Each request reads the agents as they are when it is asked, as the core's registry would answer it:
  // an agent stopped a moment ago is no longer one whose folder this reads.
  const requests: ServiceRequests = Object.fromEntries(Object.entries(answers).map(([type, handle]) =>
    [type, async (payload: Record<string, unknown>, asker: Parameters<typeof handle>[1]) => { await refresh(); return handle(payload, asker) }]))
  return (options.run ?? runServiceProcess)({
    name: 'projects',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests,
    onConnected: (connection) => { core = connection },
  })
}
