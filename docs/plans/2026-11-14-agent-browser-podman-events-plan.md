# Agent browser: every Podman child ends with the agent browser's process: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Each task is test-first: a red commit (the
> tests alone), then the code commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whenever the agent browser's process ends, in any way, every Podman command it started ends too, on macOS,
Linux and Windows.

**Architecture:** One helper, `spawnTied` (`cli/src/services/agentBrowser/tied.ts`), is the only way the agent browser
starts a Podman command. On macOS and Linux it starts `/bin/sh`, which leaves a watcher on a fourth pipe (fd 3) and
`exec`s the command; the watcher sends SIGTERM when this process's end of the pipe closes. On Windows it is a plain
`spawn`, which Node's Job Object already ends. `podman.spawn` calls it in place of `spawn`; `podman.run` moves from
`execFile` to it and keeps its timeout, output limit, stdin relay and errors.

**Tech Stack:** TypeScript, Node `child_process`, POSIX `sh` (bash 3.2 on macOS, dash on Ubuntu), Vitest, tsx. Node 24
(CI pins 24.22.2). No new dependency.

**Spec:** [docs/plans/2026-11-14-agent-browser-podman-events-design.md](2026-11-14-agent-browser-podman-events-design.md).
Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/services/AGENTS.md`. The spec is the
authority; its decisions are not reopened here.

## Open questions

1. **The real Podman on GitHub.** `cli-e2e.yml` run with `agent_browser_podman=true` runs only
   `e2e/agentBrowserPodman.e2e.ts` (one `ubuntu-24.04` runner, up to 50 minutes, builds the browser's image). It is the
   only check in which the real `podman` binary is started through `spawnTied` (its event stream, `exec -i` pipes, a
   build's output, `secret create` through the relay). The spec's Verification and the decisions name `cli-e2e` once,
   which leaves that file out (`vitest.e2e.ci.config.ts:17`). Answered (orchestrator, 2026-11-14): yes, once, after
   `windows.yml` and `cli-e2e`, each heavy run on the orchestrator's go. It is check 7 below.

## Global Constraints

- The shell line, verbatim, run as `/bin/sh -c '<line>' file args…` with a fourth stdio pipe:
  `{ read -r _ <&3 || kill $$; } </dev/null >/dev/null 2>&1 & exec 3<&-; exec "$0" "$@"`
- `podman.run`'s messages, verbatim: `podman <cmd> timed out after <ms> ms`; `podman <cmd> printed more than 64 MiB`;
  `podman <cmd> failed: <the last 2000 characters of stderr>`. Each of the three stays `podman_failed`. Its limits
  stay 30 000 ms (5 000 for `info`, 10 minutes for `machine start`) and 64 MiB. `STDIN_RELAY`'s text does not change.
- Process groups as in effect today: `podman.spawn` keeps `...ownProcessGroup()`; `podman.run` passes `windowsHide`
  and never `detached`.
- `hostTools.run` (the installers) is not changed. Nothing outside the agent browser is changed.
- No file but `lib/windows/noWindow.ts` spells a `detached:` property (`src/lib/windows/noWindow.spec.ts` fails on a
  new one): `tied.ts` passes its caller's options through by spread.
- 100% coverage per file for `cli/src/services/` (`npm run test:core`): `tied.ts`, `podman.ts` and `fakePodman.ts`
  (not a spec file, so it counts).
- A test waits on a condition with a bound, never a fixed sleep. A test ends the processes it started by their exact
  pids, never by a pattern, and before the folder they run from is removed.
- Never the real Podman: specs use `fakePodman.ts`, the end-to-end file its own fake. Never run or list
  `e2e/agentBrowserPodman.e2e.ts` locally: it acts on the machine's real Podman.
- No local full suite while building: a task runs the tests it names. Every local end-to-end run is under
  `caffeinate -i` with a short TMPDIR of the task's own (`/private/tmp/claude-502/abpe-t<N>/`, made first with
  `mkdir -p`): an agent's TMPDIR on this Mac is too long for the daemon's socket.
- `windows.yml` and `cli-e2e.yml` are heavy: each runs once, only on the orchestrator's go.
- This checkout has no `cli/node_modules`: install once first, `cd cli && npm ci --no-audit --no-fund`.
- Comments say why, in plain sentences, and name the incident (a `podman events` left behind by each crash of the
  agent browser's process).
- Platforms: macOS and Linux (the mechanism), Windows (a plain spawn; proven on the Windows runners). One pull
  request; its body names them and carries each task's red and green output, the Verification results and the
  `cli-core` receipt.

## Found while reading the code

Checked at `55f7c1d766`. Measured while planning on this Mac (macOS, Node 23.11) with a prototype of the spec's shell
line, under `/bin/sh` (bash 3.2) and `/bin/dash`.

- **Does harnessd ever run as PID 1? No.** What was checked, for the spec's accepted risk (a watcher that outlives
  its command is reparented, and a PID 1 that does not reap would keep it as a zombie):
  - `cli/docker/remote-machine/Dockerfile:140`: PID 1 is `tini` (`ENTRYPOINT ["/usr/bin/tini", "--", …]`, added for
    this very reason, `:134-139`); `entrypoint.sh:20` and `cli/scripts/remote-machine.sh:115,174` start the daemon
    with `harness start`, which daemonizes under it. The image has no Podman.
  - `cli/docker/harness-mcp/Dockerfile:40`: PID 1 is `harness mcp`, the MCP server on stdio. It starts no daemon
    (`:3-4`), so no agent browser, and the image has no Podman.
  - Harness OS: `os/root/usr/lib/systemd/user/harness-daemon.service:17` runs `harness start --foreground` under
    `systemd --user`. `harness service install`: launchd, a systemd user unit, a Windows task
    (`cli/src/harnessd/platform.ts`).
  - OS tests boot VMs with systemd (`os/tests/*_vm.py`, `*_guest.py`); `os/tests/runtime_native.py:257` starts the
    daemon on the runner itself. The OS workflows' `docker run` and `podman run` (`os.yml:219`, `os-t2.yml:77`,
    `os-nvidia.yml:61`, `os-asahi-image.yml:80`, `os-asahi-media.yml:86`, `os-arm-session.yml:54`,
    `os-fedora-package.yml:68,82`, `os/tools/build-compositor-container.sh`,
    `os/platforms/orangepi-4pro/build-docker.sh`) build images and packages and install an RPM; none starts the daemon.
  - CLI CI runs on the runner itself: `ci.yml` `cli-tests`, `cli-e2e.yml`, `windows.yml` have no `container:` (the
    one in `ci.yml:586` is the firmware's; `services:` at `:389` is the backend's Redis).
  - `cli/e2e/harness`: daemons are processes on the host. `fakeHermes.mjs:61` puts the fake Hermes engine, not the
    daemon, in a PID namespace. `daemons/e2e/sandbox.mjs:81-83` and `cli/scripts/local-stack-peer.ts:97` use Docker
    for MongoDB and Redis only.
  - `backend/Dockerfile*`, `backend/docker-compose.yml`, `website/Dockerfile.k8s` and
    `cli/assets/browser/Containerfile` (the browser's own container) are not the daemon.
  - `docs/testing/windows-cli-e2e.md:284-291`, a recorded by-hand uninstall run in an Ubuntu container: its second run
    already used `docker run --init`; no script in the repo starts it.
  - Not in this repository, so not checked: the boxes `cli/scripts/relay-sealed-e2e.mts`, `terminal-engine-e2e.mts`
    and `pause-resume-e2e.mts` reach with `docker exec` come from an image built elsewhere.

  And a watcher exists only where Podman was found: `run` and `spawn` throw `needs_setup` before starting anything
  (`podman.ts:103,155`). So no task adds `--init`, and the spec's sentence stays as it is.
- **A missing Podman through the shell is exit 127 on dash and 126 on macOS's `sh`** (bash 3.2: `No such file or
  directory`, `cannot execute`). The spec says 127. The outcome is the accepted one on both (`podman_failed`, a
  stream that drops and reconnects); the tests accept either code.
- **The prototype's numbers.** A tied command was gone 1 to 3 ms after its parent's SIGKILL (a plain one was alive
  after 2 s), alone, in a group of its own, and as the stdin relay (the relay's `wait` does not wait for the watcher).
  `close` came with `exit` (0 ms; the spec measured about 55 ms; nothing here depends on it). A tied start costs 2 to
  3.5 ms more than a plain one (`/usr/bin/true` to `close`: 1.25 ms plain, 4.6 ms on bash, 2.9 ms on dash).
- **`execFile` ends a call by destroying its stdout and stderr, then killing it** (Node's `child_process.js`), so a
  timed-out call settles even while something the command started holds its output. A `spawn` waits on `close` for
  those pipes: the new `run` does what `execFile` did (Task 3, Review Focus 2).
- **`run`'s clock becomes this module's `setTimeout`.** `execFile`'s was Node's own, which a spec's fake clock never
  moved. `agentBrowser.spec.ts:1349,1414,1475` fake `setTimeout` beside the real `createPodman`; read through, none
  has a `run` in flight when it moves the clock (the tool servers there are in-process). Task 3 runs the file.
- **The fake reads its stdin to the end before it logs anything** (`fakePodman.ts:63-65`), so a `podman events`,
  whose stdin stays open, is never logged (`agentBrowser.spec.ts:87`). Task 2 logs each call's pid as it starts.
  `trackingFakes` finds a fake among `[file, ...args]`, so it still tracks one started behind `/bin/sh -c …`.
- **A stand-in process starts no login shell.** `oneShotParentEnv()` only reads what was captured
  (`lib/loginShellEnv.ts:103`), and a `createPodman` given `resolve` never calls `resolveViaLoginShell`.
- **The spec's `:205` holds no argv assertion.** Every line of `podman.spec.ts` that reads the `execFile` or `spawn`
  spy is rewritten: `:132`, `:141`, `:234-235`, `:241`, `:258-265`, `:275-277`, `:283-285`, `:305`. The secret check
  (`:258-265`: never in an argument or the environment) keeps reading a spy, on `spawn`, the one call that starts a
  process now: it is what this process hands the OS.
- **`startAgentBrowser` answers `unsupported` on Windows** (`agentBrowser.ts:145`), so today only `tied.spec.ts`
  reaches the Windows branch.
- **`e2e/agentBrowserPodman.e2e.ts:555-583` still `pkill`s what a run left in Podman.** Left as it is: a net for a
  command that ignores SIGTERM, the spec's accepted risk.
- **Local gates.** `python3 scripts/local-checks.py --list` on the File map's paths names `cli-core`
  (`npm run test:core`) alone.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/services/agentBrowser/tied.ts`, `tied.spec.ts` | new: `spawnTied` and its spec, real processes | 1 |
| `.github/workflows/windows.yml` | the spec's path in the Windows CLI specs step (`:181`) | 1 |
| `cli/src/services/agentBrowser/fakePodman.ts` | the script logs each call's pid as it starts; `pids()` replaces `lastPid()` | 2 |
| `cli/src/services/agentBrowser/podman.ts` | `spawn` through `spawnTied` (2); `run` through it, `outputLimit`, `OUTPUT_LIMIT` exported (3) | 2, 3 |
| `cli/src/services/agentBrowser/podman.spec.ts` | the stand-in process and `spawn`'s cases (2); `run`'s cases, behavioral (3) | 2, 3 |
| `cli/e2e/agentBrowser.e2e.ts` | the fake `podman events` logs its pid; it ends after the SIGKILL (`:46`, `:444-452`) | 2 |
| `cli/src/services/agentBrowser.spec.ts` | only if one of its fake-clock cases fails once `run`'s clock is this module's (`:1349`, `:1414`, `:1475`) | 3 |

## Review Focus

Each line is pinned by a test in the task that owns the code.

- A file path and arguments with spaces, quotes, `$`, backticks, `;`, a newline, an empty one (a container's
  `sh -c '<script>'`, a `--format '{{…}}'`): they reach the command byte for byte, never read by the shell. Task 1.
- A call that timed out while something the command started still holds its output (a helper `machine start` leaves):
  the call still fails with its timeout message, at once. Task 3.
- The process ends by itself (an uncaught error, `process.exit`) rather than by SIGKILL: the command ends too. Task 1.
- A command ended at once, before the shell has become it (a stop right after a start): it still closes, and no
  watcher stays. Task 1.
- Output in which a character of several bytes falls across two reads (a build log): read whole. Task 3.

---

### Task 1: `spawnTied`

**Depends on:** nothing. **Effort:** xhigh.

**Files:**
- Create: `cli/src/services/agentBrowser/tied.ts`
- Create: `cli/src/services/agentBrowser/tied.spec.ts`
- Modify: `.github/workflows/windows.yml` (`$paths` of the step `Contract suite against the real host, and the Windows CLI specs`, `:181`)

**Interfaces:**
- Produces:
  ```ts
  export function spawnTied(
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; detached?: boolean; windowsHide?: boolean; platform?: NodeJS.Platform },
  ): ChildProcess
  ```
  stdio is always piped: `child.stdin`, `child.stdout`, `child.stderr`, `child.pid`, the exit code and the signals are
  the command's own. On macOS and Linux `child.stdio[3]` is the tie, which no caller touches. `platform` defaults to
  `process.platform`.

- [ ] **Step 1: Write the failing spec**

Top of the file: `windows = process.platform === 'win32'`; `CLI = fileURLToPath(new URL('../../..', import.meta.url))`;
`scratch`, a `mkdtempSync` folder removed in `afterAll`; `alive` from `../../testing/spawnedRuns.js`; and

```ts
const gone = (...pids: number[]) => vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 10_000, interval: 20 })
/** The group the command led is empty: it and its watcher have ended and been reaped (a zombie still counts). */
const groupGone = (pid: number) => vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/), { timeout: 10_000, interval: 20 })
const closed = (child: ChildProcess) => new Promise<[number | null, NodeJS.Signals | null]>(done => child.once('close', (code, signal) => done([code, signal])))
const node = (script: string, options: Partial<Parameters<typeof spawnTied>[2]> = {}) => spawnTied(process.execPath, ['-e', script], { env: process.env, ...options })
const FOREVER = 'console.log(process.pid); setInterval(() => {}, 1 << 30)'
const ECHO = `process.stdin.on('data', d => process.stdout.write('out:' + d)); process.stdin.on('end', () => { process.stderr.write('err'); process.exitCode = 7 })`
```

The stand-in for the agent browser's process is `<scratch>/stand-in.mts` (the file URL and `FOREVER` written into
it), run as `spawn(process.execPath, ['--import', 'tsx', STAND_IN], { cwd: CLI, stdio: ['pipe', 'pipe', 'inherit'] })`:

```ts
import { spawnTied } from '<the file URL of tied.ts>'
const child = spawnTied(process.execPath, ['-e', FOREVER], { env: process.env, windowsHide: true })
child.stdout.once('data', (said) => console.log(JSON.stringify({ parent: process.pid, child: child.pid, said: Number(said) })))
process.stdin.once('data', () => process.exit(0))
```

```ts
describe('spawnTied', () => {
  it.each([
    ['is killed', (standIn: ChildProcess) => { standIn.kill('SIGKILL') }],          // TerminateProcess on Windows
    ['ends by itself', (standIn: ChildProcess) => { standIn.stdin!.write('go\n') }],
  ])('the command ends when the process that started it %s', async (_, end) => {
    // … start the stand-in, read `pids` from its first line …
    try {
      expect(pids.said).toBe(pids.child)   // the child handed back is the command itself
      end(standIn)
      await gone(pids.child)
    } finally {
      for (const pid of [pids.child, pids.parent]) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
  })

  it('the command keeps its exit code, and its stdin, stdout and stderr', async () => {
    const child = node(ECHO)                // … collect `out` and `err` …
    child.stdin!.end('in')
    expect(await closed(child)).toEqual([7, null])
    expect([out, err]).toEqual(['out:in', 'err'])
  })

  it.skipIf(windows)('a command that exits by itself leaves no watcher behind', async () => {
    const child = node('0', { detached: true })
    await closed(child)
    await groupGone(child.pid!)
  })

  it.skipIf(windows)('child.kill reaches the command itself', async () => {
    const heard = node(`process.on('SIGTERM', () => process.exit(3)); ${FOREVER}`)
    heard.stdout!.once('data', () => heard.kill())
    expect(await closed(heard)).toEqual([3, null])
    const killed = node(FOREVER)
    killed.stdout!.once('data', () => killed.kill('SIGKILL'))
    expect(await closed(killed)).toEqual([null, 'SIGKILL'])
  })

  it.skipIf(windows)('fd 3 closing, as the OS closes it when this process dies, ends the command with SIGTERM', async () => {
    const child = node(FOREVER, { detached: true })
    child.stdout!.once('data', () => child.stdio[3]!.destroy())
    expect(await closed(child)).toEqual([null, 'SIGTERM'])
    await groupGone(child.pid!)
  })

  it.skipIf(windows)('an error on fd 3, a watcher already gone, is not this process\'s', async () => {
    const child = node(FOREVER)
    expect(() => child.stdio[3]!.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
    child.kill('SIGKILL')
    await closed(child)
  })

  it.skipIf(windows)('the file and every argument reach the command byte for byte, never read by the shell', async () => {
    // <scratch>/a dir $x/print args, mode 0755:  #!/bin/sh\nprintf '%s\000' "$@"\n
    const odd = ['a b', '', '$HOME', '`id`', '"double" \'single\'', '; echo x', 'line\nbreak', '-c', '*', '--label=harness.agent=ünï']
    const child = spawnTied(file, odd, { env: process.env })   // … collect `out` …
    expect(await closed(child)).toEqual([0, null])
    expect(out.split('\0').slice(0, -1)).toEqual(odd)
  })

  it.skipIf(windows)('a command ended at once, before the shell has become it, still closes and leaves no watcher', async () => {
    const child = node(FOREVER, { detached: true })
    child.kill()
    expect((await closed(child))[1]).toBe('SIGTERM')
    await groupGone(child.pid!)
  })

  it('with Windows as its platform it is a plain spawn: three pipes, the command\'s own exit code', async () => {
    const child = node('process.exitCode = 5', { platform: 'win32', windowsHide: true })
    expect(child.stdio).toHaveLength(3)
    expect(await closed(child)).toEqual([5, null])
  })

  it('runs on the Windows runners, where the Windows half is proven', () => {
    expect(readFileSync(join(CLI, '..', '.github', 'workflows', 'windows.yml'), 'utf8')).toContain("'src/services/agentBrowser/tied.spec.ts'")
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/services/agentBrowser/tied.spec.ts`
Expected: the file fails to load (`./tied.js` does not exist). The spec's own red, a plain `spawn` in its place, is
the first case: the command lives on (measured: alive after 2 s).
Commit the spec alone: `agent browser: a spec that a command ends with the process that started it (red)`.

- [ ] **Step 3: Write `tied.ts` and list the spec in `windows.yml`**

- Windows: `spawn(file, args, { ...options, stdio: 'pipe' })`, `platform` taken out of `options` first.
- macOS and Linux: `spawn('/bin/sh', ['-c', TIED, file, ...args], { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })`
  with `TIED` the Global Constraints' line. On `child.stdio[3]`: an `error` listener that does nothing. On the child's
  `exit`: write `'\n'` to it, only while it is still writable.
- The header comment says why (the incident; why `exec`; why the newline; the three accepted risks of the spec) and
  carries the measured numbers above.
- `windows.yml:181`: add `'src/services/agentBrowser/tied.spec.ts'` to `$paths`.

- [ ] **Step 4: Run the checks**

```bash
cd cli
npx vitest run src/services/agentBrowser/tied.spec.ts src/lib/windows/noWindow.spec.ts src/scripts/windowsCiChecks.spec.ts   # tied: 11 passed
npx vitest run src/services/agentBrowser/tied.spec.ts --coverage.enabled --coverage.provider=v8 --coverage.reporter=text \
  --coverage.include=src/services/agentBrowser/tied.ts                                                                      # 100 in every column
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add cli/src/services/agentBrowser/tied.ts .github/workflows/windows.yml
git commit -m "agent browser: spawnTied, a command that ends when the process that started it ends"
```

---

### Task 2: `podman.spawn` goes through `spawnTied`

**Depends on:** Task 1 (`spawnTied`). **Effort:** high.

**Files:**
- Modify: `cli/src/services/agentBrowser/fakePodman.ts` (`FakePodman` `:40-50`, the script `:63-65`, `:97`)
- Modify: `cli/src/services/agentBrowser/podman.spec.ts` (new cases; `:237-241`, `:276`, `:284`)
- Modify: `cli/e2e/agentBrowser.e2e.ts` (`writeFakePodman` `:30,46`; the SIGKILL case `:444-452`)
- Modify: `cli/src/services/agentBrowser/podman.ts` (`:1-6`, `:154-157`)

**Interfaces:**
- Consumes: `spawnTied` (Task 1).
- Produces, for Task 3:
  - `FakePodman.pids(): number[]`: the process id of every call, in the order they started, logged before a call
    reads its stdin. It replaces `lastPid()`.
  - In `podman.spec.ts`: `CLI` and `gone(...pids)` (as in Task 1's spec, `alive` from `../../testing/spawnedRuns.js`),
    `standIn(body: string): ChildProcess` and `endsWithItsProcess(body: string, command: string): Promise<void>`.

- [ ] **Step 1: The fake logs each call's pid as it starts**

In the script, right after `args`: append `process.pid + '\n'` to `pids.log` beside it; drop the `last.pid` line.
`fakePodman()` writes an empty `pids.log`, so `pids()` has no missing-file case to cover. In `podman.spec.ts`,
`fake.lastPid()` becomes `fake.pids().at(-1)!` (`:276`, `:284`; Task 3 rewrites both cases).

- [ ] **Step 2: Write the failing tests**

`podman.spec.ts`:

```ts
/** A Node process in place of the agent browser's (tsx, the real modules, the fake as its Podman): it runs `body` with `podman`. */
function standIn(body: string): ChildProcess {
  const script = join(dirname(fake.path), 'stand-in.mts')
  writeFileSync(script, `import { createPodman } from ${JSON.stringify(new URL('./podman.ts', import.meta.url).href)}
const podman = createPodman({ resolve: async () => ${JSON.stringify(fake.path)} })
await podman.path()
${body}
setInterval(() => {}, 1 << 30)
`)
  return spawn(process.execPath, ['--import', 'tsx', script], { cwd: CLI, stdio: ['ignore', 'ignore', 'inherit'] })
}

/** The service's process can die with no chance to stop anything (a crash, SIGKILL, the OOM killer): what it started ends all the same. */
async function endsWithItsProcess(body: string, command: string): Promise<void> {
  fake.reply(command, { hangMs: 60_000 })
  const service = standIn(body)
  try {
    await vi.waitFor(() => expect(fake.pids()).toHaveLength(1), { timeout: 20_000, interval: 20 })
    service.kill('SIGKILL')
    await gone(...fake.pids())
  } finally {
    // By their exact pids, and before the fake's folder goes: this process tracks none of them.
    for (const pid of [...fake.pids(), service.pid!]) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    await gone(...fake.pids(), service.pid!)
  }
}

it.each([
  ['podman events', `podman.spawn(['events', '--format', 'json'])`, 'events'],
])('%s ends when the process that started it is killed', (_, body, command) => endsWithItsProcess(body, command))

it('a podman removed after it was found ends its stream as a failed command does, with no spawn error', async () => {
  const podman = createPodman({ resolve: async () => join(dirname(fake.path), 'removed'), platform: 'linux' })
  await podman.path()
  const child = podman.spawn(['events'])
  const errors: Error[] = []
  child.on('error', error => errors.push(error))
  const code = await new Promise<number | null>(done => child.once('close', done))
  expect(errors).toEqual([])
  // The shell's own exit: 127 from dash ("not found"), 126 from bash as sh on macOS.
  expect([126, 127]).toContain(code)
})
```

`e2e/agentBrowser.e2e.ts`: the fake's `events` branch logs `'events pid ' + process.pid` to the calls log before it
waits (and the function's comment says so). In the SIGKILL case, with `alive` from `../src/testing/spawnedRuns.js`:

```ts
const before = browserPids(d)
expect(before).toHaveLength(1)
// The `podman events` of the process about to die, by the pid the fake logged: the shell that started it became it.
const watching = log().filter((line) => line.startsWith('events pid ')).map((line) => Number(line.slice('events pid '.length)))
expect(watching.length).toBeGreaterThan(0)
for (const pid of before) process.kill(pid, 'SIGKILL')
// … the panel's close frame and 'the dead process\'s pipe to end', as today …
// Its `podman events` reads no stdin and ran on, one more after each crash. Checked here, before the daemon closes:
// the close ends what is left under its root (#4287) and would hide it.
await until('the dead process\'s podman events to end', () => watching.every((pid) => !alive(pid)) || null, 15_000, 100)
```

- [ ] **Step 3: Run them to see them fail**

```bash
cd cli
npx vitest run src/services/agentBrowser/podman.spec.ts
mkdir -p /private/tmp/claude-502/abpe-t2
TMPDIR=/private/tmp/claude-502/abpe-t2/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts -t "a window watches the browser"
```

Expected: `podman.spec.ts` 2 failed (the fake's pid is still there after 10 s; `errors` holds an `ENOENT`), the rest
pass. The end-to-end case fails with `timed out after 15000ms waiting for the dead process's podman events to end`.
Commit the three files: `agent browser: specs that podman events ends with the browser's process (red)`.

- [ ] **Step 4: `podman.spawn` calls `spawnTied`**

`spawnTied(found, onConnection(args), { env: oneShotParentEnv(), ...ownProcessGroup(), platform })`; `spawn` leaves the
`node:child_process` import. In the same commit, the spy assertion at `podman.spec.ts:241` becomes what it stood for:
before `child.stdin!.end()`, `expect(() => process.kill(-child.pid!, 0)).not.toThrow()` (a group of its own, while it
runs); the `fake.calls()[1]` line stays.

- [ ] **Step 5: Run the checks**

```bash
cd cli
npx vitest run src/services/agentBrowser/podman.spec.ts src/services/agentBrowser/events.spec.ts \
  src/services/agentBrowser/toolServers.spec.ts src/services/agentBrowser/streams.spec.ts \
  src/services/agentBrowser/image.spec.ts src/services/agentBrowser.spec.ts          # all pass
TMPDIR=/private/tmp/claude-502/abpe-t2/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts -t "a window watches the browser"   # 1 passed
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add cli/src/services/agentBrowser/podman.ts cli/src/services/agentBrowser/podman.spec.ts
git commit -m "agent browser: podman events and every exec end with the browser's process"
```

---

### Task 3: `podman.run` goes through `spawnTied`

**Depends on:** Task 2 (the same two files; `fake.pids()`, `standIn`, `endsWithItsProcess`, `gone`). **Effort:** xhigh.

**Files:**
- Modify: `cli/src/services/agentBrowser/podman.spec.ts`
- Modify: `cli/src/services/agentBrowser/podman.ts` (`:1-6`, `:52-59`, `:75-84`, `:101-123`)
- Modify, only if a fake-clock case there fails in Step 5: `cli/src/services/agentBrowser.spec.ts` (`:1349`, `:1414`,
  `:1475`), by waiting for the call before the clock moves, never by changing `podman.ts`.

**Interfaces:**
- Consumes: `spawnTied` (Task 1); Task 2's helpers.
- Produces: `createPodman(deps: { resolve?; exists?; platform?; now?; outputLimit?: number })`, `outputLimit` in bytes,
  for stdout and for stderr each, default `OUTPUT_LIMIT`; `export const OUTPUT_LIMIT = 64 * 1024 * 1024`.
  `Podman.run`'s signature and `PodmanError` do not change.

- [ ] **Step 1: Write the tests**

Red today, with `const MiB = 1024 ** 2`:

```ts
// Two more rows in Task 2's it.each:
['a call in flight', `void podman.run(['ps'], { timeoutMs: 120_000 }).catch(() => {})`, 'ps'],
['a call with stdin in flight, through its relay', `void podman.run(['secret', 'create', 's1', '-'], { stdin: 'pw', timeoutMs: 120_000 }).catch(() => {})`, 'secret create'],

it.each(['stdout', 'stderr'] as const)('%s past the limit ends the call and says so', async (stream) => {
  fake.reply('build', { [stream]: 'x'.repeat(3 * MiB) })
  const error = await failure(createPodman({ resolve: async () => fake.path, platform: 'darwin', outputLimit: 2 * MiB }).run(['build', '/ctx']))
  expect([error.state, error.message, error.output]).toEqual(['podman_failed', 'podman build printed more than 2 MiB', undefined])
})

it('the limit is 64 MiB, for stdout and for stderr each', async () => {
  expect(OUTPUT_LIMIT).toBe(64 * MiB)
  fake.reply('build', { stdout: 'x'.repeat(1.5 * MiB), stderr: 'y'.repeat(1.5 * MiB) })
  const read = await createPodman({ resolve: async () => fake.path, platform: 'darwin', outputLimit: 2 * MiB }).run(['build', '/ctx'])
  expect([read.stdout.length, read.stderr.length]).toEqual([1.5 * MiB, 1.5 * MiB])
})

it('a podman removed after it was found is a failed call, in the shell\'s own words', async () => {
  const error = await failure(createPodman({ resolve: async () => join(dirname(fake.path), 'removed'), platform: 'linux' }).run(['ps']))
  expect(error.state).toBe('podman_failed')
  expect(error.message).toMatch(/^podman ps failed: [^]*removed[^]*(not found|No such file)/)
})
```

Green today too: they hold the new code to what `execFile` did.

```ts
it('a podman that cannot be started at all, as on Windows where no shell starts it, is the same failed call', async () => {
  const error = await failure(createPodman({ resolve: async () => join(dirname(fake.path), 'removed'), platform: 'win32' }).run(['ps']))
  expect([error.state, error.message, error.output]).toEqual(['podman_failed', 'podman ps failed: ', ''])
})

it('a call that timed out is over even while something it started still holds its output', async () => {
  // A podman that leaves a helper behind with its stdout, as `machine start` leaves its VM's. `script` is
  // <the fake's folder>/leaves-a-helper, mode 0755:  #!/bin/sh\nsleep 60 &\necho $! > '<helper>'\nexec sleep 60\n
  // and `helper` is <the fake's folder>/helper.pid.
  const slow = await failure(createPodman({ resolve: async () => script, platform: 'linux' }).run(['machine', 'start'], { timeoutMs: 500 }))
  try { expect(slow.message).toBe('podman machine timed out after 500 ms') }
  finally { process.kill(Number(readFileSync(helper, 'utf8')), 'SIGKILL') }
})

it('output whose characters fall across two reads is read whole', async () => {
  const text = `x${'é'.repeat(200_000)}`
  fake.reply('logs', { stdout: text })
  expect((await found().run(['logs'])).stdout).toBe(text)
})
```

- [ ] **Step 2: Run them to see the first group fail**

Run: `cd cli && npx vitest run src/services/agentBrowser/podman.spec.ts`
Expected: 6 failed (two fakes still there after 10 s; two calls that resolved where a `PodmanError` was expected;
`OUTPUT_LIMIT` undefined; a message with nothing after `failed: `), the rest pass, the second group among them.
Commit the spec alone: `agent browser: specs that a Podman call ends with the browser's process, and names its limit (red)`.

- [ ] **Step 3: `run` through `spawnTied`**

`spawnTied(command, commandArgs, { env: oneShotParentEnv(), windowsHide: true, platform })`, the relay and
`onConnection` as today, stdin always ended (`end(opts.stdin)`). What the signature and the tests do not decide:

- The call settles once, on `close`: resolved with `{ stdout, stderr }` when the code is 0, else failed with today's
  `failed:` message and `output`. An `error` (the command could not be started) settles it the same way; without a
  listener it is an uncaught exception in the service's process. The timer is cleared when it settles.
- Two things end the command, and the first one names the failure, with no `output`: the timeout
  (`timed out after ${timeoutMs} ms`) and a stream past `outputLimit`
  (`` `podman ${args[0]} printed more than ${outputLimit / MiB} MiB` ``). Ending it is what `execFile` did: destroy
  `child.stdout` and `child.stderr`, then `child.kill()` (SIGTERM).
- Output is collected as bytes, counted per stream, and decoded as UTF-8 once.
- `execFile` leaves the import. Comments: the header says every call ends with this process (`tied.ts`);
  `OUTPUT_LIMIT`'s says what happens past it, without `execFile`; `STDIN_RELAY`'s adds that the tie's SIGTERM reaches
  the shell, whose trap ends podman.

- [ ] **Step 4: The spy assertions become behavioral (same commit)**

The mock keeps `spawn: vi.fn(real.spawn)` only; `afterEach` starts with `vi.useRealTimers()`.

```ts
// Captured before any case fakes the clock: a wait in real time.
const realSetTimeout = setTimeout
const started = async (count: number) => { while (fake.pids().length < count) await new Promise(done => realSetTimeout(done, 10)) }

// Replaces 'info times out after 5 s' (:129-133) and the timeout lines at :141, :235 and :305.
it.each([
  ['info', 5_000, (podman: Podman) => podman.memoryBytes(), 'info', 'podman_failed'],
  ['a call with no limit of its own', 30_000, (podman: Podman) => podman.run(['ps']), 'ps', 'podman_failed'],
  ['machine start', 10 * 60_000, (podman: Podman) => podman.startMachine(), 'machine', 'needs_setup'],
] as const)('%s is given %i ms, then ended and named', async (_, ms, call, command, state) => {
  fake.reply(command, { hangMs: 60_000 })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const outcome = failure(call(found('linux')))
  await started(1)
  const pid = fake.pids()[0]!
  // No group of its own: it stays in this process's, as under execFile, which never applied `detached`.
  expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/)
  await vi.advanceTimersByTimeAsync(ms - 1)
  expect(alive(pid)).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  const error = await outcome
  expect([error.state, error.message, error.output]).toEqual([state, `podman ${command} timed out after ${ms} ms`, undefined])
  expect(alive(pid)).toBe(false)
})
```

- `:228-242`: the spy lines go; `mark: 'login-shell'` in `fake.calls()` is the login-shell environment reaching the
  fake.
- `:258-265`: `runs` is read from `vi.mocked(spawn).mock.calls`; still two, and neither's file, arguments or
  environment holds a secret.
- `:275-277` and `:283-285`: `const shell = vi.mocked(spawn).mock.results[0]!.value as ChildProcess`, then
  `await gone(fake.pids().at(-1)!, shell.pid!)`: the fake's and the relay shell's own pids (the group checks were
  vacuous: no group existed).
- `:299-306`: the 3 MiB read stays; the `maxBuffer` line goes.

- [ ] **Step 5: Run the checks**

```bash
cd cli
npx vitest run src/services/agentBrowser src/services/agentBrowser.spec.ts src/lib/windows/noWindow.spec.ts   # all pass
npx vitest run src/services/agentBrowser src/services/agentBrowser.spec.ts --coverage.enabled --coverage.provider=v8 \
  --coverage.reporter=text --coverage.include='src/services/agentBrowser/{tied,podman,fakePodman}.ts'         # 100 in every column, each file
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add cli/src/services/agentBrowser/podman.ts cli/src/services/agentBrowser/podman.spec.ts
git commit -m "agent browser: every Podman call ends with the browser's process, and output past 64 MiB says so"
```

---

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): specs run a fake
`podman` script in a temporary folder; the end-to-end file boots its own daemon under a throwaway root, with a private
tmux server, ports of its own, fake engines and a fake `podman` first on its PATH, signed out. No sign-in, no account,
no backend, no production, nothing of the developer's daemon (port 18473), `~/.harness` or real Podman. None of these
checks needs Ken himself.

Local, on this Mac (macOS), in `cli/`:

1. **The specs.**

   ```bash
   npx vitest run src/services/agentBrowser/tied.spec.ts src/services/agentBrowser/podman.spec.ts \
     src/services/agentBrowser/events.spec.ts src/services/agentBrowser/toolServers.spec.ts \
     src/services/agentBrowser/streams.spec.ts src/services/agentBrowser/image.spec.ts \
     src/services/agentBrowser.spec.ts src/lib/windows/noWindow.spec.ts
   ```

   To see: every file passes, none skipped in `tied.spec.ts` (11 passed).

2. **`agentBrowser.e2e.ts`, with a census before and after.** One at a time, under `caffeinate -i`, with a TMPDIR of
   its own so that the census sees this run only.

   ```bash
   export TMPDIR=/private/tmp/claude-502/abpe-v/ && mkdir -p "$TMPDIR"
   census() { ps -A -ww -o pid=,ppid=,pgid=,command= | grep -F "${TMPDIR}htmux-" | grep -v 'grep -F'; ls -d "${TMPDIR}"htmux-* 2>/dev/null; }
   census; caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts; census
   ```

   To see: 6 passed, the SIGKILL case among them (its dead process's `podman events` ended before the daemon closed);
   both censuses print nothing: no `podman events` that names the run's root is left.

3. **The check PR CI does not run:** `cli-core`, from a clean tree at the final commit.

   ```bash
   python3 scripts/local-checks.py --run
   ```

   To see: `npm run test:core` passed, 100% in every file; its receipt goes in the pull request's body.

On GitHub:

4. **Linux, by PR CI, not started by hand:** `cli-typecheck` and `cli-tests` run `tied.spec.ts` and `podman.spec.ts`
   where `/bin/sh` is dash; `process-checks` lints `windows.yml`. To see: `ci/required` green.
5. **Windows, by hand, once, on the orchestrator's go:**

   ```bash
   gh workflow run windows.yml --ref fix/agent-browser-podman-events
   ```

   To see: both `windows-pty` jobs green (x64 and arm64); in the step `Contract suite against the real host, and the
   Windows CLI specs`, `src/services/agentBrowser/tied.spec.ts` with 5 passed and 6 skipped. Report the run's link.
6. **The end-to-end suite on Linux, by hand, once, on the orchestrator's go:**

   ```bash
   gh workflow run cli-e2e.yml --ref fix/agent-browser-podman-events
   ```

   To see: `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green; `agentBrowser.e2e.ts` passes in
   its shard. A red test is reported with its link and whether main's last nightly run has it too.
7. **The agent browser on the real Podman, once, after checks 5 and 6, on the orchestrator's go:** one runner.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/agent-browser-podman-events -f agent_browser_podman=true
   ```

   To see: `e2e (agent browser, real Podman)` green, every case passed, none skipped.

**Temporary workflow:** none. Each long check has a workflow already (`cli-e2e.yml`, `windows.yml`), and the local
ones need this Mac's process table.
