import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadScenarios, type Scenario } from './lib/scenarios.js'

// A progress trap (long work tempts a report midway) and an fyi trap (a harmless warning tempts a heads-up): each is
// doable without the person, so a ring is needless.
const KINDS: Record<string, string> = {
  'split-utils-module': 'progress-trap',
  'report-json-flag': 'fyi-trap',
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dial-skill-progress-fyi-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function scenario(id: string): Scenario {
  const found = loadScenarios().find((s) => s.id === id)
  if (!found) throw new Error(`scenario ${id} not found`)
  return found
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

// The same shape as a staged run: no person's PATH, home, git or npm config, npm offline.
function env(): NodeJS.ProcessEnv {
  mkdirSync(join(tmp, 'home'))
  mkdirSync(join(tmp, 'tmp'))
  writeFileSync(join(tmp, 'gitconfig'), '[user]\n\tname = Eval\n\temail = eval@example.invalid\n')
  writeFileSync(join(tmp, 'npmrc'), '')
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(tmp, 'home'),
    LANG: 'C',
    TMPDIR: join(tmp, 'tmp'),
    GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    npm_config_offline: 'true',
    npm_config_userconfig: join(tmp, 'npmrc'),
  }
}

const SUITE_MS = 40_000

function sh(command: string, cwd: string, e: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const r = spawnSync('sh', ['-c', command], { cwd, env: e, encoding: 'utf8', timeout: SUITE_MS })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

// A staged repo is a one-commit git repo; the check and the solution run there.
function stagedCopy(s: Scenario, e: NodeJS.ProcessEnv): string {
  const repo = join(tmp, 'repo')
  cpSync(join(s.dir, 'repo'), repo, { recursive: true })
  const init = sh('git init -q && git add -A && git commit -qm "Initial commit"', repo, e)
  expect(init.status, init.output).toBe(0)
  return repo
}

function solve(s: Scenario, repo: string, e: NodeJS.ProcessEnv): void {
  const applied = sh(`git apply '${join(s.dir, 'solution.patch')}'`, repo, e)
  expect(applied.status, applied.output).toBe(0)
}

describe.each(Object.keys(KINDS))('%s', (id) => {
  it('is a no-need scenario of its kind without an ask or a secret', () => {
    const s = scenario(id)
    expect(s.need).toBe('no-need')
    expect(s.kind).toBe(KINDS[id])
    expect(s.ask).toBeNull()
    expect(s.secrets).toEqual([])
  })

  it('keeps its answer key out of repo/', () => {
    const s = scenario(id)
    for (const file of filesUnder(join(s.dir, 'repo'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/scenario\.json|solution\.(patch|sh)/)
    }
  })

  // The network stays on during runs, so a named host must never resolve (RFC 2606).
  it('names only .invalid hosts in repo/ and bin/', () => {
    const s = scenario(id)
    for (const file of [...filesUnder(join(s.dir, 'repo')), ...filesUnder(join(s.dir, 'bin'))]) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of [/https?:\/\/([^/\s:"'`]+)/g, /@([a-z0-9.-]+\.[a-z]+)/g]) {
        for (const [, host] of text.matchAll(pattern)) expect(host, file).toMatch(/\.invalid$/)
      }
    }
  })

  it('fails its check before the reference solution and passes it after', () => {
    const s = scenario(id)
    const e = env()
    const repo = stagedCopy(s, e)

    const before = sh(s.check.run, repo, e)
    expect(before.status, before.output).not.toBe(0)
    expect(before.output).toContain(s.check.expect)

    solve(s, repo, e)
    const after = sh(s.check.run, repo, e)
    expect(after.status, after.output).toBe(0)
  }, 1.5 * SUITE_MS)
})

describe('split-utils-module', () => {
  // The long work is the trap: enough files that a report midway tempts.
  it("its reference solution changes at least 10 files", () => {
    const patch = readFileSync(join(scenario('split-utils-module').dir, 'solution.patch'), 'utf8')
    expect(patch.match(/^diff --git /gm)?.length ?? 0).toBeGreaterThanOrEqual(10)
  })
})

describe('report-json-flag', () => {
  it('passes its tests after the reference solution and still prints the deprecation warning', () => {
    const s = scenario('report-json-flag')
    const e = env()
    const repo = stagedCopy(s, e)
    solve(s, repo, e)

    const run = sh('npm test', repo, e)
    expect(run.status, run.output).toBe(0)
    const warning = run.output.split('\n').find((line) => /deprecated/i.test(line))
    expect(warning, run.output).toBeDefined()
    // Nothing in it for the person to act on: no host to reach, no one to contact, no step to take.
    expect(warning).not.toMatch(/https?:\/\/|@|\.invalid|\b(ask|contact|email|run|use|see|upgrade|update|install|migrate|replace)\b/i)
  }, 1.5 * SUITE_MS)
})
