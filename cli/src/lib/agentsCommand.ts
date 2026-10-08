/**
 * `harness agents …`: installing the agents Harness runs.
 *
 *   harness agents install <agent> [--pane]      install one, now, in this terminal (what a pane whose
 *                                                agent is missing runs, by the daemon's own CLI build)
 *   harness agents install-missing [--background] install the default agents this computer lacks
 *
 * The logic lives in agentInstall.ts and agentInstallMissing.ts; this only reads the arguments.
 */
import { ENGINES, type ProcessEngine } from '../engines/types.js'
import { agentInstallExitCode, installAgent } from './agentInstall.js'
import { installMissingCommand } from './agentInstallMissing.js'
import { engineBin } from './engineBin.js'
import { ENGINE_INSTALL, type EngineInstallRecipe } from './engineInstall.js'
import { managedNodePath } from './nodeRuntime.js'

export const AGENTS_USAGE = `Usage:
  harness agents install <agent>                 install one agent now, in this terminal
  harness agents install-missing [--background]  install OpenCode, Claude Code, Codex and pi where missing`

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

/** A recipe handed over whole (a pane's launch with a recipe of its own, as a test's fixture is). */
function recipeFrom(json: string): EngineInstallRecipe | null {
  try {
    const value = JSON.parse(json) as EngineInstallRecipe
    return typeof value?.command === 'string' && Array.isArray(value.executable?.names) ? value : null
  } catch {
    return null
  }
}

export async function agentsCommand(
  argv: readonly string[],
  context: { self: readonly string[]; error?: (line: string) => void },
): Promise<number> {
  const error = context.error ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  const words = argv.filter((arg) => !arg.startsWith('-'))
  const flags = argv.filter((arg) => arg.startsWith('-'))
  if (words[0] === 'install-missing') {
    return installMissingCommand({ background: flags.includes('--background'), self: context.self })
  }
  if (words[0] !== 'install' || !words[1]) {
    error(AGENTS_USAGE)
    return 2
  }
  const engine = words[1]
  const given = flag(flags, 'recipe')
  const known = (ENGINES as readonly string[]).includes(engine) && engine in ENGINE_INSTALL
  const recipe = given !== undefined ? recipeFrom(given) : known ? ENGINE_INSTALL[engine as ProcessEngine] : null
  if (!recipe) {
    error(given !== undefined ? 'harness: that install recipe could not be read.' : `harness: ${engine} is not an agent Harness can install.`)
    return 2
  }
  const command = flag(flags, 'command') || (known ? engineBin(engine as ProcessEngine) : recipe.executable.names[0]!)
  // Ctrl-C ends a wait, or stops the installer (its whole group); the pane's script carries on from there.
  const abort = new AbortController()
  const onSignal = (signal: NodeJS.Signals): void => abort.abort(signal)
  for (const signal of SIGNALS) process.on(signal, onSignal)
  try {
    const report = await installAgent({
      engine,
      recipe,
      command,
      mode: 'pane',
      say: (line) => { process.stdout.write(`${line}\n`) },
      output: 'inherit',
      signal: abort.signal,
      runtimeNode: managedNodePath(),
    })
    if (abort.signal.aborted && report.outcome === 'interrupted') return 130
    return agentInstallExitCode(report)
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal)
  }
}
