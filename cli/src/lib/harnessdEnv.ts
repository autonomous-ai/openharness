/**
 * The `HARNESSD_*` variables: what harnessd's master tells the core and each service process it starts
 * (harnessd/supervisor.ts, harnessd/services.ts, harnessd/master.ts), among them the service token
 * that admits a connection as one of this boot's services (localWsServer.ts, `role: 'service'`).
 *
 * They are for those processes alone. Left in process.env, every child inherited them: the tmux server
 * the core starts copies the environment it starts with into the one every new pane gets, so every
 * agent, every terminal tile and every hook they ran had them all (found 2026-10-11: `env` in an agent's
 * pane listed every one). So the core and each service process take them out of process.env first thing
 * (`holdHarnessdEnv`), and read them through `harnessdEnv()` instead. What harnessd's own processes
 * need of them (the updater beside a core, a master a core hands over to, the master's probe) is passed
 * to them explicitly.
 */

const PREFIX = 'HARNESSD_'

/** What this process took out of process.env: what `harnessdEnv()` puts back for its own readers. */
const held: Record<string, string> = {}

/** Whether [name] is one of harnessd's own variables, never for a pane or anything else a process starts. */
export function isHarnessdVariable(name: string): boolean {
  return name.startsWith(PREFIX)
}

/**
 * Take every `HARNESSD_*` out of [env], this process's own by default, and keep it for `harnessdEnv()`.
 * Called before the process starts anything: a child started before it has them for good, and a tmux
 * server started before it hands them to every pane until it is told otherwise (TmuxBackend
 * `unsetServerEnvironment`).
 */
export function holdHarnessdEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env).filter(isHarnessdVariable)) {
    held[name] = env[name]!
    delete env[name]
  }
}

/**
 * The environment this process was started with: [env] (process.env by default) with the `HARNESSD_*`
 * it holds back put in again. A copy, for reading what the master said, and the base of the environment
 * of harnessd's own processes; never of anything else.
 */
export function harnessdEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ...held }
}
