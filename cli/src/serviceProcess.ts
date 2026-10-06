/**
 * A service in its own process (`__service <name>`), as harnessd's master starts it.
 *
 * Its own module, so the bundle's entry (entry.ts) can start a service that evaluates only that service:
 * each runner is imported by the process that runs it, and a search process never evaluates the
 * viewers. Isolation is the point of the split, and it cost the whole CLI per process while every one
 * evaluated the whole bundle: 115 to 160 MiB resident each at idle, measured from the bundle
 * (2026-10-05).
 */
import { env } from './config/env.js'
import { ensureUtf8Locale } from './lib/childLocale.js'
import { readOrMintComputerId } from './lib/computerIdentity.js'
import { localSocketPath } from './lib/localSocket.js'
import { ignoreLogWriteErrors, installTimestampedConsole } from './lib/log.js'
import type { ServiceProcess } from './services/process.js'

export interface ServiceProcessOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
}
type Runner = (options: ServiceProcessOptions) => ServiceProcess

/** Every service this build can run in its own process, and how to load its runner alone. */
export const SERVICE_RUNNERS: ReadonlyMap<string, () => Promise<Runner>> = new Map([
  ['search', async () => (await import('./services/searchProcess.js')).runSearchService],
  ['viewers', async () => (await import('./services/viewersProcess.js')).runViewersService],
  ['workspaces', async () => (await import('./services/workspacesProcess.js')).runWorkspacesService],
  ['teams', async () => (await import('./services/teamsProcess.js')).runTeamsService],
])

export interface ServiceProcessDeps {
  runners?: ReadonlyMap<string, () => Promise<Runner>>
  exit?: (code: number) => never
}

/** Run the service [name] until the master stops it; exits 2 for a name this build does not know. */
export async function startServiceProcess(name: string | undefined, deps: ServiceProcessDeps = {}): Promise<ServiceProcess> {
  const runners = deps.runners ?? SERVICE_RUNNERS
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const socketPath = localSocketPath(env.ADAPTER_DATA_DIR, env.PORT)
  const load = name === undefined ? undefined : runners.get(name)
  if (!load || !socketPath) {
    console.error(`[service] ${name ?? '(none)'}: ${socketPath ? 'no such service in this build' : 'the core has no local socket to reach'}`)
    return exit(2)
  }
  // The same name as the hard link it was exec'd through (harnessd/processName.ts): one name in ps and Activity Monitor.
  process.title = `harnessd-${name}`
  // Its lines share the daemon's log with the master's: a write a full disk refuses is dropped, not fatal.
  ignoreLogWriteErrors()
  // As every daemon process did at load: a service that runs `ps` or `git` must not get mangled output.
  ensureUtf8Locale()
  // Its lines go to the daemon's log between the core's and the master's, which are stamped: unstamped,
  // a service's said nothing of when.
  installTimestampedConsole()
  const run = await load()
  return run({
    dataDir: env.ADAPTER_DATA_DIR,
    socketPath,
    machineId: readOrMintComputerId(env.ADAPTER_COMPUTER_ID_FILE, env.ADAPTER_COMPUTER_ID),
    token: process.env.HARNESSD_SERVICE_TOKEN ?? '',
  })
}
