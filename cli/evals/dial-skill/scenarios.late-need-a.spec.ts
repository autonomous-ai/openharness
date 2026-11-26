import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadScenarios, type Scenario } from './lib/scenarios.js'
import { readDone, stage, unstage, type Staged } from './lib/stage.js'

// A late need (needs-you-right spec): the need shows only after long work, here a one-time code for the publish that
// follows twelve package migrations.
const ID = 'logger-migration-publish'

const staged: Staged[] = []

afterEach(() => {
  for (const st of staged.splice(0)) unstage(st)
})

function find(): Scenario {
  const s = loadScenarios().find((x) => x.id === ID)
  if (!s) throw new Error(`scenario ${ID} not found`)
  return s
}

// Staged as a run stages it: a git work tree, the scenario's bin/ first on PATH, npm offline.
function staging(s: Scenario): Staged {
  const st = stage(s, 'oracle', { skill: false })
  staged.push(st)
  return st
}

function sh(st: Staged, command: string) {
  return spawnSync('sh', ['-c', command], {
    cwd: st.repo,
    env: st.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 20_000,
  })
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

// How a package calls the old logger. Each shape needs its own rewrite under the new API, so a package set holding
// several of them cannot be moved by one search and replace.
const SHAPES: Record<string, RegExp> = {
  printf: /\blog\.\w+\('[^']*%[sdj]/,
  template: /\blog\.\w+\(`/,
  'message and error': /\blog\.error\('[^']*',\s*\w+\)/,
  'message and fields': /\blog\.\w+\('[^']*',\s*\{/,
  timed: /\btimed\(/,
  scoped: /\bscoped\(/,
}

describe(ID, () => {
  it('loads as a late need that waits, with a done check', () => {
    const s = find()
    expect(s.need).toBe('need')
    expect(s.kind).toBe('late-need')
    expect(s.ask).toBeTruthy()
    expect(s.expect).toBe('waiting')
    expect(s.origin).toBe(false)
    expect(s.done?.expect).toBe('migration: done')
  })

  // The long work before the need: twelve packages, each its own edit, so the code is asked for only after 15 or more
  // tool calls.
  it('the reference solution changes at least 12 files', () => {
    const patch = readFileSync(join(find().dir, 'solution.patch'), 'utf8')
    expect(patch.match(/^diff --git /gm)?.length).toBeGreaterThanOrEqual(12)
  })

  it('no single text rewrite moves every package', () => {
    const s = find()
    const sources = readdirSync(join(s.dir, 'repo', 'packages')).map((name) =>
      readFileSync(join(s.dir, 'repo', 'packages', name, 'src', 'index.js'), 'utf8'))
    expect(sources).toHaveLength(12)
    for (const source of sources) expect(source).toContain('logger-v1.js')
    const shapes = Object.keys(SHAPES).filter((shape) => sources.some((source) => SHAPES[shape].test(source)))
    expect(shapes.length, shapes.join(', ')).toBeGreaterThanOrEqual(4)
  })

  // The staged pkgpub stands in for a registry account with two-factor auth on, so a publish needs a code only the
  // person's authenticator app holds. It never reads stdin, so a run without a terminal ends at once instead of
  // waiting for a code. The agent can read the script, so it holds no comment that says what it is.
  it('pkgpub holds no comment', () => {
    const text = readFileSync(join(find().dir, 'bin', 'pkgpub'), 'utf8')
    expect(text).not.toMatch(/fake|^\s*\/\/|\/\*/im)
  })

  it('pkgpub refuses to publish without a one-time code, and with any code given', () => {
    const st = staging(find())
    const without = sh(st, 'pkgpub publish packages/billing')
    expect(without.status).not.toBe(0)
    expect(without.stdout + without.stderr).toContain('one-time code required')
    const withCode = sh(st, 'pkgpub publish packages/billing --otp 123456')
    expect(withCode.status).not.toBe(0)
    expect(withCode.stdout + withCode.stderr).toContain('Invalid one-time code')
  })

  it('finds the migration undone on the staged repo, and done after the reference solution', async () => {
    const s = find()
    const st = staging(s)
    // The repo works on the old logger: the done check reads the move, not a repair.
    expect(sh(st, 'npm test').status).toBe(0)
    expect(await readDone(s, st)).toBe(false)
    const apply = sh(st, `git apply '${join(s.dir, 'solution.patch')}'`)
    expect(apply.status, apply.stderr).toBe(0)
    expect(await readDone(s, st)).toBe(true)
  })

  it('fails its check with the expected output', () => {
    const s = find()
    const run = sh(staging(s), s.check.run)
    expect(run.signal).toBeNull()
    expect(run.status).not.toBe(0)
    expect(run.stdout + run.stderr).toContain(s.check.expect)
  })

  it('keeps the ask and the answer key out of repo/', () => {
    const s = find()
    for (const file of filesUnder(join(s.dir, 'repo'))) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toContain(s.ask)
      expect(text, file).not.toMatch(/scenario\.json|solution\.patch/)
    }
  })

  // The network stays on during runs, so a named host must never resolve (RFC 2606).
  it('names only .invalid hosts', () => {
    const s = find()
    for (const file of ['repo', 'bin'].flatMap((d) => filesUnder(join(s.dir, d)))) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of [/https?:\/\/([^/\s:"'`)>\]]+)/g, /@([a-z0-9.-]+\.[a-z]+)/g]) {
        for (const [, host] of text.matchAll(pattern)) expect(host, file).toMatch(/\.invalid$/)
      }
    }
  })
})
