# A hook's caller outlives the hook: no Stop lost to a stalled core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(cli): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** On Linux a hook names the nearest ancestor that outlives it, so a core that reads the process table after the hook and its shell have exited still finds the hook's engine, and a pane agent's Stop is no longer refused as `unbound`.

**Architecture:** One function in `cli/hook/notify.mjs`, `hookCallerPid()`, replaces `observedCallerPid()` and serves both the paneless post (`/api/hook/observed`) and every pane route (`terminalHookFields`). On Linux it climbs from `process.ppid` past each command shell in a row, read from `/proc`; off Linux it is `process.ppid`. The core's check does not change: one comment in `cli/src/core/engines/hooks.ts` is corrected.

**Tech Stack:** Node (the hook is built-ins only), TypeScript, vitest; `cli/`.

**Spec:** `docs/plans/2026-11-19-hook-descendant-stall-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core, rule 4) and `cli/src/core/AGENTS.md`.

## Base

- Branch `fix/hook-descendant-stall` at `d78ce8149d`, in a worktree of its own.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (`cli/` has no `node_modules`). One process runs it, never two tasks at once.
- Names at the base. `cli/hook/notify.mjs`: `HOOK_SHELLS`, `observedCallerPid`, `observedBody`, `terminalHookFields`, `linuxOwnerBirth`, `readProcField`. `cli/src/hookNotify.spec.ts`: `RunHookOpts` (`viaShell`), `runHook`, `collect`, `tmpDirs`, the `native-process.mjs` fixture. `cli/src/core/engines/hooks.spec.ts`: `agent`, `tree`, `hint`, `setup`, `gatewayTree`. If a name differs, follow the code and say so in the report.
- `main` has moved. #4475 added `received(requests)` to `hookNotify.spec.ts` (a paneless post is waited for at the fake daemon). It is not on this base: a paneless case here that reads `requests` as the hook exits fails now and then under load (one of 283 in each of two Linux runs while planning, a different case each time). Do not chase it; the new paneless cases below wait for their request, and take `received(requests)` at the rebase.
- The e2e-flakes session is changing `FIRED_AT` in `cli/hook/notify.mjs` (branch `fix/hook-fired-at-origin`). Task 1 edits that file in two places only: the block from `HOOK_SHELLS` to the end of `observedCallerPid` (with its one call in `observedBody`), and the return of `terminalHookFields`.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The hook names the nearest ancestor that outlives it | `cli/hook/notify.mjs`, `cli/src/hookNotify.spec.ts`, `cli/e2e/stallHook.e2e.ts` (new) | none | xhigh | `hookNotify.spec.ts` (`the caller a hook names`), on this Mac and in the Linux container; `e2e/stallHook.e2e.ts`, in the Linux container |
| 2 The core: its comment, and the caller it is now given | `cli/src/core/engines/hooks.ts` (one comment), `cli/src/core/engines/hooks.spec.ts` | none | medium | none: no behavior changes, one commit |

Longest chain: one task. The two share no file and start at once. The end-to-end test is in Task 1 because its red-then-green cycle closes only with the fix: its red run is on Task 1's red commit, which has the test and not the fix.

## Global Constraints

- **The rule.** Off Linux: `process.ppid`, before any read. On Linux: start at `process.ppid`; at most 8 times, step to the parent when the process reached is a command shell whose parent is not init (`parentPid > 1`); name the process reached when the steps end.
- **A command shell:** `/proc/<pid>/stat` command is `sh`, `dash`, `bash`, `zsh` or `fish`, and `/proc/<pid>/cmdline` has, before its first operand, an option word that is `-c` or a single-dash cluster holding `c` (`-c`, `-lc`, `-ec`). The words after the first, in order: one that does not start with `-`, or is `-` or `--`, ends the scan (not a command shell); one that starts with `--` is passed over (`--norc` holds a `c` and is no cluster); a single-dash or `+` cluster holding `o` or `O` (`-o`, `+o`, `-O`, `-eo`) takes the next word as its own argument, and both are passed over (harness-pm: `bash -o pipefail -c "…"` is common in launchers and hook commands, and must be climbed past).
- **Cannot read:** a process whose `stat` cannot be read or is not a live process's (`linuxOwnerBirth` gives null: gone, a zombie, a short record), or whose `cmdline` cannot be read, is not climbed past. It is named.
- **Security.** The climb only ever names an ancestor of the hook's parent, and stops at the first process that is not a command shell. The core's check is untouched: the named pid must be the recorded engine process (pid and start marker) or descend from it.
- **No environment.** The hook reads `/proc/<pid>/stat` and `/proc/<pid>/cmdline` only, never `environ` (`src/architecture.environment.spec.ts` stays green). No word of a command line is logged, sent or kept: it yields a pid.
- **The hook ships alone:** Node built-ins only, nothing imported from `src/`.
- **The core does not change in behavior.** `resolveHookAgent` keeps the early `arrival` read. No line of `cli/src/architecture.coreFiles.txt` changes.
- **Not in this pull request:** the 500 ms reply budget, the hook's retries, Windows (Codex and Copilot through PowerShell, Command Code through `cmd.exe`: a named gap in the pull request's body).
- **No fixed sleeps:** `until` and `vi.waitFor` only.

## Decisions made in this plan (the spec left them to the builder)

- The function is `hookCallerPid()`. The end-to-end test is a file of its own, `cli/e2e/stallHook.e2e.ts`, so the container runs one short file (about 30 s), not `stall.e2e.ts`'s two long tests.
- The climb's cases run against a faked `/proc` on every platform, so they are red on this Mac too. A shell under init cannot be built from real processes without a race (and a desktop's orphans go to `systemd --user`, not pid 1). Three real-process cases on Linux hold the kernel's real `stat` and `cmdline` under real dash and bash.
- The hold is 4000 ms, started by SIGUSR2 and seen in the log before the held Stop hook is released. Probed in the Verification container on 2026-11-19, container only, nothing applied to the repo: the hook left 570 to 610 ms into the hold; without the fix the log had `caller is not a descendant of that engine process` and `turn-stop refused · unbound`; with a draft of the rule above it had `turn-stop` and the turn ended once.

## Review Focus

Inputs the spec implies and its own test list does not name. Each has its test in the task that owns the code.

1. **A long option that holds a `c`** (`bash --norc run.sh`, a wrapper engine): read as a command shell, the hook would name a process above the engine and every hook of that engine would be refused. Expected: the shell is named. Task 1, table row `a long option holding a c`.
2. **`-c` after the script** (`bash run.sh -c`): it is the script's argument. Expected: the shell is named. Task 1, row `-c after the script`.
3. **An option with its own argument before `-c`** (`bash -o pipefail -c …`, `bash -O extglob -c …`): the option and its argument are passed over and the shell is a command shell, climbed past (harness-pm). `bash -o pipefail run.sh` stays a script shell, named. Task 1, rows `an option's own argument before -c` and `an option's own argument, then a script`.
4. **A process `/proc` cannot show** (gone between two reads, a zombie): expected no throw, the hook still posts, and it names the last process it reached. Task 1, row `a process /proc cannot show`.
5. **Hermes' shared gateway named directly.** Past its shell, a Linux hook from Hermes 0.22+ names the gateway itself. Expected: the core still reads it as a hook through the shared process. Task 2, `hookViaSharedProcess` case.

---

### Task 1: The hook names the nearest ancestor that outlives it

**Files:**
- Modify: `cli/hook/notify.mjs` (the two places named in Base)
- Modify: `cli/src/hookNotify.spec.ts`
- Create: `cli/e2e/stallHook.e2e.ts`

**Depends on:** none. **Effort:** xhigh (the pid the core's ancestry check is given).

**Interfaces:**
- Produces: `hookCallerPid(): number` in `cli/hook/notify.mjs` (not exported). Task 2's comment names it and `e2e/stallHook.e2e.ts`.

- [ ] **Step 1: The spec's helpers.** In `RunHookOpts`, replace `viaShell?: boolean` with `via`, and add two fixtures written as `--import` modules the way `native-process.mjs` is:

```ts
/** The command lines the hook is run through, outermost first: each hands the rest of the line on as `"$0" "$@"`. */
via?: string[][]
/** Linux's /proc as the hook's climb reads it, faked on any platform (`process.platform` reads 'linux'): the hook's
 *  ancestors, nearest first. The first is the hook's real parent; the row at index n > 0 has pid 9000 + n; each one's
 *  parent is the next, and the last one's is pid 1. null is a process /proc cannot show (ENOENT). Only
 *  /proc/<pid>/stat and /proc/<pid>/cmdline of these pids are answered; cmdline is argv joined and ended by NUL. */
