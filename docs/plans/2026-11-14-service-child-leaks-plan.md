# Service children end with their service: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Each task is test-first: a red commit (the
> tests alone, unless the task says what else belongs in it), then the code commit. A task that changes no behavior
> has no red test and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every child a service starts that runs until stopped, or can run 30 s or more, ends when its service's
process ends, in any way, on macOS and Linux, through one helper.

**Architecture:** #4294's `spawnTied` moves from the agent browser to `cli/src/lib/tied.ts` and learns what the other
callers need: their own stdio and cwd, a group kill for a detached child, and a missing command reported as the
`ENOENT` a plain spawn gives. `podman.run`'s loop moves beside it as `execFileTied`, the `execFile`-shaped call. Then
each row of the spec's in-scope table swaps its `spawn` or `execFile` for one of the two, one task a file, each proven
by a stand-in service process that is SIGKILLed. Windows stays a plain spawn.

**Tech Stack:** TypeScript, Node `child_process`, POSIX `sh` (bash 3.2 on macOS, dash on Ubuntu), Vitest, tsx. Node 24
(CI pins 24.22.2). No new dependency.

**Spec:** [docs/plans/2026-11-14-service-child-leaks-design.md](2026-11-14-service-child-leaks-design.md). Read it with
this plan, the root `AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, and #4294's
[spec](2026-11-14-agent-browser-podman-events-design.md). The spec is the authority; its decisions are not reopened.

## Open questions

None. Three things the spec's Verification did not expect are in "Found while reading the code": the local gates are
four, three end-to-end files change, and `cli-e2e` is needed once.

## Global Constraints

- The shell lines, verbatim, run as `/bin/sh -c '<line>' file args…` with a fourth stdio pipe (fd 3). Not detached
  (unchanged from #4294): `{ read -r _ <&3 || kill $$; } </dev/null >/dev/null 2>&1 & exec 3<&-; exec "$0" "$@"`.
  Detached: the same with `kill -TERM -$$` in place of `kill $$`.
- No file listed in `cli/src/architecture.coreFiles.txt` changes, and none starts importing `lib/tied.ts`. Before
  editing a file: `grep -x '<its path under src/>' cli/src/architecture.coreFiles.txt` prints nothing (true today for
  every file in the File map). A site in a core-loaded file is the spec's accepted gap: leave it.
- Only the in-scope table's sites change. In the same files these stay plain: `dsh/install.ts:94` (`gitHead`),
  `agentClient/computerUse.ts:87` (`opencode --version`), `services/osDevice.ts` `execBounded` and `spawnDetached`,
  `lib/appModels.ts:214` (`ollama serve`, `llama-server`: meant to outlive the daemon). `dsh/viewerLedger.ts` stays.
- Each caller keeps what a living service sees: output, exit codes, error codes and messages ("not installed" from
  `ENOENT`), timeouts and their signals, its own stop and group kill, its stdio (what it never pipes stays unpiped).
- No file but `lib/windows/noWindow.ts` (and its listed exceptions) spells a `detached:` property
  (`src/lib/windows/noWindow.spec.ts`): callers keep `...ownProcessGroup()`, and `lib/tied.ts` reads `options.detached`
  and passes options on by spread.
- Windows: `spawnTied` is a plain `spawn`, and `execFileTied` the same loop over it. Every `*.tied.spec.ts` case that
  needs POSIX is `skipIf(process.platform === 'win32')`.
- A test waits on a condition with a bound, never a fixed sleep. It ends the processes it started by their exact pids
  (the pid a fake logged, never a grep of argv: the watcher shares its command's argv), before their folder goes.
- Never the real engines, `gh`, `git` remotes, Chrome or grid: a fake program on the helper's own seam, under the
  suite's throwaway home (`vitest.setup.ts`). No stand-in starts a login shell but `/bin/sh`.
- No local full suite while building: a task runs the tests it names. Tasks run side by side in one checkout:
  `npx tsc --noEmit` must report nothing in the task's own files (another running task's files may be mid-change),
  and a commit adds only the files its task names.
- Every local end-to-end run is one file at a time, under `caffeinate -i`, with a short TMPDIR of the task's own
  (`/private/tmp/claude-502/scl-t<N>/`, made first with `mkdir -p`): an agent's TMPDIR on this Mac is too long for the
  daemon's socket. `windows.yml` and `cli-e2e.yml` are heavy: each runs once, only on the orchestrator's go.
- This checkout has no `cli/node_modules`: install once first, `cd cli && npm ci --no-audit --no-fund`.
- 100% coverage per file where a gate holds it: `src/services/` (`podman.ts`, `osDevice.ts`; `npm run test:core`) and
  `src/sharing/` (`viewer.ts`; `npm run test:sharing`). `lib/tied.ts` left `src/services/` and its gate; Tasks 2 and 3
  still hold it to 100.
- Comments say why, in plain sentences, and name the incident (a child left running by each crash of its service).
- Platforms: macOS and Linux (changed), Windows (unchanged; proven on the Windows runners). One pull request; its body
  names them and carries each task's red and green output, the numbers below, the Verification results and the local
  check receipts.

## Found while reading the code

Checked at `39c675b7af`. Measured while planning on this Mac (macOS, Node 23.11) with a prototype of the helper as
planned, under `/bin/sh` (bash 3.2) and `/bin/dash`.

- **The mechanism holds for all three shapes.** After the stand-in's SIGKILL a tied command, a detached one with a
  child in its group (`kill -TERM -$$`), and one inside the `execFile`-shaped call were all gone at the first 5 ms
  poll, on both shells.
- **A missing command is best left to Node.** `spawnTied` looks the file up first (`resolveBinaryOnPath`,
  `lib/binaryOnPath.ts`, which `gridExec` and `gridHandoff` already use) and, when it is not there, makes the plain
  `spawn` call: measured, an `error` with `code: 'ENOENT'` and `path` the file, then `close` with -2 and no `exit`, for
  a bare name and for a path. It is the very call callers have today, so nothing about it can read differently. The
  same for a `cwd` that is not there, which Node reports as `spawn <file> ENOENT`: through the shell it would name
  `/bin/sh`, and a doctor's line shows that message to a person. Accepted: a command that appears between the look and
  the spawn runs untied, once; so does a name found only through an empty PATH entry (the current folder), which
  `resolveBinaryOnPath` does not search.
- **A command that waits for all its children does not wait for the watcher.** `sleep 0.2 & wait; echo done` closed in
  213 to 239 ms under sh, bash, zsh and dash, and as a detached `zsh -lic` and `bash -lic` (how a Store setup runs),
  whose group was empty at `close`.
- **Cost of a start, to `close` (`/usr/bin/true`):** 1.25 ms plain; tied by path 4.7 ms on bash and 2.9 ms on dash;
  by bare name with 81 PATH entries 4.9 and 3.8 ms. The busiest caller is the Swarm's readiness pass: three `git`
  calls per checkout every 10 minutes, 64 checkouts at most, so under 0.7 s more per pass.
- **`podman.run` on a Podman removed after it was found reads as before #4294 again**: the spawn's `ENOENT`, so
  `podman_failed` with `podman ps failed: ` and nothing after it, which is what the Windows case in `podman.spec.ts`
  already expects. `podman.spawn`'s callers all hear `error` (`events.ts:73`, `streams.ts:145`, `toolServers.ts:181`).
- **`execFile` leaves stdin an open pipe; `execFileTied` always ends it** (the spec's decision). Four callers change
  that way: `elsewhere.ts` `run`, `worktreeSweep.ts` `git`, `computerUse.ts` `reload`, `appModels.ts` `exec`.
  The orchestrator's condition: no command may behave differently because its stdin is now ended. Each of these
  four tasks proves, from the command's own code or documentation, that the command it runs does not read stdin
  (and says so in its report and a one-line comment), or else keeps stdin open for it (an `execFileTied` option the
  task adds, with a test, when needed).
- **"Plain `execFile`" on Windows is read as the plain `execFile`-shaped call**: one loop over a plain spawn, as
  `podman.run` has run on Windows since #4294, not a second code path through Node's `execFile`.
- **Specs that hand a fake child to `node:child_process`'s `spawn` must hand it to `spawnTied` instead**
  (`vi.mock` of `lib/tied.js`): `sharing/viewer.spec.ts`, `dsh/installProcess.spec.ts`, `dsh/shell.spec.ts`
  (`seams.fakeChild`), `services/osDevice.spec.ts`. Left as they are they would take the tied path where the file
  exists and the plain one where it does not (`/usr/bin/gh` is on the Linux runner and not on a Mac), and a fake child
  has no fd 3. `lib/gridSpawnRefusal.spec.ts` needs no change: its `spawn` throws, and `spawnTied` calls it.
- **Three end-to-end files count processes by command line, and the watcher shares its command's argv**:
  `e2e/harness/hungCodex.ts:37-41` waits for a group of exactly 2 (four cases of `e2e/leftBehind.e2e.ts` use it, and
  `:129` expects 2), and `e2e/engineNativeControl.e2e.ts:50-53,79,89` expects every `app-server proxy` row's parent to
  be the Codex worker. Tasks 8 and 9 change them. About 40 end-to-end files read the process table, and PR CI runs no
  end-to-end test, so **`cli-e2e` is needed once**: it is the only run that finds a census this reading missed, and
  the only one of the converted rows on Linux through the real daemon (viewers through the login shell, a Store
  install, grid, Codex control).
- **The local gates are four, not one.** `python3 scripts/local-checks.py --list` on the File map's paths names
  `cli-core`, `cli-sharing` (`sharing/viewer.ts`), `cli-portability` (`dsh/`) and `cli-local-models`
  (`lib/gridFleetRpc.ts`). `src/architecture.spec.ts` is in the unit suite, not in `test:core`.
- **Callers outside the services**, tied to their own `harness` command, which waits for them as before:
  `computerUse.ts` (`harness computer-use`), `gridExec.ts` and `gridHandoff.ts` (`harness grid …`), `runDshCommand`
  (`harness dsh install`, `doctor`). `DshViewerManager` is the viewers service's alone.
- **An interactive shell ignores SIGTERM.** A DSH command runs under the person's `-lic` shell: the tie's group
  SIGTERM ends its job, and the shell ends when its script has. `killProcessGroup` still follows with SIGKILL on a
  stop; the tie does not (the spec's accepted risk).
- **`services/osDevice.ts` `githubDeviceSignIn` has no seam**: `GH` is `/usr/bin/gh`, the real one on a Linux runner.
  Task 15 gives it a path parameter, in its red commit.
- **The fake program is a shell script, not a Node one**: it has logged its pid within milliseconds, before a
  caller's own short timeout can end it (`nativeControl.ts`'s 3 s handshake).
- **PID 1:** unchanged from #4294's plan (Harness never runs as PID 1), so the spec's zombie-watcher risk stays as is.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/lib/tied.ts`, `tied.spec.ts` | moved from `services/agentBrowser/` (1); options, group, ENOENT (2); `execFileTied` (3) | 1, 2, 3 |
| `.github/workflows/windows.yml` | the spec's path (`:181`) | 1 |
| `cli/src/services/agentBrowser/podman.ts` | import and comments (1); `run` through `execFileTied` (3) | 1, 3 |
| `cli/src/services/agentBrowser/fakePodman.ts` | a comment's path (`:17`) | 1 |
| `cli/src/services/agentBrowser/podman.spec.ts` | the two "removed after it was found" cases (`:414-435`) | 2 |
| `cli/src/testing/tiedStandIn.ts` | new: the fake program and the stand-in service every row's spec uses | 2 |
| `cli/src/sharing/viewer.ts`, `viewer.spec.ts`, `viewer.tied.spec.ts` | row | 4 |
| `cli/src/dsh/shell.ts`, `shell.spec.ts`, `shell.tied.spec.ts` | row | 5 |
| `cli/src/dsh/install.ts`, `installProcess.spec.ts`, `install.tied.spec.ts` | row | 6 |
| `cli/src/lib/oneshot.ts`, `oneshot.tied.spec.ts` | row (eight sites) | 7 |
| `cli/src/lib/codexRateLimits.ts`, `codexRateLimits.spec.ts`, `codexRateLimits.tied.spec.ts`, `cli/e2e/harness/hungCodex.ts`, `cli/e2e/harness/abandonedWorker.ts`, `cli/e2e/leftBehind.e2e.ts` | row | 8 |
| `cli/src/engines/codex/nativeControl.ts`, `nativeControl.tied.spec.ts`, `cli/e2e/engineNativeControl.e2e.ts` | row | 9 |
| `cli/src/engines/codex/providerMove.ts`, `providerMove.tied.spec.ts` | row (two sites) | 10 |
| `cli/src/lib/connectors/elsewhere.ts`, `elsewhere.tied.spec.ts` | row | 11 |
| `cli/src/superTabs/claudeSignIn.ts`, `claudeSignIn.tied.spec.ts` | row | 12 |
| `cli/src/superTabs/machines.ts`, `machines.tied.spec.ts` | row (`createQuietGit`) | 13 |
| `cli/src/lib/worktreeSweep.ts`, `worktreeSweep.tied.spec.ts` | row | 14 |
| `cli/src/services/osDevice.ts`, `osDevice.spec.ts`, `osDevice.tied.spec.ts` | row (`githubDeviceSignIn`) | 15 |
| `cli/src/agentClient/computerUse.ts`, `computerUse.tied.spec.ts` | row (`reload`) | 16 |
| `cli/src/lib/gridFleetRpc.ts`, `gridFleetRpc.tied.spec.ts` | row | 17 |
| `cli/src/lib/gridExec.ts`, `gridExec.tied.spec.ts` | row | 18 |
| `cli/src/lib/gridHandoff.ts`, `gridHandoff.tied.spec.ts` | row | 19 |
| `cli/src/lib/appModels.ts`, `appModels.tied.spec.ts` | row (`exec`) | 20 |

