/**
 * A project's goal file and the workflow that checks it, written into an agent's checkout: `harness super-tab goal`.
 *
 * Harness scores a goal from checks named `goal: <milestone>` on the main branch (goal.ts) and runs none itself: the
 * repository's CI does. What reads the file there must read it exactly as Harness does, row for row, or a milestone waits for
 * ever on a check that has another name. So the two files are written by code, from here, and not typed by an agent from a
 * description: the workflow's reader is the same few lines as goal.ts goalRows (a test runs the workflow's own text and
 * goalRows on the same files).
 *
 * Only written: the agent commits them on a branch of its own and opens a pull request as for any change, so they are read by
 * another agent and land on the train. A file that is there already is left as it is.
 */
import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitEnv } from '../lib/gitProject.js'
import { GOAL_CHECK, GOAL_FILE, GOAL_MAX, LINE_MAX, MILESTONE_MAX } from './goal.js'

const GOAL_WORKFLOW = '.github/workflows/goal.yml'

/** The goal file a project starts from: what it is, and the table's head. No row: a milestone is the project's to write. */
export const GOAL_TEXT = `# Goal

What this project is for, as checks. One row for each milestone: what must be true, and the command that proves it, in
backticks. CI runs each command on the main branch (\`${GOAL_WORKFLOW}\`), and a milestone is done when its check passes
there. Harness tells the project's PM and its channel how many pass. A command that needs a pipe goes in a script.

| Milestone | Check |
|---|---|
`

/** The lines of the workflow that read the goal file, as goal.ts goalRows reads it: a table row whose second cell is a command
 *  in backticks, a milestone once, at most [GOAL_MAX] of [MILESTONE_MAX] characters, from lines of [LINE_MAX] at most. Node,
 *  as every GitHub runner has it. */
export const GOAL_READER = String.raw`const rows = new Map()
for (const line of require('fs').readFileSync('${GOAL_FILE}', 'utf8').split(/\r?\n/)) {
  if (line.length > ${LINE_MAX}) continue
  const row = line.trim(), cell = row.slice(0, -1).trimEnd(), open = cell.lastIndexOf('\x60', cell.length - 2)
  const head = cell.slice(0, open).trimEnd(), named = head.slice(1, -1).trim()
  if (!row.startsWith('|') || !row.endsWith('|') || !cell.endsWith('\x60') || open < 0 || !head.endsWith('|')) continue
  const milestone = /[\r\u2028\u2029]/.test(named) ? '' : named.replace(/\s+/g, ' '), check = cell.slice(open + 1, -1).trim()
  if (!milestone || !check || milestone.length > ${MILESTONE_MAX} || rows.has(milestone)) continue
  rows.set(milestone, { milestone, check })
  if (rows.size >= ${GOAL_MAX}) break
}
console.log('rows=' + JSON.stringify([...rows.values()]))`

/** The workflow, for a repository whose main branch is [base]: one job reads the rows, and one job for each runs its check
 *  under the name Harness looks for. A check is the repository's own command, on its main branch only, where what it runs was
 *  read and landed as any change; it reaches the shell as a variable, never as text of the script, and fails when any part of
 *  it does (`-eo pipefail`). One run at a time: a push while one runs waits its turn, and a newer push takes that turn, so
 *  some landing's checks always end however fast landings come (cancelling the run in hand, none ever did). Harness looks at
 *  the last five landings only (goal.ts): where landings come faster than that, it scores the one furthest through. Ten
 *  checks run at once and each has half an hour, so a goal holds no runner for long. */
