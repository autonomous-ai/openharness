# harnessd's processes show their environment in their command line: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **devcrew phase 3**. Tasks 1 and 2 are test-first: a red commit
> (the tests alone), then the code commit. Tasks 3 and 4 change tests only and are one commit each; the cases that
> fail before them are named. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No process of the daemon shows a variable of its environment where its arguments are read (`pgrep -f` on
macOS), and a test fails if one ever does again.

**Architecture:** Delete the two `process.title` assignments (the master's and every service process's). A process
keeps the one name it already has: the hard link of the managed Node it is started through
(`cli/src/harnessd/processName.ts`). Three tests hold it: an end-to-end test that reads a real daemon's processes
the way `pgrep -fl` does, two unit assertions, and an architecture spec that fails on any `process.title` assignment
under `cli/src`. The end-to-end files that found the daemon's processes by their title, or counted on the title
hiding them, are moved to the master's own log and the process tree.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node (arm64 v22.23.5 on this Mac; CI pins 24.22.2), `pgrep`, `ps`, tmux,
zsh. No new dependency.

**Spec:** [docs/plans/2026-11-17-harnessd-process-title-env-design.md](2026-11-17-harnessd-process-title-env-design.md).
Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/harnessd/AGENTS.md`. The spec is the
authority. Branch `fix/harnessd-process-title-env`, on `main` at `b9a7280863`.

## Decided

By the PM, 2026-11-17 (the spec and the brief). Not reopened:

1. Remove both assignments: `cli/src/harnessd/master.ts:281` and `cli/src/serviceProcess.ts:107`.
2. Three tests: end to end with a real `IsolatedDaemon`, a sentinel variable and at least one service process, read
   the way `pgrep -fl` reads (macOS) or from `/proc/<pid>/cmdline` (Linux); unit, `runMaster` and
   `startServiceProcess` leave `process.title` alone; architecture, no `process.title` assignment in a non-test file
   under `cli/src`.
3. The daemon inheriting its starter's whole environment (`cli/src/cli.ts:1727`) is out of scope.
4. The end-to-end test runs on this Mac, by the tester. No temporary workflow.

The plan's own, each from what the code showed (below):

5. The end-to-end test is a new file, `cli/e2e/processArguments.e2e.ts`, so it shares no file with Tasks 2 to 4.
6. It puts the sentinel **first** in the daemon's environment. A variable further down was never shown, and a test
   with it there passes on the broken code.
7. It carries a control on macOS: a process of the test's own that sets a title must show the sentinel to the same
   reader. Without it, a reader that sees nothing reads as a pass.
8. It also asserts that each process shows its own arguments (`__harnessd`, `__run`, `__service search`). That is
   what makes it fail on Linux before the fix too, where no environment shows, so the nightly Linux run can catch a
   title that comes back.
9. The end-to-end files that read the title are fixed in this pull request (Tasks 2 to 4). See open question 1.

## Open questions

For the PM, in one message. The draft says what it assumes until then.

1. **Thirteen end-to-end files depend on the title, and the spec names none of them.** Eleven find a service
   process or the master by a `ps` match on `harnessd`, `harnessd-edge`, `harnessd-search` and the like; two list
   "every process of this build" by path and passed only because the title hid the master and the services from
   that list. With the title gone they fail (one, `leftBehind`, goes quietly weaker). **The draft assumes** they
   are fixed here, in Tasks 2 to 4, since the nightly CLI end to end would otherwise be red on them from the merge
   on. Agreed, or another route? A no drops Tasks 2 to 4 and checks 4 and 5.
2. **One run of the existing "CLI end to end" workflow on the branch** (Actions, Run workflow; Linux, eight shards
   and the macOS full-disk job, once, on the final head). **The draft assumes** yes: those thirteen files change
   what they read, `ps` prints differently on Linux, a dependence the search missed would show there, and one file
   (`sharedTabs`) needs the real backend's services, which that workflow sets up. It is the repo's own workflow,
   not a temporary one. Agreed?
3. **The spec's manual check** (`pgrep -fl harnessd` on your Mac after the release) is against your own running
   daemon and needs the released build. **The draft assumes** it stays yours, after the release, and is no gate of
   this pull request.

## Global Constraints

- Platforms, from the spec: macOS (the leak); Linux and Windows (the same change, nothing to see). Not in the core.
- Tests use one made-up sentinel value, never a real variable, and read only processes they started themselves.
- **Never `pgrep -f` or `pgrep -fl` without `-g <a group the test started>`, and never `ps e` or `ps -E`,** in a
  test, a step or a check. On this Mac the developer's own daemon still shows its environment that way until it
  runs the fixed build, and the listing would land in a log. Never paste such a listing anywhere.
- A failing assertion prints process names and pids, never what was read.
- Only `IsolatedDaemon` daemons: throwaway home and data folder, private tmux server, fake engines, signed out.
  Never the developer's daemon (port 18473), tmux server, `~/.harness`, `~/.claude` or `~/.codex`
  (`cli/AGENTS.md`, rule 6).
- Only your own processes. Other sessions run end-to-end tests on this Mac: end nothing by name.
- No fixed sleeps: `until` with a deadline. Comments say why, in plain sentences.
- `cli/src/harnessd/` stays at 100% per file (`npm run test:harnessd`).
- `cli/src/cli.ts:1727` is not touched.

## Found while reading the code

- **Where the title is set.** Only the two lines. Under `cli/e2e` and `cli/scripts` a title is set only by fake
  engines and other stand-ins for programs that are not Harness's. They stay.
- **What `pgrep` shows, measured on this Mac** (a process of the probe's own, a made-up environment): with a title,
  `pgrep -fl -g <its group> .` prints the title and then the environment's first `argc - 1` strings (four for five
  arguments, two for three). A variable below those is not printed. `ps -o command=` prints the title alone. With no
  title, both print the real arguments.
- **Why the sentinel must be moved.** `daemonEnvironment` (`cli/src/testing/daemonEnvironment.ts`) puts a test's own
  variables last. Node hands a child its `env` in key order, `process.env` lists in the block's order, and the
  master gives the core and each service `{ ...env, ...extra }` (`master.ts:286`, `:397`, `:457`), so first stays
  first. Measured here through one Node parent that hands on `{ ...process.env, … }` to a child that sets a title:
  the child showed the sentinel first. For the daemon's own service, Task 1's red run is the measurement.
- **A daemon under test has no name link.** It runs on the run's Node, outside the managed runtime
  (`cli/src/testing/testNode.ts`), so `namedNode` links nothing. With no title, `ps` shows
  `<node> … __harnessd`, `… __run` and `… __service <names>`, on Linux as on macOS (the title replaced the
  arguments there too).
- **The title was load-bearing in the end-to-end suite, two ways.** (a) Found by it: helpers keep the pids the
  master logged whose `ps` command is exactly `harnessd-<name>`. (b) Hidden by it: `nothingOrphaned` in
  `reexec.e2e.ts` and `updateHostile.e2e.ts` lists every process whose command names this install's `cli.js` or
  lean folder and requires each to be a core under the master. The master and the services were not in that list
  only because their command line was a title.
- **Nothing in the product reads the title.** No file under `cli/src`, `desktop/`, `device-app/`, `backend/`, `os/`
  or `scripts/` matches a daemon process by `harnessd…` in a process listing. The scans over the whole process
  table (`lib/processTable.ts`, `lib/sessionSearch/externals/`) go by executable name or package entry point, never
  a word in the arguments, and have always seen the core as `<node> <cli.js> __run`.
- **What exists to build on.** `harnessdProcesses(d)` (`cli/e2e/harness/endurance.ts`) maps `master`, `core` and
  each service process to its pid from the master's log. Pure functions of the harness have unit specs under
  `cli/src/testing/` that import `e2e/harness/daemon.js` untyped (`daemonListeningPort.spec.ts`).
- **Where the checks run.** Pull request CI runs the unit suite on Linux. The end-to-end suite runs nightly and by
  hand (`.github/workflows/cli-e2e.yml`, Linux, `E2E_BUNDLE=1`). `scripts/local-checks.py` names `cli-harnessd`
  (`npm run test:harnessd`) for `cli/src/harnessd/*`; no other local gate covers these paths.
- **This worktree has no `cli/node_modules`:** `npm ci` in `cli/` first.

## File map

| Task | File | What |
|---|---|---|
| 1 | `cli/e2e/processArguments.e2e.ts` (new) | the end-to-end red test |
| 1 | `cli/src/architecture.processTitle.spec.ts` (new) | no `process.title` assignment under `cli/src` |
| 1 | `cli/src/serviceProcess.spec.ts`, `cli/src/harnessd/master.spec.ts` | the title is left alone |
| 1 | `cli/src/harnessd/master.ts`, `cli/src/serviceProcess.ts` | the fix |
| 1 | `cli/src/harnessd/services.ts`, `cli/src/harnessd/processName.ts` | comments |
| 1 | `cli/src/harnessd/AGENTS.md`, `cli/AGENTS.md`, `docs/design/2026-10-03-harnessd.md` | one sentence each |
| 2 | `cli/src/testing/daemonServicePids.spec.ts` (new) | unit spec of the helper |
| 2 | `cli/e2e/harness/daemon.ts` | `loggedServicePids`, `IsolatedDaemon.servicePids` |
| 2 | `cli/e2e/harness/desk.ts`, `cli/e2e/serviceProcesses.e2e.ts`, `agentBrowser.e2e.ts`, `gatewayProcess.e2e.ts`, `recapsProcess.e2e.ts`, `handoff.e2e.ts`, `shell.e2e.ts`, `sharedTabs.e2e.ts`, `leftBehind.e2e.ts` | found by the master's log and the process tree |
| 3 | `cli/e2e/lean.e2e.ts`, `cli/e2e/cli.e2e.ts` | assert the real arguments |
| 3 | `cli/e2e/developerState.e2e.ts`, `releaseRehearsal.e2e.ts`, `footprint.e2e.ts` | comments only |
| 4 | `cli/e2e/reexec.e2e.ts`, `cli/e2e/updateHostile.e2e.ts` | `nothingOrphaned` counts the master and the services |

No two tasks share a file.

## Review Focus

Most likely first. Each has its test, or the reason it has none.

1. **The end-to-end test passes without seeing anything** (the sentinel not among the first strings, or a reader
   that prints no arguments). Pinned by Task 1's control on macOS and by its red run, from sources and from the
   bundle.
2. **A title comes back by a door the architecture spec cannot see** (`node --title=…`, a dependency, an alias of
   `process`). Pinned by Task 1's end-to-end assertion that each process shows its own arguments, which fails on
   Linux and macOS alike.
3. **The master after it re-executed itself on the lean bundle,** the product's normal state: three arguments, so
   two environment strings showed. Pinned by running the end-to-end test with `E2E_BUNDLE=1` (Task 1, Verification
   2; the nightly run uses it).
4. **A pid the master logged is a stranger's now** (the service died and the number was taken). Pinned by Task 2's
   unit case "leaves out a pid that has gone, or is a stranger's now".
5. **A scan of the whole process table now sees the master's and the services' real arguments,** which name
   `engine-claude`, `engine-codex` and `cli.js`. No test: the matchers go by executable name or package entry
   point (`heuristicEngineProcessMatchScore`), and the core has had this shape since harnessd began. A reviewer
   reads `lib/processTable.ts:771-816` once with that in mind.

---

### Task 1: The fix, and its three tests

**Depends on:** nothing. **Effort:** xhigh (a secret in a process listing; a red test that can pass by seeing
nothing).

**Files:**
- Create: `cli/e2e/processArguments.e2e.ts`
- Create: `cli/src/architecture.processTitle.spec.ts`
- Modify: `cli/src/serviceProcess.spec.ts:29-30`, `:67`, `:85`
- Modify: `cli/src/harnessd/master.spec.ts:293-296`, and its first `runMaster` case (`:312-351`)
- Modify: `cli/src/harnessd/master.ts:281`
- Modify: `cli/src/serviceProcess.ts:103-107`, `:136`
- Modify (comment): `cli/src/harnessd/services.ts:15`, `cli/src/harnessd/processName.ts` (header)
- Modify (one sentence): `cli/src/harnessd/AGENTS.md` (rule 8), `cli/AGENTS.md:63-64`,
  `docs/design/2026-10-03-harnessd.md:133-134`

**The tests that fail before the change:** `e2e/processArguments.e2e.ts` (on macOS, the sentinel shows; on Linux,
the arguments are a title); `src/architecture.processTitle.spec.ts`, "no file of the daemon sets a process title";
`src/serviceProcess.spec.ts`, "runs the one it is named…" and "runs several in one process…";
`src/harnessd/master.spec.ts`, "starts the core through a link named after it…".

**Interfaces:**
- Produces: no process of the daemon has a title. In `ps` and `pgrep -f` the master's arguments end ` __harnessd`,
  the core's ` __run`, a service process's ` __service <its services, comma-separated>`. Tasks 2 to 4 read these.

- [ ] **Step 1: The end-to-end test**

`cli/e2e/processArguments.e2e.ts`. The header says why (the incident of 2026-11-17, the mechanism in three
sentences, the spec's path) and the two rules: it reads only groups it started, and never `pgrep -f` without `-g`.

```ts
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { processTable } from '../src/testing/spawnedRuns.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'

/** A value no real variable holds. */
const SENTINEL = `sentinel-${randomBytes(8).toString('hex')}`