**Order.** 1, then 2, then 3. Tasks 4 to 10, 12, 13, 15 and 17 to 19 need Task 2 only; Tasks 11, 14, 16 and 20 need
Task 3. No two row tasks share a file. Longest chain: 1 → 2 → 3 → a row.

## Review Focus

Each line is pinned by a test in the task that owns the code.

- A command that waits for every child it has (`wait` in a setup script; sh, bash, zsh, and an interactive login
  shell in a group of its own): it ends when its own children have, never waiting on the watcher. Task 2.
- A `cwd` that is not there (a harness folder removed under a doctor): the same `ENOENT` in Node's own words as a
  plain spawn, never `spawn /bin/sh ENOENT`. Task 2.
- stdio the caller does not pipe (`'ignore'`, `'inherit'`): `child.stdin` and `child.stderr` are null as from a plain
  spawn, and the command holds exactly the fds a plain spawn gives it. Task 2.
- A command named without a path, found only on the PATH its caller gives it (the login shell's, not the daemon's):
  it runs tied; one on the daemon's PATH alone is `ENOENT`, as `spawn` decides it. Task 2.
- A timed-out `execFileTied` call while something the command started still holds its output (a git credential
  helper, an `lms` daemon): it settles at once, with its timeout's shape. Task 3.

---

### Task 1: Move the helper to `lib/tied.ts`

**Depends on:** nothing. **Effort:** medium. **No behavior changes: no red test, one commit.**

**Files:**
- Move: `cli/src/services/agentBrowser/tied.ts` → `cli/src/lib/tied.ts`; `…/agentBrowser/tied.spec.ts` → `cli/src/lib/tied.spec.ts` (`git mv`, both)
- Modify: `cli/src/services/agentBrowser/podman.ts` (`:3`, `:12`, `:62`), `cli/src/services/agentBrowser/fakePodman.ts` (`:17`), `.github/workflows/windows.yml` (`:181`)

**Interfaces:**
- Produces: `spawnTied`, unchanged, importable from `cli/src/lib/tied.ts`.

- [ ] **Step 1: Move and repoint.** `git mv` the two files. In the spec: `alive` from `../testing/spawnedRuns.js`,
  `CLI` from `new URL('../..', import.meta.url)`, and the last case reads `'src/lib/tied.spec.ts'`. `podman.ts` imports
  `../../lib/tied.js`; its two comments and `fakePodman.ts`'s say `lib/tied.ts`. `windows.yml:181` lists
  `'src/lib/tied.spec.ts'` in place of the old path.
- [ ] **Step 2: Run the checks.**

  ```bash
  cd cli
  npx vitest run src/lib/tied.spec.ts src/services/agentBrowser/podman.spec.ts src/scripts/windowsCiChecks.spec.ts src/architecture.spec.ts   # all pass; tied: 12 passed
  npx tsc --noEmit
  git grep -n "agentBrowser/tied" -- cli .github    # nothing
  ```
