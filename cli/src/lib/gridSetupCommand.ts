import { daemonSession, type NewCommandDeps } from './newCommand.js'

/**
 * `harness grid setup` — have grid ready on this computer: installed, signed in with this computer's
 * Harness account (its token, no browser) and the account's own grid there. The same set-up the models
 * picker's Set up asks for, by the same request, so the running daemon does it once (`lib/gridAttach.ts`
 * queues and remembers it) rather than this process doing it a second way beside it.
 *
 * Run by the Model Manager when grid answers "not signed in" or is not there at all: since grid became an
 * add-on (#488) nothing sets it up until a grid feature is used, and the sign-in a person can do,
 * `harness login`, signs in to Harness alone.
 */
export interface GridSetupDeps extends Pick<NewCommandDeps, 'port' | 'connect' | 'timeoutMs'> {
  localMachineId: string | null
  daemonRunning: () => boolean | Promise<boolean>
  output: (line: string) => void
  error: (line: string) => void
}

/** A first set-up installs grid, which takes minutes; the app's Set up waits as long. */
export const GRID_SETUP_TIMEOUT_MS = 5 * 60_000

export async function gridSetupCommand(deps: GridSetupDeps): Promise<number> {
  if (!(await deps.daemonRunning())) {
    deps.error('Harness is not running on this computer. Start it with `harness start`.')
    return 1
  }
  if (!deps.localMachineId) {
    deps.error('This computer is not signed in to Harness. Run `harness login`.')
    return 1
  }
  const session = await daemonSession({ ...deps, timeoutMs: deps.timeoutMs ?? GRID_SETUP_TIMEOUT_MS }, deps.localMachineId)
  try {
    const reply = await session.request('grid_fleet_models_list', { setup: true })
    if (typeof reply.gridSetupError === 'string' && reply.gridSetupError) {
      deps.error(reply.gridSetupError)
      return 1
    }
    if (reply.gridSetupNeeded === true) {
      deps.error('Grid could not be set up on this computer. Try again.')
      return 1
    }
    deps.output('Grid is set up on this computer, signed in with its Harness account.')
    return 0
  } finally {
    session.close()
  }
}