export const goalWorkflow = (base: string): string => `# Runs each check of ${GOAL_FILE} on the main branch, as a check named "${GOAL_CHECK}<milestone>".
# Harness reads those to show how far the project is from its goal. Add what your checks need (a toolchain, a cache) to the goal job's steps.
name: goal
on:
  push:
    branches: [${JSON.stringify(base)}]
permissions:
  contents: read
concurrency:
  group: goal
  cancel-in-progress: false
jobs:
  rows:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      rows: @@{ steps.read.outputs.rows }@@
    steps:
      - uses: actions/checkout@v4
      - id: read
        run: |
          node - <<'JS' >> "$GITHUB_OUTPUT"
${GOAL_READER.split('\n').map(line => `          ${line}`).join('\n')}
          JS
  goal:
    needs: rows
    if: needs.rows.outputs.rows != '[]'
    strategy:
      fail-fast: false
      max-parallel: 10
      matrix:
        include: @@{ fromJSON(needs.rows.outputs.rows) }@@
    name: "${GOAL_CHECK}@@{ matrix.milestone }@@"
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: bash -eo pipefail -c "$CHECK"
        env:
          CHECK: @@{ matrix.check }@@
`.replaceAll('@@{', '${{').replaceAll('}@@', '}}')

/** The first line of git's answer in [cwd], or null when git has none (no repository, no such ref, no git). With none of the
 *  variables that point git at another repository than the folder's own (lib/gitProject.ts gitEnv): run under a git hook of a
 *  linked worktree, the files were written into the folder the command stood in, not the checkout's root. */
const gitLine = (cwd: string, args: readonly string[]): Promise<string | null> => new Promise(resolve => {
  execFile('git', args, { cwd, timeout: 10_000, windowsHide: true, env: gitEnv(process.env) }, (error, stdout) => resolve(error ? null : String(stdout).trim().split('\n')[0]!))
})

/**
 * Writes the goal file and its workflow into the repository [cwd] is in, each only where nothing is there yet (not even a
 * link to nowhere), and neither when a folder on the way to one is a link (nothing is written through a link, to elsewhere
 * or to nowhere), and says what to do next in words an agent reads. The workflow names the main branch as the checkout
 * knows it (origin's HEAD), `main` when it does not say; the answer says which, as a checkout can be behind a rename.
 */
export async function startGoal(cwd: string, git: (cwd: string, args: readonly string[]) => Promise<string | null> = gitLine): Promise<{ ok: boolean; said: string }> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!root) return { ok: false, said: 'This folder is in no git repository: run it in your checkout of the project.' }
  // A branch's name is git's own, and goes into the workflow as a quoted string.
  const head = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.replace(/^origin\//, '')
  const base = head && /^[\w./-]{1,200}$/.test(head) ? head : 'main'
  const files = [[GOAL_FILE, GOAL_TEXT], [GOAL_WORKFLOW, goalWorkflow(base)]] as const
  // Both files' folders are looked at before either file is written: a link refuses the whole command, not its second half.
  for (const [path] of files) {
    for (let folder = dirname(path); folder !== '.'; folder = dirname(folder)) {
      if (lstatSync(join(root, folder), { throwIfNoEntry: false })?.isSymbolicLink()) return { ok: false, said: `${folder} is a link: nothing was written.` }
    }
  }
  const wrote: string[] = [], kept: string[] = []
  for (const [path, text] of files) {
    const file = join(root, path)
    // Whatever is there, a link to nowhere too: lstat does not follow it, so nothing is written through one.
    if (lstatSync(file, { throwIfNoEntry: false })) { kept.push(path); continue }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    wrote.push(path)
  }
  const row = '| what must be true | `the command that proves it` |'
  if (!wrote.length) return { ok: true, said: `${GOAL_FILE} and ${GOAL_WORKFLOW} are there already. Add a row to ${GOAL_FILE} for each milestone: ${row}` }
  return { ok: true, said: `Wrote ${wrote.join(' and ')}${kept.length ? ` (${kept[0]} was there already)` : ''}. Add a row to ${GOAL_FILE} for each milestone: ${row} `
    + `Then commit ${wrote.length > 1 ? 'both' : 'it'} on a branch of yours and open a pull request, as for any change. The checks run on ${base} once it lands.` }
}