- [ ] **Step 3: Commit.** `git add -A cli/src/lib/tied.ts cli/src/lib/tied.spec.ts cli/src/services/agentBrowser .github/workflows/windows.yml`;
  message: `daemon: the tied spawn moves to lib/tied.ts, for every service`.

---

### Task 2: `spawnTied` for every caller: its stdio and cwd, a group for a detached child, `ENOENT`

**Depends on:** Task 1 (the same files). **Effort:** xhigh.

**Files:**
- Modify: `cli/src/lib/tied.ts`, `cli/src/lib/tied.spec.ts`
- Create: `cli/src/testing/tiedStandIn.ts`
- Modify: `cli/src/services/agentBrowser/podman.spec.ts` (`:414-435`)

**Interfaces:**
- Produces, in `lib/tied.ts`:

  ```ts
  export type TiedStdio = 'pipe' | 'ignore' | 'inherit' | number
  export interface TiedOptions {
    cwd?: string
    /** The command's environment, and the PATH a bare name is looked for on; this process's when left out. */
    env?: NodeJS.ProcessEnv
    /** The command leads a process group of its own, and the tie ends the whole group. */
    detached?: boolean
    windowsHide?: boolean
    /** stdin, stdout and stderr, as `spawn` takes them; three pipes when left out. */
    stdio?: readonly [TiedStdio, TiedStdio, TiedStdio]
    platform?: NodeJS.Platform
  }
  export function spawnTied(file: string, args: readonly string[], options?: TiedOptions): ChildProcess
  ```
- Produces, in `testing/tiedStandIn.ts`, for Task 3 and every row task:

  ```ts
  export interface TiedScene {
    /** A folder of the scene's own, removed when the test ends; the stand-in's TMPDIR. */
    readonly dir: string
    /** The file a fake appends its pid to, one a line: for a fake the spec writes itself. */
    readonly log: string
    /** Writes `<dir>/<name>`, an executable that logs its pid and waits. `withChild`: it first starts a child that
     *  stays in the program's process group, and logs that pid too. Returns its path. */
    program(name: string, options?: { withChild?: boolean }): string
    pids(): number[]
    /** Runs `body` (an ES module's text, through tsx) in a Node process of its own, in place of the service's, with
     *  `env` over this process's. Once `count` pids are logged (1 unless said) it is SIGKILLed, and every logged pid
     *  must be gone within 10 s. */
    endsWithItsProcess(body: string, options?: { env?: NodeJS.ProcessEnv; count?: number }): Promise<void>
  }
  /** Called inside a test: its end SIGKILLs every logged pid and the stand-in, by pid, then removes the folder. */
  export function tiedScene(): TiedScene
  ```

- [ ] **Step 1: Write `testing/tiedStandIn.ts`.** What the signatures leave open:
  - The program, mode 0755 (`<log>` single-quoted; the middle line only with `withChild`):

    ```sh
    #!/bin/sh
    echo $$ >> '<log>'
    /bin/sleep 600 & echo $! >> '<log>'
    exec /bin/sleep 600
    ```
  - The stand-in is `<dir>/stand-in.mts`: `body`, then `setInterval(() => {}, 1 << 30)`. It runs as
    `spawn(process.execPath, ['--import', 'tsx', script], { cwd: <cli>, env: { ...process.env, TMPDIR: dir, ...env }, stdio: ['ignore', 'ignore', 'inherit'] })`.
  - Waits are `vi.waitFor` at a 20 ms interval: 60 s for the pids (tsx loads a large module graph for some rows), 10 s
    for them to be gone. A stand-in that exits before its pids are logged fails the wait at once, saying its code or
    signal (its stderr is the test's).

- [ ] **Step 2: Write the failing cases** in `lib/tied.spec.ts` (`fds`, hoisted out of the existing case, reads stdout
  alone; `TIED` is `JSON.stringify(new URL('./tied.ts', import.meta.url).href)`).

  ```ts
  it.skipIf(windows)('a detached command and what it started in its group end when the process that started them is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('server', { withChild: true })
    await scene.endsWithItsProcess(`import { spawnTied } from ${TIED}
  spawnTied(${JSON.stringify(fake)}, [], { env: process.env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] })`, { count: 2 })
  }, 90_000)

  it.each([
    ['a bare name', () => `no-such-command-${process.pid}`],
    ['a path', () => join(scratch, 'removed')],
  ])('a command that is not there, %s, is the ENOENT a plain spawn gives, with nothing that reads as a run', async (_, name) => {
    const file = name()
    const child = spawnTied(file, [], { env: process.env })
    const said: unknown[][] = []
    child.on('error', (error: NodeJS.ErrnoException) => said.push(['error', error.code, error.path]))
    child.on('exit', (...how) => said.push(['exit', ...how]))
    const [code] = await closed(child)
    expect(said).toEqual([['error', 'ENOENT', file]])
    expect(code).toBeLessThan(0)          // Node's own close after a failed start, never the shell's 127
  })

  it.skipIf(windows)('a name is looked for on the PATH the command is given, not this process\'s', async () => {
    // <scratch>/only-here/only-here, mode 0755:  #!/bin/sh\nexit 4\n
    const found = spawnTied('only-here', [], { env: { ...process.env, PATH: join(scratch, 'only-here') } })
    expect(found.stdio).toHaveLength(4)
    expect(await closed(found)).toEqual([4, null])
    const missing = spawnTied('only-here', [], { env: process.env })
    missing.on('error', () => {})
    expect((await closed(missing))[0]).toBeLessThan(0)
  })

  it.skipIf(windows)('a cwd that is not there fails in Node\'s own words, as a plain spawn does', async () => {
    const failure = (child: ChildProcess) => new Promise<NodeJS.ErrnoException>(done => child.once('error', done))
    const cwd = join(scratch, 'gone')
    const plain = await failure(spawn('/bin/ls', [], { cwd }))
    const tied = await failure(spawnTied('/bin/ls', [], { env: process.env, cwd }))
    expect([tied.code, tied.message]).toEqual([plain.code, plain.message])
  })

  it.skipIf(windows)('what the caller does not pipe is not piped, and the command holds the fds a plain spawn gives it', async () => {
    const tied = spawnTied('/bin/ls', ['/dev/fd/'], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
    expect([tied.stdin, tied.stderr]).toEqual([null, null])
    expect(await fds(tied)).toEqual(await fds(spawn('/bin/ls', ['/dev/fd/'], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })))
  })
  ```

  Green today too; they hold the new code to what the mechanism already does:

  ```ts
  const shells = ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(shell => existsSync(shell))

  it.skipIf(windows).each(shells)('%s waiting for all its children does not wait for the watcher', async (shell) => {
    const child = spawnTied(shell, ['-c', 'sleep 0.2 & wait; echo done'], { env: process.env })   // … onTestFinished kill, collect `said` …
    expect(await closed(child)).toEqual([0, null])
    expect(said.out).toBe('done\n')
  })

  it.skipIf(windows).each(shells.slice(1))('%s as an interactive login shell in a group of its own, as a Store setup runs, ends when its script has', async (shell) => {
    const child = spawnTied(shell, ['-lic', 'sleep 0.2 & wait; echo done'],
      { env: { ...process.env, HOME: scratch, ZDOTDIR: scratch }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    // An empty <scratch>/.zshrc first: without one, zsh on Linux offers its new-user menu (engineLaunch.ts zshNewUserGuard).
    // … onTestFinished: SIGKILL its group; collect stdout …
    expect(await closed(child)).toEqual([0, null])
    expect(out).toContain('done')
    await groupGone(child.pid!)
  })

  it.skipIf(windows)('a path is looked at from the cwd the command is given', async () => {
    // <scratch>/here/print, mode 0755:  #!/bin/sh\nexit 0\n
    const child = spawnTied('./print', [], { env: process.env, cwd: join(scratch, 'here') })
    expect(child.stdio).toHaveLength(4)
    expect(await closed(child)).toEqual([0, null])
  })
  ```

  `podman.spec.ts:414-435` becomes two cases:

  ```ts
  it('a podman removed after it was found ends its stream with the spawn\'s own error, as before the tie', async () => {
    // … as today, to `code` …
    expect(errors.map(error => (error as NodeJS.ErrnoException).code)).toEqual(['ENOENT'])
    expect(code).toBeLessThan(0)
  })

  it.each(['linux', 'win32'] as const)('a podman removed after it was found is a failed call (%s)', async (platform) => {
    const error = await failure(createPodman({ resolve: async () => join(dirname(fake.path), 'removed'), platform }).run(['ps']))
    expect([error.state, error.message, error.output]).toEqual(['podman_failed', 'podman ps failed: ', ''])
  })
  ```

