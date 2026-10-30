/** A launch resolves once, then keeps that executable through probes and dispatch. */
import { execFile } from 'node:child_process'
import { accessSync, closeSync, constants, lstatSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { engineBin, enginePathOverride } from '../../lib/engineBin.js'
import { engineInstallPaths, engineInstallRecipe, type EngineInstallRecipe } from '../../lib/engineInstall.js'
import { engineShellArgv, interactiveEngineShell, npmRuntimeBins } from '../../lib/engineLaunch.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { probeExecFile } from '../../lib/offThreadExec.js'
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
/**
 * Windows sets no HOME of its own. OpenSSH for Windows does, so the first VM runs (all over SSH) had one; a daemon
 * started any other way (WMI, a scheduled task, the desktop app) held every native launch at "Waiting to read the
 * engine's launch environment" (the Windows VM E2E, 2026-10-15). The profile is the home there, as os.homedir() says.
 */
function withWindowsHome(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return process.platform === 'win32' && !environment.HOME ? { ...environment, HOME: homedir() } : environment
}
let probing = 0
const MAX_PROBES = 8
/** How long a captured launch environment answers again. Each capture is a login shell (rc files, then Node),
 *  spawned synchronously from the core: a held launch's pass asked about four times, every pass (measured
 *  2026-10-15). A few seconds joins those; an rc file edited since is read on the next launch after it. */
const ENVIRONMENT_TTL_MS = 10_000
const captured = new Map<string, { at: number; environment: NodeJS.ProcessEnv }>()
const capturing = new Map<string, Promise<NodeJS.ProcessEnv | null>>()

/** Test seam. */
export function clearLaunchEnvironmentCache(): void {
  captured.clear()
  capturing.clear()
}

/** No unavailable or negative shell answer is cached. A slot belongs to the
 * actual child until its callback, including timeout/oversized-output kills.
 * A capture still running is joined; one taken in the last ENVIRONMENT_TTL_MS is answered again. */
export async function launchEnvironment(shell?: string): Promise<NodeJS.ProcessEnv | null> {
  const interactive = interactiveEngineShell(shell)
  if (!interactive) return withWindowsHome(pickLocations(process.env))
  // Keyed by the shell, not its argv: a shell that is not POSIX gets a one-time script file in its argv.
  const key = JSON.stringify([interactive.path, interactive.args, managedNodePath()])
  const hit = captured.get(key)
  if (hit && Date.now() - hit.at < ENVIRONMENT_TTL_MS) return { ...hit.environment }
  const running = capturing.get(key)
  if (running) return running.then(environment => environment && { ...environment })
  if (probing >= MAX_PROBES) return null
  const code = `process.stdout.write(${JSON.stringify(ENV_MARKER)}+JSON.stringify(Object.fromEntries(${JSON.stringify(LAUNCH_LOCATION_VARIABLES)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))))`
  const argv = engineShellArgv(interactive, [`exec ${shellSingleQuote(managedNodePath())} -e ${shellSingleQuote(code)}`, 'harness-launch-environment'])
  const capture = captureEnvironment(argv).then(environment => {
    capturing.delete(key)
    if (environment) captured.set(key, { at: Date.now(), environment })
    return environment
  })
  capturing.set(key, capture)
  return capture.then(environment => environment && { ...environment })
}

function captureEnvironment(argv: string[]): Promise<NodeJS.ProcessEnv | null> {
  probing++
  return new Promise(done => {
    try {
      const child = probeExecFile(execFile)(argv[0], argv.slice(1), { timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (error, output) => {
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
      child?.stdin?.end()
    } catch { probing--; done(null) }
  })
}

/**
 * The names a launch looks for on PATH, the command first. On Windows `cmd` is never one: it names the command processor
 * (C:\Windows\System32\cmd.exe, ahead of npm's folder on PATH), which every Command Code launch ran instead (F7).
 */
export function launchSearchNames(command: string, recipeNames: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return [...new Set([command, ...recipeNames])].filter((name) => platform !== 'win32' || name.toLowerCase() !== 'cmd')
}

/** A complete absence can authorize installation. Unreadable routes and failed
 * shell capture cannot: installing then would risk replacing a working engine. */
export async function captureLaunchExecutable(engine: AgentEngine, shell?: string): Promise<LaunchExecutableResult> {
  const environment = await launchEnvironment(shell)
  if (!environment || !environment.HOME || !isAbsolute(environment.HOME)) return held('Waiting to read the engine’s launch environment.')
  const command = engineBin(engine), override = enginePathOverride(engine)
  // An entry that is not absolute names no fixed folder, so it is left out of the search, as an over-long
  // one is. It is not a reason to hold: `~/.dotnet/tools` is on the login PATH of every Mac with the .NET SDK
  // (its /etc/paths.d file says it that way), and 0.3.74 held every launch on such a computer for good.
  const listed = environment.PATH?.split(delimiter) ?? []
  const entries = listed.filter(path => isAbsolute(path) && path.length <= 4096)
  if (entries.length === 0 || listed.length > 256) return held('Waiting for a bounded, absolute engine search path.')
  const recipe = override ? undefined : engineInstallRecipe(engine)
  const names = launchSearchNames(command, recipe?.executable.names ?? [])
  const candidates = command.includes('/') || isAbsolute(command) ? [resolve(command)] : names.flatMap(name => entries.map(path => join(path, name)))
  if (recipe) candidates.push(...engineInstallPaths(recipe, environment.HOME))
  // The installer also finds an npm engine beside Harness's own Node (its PATH gains that folder, and
  // `npm prefix -g` names it). Looking only here, a Codex in that folder was "missing": every launch dispatched
  // an installer that found it and exited 0 without a word, and the next launch dispatched another (2026-10-19).
  if (recipe?.executable.npmGlobal) candidates.push(...npmRuntimeBins().flatMap(bin => recipe.executable.names.map(name => join(bin, name))))
  // A candidate this account may not reach. Looked past, for a later one it can run; with none, held as before rather
  // than installing over what may be there.
  let unreachable = false
  // A dangling link on the way to a candidate: a person's choice, so it never proves the engine absent. Looked past
  // as a shell looks past it, for a later candidate it can run; with none, held rather than installing. Held at the
  // link, every start on a Mac with Nix and no profile yet (~/.nix-profile) waited for good, its own Claude Code in
  // ~/.local/bin never reached (2026-10-30).
  let aliased = false
  for (const path of [...new Set(candidates.flatMap(windowsPrograms))]) {
    try {
      const info = statSync(path)
      if (!info.isFile()) return held('Waiting for the selected engine path to name an executable file.')
      accessSync(path, constants.X_OK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Windows: statSync follows links, so a PATH entry across a symlink or junction (nvm-windows, Scoop) proves
        // absence like any other. NativePaths refuses links there, which is right for hook files, not for this search.
        // A leaf that exists though statSync cannot follow it is a dangling link: a user's choice, held as on POSIX.
        // Only the leaf is checked: a dangling folder on the way (nvm-windows' nodejs link after its version was
        // removed) still reads as absent here, where POSIX holds on a dangling ancestor.
        if (process.platform === 'win32') {
          try { lstatSync(path) } catch (leaf) {
            if ((leaf as NodeJS.ErrnoException).code === 'ENOENT') continue
          }
          aliased = true
          continue
        }
        try {
          const paths = new NativePaths(new NativeEvidenceBudget())
          if (paths.resolveSync(path, true)) return held('Waiting for the engine search path to stop changing.')
          // A dangling executable/ancestor alias is an existing user choice,
          // not evidence that installation is safe. Ordinary missing folders
          // and missing descendants of valid aliases still prove absence.
          for (const fact of paths.snapshot()) if (fact.alias) statSync(fact.path)
          paths.verify()
        } catch { aliased = true }
        continue
      }
      // A folder on the search path that this account may not enter, or a file it may not run, hides nothing it could
      // run: every account's PATH has Homebrew's bin (/etc/paths.d/homebrew), and a Harness Team account on a Mac whose
      // Homebrew is its owner's alone (mode 770) held every Claude Code launch here for good, its own Claude Code in
      // ~/.local/bin never reached (2026-10-27).
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') { unreachable = true; continue }
      return held('Waiting to confirm access to the selected engine executable.')
    }
    const executable = executableSnapshot(nativeVersionProbe({ args: [], output: /^$/, timeoutMs: 5_000 }, () => path))
    if (!executable) return held('Waiting for the selected engine executable to stop changing.')
    return { state: 'ready', executable, environment: withNodeForScript(path, environment) }
  }
  if (aliased) return held('Waiting to confirm the engine search path and its aliases.')
  if (unreachable) return held('Waiting to confirm access to the selected engine executable.')
  return recipe ? { state: 'install', recipe, environment: environment as Record<string, string> } : held('Waiting for the configured engine executable to become available.')
}

/**
 * The files a Windows launch can run for [path], in the order CreateProcess and npm's shims make them: its `.exe`, then
 * its `.cmd`, `.bat` or `.com` (an npm shim, run as its script: lib/windows/launch.ts). Not the extensionless sh script
 * npm also writes, which nothing on Windows runs, nor a `.ps1`. Claude Code's native install is `claude.exe` alone, and
 * with only the bare name looked for, every launch of it read as not installed (Windows 11 VM, 2026-10-15). A path
 * that names a program already, and every path elsewhere, is itself.
 */
function windowsPrograms(path: string): string[] {
  if (process.platform !== 'win32' || /\.(?:exe|cmd|bat|com)$/i.test(path)) return [path]
  return ['.exe', '.cmd', '.bat', '.com'].map(extension => path + extension)
}

/**
 * An engine whose executable is a Node script (`#!/usr/bin/env node`: what `npm install -g` leaves for
 * Codex, Claude Code and the other npm engines) needs a `node` on its PATH. Harness installs those with its
 * own Node (lib/engineLaunch.ts `npmRuntimePrelude`; Desktop's setup too, bootstrap/agent_prefetch.dart) and
 * never adds that Node to the person's PATH, so on a computer without a Node of its own the engine could
 * not start: in a fresh Ubuntu VM (2026-10-11) Codex installed by the daemon failed its `--help` probe with
 * "/usr/bin/env: ‘node’: No such file or directory" and every launch of it held for good, and a pane would
 * have failed the same way. Only for such a script, and only when no directory of the launch PATH has a
 * `node`, Harness's Node goes at the END of that PATH. The probe runs with this environment and the pane sets
 * it again after its rc files, so both find the same Node; a Node the person has is never shadowed.
 */
export function withNodeForScript(path: string, environment: NodeJS.ProcessEnv, node: string = managedNodePath()): NodeJS.ProcessEnv {
  const entries = environment.PATH?.split(delimiter) ?? []
  const bin = dirname(node)
  if (!isAbsolute(node) || bin.includes(delimiter) || entries.length >= 256 || !runsOnPathNode(path)) return environment
  const executableFile = (file: string) => { try { accessSync(file, constants.X_OK); return statSync(file).isFile() } catch { return false } }
  if (entries.some(entry => executableFile(join(entry, 'node')))) return environment
  return { ...environment, PATH: [...entries, bin].join(delimiter) }
}

/** The script's first line names `env node` (or `env -S node …`) as its interpreter. */
function runsOnPathNode(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const head = Buffer.alloc(256)
    const line = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString('utf8').split('\n')[0]!
    return /^#!\s*\S*\/env(?:\s+-S)?\s+node(?:\s|$)/.test(line)
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}