/** What a reader of arguments is shown for each process of the group [pgid] leads, by pid: `pgrep -fl` on macOS,
 *  `/proc/<pid>/cmdline` on Linux. */
function shownArguments(pgid: number): Map<number, string> {
  if (process.platform === 'darwin') {
    // `.`: every process of the group. Never without -g: that lists every process on the machine.
    const listed = execFileSync('pgrep', ['-fl', '-g', String(pgid), '.'], { encoding: 'utf8' })
    return new Map(listed.split('\n').flatMap((line) => {
      const row = /^(\d+) (.*)$/.exec(line)
      return row ? [[Number(row[1]), row[2]] as const] : []
    }))
  }
  // A probe the daemon ran (`ps`, `lsof`) can be gone between the listing and the read: left out.
  const read = (pid: number): string | null => {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { return null }
  }
  return new Map(processTable().filter((row) => row.pgid === pgid).flatMap((row) => {
    const shown = read(row.pid)
    return shown === null ? [] : [[row.pid, shown] as const]
  }))
}

describe('the daemon\'s processes', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('show their own arguments, and no variable of their environment, where arguments are read', async () => {
    const d = daemon = await IsolatedDaemon.create({ env: { HARNESSD_SERVICES: 'search' } })
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}`) })
    // First in the environment: after a title, pgrep -f showed the environment's first strings, one fewer than the
    // process had arguments (two for `node cli.js __harnessd`). A variable further down was never shown.
    const rest = { ...d.env }
    for (const name of Object.keys(d.env)) delete d.env[name]
    Object.assign(d.env, { E2E_ARGUMENTS_SENTINEL: SENTINEL }, rest)

    // The control, on macOS: a process of the test's own, with this environment, that sets a title shows the
    // sentinel to this reader. Without it a reader that saw nothing would pass for a daemon that leaks.
    if (process.platform === 'darwin') {
      const control = spawn(process.execPath,
        ['-e', 'process.title = "control"; process.stdout.write("up\\n"); setTimeout(() => {}, 30_000)'],
        { env: d.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
      try {
        await new Promise((up) => control.stdout!.once('data', up))
        expect(shownArguments(control.pid!).get(control.pid!)?.includes(SENTINEL),
          'the reader sees the environment of a process that sets a title').toBe(true)
      } finally { try { process.kill(-control.pid!, 'SIGKILL') } catch { /* gone */ } }
    }

    await d.start()
    await until('search to connect to the core', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    const shown = shownArguments(d.pid!)
    const logged = harnessdProcesses(d)
    const ends = { master: ' __harnessd', core: ' __run', search: ' __service search' }
    const own = Object.keys(ends).map((name) => [name, logged.get(name)] as const)
    // Names only, in every message: a failure prints nothing of what was read.
    expect(own.filter(([, pid]) => !pid || !shown.has(pid)).map(([name]) => name), 'processes of the daemon that were not read').toEqual([])
    expect(own.filter(([, pid]) => shown.get(pid!)!.includes(SENTINEL)).map(([name]) => name),
      'processes whose arguments show a variable of their environment').toEqual([])
    expect(own.filter(([name, pid]) => !shown.get(pid!)!.trimEnd().endsWith(ends[name as keyof typeof ends])).map(([name]) => name),
      'processes whose arguments are not their own').toEqual([])
  })
})
```

- [ ] **Step 2: The architecture spec**

`cli/src/architecture.processTitle.spec.ts`, shaped as `cli/src/architecture.environment.spec.ts`: the TypeScript
parser, so a comment or a string is no finding. Its header comment carries the reason: on Unix libuv writes the
title over the start of the argument area and blanks the rest; on macOS the environment follows that area and
`pgrep -f` printed its first variables as arguments (2026-11-17, a session token among them); a process is named by
the hard link it is started through (`harnessd/processName.ts`). And its limits: an alias (`const p = process`),
`Object.assign`, `Object.defineProperty` or `Reflect.set` on `process`, `node --title=…` and a script kept as text
are not reached; `e2e/processArguments.e2e.ts` reads the real processes.

`function titleWrites(code: string, file = 'file.ts'): string[]`: one `line N: process.title` for each assignment
(`=` or a compound one) whose left side, through parentheses and `as`, is `.title` or `['title']` on `process`,
`globalThis.process` or `global.process`.

```ts
it.each([
  "process.title = 'harnessd'",
  'process.title = `harnessd-${name}`',
  "process['title'] = name",
  "process.title += ' (core)'",
  "globalThis.process.title = 'harnessd'",
  "global.process.title = 'harnessd'",
  "(process as NodeJS.Process).title = 'harnessd'",
  'if (named) process.title = named',
])('finds %s', (code) => expect(titleWrites(code)).not.toEqual([]))

it.each([
  "// process.title = 'harnessd'",
  'const script = "process.title = \'codex\'"',
  'const script = `process.title = ${JSON.stringify(engine)}`',
  'const title = process.title',
  "if (process.title === 'node') start()",
  "document.title = 'Harness'",
  'pane.title = name',
  'this.process.title = name',
])('passes %s', (code) => expect(titleWrites(code)).toEqual([]))

it('no file of the daemon sets a process title', () => {
  // Every .ts, .tsx, .js, .mjs and .cjs under cli/src that is not a .spec. or .test. file, as the environment spec lists them.
  const found = files.flatMap((file) => titleWrites(readFileSync(join(SRC, file), 'utf8'), file).map((finding) => `${file}: ${finding}`))
  expect(found, 'No process of the daemon sets process.title: on macOS the title is written over the process\'s arguments, '
    + 'and `pgrep -f` then prints the first variables of its environment in their place. A process is named by the hard link '
    + 'it is started through (harnessd/processName.ts).').toEqual([])
})
```

- [ ] **Step 3: The two unit specs**

`cli/src/serviceProcess.spec.ts`: `:29` stays (`const title = process.title`, read before any case runs). `:30`
loses `process.title = title;`. `:67` and `:85` become `expect(process.title).toBe(title)`, under one comment at
`:67`: named by the link it was exec'd through and nothing else; a title put its environment in `pgrep -f` on macOS.

`cli/src/harnessd/master.spec.ts`: delete the comment at `:293` and `const title` at `:294`; `:296` loses
`; process.title = title`. In the first case, "starts the core through a link named after it, so Activity Monitor
tells it from node" (the first `runMaster` this file runs in its own process), read `const title = process.title`
before `runMaster(` and add, after the three `readFileSync` expectations:
`expect(process.title, 'the link is its only name').toBe(title)`.

- [ ] **Step 4: See them fail, and commit them**

```bash
cd cli && npm ci
npx vitest run src/architecture.processTitle.spec.ts src/serviceProcess.spec.ts src/harnessd/master.spec.ts
```

Expected: 4 failed. The architecture case names `harnessd/master.ts: line 281: process.title` and
`serviceProcess.ts: line 107: process.title`; its `finds` and `passes` rows pass. Two cases in
`serviceProcess.spec.ts` and one in `master.spec.ts` fail on the title.

```bash
npx vitest run --config vitest.e2e.config.ts e2e/processArguments.e2e.ts
E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/processArguments.e2e.ts
```

Expected on this Mac, both runs: 1 failed, on
`processes whose arguments show a variable of their environment: expected [ 'master', 'search' ] to deeply equal []`.
**If it passes, or fails on the control or on "were not read": stop and report.** The test does not see the leak,
and the fix must not be written against it. (A run that stops on a TMPDIR too long for a socket says so: use
`TMPDIR=/private/tmp/ptitle/`.)

```bash
git add cli/e2e/processArguments.e2e.ts cli/src/architecture.processTitle.spec.ts cli/src/serviceProcess.spec.ts cli/src/harnessd/master.spec.ts
git commit -m "harnessd: no process shows its environment in its arguments (red tests)"
```

- [ ] **Step 5: The fix**

`cli/src/harnessd/master.ts`: delete line 281.

`cli/src/serviceProcess.ts`: delete line 107. The local `title` (`:106`, used at `:136`) titles nothing now: rename
it `processName`. The comment above it (`:103-105`) becomes:

```ts
  // The master names the process (`edge` for the services it shares); a process started by hand is named for what
  // it runs. The name is on its lines in the log. What ps and Activity Monitor call it is the hard link it was
  // exec'd through (harnessd/processName.ts), never a title: on macOS a title put the process's environment where
  // `pgrep -f` reads its arguments (architecture.processTitle.spec.ts).
```

- [ ] **Step 6: The comments and the three sentences**

- `cli/src/harnessd/services.ts:15`: "The process's name: what the master logs it as, and the hard link it is
  started through (`harnessd-<name>`, ./processName.ts)."
- `cli/src/harnessd/processName.ts`, end of the header's first paragraph, one sentence more: "The link is the only
  name: no process sets `process.title`, which on macOS put its environment where `pgrep -f` reads its arguments
  (../architecture.processTitle.spec.ts)."
- `cli/src/harnessd/AGENTS.md`, rule 8: ", titled the same." becomes ". No process sets `process.title`: on macOS a
  title puts the process's environment where `pgrep -f` reads its arguments
  (`../architecture.processTitle.spec.ts`)."
- `cli/AGENTS.md:63`: "In Activity Monitor and `ps`" becomes "In Activity Monitor, `top` and `ps -c`".
- `docs/design/2026-10-03-harnessd.md:133-134`: "as `harnessd <service>` with its own process title" becomes "as
  `harnessd-<service>`, the name of the hard link it runs through (it sets no process title)".

- [ ] **Step 7: See them pass**

```bash
npx vitest run src/architecture.processTitle.spec.ts src/architecture.environment.spec.ts src/serviceProcess.spec.ts src/harnessd/master.spec.ts
npm run typecheck
npm run test:harnessd
npx vitest run --config vitest.e2e.config.ts e2e/processArguments.e2e.ts
E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/processArguments.e2e.ts
```

Expected: every case passes; the typecheck prints no error; `test:harnessd` holds 100% in every file; the
end-to-end file is `1 passed` both ways.

- [ ] **Step 8: Commit**

```bash
git add cli/src/harnessd/master.ts cli/src/serviceProcess.ts cli/src/harnessd/services.ts cli/src/harnessd/processName.ts \
  cli/src/harnessd/AGENTS.md cli/AGENTS.md docs/design/2026-10-03-harnessd.md
git commit -m "harnessd: no process sets a title, which showed its environment to pgrep -f on macOS"
```

---

### Task 2: The end-to-end helpers that found a service process by its title

**Depends on:** Task 1 (the cases below fail only at its head, and the new matches read arguments that are there
only without a title). **Effort:** high.

**Files:**
- Create: `cli/src/testing/daemonServicePids.spec.ts`
- Modify: `cli/e2e/harness/daemon.ts` (one exported function, one method)
- Modify: `cli/e2e/harness/desk.ts:14-21`
- Modify: `cli/e2e/serviceProcesses.e2e.ts:42-52`, `:183-189`, `:365-371`
- Modify: `cli/e2e/agentBrowser.e2e.ts:192-199`, `cli/e2e/gatewayProcess.e2e.ts:29-35`,
  `cli/e2e/recapsProcess.e2e.ts:47-53`
- Modify: `cli/e2e/handoff.e2e.ts:165-168`, `cli/e2e/shell.e2e.ts:67-70`, `cli/e2e/sharedTabs.e2e.ts:226-229`,
  `:375-378`
- Modify: `cli/e2e/leftBehind.e2e.ts:22-25`, `:195-196`

**The tests that fail before the change:** the new unit spec (the function is not there); `leftBehind.e2e.ts`'s new
expectation (Step 1); and, at Task 1's head, every case that calls one of these helpers, the first being
`e2e/serviceProcesses.e2e.ts`, "search runs in its own process and answers through the core, for both engines"
(`expected 0 to be greater than or equal to 1`).

**Interfaces:**
- Consumes: Task 1's arguments (` __service <names>`).
- Produces, in `cli/e2e/harness/daemon.ts`:
  - `export function loggedServicePids(log: string, name: string, master: number | null, table: ReadonlyArray<{ pid: number; ppid: number }>): number[]`:
    the pids of the master's `[harnessd] service <name> started (pid N)` lines in `log`, in order and once each,
    whose row in `table` has `ppid === master`. None with no master.
  - `IsolatedDaemon.servicePids(name: string): number[]`:
    `loggedServicePids(this.log(), name, this.pid, processTable())`, with `processTable` from
    `src/testing/spawnedRuns.ts`. `name` is the service process's (`search`, `edge`, `models`, `gateway`, `devices`,
    `agentBrowser`).

- [ ] **Step 1: The unit spec, and `leftBehind`'s expectation**

`cli/src/testing/daemonServicePids.spec.ts`, importing as `daemonListeningPort.spec.ts` does:

```ts
const started = (name: string, pid: number, again = '') => `2026-11-17 10:00:00.000 [harnessd] service ${name} started (pid ${pid})${again}\n`
const log = started('search', 41) + started('edge', 42) + started('search', 55, ' · restart 1')

it('lists the pids the master logged for a service process that are still its children', () => {
  const table = [{ pid: 41, ppid: 7 }, { pid: 42, ppid: 7 }, { pid: 55, ppid: 7 }]
  expect(loggedServicePids(log, 'search', 7, table)).toEqual([41, 55])
  expect(loggedServicePids(log, 'edge', 7, table)).toEqual([42])
})

// The title did this before: a pid the master logged can be anyone's once that process has gone.
it('leaves out a pid that has gone, or is a stranger\'s now', () => {
  expect(loggedServicePids(log, 'search', 7, [{ pid: 55, ppid: 7 }])).toEqual([55])
  expect(loggedServicePids(log, 'search', 7, [{ pid: 41, ppid: 1 }, { pid: 55, ppid: 7 }])).toEqual([55])
})

it('lists none with no master, for a process the master never started, or for a longer name', () => {
  expect(loggedServicePids(log, 'search', null, [{ pid: 41, ppid: 7 }])).toEqual([])
  expect(loggedServicePids(log, 'models', 7, [{ pid: 41, ppid: 7 }])).toEqual([])
  expect(loggedServicePids(started('searchers', 41), 'search', 7, [{ pid: 41, ppid: 7 }])).toEqual([])
})
```

`cli/e2e/leftBehind.e2e.ts`, before `:195`: at Task 1's head its helper returns the master alone, and no
expectation notices.

```ts
    expect(daemonProcesses(started.master).length, 'the master and a service process at the least').toBeGreaterThanOrEqual(2)
```

- [ ] **Step 2: See them fail, and commit them**

```bash
cd cli && npx vitest run src/testing/daemonServicePids.spec.ts          # 3 failed: loggedServicePids is not a function
npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts -t 'once the worker that started it'   # 3 failed, on the new line
npx vitest run --config vitest.e2e.config.ts e2e/serviceProcesses.e2e.ts -t 'search runs in its own process'   # 1 failed, expected 0 to be >= 1
git add cli/src/testing/daemonServicePids.spec.ts cli/e2e/leftBehind.e2e.ts
git commit -m "CLI e2e: a service process is found by its master's log and its parent (red tests)"
```

- [ ] **Step 3: The function and the method**

In `cli/e2e/harness/daemon.ts`, as Interfaces says. The method's comment says why not by name: no process has a
title, and a daemon under test runs on a Node with no name link, so `ps` shows `node` for every one of them.

- [ ] **Step 4: Each helper becomes one call**

Names and callers stay; each body is `d.servicePids('<name>')`, and its comment says "started by its own master, by
the pid it logged, and still its child" in place of "titled …":

| File | Helper | Name |
|---|---|---|
| `serviceProcesses.e2e.ts` | `searchPids`, `edgePids`, `modelsPids` | `search`, `edge`, `models` |
| `agentBrowser.e2e.ts` | `browserPids` | `agentBrowser` |
| `gatewayProcess.e2e.ts` | `gatewayPids` | `gateway` |
| `recapsProcess.e2e.ts` | `edgePids` | `edge` |
| `harness/desk.ts` | `devicesPids` (exported; its four callers do not change) | `devices` |

Three places read the edge host's pid inline:

- `handoff.e2e.ts:165-168`: `const pid = d.servicePids('edge').at(-1)`, then
  `expect(pid, 'the edge host this master runs').toBeDefined()`, and `pid!` at the kill.
- `shell.e2e.ts:67-70`: `const edgePid = d.servicePids('edge').at(-1)`, the same expectation, and `edgePid!` at the
  kill.
- `sharedTabs.e2e.ts:226-229` and `:375-378`: `const edge = A.d.servicePids('edge').at(-1)` (`B.d`, `edgeB` at
  `:375`), `expect(edge, 'an edge host process').toBeDefined()`, `process.kill(edge!, 'SIGKILL')`. Its
  `processes()` stays: `:111` prints it as evidence.

Remove each import the change leaves unused (`execFileSync` in six of these files; `handoff.e2e.ts` keeps its).

One difference to keep in mind: a pid is listed from the master's "started" line on, at the spawn, where the title
appeared a moment later. Three waits read a helper as "running": `serviceProcesses.e2e.ts:679`, `:687` and
`gatewayProcess.e2e.ts:154`. They keep their meaning (a kill or a stop at boot is what those cases are about, and
the gateway case backs off 10 s), and Step 6 runs them.

- [ ] **Step 5: `leftBehind`'s own helper**

`cli/e2e/leftBehind.e2e.ts:22-25` reads another worker's daemon, so it has no `IsolatedDaemon` to ask. Its filter
`/^harnessd-/.test(row.command)` becomes `/ __service \S+$/.test(row.command)`, and its comment names the arguments
(`__service …`) in place of `harnessd-<process>`.

- [ ] **Step 6: See them pass**

```bash
npx vitest run src/testing/daemonServicePids.spec.ts src/testing/daemonListeningPort.spec.ts
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/serviceProcesses.e2e.ts e2e/recapsProcess.e2e.ts \
  e2e/gatewayProcess.e2e.ts e2e/agentBrowser.e2e.ts e2e/devicesProcess.e2e.ts e2e/devicesOnDemand.e2e.ts \
  e2e/wifiDevice.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/handoff.e2e.ts e2e/shell.e2e.ts e2e/leftBehind.e2e.ts
```

Expected: every file passes. A case that fails and calls none of these helpers is reported by name and left alone.
`sharedTabs.e2e.ts` needs the real backend's in-memory Mongo and Redis (`HARNESS_E2E_SERVICES_DIR`): run it here
only if this Mac has them; otherwise it is Verification 5's.

- [ ] **Step 7: Commit**

```bash
git add cli/e2e/harness/daemon.ts cli/e2e/harness/desk.ts cli/e2e/serviceProcesses.e2e.ts cli/e2e/agentBrowser.e2e.ts \
  cli/e2e/gatewayProcess.e2e.ts cli/e2e/recapsProcess.e2e.ts cli/e2e/handoff.e2e.ts cli/e2e/shell.e2e.ts \
  cli/e2e/sharedTabs.e2e.ts cli/e2e/leftBehind.e2e.ts
git commit -m "CLI e2e: a service process is found by its master's log and its parent, not by a title"
```

---

### Task 3: The end-to-end cases that asserted the title

**Depends on:** Task 1 (the new expectations are true only without a title). Not on Task 2: `lean.e2e.ts` has its
own `servicePids`, by the log. **Effort:** high (two slow files; the rest is comments).

**Files:**
- Modify: `cli/e2e/lean.e2e.ts:95-103`, `:108-113`
- Modify: `cli/e2e/cli.e2e.ts:198`, `:220-222`, `:263`
- Modify (comment only): `cli/e2e/developerState.e2e.ts:243-244`, `cli/e2e/releaseRehearsal.e2e.ts:90-93`,
  `cli/e2e/footprint.e2e.ts:11-13`, `:76-80`

**The cases that fail before the change,** at Task 1's head: `lean.e2e.ts`, "re-executes the master, same pid, on
the lean bundle, and runs every service and the core from it"; `cli.e2e.ts`, "without the service: start runs a
master and core…" and both "with the service installed for this data folder…". Each fails on
`expected '<node> … __harnessd' to be 'harnessd'`. One commit: tests only.

- [ ] **Step 1: See them fail**

```bash
cd cli && npx vitest run --config vitest.e2e.config.ts e2e/lean.e2e.ts -t 're-executes the master'
npx vitest run --config vitest.e2e.config.ts e2e/cli.e2e.ts -t 'start runs a master and core'
```

- [ ] **Step 2: `lean.e2e.ts`**

The command line now says what the log said, so the case reads it:

- `:103` becomes
  ``expect(commandOf(master).endsWith(` ${lean} __harnessd`), 'the master runs on the lean bundle').toBe(true)``.
- `:113` becomes
  ``for (const [name, pid] of servicePids(d)) expect(commandOf(pid).includes(` ${lean} __service `), `${name} runs from the lean bundle`).toBe(true)``.
- The comment at `:95-96` loses "titles itself `harnessd`, so" and gains "Its command line says the same." The
  comment at `:108-109` keeps its first sentence only; the wait under it stays (it proves the stamped lines).

- [ ] **Step 3: `cli.e2e.ts`**

- `:222` and `:263`: `expect(commandOf(master)).toMatch(/ __harnessd$/)` (`first` at `:263`). The pid in the pid
  file is harnessd's master, by its own arguments, whether or not it has re-executed on the lean bundle.
- `:220`: "(it retitles itself)" goes. `:198`: "The core's line: the master starts the core on its own Node."

- [ ] **Step 4: The three comments**

- `developerState.e2e.ts:243-244`: "The core's line: the master starts the core on its own Node."
- `releaseRehearsal.e2e.ts:90-93`: "(never by what ps shows: an older release's master and services rename
  themselves, this build's do not)".
- `footprint.e2e.ts:11-13`: "Each is named by the hard link it runs through, in a release, or by the pid the master
  logged it under." `:76-80`: "What a process is called: the name of the hard link it runs through (`harnessd`,
  `harnessd-core`, `harnessd-edge`…), which the master gives it in a release (harnessd/processName.ts); else the
  name the master logged its pid under; else `other: <program>`." `nameOf` itself does not change: it already falls
  back to the log.

- [ ] **Step 5: See them pass, and commit**

```bash
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/lean.e2e.ts e2e/cli.e2e.ts
git add cli/e2e/lean.e2e.ts cli/e2e/cli.e2e.ts cli/e2e/developerState.e2e.ts cli/e2e/releaseRehearsal.e2e.ts cli/e2e/footprint.e2e.ts
git commit -m "CLI e2e: the master and the services are known by their arguments, not by a title"
```

Expected: both files pass whole. The three comment-only files are not run.

---

### Task 4: `nothingOrphaned` counts the master and the services

**Depends on:** Task 1 (the master and the services are in the listing only without a title). **Effort:** high
(update and re-execution scenarios; each file builds its own bundles).

**Files:**
- Modify: `cli/e2e/reexec.e2e.ts:72-88`, `:231`
- Modify: `cli/e2e/updateHostile.e2e.ts:296-309`

**The cases that fail before the change,** at Task 1's head: `reexec.e2e.ts`, "replaces the master with the new
build in its own process: same pid, and the core and the agent carry on"
(`timed out after 10000ms waiting for only the master's own children`), and `updateHostile.e2e.ts`'s first
scenario, in `settled` (`…waiting for only the master's own core`). One commit: tests only.

- [ ] **Step 1: See them fail**

```bash
cd cli && npx vitest run --config vitest.e2e.config.ts e2e/reexec.e2e.ts -t 'replaces the master with the new build'
```

`updateHostile.e2e.ts` fails the same way in every scenario's `settled`, 15 s each: seeing `reexec`'s is enough
before the edit.

- [ ] **Step 2: Both `nothingOrphaned`**

`daemonProcesses()` stays as it is in both files; its comment says it now lists the master and the services too.
What it must hold becomes: every process of this install is the master, or the master's child running a core or
services. A probe (`… __harnessd-probe`) or an updater's canary still waits to end, as before.

```ts
    const own = (one: { pid: number; ppid: number; command: string }) =>
      one.pid === masterPid || (one.ppid === masterPid && / __(?:run|service \S+)$/.test(one.command))
    await until('only the master and its own children', () => daemonProcesses().every(own), 10_000, 200)
    expect(daemonProcesses().filter((one) => one.command.endsWith(' __run'))).toHaveLength(1)
```

In `updateHostile.e2e.ts` the same with `this.daemonProcesses()`, `master` for `masterPid`, and its own 15 s.

- [ ] **Step 3: `reexec.e2e.ts:231`**

The master died as it re-executed; a service it had stopped can still be on its way out, and the title used to hide
it. The claim is the same, with a deadline:

```ts
    await until('nothing left running in its name', () => daemonProcesses().length === 0 || null, 10_000, 200)
```

- [ ] **Step 4: See them pass, and commit**

```bash
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/reexec.e2e.ts e2e/updateHostile.e2e.ts
git add cli/e2e/reexec.e2e.ts cli/e2e/updateHostile.e2e.ts
git commit -m "CLI e2e: nothing orphaned counts the master and the services, which a title hid"
```

Expected: both files pass (the suites that need `MIGRATION_FROM` or `DISKFULL=1` stay skipped). A process that
never leaves the listing is a finding: report its arguments' last two words and its parent, and do not widen `own`
to let it through.

---

## Left out

- `cli/src/cli.ts:1727`, the daemon taking its starter's whole environment: the PM's own item.
- Rotating the token that showed: the final report recommends it (the spec, "Token exposure").
- The titles fake engines set in `cli/e2e` and `cli/scripts`: stand-ins for the labs' CLIs.
- `cli/hook`: nothing there sets a title, and the PM named `cli/src` for the architecture spec.
- `cli/src/lib/processTable.ts:326` and `cli/e2e/harness/daemon.ts:84`: comments about other programs' titles.
- `cli/e2e/migration.e2e.ts`: it reads cores only (`… __run`); unchanged.
- Windows: no end-to-end suite there, and the title only named a console window the detached daemon does not have.
- `docs/plans/` and `docs/research/` of earlier work that mention the title: records of their day.
- **A proposal, not built:** the sentinel part of `e2e/processArguments.e2e.ts` can only fail on macOS, and the
  nightly end-to-end run is Linux but for its full-disk job. Adding this one file to that macOS job of
  `cli-e2e.yml` would run it every night.

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): every file boots
its own daemons under a throwaway root, with a private tmux server and fake engines, signed out, its backend at
`127.0.0.1:9`. No real account, no production, nothing of the developer's daemon. The Global Constraints hold here
too: no `pgrep -f` without `-g`. No temporary workflow: the one new end-to-end check is short and needs a Mac,
and the long ones have the repo's own workflow (check 5).

