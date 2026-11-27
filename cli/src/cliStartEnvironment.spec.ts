/**
 * `harness start` hands the daemon only the allowlist of the shell that ran it (lib/startEnvironment.ts,
 * docs/plans/2026-11-17-daemon-minimal-env-design.md). The places are in cli.ts, which runs as a process and cannot
 * be loaded here: what each calls is asserted on the source, as cliStopFirst.spec.ts does, and the functions are
 * tested where they live. Pull request CI runs no end-to-end file, so this is what holds the wiring there.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(import.meta.dirname, 'cli.ts'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
  .replace(/(^|[^:])\/\/[^\n]*/gm, (match, lead: string) => lead + ' '.repeat(match.length - lead.length))

/** A top-level function's body, to its closing brace at column 0. */
function body(name: string): string {
  const from = SOURCE.indexOf(`async function ${name}(`)
  expect(from, `cli.ts still defines ${name}`).toBeGreaterThan(-1)
  return SOURCE.slice(from, SOURCE.indexOf('\n}\n', from))
}

/** Where `call` first appears in [text], after [after] when given. */
function at(text: string, call: string, after = 0): number {
  const index = text.indexOf(call, after)
  expect(index, `still calls ${call}`).toBeGreaterThan(-1)
  return index
}

describe('the environment a start gives the daemon (cli.ts)', () => {
  it('the background start spawns the daemon with the allowlist, and says how many variables it left out', () => {
    const text = body('spawnDaemon')
    expect(text).toContain('daemonSpawnOptions(process.env, logFd)')
    expect(text).not.toMatch(/\.\.\.process\.env/)
    expect(text.split('startEnvLine(').length - 1).toBe(1)
    // Windows' installed start keeps today's launcher, environment and all (decision 5).
    expect(text).toContain('await launchMaster()')
  })

  it('a start that becomes the daemon narrows this process before the master or the core starts in it', () => {
    const text = body('launch')
    const refusal = at(text, 'refuseServedDataFolder(')
    const master = at(text, 'startMasterInForeground(')
    const first = at(text, 'narrowOwnEnvironment(')
    // After the refusal beside a running daemon: a start that leaves at once says nothing of an environment.
    expect(first).toBeGreaterThan(refusal)
    expect(first).toBeLessThan(master)
    // And again where the core runs alone in this process: HARNESS_NO_MASTER=1 (Harness OS) and a dev run alike.
    const condition = "if (foreground || SCRIPT_PATH.endsWith('.ts'))"
    const branch = at(text, condition, master) + condition.length
    const second = at(text, 'narrowOwnEnvironment(', branch)
    expect(second).toBeLessThan(at(text, 'runCoreInForeground(', branch))
    // Its first statement, under no further condition: the dev run is narrowed too (decision 8).
    expect(text.slice(branch, second)).not.toMatch(/\bif \(/)
  })
})