- [ ] **Step 3: Run them to see them fail.**

  Run: `cd cli && npx vitest run src/lib/tied.spec.ts src/services/agentBrowser/podman.spec.ts`
  Expected: in `tied.spec.ts` the detached case (the group's child is still there after 10 s), both `ENOENT` cases
  (an `exit` with 127 or 126 and no `error`), the PATH case, the cwd case (`spawn /bin/sh ENOENT`) and the stdio case
  (`stdin` is a pipe) fail; in `podman.spec.ts` the stream case and the `linux` row fail. The rest pass.
  Commit the two specs and `testing/tiedStandIn.ts`: `daemon: specs for a tied spawn every service can use (red)`.

- [ ] **Step 4: Write the code.** What the signature and the tests do not decide:
  - **When the plain call is made.** On Windows; when `resolveBinaryOnPath` (`lib/binaryOnPath.ts`) finds no
    executable for `file` on `(options.env ?? process.env)` (a `file` with a slash is first resolved against
    `options.cwd`, as exec sees it after the chdir); and when `cwd` is given and is not a directory. Then it is
    `spawn(file, args, { ...options, stdio })` with the caller's three entries, and Node reports the failure itself.
  - **Otherwise** `spawn('/bin/sh', ['-c', line, file, ...args], { ...options, stdio: [...stdio, 'pipe'] })`, `line`
    being the Global Constraints' detached one when `options.detached`, else the other. The `error` listener on fd 3
    and the newline at `exit` stay as they are.
  - The header comment: every service's child now, not the agent browser's alone; why a detached child's group; why
    the look before the shell (callers read `ENOENT`; `gridExec.ts:147`, `codexRateLimits.ts:68`); the numbers above.

- [ ] **Step 5: Run the checks.**

  ```bash
  cd cli
  npx vitest run src/lib/tied.spec.ts src/services/agentBrowser src/services/agentBrowser.spec.ts src/lib/windows/noWindow.spec.ts src/architecture.spec.ts   # all pass
  npx vitest run src/lib/tied.spec.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=text --coverage.include=src/lib/tied.ts   # 100 in every column
  npx tsc --noEmit
  ```
- [ ] **Step 6: Commit.** `git add cli/src/lib/tied.ts`; message:
  `daemon: a tied spawn keeps its caller's stdio, ends a detached child's group, and reports a missing command as spawn does`.

---

### Task 3: `execFileTied`, and `podman.run` through it

**Depends on:** Task 2 (the same files; `tiedScene`). **Effort:** xhigh.

**Files:**
- Modify: `cli/src/lib/tied.ts`, `cli/src/lib/tied.spec.ts`
- Modify: `cli/src/services/agentBrowser/podman.ts` (`run`, `:108-161`)

**Interfaces:**
- Consumes: `spawnTied`, `TiedOptions`, `tiedScene` (Task 2).
- Produces:

  ```ts
  export interface TiedExecOptions {
    cwd?: string
    env?: NodeJS.ProcessEnv
    /** Milliseconds; none when 0 or left out, as execFile. */
    timeout?: number
    /** What ends the command at its timeout or past maxBuffer: SIGTERM unless said. */
    killSignal?: NodeJS.Signals
    /** Bytes, for stdout and for stderr each: 1024 * 1024 unless said, execFile's own default. */
    maxBuffer?: number
    /** Written to the command's stdin, which is always ended. */
    input?: string
    windowsHide?: boolean
    platform?: NodeJS.Platform
  }
  /** Shaped as execFile's error. */
  export interface TiedExecError extends Error {
    /** The exit code; null when a signal ended it; spawn's own (`'ENOENT'`) when it could not start;
     *  `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` past maxBuffer. */
    code: number | string | null
    /** This call ended it: its timeout, or maxBuffer. */
    killed: boolean
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    /** `file` and `args`, joined by spaces. */
    cmd: string
  }
  export function execFileTied(file: string, args: readonly string[], options?: TiedExecOptions): Promise<{ stdout: string; stderr: string }>
  ```
  `Podman.run`'s signature, `PodmanError`, its states, messages and limits do not change.

- [ ] **Step 1: Write the failing cases**, a `describe('execFileTied')` in `lib/tied.spec.ts`, with
  `run = (script, options = {}) => execFileTied(process.execPath, ['-e', script], { env: process.env, ...options })`
  and `failure(work)`, which resolves with the `TiedExecError` a rejected call gave. `MiB` is `1024 ** 2`.

  ```ts
  it('resolves with all the command printed; its stdin is the input, and is ended with or without one', async () => {
    expect(await run(`process.stdin.on('data', d => process.stdout.write('out:' + d)).on('end', () => process.stderr.write('err'))`, { input: 'in' }))
      .toEqual({ stdout: 'out:in', stderr: 'err' })
    expect(await run(`process.stdin.resume().on('end', () => console.log('ended'))`)).toEqual({ stdout: 'ended\n', stderr: '' })
  })

  it('a failed command rejects as execFile does: its exit code, and what it printed', async () => {
    const error = await failure(run(`console.log('out'); console.error('err'); process.exitCode = 3`))
    expect([error.code, error.killed, error.signal, error.stdout, error.stderr]).toEqual([3, false, null, 'out\n', 'err\n'])
    expect(error.message).toBe(`Command failed: ${error.cmd}\nerr\n`)
  })

  it('a call past its timeout is ended with its signal, and says so', async () => {
    // The clock as podman.spec.ts fakes it (toFake: ['setTimeout', 'clearTimeout']); the command writes its pid to a
    // file, waited for in real time, then waits. Options: { timeout: 5_000, killSignal: 'SIGKILL' }.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(alive(pid)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome
    expect([error.code, error.killed, error.signal]).toEqual([null, true, 'SIGKILL'])
    expect(alive(pid)).toBe(false)
  })

  it.skipIf(windows)('a call that timed out is over even while something the command started still holds its output', async () => {
    // podman.spec.ts:378-394's `leaves-a-helper` script and fake clock, through execFileTied with { timeout: 500 }.
    expect([error.killed, error.signal]).toEqual([true, 'SIGTERM'])
  })

  it.each(['stdout', 'stderr'] as const)('%s past maxBuffer ends the call and says so', async (stream) => {
    const flood = (bytes: number) => `process.${stream}.write('x'.repeat(${bytes})); setInterval(() => {}, 1 << 30)`
    for (const [bytes, options] of [[3 * MiB, { maxBuffer: 2 * MiB }], [MiB + 1, {}]] as const) {   // {}: the default, 1 MiB
      const error = await failure(run(flood(bytes), options))
      expect([error.code, error.killed]).toEqual(['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', true])
    }
  })

  it('maxBuffer is for stdout and for stderr each, and what a call read is decoded once', async () => {
    const both = await run(`process.stdout.write('x'.repeat(${1.5 * MiB})); process.stderr.write('y'.repeat(${1.5 * MiB}))`, { maxBuffer: 2 * MiB })
    expect([both.stdout.length, both.stderr.length]).toEqual([1.5 * MiB, 1.5 * MiB])
    const text = `x${'é'.repeat(200_000)}`          // a character of two bytes falls across two reads
    expect((await run(`process.stdout.write(${JSON.stringify(text)})`)).stdout).toBe(text)
  })

  it.each([['a bare name', () => `no-such-command-${process.pid}`], ['a path', () => join(scratch, 'removed')]])(
    'a command that is not there, %s, rejects with spawn\'s own ENOENT', async (_, name) => {
      const error = await failure(execFileTied(name(), [], { env: process.env }))
      expect([error.code, error.killed, error.stdout, error.stderr]).toEqual(['ENOENT', false, '', ''])
    })

  it.skipIf(windows)('a call in flight ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('slow')
    await scene.endsWithItsProcess(`import { execFileTied } from ${TIED}
  void execFileTied(${JSON.stringify(fake)}, [], { timeout: 120_000 }).catch(() => {})`)
  }, 90_000)

  it('with Windows as its platform it is the same call over a plain spawn', async () => {
    expect((await failure(run('process.exitCode = 5', { platform: 'win32' }))).code).toBe(5)
  })
  ```

- [ ] **Step 2: Run them to see them fail.**

  Run: `cd cli && npx vitest run src/lib/tied.spec.ts`
  Expected: every `execFileTied` case fails (`execFileTied is not a function`); the rest pass.
  Commit the spec alone: `daemon: specs for the execFile-shaped tied call (red)`.

- [ ] **Step 3: Move the loop.** `execFileTied` is `podman.run`'s loop (`podman.ts:117-160`), over `spawnTied` with
  three pipes. What the signature and the tests do not decide:
  - It settles once, on `close`, or on `error` (the spawn's own error, given `cmd`, `killed: false` and empty `stdout`
    and `stderr`). The timer is cleared when it settles.
  - Two things end the command, and the first names the failure: the timeout and a stream past `maxBuffer`. Ending it
    is what `execFile` does: destroy `child.stdout` and `child.stderr`, then `child.kill(killSignal)`.
  - Output is collected as bytes, counted per stream, decoded as UTF-8 once. stdin is always ended
    (`end(options.input)`), with an `error` listener: a command that exits before reading it is not this call's failure.
  - `message`: `Command failed: ${cmd}\n${stderr}`; past `maxBuffer`, `${stream} maxBuffer length exceeded`.
  - `podman.run` keeps finding Podman, the relay (`STDIN_RELAY`, `onConnection`) and its comments, and becomes one
    call: `execFileTied(command, commandArgs, { env: oneShotParentEnv(), windowsHide: true, platform, timeout: timeoutMs, maxBuffer: outputLimit, input: opts.stdin })`.
    A rejection maps as today: `killed` with `code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` is
    `` `podman ${args[0]} printed more than ${outputLimit / MiB} MiB` ``; `killed` otherwise is
    `` `podman ${args[0]} timed out after ${timeoutMs} ms` `` (neither with `output`); anything else is the `failed:`
    message and `output` from the error's `stderr` and `stdout`. `podman.spec.ts` is not edited.

- [ ] **Step 4: Run the checks.**

  ```bash
  cd cli
  npx vitest run src/lib/tied.spec.ts src/services/agentBrowser src/services/agentBrowser.spec.ts   # all pass
  npx vitest run src/lib/tied.spec.ts src/services/agentBrowser src/services/agentBrowser.spec.ts --coverage.enabled --coverage.provider=v8 \
    --coverage.reporter=text --coverage.include=src/lib/tied.ts --coverage.include=src/services/agentBrowser/podman.ts   # 100 in every column, both files
  npx tsc --noEmit
  ```
- [ ] **Step 5: Commit.** `git add cli/src/lib/tied.ts cli/src/services/agentBrowser/podman.ts`; message:
  `daemon: execFileTied, the execFile-shaped call that ends with its process; podman.run uses it`.

---

## Row tasks (4 to 20): the steps they share

Each row task converts one helper and proves it with one new spec, `<module>.tied.spec.ts` beside the module:

```ts
import { describe, it } from 'vitest'
import { tiedScene } from '../testing/tiedStandIn.js'            // the path from the spec's own folder

const MODULE = JSON.stringify(new URL('./<module>.ts', import.meta.url).href)
const q = JSON.stringify

describe.skipIf(process.platform === 'win32')('<the child>', () => {
  it('ends when the process that started it is killed', async () => {
    const scene = tiedScene()
    const fake = scene.program('<name>')
    await scene.endsWithItsProcess(`import { <export> } from ${MODULE}\n<the call>`, { env: { … }, count: 1 })
  }, 90_000)
})
```

A task gives the child's name, the program, the call, the environment and the count (2 for a detached row, whose
program is made `{ withChild: true }`: its own pid and its group child's). Its steps:

- **R1 Red.** Write the spec. Run `cd cli && npx vitest run <the spec>`; expected: 1 failed per case, after 10 s, with
  `expected [ <pid>, … ] to deeply equal []` (the fake is still running). Commit the spec alone, with the message the
  task gives.
- **R2 Change.** The swap the task names, and nothing else in the file. Imports that are no longer used go.
- **R3 Checks.** `npx vitest run <the spec> <the task's other specs>`: all pass. `npx tsc --noEmit`: nothing in this
  task's files.
- **R4 Commit.** Only the task's files, with the message the task gives.

---

### Task 4: Share's viewer Chrome (`sharing/viewer.ts`)

**Depends on:** Task 2. **Effort:** high.

**Files:** Modify `cli/src/sharing/viewer.ts` (`:52`), `cli/src/sharing/viewer.spec.ts` (`:3`). Create `cli/src/sharing/viewer.tied.spec.ts`.

- [ ] **R1 Red.** Child: `the shared viewer's Chrome`. Message: `share: a spec that the viewer's Chrome ends with its service's process (red)`.

  ```ts
  const fake = scene.program('chrome')
  await scene.endsWithItsProcess(`import { ViewerCapture } from ${MODULE}
  void new ViewerCapture().start('http://127.0.0.1:9/').catch(() => {})`, { env: { HARNESS_VIEWER_BROWSER: fake } })
  ```
- [ ] **R2 Change.** `spawnTied(browser, [the same arguments], { stdio: ['ignore', 'ignore', 'pipe'] })`. In
  `viewer.spec.ts` the fake child is handed to `spawnTied`: `vi.mock('../lib/tied.js', () => ({ spawnTied: m.spawn }))`
  in place of the `node:child_process` mock; its assertions on `m.spawn` stay.
- [ ] **R3 Checks.** `npx vitest run src/sharing/viewer.spec.ts src/sharing/viewer.tied.spec.ts src/lib/interactiveViewer.spec.ts`; then the
  same two `src/sharing` files with `--coverage.enabled --coverage.provider=v8 --coverage.reporter=text --coverage.include=src/sharing/viewer.ts`: 100 in every column.
- [ ] **R4 Commit.** `share: the viewer's Chrome ends with its service's process`.

---

### Task 5: DSH commands (`dsh/shell.ts`)

**Depends on:** Task 2. **Effort:** high.

**Files:** Modify `cli/src/dsh/shell.ts` (`:162-175`), `cli/src/dsh/shell.spec.ts` (`:11-25`). Create `cli/src/dsh/shell.tied.spec.ts`.

- [ ] **R1 Red.** Child: `a DSH command`. Two cases, `it.each`: `a viewer server` and `a setup or a doctor`. Message:
  `viewers: a spec that a DSH command ends with its service's process (red)`.

  ```ts
  const fake = scene.program('viewer', { withChild: true })
  const call = which === 'a viewer server'
    ? `spawnDshCommand(${q(`'${fake}'`)}, { cwd: ${q(scene.dir)} })`
    : `void runDshCommand(${q(`'${fake}'`)}, { cwd: ${q(scene.dir)}, timeoutMs: 120_000 })`
  await scene.endsWithItsProcess(`import { runDshCommand, spawnDshCommand } from ${MODULE}\n${call}`, { env: { SHELL: '/bin/sh' }, count: 2 })
  ```
- [ ] **R2 Change.** `spawnDshCommand` returns `spawnTied(path, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...ownProcessGroup() })`,
  its comment kept. `runDshCommand`, `killProcessGroup` and `killPidGroup` are not touched. In `shell.spec.ts` the two
  switches move with the call: the mock wraps `spawnTied` (`vi.mock('../lib/tied.js', …)` over the real one:
  `seams.fakeChild` in its place, else the real child with its pid pushed to `seams.started`), and the
  `node:child_process` mock goes.
- [ ] **R3 Checks.** `npx vitest run src/dsh/shell.spec.ts src/dsh/shell.tied.spec.ts src/dsh/viewer.spec.ts src/dsh/viewerLedger.spec.ts src/dsh/materialize.spec.ts`.
- [ ] **R4 Commit.** `viewers: a DSH command ends with its service's process`.

---

### Task 6: A Store package's git (`dsh/install.ts`)

**Depends on:** Task 2. **Effort:** high.

**Files:** Modify `cli/src/dsh/install.ts` (`:266`), `cli/src/dsh/installProcess.spec.ts` (`:10-13`). Create `cli/src/dsh/install.tied.spec.ts`.

- [ ] **R1 Red.** Child: `a Store package's git`. Message: `store: a spec that a package's git ends with its service's process (red)`.

  ```ts
  scene.program('git')
  await scene.endsWithItsProcess(`import { cloneInstall } from ${MODULE}
  void cloneInstall('https://example.invalid/acme/thing.git', undefined, undefined, undefined, [])`,
    { env: { PATH: `${scene.dir}:${process.env.PATH}` } })
  ```
- [ ] **R2 Change.** `streamGit`: `spawnTied('git', args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...GIT_ENV } })`.
  `gitHead` (`:94`) stays `execFile`. In `installProcess.spec.ts` the fake child is handed to `spawnTied`
  (`vi.mock('../lib/tied.js', () => ({ spawnTied: spawn }))`), and the `node:child_process` mock goes.
- [ ] **R3 Checks.** `npx vitest run src/dsh/install.tied.spec.ts src/dsh/installProcess.spec.ts src/dsh/install.spec.ts src/dsh/update.spec.ts`
  (`install.spec.ts`'s "no git" cases are the plain `ENOENT`).
- [ ] **R4 Commit.** `store: a package's git ends with its service's process`.

---

### Task 7: One-shot workers (`lib/oneshot.ts`)

**Depends on:** Task 2. **Effort:** high.

**Files:** Modify `cli/src/lib/oneshot.ts` (`:152`, `:262`, `:351`, `:480`, `:630`, `:726`, `:804`, `:934`). Create `cli/src/lib/oneshot.tied.spec.ts`.

- [ ] **R1 Red.** Child: `a one-shot worker`. `it.each` over the eight kinds, each with the variable that points it at
  the fake: `claude` `CLAUDE_PATH`, `codex` `CODEX_PATH`, `cursor` `CURSOR_PATH`, `opencode` `OPENCODE_PATH`, `kilo`
  `KILO_PATH`, `pi` `PI_PATH`, `commandcode` `COMMANDCODE_PATH`, `grok` `GROK_PATH`. Message:
  `one-shots: a spec that a worker ends with its service's process (red)`.

  ```ts
  const fake = scene.program('engine', { withChild: true })
  const options = `{ prompt: 'p', cwd: ${q(scene.dir)}, timeoutMs: 120_000 }`
  const call = engine === 'grok' ? `void runGrokOneShot(${options}).catch(() => {})` : `void runRouterOneShot(${q(engine)}, ${options}).catch(() => {})`
  await scene.endsWithItsProcess(`import { runGrokOneShot, runRouterOneShot } from ${MODULE}\n${call}`, { env: { [variable]: fake }, count: 2 })
  ```
- [ ] **R2 Change.** Each of the eight `spawn(bin, args, { cwd, env, ...ownProcessGroup(), stdio })` becomes
  `spawnTied` with the same options, stdio entry for entry (`['pipe', 'ignore', 'pipe']` for Codex,
  `['ignore', 'pipe', 'pipe']` for Grok). `killGroup` and `ProcessWorker` are not touched.
- [ ] **R3 Checks.** `npx vitest run src/lib/oneshot.tied.spec.ts src/lib/grokOneShot.spec.ts src/lib/kiloOneShot.spec.ts src/lib/opencodeOneShot.spec.ts src/lib/disposableOneShotPool.spec.ts src/lib/voiceRouter.spec.ts src/services/windowNames.spec.ts`.
- [ ] **R4 Commit.** `one-shots: every worker ends with its service's process`.

---

### Task 8: Codex rate limits (`lib/codexRateLimits.ts`)

**Depends on:** Task 2. **Effort:** high.

**Files:** Modify `cli/src/lib/codexRateLimits.ts` (`:8`, `:24`, `:45-51`), `cli/src/lib/codexRateLimits.spec.ts` (the
seam's type), `cli/e2e/harness/hungCodex.ts` (`:28-42`), `cli/e2e/harness/abandonedWorker.ts` (its comment),
`cli/e2e/leftBehind.e2e.ts` (`:129`). Create `cli/src/lib/codexRateLimits.tied.spec.ts`.

- [ ] **R1 Red.** Child: `the rate-limit read's Codex`. Message: `usage: a spec that the rate-limit read's Codex ends with its service's process (red)`.

  ```ts
  const fake = scene.program('codex', { withChild: true })
  await scene.endsWithItsProcess(`import { readCodexRateLimits } from ${MODULE}
  void readCodexRateLimits({ codexPath: ${q(fake)}, timeoutMs: 120_000 })`, { count: 2 })
  ```
- [ ] **R2 Change.** The `spawn` seam's type is `typeof spawnTied` and its default `spawnTied`; the call and its
  options are as they are. In the spec, the fakes take `TiedOptions` where they took `SpawnOptions`.
  `hungRateLimitRead` waits for the group's three rows and returns them, the leader first: the leader, the tie's
  watcher (its child, which shares its argv) and the hung child; its comment and `abandonedWorker.ts`'s say so.
  `leftBehind.e2e.ts:129` expects 3, `'the hung read\'s Codex, its watcher and its child'`; `:92` holds as it is.
- [ ] **R3 Checks.** `npx vitest run src/lib/codexRateLimits.spec.ts src/lib/codexRateLimits.tied.spec.ts src/services/usage.spec.ts`. Then, on this Mac:

  ```bash
  mkdir -p /private/tmp/claude-502/scl-t8
  TMPDIR=/private/tmp/claude-502/scl-t8/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts   # every case passes
  ```
- [ ] **R4 Commit.** `usage: the rate-limit read's Codex ends with its service's process`.

---

### Task 9: Codex control proxy (`engines/codex/nativeControl.ts`)

**Depends on:** Task 2. **Effort:** high.

**Files:** Modify `cli/src/engines/codex/nativeControl.ts` (`:8`, `:23-25`), `cli/e2e/engineNativeControl.e2e.ts` (`:49-53`). Create `cli/src/engines/codex/nativeControl.tied.spec.ts`.

- [ ] **R1 Red.** Child: `the Codex control proxy`. Message: `engine-codex: a spec that the control proxy ends with its service's process (red)`.

  ```ts
  const fake = scene.program('codex')
  await scene.endsWithItsProcess(`import { connectCodexControl } from ${MODULE}
  void connectCodexControl(${q(scene.dir)}).catch(() => {})`, { env: { CODEX_PATH: fake } })
  ```
- [ ] **R2 Change.** `spawnTied(engineBin('codex'), ['app-server', 'proxy'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] })`.
  In the end-to-end file, `proxies` leaves out a row whose parent is itself one of the rows: the tie's watcher is its
  command's child and shares its argv. Its comment says so.
- [ ] **R3 Checks.** `npx vitest run src/engines/codex/nativeControl.tied.spec.ts src/core/engines/nativeControls.stop.spec.ts`. Then, on this Mac:

  ```bash
  mkdir -p /private/tmp/claude-502/scl-t9
  TMPDIR=/private/tmp/claude-502/scl-t9/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/engineNativeControl.e2e.ts   # every case passes
  ```
- [ ] **R4 Commit.** `engine-codex: the control proxy ends with its service's process`.

---

### Task 10: Codex provider move (`engines/codex/providerMove.ts`)

**Depends on:** Task 2. **Effort:** high.

**Files:** Modify `cli/src/engines/codex/providerMove.ts` (`:10`, `:51`, `:66`). Create `cli/src/engines/codex/providerMove.tied.spec.ts`.

- [ ] **R1 Red.** Child: `a provider move's Codex`. Two cases. Message:
  `engine-codex: a spec that a provider move's Codex ends with its service's process (red)`.
  - `its app-server`: `scene.program('codex')`, and the move waits on `initialize` for good.
  - `its catalog read`: the spec writes `<dir>/codex` itself (`#!${process.execPath}`, mode 0755): given `debug` it
    appends its pid to `scene.log` and waits; otherwise it answers each JSON line that has an `id`, as
    `providerMove.spec.ts`'s fake does (`model/list` with `{ data: [{ model: 'own-model', isDefault: true }] }`, anything
    else with `{}`), and ends with its stdin. `toGrid: false`, so only the catalog read logs a pid.

  ```ts
  const move = (toGrid: boolean) => `import { moveCodexConversation } from ${MODULE}
  void moveCodexConversation({ sessionId: 's', toGrid: ${toGrid}, args: [], argv: (args) => [${q(fake)}, ...args], env: process.env }).catch(() => {})`
  await scene.endsWithItsProcess(move(true))      // its app-server; move(false) for its catalog read
  ```
- [ ] **R2 Change.** Both become `spawnTied(command!, args, { env: move.env, stdio })` with their own stdio
  (`['ignore', 'pipe', 'ignore']` at `:51`, three pipes at `:66`); the streams they read are asserted non-null where
  the type needs it.
- [ ] **R3 Checks.** `npx vitest run src/engines/codex/providerMove.spec.ts src/engines/codex/providerMove.tied.spec.ts src/engines/worker/providerMoveRequests.spec.ts`.
- [ ] **R4 Commit.** `engine-codex: a provider move's Codex ends with its service's process`.

---

### Task 11: Connectors' engine reads (`lib/connectors/elsewhere.ts`)

**Depends on:** Task 3. **Effort:** medium.

**Files:** Modify `cli/src/lib/connectors/elsewhere.ts` (`:11`, `:136-143`). Create `cli/src/lib/connectors/elsewhere.tied.spec.ts`.

- [ ] **R1 Red.** Child: `an engine's connector read`. Message: `connectors: a spec that an engine's read ends with its service's process (red)`.

  ```ts
  const fake = scene.program('claude')
  await scene.endsWithItsProcess(`import { elsewhere } from ${MODULE}
  void elsewhere({ binary: (name) => name === 'claude' ? ${q(fake)} : null })`)
  ```
- [ ] **R2 Change.** `run` is `execFileTied(command, args, { cwd: homedir(), env, timeout: timeoutMs, maxBuffer: 4 << 20 })`,
  resolved with its `stdout`; a rejection passes on as it is.
- [ ] **R3 Checks.** `npx vitest run src/lib/connectors/elsewhere.spec.ts src/lib/connectors/elsewhere.tied.spec.ts`.
- [ ] **R4 Commit.** `connectors: an engine's read ends with its service's process`.

---

### Task 12: Engine sign-in from the phone (`superTabs/claudeSignIn.ts`)

**Depends on:** Task 2. **Effort:** medium.

**Files:** Modify `cli/src/superTabs/claudeSignIn.ts` (`:16`, `:209-210`). Create `cli/src/superTabs/claudeSignIn.tied.spec.ts`.

- [ ] **R1 Red.** Child: `an engine's login`. Message: `swarm: a spec that an engine's login ends with its service's process (red)`.

  ```ts
  scene.program('claude')
  await scene.endsWithItsProcess(`import { startEngineLogin } from ${MODULE}
  startEngineLogin('claude')`, { env: { PATH: `${scene.dir}:${process.env.PATH}` } })
  ```
- [ ] **R2 Change.** `spawnTied(engineExecutable(engine), args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, BROWSER: browser, HARNESS_CLAUDE_PAGE: page } })`.
- [ ] **R3 Checks.** `npx vitest run src/superTabs/claudeSignIn.spec.ts src/superTabs/claudeSignIn.tied.spec.ts`.
- [ ] **R4 Commit.** `swarm: an engine's login ends with its service's process`.

---

### Task 13: The Swarm's quiet git (`superTabs/machines.ts`)

**Depends on:** Task 2. **Effort:** medium.

**Files:** Modify `cli/src/superTabs/machines.ts` (`:3`, `:1317`). Create `cli/src/superTabs/machines.tied.spec.ts`.

- [ ] **R1 Red.** Child: `the Swarm's quiet git`. Message: `swarm: a spec that a quiet git ends with its service's process (red)`.

  ```ts
  scene.program('git', { withChild: true })
  await scene.endsWithItsProcess(`import { createQuietGit } from ${MODULE}
  void createQuietGit(120_000)(${q(scene.dir)}, ['status'])`, { env: { PATH: `${scene.dir}:${process.env.PATH}` }, count: 2 })
  ```
- [ ] **R2 Change.** `spawnTied('git', ['-C', cwd, ...args], { env, ...ownProcessGroup(), stdio: ['ignore', 'pipe', 'pipe'] })`;
  `end`, the timer and the settle on `exit` are not touched.
- [ ] **R3 Checks.** `npx vitest run src/superTabs/machines.tied.spec.ts src/superTabs/machines.spec.ts` (its two helper
  cases, `:569` and `:589`, run the real git tied).
- [ ] **R4 Commit.** `swarm: a quiet git ends with its service's process`.

---

### Task 14: Worktree git (`lib/worktreeSweep.ts`)

**Depends on:** Task 3. **Effort:** medium.

**Files:** Modify `cli/src/lib/worktreeSweep.ts` (`:8`, `:12`, `:16`, `:30`). Create `cli/src/lib/worktreeSweep.tied.spec.ts`.

- [ ] **R1 Red.** Child: `a worktree's git`. Message: `swarm: a spec that a worktree's git ends with its service's process (red)`.

  ```ts
  scene.program('git')
  await scene.endsWithItsProcess(`import { git } from ${MODULE}
  void git(${q(scene.dir)}, ['status']).catch(() => {})`, { env: { PATH: `${scene.dir}:${process.env.PATH}` } })
  ```
- [ ] **R2 Change.** `git` awaits `execFileTied('git', [...guarded, '-C', cwd, ...args], { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env })`
  and returns its `stdout` as today; `exec`, `promisify` and `execFile` go.
- [ ] **R3 Checks.** `npx vitest run src/lib/worktreeSweep.spec.ts src/lib/worktreeSweep.tied.spec.ts`.
- [ ] **R4 Commit.** `swarm: a worktree's git ends with its service's process`.

---

### Task 15: GitHub device sign-in (`services/osDevice.ts`)

**Depends on:** Task 2. **Effort:** high.

**Files:** Modify `cli/src/services/osDevice.ts` (`:118-121`), `cli/src/services/osDevice.spec.ts` (`:15-18`). Create `cli/src/services/osDevice.tied.spec.ts`.

- [ ] **R1 Red.** Child: `gh's device sign-in`. The red commit also carries the seam, which changes no behavior:
  `githubDeviceSignIn(gh: string = GH)`, spawning `gh` (without it the spec would start the runner's real
  `/usr/bin/gh`). Message: `os device: a spec that gh's device sign-in ends with its service's process (red)`.

  ```ts
  const fake = scene.program('gh')
  await scene.endsWithItsProcess(`import { githubDeviceSignIn } from ${MODULE}
  githubDeviceSignIn(${q(fake)})`)
  ```
- [ ] **R2 Change.** `spawnTied(gh, [the same arguments], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, BROWSER: 'true', GH_PROMPT_DISABLED: '1' } })`.
  `execBounded` and `spawnDetached` stay as they are. In `osDevice.spec.ts` the sign-in's fake child is handed to
  `spawnTied`: a mock of `../lib/tied.js` whose `spawnTied` calls `child.spawn`, so every assertion on `child.spawn`
  holds as written; its comment says why (`/usr/bin/gh` is on the Linux runner, not on a Mac).
- [ ] **R3 Checks.** `npx vitest run src/services/osDevice.spec.ts src/services/osDevice.tied.spec.ts src/services/inline.spec.ts`; then
  `npx vitest run src/services/osDevice.spec.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=text --coverage.include=src/services/osDevice.ts`: 100 in every column.
- [ ] **R4 Commit.** `os device: gh's device sign-in ends with its service's process`.

---

### Task 16: OpenCode reload (`agentClient/computerUse.ts`)

**Depends on:** Task 3. **Effort:** medium.

**Files:** Modify `cli/src/agentClient/computerUse.ts` (`:17`, `:94`). Create `cli/src/agentClient/computerUse.tied.spec.ts`.

- [ ] **R1 Red.** Child: `opencode reload`. Message: `os device: a spec that opencode reload ends with its service's process (red)`.

  ```ts
  scene.program('opencode')
  await scene.endsWithItsProcess(`import { machineOpencode } from ${MODULE}
  machineOpencode().reload()`, { env: { PATH: `${scene.dir}:${process.env.PATH}` } })
  ```
- [ ] **R2 Change.** `reload` is `void execFileTied('opencode', ['reload'], { timeout: 30_000 }).catch(() => {})`, its
  comment kept. `major` (`:87`) stays `execFileSync`.
- [ ] **R3 Checks.** `npx vitest run src/agentClient/computerUse.spec.ts src/agentClient/computerUse.tied.spec.ts src/services/osDevice.spec.ts`.
- [ ] **R4 Commit.** `os device: opencode reload ends with its service's process`.

---

### Task 17: Grid fleet commands (`lib/gridFleetRpc.ts`)

**Depends on:** Task 2. **Effort:** medium.

**Files:** Modify `cli/src/lib/gridFleetRpc.ts` (`:2`, `:73-79`). Create `cli/src/lib/gridFleetRpc.tied.spec.ts`.

- [ ] **R1 Red.** Child: `a grid fleet command`. Message: `models: a spec that a grid fleet command ends with its service's process (red)`.

  ```ts
  const fake = scene.program('grid')
  await scene.endsWithItsProcess(`import { GridFleetRpc } from ${MODULE}
  void new GridFleetRpc({ ...process.env, HARNESS_GRID_BIN: ${q(fake)} }).run('owner', 'job', { args: ['--remote', 'join', '--serve'], timeoutMs: 120_000 })`)
  ```
- [ ] **R2 Change.** `spawnTied(command.file, command.args, { env: { … as today … }, stdio: ['ignore', 'pipe', 'pipe'] })`
  inside the same `try`; `child`'s type follows.
- [ ] **R3 Checks.** `npx vitest run src/lib/gridFleetRpc.spec.ts src/lib/gridFleetRpc.tied.spec.ts src/lib/gridSpawnRefusal.spec.ts`.
- [ ] **R4 Commit.** `models: a grid fleet command ends with its service's process`.

---

### Task 18: Grid calls (`lib/gridExec.ts`)

**Depends on:** Task 2. **Effort:** medium.

**Files:** Modify `cli/src/lib/gridExec.ts` (`:22`, `:107-109`). Create `cli/src/lib/gridExec.tied.spec.ts`.

- [ ] **R1 Red.** Child: `a grid call`. Message: `models: a spec that a grid call ends with its service's process (red)`.

  ```ts
  const fake = scene.program('grid')
  await scene.endsWithItsProcess(`import { gridExec } from ${MODULE}
  void gridExec(['--remote', 'ls'], { processEnv: { ...process.env, HARNESS_GRID_BIN: ${q(fake)} }, timeoutMs: 120_000 })`)
  ```
- [ ] **R2 Change.** `spawnTied(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'], env: gridChildEnv(processEnv) })`
  inside the same `try`; `child`'s type follows.
- [ ] **R3 Checks.** `npx vitest run src/lib/gridExec.spec.ts src/lib/gridExec.tied.spec.ts src/lib/gridSpawnRefusal.spec.ts src/lib/swarmGrid.spec.ts`
  (`gridExec.spec.ts` runs with an empty PATH: the tie's shell line uses builtins alone).
- [ ] **R4 Commit.** `models: a grid call ends with its service's process`.

---

### Task 19: Grid sign-in hand-off (`lib/gridHandoff.ts`)

**Depends on:** Task 2. **Effort:** medium.

**Files:** Modify `cli/src/lib/gridHandoff.ts` (`:24`, `:138-145`). Create `cli/src/lib/gridHandoff.tied.spec.ts`.

- [ ] **R1 Red.** Child: `the grid sign-in`. Message: `models: a spec that the grid sign-in ends with its service's process (red)`.

  ```ts
  const fake = scene.program('grid')
  await scene.endsWithItsProcess(`import { handOffToGrid } from ${MODULE}
  void handOffToGrid('token', { json: true, timeoutMs: 120_000 })`, { env: { HARNESS_GRID_BIN: fake } })
  ```
- [ ] **R2 Change.** `spawnTied(command.file, command.args, { stdio: ['pipe', opts.json ? 'pipe' : 'inherit', opts.json ? 'pipe' : 'inherit'], env: gridChildEnv() })`
  inside the same `try`, its comment kept; `child`'s type follows.
- [ ] **R3 Checks.** `npx vitest run src/lib/gridHandoff.spec.ts src/lib/gridHandoff.tied.spec.ts src/lib/gridSpawnRefusal.spec.ts src/lib/gridAttach.spec.ts`.
- [ ] **R4 Commit.** `models: the grid sign-in ends with its service's process`.

---

### Task 20: Other apps' models (`lib/appModels.ts`)

**Depends on:** Task 3. **Effort:** medium.

**Files:** Modify `cli/src/lib/appModels.ts` (`:5`, `:44-47`). Create `cli/src/lib/appModels.tied.spec.ts`.

- [ ] **R1 Red.** Child: `the Model Manager's scan`. Message: `models: a spec that the model scan ends with its service's process (red)`.

  ```ts
  const fake = scene.program('node')
  await scene.endsWithItsProcess(`import { scanAppModels } from ${MODULE}
  void scanAppModels({ node: ${q(fake)}, packageDir: ${q(scene.dir)}, env: process.env })`)
  ```
- [ ] **R2 Change.** `exec` is `execFileTied(file, args, { env: options.env, timeout: options.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024 })`,
  resolved to `{ ok: true, stdout, stderr }`, and a rejection to `{ ok: false, stdout, stderr }` from the error.
  `background` (`:209-219`) keeps its plain, detached `spawn`.
- [ ] **R3 Checks.** `npx vitest run src/lib/appModels.spec.ts src/lib/appModels.tied.spec.ts src/lib/localModels.spec.ts`.
- [ ] **R4 Commit.** `models: the model scan and LM Studio's commands end with their service's process`.

---

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): specs run under the
suite's throwaway home, data and runtime folders (`vitest.setup.ts`) with fake programs in temporary folders; each
end-to-end file boots its own daemon under a throwaway root, with a private tmux server, ports of its own and fake
engines, signed out. No sign-in, no account, no backend, no production, nothing of the developer's daemon (port
18473), `~/.harness`, real engines, `gh` or Chrome. None of these checks needs Ken himself.

Local, on this Mac (macOS, where `/bin/sh` is bash 3.2), in `cli/`:

1. **The specs.** `tied.spec` matches `src/lib/tied.spec.ts` and every `*.tied.spec.ts`.

   ```bash
   npx vitest run tied.spec src/services/agentBrowser src/services/agentBrowser.spec.ts src/sharing/viewer.spec.ts \
     src/dsh/shell.spec.ts src/dsh/installProcess.spec.ts src/dsh/install.spec.ts src/lib/codexRateLimits.spec.ts \
     src/engines/codex/providerMove.spec.ts src/lib/connectors/elsewhere.spec.ts src/superTabs/claudeSignIn.spec.ts \
     src/superTabs/machines.spec.ts src/lib/worktreeSweep.spec.ts src/services/osDevice.spec.ts \
     src/agentClient/computerUse.spec.ts src/lib/gridFleetRpc.spec.ts src/lib/gridExec.spec.ts src/lib/gridHandoff.spec.ts \
     src/lib/gridSpawnRefusal.spec.ts src/lib/appModels.spec.ts src/architecture.spec.ts src/lib/windows/noWindow.spec.ts
   ```

   To see: every file passes; 18 files named `tied.spec`, none of their cases skipped; `architecture.spec.ts` green
   (no file joined the core's process).

2. **The end-to-end files that census processes or run a converted row through the login shell, with a census
   before and after.** One at a time.

   ```bash
   export TMPDIR=/private/tmp/claude-502/scl-v/ && mkdir -p "$TMPDIR"
   census() { ps -A -ww -o pid=,ppid=,pgid=,command= | grep -F "$TMPDIR" | grep -v 'grep -F'; }
   census
   for file in leftBehind engineNativeControl viewersProcess storeProcess; do
     caffeinate -i npx vitest run --config vitest.e2e.config.ts "e2e/$file.e2e.ts"; census
   done
   ```

   To see: each file passes, and every census prints nothing: no process that names the run's folder is left.

3. **The checks PR CI does not run**, from a clean tree at the final commit:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   To see: `cli-core`, `cli-sharing`, `cli-portability` and `cli-local-models` passed, 100% in every file each holds;
   the receipts go in the pull request's body.

On GitHub:

4. **Linux, by PR CI, not started by hand:** `cli-typecheck` and `cli-tests` run every spec above where `/bin/sh` is
   dash; `process-checks` lints `windows.yml`. To see: `ci/required` green.
5. **Windows, by hand, once, on the orchestrator's go:**

   ```bash
   gh workflow run windows.yml --ref fix/service-child-leaks
   ```

   To see: both `windows-pty` jobs green (x64 and arm64). In the step `Contract suite against the real host, and the
   Windows CLI specs`: `src/lib/tied.spec.ts` with no failure (the plain spawn and the plain `execFileTied`; its POSIX
   cases skipped), and `src/lib/windows` green, where `gitBashTimeout.real.spec.ts` runs a DSH command
   (`runDshCommand`) on the real Windows. Report the run's link.
6. **The end-to-end suite on Linux, by hand, once, after check 5, on the orchestrator's go:**

   ```bash
   gh workflow run cli-e2e.yml --ref fix/service-child-leaks
   ```

   Why it is needed: three end-to-end files change with this work, others census processes by command line, PR CI
   runs none of them, and it is the only run of the converted rows through the real daemon on Linux. To see:
   `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green. A red test is reported with its link and
   whether main's last nightly run has it too.

**Temporary workflow:** none. Each long check has a workflow already (`cli-e2e.yml`, `windows.yml`), and the local
ones need this Mac's shell and process table.
