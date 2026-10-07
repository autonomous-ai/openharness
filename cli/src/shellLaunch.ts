/** Run an agent at the current prompt using cm. Credentials stay on this computer. */
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { engineBin, PROCESS_ENGINES } from './lib/engineBin.js'
import type { ProcessEngine } from './engines/types.js'
import { engineInstallRecipe } from './lib/engineInstall.js'
import { shellAgentArgv } from './lib/engineLaunch.js'
import { buildGridEngineLaunch, gridConflictingEnvToClear } from './lib/gridLaunch.js'
import { parseNewAgentModel, type NewAgentModel } from './lib/newAgentModel.js'
import type { GridLaunchOverride } from './lib/gridLaunch.js'

export interface ShellLaunchDeps {
  resolve: (selection: NewAgentModel) => Promise<GridLaunchOverride | null>
  run: (binary: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>
  error: (message: string) => void
}

export function routedInvocation(engine: 'codex' | 'claude', route: GridLaunchOverride,
  args: string[], inherited: NodeJS.ProcessEnv): { binary: string; args: string[]; env: NodeJS.ProcessEnv } {
  const result = buildGridEngineLaunch(engine, route, { hermesSystemManaged: false })
  if (!result.ok) throw new Error(result.detail)
  const { launch } = result
  const env = { ...inherited }
  for (const name of gridConflictingEnvToClear(launch)) delete env[name]
  Object.assign(env, launch.env)
  if (launch.configDir) throw new Error('This agent requires a newer shell launcher.')
  return { binary: engineBin(engine), args: [...launch.args, ...args], env }
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
  if (PROCESS_ENGINES.includes(engine as ProcessEngine) && grid === '--native' && model === '--') {
    const nativeEngine = engine as ProcessEngine
    const argv = shellAgentArgv(engineBin(nativeEngine), args.slice(3), engineInstallRecipe(nativeEngine)!)
    return deps.run(argv[0], argv.slice(1), process.env)
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
    const launch = routedInvocation(engine, target, nativeArgs, process.env)
    const argv = shellAgentArgv(launch.binary, launch.args, engineInstallRecipe(engine)!)
    return await deps.run(argv[0], argv.slice(1), launch.env)
  } catch {
    deps.error('This model route could not be started. Your agent defaults have not changed.')
    return 1
  }
}
