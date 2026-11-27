import { startEnvironment } from '../lib/startEnvironment.js'

/**
 * The text of the env file (HARNESS_ENV_FILE) for a daemon a test starts through `harness start` or `harness start -f`:
 * one `NAME='value'` line for each of [names] that [env] sets and a start on [platform] leaves out, then [more].
 *
 * Since 2026-11-17 a start gives the daemon only an allowlist of its shell's environment
 * (docs/plans/2026-11-17-daemon-minimal-env-design.md), so any harness setting the allowlist does not name would never
 * reach the daemon under test. The env file is where the product says such a variable goes, so a test puts it there too.
 * Only the harness's settings ([names]) and a test's own lines ([more]) are written: a variable a test sets to see it
 * dropped stays dropped.
 *
 * Throws, naming the variable and never its value, on a value a single-quoted line cannot hold as written.
 */
export function startEnvFile(env: NodeJS.ProcessEnv, names: readonly string[], more: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): string {
  const kept = startEnvironment(env, platform)
  const lines: Array<[string, string]> = []
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && !(name in kept)) lines.push([name, value])
  }
  lines.push(...Object.entries(more))
  return lines.map(([name, value]) => {
    if (/['\r\n]/.test(value)) throw new Error(`${name} holds a single quote or a line break, which an env file line cannot hold as written`)
    return `${name}='${value}'\n`
  }).join('')
}
