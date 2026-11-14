# CLI end-to-end harness learns the port a process bound: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Each task is test-first: a red commit (the
> tests alone), then the code commit. A task marked "no failing test" is one commit. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** The end-to-end harness never hands a process a port it picked ahead and then trusts: it reads the port the
daemon and the real backend say they bound, so a port taken between the pick and the bind can no longer fail a test.

**Architecture:** Test harness, plus one log line of the backend. `IsolatedDaemon` keeps the port it asked for as
`configuredPort` (the `PORT` env, the socket's name, artifact names) and `port` becomes the port in the daemon's last
`[hooks] listening on 127.0.0.1:<n>` line, which `start()` waits for before it asks `/api/health`. The real backend
is started with `PORT=0` and `PORT_APP_PROXY=0`, logs the port it bound, and the harness reads that line.
`cloudAgents.e2e.ts` drops its own pick for the harness's `HARNESS_CONNECTIONS_PORT: '0'`. Four stack scripts run by
hand (`cli/scripts/`) take the same two ways: the backend's line for its port, and for a daemon the record it writes of
the port it bound.

**Tech Stack:** TypeScript, Vitest 4.1 (`pool: 'forks'`), Node 24 (CI pins 24.22.2), Fastify (backend). No new
dependency.

**Spec:** [docs/plans/2026-11-14-e2e-free-port-race-design.md](2026-11-14-e2e-free-port-race-design.md). Read it with
this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `backend/AGENTS.md`. The spec is the authority.

## Decided, and still open

The draft's four questions are answered in the spec ("Decisions on the plan's questions"): `cli.e2e.ts` reads the
daemon's own record (Task 1); `noSocket.e2e.ts`'s first case is left as it is and named in the pull request (Left
out); `twodaemons.e2e.ts:309` starts `release` first and passes `release.port` (Task 1); the scripts outside
`cli/e2e/` are Tasks 5 to 8, and one of them is left out with its reason (Left out).

Answered after the update (main session, within the orchestrator's rule "same cause, fix it unless it needs a
product change or a large rewrite"): Docker's two ports in `cli/scripts/local-stack-peer.ts` (`mongoPort`,
`redisPort`) are Task 8's too. Docker chooses them (`-p 127.0.0.1::27017`, `-p 127.0.0.1::6379`) and the script
reads each back with `docker port <name> <port>/tcp` before it builds `DATABASE_URL` and `REDIS_URL`.

Runs of Tasks 7 and 8: a script's daemons get the caller's `HOME`, so every run of them sets `HOME` (and every other
home the script passes on) to a throwaway folder of the task's own; never the person's own home. The orchestrator
decides whether Task 8 may start Docker Desktop; until then Task 8 does its edit and static checks and reports
`not run`.

## Global Constraints

- A flaky test is a bug, fixed at its layer with a red-then-green test. No retry, no longer timeout, no new option,
  no fixed sleep: a wait is on a condition, with a bound.
- No change to the daemon's own fallback or socket naming (spec, Non-goals). Product code changes in one place only:
  the backend's listening line. Under `cli/src/` only `cli/src/testing/`: two new specs, and one helper the harness
  and the stack scripts share.
- The spec's values, verbatim: the line `[hooks] listening on 127.0.0.1:<n>`; the error
  `the daemon has not said which port it listens on yet`; `PORT=0` and `PORT_APP_PROXY=0`; the line
  `backend listening on <n>`; the harness's `HARNESS_CONNECTIONS_PORT: '0'`.
- The backend line carries a port and nothing else: no user data, no address.
- End-to-end files are not typechecked (`cli/tsconfig.json` includes `src/**/*` only): a `d.port` that breaks is
  found by reading and by running the file, never by `tsc`. The sites are listed below; a task that finds another
  adds it to its report.
- No local full suite. A task runs only the tests of what it changed. Every local end-to-end run is under
  `caffeinate -i`, with `E2E_BUNDLE=1` and a short TMPDIR of the task's own (`/private/tmp/claude-502/fpr-t<N>/`,
  made first with `mkdir -p`): an agent's TMPDIR on this Mac is too long for the daemon's socket.
- Never run or list `e2e/agentBrowserPodman.e2e.ts` locally: it acts on the machine's real Podman.
- The GitHub workflow `cli-e2e` is heavy: ask the orchestrator before every run of it.
- Where `cli/node_modules` or `backend/node_modules` is missing, once, before the first run:
  `(cd cli && npm ci --no-audit --no-fund)`, and for Tasks 3 and 5 to 8 and the Verification
  `(cd backend && npm ci --no-audit --no-fund)`.
- Comments say why, in plain sentences, and name the incident (cli-e2e run 43568618113, shard 2, `turns.e2e.ts`).
- Platforms: the harness runs on macOS and Linux, where cli-e2e runs; the backend line runs wherever the backend
  does. One pull request; its body names them and carries each task's red and green output and the Verification
  results.
- The pull request's body names what is left out, each with its reason (see Left out): first of all
  `noSocket.e2e.ts`'s first case, which can still meet a stolen port.

## Found while reading the code

Checked at `447b4a07e3`.

- **The daemon's line** is `[hooks] listening on 127.0.0.1:${actual} (SessionStart/SessionEnd callbacks)`
  (`cli/src/hookServer.ts:1413`), printed once per core start; `startHookServer` has one caller
  (`cli/src/core/main.ts:2275`). The socket's line (`[hooks] listening on <path>`, `:1420`) and the core's summary
  (`[cli] daemon pid … listening on 127.0.0.1:<n>`, `main.ts:2413`) are other lines. Releases since 0.3.60 print it
  the same (`git grep` at `v0.3.60_cli`), so the bundles of released builds the compat, migration and rehearsal tests
  run say it too.
- **Which port a core binds:** `daemonPort()`, the port its record holds (`daemon-<configured>.json`,
  `cli/src/lib/daemonRecord.ts`), else `PORT`. On `EADDRINUSE` it listens on port 0 instead, but only with a socket
  (`hookServer.ts:1394`). The record is written once the core is bound (`main.ts:2379`).
- **`d.port` as the bound port is right for the uses that stay:** hooks are installed with the bound port
  (`main.ts:3507`), so hook files name it (`eagerHooks.e2e.ts:283,286`, `hermesTerminalRecord.e2e.ts:71`,
  `twodaemons.e2e.ts:155-156`); the CLI's own clients take either port (`cli/src/lib/localTransport.ts:34-50`), so
  `where: { port }` (`superTabs.e2e.ts:109`, `superTabChannel.e2e.ts:108`, `superTabsCollaboration.e2e.ts:115`,
  `swarmV4Team.e2e.ts:102`, `swarmV4Journey.e2e.ts:121`, `superTabTerminal.e2e.ts:40`) reaches the daemon.
- **Every `.port` of a daemon in `cli/e2e` was read** (100 lines match `\.port\b`; 82 are a daemon's, 18 of them
  change and 64 stay). The ones that change, and one script beside them:

  | Site | Why | Becomes | Task |
  | --- | --- | --- | --- |
  | `noSocket.e2e.ts:37` | read before `start`; names a socket | `d.configuredPort` | 1 |
  | `lean.e2e.ts:188` | a second daemon on the same `PORT` and socket | `d.configuredPort` | 1 |
  | `twodaemons.e2e.ts:246` | read before `start`; the same `PORT` and socket | `first.configuredPort` | 1 |
  | `twodaemons.e2e.ts:249`, `:262` | the master that loses may never say a port | the winner's `port` | 1 |
  | `twodaemons.e2e.ts:309`, `:310` | `dev` must be asked for the port `release` holds, whichever it took | `release` started first; `port: release.port` | 1 |
  | `twodaemons.e2e.ts:315`, `:316` | the daemon logs, and names its record by, the port it was configured with | `dev.configuredPort` | 1 |
  | `cli.e2e.ts:109`, `:175`, `:188` | the daemon is started by `harness start`: no output to read | the daemon's record | 1 |
  | `endurance.e2e.ts:317` | a failure handler set before `start`; a file name | `d.configuredPort` | 1 |
  | `footprint.e2e.ts:183` | read inside a timed window; the getter reads the daemon's output | read before the clock | 1 |
  | `cli/scripts/spike-a-stack.ts:101` | compared with a process's `PORT` | `B.daemon.configuredPort` | 1 |
  | `harness/daemon.ts:389`, `:434`, `:552`, `:565` | the socket's name and artifact names | `this.configuredPort` | 1 |
  | `harness/daemon.ts:451` | the health poll | the port this start said | 2 |

