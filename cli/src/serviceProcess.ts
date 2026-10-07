/**
 * Services in their own process (`__service <a>,<b>`), as harnessd's master starts them: one, or the
 * several a host shares (harnessd/services.ts `SERVICE_HOSTS`).
 *
 * Its own module, so the bundle's entry (entry.ts) can start a process that evaluates only its own
 * services: each runner is imported by the process that runs it, and a search process never evaluates
 * the viewers. Isolation is the point of the split, and it cost the whole CLI per process while every
 * one evaluated the whole bundle: 115 to 160 MiB resident each at idle, measured from the bundle
 * (2026-10-05).
 */
import { env } from './config/env.js'
import { ensureUtf8Locale } from './lib/childLocale.js'
import { readOrMintComputerId } from './lib/computerIdentity.js'
import { localSocketPath } from './lib/localSocket.js'
import { ignoreLogWriteErrors, installTimestampedConsole } from './lib/log.js'
import { hostServices, type ServiceHost, type ServiceHostOptions, type ServiceProcess } from './services/process.js'

export interface ServiceProcessOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
}
type Runner = (options: ServiceProcessOptions) => ServiceProcess

/** The processes the master runs that speak only to it, never to the core: they need no local socket. */
const BESIDE_THE_CORE: ReadonlySet<string> = new Set(['updater'])

/** Every service this build can run in its own process, and how to load its runner alone. */
export const SERVICE_RUNNERS: ReadonlyMap<string, () => Promise<Runner>> = new Map<string, () => Promise<Runner>>([
  ['search', async () => (await import('./services/searchProcess.js')).runSearchService],
  ['viewers', async () => (await import('./services/viewersProcess.js')).runViewersService],
  ['workspaces', async () => (await import('./services/workspacesProcess.js')).runWorkspacesService],
  ['usage', async () => (await import('./services/usageProcess.js')).runUsageService],
  ['monitor', async () => (await import('./services/monitorProcess.js')).runMonitorService],
  ['projects', async () => (await import('./services/projectsProcess.js')).runProjectsService],
  ['handoff', async () => (await import('./services/handoffProcess.js')).runHandoffService],
  ['recaps', async () => (await import('./services/recapsProcess.js')).runRecapsService],
  ['store', async () => (await import('./services/storeProcess.js')).runStoreService],
  ['teams', async () => (await import('./services/teamsProcess.js')).runTeamsService],
  ['collaboration', async () => (await import('./services/collaborationProcess.js')).runCollaborationService],
  ['sharing', async () => (await import('./services/sharingProcess.js')).runSharingService],
  ['orchestrator', async () => (await import('./services/orchestratorProcess.js')).runOrchestratorService],
  ['commandBar', async () => (await import('./services/commandBarProcess.js')).runCommandBarService],
  // Not a service the core knows: the master runs it beside them (harnessd/services.ts `UPDATER_HOST`).
  ['updater', async () => (await import('./services/updaterProcess.js')).runUpdaterService],
  ['gateway', async () => (await import('./gateway/gatewayProcess.js')).runGatewayService],
  ['models', async () => (await import('./services/modelsProcess.js')).runModelsService],
  ['devices', async () => (await import('./services/devicesProcess.js')).runDevicesService],
  ['wifi', async () => (await import('./services/wifiProcess.js')).runWifiService],
])

export interface ServiceProcessDeps {
  runners?: ReadonlyMap<string, () => Promise<Runner>>
  /** The process the services run in; swapped in tests for one that touches no channel, signal or exit. */
  host?: (options: ServiceHostOptions) => ServiceHost
  exit?: (code: number) => never
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Run the services [named] (`search`, or `workspaces,usage`) until the master stops them; exits 2 for a
 * name this build does not know. Throws when none of them starts, as a lone service whose start throws
 * always did: the process ends, and the master decides whether to try again.
 */
export async function startServiceProcess(named: string | undefined, deps: ServiceProcessDeps = {}): Promise<ServiceProcess> {
  const runners = deps.runners ?? SERVICE_RUNNERS
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const names = [...new Set((named ?? '').split(',').map((name) => name.trim()).filter(Boolean))]
  const socketPath = localSocketPath(env.ADAPTER_DATA_DIR, env.PORT)
  const unknown = names.length ? names.find((name) => !runners.has(name)) : '(none)'
  if (unknown !== undefined) {
    console.error(`[service] ${unknown}: no such service in this build`)
    return exit(2)
  }
  // The updater never reaches the core: it tells the master. Without a socket (a data folder too deep for
  // one) it still runs, or that machine would never get the update that fixes it.
  if (!socketPath && names.some((name) => !BESIDE_THE_CORE.has(name))) {
    console.error(`[service] ${names.join(',')}: the core has no local socket to reach`)
    return exit(2)
  }
  // The master names the process (`edge` for the services it shares); a process started by hand is named
  // for what it runs. The same name as the hard link it was exec'd through (harnessd/processName.ts): one
  // name in ps and Activity Monitor.
  const title = process.env.HARNESSD_SERVICE || names.join(',')
  process.title = `harnessd-${title}`
  // Its lines share the daemon's log with the master's: a write a full disk refuses is dropped, not fatal.
  ignoreLogWriteErrors()
  // As every daemon process did at load: a service that runs `ps` or `git` must not get mangled output.
  ensureUtf8Locale()
  // Its lines go to the daemon's log between the core's and the master's, which are stamped: unstamped,
  // a service's said nothing of when.
  installTimestampedConsole()
  const loaded = await Promise.all(names.map(async (name) => [name, await runners.get(name)!()] as const))
  const options: ServiceProcessOptions = {
    dataDir: env.ADAPTER_DATA_DIR,
    socketPath: socketPath ?? '',
    machineId: readOrMintComputerId(env.ADAPTER_COMPUTER_ID_FILE, env.ADAPTER_COMPUTER_ID),
    token: process.env.HARNESSD_SERVICE_TOKEN ?? '',
  }
  const running: ServiceProcess[] = []
  let failure: unknown = null
  for (const [name, run] of loaded) {
    try {
      running.push(run(options))
    } catch (error) {
      // One service that cannot start is off, and the others in its process run on: the core answers its
      // requests SERVICE_UNAVAILABLE, as for any service that is down. In-process, the core's host does
      // the same with a start that throws (core/serviceHost.ts).
      failure ??= error
      console.error(`[service ${name}] did not start · ${describe(error)}`)
    }
  }
  if (!running.length) throw failure
  const host = (deps.host ?? hostServices)({ name: title, services: names })
  for (const service of running) host.add(service)
  return {
    stop: () => Promise.allSettled(running.map((service) => Promise.resolve().then(() => service.stop()))).then(() => {}),
  }
}
