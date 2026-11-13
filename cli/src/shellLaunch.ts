/** Run an agent at the current prompt using cm. Credentials stay on this computer. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:os'
import { engineBin, PROCESS_ENGINES } from './lib/engineBin.js'
import type { ProcessEngine } from './engines/types.js'
import { launchContract } from './engines/launches.js'
import { screenArgs, screenEnvironment } from './engines/kit/launchScreen.js'
import { engineInstallRecipe } from './lib/engineInstall.js'
import { shellAgentArgv } from './lib/engineLaunch.js'
import { writeGridConfigDir } from './lib/gridConfigDir.js'
import { buildGridEngineLaunch, gridConflictingEnvToClear } from './lib/gridLaunch.js'
import { gridConfigHandOff, type GridConfigFile, type GridConfigLink } from './lib/gridLaunchWire.js'
import { parseNewAgentModel, type NewAgentModel } from './lib/newAgentModel.js'
import type { GridLaunchOverride } from './lib/gridLaunch.js'

export interface ShellLaunchDeps {
  resolve: (selection: NewAgentModel) => Promise<GridLaunchOverride | null>
  run: (binary: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>
  error: (message: string) => void
  /** Where a launch's config files go (`writeGridConfigDir`); the directory written. */
  writeConfig?: GridConfigWriter
}

type GridConfigWriter = (key: string, files: readonly GridConfigFile[], links: readonly GridConfigLink[]) => Promise<string>

export async function routedInvocation(engine: 'codex' | 'claude', route: GridLaunchOverride,
  args: string[], inherited: NodeJS.ProcessEnv,
  writeConfig: GridConfigWriter = writeGridConfigDir): Promise<{ binary: string; args: string[]; env: NodeJS.ProcessEnv }> {
  const result = buildGridEngineLaunch(engine, route, { hermesSystemManaged: false })
  if (!result.ok) throw new Error(result.detail)
  const { launch } = result
  const env = { ...inherited }
  for (const name of gridConflictingEnvToClear(launch)) delete env[name]
  Object.assign(env, launch.env)
  const launchArgs = [...launch.args]
  if (launch.configDir) {
    // The same private directory a pane gets (`core/agents/create.ts`), one per engine, grid and model, so a
    // second launch of the same route rewrites it rather than adding another; unused ones are pruned.
    const key = `shell-${engine}-${createHash('sha256').update(`${route.networkId}\0${route.model ?? ''}`).digest('hex').slice(0, 16)}`
    const dir = await writeConfig(key, launch.configDir.files, launch.configDir.links ?? [])
    const handOff = gridConfigHandOff(launch.configDir, dir)
    Object.assign(env, handOff.env)
    launchArgs.push(...handOff.args)
  }
  return { binary: engineBin(engine), args: [...launchArgs, ...args], env }
}

async function run(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: 'inherit', env })
    // SIGINT reaches the whole foreground group: let the child handle it without
    // Node exiting first and losing the shell's tty state.
    const interrupt = () => {}
    const terminate = () => { child.kill('SIGTERM') }
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    const clean = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
    child.once('error', (error: NodeJS.ErrnoException) => {
      clean()
      console.error(error.code === 'ENOENT' ? `${binary} is not installed on this computer.` : `Could not start ${binary} (${error.code ?? 'launch failed'}).`)
      resolve(127)
    })
    child.once('exit', (code, signal) => { clean(); resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1)) })
  })
}

export async function shellLaunch(args: string[], deps: ShellLaunchDeps = {
  // The October 6 models extraction moved routing into the service. This standalone shell child
  // shares its launch resolver; native launches never load grid, and the core gains no imports.
  resolve: async selection => (await import('./services/models.js')).launchTarget(selection),
  run,
  error: console.error,
}): Promise<number> {
  const [engine, grid, model, separator, ...nativeArgs] = args
  // An engine typed at a Harness prompt runs in the pane the phone and the desktop share, so it runs on the screen
  // every launch Harness makes runs it on (facets/launch.ts `ScreenContract`). Its argv goes ahead of the person's
  // own, which may start with a subcommand: Codex takes `-c` before `resume` and `fork` (0.162.1).
  const screen = launchContract(engine)
  if (PROCESS_ENGINES.includes(engine as ProcessEngine) && grid === '--native' && model === '--') {
    const nativeEngine = engine as ProcessEngine
    const argv = shellAgentArgv(engineBin(nativeEngine), [...screenArgs(screen), ...args.slice(3)], engineInstallRecipe(nativeEngine)!)
    return deps.run(argv[0], argv.slice(1), screenEnvironment(screen, process.env))
  }
  if (PROCESS_ENGINES.includes(engine as ProcessEngine) && engine !== 'codex' && engine !== 'claude' && separator === '--') {
    deps.error(`cm routing is not supported for ${engine} yet. Run cm default to use its own model settings.`)
    return 2
  }
  if ((engine !== 'codex' && engine !== 'claude') || separator !== '--') {
    deps.error('Usage: harness shell-launch <agent> --native -- [agent arguments], or shell-launch codex|claude <grid> <model> -- [agent arguments]')
    return 2
  }
  const parsed = parseNewAgentModel(engine, { gridName: grid, gridModel: model })
  if (parsed.state !== 'ok') { deps.error(parsed.state === 'invalid' ? parsed.detail : 'Choose a model with cm first.'); return 2 }
  // Resolver diagnostics may include service details. Never echo them into a
  // transcript; failed routing never falls through to a subscription.
  const target = await deps.resolve(parsed.selection).catch(() => null)
  if (!target) { deps.error('That model is unavailable from this computer. Choose another with cm, or use cm default.'); return 1 }
  try {
    const launch = await routedInvocation(engine, target, [...screenArgs(screen), ...nativeArgs], process.env, deps.writeConfig)
    const argv = shellAgentArgv(launch.binary, launch.args, engineInstallRecipe(engine)!)
    return await deps.run(argv[0], argv.slice(1), screenEnvironment(screen, launch.env))
  } catch {
    deps.error('This model route could not be started. Your agent defaults have not changed.')
    return 1
  }
}
