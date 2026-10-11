/** A launch resolves once, then keeps that executable through probes and dispatch. */
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { engineBin, enginePathOverride } from '../../lib/engineBin.js'
import { engineInstallPaths, engineInstallRecipe, type EngineInstallRecipe } from '../../lib/engineInstall.js'
import { engineShellArgv, interactiveEngineShell } from '../../lib/engineLaunch.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'
import { LAUNCH_LOCATION_VARIABLES } from './nativeLocations.js'
import type { AgentEngine } from '../types.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths } from './nativePaths.js'
import { executableSnapshot, nativeVersionProbe, type NativeExecutableSnapshot } from './nativeVersion.js'

export type LaunchExecutableResult =
  | { state: 'ready'; executable: NativeExecutableSnapshot; environment: NodeJS.ProcessEnv }
  | { state: 'install'; recipe: EngineInstallRecipe; environment: Record<string, string> }
  | { state: 'held'; detail: string }
const held = (detail: string): LaunchExecutableResult => ({ state: 'held', detail })
const ENV_MARKER = '__HARNESS_LAUNCH_ENV__'
export { LAUNCH_LOCATION_VARIABLES } from './nativeLocations.js'
const pickLocations = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(
  LAUNCH_LOCATION_VARIABLES.filter(key => environment[key] !== undefined).map(key => [key, environment[key]]),
)
let probing = 0
const MAX_PROBES = 8

/** No unavailable or negative shell answer is cached. A slot belongs to the
 * actual child until its callback, including timeout/oversized-output kills. */
export async function launchEnvironment(shell?: string): Promise<NodeJS.ProcessEnv | null> {
  const interactive = interactiveEngineShell(shell)
  if (!interactive) return pickLocations(process.env)
  if (probing >= MAX_PROBES) return null
  const code = `process.stdout.write(${JSON.stringify(ENV_MARKER)}+JSON.stringify(Object.fromEntries(${JSON.stringify(LAUNCH_LOCATION_VARIABLES)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))))`
  const argv = engineShellArgv(interactive, [`exec ${shellSingleQuote(managedNodePath())} -e ${shellSingleQuote(code)}`, 'harness-launch-environment'])
  probing++
  return new Promise(done => {
    try {
      const child = execFile(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (error, output) => {
        probing--
        if (error) { done(null); return }
        try {
          const marker = output.lastIndexOf(ENV_MARKER)
          if (marker < 0) { done(null); return }
          const value: unknown = JSON.parse(output.slice(marker + ENV_MARKER.length))
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.values(value).some(item => typeof item !== 'string' || item.includes('\0'))) { done(null); return }
          done(pickLocations(value as NodeJS.ProcessEnv))
        } catch { done(null) }
      })
      child.stdin?.end()
    } catch { probing--; done(null) }
  })
}

/** A complete absence can authorize installation. Unreadable routes and failed
 * shell capture cannot: installing then would risk replacing a working engine. */
export async function captureLaunchExecutable(engine: AgentEngine, shell?: string): Promise<LaunchExecutableResult> {
  const environment = await launchEnvironment(shell)
  if (!environment || !environment.HOME || !isAbsolute(environment.HOME)) return held('Waiting to read the engine’s launch environment.')
  const command = engineBin(engine), override = enginePathOverride(engine)
  const entries = environment.PATH?.split(delimiter) ?? []
  if (entries.length === 0 || entries.length > 256 || entries.some(path => !isAbsolute(path) || path.length > 4096)) {
    return held('Waiting for a bounded, absolute engine search path.')
  }
  const recipe = override ? undefined : engineInstallRecipe(engine)
  const names = [...new Set([command, ...(recipe?.executable.names ?? [])])]
  const candidates = command.includes('/') ? [resolve(command)] : names.flatMap(name => entries.map(path => join(path, name)))
  if (recipe) candidates.push(...engineInstallPaths(recipe, environment.HOME))
  for (const path of [...new Set(candidates)]) {
    try {
      const info = statSync(path)
      if (!info.isFile()) return held('Waiting for the selected engine path to name an executable file.')
      accessSync(path, constants.X_OK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          const paths = new NativePaths(new NativeEvidenceBudget())
          if (paths.resolveSync(path, true)) return held('Waiting for the engine search path to stop changing.')
          // A dangling executable/ancestor alias is an existing user choice,
          // not evidence that installation is safe. Ordinary missing folders
          // and missing descendants of valid aliases still prove absence.
          for (const fact of paths.snapshot()) if (fact.alias) statSync(fact.path)
          paths.verify()
        } catch { return held('Waiting to confirm the engine search path and its aliases.') }
        continue
      }
      return held('Waiting to confirm access to the selected engine executable.')
    }
    const executable = executableSnapshot(nativeVersionProbe({ args: [], output: /^$/, timeoutMs: 5_000 }, () => path))
    if (!executable) return held('Waiting for the selected engine executable to stop changing.')
    return { state: 'ready', executable, environment }
  }
  return recipe ? { state: 'install', recipe, environment: environment as Record<string, string> } : held('Waiting for the configured engine executable to become available.')
}