procAncestors?: Array<{ comm: string; argv: string[] } | null>
/** Every path under /proc the hook reads is appended here, one a line. The file is not made when it reads none. */
procReadLog?: string
```

`runHook` spawns `[...(opts.via ?? []).flat(), process.execPath, ...args]`. A `stat` line is shaped as `native-process.mjs` shapes it (state `S`, a start time).

- [ ] **Step 2: The failing unit tests.** A new `describe('hook notify: the caller a hook names', …)`. Move the existing Linux case `a hook run through a shell that stays its parent names the shell's parent` into it, with its comment, `via: [SH]` in place of `viaShell: true`, and the same `vi.waitFor` as the paneless case below before it reads `requests`.

```ts
/** Keeps a shell as the hook's parent: `; exit $?` stops bash and dash alike from exec'ing the hook. */
const STAYS = '"$0" "$@"; exit $?'
const SH = ['/bin/sh', '-c', STAYS]
type Ancestor = NonNullable<RunHookOpts['procAncestors']>[number]
/** The pid `procAncestors` gives its row at [index]. */
const pidAt = (index: number) => index === 0 ? process.pid : 9000 + index
const sh: Ancestor = { comm: 'sh', argv: ['/bin/sh', '-c', 'hook'] }
const engine: Ancestor = { comm: 'claude', argv: ['claude'] }
const bash = (...argv: string[]): Ancestor => ({ comm: 'bash', argv: ['bash', ...argv] })
const stop = { hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/work/app' }
const linux = process.platform === 'linux'
/** The pid a pane's Stop names. A pane post is waited for, so the request is in when the hook exits. */
const paneCaller = async (opts: Partial<RunHookOpts>) => {
  const { port, requests } = await collect()
  await runHook({ port, tmuxPane: '%4', input: stop, ...opts })
  expect(requests.map((request) => request.url)).toEqual(['/api/hook/turn-stop'])
  return requests[0].body.callerPid
}

it.each<[string, Ancestor[], number]>([
  ['a command shell: its parent', [sh, engine], 1],
  ['each of the five shells, in a row: the process above them all', [sh, { comm: 'dash', argv: ['dash', '-c', 'hook'] }, bash('-ec', 'hook'),
    { comm: 'zsh', argv: ['zsh', '-lc', 'hook'] }, { comm: 'fish', argv: ['fish', '-c', 'hook'] }, engine], 5],
  ['a shell that runs a script (bash run.sh): that shell, not the pane shell above it', [sh, bash('/opt/engine/run.sh'), { comm: 'zsh', argv: ['-zsh'] }], 1],
  ['an engine under a wrapper script that did not exec: the engine program, not the wrapper',
    [sh, { comm: 'node', argv: ['node', '/opt/claude/cli.js'] }, { comm: 'bash', argv: ['/bin/bash', '/usr/local/bin/claude'] }], 1],
  ['a command shell whose parent is init: the shell itself', [sh], 0],
  ['ten command shells in a row: the one 8 steps up', Array<Ancestor>(10).fill(sh), 8],
  ['a process /proc cannot show: the last one reached', [sh, null], 1],
  ['a long option holding a c (bash --norc run.sh): the shell itself', [bash('--norc', 'run.sh'), engine], 0],
  ['a long option, then -c: its parent', [bash('--norc', '-c', 'hook'), engine], 1],
  ['-c after the script (bash run.sh -c): the shell itself', [bash('run.sh', '-c'), engine], 0],
  ['an option\'s own argument before -c (bash -o pipefail -c): its parent', [bash('-o', 'pipefail', '-c', 'hook'), engine], 1],
  ['a shopt option\'s argument before -c (bash -O extglob -ec): its parent', [bash('-O', 'extglob', '-ec', 'hook'), engine], 1],
  ['an option\'s own argument, then a script (bash -o pipefail run.sh): the shell itself', [bash('-o', 'pipefail', 'run.sh'), engine], 0],
  ['a program that is no shell, whatever its options (node -c): itself', [{ comm: 'node', argv: ['node', '-c', 'x.js'] }, engine], 0],
  ['a person\'s interactive shell: itself', [{ comm: 'zsh', argv: ['-zsh'] }, engine], 0],
])('a pane hook names, past %s', async (_case, procAncestors, named) => {
  expect(await paneCaller({ procAncestors })).toBe(pidAt(named))
})

it('a paneless hook names by the same rule: past two command shells, the process above both', async () => {
  const { port, requests } = await collect()
  await runHook({ port, input: stop, procAncestors: [sh, bash('-ec', 'hook'), engine] })
  await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10_000 })   // `received(requests)` once #4475 is in
  expect(requests[0]).toMatchObject({ url: '/api/hook/observed', body: { callerPid: pidAt(2) } })
})

// Real processes, the kernel's own /proc: dash keeps `sh -c` as the hook's parent, and it exits with the hook.
it.runIf(linux)('a pane hook run through a shell that stays its parent names the shell\'s parent', async () => {
  expect(await paneCaller({ via: [SH] })).toBe(process.pid)
})
it.runIf(linux)('a pane hook run through two shells in a row names the process above both', async () => {
  expect(await paneCaller({ via: [SH, ['bash', '-ec', STAYS]] })).toBe(process.pid)
})
it.runIf(linux)('a script bash runs (bash wrapper.sh) is named itself, never what started it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-caller-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'wrapper.sh'), `echo $$ > '${join(dir, 'pid')}'\n"$@"\nexit $?\n`)
  const named = await paneCaller({ via: [['bash', join(dir, 'wrapper.sh')], SH] })
  expect(named).toBe(Number(readFileSync(join(dir, 'pid'), 'utf8')))
  expect(named).not.toBe(process.pid)
})
// macOS's /bin/sh is a bash that execs the hook (no `; exit $?` here, as an engine runs it): nothing to climb.
it.runIf(process.platform === 'darwin')('on macOS a hook names its parent, the engine, and reads nothing under /proc', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-caller-'))
  tmpDirs.push(dir)
  expect(await paneCaller({ via: [['/bin/sh', '-c', '"$0" "$@"']], procReadLog: join(dir, 'proc-reads') })).toBe(process.pid)
  expect(existsSync(join(dir, 'proc-reads'))).toBe(false)
})
```

