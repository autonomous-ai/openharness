import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadScenarios, type Scenario } from './lib/scenarios.js'

const IDS = [
  'add-version-flag',
  'commit-new-branch',
  'env-from-example',
  'fix-off-by-one',
  'install-vendored-dep',
  'rename-across-files',
]

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dial-skill-no-need-'))
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
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

// The same shape as a staged run (Task 4): no person's PATH, home, git or npm config, npm offline.
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

function sh(command: string, cwd: string, e: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const r = spawnSync('sh', ['-c', command], { cwd, env: e, encoding: 'utf8', timeout: 25_000 })
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

describe.each(IDS)('%s', (id) => {
  it('is a no-need scenario without an ask', () => {
    const s = scenario(id)
    expect(s.need).toBe('no-need')
    expect(s.ask).toBeNull()
  })

  it('keeps its answer key out of repo/', () => {
    const s = scenario(id)
    for (const file of filesUnder(join(s.dir, 'repo'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/scenario\.json|solution\.(patch|sh)/)
    }
  })

  it('fails its check before the reference solution and passes it after', () => {
    const s = scenario(id)
    const e = env()
    const repo = stagedCopy(s, e)

    const before = sh(s.check.run, repo, e)
    expect(before.status, before.output).not.toBe(0)
    expect(before.output).toContain(s.check.expect)

    const patch = join(s.dir, 'solution.patch')
    const solve = existsSync(patch)
      ? sh(`git apply '${patch}'`, repo, e)
      : sh(`sh '${join(s.dir, 'solution.sh')}'`, repo, e)
    expect(solve.status, solve.output).toBe(0)

    const after = sh(s.check.run, repo, e)
    expect(after.status, after.output).toBe(0)
  })
})
