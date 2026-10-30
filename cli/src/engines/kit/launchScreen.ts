/**
 * What an engine's declared screen (facets/launch.ts `ScreenContract`) adds to a launch: its argv, ahead of the
 * launch's own extra arguments, and its variables. In a pane's script the variables are set after the person's
 * rc files (lib/engineLaunch.ts), where a launch has no script they go through `/usr/bin/env`, and a run from an
 * existing prompt (shellLaunch.ts) hands them to the child's environment.
 */
import type { EngineLaunch } from '../facets/launch.js'
import { shellSingleQuote } from '../../lib/shellQuote.js'

type Launch = Pick<EngineLaunch, 'screen'> | undefined

/** A name a POSIX shell and `env` both take; any other is left out rather than written into a script. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

function variablesOf(launch: Launch): { clear: string[]; set: Array<[string, string]> } {
  const screen = launch?.screen
  return {
    clear: (screen?.clearEnvironment ?? []).filter((name) => VARIABLE.test(name)),
    set: Object.entries(screen?.environment ?? {}).filter(([name]) => VARIABLE.test(name)),
  }
}

/** The argv the screen declares, or none. */
export function screenArgs(launch: Launch): string[] {
  return [...(launch?.screen?.args ?? [])]
}

/** The script's lines that clear and then set the screen's variables, or ''. */
export function screenPrelude(launch: Launch): string {
  const { clear, set } = variablesOf(launch)
  return (clear.length ? `unset ${clear.join(' ')}\n` : '')
    + set.map(([name, value]) => `export ${name}=${shellSingleQuote(value)}\n`).join('')
}

/** The same variables as an `/usr/bin/env` prefix, for a launch run with no script; none when there are none. */
export function screenEnvPrefix(launch: Launch): string[] {
  const { clear, set } = variablesOf(launch)
  if (!clear.length && !set.length) return []
  return ['/usr/bin/env', ...clear.flatMap((name) => ['-u', name]), ...set.map(([name, value]) => `${name}=${value}`)]
}

/** The variables the screen sets, as an environment: what a Windows launch sends in the pane's env instead of the
 *  `/usr/bin/env` prefix, which Windows has no program for (lib/engineLaunch.ts `engineLaunchEnv`). */
export function screenVariables(launch: Launch): Record<string, string> {
  return Object.fromEntries(variablesOf(launch).set)
}

/** `inherited` with the screen's variables cleared and set, as a copy. */
export function screenEnvironment(launch: Launch, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { clear, set } = variablesOf(launch)
  const environment = { ...inherited }
  for (const name of clear) delete environment[name]
  for (const [name, value] of set) environment[name] = value
  return environment
}