On this Mac (macOS, arm64, tmux, zsh), in `cli/`, after `npm ci`:

1. **The unit specs and the typecheck.**

   ```bash
   npx vitest run src/architecture.processTitle.spec.ts src/architecture.environment.spec.ts src/serviceProcess.spec.ts \
     src/harnessd/master.spec.ts src/testing/daemonServicePids.spec.ts src/testing/daemonListeningPort.spec.ts
   npm run typecheck
   ```

   To see: six files passed, no error from the typecheck. Pull request CI runs the whole unit suite on Linux.

2. **The leak, end to end, from sources and from the bundle.**

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/processArguments.e2e.ts
   E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/processArguments.e2e.ts
   ```

   To see: `1 passed` both times. The red is Task 1's first commit, the same two commands:
   `1 failed`, `[ 'master', 'search' ]`.

3. **The local gate pull request CI does not run.** From the repository root, clean tree, final commit:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   To see: `cli-harnessd` (`npm run test:harnessd`) passed, 100% in every file. Its receipt goes in the pull
   request body.

4. **The end-to-end files that read `ps` text, on macOS.** Long (not timed in planning) and local, since no
   workflow runs the suite on a Mac:

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/serviceProcesses.e2e.ts e2e/leftBehind.e2e.ts \
     e2e/lean.e2e.ts e2e/cli.e2e.ts e2e/reexec.e2e.ts
   ```

   To see: five files passed. The others Tasks 2 and 4 changed ran here in their tasks and run in check 5.

On GitHub, by hand:

5. **CLI end to end, once, on the branch** (open question 2): Actions, "CLI end to end", Run workflow, branch
   `fix/harnessd-process-title-env`, `agent_browser_podman` unticked. To see: every shard and `e2e-summary` green,
   `e2e/processArguments.e2e.ts` and `e2e/sharedTabs.e2e.ts` among the files run. A red file is compared with last
   night's run before it is called this change's. The run's link goes in the pull request.

Not a check of this pull request:

6. **After the release, by the user themselves** (open question 3): on their Mac, with the daemon on the released
   build, `pgrep -fl harnessd` shows names and arguments only. Until then that command prints their environment:
   its output is never pasted.

Windows: none. The change removes a console title a detached daemon never had, and no end-to-end suite runs there.

**The pull request names:** the platforms (macOS: the fix; Linux: the same change, `ps` shows arguments where it
showed a title; Windows: nothing to see); Task 1's red and green runs; check 3's receipt; check 5's link; and the
spec's advice to rotate the token that showed.
