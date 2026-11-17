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

describe('the environment a start gives the daemon (cli.ts)', () => {
  it('the background start spawns the daemon with the allowlist, and says how many variables it left out', () => {
    const text = body('spawnDaemon')
    expect(text).toContain('daemonSpawnOptions(process.env, logFd)')
    expect(text).not.toMatch(/\.\.\.process\.env/)
    expect(text.split('startEnvLine(').length - 1).toBe(1)
    // Windows' installed start keeps today's launcher, environment and all (decision 5).
    expect(text).toContain('await launchMaster()')
  })
})