- **The eleven `start({ ready: 'none' })`:** `noSocket.e2e.ts:40` (`:42` connects over TCP after `[cli] ready`: safe),
  `twodaemons.e2e.ts:247` (above), `:284` and `:298` (socket clients, no port read), `masterIpcExit.e2e.ts:47` (`:60`
  reads after the second core's `[cli] ready`: safe), `master.e2e.ts:148` and `:201` (no port read),
  `orphan.e2e.ts:68` (`:75` reads after an earlier full start: the last line said), `lean.e2e.ts:190` (the second
  daemon's port is never read), `stall.e2e.ts:226` (no port read), `portHolder.e2e.ts:27` (Task 2).
- **Harness files:** `client.ts:55` (`tcp`), `realBackend.ts:193` (`signIn`) and `socketScenario.ts:276` read the port
  after `daemon.start()` returned: unchanged. The cleanup helpers that run `lsof` on `daemon!.port`
  (`migration.e2e.ts:80`, `releaseRehearsal.e2e.ts:75`, `updateOnItsOwn.e2e.ts:49`) read it inside their own
  `try`: a daemon that never said a port has no listener to find.
- **cli-e2e has no list of real-backend specs.** Every shard sets `HARNESS_E2E_SERVICES_DIR`
  (`.github/workflows/cli-e2e.yml:94-102`) and runs the discovered inventory, so a new `e2e/*.e2e.ts` runs there with
  no workflow change; a file with no hint in `cli/ci-e2e-durations.json` costs the default.
- **The backend's line has no red test of its own.** `backend/src/server.ts` starts on import (Mongo, Redis, three
  listeners) and no backend test imports or starts it; `backend/package.json` has no lint script. The real-backend
  harness spec of Task 3 is its red test; its other checks are `npm run typecheck` and PR CI's `backend-desk`.
- **The backend's log under `NODE_ENV=test`** is `[<iso time>] [INFO] <message>` (`backend/src/utils/logger.ts`). The
  app proxy logs `backend subdomain app-proxy listening on ${env.PORT_APP_PROXY}` (`lib/subdomainProxy.ts:147`): with
  `PORT_APP_PROXY=0` that prints `0`, and it is left alone (no test uses the proxy). `env.PORT` is read nowhere but
  `server.ts:271-272`. The metrics listener's fixed port already costs only the scrape when taken (`lib/metrics.ts`).
- **The stand-in for the pick was tried** on Vitest 4.1.10, `pool: 'forks'`: `vi.mock('node:net', factory)` replaces
  the `createServer` a project module imports from `node:net`; a `node:http` server and a `createRequire`d
  `node:net` (how `mongodb-memory-server` is loaded) keep the real one.
- **The stack scripts** (`cli/scripts/share-harness-e2e.ts`, `box-claim-e2e.ts`, `remote-viewers-stack.ts`,
  `local-stack-peer.ts`) are run by hand and by no workflow (`scripts/ci-plan.py:207-209`). Each has a `freePort()`
  of its own and picks the backend's `PORT` and `PORT_APP_PROXY` and every daemon's `PORT` with it. They start the
  backend from source (`tsx src/server.ts`, `NODE_ENV=test`) with its output in a file under their root
  (`backend.log`; `backend-<index>.log` in remote-viewers), so Task 3's line is theirs to read. Their daemons are
  `tsx src/cli.ts __run` (box-claim: the bundle's `harness start`); with a master or without, the core writes
  `daemon-<configured>.json` once bound (`main.ts:2379`), so the record is there to read for all of them. No test
  uses the app proxy.
- **The scripts cannot load the harness:** `e2e/harness/artifacts.ts` imports `vitest`
  (`cli/scripts/spike-a-stack.ts:15-17` stands in a worker state to get past it). What they share with the harness
  lives in `cli/src/testing/`, as `socketPathRoom.ts` and `ghStub.ts` do; two of them import `../src/lib/` already.
- **A script's daemon falls back only with a socket** (`hookServer.ts:1394`). Under this Mac's own TMPDIR (48 bytes)
  the data folders of share-harness and box-claim are too long for one (`lib/localSocket.ts`: 96 bytes, and their
  home is under the same root), so there a taken port still fails that daemon with `EADDRINUSE`, as in
  `noSocket.e2e.ts`. Under the short TMPDIR of this plan's runs the socket fits and the daemon moves.
- **remote-viewers starts backend 1 again after an outage** (`:316-318`) while its daemon's `BACKEND_WS_URL` stays:
  that boot must bind the port the first one bound. **share-harness takes `HARNESS_SHARE_BACKEND_PORT`**, a caller's
  fixed port (`:141`): it stays.
- **None of the four has a place for a cheap red test:** the pick is inside a top-level script with no seam, and a
  run is a whole stack (a backend, Mongo, Redis, two or three daemons, tmux; Chrome, Docker or Flutter for three).
- **`daemons/e2e/sandbox.mjs`** keeps seven picked ports in `state.json`, which its own commands (`up`, `backend`,
  `harnessd`, `status`, `down`), `client.mjs`, `services.mjs`, `daemons.e2e.test.mjs` and the Desktop test read on
  later runs; it also runs backend builds of older refs (`build-ref.sh`, `E2E_OLD_BACKEND`), which print the
  configured port. See Left out.
- **Local gates:** `python3 scripts/local-checks.py --list` on the paths of the File map prints `{}`. Nothing under
  `cli/src/core`, `cli/src/services` or `cli/src/harnessd` changes, so `npm run test:core` and `test:harnessd` are
  not needed.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/e2e/harness/daemon.ts` | `configuredPort` (1); `listeningPort`, the `port` getter, `start()` (2) | 1, 2 |
| `cli/e2e/noSocket.e2e.ts`, `lean.e2e.ts`, `twodaemons.e2e.ts`, `cli.e2e.ts`, `endurance.e2e.ts`, `footprint.e2e.ts` | the sites of the table above | 1 |
| `cli/scripts/spike-a-stack.ts` | line 101 | 1 |
| `cli/src/testing/daemonListeningPort.spec.ts` | new | 2 |
| `cli/e2e/portHolder.e2e.ts` | the existing case's new asserts; a second case | 2 |
| `cli/e2e/realBackendPort.e2e.ts` | new | 3 |
| `cli/src/testing/backendListeningPort.ts`, `backendListeningPort.spec.ts` | new: the backend's line, read from a log | 3 |
| `cli/e2e/harness/realBackend.ts` | no pick; the wait reads the log | 3 |
| `backend/src/server.ts` | logs the port it bound (`:272`) | 3 |
| `cli/e2e/cloudAgents.e2e.ts` | its `freePort` and three overrides go | 4 |
| `cli/scripts/share-harness-e2e.ts` | the backend's port from its log; three daemons' ports from their records | 5 |
| `cli/scripts/box-claim-e2e.ts` | the same; two boxes | 6 |
| `cli/scripts/remote-viewers-stack.ts` | the same; two backends, two daemons | 7 |
| `cli/scripts/local-stack-peer.ts` | the same; one backend, one daemon | 8 |

## Review Focus

Each line is pinned by a test in the task that owns the code.

- A stranger that is no daemon holds the picked port (the incident: the harness asked 34881 until its 60 s ran out):
  `start()` ends ready on the port the daemon took, and a TCP client connects there. Task 2, second case.
- A restart moves the daemon to another port: the harness follows the last line, not the first. Task 2, second case
  (its second half) and the spec's second test.
- A line caught in the middle of its port (a daemon's output arrives in chunks; the backend's log is read while it
  is written), or a log file not made yet (a script's is opened as its backend starts): never read as a shorter port,
  never an error. Task 2, the spec's fourth test; Task 3, the spec's third and fourth tests.
- The backend exits before it says its port: the wait ends at once with the exit and the log's own words, not at
  its 120 s. Task 3, the end-to-end spec's second case.
- A port read before the daemon said one, or of a daemon the harness did not start: an error by name, never a guess.
  Task 2, first case (`toThrow`), and the four files of Task 1 run again on the getter (Task 2, step 5).

---

### Task 1: `configuredPort`, and every use that means it

**Depends on:** nothing. **Effort:** high.

**Test that must fail first:** none. No behaviour changes: until Task 2, `port` and `configuredPort` are the same
number, and a daemon made after another has started is made as before. One commit.

**Files:**
- Modify: `cli/e2e/harness/daemon.ts` (249, 389, 434, 552, 565)
- Modify: `cli/e2e/noSocket.e2e.ts` (37), `cli/e2e/lean.e2e.ts` (188), `cli/e2e/twodaemons.e2e.ts` (246-251, 262,
  308-310, 315-316), `cli/e2e/cli.e2e.ts` (imports, 109, 175, 188), `cli/e2e/endurance.e2e.ts` (317),
  `cli/e2e/footprint.e2e.ts` (182-183), `cli/scripts/spike-a-stack.ts` (101)

**Interfaces:**
- Produces: `IsolatedDaemon.configuredPort: number` (readonly; what `PORT` is set to and what the `port` option
  sets). `IsolatedDaemon.port` keeps its type and, in this task, its value.

- [ ] **Step 1: `daemon.ts`**

The constructor's third parameter becomes `readonly configuredPort: number`, with a comment: what `PORT` is set to,
which names the socket (`daemon-<n>.sock`), the daemon's record and its artifacts. Add
`get port(): number { return this.configuredPort }` beside `socketPath`, commented `The port its control server
answers on.` `socketPath` (389) and the three artifact names (434, 552, 565) read `this.configuredPort`. The health
poll (451) keeps `this.port`.

- [ ] **Step 2: The sites**

- `noSocket.e2e.ts:37`: `localSocketName(d.configuredPort)`.
- `lean.e2e.ts:188`: `port: d.configuredPort`.
- `twodaemons.e2e.ts:246`: `port: first.configuredPort`. `:315`:
  `` `[hooks] control port ${dev.configuredPort} unavailable; assigning a separate port` ``. `:316`:
  `` `daemon-${dev.configuredPort}.json` ``. `:317` and `:319` keep `release.port`. `:262`:
  `status(winner!.port)`. `:308-310` (the spec's decision 3): `release` is started before `dev` is made, and `dev` is
  asked for the port `release` answers on. The old `await release.start()` at 310 goes:

  ```ts
  const release = await make('release')
  await release.start()
  // The port release holds, whichever it took. Asked for the one release was configured with, dev could find it free
  // (release moved off it, and whoever had it left) and never be refused.
  const dev = await make('dev', { beside: release, port: release.port })
  ```

  The wait at 248-251 becomes:

  ```ts
  await until('a daemon to serve', async () => {
    // Either master's core may be the one that serves, and the other may never say a port: the pid file names it.
    const serving = [first, second].find((daemon) => daemon.pid !== null && daemon.pid === pidFile(first))
    if (!serving || !existsSync(first.socketPath)) return null
    return (await fetch(`http://127.0.0.1:${serving.port}/api/health`).catch(() => null))?.ok ? true : null
  }, 90_000, 200)
  ```

- `cli.e2e.ts` (the spec's decision 1): import `savedDaemonPort` from `../src/lib/daemonRecord.js` and add, above `statusOf`:

  ```ts
  /** The port this machine's daemon bound, as the daemon recorded it (`daemon-<configured>.json`): `harness start` runs
   *  it, so the harness never sees its output and cannot say which port it took. */
  const portOf = (m: Machine): number => savedDaemonPort(m.daemon.dataDir, m.daemon.configuredPort)
  ```

  Lines 109, 175 and 188 use `portOf(m)` in place of `m.daemon.port`.
- `endurance.e2e.ts:317`: `` `daemon-${d.configuredPort}.log` `` (the handler is set before `start`).
- `footprint.e2e.ts:182-183`: read the port into a `const` on the line before `const sent = performance.now()`, with
  a comment that the harness finds it in the daemon's output and the clock must not count that; the `fetch` uses it.
- `cli/scripts/spike-a-stack.ts:101`: `String(B.daemon.configuredPort)` (it is compared with a process's `PORT`).

- [ ] **Step 3: Run the files whose logic changed**

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/fpr-t1/ && mkdir -p "$TMPDIR"
E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/noSocket.e2e.ts e2e/twodaemons.e2e.ts e2e/cli.e2e.ts
```

Expected: 3 files passed; 2, 7 and 8 tests passed, none skipped.

- [ ] **Step 4: Commit**

```bash
git add cli/e2e/harness/daemon.ts cli/e2e/noSocket.e2e.ts cli/e2e/lean.e2e.ts cli/e2e/twodaemons.e2e.ts \
  cli/e2e/cli.e2e.ts cli/e2e/endurance.e2e.ts cli/e2e/footprint.e2e.ts cli/scripts/spike-a-stack.ts
git commit -m "e2e: configuredPort names the port a daemon under test was asked for"
```

---

### Task 2: `port` is the port the daemon said it bound

**Depends on:** Task 1 (the same `daemon.ts`; its sites must already be off `port`). **Effort:** xhigh (every
end-to-end file starts through this code, and it reads a process's output as it arrives).

**Test that must fail first:** `cli/src/testing/daemonListeningPort.spec.ts` (new) and both cases of
`cli/e2e/portHolder.e2e.ts`.

**Files:**
- Create: `cli/src/testing/daemonListeningPort.spec.ts`
- Modify: `cli/e2e/portHolder.e2e.ts`
- Modify: `cli/e2e/harness/daemon.ts` (`freePort`'s comment at 110; the `port` getter; `start()` at 450-453)

**Interfaces:**
- Consumes: `IsolatedDaemon.configuredPort` (Task 1).
- Produces: `export function listeningPort(output: string): number | null` in `daemon.ts`: the port in the last
  `[hooks] listening on 127.0.0.1:<n> (` line of `output`, or `null`. `IsolatedDaemon.port` is a getter:
  `listeningPort` of all the daemon's output so far, and with none it throws
  `the daemon has not said which port it listens on yet`.

- [ ] **Step 1: Write the failing spec**

`cli/src/testing/daemonListeningPort.spec.ts`. The harness is outside `tsconfig`'s `rootDir`, so it is loaded
untyped, as `releaseFixtures.spec.ts` loads it.

```ts
import { expect, it } from 'vitest'

const { listeningPort } = await import('../../e2e/harness/daemon.js' as string) as { listeningPort: (output: string) => number | null }
const said = (port: number) => `[hooks] listening on 127.0.0.1:${port} (SessionStart/SessionEnd callbacks)\n`

it('reads the port the daemon said it listens on', () => {
  expect(listeningPort(`[hooks] control port 34881 unavailable; assigning a separate port for this user\n${said(42457)}`)).toBe(42457)
})
it('follows the last line: a core started again on another port', () => {
  expect(listeningPort(`${said(42457)}[harnessd] core started (pid 2)\n${said(42999)}`)).toBe(42999)
})
it('has no port before the daemon said one: the socket\'s line and the core\'s summary are other lines', () => {
  expect(listeningPort('')).toBeNull()
  expect(listeningPort('[hooks] listening on /tmp/h/data/daemon-34881.sock\n[cli] daemon pid 7 · v0.6.12 · listening on 127.0.0.1:34881\n')).toBeNull()
})
it('does not read a line caught in the middle of its port', () => {
  expect(listeningPort('[hooks] listening on 127.0.0.1:424')).toBeNull()
  expect(listeningPort(`${said(42457)}[hooks] listening on 127.0.0.1:429`)).toBe(42457)
})
```

- [ ] **Step 2: Write the failing end-to-end cases**

`cli/e2e/portHolder.e2e.ts`. Add `type Server` to the `node:http` import and
`import { LocalClient } from './harness/client.js'`.

In the existing case, after `started.push(d)` and before `d.start({ ready: 'none' })`:

```ts
    // Until the daemon says where it listens the harness has no port for it: never the one it asked for.
    expect(d.configuredPort).toBe(port)
    expect(() => d.port).toThrow('the daemon has not said which port it listens on yet')
```

and after the wait for `assigning a separate port`:

```ts
    // The harness follows it there, and the daemon answers on that port as itself. Asked with no credential, as
    // anyone can: this request must never carry one to the holder.
    const bound = await until('the daemon to say which port it took', () => d.port, 30_000)
    expect(bound).not.toBe(port)
    const status = await until('the daemon to answer on the port it took', async () => {
      const answer = await (await fetch(`http://127.0.0.1:${bound}/api/status`)).json() as Record<string, unknown>
      return answer.corePid ? answer : null
    }, 30_000, 200)
    expect(status).toMatchObject({ pid: d.pid, corePid: d.corePid() })
```

The hook's `--port` stays `String(port)`: the socket is named for the configured port.

A second case:

```ts
it('start() follows the daemon to the port it took, and again when a restart moves it', async () => {
  // cli-e2e run 43568618113, shard 2 (turns.e2e.ts): the port picked for the daemon was taken before it bound. The
  // daemon said `control port 34881 unavailable`, listened on 42457, and the harness asked 34881 until its 60 s ran
  // out. A stranger that is no daemon: it answers 503 to everything.
  const strangers: Server[] = []
  const hold = (port: number) => new Promise<number>((resolve, reject) => {
    const stranger = createServer((_req, res) => { res.writeHead(503).end() })
    stranger.once('error', reject)
    stranger.listen(port, '127.0.0.1', () => { strangers.push(stranger); resolve((stranger.address() as AddressInfo).port) })
  })
  try {
    const port = await hold(0)
    const d = await IsolatedDaemon.create({ port })
    started.push(d)
    await d.start()
    const first = d.port
    expect(first).not.toBe(port)
    let client = await LocalClient.connect(d, { tcp: true })
    client.close()
    // Stopped, and the port it had is taken too: the next start moves again, and the harness with it.
    await d.stop()
    await until('the port the daemon left to be taken', () => hold(first).catch(() => null), 10_000, 100)
    await d.start()
    expect([port, first]).not.toContain(d.port)
    client = await LocalClient.connect(d, { tcp: true })
    client.close()
  } finally {
    for (const stranger of strangers) {
      stranger.closeAllConnections()
      await new Promise<void>((resolve) => { stranger.close(() => resolve()) })
    }
  }
}, 180_000)
```

- [ ] **Step 3: Run them to see them fail**

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/fpr-t2/ && mkdir -p "$TMPDIR"
npx vitest run src/testing/daemonListeningPort.spec.ts
E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/portHolder.e2e.ts
```

Expected: the spec, 4 failed (`listeningPort is not a function`). `portHolder`, 2 failed: the first on
`expected [Function] to throw an error`, the second after about a minute on
`timed out after 60000ms waiting for the daemon to answer on its port`, which is the incident.
Commit the two test files alone: `e2e: specs that the harness follows a daemon to the port it bound (red)`.

- [ ] **Step 4: `listeningPort`, the getter and `start()`**

- `listeningPort`: the last match of `/\[hooks\] listening on 127\.0\.0\.1:(\d+) \(/g`. The bracket after the number
  is part of the match on purpose (a line cut inside its port); say so in its comment.
- `get port()`: `listeningPort(this.output)`, or throw `the daemon has not said which port it listens on yet`. Its
  comment says it follows a core the master starts again, as `corePid()` does.
- `start()`: the wait `the daemon to answer on its port` keeps its 60 s and its 200 ms. Each time, its probe takes
  `listeningPort(this.output.slice(from))` (this start's own line, never an earlier boot's), throws the getter's
  error when there is none, and asks `/api/health` on that port. `until` keeps the last error, so a daemon that
  never says its port times out by name. No second wait and no second deadline.
- `freePort()`: unchanged; its comment says what it is now. It picks the port a daemon is configured with (`PORT`,
  the socket's name, artifact names), and one taken by the time the daemon binds is harmless: the daemon moves and
  the harness reads where to. Name the run.

- [ ] **Step 5: Run the checks**

```bash
cd cli
npx vitest run src/testing/daemonListeningPort.spec.ts                                              # 4 passed
E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/portHolder.e2e.ts       # 2 passed
E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/turns.e2e.ts \
  -t 'a /goal that pauses after its hook refuses to stop'                                           # 1 passed, the rest skipped
E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts \
  e2e/noSocket.e2e.ts e2e/twodaemons.e2e.ts e2e/lean.e2e.ts e2e/cli.e2e.ts                          # 2, 7, 7 and 8 passed
npm run typecheck                                                                                   # no error
```

The last end-to-end line is Task 1's sites on the real getter: a failure there with
`the daemon has not said which port it listens on yet` is a site this plan missed. Fix it as its row in the table
would be, and name it in the report.

- [ ] **Step 6: Commit**

```bash
git add cli/e2e/harness/daemon.ts
git commit -m "e2e: the harness reads the port a daemon bound from what the daemon says"
```

---

### Task 3: The real backend binds a port of the system's choosing, and says which

**Depends on:** nothing. **Effort:** high.

**Test that must fail first:** `cli/e2e/realBackendPort.e2e.ts`, first case, and
`cli/src/testing/backendListeningPort.spec.ts` (both new). The backend's line has no test of its own (see
"Found while reading the code"): the first is its red test.

**Files:**
- Create: `cli/e2e/realBackendPort.e2e.ts`, `cli/src/testing/backendListeningPort.ts`,
  `cli/src/testing/backendListeningPort.spec.ts`
- Modify: `backend/src/server.ts` (271-272)
- Modify: `cli/e2e/harness/realBackend.ts` (the `node:net` import at 6, `freePort` at 62-68, 121, 138, 153-160, 166)

**Interfaces:**
- Produces, in `cli/src/testing/backendListeningPort.ts` (it imports `node:fs` and nothing else: the stack scripts
  of Tasks 5 to 8 load it too, and cannot load the harness):
  - `export function backendListeningPort(log: string): number | null`: the port of the backend's
    `backend listening on <n>` line in its log, or `null`.
  - `export function backendListeningPortIn(logPath: string): number | null`: the same, of the log file at
    `logPath`; `null` too while that file is not there.
- Produces: the backend's line `backend listening on <bound port>`. `RealBackend` keeps its shape; `url` and `wsUrl`
  carry the port the backend bound.

- [ ] **Step 1: Write the failing spec**

`cli/src/testing/backendListeningPort.spec.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { backendListeningPort, backendListeningPortIn } from './backendListeningPort.js'

const at = '[2026-11-14T03:04:05.678Z] [INFO] '
const proxy = `${at}backend subdomain app-proxy listening on 0 {"suffix":".harness.autonomous.ai"}\n`

it('reads the port the backend said it bound', () => {
  expect(backendListeningPort(`${proxy}${at}backend listening on 43121\n`)).toBe(43121)
})
it('has no port before the backend said one: the app proxy\'s line is another listener\'s', () => {
  expect(backendListeningPort('')).toBeNull()
  expect(backendListeningPort(proxy)).toBeNull()
})
it('does not read a line caught in the middle of its port', () => {
  expect(backendListeningPort(`${proxy}${at}backend listening on 431`)).toBeNull()
})
it('reads a log file, and has no port while the file is not there yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backend-port-'))
  try {
    expect(backendListeningPortIn(join(dir, 'backend.log'))).toBeNull()
    writeFileSync(join(dir, 'backend.log'), `${proxy}${at}backend listening on 43121\n`)
    expect(backendListeningPortIn(join(dir, 'backend.log'))).toBe(43121)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Write the failing end-to-end spec**

`cli/e2e/realBackendPort.e2e.ts`:

```ts
/**
 * The real backend's port is the one it bound (harness/realBackend.ts). The harness used to open a listener on port 0,
 * read its port, close it and hand the number to the backend: anything could take the port in between, and the harness
 * then waited on, and gave its tests the address of, whoever held it. The daemon's side of the same pick failed cli-e2e
 * run 43568618113 (shard 2).
 *
 * Here that race is lost every time. A stranger holds a port, and any listener the harness opens through `node:net` to
 * pick one is told it got that port. With no pick the stand-in is never asked and the stranger hears nothing; a pick
 * that comes back goes straight to the stranger, and this fails.
 *
 * Needs the backend's in-memory Mongo and Redis (HARNESS_E2E_SERVICES_DIR, see harness/realBackend.ts).
 */
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRealBackend, type RealBackend } from './harness/realBackend.js'

/** The port every `node:net` listener of the harness is told it got, while one is set. */
const pick = vi.hoisted(() => ({ port: 0 }))
vi.mock('node:net', async (original) => {
  const net = await original<typeof import('node:net')>()
  const createServer = (...args: Parameters<typeof net.createServer>) => {
    const server = net.createServer(...args)
    const address = server.address.bind(server)
    server.address = () => {
      const real = address()
      return pick.port && real && typeof real === 'object' ? { ...real, port: pick.port } : real
    }
    return server
  }
  return { ...net, createServer, default: { ...net.default, createServer } }
})

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('the real backend\'s port', () => {
  let backend: RealBackend | undefined
  let stranger: Server | undefined
  const limit = process.env.ROUTE_RATE_LIMIT_PER_CALLER_SECOND
  afterEach(async () => {
    pick.port = 0
    if (limit === undefined) delete process.env.ROUTE_RATE_LIMIT_PER_CALLER_SECOND
    else process.env.ROUTE_RATE_LIMIT_PER_CALLER_SECOND = limit
    await backend?.stop()
    backend = undefined
    stranger?.closeAllConnections()
    await new Promise<void>((done) => { if (stranger) stranger.close(() => done()); else done() })
    stranger = undefined
  })

  it('is the port the backend bound: a port a stranger holds is never handed to it, and the stranger hears nothing', async () => {
    const heard: string[] = []
    stranger = createServer((req, res) => { heard.push(`${req.method} ${req.url}`); req.resume(); res.end('{}') })
    await new Promise<void>((resolve) => { stranger!.listen(0, '127.0.0.1', resolve) })
    pick.port = (stranger.address() as AddressInfo).port
    backend = await startRealBackend([], () => {})
    const said = [...readFileSync(backend.logPath, 'utf8').matchAll(/ backend listening on (\d+)\n/g)].map((line) => Number(line[1]))
    expect(said).toHaveLength(1)
    expect(Number(new URL(backend.url).port)).toBe(said[0])
    expect(new URL(backend.wsUrl).port).toBe(new URL(backend.url).port)
    expect(await (await fetch(`${backend.url}/api/health`)).json()).toMatchObject({ success: true, data: { status: 'ok' } })
    expect(heard).toEqual([])
  }, 300_000)

  it('ends the wait at once, in the backend\'s own words, when the backend exits before it says its port', async () => {
    // Refused by the backend's own check of its settings (backend/src/config/env.ts): it exits as it starts.
    process.env.ROUTE_RATE_LIMIT_PER_CALLER_SECOND = '-1'
    await expect(startRealBackend([], () => {})).rejects.toThrow(/the backend exited \(1\) while starting; backend log [^]*Invalid environment variables/)
  }, 300_000)
})
```

- [ ] **Step 3: Run them to see them fail**

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/fpr-t3/ && mkdir -p "$TMPDIR"
npx vitest run src/testing/backendListeningPort.spec.ts
HARNESS_E2E_SERVICES_DIR="$HOME/test-services" HARNESS_E2E_REDIS_SERVER=/usr/local/bin/redis-server \
HARNESS_E2E_MONGOD="$HOME/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6" \
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/realBackendPort.e2e.ts
```

Expected: the spec's file fails before any test runs (its import of `./backendListeningPort.js` does not resolve).
The end-to-end file, 1 failed and 1 passed: the first case on `expected [] to have a length of 1` (the harness took the stranger's `{}` for a ready backend and
returned before the backend said anything); the second passes today and must still pass after step 6. `2 skipped`
is not a red: the file skips without `HARNESS_E2E_SERVICES_DIR`. On a machine without that folder it is made as
`.github/workflows/cli-e2e.yml:98-100` makes it; without `HARNESS_E2E_MONGOD`, MongoDB is downloaded.
Commit the two test files alone: `e2e: specs that the real backend's port is the one it bound (red)`.

- [ ] **Step 4: `backend/src/server.ts`**

Line 272 logs the port of `app.server.address()` (an `AddressInfo` of `net`) in place of `env.PORT`:
`backend listening on <bound port>`. A comment, on lines of its own, says why: with `PORT=0` the system picks the
port and the CLI's end-to-end harness and stack scripts read it from this line
(`cli/src/testing/backendListeningPort.ts`); with a fixed `PORT`, as in production, the line reads as before. Nothing
else on the line.

- [ ] **Step 5: `cli/src/testing/backendListeningPort.ts`**

- `backendListeningPort`: the first match of `/ backend listening on (\d+)\n/`. The newline is part of the match on
  purpose (the log is read while it is written); say so in its comment, and that the harness and the stack scripts
  (`cli/scripts/`) both read the backend's port with it.
- `backendListeningPortIn`: `backendListeningPort` of the file's text; `null` for a file that is not there (`ENOENT`),
  any other error thrown.

- [ ] **Step 6: `cli/e2e/harness/realBackend.ts`**

- Remove `freePort` and the `node:net` import; line 121 goes. The backend is spawned with `PORT: '0'` and
  `PORT_APP_PROXY: '0'`, with a comment that names the run and says the harness reads the port the backend bound.
- The one wait `backend readiness` keeps its 120 s. Its check, in this order: the exit test as today (it throws
  `WaitEnded`); the port, from `backendListeningPortIn(logPath)` (imported from
  `../../src/testing/backendListeningPort.js`), kept once found, `false` while there is none; then `/api/ready` on
  that port as today.
- `url` and `wsUrl` are built from that port.

- [ ] **Step 7: Run the checks**

```bash
cd cli
npx vitest run src/testing/backendListeningPort.spec.ts src/testing/realBackendApi.spec.ts          # 4 passed, and the file's own as before
HARNESS_E2E_SERVICES_DIR="$HOME/test-services" HARNESS_E2E_REDIS_SERVER=/usr/local/bin/redis-server \
HARNESS_E2E_MONGOD="$HOME/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6" \
caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/realBackendPort.e2e.ts              # 2 passed
npm run typecheck                                                                                   # no error
(cd ../backend && npm run typecheck)                                                                # no error
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/server.ts cli/e2e/harness/realBackend.ts cli/src/testing/backendListeningPort.ts
git commit -m "e2e: the real backend binds a port of the system's choosing and says which"
```

---

### Task 4: `cloudAgents.e2e.ts` takes the harness's bridge port

**Depends on:** nothing. **Effort:** medium.

**Test that must fail first:** none. Nothing in the test reads the port it picked (a leftover from before the
harness set `HARNESS_CONNECTIONS_PORT: '0'`, #4027); the file itself passing is the check (spec, Tests). One commit.

**Files:**
- Modify: `cli/e2e/cloudAgents.e2e.ts` (13, 20-25, 105-107, 212-213, 249-250)

- [ ] **Step 1: Remove the pick**

Delete `freePort` (20-25) and the `node:net` import (13), the three `const port = await freePort()` lines (105, 212,
249) and the three `HARNESS_CONNECTIONS_PORT: String(port)` entries (107, 213, 250). The third daemon is then
`IsolatedDaemon.create()` with no options.

- [ ] **Step 2: Run the file**

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/fpr-t4/ && mkdir -p "$TMPDIR"
E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/cloudAgents.e2e.ts      # 3 passed
grep -n "freePort\|HARNESS_CONNECTIONS_PORT\|node:net" e2e/cloudAgents.e2e.ts                       # prints nothing
```

- [ ] **Step 3: Commit**

```bash
git add cli/e2e/cloudAgents.e2e.ts
git commit -m "e2e: cloudAgents takes the harness's bridge port"
```

---

## Tasks 5 to 8: the stack scripts

Four scripts, one task each: no two share a file, so they run together once Task 3 is in. Each is the spec's
decision 4, with the two ways this branch has and nothing new. None depends on Task 1 or 2: the record is the
product's own.

**The backend's port (Task 3's way).** The backend is spawned with `PORT: '0'` and `PORT_APP_PROXY: '0'`; the picks
of both go. The script's own wait for the backend, with the deadline it has today, first reads the port from the
backend's log with `backendListeningPortIn(<the log's path>)`
(`import { backendListeningPortIn } from '../src/testing/backendListeningPort.js'`) on every attempt (`null`: not
yet), then asks `/api/ready` on that port. Every address the script built from its pick (`backendUrl`, `api`,
`BACKEND_WS_URL`, `WEB_URL`, a bridge's upstream) is built from the bound port, after the wait.

**A daemon's port (the daemon's own record, as `cli.e2e.ts` in Task 1).** `PORT` stays a number the script picks,
now only what the daemon is configured with (the name of its socket and of its record): the script's `freePort()`
stays for that alone, with a comment that says so, as Task 2 writes on the harness's. The script reads the port the
daemon bound with `readDaemonRecord(<its data folder>, <its configured port>)?.port`
(`import { readDaemonRecord } from '../src/lib/daemonRecord.js'`) on every attempt of its wait for that daemon:
`undefined` is "not yet" (a first start has no record), and a daemon started again may write another port. Every
TCP address of that daemon uses the port read. Not `savedDaemonPort`: before the record is there it answers the
configured port, which is the guess this plan removes.

No new wait, deadline or retry, no option, and no change to what a script checks. One comment per script names the
run (cli-e2e 43568618113, shard 2).

**No failing test, one commit each.** The pick is inside a top-level script with no seam, and a run is a whole
stack: a red test would cost a harness these scripts do not have. Each task is checked by running its script, on
this Mac, against the stack the script itself makes (a backend from this checkout, a throwaway database, fixture
accounts at `.invalid` addresses, daemons under a temporary root): never production, never a real account.

- **Before the edit, run the script as it is.** That run is the task's baseline, in place of a red test: `PASS`, or
  the step it stops at with its last lines. A script already red for another cause is reported and not fixed here;
  after the edit it must get at least as far, and past every start of a backend and of a daemon.
- **After the edit, run it again:** the pass line of the task.
- Every run is under `caffeinate -i` with a short TMPDIR of the task's own. Short matters here too: the scripts'
  data folders sit under TMPDIR, and only a daemon whose socket fits can leave a taken port (see Left out).
- **Tasks 7 and 8 need the orchestrator's go before their runs.** Their scripts hand the caller's whole environment,
  `HOME` with it, to their daemons (the scripts' own design, not changed here), and they need things this Mac does
  not have ready: Task 7 the dependencies of three `store/` packages, Task 8 Docker Desktop started. Ask once, before
  the baseline. Without a go, the task does its edit and its static checks and reports `not run`; Verification 7 or 8
  is then the first run, and a failure there is compared with the base commit in a worktree of its own.

Tasks 5 to 7 take their Mongo and Redis binaries from the same place as Task 3. In `cli/`, before their runs:

```bash
export HARNESS_E2E_SERVICES_DIR="$HOME/test-services" HARNESS_E2E_REDIS_SERVER=/usr/local/bin/redis-server \
  HARNESS_E2E_MONGOD="$HOME/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6"
```

---

### Task 5: `share-harness-e2e.ts` reads the ports its backend and three daemons bound

**Depends on:** Task 3 (the backend's line and `backendListeningPortIn`). **Effort:** high.

**Test that must fail first:** none (see above). One commit.

**Files:**
- Modify: `cli/scripts/share-harness-e2e.ts` (imports at 5-19, `freePort` at 38-44, 141-152, 168, 184, 190-191,
  312-314)

**Interfaces:**
- Consumes: `backendListeningPortIn(logPath: string): number | null` (Task 3); `readDaemonRecord(dataDir, port)`
  (`cli/src/lib/daemonRecord.ts`, on main).

- [ ] **Step 1: The baseline**

The script takes its Mongo and Redis from a file of addresses (`HARNESS_SHARE_E2E_SERVICES`) and the repo has
nothing that makes one. Write this helper to `$TMPDIR/share-services.mjs`, outside the repo and never committed (it
was run on this Mac, 2026-11-14): disposable Mongo (a replica set) and Redis on `127.0.0.1` around one command.

```js
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const services = createRequire(join(resolve(process.env.HARNESS_E2E_SERVICES_DIR), 'package.json'))
const mongo = await services('mongodb-memory-server').MongoMemoryReplSet.create({
  binary: { systemBinary: process.env.HARNESS_E2E_MONGOD }, replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
const redis = new (services('redis-memory-server').RedisMemoryServer)({ binary: { systemBinary: process.env.HARNESS_E2E_REDIS_SERVER } })
const dir = mkdtempSync(join(tmpdir(), 'share-services-'))
let status = 1
try {
  const uri = new URL(mongo.getUri())
  uri.searchParams.set('directConnection', 'true')
  writeFileSync(join(dir, 'services.json'), JSON.stringify({ mongo: uri.href, redis: `redis://127.0.0.1:${await redis.getPort()}` }))
  status = spawnSync(process.argv[2], process.argv.slice(3), { stdio: 'inherit',
    env: { ...process.env, HARNESS_SHARE_E2E_SERVICES: join(dir, 'services.json') } }).status ?? 1
} finally {
  await redis.stop()
  await mongo.stop()
  rmSync(dir, { recursive: true, force: true })
}
process.exit(status)
```

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/fpr-t5/ && mkdir -p "$TMPDIR"
caffeinate -i node "$TMPDIR/share-services.mjs" npm run test:sharing-e2e
```

Expected: the last line starts `PASS: public/private browser links`, exit 0. Needs tmux and Chrome (the live
viewer). The browser checks (`HARNESS_SHARE_BROWSER_CHECK`, `HARNESS_WORKSPACE_BROWSER_CHECK`) stay unset: they need
a web origin, and no port goes through them.

- [ ] **Step 2: The backend**

`PORT` is `process.env.HARNESS_SHARE_BACKEND_PORT ?? '0'` (a caller's fixed port stays the caller's) and
`PORT_APP_PROXY` is `'0'`; `proxyPort` and the pick of `backendPort` go (141-142). The wait `backend` (152) reads
the port from `join(root, 'backend.log')` and asks `/api/ready` there; `backendUrl` (143) and the daemons'
`BACKEND_WS_URL` (184) are built from it. With a fixed port the log says that port: one path for both.

- [ ] **Step 3: The three daemons**

The pick at 168 stays as each daemon's configured `PORT`. One local function waits for a daemon and returns the port
it bound: on every attempt it reads the record of `data` and asks `/api/status` (header `x-adapter-local: 1`) on the
port read for `connected === true`, as lines 190 and 313 do today. Line 190 uses it and `machines[].port` holds what
it returns. Lines 312-314 (the owner's daemon started again) use it too, with the data folder and `PORT` of
`host.env`, and set `host.port` before `Peer.connect`.

- [ ] **Step 4: Run it again**

The command of step 1. Expected: the same last line, exit 0.
`grep -n "proxyPort" scripts/share-harness-e2e.ts` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add cli/scripts/share-harness-e2e.ts
git commit -m "e2e: the sharing stack script reads the ports its backend and daemons bound"
```

---

### Task 6: `box-claim-e2e.ts` reads the ports its backend and two boxes bound

**Depends on:** Task 3. **Effort:** medium.

**Test that must fail first:** none (see above). One commit.

**Files:**
- Modify: `cli/scripts/box-claim-e2e.ts` (imports at 11-22, `freePort` at 50-56, 65, 103-104, 132-152)

**Interfaces:**
- Consumes: `backendListeningPortIn` (Task 3); `readDaemonRecord` (on main).

- [ ] **Step 1: The baseline**

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/fpr-t6/ && mkdir -p "$TMPDIR"
HARNESS_BOX_E2E=1 caffeinate -i npx tsx scripts/box-claim-e2e.ts
```

Expected: `ALL PASS`, exit 0. It builds the CLI's bundle itself; it needs tmux.

- [ ] **Step 2: The backend**

`PORT: '0'`, `PORT_APP_PROXY: '0'`; the two picks at 132 go. The wait `backend readiness` (152) reads the port from
`join(root, 'backend.log')`, then `/api/ready`; `api` (150) is set after the wait, and `newBox` (180-181) is handed
the bound port.

- [ ] **Step 3: The boxes**

The pick at 65 stays as the box's configured `PORT` (`Box.port`; its comment says so). `daemonStatus` (103-104) reads
the record of `join(box.home, 'data')` on every call and asks the port read, and throws
`<name>'s daemon has not recorded its port yet` when there is none: a box's daemon is started by `harness start`
and starts again on sign-in, so no port is kept between calls. Every caller is inside an `until`, which takes a
throw as "not yet".

- [ ] **Step 4: Run it again**

The command of step 1. Expected: `ALL PASS`, exit 0. `grep -n "proxyPort" scripts/box-claim-e2e.ts` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add cli/scripts/box-claim-e2e.ts
git commit -m "e2e: the box ticket script reads the ports its backend and boxes bound"
```

---

### Task 7: `remote-viewers-stack.ts` reads the ports its two backends and two daemons bound

**Depends on:** Task 3. **Effort:** high.

**Test that must fail first:** none (see above). One commit.

**Files:**
- Modify: `cli/scripts/remote-viewers-stack.ts` (imports at 7-20, `freePort` at 44-50, 123-124, 133-140, 155, 158,
  185-191)

**Interfaces:**
- Consumes: `backendListeningPortIn` (Task 3); `readDaemonRecord` (on main).

- [ ] **Step 1: The baseline (on the orchestrator's go)**

Its needs are in `docs/plans/2026-09-17-004-remote-viewers.md` ("Reproduce"): installed dependencies in
`store/agents/godogen`, `store/agents/marp/toolchain` and `store/viewers/model-viewer` (this checkout has none),
tmux, ffmpeg and Chrome.

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/fpr-t7/ && mkdir -p "$TMPDIR"
npx tsc --noEmit -p tsconfig.viewer-tests.json
HARNESS_VIEWER_STACK=1 caffeinate -i node --import tsx scripts/remote-viewers-stack.ts
```

Expected: `tsc` with no error (or the errors it has today, noted); the run prints a `PASS` line per checkpoint, the
last `PASS all test agents deleted through real daemon RPC`, exits 0, and `results.json` in the folder it names
says `"completed": true`.

- [ ] **Step 2: The two backends**

`backendPorts` starts empty and `proxyPorts` goes (123-124). `bootBackend(index)` (133-140) spawns with
`PORT_APP_PROXY: '0'` and `PORT: String(backendPorts[index] ?? 0)`, reads the port from that backend's log
(`backend-<index>.log` under `root`) in its wait, and keeps it in `backendPorts[index]`. So the first boot of a
backend binds a port of the system's choosing, and the boot after the outage (318) binds the port that backend had:
its daemon's `BACKEND_WS_URL` names it, and the checkpoint is that the daemon finds it again. That is the backend's
own port asked for again, not a pick (see Left out). A comment says so.

- [ ] **Step 3: The two daemons**

The pick at 155 stays as the daemon's configured `PORT`. `boot()` (185-190) reads the record of `data` on every
attempt of its wait and asks `/api/status` on the port read; `machine()` returns that port as `port` (191), which
is what lines 199, 200, 319, 325 and 326 use.

- [ ] **Step 4: Run it again**

The commands of step 1, with the same result and no new `tsc` error.
`grep -n "proxyPorts" scripts/remote-viewers-stack.ts` prints nothing. Without a go: `tsc` and the `grep` only, and
the report says `not run`.

- [ ] **Step 5: Commit**

```bash
git add cli/scripts/remote-viewers-stack.ts
git commit -m "e2e: the remote viewers stack reads the ports its backends and daemons bound"
```

---

### Task 8: `local-stack-peer.ts` reads the ports its backend and daemon bound

**Depends on:** Task 3. **Effort:** medium.

**Test that must fail first:** none (see above). One commit.

**Files:**
- Modify: `cli/scripts/local-stack-peer.ts` (imports at 5-18, `freePort` at 44-50, 83, 114, 121-124, 173-179, 230)

**Interfaces:**
- Consumes: `backendListeningPortIn` (Task 3); `readDaemonRecord` (on main).
- Produces: the fixture's first line of JSON keeps its shape; `localPort` is the port the daemon bound
  (`desktop/test/local_stack_e2e_test.dart:108` connects to it).

- [ ] **Step 1: The baseline (on the orchestrator's go)**

Desktop's test starts the script and is its only caller. It needs Docker Desktop running (stopped on this Mac on
2026-11-14; the script's containers are its own, named `harness-stack-<kind>-<pid>`, and removed at the end), tmux
and Flutter.

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/fpr-t8/ && mkdir -p "$TMPDIR"
(cd ../desktop && flutter pub get)
caffeinate -i ../desktop/scripts/test-terminal-local-e2e.sh
```

Expected: `All tests passed!`, exit 0.

- [ ] **Step 2: The backend**

Line 83 picks three ports, not five: `mongoPort`, `redisPort` and `cliPort`. `PORT: '0'`, `PORT_APP_PROXY: '0'`
(114). The wait `backend readiness` (124) reads the port from `join(root, 'backend.log')`, then `/api/ready`;
`backendUrl` (122), the daemon's `BACKEND_WS_URL` (150) and the bridge's upstream (189) are built from it.
`mongoPort` and `redisPort` go: Docker binds `-p 127.0.0.1::27017` and `-p 127.0.0.1::6379`, and the script reads each with `docker port <container> 27017/tcp` (and `6379/tcp`) right after its `docker run`, before `DATABASE_URL` and `REDIS_URL` are built.

- [ ] **Step 3: The daemon**

`cliPort` stays as the daemon's configured `PORT`. `bootDaemon()` (173-179) reads the record of `dataDir` on every
attempt of its wait and asks `/api/status` on the port read; the JSON's `localPort` (230) is the port read by the
first boot. `/restart` runs `bootDaemon()` again as today.

- [ ] **Step 4: Run it again**

The command of step 1. Expected: `All tests passed!`, exit 0.
`grep -n "proxyPort" scripts/local-stack-peer.ts` prints nothing. Without a go: the `grep` only, and the report says
`not run`.

- [ ] **Step 5: Commit**

```bash
git add cli/scripts/local-stack-peer.ts
git commit -m "e2e: the Desktop local stack fixture reads the ports its backend and daemon bound"
```

---

## Left out

Each is named in the pull request's body and in the final report, with its reason.

- **`noSocket.e2e.ts`, first case** (the spec's decision 2). A daemon with no socket cannot fall back
  (`cli/src/hookServer.ts:1394`, by design), so a port taken before its bind still fails that core with
  `EADDRINUSE`. Both ways out are non-goals (the daemon's fallback, a retry). The test is left as it is.
- **The same cause in Tasks 5 to 8:** a script's daemon whose data folder is too long for a socket (share-harness
  and box-claim under this Mac's own TMPDIR) cannot fall back either. It fails at once, by name, in its own log.
- **`daemons/e2e/sandbox.mjs`** (the spec's decision 4: a large rewrite). Its seven ports are picked once at `up`
  and kept in `state.json`, which is the sandbox's contract with its later commands (`backend`, `harnessd`, `status`,
  `down`) and with `client.mjs`, `services.mjs`, `daemons.e2e.test.mjs` and the Desktop test
  (`HARNESS_DAEMONS_E2E_PORT`). Neither way of this branch fits it whole:
  - its backend is `dist/server.js` of any build, the older ref of the mixed-version runs among them
    (`build-ref.sh`, `E2E_OLD_BACKEND`): with `PORT=0` an older build prints `backend listening on 0`;
  - the stub sign-in server and the logging proxy (`services.mjs`) and the two Docker ports are bound by neither the
    backend nor a daemon;
  - the daemon's port alone could follow the record, across three files, and would leave six picks.

  Found beside it and not changed here: `stopHarnessd` (`sandbox.mjs:286-290`) sends SIGTERM to whatever listens on
  the picked daemon port ("Whatever still holds the sandbox port is ours"). When the daemon lost that port and moved,
  the listener is someone else's process. A proposal for the maintainers, with the sandbox's own port rework.
- **A process started again on the port it had:** remote-viewers' backend 1 after its outage (Task 7), a daemon
  after a restart (it binds the port in its record; local-stack-peer's `localPort` is said once). A port taken in
  between is a restart's race, not a pick ahead, and the daemon's own fallback and the scripts' flows are not this
  change.

---

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): every file boots
its own daemons under a throwaway root, with a private tmux server and fake engines, signed out, its backend at
`127.0.0.1:9`. The real-backend files start the backend of this checkout against an in-memory Mongo replica set and
Redis on `127.0.0.1`, with a fake sign-in server and accounts the test makes (`<name>@spike.invalid`). In checks 1
to 4 and 9: no real account, no production, nothing of the developer's daemon (port 18473), `~/.harness`,
`~/.claude` or `~/.codex`. The stack scripts (checks 5 to 8) have no guide of their own, so their isolation is
spelled out with each: all four start this checkout's backend on a throwaway Mongo and Redis on `127.0.0.1`, behind
a fake sign-in server, with accounts they make (`.invalid` addresses) and daemons whose data, sign-in and tmux socket
are under a temporary root: no real account and no production there either. Checks 7 and 8 say what their daemons
still share with the caller. None of these checks needs Ken himself.

Local checks run on this Mac (macOS, tmux), in `cli/`, one command at a time:

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/fpr-v/ && mkdir -p "$TMPDIR"
export HARNESS_E2E_SERVICES_DIR="$HOME/test-services" HARNESS_E2E_REDIS_SERVER=/usr/local/bin/redis-server \
  HARNESS_E2E_MONGOD="$HOME/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6"
```

1. **The harness follows a daemon that lost its port.**

   ```bash
   E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/portHolder.e2e.ts
   ```

   To see: 2 passed.

2. **The test of the incident, and a plain start.**

   ```bash
   E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/turns.e2e.ts \
     -t 'a /goal that pauses after its hook refuses to stop'
   ```

   To see: 1 passed, the rest skipped.

3. **The files whose use of the port changed.**

   ```bash
   E2E_BUNDLE=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts \
     e2e/twodaemons.e2e.ts e2e/lean.e2e.ts e2e/noSocket.e2e.ts e2e/cli.e2e.ts e2e/cloudAgents.e2e.ts
   ```

   To see: 5 files passed; 7, 7, 2, 8 and 3 tests passed, none skipped. No line of the output says
   `the daemon has not said which port it listens on yet`.

4. **The real backend on a port of its own, and a daemon signed in to it.**

   ```bash
   HARNESS_E2E_SERVICES_DIR="$HOME/test-services" HARNESS_E2E_REDIS_SERVER=/usr/local/bin/redis-server \
   HARNESS_E2E_MONGOD="$HOME/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6" \
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/realBackendPort.e2e.ts e2e/twoAccounts.spike.e2e.ts
   ```

   To see: 2 files passed; 2 and 1 tests passed. `skipped` is not a pass.

The stack scripts, each once. A failure is compared with the task's baseline (its report), or, where the task had no
go, with the same run at the base commit in a worktree of its own: an old red is reported as such.

5. **The box ticket flow** (Task 6): a backend and two boxes, each box with a home of its own under the root.

   ```bash
   HARNESS_BOX_E2E=1 caffeinate -i npx tsx scripts/box-claim-e2e.ts
   ```

   To see: `PASS backend up on in-memory Mongo + Redis`, the lines after it, `ALL PASS`, exit 0.

6. **The sharing flow** (Task 5): a backend and three daemons, each with a home of its own
   (`share-harness-e2e-preload.cjs`), on the disposable Mongo and Redis of Task 5's helper (step 1; written to
   `$TMPDIR/share-services.mjs`, never into the repo). Needs Chrome.

   ```bash
   caffeinate -i node "$TMPDIR/share-services.mjs" npm run test:sharing-e2e
   ```

   To see: the last line starts `PASS: public/private browser links`, exit 0.

7. **The remote viewers stack** (Task 7), **on the orchestrator's go**: two backends, one stopped and started again
   on its port, and two daemons. Its daemons get the caller's environment, `HOME` with it; their data, sign-in,
   runtime, DSH, Claude folders and tmux socket are under the root. Needs the dependencies of
   `docs/plans/2026-09-17-004-remote-viewers.md` ("Reproduce"), ffmpeg and Chrome.

   ```bash
   npx tsc --noEmit -p tsconfig.viewer-tests.json
   HARNESS_VIEWER_STACK=1 caffeinate -i node --import tsx scripts/remote-viewers-stack.ts
   ```

   To see: no `tsc` error the baseline did not have; `PASS backend process outage, reconnect and viewer recovery`
   among the lines, `PASS all test agents deleted through real daemon RPC` the last, exit 0.

8. **Desktop's local stack test** (Task 8), **on the orchestrator's go**: the fixture's backend and daemon, Mongo
   and Redis in two containers of its own (`harness-stack-<kind>-<pid>`, removed at the end; Docker Desktop must be
   running), and Desktop's own client through them. Its daemon gets the caller's environment, as in 7; its data,
   sign-in, DSH and Claude projects folders and its tmux socket are under the root.

   ```bash
   (cd ../desktop && flutter pub get)
   caffeinate -i ../desktop/scripts/test-terminal-local-e2e.sh
   ```

   To see: `All tests passed!`, exit 0.

On GitHub, by hand, once, **only on the orchestrator's go**, after the branch is pushed (shared runners,
`docs/validation-and-release.md`). Report the run's link.

9. **The whole suite on Linux, the real-backend files on every shard, and the full disk on macOS:** the existing
   workflow (`workflow_dispatch`), eight Linux shards and one macOS runner, each shard with the real backend and its
   in-memory Mongo and Redis.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/e2e-free-port-race
   ```

   To see: `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green; `e2e/realBackendPort.e2e.ts` in
   the summary's verified files. It proves that every file's daemons start through the new wait, the 64 lines that
   read a daemon's `.port` and stay as they are, and every real-backend file on the backend's own port. A red test
   is reported with its link and whether main's last nightly run has it too.

**Temporary workflow:** none. The long check has a workflow already (`.github/workflows/cli-e2e.yml`, run by hand
from a branch and every night), which discovers the new file by itself. The four stack scripts are one flow
each, not a suite, and are run by hand by design (`scripts/ci-plan.py:207`); three need this Mac's Chrome, Docker or
Flutter, and none has run on a runner. No permanent workflow is proposed for them.

**Beside the end-to-end checks:** `cd cli && npm run typecheck` and
`npx vitest run src/testing/daemonListeningPort.spec.ts src/testing/backendListeningPort.spec.ts` (PR CI's
`cli-typecheck` and `cli-tests` run them too); `cd backend && npm run typecheck` (the backend has no lint script; PR
CI's `backend-desk` runs its unit suite). **Checks PR CI does not run:** none for these paths
(`python3 scripts/local-checks.py --list` prints `{}`); `npm run test:core` and `test:harnessd` are not needed, as
nothing under `cli/src/core`, `cli/src/services` or `cli/src/harnessd` changes.
