/** Interactive discovery runs in the existing engineProbe feature process, not session control. */
import { execFile } from 'node:child_process'
import type { AgentEngine } from '../types.js'
import { engineInstallPaths, type EngineInstallRecipe } from '../../lib/engineInstall.js'
import { binaryOnPath } from '../../lib/binaryOnPath.js'
import { notStoreAppAlias } from '../../lib/windows/storeAppAlias.js'
import { windowsEngineArgv } from '../../lib/windows/launch.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'
import { engineShellArgv, interactiveEngineShell } from '../../lib/engineLaunch.js'
import { npmRuntimePrelude } from './installationScript.js'
import { errorKind } from '../../lib/log.js'

function availabilityScript(recipe: EngineInstallRecipe | undefined): string {
  const names = recipe?.executable.names.map(shellSingleQuote).join(' ') ?? ''
  const paths = recipe ? engineInstallPaths(recipe).map(shellSingleQuote).join(' ') : ''
  const candidates = [names, paths].filter(Boolean).join(' ')
  return [
    ...(recipe ? [npmRuntimePrelude(recipe, managedNodePath())] : []),
    `for candidate in "$@" ${candidates}; do`,
    '  case "$candidate" in',
    '    */*) resolved="$candidate" ;;',
    '    *) resolved="$(command -v "$candidate" 2>/dev/null)" || true ;;',
    '  esac',
    '  if [ -n "$resolved" ] && [ -f "$resolved" ] && [ -x "$resolved" ]; then exit 0; fi',
    'done',
    ...(recipe?.executable.npmGlobal ? [
      'npm_prefix="$(npm prefix -g 2>/dev/null)" || true',
      'if [ -n "$npm_prefix" ]; then',
      `  for bin in ${names}; do [ -f "$npm_prefix/bin/$bin" ] && [ -x "$npm_prefix/bin/$bin" ] && exit 0; done`,
      'fi',
    ] : []),
    // An ordinary shell/profile failure may also exit 1. Only this value proves the probe ran to completion and found nothing.
    'exit 42',
  ].join('\n')
}

type CommandAvailability = { status: 'available' | 'missing' | 'unverified'; detail?: string }
/**
 * Does the same interactive shell that launches a new agent resolve this CLI?
 *
 * The fallback is intentionally the daemon PATH: without a usable absolute
 * SHELL there is no safer context to consult and direct launch is used too.
 */
export function commandAvailableInInteractiveShell(command: string, shell: string | undefined, recipe: EngineInstallRecipe | undefined, detailed: true): Promise<CommandAvailability>
export function commandAvailableInInteractiveShell(command: string, shell?: string, recipe?: EngineInstallRecipe): Promise<boolean>
export async function commandAvailableInInteractiveShell(
  command: string,
  shell: string | undefined = undefined,
  recipe: EngineInstallRecipe | undefined = undefined,
  detailed = false,
): Promise<boolean | CommandAvailability> {
  const interactive = interactiveEngineShell(shell)
  if (!interactive) {
    // Windows: a Store app's alias passes accessSync but is no engine (lib/windows/storeAppAlias.ts), and a launch looks
    // past it to install the engine. Counted here, New showed an older Claude desktop app's `claude.exe` as Claude Code
    // installed, so the install it then got came without the dialog announcing it.
    const found = binaryOnPath(command, process.env, notStoreAppAlias)
      || (recipe ? engineInstallPaths(recipe).some((candidate) => binaryOnPath(candidate, process.env, notStoreAppAlias)) : false)
    return detailed ? { status: found ? 'available' : 'missing' } : found
  }
  const [file, ...args] = engineShellArgv(interactive, [availabilityScript(recipe), 'harness-engine-probe', command])
  const result = await new Promise<CommandAvailability>((resolve) => {
    execFile(
      file,
      args,
      { timeout: 5_000 },
      (error) => {
        if (!error) return resolve({ status: 'available' })
        if (Number(error.code) === 42) return resolve({ status: 'missing' })
        if (error.killed) return resolve({ status: 'unverified', detail: 'Interactive shell tool probe timed out after 5 seconds.' })
        resolve({ status: 'unverified', detail: `Interactive shell tool probe failed (${String(error.code ?? error.signal ?? 'unknown error')}).` })
      },
    )
  })
  return detailed ? result : result.status === 'available'
}

/**
 * What `command args…` prints on both streams, and its exit status, run in the interactive shell a new agent launches
 * through, so it finds the Node and PATH the engine will. Windows has no such shell: there it is run as a pane would run
 * [engine] (an npm shim as node on its script, lib/windows/launch.ts), with its console hidden (docs/windows-rules.md).
 * Null when it gave no answer within 5 seconds, or could not be started.
 */
export async function commandOutputInInteractiveShell(engine: AgentEngine, command: string, args: readonly string[], shell: string | undefined = undefined): Promise<{ code: number; output: string } | null> {
  const interactive = interactiveEngineShell(shell)
  let run: string[]
  try {
    run = interactive
      ? engineShellArgv(interactive, ['"$@" 2>&1', 'harness-engine-output', command, ...args])
      : windowsEngineArgv(engine, [command, ...args])
  } catch (error) {
    // A shim Windows will not run (lib/windows/launch.ts): the launch itself says why.
    console.warn(`[engine] ${engine} not run · ${errorKind(error)}`)
    return null
  }
  const [file, ...argv] = run
  return await new Promise((resolve) => {
    execFile(file, argv, { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
      resolve(code === null || error?.killed ? null : { code, output: `${stdout}\n${stderr}` })
    })
  })
}