- [ ] **Step 3: The failing end-to-end test.** Create `cli/e2e/stallHook.e2e.ts`: a header comment that says why (the spec's Cause, in four lines), `describe('a Stop hook that reaches a held core')`, one test of 240 s, the daemon closed in `afterEach` and its log and hook log printed `onTestFailed`, as `e2e/hookStatus.e2e.ts` does. Set up: `IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: `core.stall:${HOLD_MS}` } })` (no period, no `/spawn`: it holds on SIGUSR2 alone, at once), started, `[stall] armed` waited for as `e2e/stall.e2e.ts` `fresh` does; one `claude` agent created with `bypassPermission: true` and waited for until it is `active` with a `sessionId`; one plain first turn (`client.turn`). Then this, whose order is the whole test: the Stop hook is started and held (`!heldstop`), the core is held and seen held, the hook is released, and the hook is seen gone before the core answers.

```ts
/** Far past the hook's 500 ms wait for a reply, far inside the master's 40 s. */
const HOLD_MS = 4_000
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
/** The Stop hooks the fake engine has seen end, for this session (fakeEngine.mjs notes each once its shell has exited). */
const stopsRan = (d: IsolatedDaemon, sessionId: string): number =>
  d.hookLog().split('\n').filter((line) => line.includes(` Stop session=${sessionId} `)).length

  it('claude: its Stop ends the turn once the core lets go, though the hook and its shell have exited', async () => {
    // … the set-up above: d, client, agent …
    const release = join(d.engineConfig.root, 'held-stop.release')
    const since = client.frames.length
    client.send('message', { agentId: agent.id, content: '!heldstop' })
    // The engine has started its Stop hook under its `/bin/sh -c`, and the hook waits for the release.
    await until('the Stop hook to start', () => existsSync(`${release}.started`) || null, 45_000, 20)
    const before = stopsRan(d, agent.sessionId)
    process.kill(d.corePid()!, 'SIGUSR2')
    // What the core logs after this line, it logs after the hold. The first turn's own Stop line is before it,
    // though it can reach this log after that turn's end was read: a mark taken earlier counted it as this turn's.
    const held = await until('the core to be held', () => {
      const at = d.log().indexOf('[stall] holding the event loop')
      return at >= 0 ? at : null
    }, 10_000, 10)
    writeFileSync(release, 'go')
    await until('the Stop hook and its shell to exit', () => stopsRan(d, agent.sessionId) > before || null, 30_000, 20)
    expect(d.log().slice(held), 'the hook and its shell left while the core was still held').not.toMatch(/turn-stop|unmatched/)
    await until('the core to answer the Stop', () => /\[hooks\] \S+ turn-stop/.test(d.log().slice(held)) || null, HOLD_MS + 30_000, 50)
    const log = d.log().slice(held)
    expect(log).not.toMatch(/turn-stop refused · unbound/)
    expect(log).not.toMatch(/caller is not a descendant of that engine process/)
    expect(log).toMatch(/\[hooks\] \S+ turn-stop$/m)
    await until('the turn to end', () => client.frames.slice(since).some(isTurn('turn_ended', agent.id)) || null, 30_000, 50)
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
    client.close()
  }, 240_000)
```

No entry is added to `cli/ci-e2e-durations.json`: a file without a hint takes its default, and the nightly run refreshes the hints.

- [ ] **Step 4: See them fail.**
  - On this Mac: `cd cli && npx vitest run src/hookNotify.spec.ts -t "the caller a hook names"`. Expected: FAIL in the nine pane rows whose answer is not the hook's parent (`a command shell`, `each of the five shells`, `a shell that runs a script`, `an engine under a wrapper script`, `ten command shells`, `a process /proc cannot show`, `a long option, then -c`, `an option's own argument before -c`, `a shopt option's argument before -c`), each naming `process.pid`, and in the paneless case (it names 9001, one shell up). The six rows that name the hook's parent and the macOS case pass before and after: they hold what must not change.
  - In the Linux container (Verification, "The Linux container": `up`, `sync`, then `unit`): the same failures, and the three real-process cases (the first two name the shell's pid, the third the `sh -c` under the wrapper). The moved paneless Linux case passes before and after.
  - In the same container, `e2e`: expected FAIL, `AssertionError: expected '[stall] holding the event loop for 40…' not to match /turn-stop refused · unbound/`. Keep the output for the pull request.
  - A test that passes here where it should fail is wrong: fix the test, not the expectation.

- [ ] **Step 5: Commit the red tests.** `git add cli/src/hookNotify.spec.ts cli/e2e/stallHook.e2e.ts && git commit -m "test(cli): a hook names the nearest ancestor that outlives it (red)"`

- [ ] **Step 6: Implement `hookCallerPid(): number`** in `cli/hook/notify.mjs`, in place of `observedCallerPid()`, by the rule in Global Constraints. `HOOK_SHELLS` becomes `sh`, `dash`, `bash`, `zsh`, `fish`. It reads through `linuxOwnerBirth(pid)` (`parentPid`, `command`) and `readProcField(pid, 'cmdline')`. `observedBody` and `terminalHookFields` both send `callerPid: hookCallerPid()`. Nothing else in the file changes. Its comment says why, with both incidents: the devices kept a pid already gone (GitHub run 43721656615), and a core held about a second read the table after the shell had exited and refused the Stop (`e2e/stallHook.e2e.ts`); why only command shells (an engine may be a shell that runs a script; a person's pane shell has no `-c`); why it never names init; that it is read from `/proc`, never the environment; and that macOS's `/bin/sh` execs the hook, so there is nothing to climb.

- [ ] **Step 7: See them pass.**
  - On this Mac: `cd cli && npx vitest run src/hookNotify.spec.ts src/architecture.environment.spec.ts && npm run typecheck`. Expected: PASS, but for the paneless flake named in Base (rerun that case alone; it is not this change).
  - On this Mac, the end-to-end file, which must pass on macOS as it did before the fix: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/stallHook.e2e.ts`. Expected: 1 passed.
  - In the container: `sync`, then `unit` (all of `the caller a hook names` pass) and `e2e` (1 passed; the log between the hold and the end has `[hooks] <id> turn-stop` and no `refused · unbound`). Keep both outputs for the pull request, then `down`.

- [ ] **Step 8: Commit.** `git add cli/hook/notify.mjs && git commit -m "CLI: a hook names the nearest ancestor that outlives it, so a held core still finds its engine"`

### Task 2: The core: its comment, and the caller it is now given

**Files:**
- Modify: `cli/src/core/engines/hooks.ts` (the comment above `const arrival = …` in `resolveHookAgent`; no code)
- Modify: `cli/src/core/engines/hooks.spec.ts`

**Depends on:** none. **Effort:** medium. **Test that fails first:** none. The core's behavior does not change, so the new cases pass as written; one commit.

**Interfaces:**
- Consumes: the names `hook/notify.mjs` `hookCallerPid` and `e2e/stallHook.e2e.ts` (Task 1), in comments only. Fixed by this plan: no need to wait for Task 1.

- [ ] **Step 1: Correct the comment** above `arrival` in `resolveHookAgent`. It must say, in plain sentences: the table is read as the hook arrives because a caller that exits with its hook is gone after the reconcile pass or the wait, and a restart's new conversation was then never bound (`e2e/updates.e2e.ts`, on Linux at the time); on Linux the hook now names the nearest ancestor that outlives it (`hook/notify.mjs` `hookCallerPid`), and macOS's `/bin/sh` execs the hook, so on both the caller is alive; Windows still needs the read (Codex and Copilot run their hook through PowerShell, Command Code through `cmd.exe`, a shell that is the hook's parent and exits with it); and the read only narrows that window, since a core held past the shell's exit starts it too late (`e2e/stallHook.e2e.ts`).

- [ ] **Step 2: Correct the test comment** above `belongs to the agent after the wait though its own process has exited by then, by its ancestry as it arrived`: its caller is now a shell on Windows, not Linux's dash. The test itself stays.

- [ ] **Step 3: Add the cases**, in `describe('which agent a hook belongs to')` and in `describe('a Hermes hook from its shared gateway')`:

```ts
// A Linux hook names the nearest ancestor that outlives it (hook/notify.mjs hookCallerPid). When a held core reads
// the table, the hook and the shells that ran it are gone, and the process it named is still there.
it.each([
  ['the recorded engine itself', tree([100, 1]), 100],
  ['the engine program a recorded wrapper script started', tree([200, 100], [100, 1]), 200],
])('the agent whose engine the named caller is, the hook and its shells gone: %s', async (_case, rows, callerPid) => {
  const a1 = agent('a1', 100)
  vi.mocked(processRows).mockResolvedValueOnce(rows as never)
  expect(await setup({ '%1': a1 }).hooks.resolveHookAgent({ engine: 'claude', runtimeHints: [hint('%1')], callerPid })).toEqual(a1)
  expect(processRows).toHaveBeenCalledTimes(1)
  expect(console.log).not.toHaveBeenCalled()
})

it('is one when the caller named is the gateway itself, as a Linux hook names it past its shell', async () => {
  vi.mocked(processRows).mockResolvedValueOnce(gatewayTree().slice(0, 2) as never)
  expect(await setup().hooks.hookViaSharedProcess({ engine: 'hermes', callerPid: 23704 })).toBe(true)
})
```

- [ ] **Step 4: Run.** `cd cli && npx vitest run src/core/engines/hooks.spec.ts && npm run typecheck`. Expected: PASS. A case that fails means the core does not do what the spec says it does: stop and report it, change no core code.

- [ ] **Step 5: Commit.** `git add cli/src/core/engines/hooks.ts cli/src/core/engines/hooks.spec.ts && git commit -m "CLI core: the arriving-table read's comment names who still needs it, and a test holds the caller a Linux hook names"`

---

## Verification

**Platforms the pull request names:** Linux, fixed (the container below, and PR CI's unit tests). macOS, not affected (the macOS case of Task 1, and the end-to-end file run on this Mac). Windows, not fixed: Claude Code runs its hook with no shell and is not affected; Codex and Copilot (PowerShell) and Command Code (`cmd.exe`) can still lose a Stop to a stall. The pull request's body names that gap.

### The Linux container

Docker on this Mac (linux/arm64). Image `node:24.22.2-bookworm`: Node as `CLI_NODE_VERSION` in `.github/workflows/cli-e2e.yml`, Debian, dash as `/bin/sh` (0.5.12), bash, procps. Everything runs inside the container as its user `node`: each daemon under test has its own throwaway home, data folder, port and private tmux server (`cli/e2e/harness/daemon.ts`), and the fake engines. It reaches no backend, no real engine, and nothing on the Mac but the copied files. Give the container your own name, and remove only it: this Docker holds other sessions' containers and images.

```bash
# from the repo root; C is yours alone: hook-descendant-stall-task1 (the implementer), hook-descendant-stall-tester (a tester)
C=hook-descendant-stall-task1
# up, once
docker run -d --name $C -e LANG=C.UTF-8 -e SHELL=/bin/zsh node:24.22.2-bookworm sleep infinity
docker exec $C bash -c 'apt-get -q update && apt-get -q install -y --no-install-recommends tmux zsh lsof && mkdir -p /work && chown node:node /work'
git archive HEAD cli plugins pty scripts store | docker exec -i -u node $C tar -x -C /work
docker exec -u node -w /work/cli $C npm ci --no-audit --no-fund
# sync: the working tree's copy of this plan's files, after every edit (a tester on a clean head skips it)
for f in cli/hook/notify.mjs cli/src/hookNotify.spec.ts cli/e2e/stallHook.e2e.ts; do docker cp "$f" "$C:/work/$f"; done
# unit: only this plan's cases of the one spec file
docker exec -u node -w /work/cli $C npx vitest run src/hookNotify.spec.ts -t "the caller a hook names"
# e2e: only the one file, with the e2e config (about 30 s)
docker exec -u node -w /work/cli $C env E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/stallHook.e2e.ts
# down: this container and nothing else (no prune)
docker rm -f $C
```

Checked while planning, in a container made by these lines and since removed: an existing end-to-end test passes there (`e2e/hookStatus.e2e.ts`, one test, 42 s), and the test of Task 1, Step 3 is red on the base and green with a draft of the rule.

### End-to-end checks

1. **A Stop that reaches a held core, on Linux** (the container, `e2e`). Red on Task 1's red commit (the implementer, Step 4), green on the final head (a tester: `up` from the final head, no `sync`, `e2e`, `down`). A person should see `1 passed`, and in the daemon log after `[stall] holding the event loop for 4000 ms` the line `[hooks] <id> turn-stop`, with no `turn-stop refused · unbound`.
2. **The hook's cases on Linux** (the container, `unit`): red then green in Task 1; a tester runs the whole file once on the final head (`npx vitest run src/hookNotify.spec.ts`, about 50 s).
3. **macOS, on this Mac**, against isolated daemons only (a throwaway home, data folder, port and tmux server; never the person's daemon on port 18473, `~/.claude`, `~/.codex` or their tmux server): `cd cli && npx vitest run src/hookNotify.spec.ts src/core/engines/hooks.spec.ts` and `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/stallHook.e2e.ts`. The end-to-end file passes here before and after, which shows only that macOS is unchanged. It was not run on macOS while planning.
4. **On GitHub:** PR CI's `cli-tests` runs `hookNotify.spec.ts` and `hooks.spec.ts` on Linux by itself. `cli-e2e.yml` (Actions, CLI end to end, Run workflow) runs the new file with the whole suite nightly; it is not run by hand for this pull request, and no temporary workflow is added (decision: it cannot run one file, and a run holds nine runners). The one file's evidence is check 1.
5. **Windows:** none. The gap is named, not tested.

No check needs a sign-in, a test account, a device or the person themselves. **Against production:** none.

### Required local gates, at the final head, recorded in the pull request

- `python3 scripts/local-checks.py --run` from a clean tree at the final commit: it runs `cli-core` (`npm run test:core`, 100% per file), which applies because `cli/src/core/engines/hooks.ts` changes. Its fence goes in the pull request's body.
- `cd cli && npm run typecheck && npx vitest run src/hookNotify.spec.ts src/core/engines/hooks.spec.ts src/architecture.environment.spec.ts src/architecture.spec.ts`.
- With `B=$(git merge-base HEAD origin/main)`: `git diff --stat $B -- cli/src/architecture.coreFiles.txt` prints nothing, `git diff $B -- cli/src/core/engines/hooks.ts` is comment lines only, and `git diff -U0 $B -- cli/hook/notify.mjs` has hunks in the two places named in Base only.
- Not needed: `npm run test:harnessd`, the serial and PTY specs, Desktop, device-app.

### Numbers

The hook is on the engine's wait. On Linux it now reads at most 17 small `/proc` files (8 shells, two each, and the process named), and three in the usual case (the shell's `stat` and `cmdline`, the engine's `stat`); a paneless hook read one before and a pane hook none. Off Linux it reads none (Task 1's macOS case). For the pull request, the cost of the usual case, in the container:

```bash
docker exec -u node $C node -e "const fs=require('fs');const t=process.hrtime.bigint();for(let i=0;i<10000;i++){fs.readFileSync('/proc/self/stat','utf8');fs.readFileSync('/proc/self/cmdline','utf8');fs.readFileSync('/proc/1/stat','utf8')}console.log((Number(process.hrtime.bigint()-t)/1e7).toFixed(1)+' µs a hook')"
```

### Evidence the pull request carries

The red and green outputs of checks 1 and 2, the macOS run, the `local-checks` fence, the number above, the platforms, and the Windows gap.
