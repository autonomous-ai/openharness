import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitEnv } from '../lib/gitProject.js'
import { goalRows } from './goal.js'
import { GOAL_READER, GOAL_TEXT, goalWorkflow, showGoal, startGoal } from './goalStarter.js'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
const folder = () => { const made = mkdtempSync(join(tmpdir(), 'goal-starter-')); folders.push(made); return made }
/** git as a checkout whose root is [root] and whose origin's main branch is [head] answers. */
const git = (root: string | null, head: string | null) => async (_cwd: string, args: readonly string[]) => args[0] === 'rev-parse' ? root : head
/** A real git, in a throwaway folder and nowhere else: never the repository a test run stands in, whatever GIT_DIR says. */
const realGit = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(process.env), encoding: 'utf8' })
const ROW = '| what must be true | `the command that proves it` |'

describe('a project\'s goal file and its workflow, written into a checkout', () => {
  it('writes both where they are not, naming the main branch as the checkout knows it, and says what to do next', async () => {
    const root = folder()
    expect(await startGoal(join(root, 'cli'), git(root, 'origin/trunk'))).toEqual({ ok: true, said: 'Wrote agents/GOAL.md and .github/workflows/goal.yml. '
      + `Add a row to agents/GOAL.md for each milestone: ${ROW} `
      + 'Then commit both on a branch of yours and open a pull request, as for any change. The checks run on trunk once it lands.' })
    expect(readFileSync(join(root, 'agents/GOAL.md'), 'utf8')).toBe(GOAL_TEXT)
    expect(readFileSync(join(root, '.github/workflows/goal.yml'), 'utf8')).toBe(goalWorkflow('trunk'))
    // The file as written states no milestone: a project with it and no row has no goal yet.
    expect(goalRows(GOAL_TEXT)).toEqual([])
  })

  it('leaves alone what is there, a link to nowhere too, and says which', async () => {
    const root = folder()
    mkdirSync(join(root, 'agents'))
    writeFileSync(join(root, 'agents/GOAL.md'), '| Sync works | `npm test` |\n')
    expect(await startGoal(root, git(root, 'origin/main'))).toEqual({ ok: true, said: 'Wrote .github/workflows/goal.yml (agents/GOAL.md was there already). '
      + `Add a row to agents/GOAL.md for each milestone: ${ROW} `
      + 'Then commit it on a branch of yours and open a pull request, as for any change. The checks run on main once it lands.' })
    expect(readFileSync(join(root, 'agents/GOAL.md'), 'utf8')).toBe('| Sync works | `npm test` |\n')
    expect(await startGoal(root, git(root, 'origin/main'))).toEqual({ ok: true, said: `agents/GOAL.md and .github/workflows/goal.yml are there already. Add a row to agents/GOAL.md for each milestone: ${ROW}` })
    // A link whose target is not there is not written through: nothing outside the checkout comes to be.
    const linked = folder(), outside = join(folder(), 'elsewhere.md')
    mkdirSync(join(linked, 'agents'))
    symlinkSync(outside, join(linked, 'agents/GOAL.md'))
    expect((await startGoal(linked, git(linked, 'origin/main'))).said).toContain('(agents/GOAL.md was there already)')
    expect(existsSync(outside)).toBe(false)
    // Nor a folder of the checkout that is a link to elsewhere: nothing is written outside it.
    const through = folder(), elsewhere = folder()
    symlinkSync(elsewhere, join(through, 'agents'))
    expect(await startGoal(through, git(through, 'origin/main'))).toEqual({ ok: false, said: 'agents is a link: nothing was written.' })
    expect(existsSync(join(elsewhere, 'GOAL.md'))).toBe(false)
    expect(existsSync(join(through, '.github'))).toBe(false)
    // The second file's folder is looked at before the first file is written, and a link to nowhere is said, not thrown.
    for (const target of [folder(), join(folder(), 'nowhere')]) {
      const second = folder()
      symlinkSync(target, join(second, '.github'))
      expect(await startGoal(second, git(second, 'origin/main'))).toEqual({ ok: false, said: '.github is a link: nothing was written.' })
      expect(existsSync(join(second, 'agents'))).toBe(false)
      expect(existsSync(join(target, 'workflows'))).toBe(false)
    }
    // What it cannot write for another reason is the command's failure.
    const blocked = folder()
    writeFileSync(join(blocked, 'agents'), 'a file where the folder goes')
    await expect(startGoal(blocked, git(blocked, 'origin/main'))).rejects.toThrow()
  })

  it('names main where the checkout does not say its main branch, or says one that is no branch\'s name', async () => {
    for (const head of [null, '', 'origin/"] }\nrun: evil', 'origin/' + 'x'.repeat(201)]) {
      const root = folder()
      await startGoal(root, git(root, head))
      expect(readFileSync(join(root, '.github/workflows/goal.yml'), 'utf8')).toBe(goalWorkflow('main'))
    }
  })

  it('writes nothing outside a git repository, and says so', async () => {
    const root = folder()
    for (const none of [null, '']) {
      expect(await startGoal(root, git(none, null))).toEqual({ ok: false, said: 'This folder is in no git repository: run it in your checkout of the project.' })
    }
    expect(existsSync(join(root, 'agents'))).toBe(false)
  })

  // Under a git hook of a linked worktree GIT_DIR names another repository than the folder's: the files were written into the
  // folder the command stood in, cli/ of this very repository (the goal's first review).
  it('reads the folder\'s own repository with git itself, whatever GIT_DIR says', async () => {
    const root = folder(), other = folder()
    realGit(root, ['init', '-q', '-b', 'main', root])
    realGit(other, ['init', '-q', '-b', 'main', other])
    realGit(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'])
    mkdirSync(join(root, 'sub/deeper'), { recursive: true })
    const before = process.env.GIT_DIR
    process.env.GIT_DIR = join(other, '.git')
    try { expect((await startGoal(join(root, 'sub/deeper'))).said).toContain('The checks run on trunk once it lands.') } finally {
      if (before === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = before
    }
    expect(existsSync(join(root, 'agents/GOAL.md'))).toBe(true)
    expect(existsSync(join(root, 'sub/deeper/agents'))).toBe(false)
    // A repository that names no origin is checked on main.
    expect((await startGoal(other)).said).toContain('The checks run on main once it lands.')
  })
})

describe('the workflow that checks a goal', () => {
  const text = goalWorkflow('main')
  it('runs on the main branch alone, each check under the name Harness looks for, its command as a variable', () => {
    expect(text).toContain('    branches: ["main"]\n')
    expect(text).toContain('    name: "goal: ${{ matrix.milestone }}"\n')
    expect(text).toContain('      - run: bash -eo pipefail -c "$CHECK"\n        env:\n          CHECK: ${{ matrix.check }}\n')
    expect(text).toContain('        include: ${{ fromJSON(needs.rows.outputs.rows) }}\n')
    expect(text).toContain("    if: needs.rows.outputs.rows != '[]'\n")
    expect(text).toContain('permissions:\n  contents: read\n')
    // No row's words are ever part of the script: only these expressions carry them.
    expect(text.match(/\$\{\{[^}]*\}\}/g)).toEqual(['${{ steps.read.outputs.rows }}', '${{ fromJSON(needs.rows.outputs.rows) }}', '${{ matrix.milestone }}', '${{ matrix.check }}'])
    expect(text).not.toMatch(/@@\{|\}@@/)
  })

  it('lets one failing check fail alone, runs one push at a time, and lets no job hold a runner for long', () => {
    expect(text).toContain('    strategy:\n      fail-fast: false\n      max-parallel: 10\n')
    // One run at a time, and the one in hand is never cancelled: however fast landings come, some landing's checks end.
    expect(text).toContain('concurrency:\n  group: goal\n  cancel-in-progress: false\n')
    expect(text).toContain('  rows:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n')
    expect(text).toContain('    runs-on: ubuntu-latest\n    timeout-minutes: 30\n')
    // The rows are read from the commit that was pushed.
    expect(text).toContain('    steps:\n      - uses: actions/checkout@v4\n      - id: read\n')
  })

  // What CI names a check must be what Harness looks for, row for row: the same file read by the workflow's own lines, taken
  // from its text and run as it runs them, and by goal.ts.
  it('reads a goal file exactly as Harness reads it', () => {
    const step = /\n {8}run: \|\n {10}node - <<'JS' >> "\$GITHUB_OUTPUT"\n([\s\S]*?)\n {10}JS\n/.exec(text)
    expect(step).not.toBeNull()
    const script = step![1]!.split('\n').map(line => line.slice(10)).join('\n')
    expect(script).toBe(GOAL_READER)
    const files = ['# Goal\n\n| Milestone | Check |\n|---|---|\n| Settings sync offline | `npm test -- sync.offline` |\n  |  The  app   starts | `scripts/start --under 1000`|\n',
      '| Sync | `a` |\r\n| Sync | `b` |\n| Start | `c | d` |\n| No check | npm test |\n| Empty | ` ` |\n| ' + 'x'.repeat(101) + ' | `a` |\n| ' + 'y'.repeat(100) + ' | `b` |\nnot a row\n| Only one |\n',
      Array.from({ length: 105 }, (_, n) => `| Milestone ${n} | \`check "${n}" && echo '$HOME' \` |`).join('\n'), '', '| “Quotes” & <tags> ☃ | `echo "${{ secrets.X }}"` |\n',
      '﻿| With a mark before it | `a` |\n|\tTabs\tand spaces\t|\t`b`\t|\n| rows=[] | `c` |\n| A | `x`y` |\n',
      `| Just fits | \`${'b'.repeat(1_000 - 18)}\` |\n| One too long | \`${'b'.repeat(1_000 - 20)}\` |\n| a${' '.repeat(50_000)}| x\n`,
      // A milestone of space alone is no row, and the slowest line there was is read at once: in the workflow as in goal.ts.
      `|  | \`x\` |\n| Kept | \`y\` |\n|${' '.repeat(998)}a\n`]
    for (const file of files) {
      const root = folder()
      mkdirSync(join(root, 'agents'))
      writeFileSync(join(root, 'agents/GOAL.md'), file)
      // On stdin, as the workflow's heredoc gives it.
      const said = execFileSync(process.execPath, ['-'], { cwd: root, input: script, encoding: 'utf8' })
      expect(said.startsWith('rows=')).toBe(true)
      expect(said.trimEnd().split('\n')).toHaveLength(1)
      expect(JSON.parse(said.slice('rows='.length))).toEqual(goalRows(file))
    }
  })
})

// `harness super-tab goal` alone: what the checkout's goal states, written nowhere (anh Dee's Lou, 2026-11-12, ran it to see).
describe('a project\'s goal, shown from a checkout', () => {
  it('says there is none yet, and how to start one once its person says what the project is for, writing nothing', async () => {
    const root = folder()
    expect(await showGoal(join(root, 'cli'), git(root, 'origin/main'))).toEqual({ ok: true, said: 'This project states no goal yet: '
      + 'agents/GOAL.md is not in this checkout. Ask your person what the project is for, then `harness super-tab goal write` '
      + 'writes agents/GOAL.md and the workflow that checks it.' })
    expect(existsSync(join(root, 'agents'))).toBe(false)
    expect(existsSync(join(root, '.github'))).toBe(false)
  })

  it('lists the milestones a goal file states and their checks, and says when its workflow is missing or it states none', async () => {
    const root = folder()
    mkdirSync(join(root, 'agents'))
    writeFileSync(join(root, 'agents/GOAL.md'), GOAL_TEXT)
    expect(await showGoal(root, git(root, null))).toEqual({ ok: true, said: `agents/GOAL.md states no milestone yet. Add a row for each: ${ROW} `
      + 'Its workflow, .github/workflows/goal.yml, is not in this checkout: `harness super-tab goal write` writes it.' })
    writeFileSync(join(root, 'agents/GOAL.md'), `${GOAL_TEXT}| Builds | \`npm run build\` |\n| Tests pass | \`npm test\` |\n`)
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/goal.yml'), goalWorkflow('main'))
    expect(await showGoal(root, git(root, null))).toEqual({ ok: true, said: 'agents/GOAL.md states 2 milestones, each checked on the '
      + 'main branch by .github/workflows/goal.yml:\n- Builds: `npm run build`\n- Tests pass: `npm test`' })
    // One milestone, its workflow gone.
    rmSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, 'agents/GOAL.md'), `${GOAL_TEXT}| Builds | \`npm run build\` |\n`)
    expect(await showGoal(root, git(root, null))).toEqual({ ok: true, said: 'agents/GOAL.md states 1 milestone, each checked on the '
      + 'main branch:\n- Builds: `npm run build`\nIts workflow, .github/workflows/goal.yml, is not in this checkout: `harness super-tab goal write` writes it.' })
    // A file far larger than any goal is not read: no milestone is listed from it.
    writeFileSync(join(root, 'agents/GOAL.md'), `${GOAL_TEXT}| Builds | \`npm run build\` |\n${'x'.repeat(300 * 1024)}\n`)
    expect((await showGoal(root, git(root, null))).said).toMatch(/^agents\/GOAL\.md states no milestone yet\./)
  })

  it('reads no goal through a link, and none outside a repository', async () => {
    const root = folder(), elsewhere = folder()
    writeFileSync(join(elsewhere, 'GOAL.md'), `${GOAL_TEXT}| Secret | \`cat x\` |\n`)
    mkdirSync(join(root, 'agents'))
    symlinkSync(join(elsewhere, 'GOAL.md'), join(root, 'agents/GOAL.md'))
    expect((await showGoal(root, git(root, null))).said).toBe('agents/GOAL.md is not a plain file (a link or a folder): it was not read.')
    const other = folder()
    mkdirSync(join(other, 'agents/GOAL.md'), { recursive: true })
    expect((await showGoal(other, git(other, null))).said).toBe('agents/GOAL.md is not a plain file (a link or a folder): it was not read.')
    expect(await showGoal(root, git(null, null))).toEqual({ ok: false, said: 'This folder is in no git repository: run it in your checkout of the project.' })
  })
})
