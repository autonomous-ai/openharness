# CLI end-to-end harness hygiene (nothing left behind, a bounded backend call, a socket path that fits): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Each task is test-first: a red commit (the
> test alone), then the code commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI end-to-end run leaves no process and no folder behind, a test backend that stops answering fails its
call by name within 30 s, and a TMPDIR too long for the daemon's socket stops the run at once with a sentence that
says so.

**Architecture:** Test harness and fake engine only. `IsolatedDaemon.close()` and the worker's reaper end every
process that still names the root before the root is removed (`src/testing/rootProcesses.ts`); the fake
`codex app-server` ends with its stdin; the harness points the grid manifest at this machine and switches grid's
installer off. `backend.api` becomes one exported, bounded `backendApi`. One check of a socket path's room
(`src/testing/socketPathRoom.ts`) runs as the suite's first global setup and, for the data folder the harness itself
gives a daemon, in `IsolatedDaemon.create`.

**Tech Stack:** TypeScript and plain Node modules, Vitest, Node 24 (CI pins 24.22.2). No new dependency.

**Spec:** [docs/plans/2026-11-14-e2e-harness-hygiene-design.md](2026-11-14-e2e-harness-hygiene-design.md). Read it with
this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Open questions

None.

## Global Constraints

- No product code. Under `cli/src/` only files in `cli/src/testing/` (new ones, and the root's removal in
  `isolatedTmux.ts`, Task 6); everything else is in `cli/e2e/`,
  `cli/vitest.e2e.config.ts` and `cli/vitest.setup.ts` (Task 9). A real `podman events` outliving a crashed agent-browser process is out of scope.
- A failing or flaky test is a bug, fixed at its layer with a red-then-green test: never skipped, loosened, retried
  or given a longer timeout. No fixed sleeps in a test; a wait is on a condition, with a bound.
- The spec's values, verbatim: `http://127.0.0.1:9/grid.json`; `DISABLE_GRID_INSTALL: 'true'`; 30 000 ms; 96 bytes;
  `the test backend did not answer POST /api/machines/resolve-computer within 30000 ms`;
  `TMPDIR is too long for the daemon's Unix socket: <path> would be <n> bytes; a socket path has room for 96. Run with a shorter TMPDIR, for example TMPDIR=/tmp npm run test:e2e.`
  (one line).
- A TMPDIR that is too long fails fast. Nothing picks a short folder by itself.
- No new option on `DaemonOptions` (one way to do a thing, no switch for a choice the code can make): the harness
  tells whose data folder it is from `options.dataDir`, and a test's own environment still wins over the harness's.
- No local full suite. A task runs only the tests of what it changed. Every local end-to-end run is under
  `caffeinate -i` with a short TMPDIR of the task's own (`/private/tmp/claude-502/hyg-t<N>/`, made first with
  `mkdir -p`): an agent's TMPDIR on this Mac is too long for the socket.
- Never run or list `e2e/agentBrowserPodman.e2e.ts` locally: it acts on the machine's real Podman.
- The GitHub workflow `cli-e2e` is heavy: ask the orchestrator before every run of it.
- Other sessions run end-to-end tests on this Mac, and the leftovers of 2026-11-14 (14 fake `codex app-server`
  pairs, ten `htmux-*` roots) are still there. A task ends only the processes its own test started and removes only
  its own folders, by their exact pid or path, never by a pattern.
- Comments say why, in plain sentences, and name the incident (the census of 2026-11-14 in the spec).
- This checkout has `cli/node_modules`. A task run in another checkout installs once first:
  `cd cli && npm ci --no-audit --no-fund`.
- Platforms: macOS and Linux, where the end-to-end suite runs, and Windows for `cli/vitest.setup.ts` (Task 9), which
  `windows.yml`'s CLI specs load. One pull request; its body names them and carries
  each task's red and green output and the Verification results.

## Found while reading the code

Checked at `b79d017c41`.

- **Specs of harness code live in `cli/src/testing/`.** `tsconfig.json` has `rootDir: src`, so a spec loads
  `e2e/harness/*` untyped, `await import('../../e2e/harness/x.js' as string) as { … }`, as
  `src/testing/fullDisk.spec.ts:8` does. `scripts/ci-plan.py` lets `src/` read `cli/e2e/harness/` only. End-to-end
  files are not typechecked.
- **`isolatedTmux().close()` stops the server and removes the root in one call** (`src/testing/isolatedTmux.ts:30-36`).
  The sweep has to come between the two, so the close stops the server itself first.
- **The reaper is plain Node** (`reaper.ts:19` starts `reaperProcess.mjs` with no loader): it cannot import
  `src/testing/*.ts`, and already keeps its own copies of `alive` and the group rule. It mirrors the sweep's rule in
  its own file; the three worker cases of `leftBehind.e2e.ts` hold it.
- **A Codex rate-limit read** is `usage_read` (`src/services/usage.ts:88`), answered only when the read settles; it
  starts `<root>/bin/codex app-server` in a group of its own (`src/lib/codexRateLimits.ts:50-51`) and ends that group
  itself after 10 s. The fake Codex is two processes, the npm wrapper and its child (`fakeEngine.mjs:121`), and only
  the wrapper's command line names the root.
- **After Task 1 the fake `codex app-server` ends by itself** when its daemon dies. A test of the sweep therefore
  needs a Codex that does not: Task 6 writes a hung one over the daemon's own.
- **`launch-argv` has five readers:** `modelSwitch.e2e.ts:52`, `swarmNoShellGuard.e2e.ts:29`,
  `swarmBasics.e2e.ts:45`, `swarmAttachRestart.e2e.ts:88,105`, `swarmV4Journey.e2e.ts:103`. Each looks for an agent's
  launch by engine or argument; today a rate-limit read's `{"engine":"codex","args":["app-server"]}` can be taken for
  one. None reads an `app-server` line.
- **`backend.api` is the only way the tests call the real backend:** 27 calls, none around it.
- **`MAX_SOCKET_PATH_BYTES` is not exported** (`src/lib/localSocket.ts:46`, product code). The check keeps its own
  96 and a spec holds it to the product's `socketPathIn`.
- **Socket path sizes** (`<tmp>/htmux-XXXXXX/data/daemon-65535.sock`): macOS's default TMPDIR, by its real path,
  92 bytes; `/tmp` 40; `/private/tmp/claude-502/hyg-t1` 66.
- **`ensureManagedGrid` has three callers:** `src/cli.ts:1588` (`repairManagedRuntimes`, from `:1176` and `:1600`),
  `src/services/models.ts:75` (`followGridPin`, only with a managed grid already there) and `:92` (`installCli`,
  asked through `models.ensure`). Reading does not show which one `masterIpcExit.e2e.ts` reaches.
- **The manifest alone would trade one download for another.** With no grid after `ensureManagedGrid`, `installCli`
  goes on to grid's public installer (`ensureGridInstalled`: `curl -fsSL https://grid.autonomous.ai/install.sh | bash`,
  `src/lib/gridInstall.ts:170`) unless `DISABLE_GRID_INSTALL` is true (`src/config/env.ts:285`, read at
  `gridInstall.ts:138,158`). No end-to-end file names that variable, expects the installer's output or has a fake
  `curl`, so the harness sets it for every daemon.
- **Who passes a `dataDir` of their own:** `noSocket.e2e.ts:29` (too long for a socket on purpose: its subject is the
  daemon that serves on its port alone), `diskfull.e2e.ts:67,145` (a test volume), `twodaemons.e2e.ts:246` and
  `lean.e2e.ts:188` (the data folder of the daemon they run beside). None of them is measured by `create`.
- **`isolatedTmux()` starts no server** until its first `run` (`src/testing/isolatedTmux.ts:16-24`): a `create` refused
  before any `mkdir` has only the root to remove.
- **Local gates.** `python3 scripts/local-checks.py --list` on the paths of the File map prints `{}`.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/e2e/harness/fakeEngine.mjs` | `codex app-server [-c …]`: reads, answers nothing, ends with its stdin | 1 |
| `cli/src/testing/fakeCodexAppServer.spec.ts` | new | 1 |
| `cli/e2e/harness/realBackend.ts` | `backendApi`, `BACKEND_API_TIMEOUT_MS`; `backend.api` calls it | 2 |
| `cli/src/testing/realBackendApi.spec.ts` | new | 2 |
| `cli/src/testing/socketPathRoom.ts`, `.spec.ts` | new: the check and its spec | 3 |
| `cli/e2e/harness/socketRoom.ts` | new: the suite's first global setup | 3 |
| `cli/vitest.e2e.config.ts` | lists it before `bundle.ts` | 3 |
| `cli/e2e/harness/daemon.ts` | `create` checks the data folder it made itself (4); `close` sweeps (6); the grid manifest and installer switch (8) | 4, 6, 8 |
| `cli/e2e/noSocket.e2e.ts` | the refusal's test, beside the test whose own data folder is too long on purpose | 4 |
| `cli/src/testing/rootProcesses.ts`, `.spec.ts` | new: what still names a root, and ending it | 5 |
| `cli/e2e/harness/hungCodex.ts` | new: a Codex whose rate-limit read never ends | 6 |
| `cli/src/testing/isolatedTmux.ts`, `.spec.ts` | the root's removal also removes a folder made read-only in it (moved to `removeRoot.ts` in the final review, which `vitest.setup.ts` uses too) | 6, 9 |
| `cli/e2e/leftBehind.e2e.ts` | the close's tests (6), the worker's (7), grid's (8) | 6, 7, 8 |
| `cli/e2e/harness/reaperProcess.mjs`, `abandonedWorker.ts` | the reaper sweeps a root before removing it, and removes a folder made read-only in it | 7 |
| `cli/vitest.setup.ts`, `cli/src/testing/vitestSetupFolders.spec.ts` | the setup removes the home, data and runtime folders it made when the file ends; the spec, new | 9 |
| `cli/e2e/harness/daemon.ts`, `cli/e2e/agentBrowser.e2e.ts`, `cli/e2e/harness/realBackend.ts` | a daemon's TMPDIR is in its root, and the screenshot test's check; `backend.stop()` throws the closes that failed | 10 |

## Review Focus

Each line is pinned by a test in the task that owns the code.

- A TMPDIR that is a link to a longer folder, as macOS's `/var` is to `/private/var`: measured by its real path, and
  in bytes, not characters. Task 3, fourth and fifth tests.
- Two roots where one's path begins the other's (`htmux-abc`, `htmux-abcd`), in a parallel run: the sweep of one
  never touches the other. Task 5, fourth and fifth tests.
- A process of the test's own that names the root, in the Vitest worker's process group: ended alone, the worker
  goes on; and a daemon beside another closes without sweeping the root they share. Task 5, second and third tests;
  Task 6, second test.
- A backend that sends its headers and then stalls: the body is inside the limit, and a body that is not JSON is
  still `null`, not an error. Task 2, second and third tests.
- A daemon refused for its socket path leaves no root behind, and a test's own data folder, too long on purpose, is
  not measured: the one test that wants no socket still runs, unchanged. Task 4, both tests of `noSocket.e2e.ts`.

---

### Task 1: The fake `codex app-server` ends with its stdin

**Depends on:** nothing. **Effort:** high.

**Files:**
- Create: `cli/src/testing/fakeCodexAppServer.spec.ts`
- Modify: `cli/e2e/harness/fakeEngine.mjs` (`run`, between the `agents --json` branch at 202-207 and the
  `launch-argv` line at 209; the header comment's list)

- [ ] **Step 1: Write the failing spec**

`fakeEngineShim` is loaded untyped from `../../e2e/harness/daemon.js`. Each case writes the shim to
`<root>/bin/codex` under a `mkdtempSync` root with the config
`{ port: 1, dataDir: <root>/data, claudeProjectsDir: <root>/claude, codexHome: <root>/codex, root, hookLog: <root>/hooks.log }`,
starts it with `spawn(codex, argv, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })`, and `afterEach` ends its
process group (`process.kill(-pid, 'SIGKILL')`, errors ignored) and removes the root.

```ts
describe('the fake codex app-server', () => {
  it.each([
    ['as the rate-limit read runs it', ['app-server']],
    ['with -c pairs, as a provider move runs it', ['app-server', '-c', 'model_provider="grid"']],
  ])('answers nothing and ends when its stdin ends, %s', async (_, argv) => {
    // … spawn as above, collect stdout into `out`, `ended` resolves with the code of its `close` …
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`)
    child.stdin.end()
    let timer: NodeJS.Timeout | undefined
    const code = await Promise.race([ended, new Promise<'still running'>((done) => { timer = setTimeout(() => done('still running'), 10_000) })])
    clearTimeout(timer)
    expect(code, 'the server once its stdin ended').toBe(0)
    expect(out).toBe('')
    // A read is no launch: the tests that read launch-argv see agents only.
    expect(existsSync(join(root, 'launch-argv'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/testing/fakeCodexAppServer.spec.ts`
Expected: 2 failed, `expected 'still running' to be 0` (today the fake draws its TUI and outlives its stdin).
Commit the spec alone: `e2e: a spec that the fake codex app-server ends with its stdin (red)`.

- [ ] **Step 3: Give the fake its `app-server`**

In `run`, before the `launch-argv` line: `if (engine === 'codex' && args[0] === 'app-server')` (the `proxy` form
returned at 152; `-c` pairs follow `app-server`). It reads lines from stdin, writes nothing to stdout, and calls
`process.exit(0)` when stdin ends. No title, no hooks, no transcript, no `launch-argv` line. Its comment says why:
the real server is JSON-RPC on stdio and exits with its stdin, and 14 pairs of the fake were found orphaned on
2026-11-14. Add the line to the header's list of what the fake does.

- [ ] **Step 4: Run the checks**

```bash
cd cli
npx vitest run src/testing/fakeCodexAppServer.spec.ts                        # 2 passed
mkdir -p /private/tmp/claude-502/hyg-t1
TMPDIR=/private/tmp/claude-502/hyg-t1/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/modelSwitch.e2e.ts   # 1 passed
```

The four Swarm readers of `launch-argv` need the real backend; the GitHub run in Verification covers them.

- [ ] **Step 5: Commit**

```bash
git add cli/e2e/harness/fakeEngine.mjs
git commit -m "e2e: the fake codex app-server reads, answers nothing and ends with its stdin"
```

---

### Task 2: `backendApi`, bounded and named

**Depends on:** nothing. **Effort:** high.

**Files:**
- Create: `cli/src/testing/realBackendApi.spec.ts`
- Modify: `cli/e2e/harness/realBackend.ts` (138-143)

**Interfaces:**
- Produces: `export const BACKEND_API_TIMEOUT_MS = 30_000` and
  `export async function backendApi(url: string, a: Account, path: string, method = 'GET', body?: unknown, ms = BACKEND_API_TIMEOUT_MS): Promise<{ status: number; body: any }>`.
  `RealBackend.api` keeps its signature.

- [ ] **Step 1: Write the failing spec**

Both names are loaded untyped from `../../e2e/harness/realBackend.js`. `serve(handler)` starts a `node:http` server
on `127.0.0.1:0` and returns its URL; `afterEach` calls `closeAllConnections()` and `close()` on each.
`A = { name: 'a', token: 't', id: 'i', email: 'a@spike.invalid' }`.

```ts
it('names the call a backend never answered, at its limit', async () => {
  const url = await serve(() => { /* accepts, and never answers */ })
  await expect(backendApi(url, A, '/api/machines/resolve-computer', 'POST', { computerId: 'c' }, 200))
    .rejects.toThrow('the test backend did not answer POST /api/machines/resolve-computer within 200 ms')
})
it('counts the body in the limit: headers alone are no answer', async () => {
  const url = await serve((_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":') })
  await expect(backendApi(url, A, '/api/slow', undefined, undefined, 200))
    .rejects.toThrow('the test backend did not answer GET /api/slow within 200 ms')
})
it('answers as before: the status and the parsed body, or null for a body that is not JSON', async () => {
  const url = await serve((req, res) => req.url === '/json'
    ? res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, env: req.headers['x-autonomous-env'], type: req.headers['content-type'] }))
    : res.writeHead(502).end('Bad Gateway'))
  expect(await backendApi(url, A, '/json', 'POST', { a: 1 })).toEqual({ status: 200, body: { method: 'POST', auth: 'Bearer t', env: 'prod', type: 'application/json' } })
  expect(await backendApi(url, A, '/text')).toEqual({ status: 502, body: null })
})
it('gives a call 30 seconds', () => { expect(BACKEND_API_TIMEOUT_MS).toBe(30_000) })
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/testing/realBackendApi.spec.ts`
Expected: 4 failed (`backendApi is not a function`; the limit is `undefined`).
Commit the spec alone: `e2e: a spec that a call to the test backend is bounded and named (red)`.

- [ ] **Step 3: Write `backendApi` and call it from `backend.api`**

One `AbortSignal.timeout(ms)` covers the `fetch` and the read of the body. When it has fired, throw
`the test backend did not answer ${method} ${path} within ${ms} ms`, the abort as its `cause`: the body's read must
not turn a timeout into `null`. A body that is not JSON is still `null`. Headers and body are sent as today. In
`boot`: `api: (a, path, method, body) => backendApi(url, a, path, method, body)`.

- [ ] **Step 4: Run the checks**

```bash
cd cli
npx vitest run src/testing/realBackendApi.spec.ts        # 4 passed
npm run typecheck                                        # no error
```

- [ ] **Step 5: Commit**

```bash
git add cli/e2e/harness/realBackend.ts
git commit -m "e2e: a call to the test backend ends at 30 s, naming its method and path"
```

---

### Task 3: The socket-room check, and the suite's first global setup

**Depends on:** nothing. **Effort:** high.

**Files:**
- Create: `cli/src/testing/socketPathRoom.ts`, `cli/src/testing/socketPathRoom.spec.ts`,
  `cli/e2e/harness/socketRoom.ts`
- Modify: `cli/vitest.e2e.config.ts` (the header comment, and `globalSetup` at 25)

**Interfaces:**
- Produces, for Task 4, in `src/testing/socketPathRoom.ts`:
  - `export const SOCKET_PATH_ROOM = 96`
  - `export function suiteSocketPath(tmp: string): string`, which is
    `join(tmp, 'htmux-XXXXXX', 'data', 'daemon-65535.sock')`
  - `export function assertSocketPathFits(path: string): void`, which throws an `Error` with the Global
    Constraints' sentence when `Buffer.byteLength(path) > SOCKET_PATH_ROOM`.
- `e2e/harness/socketRoom.ts`: `export default function setup(): void`, which is
  `assertSocketPathFits(suiteSocketPath(realpathSync(tmpdir())))`.

- [ ] **Step 1: Write the failing spec**

`setup` is loaded untyped: `(await import('../../e2e/harness/socketRoom.js' as string) as { default: () => void }).default`.
`afterEach` puts `process.env.TMPDIR` back as it was (deleted when it was unset) and removes `base`.

```ts
const said = (path: string) => `TMPDIR is too long for the daemon's Unix socket: ${path} would be ${Buffer.byteLength(path)} bytes; a socket path has room for 96. Run with a shorter TMPDIR, for example TMPDIR=/tmp npm run test:e2e.`
const LONG = 'a-temporary-folder-whose-path-is-longer-than-a-unix-socket-path-may-be'

it('the default macOS and Linux TMPDIRs pass', () => {
  expect(suiteSocketPath('/tmp')).toBe('/tmp/htmux-XXXXXX/data/daemon-65535.sock')
  expect(() => assertSocketPathFits(suiteSocketPath('/tmp'))).not.toThrow()
  expect(() => assertSocketPathFits(suiteSocketPath('/private/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T'))).not.toThrow()
})
it('a long folder fails, saying so', () => {
  const tmp = '/private/tmp/claude-502/-Users-someone-workspaces-project/0f8fad5b-d9cb-469f-a165-70867728950e/scratchpad'
  expect(() => assertSocketPathFits(suiteSocketPath(tmp))).toThrow(
    `TMPDIR is too long for the daemon's Unix socket: ${tmp}/htmux-XXXXXX/data/daemon-65535.sock would be 141 bytes; a socket path has room for 96. Run with a shorter TMPDIR, for example TMPDIR=/tmp npm run test:e2e.`)
})
it('its room is the daemon\'s own, to the byte', () => {
  const name = localSocketName(65535), fits = `/${'a'.repeat(77)}`, over = `${fits}a`   // 96 and 97 bytes with the name
  expect(SOCKET_PATH_ROOM).toBe(96)
  expect(socketPathIn(fits, name, '/h')).toBe(join(fits, name))
  expect(() => assertSocketPathFits(join(fits, name))).not.toThrow()
  expect(socketPathIn(over, name, '/h')).not.toBe(join(over, name))
  expect(() => assertSocketPathFits(join(over, name))).toThrow(said(join(over, name)))
})
it('counts bytes, not characters', () => {
  const path = suiteSocketPath(`/${'é'.repeat(30)}`)   // 67 characters, 97 bytes
  expect(() => assertSocketPathFits(path)).toThrow(' would be 97 bytes; ')
})
it('the suite\'s setup measures the real TMPDIR, as macOS\'s /var is /private/var', () => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 's-'))
  const real = join(base, LONG), link = join(base, 't')
  mkdirSync(real)
  symlinkSync(real, link)
  process.env.TMPDIR = link
  expect(() => setup()).toThrow(said(join(real, 'htmux-XXXXXX', 'data', 'daemon-65535.sock')))
  process.env.TMPDIR = '/tmp'
  expect(() => setup()).not.toThrow()
})
```

`localSocketName` and `socketPathIn` come from `../lib/localSocket.js`.

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/testing/socketPathRoom.spec.ts`
Expected: FAIL, the two modules cannot be found.
Commit the spec alone: `e2e: a spec of the socket path's room (red)`.

- [ ] **Step 3: Write the check, the setup, and list it first**

The two files of Interfaces. `SOCKET_PATH_ROOM`'s comment names `MAX_SOCKET_PATH_BYTES` (`lib/localSocket.ts`) and
the spec that holds the two together. In `vitest.e2e.config.ts`:
`globalSetup: ['./e2e/harness/socketRoom.ts', './e2e/harness/bundle.ts']`, and a paragraph in its header: a TMPDIR
too long for a daemon's socket stops the run before any test, and before the bundle is built.

- [ ] **Step 4: Run the checks**

```bash
cd cli
npx vitest run src/testing/socketPathRoom.spec.ts        # 5 passed
npm run typecheck                                        # no error
long=/private/tmp/claude-502/hyg-t3-a-temporary-folder-whose-path-is-longer-than-a-unix-socket-path-may-be
mkdir -p "$long" && TMPDIR="$long" npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts
ls -d "$long"/htmux-* "$long"/harness-e2e-bundle-* 2>/dev/null; rm -rf "$long"
```

The last run fails at once with the sentence, naming `<long>/htmux-XXXXXX/data/daemon-65535.sock`, and runs no test;
`ls` prints nothing: no root, and no bundle was built.

- [ ] **Step 5: Commit**

```bash
git add cli/src/testing/socketPathRoom.ts cli/e2e/harness/socketRoom.ts cli/vitest.e2e.config.ts
git commit -m "e2e: a TMPDIR too long for the daemon's socket stops the run at once, saying so"
```

---

### Task 4: `IsolatedDaemon.create` checks the data folder it made itself

**Depends on:** Task 3 (`assertSocketPathFits`). **Effort:** high. Shares `daemon.ts` with Tasks 6 and 8.

The rule, decided: no option. `create` measures the socket path only of the data folder the harness itself gives a
daemon, that is when the test passed no `options.dataDir` (`<root>/data`, or `<root>/b<n>/d` beside another). A
test's own `dataDir` is never measured: where it sits is that test's subject. `noSocket.e2e.ts:29` passes one too
long on purpose; that test is not changed, and it is the other half of this rule's proof.

**Files:**
- Modify: `cli/e2e/noSocket.e2e.ts` (a second test, the imports, `afterEach`)
- Modify: `cli/e2e/harness/daemon.ts` (`dataDir`'s comment at 91-93, `create` at 253-268)

**Interfaces:**
- Consumes: `assertSocketPathFits(path: string): void` from `../../src/testing/socketPathRoom.js`.
- Produces: nothing another task uses. `DaemonOptions` gains no field.

- [ ] **Step 1: Write the failing test**

In `e2e/noSocket.e2e.ts`, inside the `describe`, after its test; `readdirSync` and `realpathSync` join the file's
`node:fs` import. The `describe` keeps `const tmp = process.env.TMPDIR`, and `afterEach`, after it closed the daemon,
puts it back (`delete process.env.TMPDIR` when it was unset).

```ts
it('refuses at once, saying so, the harness\'s own data folder under a TMPDIR too long, and leaves no root', async () => {
  deep = mkdtempSync(join(tmpdir(), 'harness-deep-'))
  // A daemon made outside the suite's setup: the run's TMPDIR fits, this one does not.
  const long = join(deep, 'a-temporary-folder-whose-path-is-longer-than-a-unix-socket-path-may-be')
  mkdirSync(long)
  process.env.TMPDIR = long
  const refused = await IsolatedDaemon.create({ port: 54321 }).then((made) => { daemon = made; return null }, (error: Error) => error.message)
  const said = /^TMPDIR is too long for the daemon's Unix socket: (\S+\/htmux-\w{6}\/data\/daemon-54321\.sock) would be (\d+) bytes; a socket path has room for 96\. Run with a shorter TMPDIR, for example TMPDIR=\/tmp npm run test:e2e\.$/.exec(refused ?? '')
  expect(said, refused ?? 'the daemon was created').not.toBeNull()
  expect(said![1].startsWith(`${realpathSync(long)}/`)).toBe(true)
  expect(Number(said![2])).toBe(Buffer.byteLength(said![1]))
  expect(readdirSync(long)).toEqual([])
})
```

A create that wrongly succeeds leaves its daemon in `daemon`, which `afterEach` closes; the daemon is never started.

- [ ] **Step 2: Run it to see it fail**

```bash
cd cli && mkdir -p /private/tmp/claude-502/hyg-t4
TMPDIR=/private/tmp/claude-502/hyg-t4/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/noSocket.e2e.ts -t 'refuses at once'
```

Expected: FAIL, `the daemon was created: expected null not to be null`.
Commit the test alone: `e2e: a test that the harness's own data folder too long for a socket is refused at once (red)`.

- [ ] **Step 3: Check in `create`, only the folder the harness made**

In `create`, once `dirs` is known and before any `mkdir`: when `options.dataDir === undefined`,
`` assertSocketPathFits(join(dirs.data, `daemon-${port}.sock`)) ``. When it throws, undo only what this call made and
throw the same error: for a daemon not `beside` another, `await tmux.close()` (it removes the root) and
`forgetTmux(tmux.socket)`; a daemon `beside` another made nothing yet and leaves the shared root alone. Its comment
says why a test's own data folder is not measured (`noSocket.e2e.ts` passes one too long on purpose), and the
`dataDir` option's own comment gains the same sentence. No `DaemonOptions` field, no other condition.

- [ ] **Step 4: Run the checks**

```bash
TMPDIR=/private/tmp/claude-502/hyg-t4/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/noSocket.e2e.ts   # 2 passed
ls -d /private/tmp/claude-502/hyg-t4/htmux-* /private/tmp/claude-502/hyg-t4/harness-deep-* 2>/dev/null                # prints nothing
```

The file's first test passing is the proof that a test's own data folder, 100 bytes and more, is still accepted.

- [ ] **Step 5: Commit**

```bash
git add cli/e2e/harness/daemon.ts
git commit -m "e2e: a daemon under test checks the socket path of the data folder the harness gives it"
```

---

### Task 5: `rootProcesses`: what still names a root, and ending it

**Depends on:** nothing. **Effort:** xhigh (signals to process groups: a wrong one ends the test run).

**Files:**
- Create: `cli/src/testing/rootProcesses.ts`, `cli/src/testing/rootProcesses.spec.ts`

**Interfaces:**
- Consumes: `processTable()`, `alive(pid)`, `ProcessRow` from `./spawnedRuns.js`.
- Produces, for Tasks 6 and 7:
  - `export interface RootProcesses { groups: number[]; pids: number[]; all: number[] }`
  - `export function rootProcesses(root: string, table: ProcessRow[], self: number = process.pid): RootProcesses`.
    A row matches when its command contains `` `${root}/` ``. Never matched: `self`, its parent, pid 1. A match with
    `pid === pgid`, outside `self`'s own group, puts its `pgid` in `groups`; every other match goes in `pids`. `all`
    is every pid the signals reach, once each, in the table's order: the matches and every row of a group in
    `groups`.
  - `export async function endRootProcesses(root: string, ms = 5_000): Promise<string[]>`. Reads `processTable()`
    once, sends SIGKILL to each group (`process.kill(-pgid, …)`) and each pid, then waits until none of `all` is
    alive, at most `ms`. Returns what is still alive as `pid <n> <command>`, empty when nothing is. The wait is
    asynchronous: a child of the caller's own stays a zombie until Node's event loop reaps it.

- [ ] **Step 1: Write the failing spec**

```ts
const row = (pid: number, ppid: number, pgid: number, command: string): ProcessRow => ({ pid, ppid, pgid, command })
const ROOT = '/tmp/htmux-abc'
/** The caller is 50, started by 41, in the group 40 leads. */
const OWN = [row(40, 1, 40, 'node vitest'), row(41, 40, 40, 'node (vitest 1)'), row(50, 41, 40, 'node (vitest 2)')]

describe('rootProcesses', () => {
  it('a match that leads a group gives the group, with the members that do not name the root', () => {
    const table = [...OWN, row(100, 1, 100, 'node /tmp/htmux-abc/bin/codex app-server'), row(101, 100, 100, 'node /repo/cli/e2e/harness/fakeEngine.mjs app-server')]
    expect(rootProcesses(ROOT, table, 50)).toEqual({ groups: [100], pids: [], all: [100, 101] })
  })
  it('a match that leads no group is alone: a test\'s own tmux call is in the worker\'s group', () => {
    const table = [...OWN, row(60, 50, 40, 'tmux -S /tmp/htmux-abc/tmux-501/default list-panes')]
    expect(rootProcesses(ROOT, table, 50)).toEqual({ groups: [], pids: [60], all: [60] })
  })
  it('never the caller, its parent, pid 1, or the caller\'s own group as a group', () => {
    const named = (pid: number, ppid: number, pgid: number) => row(pid, ppid, pgid, `node ${ROOT}/x`)
    expect(rootProcesses(ROOT, [named(1, 0, 1), named(40, 1, 40), named(41, 40, 40), named(50, 41, 40)], 50)).toEqual({ groups: [], pids: [40], all: [40] })
  })
  it('a root whose path begins another\'s is not that root, nor is the root named alone', () => {
    const table = [...OWN, row(100, 1, 100, 'node /tmp/htmux-abcd/bin/codex app-server'), row(110, 1, 110, 'rm -rf /tmp/htmux-abc')]
    expect(rootProcesses(ROOT, table, 50)).toEqual({ groups: [], pids: [], all: [] })
  })
})

describe('endRootProcesses', () => {
  it('ends a group that left its parent and a process of the caller\'s own group, and nothing else', async () => {
    const root = mkdtempSync(join(tmpdir(), 'htmux-')), idle = 'setInterval(() => {}, 1 << 30)'
    // A group of its own whose child names nothing of the root, as `codex app-server` is started (lib/codexRateLimits.ts).
    const leader = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); ${idle}`, join(root, 'bin', 'codex')], { stdio: 'ignore', detached: true })
    // In this spec's own group, as a test's `tmux -S <root>/…` call is; and one under a root whose path begins this one's.
    const own = spawn(process.execPath, ['-e', idle, join(root, 'own')], { stdio: 'ignore' })
    const other = spawn(process.execPath, ['-e', idle, `${root}x/other`], { stdio: 'ignore' })
    const members = await until(() => { const rows = processTable().filter((each) => each.pgid === leader.pid); return rows.length === 2 ? rows.map((each) => each.pid) : null })
    expect(await endRootProcesses(root)).toEqual([])
    expect([...members, own.pid!].filter(alive)).toEqual([])
    expect(alive(other.pid!)).toBe(true)
  })
})
```

`until(probe)` is the spec's own: it asks every 50 ms and throws after 10 s. `afterEach` ends what is left by its
own pid (`-leader.pid`, `own.pid`, `other.pid`, errors ignored) and removes the root.

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/testing/rootProcesses.spec.ts`
Expected: FAIL, `./rootProcesses.js` cannot be found.
Commit the spec alone: `e2e: a spec of what still names a test root, and of ending it (red)`.

- [ ] **Step 3: Write `rootProcesses.ts`** as Interfaces says. Its header says why a group and why not: the fake
engine renames its title, so the fake Codex's child is reached only through its group; a test's own `tmux -S <root>/…`
call is in the Vitest worker's group, which must never be signalled.

- [ ] **Step 4: Run the checks**

```bash
cd cli
npx vitest run src/testing/rootProcesses.spec.ts         # 5 passed
npm run typecheck                                        # no error
```

- [ ] **Step 5: Commit**

```bash
git add cli/src/testing/rootProcesses.ts
git commit -m "e2e: find and end the processes that still name a test root"
```

---

### Task 6: The close ends what left its groups

**Depends on:** Task 5 (`endRootProcesses`) and Task 8 (its first step has to see a run before the close ends what
outlives it). **Effort:** xhigh. Shares `daemon.ts` with Task 4.

**Files:**
- Create: `cli/e2e/harness/hungCodex.ts`
- Modify: `cli/e2e/leftBehind.e2e.ts`
- Modify: `cli/e2e/harness/daemon.ts` (`close`, 545-550)
- Modify: `cli/src/testing/isolatedTmux.ts` (`close`, 30-36), `cli/src/testing/isolatedTmux.spec.ts`

**Interfaces:**
- Consumes: `endRootProcesses(root: string, ms?: number): Promise<string[]>` from
  `../../src/testing/rootProcesses.js`.
- Produces, for Task 7, in `e2e/harness/hungCodex.ts`:
  - `export function writeHungCodex(daemon: IsolatedDaemon): void`, called before the daemon starts.
  - `export async function hungRateLimitRead(daemon: IsolatedDaemon): Promise<ProcessRow[]>`: the two rows of the
    read's process group, its leader first.

- [ ] **Step 1: Write the helper and the failing tests**

`hungCodex.ts`. A hung Codex is the daemon's own fake with these lines after its first (the shim is CommonJS, as the
fake `podman` of `agentBrowser.e2e.ts:40-77` is):

```ts
const HANG = `if (process.argv[2] === 'app-server' && process.argv[3] !== 'proxy') {
  require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
  setInterval(() => {}, 1 << 30)
  return
}`
export function writeHungCodex(daemon: IsolatedDaemon): void {
  const [shebang, ...engine] = fakeEngineShim('codex', { ...daemon.engineConfig }).split('\n')
  writeFileSync(join(daemon.root, 'bin', 'codex'), [shebang, HANG, ...engine].join('\n'), { mode: 0o755 })
}
```

`hungRateLimitRead` waits for `[services] usage connected` in `daemon.log()` (30 s, as `adopt.e2e.ts:43` waits for
search), connects a `LocalClient`, sends `usage_read` without waiting for its answer
(`client.send('usage_read', { requestId: 'hung-read' })`: the answer comes only when the read settles), waits with
`until` (60 s, every 100 ms) for a row with `pid === pgid` whose command contains
`` `${join(daemon.root, 'bin', 'codex')} app-server` `` and for exactly two rows in that group, closes the client and
returns the two rows. Its comment says why a hung one: the fake's own `app-server` ends with its stdin, so only a
Codex that does not end shows what the close must do.

In `e2e/leftBehind.e2e.ts`, inside the `describe`; the file's imports gain the two helpers:

```ts
it('ends what left its process groups: a Codex rate-limit read cut by the close', async () => {
  const d = daemon = await IsolatedDaemon.create()
  writeHungCodex(d)
  await d.start()
  const group = await hungRateLimitRead(d)
  watched = group.map((row) => row.pid)
  // Its child names nothing of the root: only its group reaches it.
  expect(group.filter((row) => !row.command.includes(`${d.root}/`))).toHaveLength(1)
  await d.close()
  daemon = undefined
  expect(watched.filter(alive), 'the read\'s Codex and its child').toEqual([])
  expect(processTable().filter((row) => row.command.includes(`${d.root}/`)).map((row) => row.command)).toEqual([])
  expect(existsSync(d.root)).toBe(false)
})

it('leaves a shared root to the daemon that owns it, and ends alone a process of the test\'s own that names it', async () => {
  const owner = daemon = await IsolatedDaemon.create()
  // In this worker's own process group, as a test's `tmux -S <root>/…` call is.
  const named = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', join(owner.root, 'named')], { stdio: 'ignore' })
  watched = [named.pid!]
  await (await IsolatedDaemon.create({ beside: owner })).close()
  expect(alive(named.pid!), 'after the close of the daemon beside it').toBe(true)
  await owner.close()
  daemon = undefined
  // Ended, and this worker, in the same group, is still here to say so.
  expect(alive(named.pid!), 'after its owner\'s close').toBe(false)
})
```

In `src/testing/isolatedTmux.spec.ts`, inside its `describe` (it needs tmux, as the file's first test does):

```ts
it('removes a folder made read-only in the root, and changes nothing a link in it leads to', async () => {
  const tmux = await isolatedTmux()
  const bin = join(tmux.root, 'runtime', 'grid-0.3.63-darwin-arm64', 'bin')
  const outside = mkdtempSync(join(tmpdir(), 'isolated-tmux-outside-'))
  try {
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'grid'), '')
    chmodSync(bin, 0o555)
    writeFileSync(join(outside, 'kept'), '')
    chmodSync(outside, 0o555)
    symlinkSync(outside, join(tmux.root, 'link'))
    await tmux.close()
    expect(existsSync(tmux.root)).toBe(false)
    expect([statSync(outside).mode & 0o777, readdirSync(outside)]).toEqual([0o555, ['kept']])
  } finally {
    for (const folder of [bin, outside]) { try { chmodSync(folder, 0o755) } catch { /* gone */ } }
    rmSync(tmux.root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run them to see them fail**

```bash
cd cli && mkdir -p /private/tmp/claude-502/hyg-t6
TMPDIR=/private/tmp/claude-502/hyg-t6/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts -t 'ends what left|leaves a shared root'
npx vitest run src/testing/isolatedTmux.spec.ts
```

Expected: the spec, 1 failed, on `EACCES: permission denied, unlink '<root>/runtime/grid-0.3.63-darwin-arm64/bin/grid'`.
The end-to-end file, 2 failed. The first on `the read's Codex and its child: expected [ <pid>, <pid> ] to deeply equal []`, the
second on `after its owner's close: expected true to be false`. A first test that fails earlier, waiting for the
read's Codex, means this plan read the daemon wrongly: stop and report it. The file's `afterEach` ends the `watched`
pids, so the red run leaves nothing: check with
`ps -A -ww -o pid=,command= | grep -F /private/tmp/claude-502/hyg-t6/htmux- | grep -v 'grep -F'`, which prints nothing.
Commit the helper and the tests: `e2e: tests that a daemon's close ends what left its process groups, and removes a read-only folder in its root (red)`.

- [ ] **Step 3: Sweep in `close`**

For the daemon that owns the root (not one `beside` another), in this order:
1. `await this.tmux.run('kill-server').catch(() => {})`: its server names the root on its own command line, so it
   is stopped before the sweep.
2. `const left = await endRootProcesses(this.root)`.
3. `await this.tmux.close()`, which removes the root: after the sweep, so nothing that named it can write into it
   while it goes. The removal also removes a folder a test or a daemon made read-only (the managed grid's `bin/` kept
   ten roots on this Mac, 2026-11-14): see Step 4, the read-only step.
4. `forgetTmux(this.tmux.socket)`.

Then `if (escaped) throw escaped` as today, and after it, when `left` is not empty, throw
`` new Error(`a daemon under test left processes that would not end (root ${this.root}): ${left.join('; ')}`) ``.

- [ ] **Step 4: The read-only step**

`isolatedTmux().close()` removes the root as today, `rm(root, { recursive, force, maxRetries: 10, retryDelay: 50 })`.
When that fails, it makes the root's folders writable by their owner and removes it once more: each folder, the root
first, is read with `lstat` and given `u+rwx`, and only entries that are folders themselves are walked, so a link in the
root is never followed and nothing outside it changes. Only on a failure: a close that removes its root at once walks
nothing. What the second removal cannot remove, its error names, and the close throws it. The worker's reaper does the
same in Task 7.

- [ ] **Step 5: Run the checks**

```bash
TMPDIR=/private/tmp/claude-502/hyg-t6/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts   # 7 passed
npx vitest run src/testing/isolatedTmux.spec.ts                                                                         # 2 passed
ps -A -ww -o pid=,command= | grep -F /private/tmp/claude-502/hyg-t6/htmux- | grep -v 'grep -F'                          # prints nothing
ls -d /private/tmp/claude-502/hyg-t6/htmux-* 2>/dev/null                                                                # prints nothing
```

- [ ] **Step 6: Commit**

```bash
git add cli/e2e/harness/daemon.ts cli/src/testing/isolatedTmux.ts docs/plans/2026-11-14-e2e-harness-hygiene-plan.md
git commit -m "e2e: a daemon's close ends every process that still names its root, then removes it, read-only folders and all"
```

---

### Task 7: The reaper does the same

**Depends on:** Task 6 (`hungCodex.ts`, and the rule it mirrors). **Effort:** xhigh.

**Files:**
- Modify: `cli/e2e/harness/abandonedWorker.ts`
- Modify: `cli/e2e/leftBehind.e2e.ts` (`Started` at 19, the `afterEach` at 41-44, `watched` at 128-129)
- Modify: `cli/e2e/harness/reaperProcess.mjs` (the header, `reap` at 56-61)

**Interfaces:**
- Consumes: `writeHungCodex(daemon)`, `hungRateLimitRead(daemon): Promise<ProcessRow[]>` from `./hungCodex.js`.

- [ ] **Step 1: Make the three worker cases leave a hung read and a read-only folder**

`abandonedWorker.ts`: `writeHungCodex(daemon)` before `daemon.start()`; once the tmux session is made,
`const escaped = (await hungRateLimitRead(daemon)).map((row) => row.pid)`; then `readOnly`, `<root>/read-only` with a
file `kept` in it, `chmod 0o555` (empty, a recursive removal would remove it); the line it prints gains `escaped` and
`readOnly`. Its header says so. `leftBehind.e2e.ts`: `Started` gains `escaped: number[]` and `readOnly: string`; before
`end(child)`, `expect(started.escaped, 'the hung read\'s Codex and its child').toHaveLength(2)`, and `watched` includes
`...started.escaped`. The two waits that follow stay as they are: every watched process gone, then the root. The
`afterEach` makes `started.readOnly` `0o755` before its `rmSync(started.root, …)`, so a red run leaves no root either.

- [ ] **Step 2: Run one case to see it fail**

```bash
cd cli && mkdir -p /private/tmp/claude-502/hyg-t7
TMPDIR=/private/tmp/claude-502/hyg-t7/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts -t 'is killed'
```

Expected: FAIL, `timed out after 40000ms waiting for every process of the daemon to be gone` (the pair outlives the
reaper), and the reaper's `[e2e reaper] could not remove <root>: ENOTEMPTY` (the read-only folder). The `afterEach`
ends the pair and removes the root.
Commit: `e2e: the abandoned worker's daemon leaves a hung Codex read and a read-only folder for the reaper (red)`.

- [ ] **Step 3: Sweep in the reaper, and remove a read-only folder**

In `reap`, for each tmux server: after its `kill-server` and before the root's removal, read the process table
(`ps -A -ww -o pid=,pgid=,command=`, `maxBuffer` 64 MiB), and for each row whose command contains `` `${root}/` ``,
never this process, its parent or pid 1: SIGKILL to its group when `pid === pgid`, to the pid alone otherwise. One line
on stderr when it found any: `[e2e reaper] ended <n> processes that still named <root>`. Then wait until none of them
`exists`, at most 5 s, 100 ms apart, as `reap` waits for its groups; one line names those still there. A failed `ps` is
logged and the root is still removed. The comment names `src/testing/rootProcesses.ts` as the rule it mirrors, and the
header's first paragraph and protocol note say what a root's removal now does.

The removal is Task 6's read-only step, in plain Node (the reaper cannot import `src/testing/isolatedTmux.ts`): `rmSync`
as today; when it fails, each folder, the root first, read with `lstatSync` and given `u+rwx`, only entries that are
folders themselves walked, and `rmSync` once more. What that one cannot remove is logged:
`[e2e reaper] could not remove <root>: <error>`. Checked by the root wait: without the second removal, the `exits` case
fails on `timed out after 10000ms waiting for the daemon's root to be removed`.

- [ ] **Step 4: Run the checks**

```bash
TMPDIR=/private/tmp/claude-502/hyg-t7/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts -t 'once the worker'   # 3 passed
ps -A -ww -o pid=,command= | grep -F /private/tmp/claude-502/hyg-t7/htmux- | grep -v 'grep -F'                                                 # prints nothing
ls -d /private/tmp/claude-502/hyg-t7/htmux-* 2>/dev/null                                                                                       # prints nothing
```

- [ ] **Step 5: Commit**

```bash
git add cli/e2e/harness/reaperProcess.mjs docs/plans/2026-11-14-e2e-harness-hygiene-plan.md
git commit -m "e2e: the worker's reaper ends what still names a root before it removes it, read-only folders and all"
```

---

### Task 8: Nothing of grid comes from beyond this machine

**Depends on:** nothing. **Effort:** high. Shares `daemon.ts` with Task 4. Tasks 6 and 7 come after it.

Decided: the harness's environment sets both `ADAPTER_GRID_RUNTIME_METADATA_URL: 'http://127.0.0.1:9/grid.json'` and
`DISABLE_GRID_INSTALL: 'true'` (the product's own variable, `src/config/env.ts:285`). The second is needed because a
manifest that cannot be read sends `installCli` on to grid's public installer (Found while reading the code). A
test's own `env` still wins over both. Step 1 named the caller (`installCli`); the fix is these two lines.

**Files:**
- Modify: `cli/e2e/leftBehind.e2e.ts`
- Modify: `cli/e2e/harness/daemon.ts` (the environment, beside `BACKEND_WS_URL` at 313-315)

- [x] **Step 1: Find what asks for the manifest** (done, 2026-11-14)

Not `masterIpcExit.e2e.ts`: a copy of it with a local manifest server that noted every request saw none in two runs
of about 320 s, during the test or for five minutes after its close. Nor `storeProcess`, `serviceProcesses`,
`services`, `modelsOnDemand`, `modelSwitch` or `eagerOpenCode` (`compat` skips without a released build), each run
unchanged with `ADAPTER_GRID_RUNTIME_METADATA_URL` pointed at a counting server and `DISABLE_GRID_INSTALL=true` in
Vitest's environment, which the harness passed on to its daemons.

`swarmV4Journey.e2e.ts` asks, on the real backend from before the Swarm's backend was deleted (`be3d169b2b^`, #4280;
at the head the journey fails at its first step, `/api/super-tabs` being gone). Ten requests in one 70 s run, all
from `harnessd-models`, one at each start of models on each of its two computers. The stacks: `harnessd-superTabs`
(`SwarmGrids.pass`, `src/superTabs/swarmGrids.ts:54`) sends `grid_swarm_sync` for the project's Swarm grid; models
answers it after `notReady` (`src/services/models.ts:441`), whose `gridAccess.ensure` runs `reconcileGridAttach`,
then `installCli` (`:92`), then `ensureManagedGrid`. The leftover roots match it: 14 on this Mac now, mostly pairs
made 2-3 s apart, as the journey's two computers are; four pairs were made seconds after a logged run of the journey
started (2026-11-13 17:32 and 17:46, 2026-11-14 07:25 and 07:29), and each root last changed 60-90 s after it was
made, when its close removed what it could.

Why the folder outlived its root: `ensureManagedArchive` makes the managed grid's `bin/` read-only
(`runtimeInstall.ts`, `readOnly`), and the close's recursive removal cannot unlink `bin/grid` in it. The rest of the
root went (`LICENSE.grid` beside `bin/` too); `runtime/` itself is the root's first one, never made again.

- [x] **Step 2: Write the failing test**

In `e2e/leftBehind.e2e.ts`, inside the `describe`; the file's imports gain `readdirSync`, `join` and `LocalClient`.
The path is the request that asked: a local owner's `grid_swarm_sync`, waited for by its answer. Signed out, grid's
set-up gives up (no grid name to mint, or no `grid` on a machine without one), so the answer is `ready: false`;
the Swarm switched off would answer `SERVICE_UNAVAILABLE` with no `ready`, and the assertion would fail.

```ts
// What asked, on 2026-11-14: models' process (`harnessd-models`), at each of its starts in swarmV4Journey.e2e.ts on the real
// backend, once the Swarm's grid was listed. The Swarm's pass (superTabs/swarmGrids.ts) sends `grid_swarm_sync`, which sets
// grid up first: installCli, the managed grid's manifest, then grid's public installer when there is still no `grid`.
it('asks no grid manifest and runs no grid installer beyond the machine', async () => {
  daemon = await IsolatedDaemon.create()
  expect(daemon.env.ADAPTER_GRID_RUNTIME_METADATA_URL).toBe('http://127.0.0.1:9/grid.json')
  expect(daemon.env.DISABLE_GRID_INSTALL).toBe('true')
  // A test's own still stands (update.e2e.ts, harness/fleet.ts). Never started: it only shows whose word wins.
  const own = await IsolatedDaemon.create({ env: { ADAPTER_GRID_RUNTIME_METADATA_URL: 'http://127.0.0.1:1/own.json', DISABLE_GRID_INSTALL: 'false' } })
  await own.close()
  expect(own.env.ADAPTER_GRID_RUNTIME_METADATA_URL).toBe('http://127.0.0.1:1/own.json')
  expect(own.env.DISABLE_GRID_INSTALL).toBe('false')
  await daemon.start()
  const client = await LocalClient.connect(daemon)
  // The owner's computer keeping a Swarm's grid, as the Swarm's pass asks it: answered once grid's set-up gave up.
  expect(await client.request('grid_swarm_sync', { grid: 'swarm-0123456789ab', members: [] }, 60_000)).toMatchObject({ ready: false })
  client.close()
  expect(daemon.log()).not.toContain('installing the Harness grid runtime')
  expect(daemon.log()).not.toMatch(/grid installer (exited|finished)|installed `grid` to/)
  expect(readdirSync(daemon.env.ADAPTER_RUNTIME_DIR!).filter((name) => name.startsWith('grid-'))).toEqual([])
  // Where grid's installer would put it: under the test's home (lib/gridInstall.ts GRID_INSTALL_DIR).
  expect(existsSync(join(daemon.env.HOME!, '.local', 'bin', 'grid'))).toBe(false)
})
```

The environment's assertions come first on purpose: the red run stops at the first of them and never drives the
path, which before the fix could reach the internet. After the fix, the same request asks `127.0.0.1:9/grid.json`
from `harnessd-models` (seen with a fetch trace), and is refused on this machine.

- [ ] **Step 3: Run it to see it fail**

`TMPDIR=/private/tmp/claude-502/hyg-t8/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts -t 'asks no grid manifest'`
Expected: FAIL on the first `expect`: `expected undefined to be 'http://127.0.0.1:9/grid.json'`.
Commit the test alone: `e2e: a test that a daemon under test asks no grid manifest and runs no grid installer beyond the machine (red)`.

- [ ] **Step 4: Keep grid on this machine**

In `create`'s environment, with the two lines under "Signed out, and nothing reaches beyond the machine":
`ADAPTER_GRID_RUNTIME_METADATA_URL: 'http://127.0.0.1:9/grid.json'` and `DISABLE_GRID_INSTALL: 'true'`. Both are
above `...options.env`, so a test's own still decides. Their comment names the 19 MB
`runtime/grid-0.3.63-darwin-arm64` that removed roots kept, the file that downloaded it (`swarmV4Journey.e2e.ts`,
through `grid_swarm_sync`), and says why the second line: with no manifest to read, the models service goes on to
grid's public installer (`services/models.ts` `installCli`).

- [ ] **Step 5: Run the checks**

```bash
TMPDIR=/private/tmp/claude-502/hyg-t8/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts -t 'asks no grid manifest|bridge a port'   # 2 passed
```

- [ ] **Step 6: Commit**

```bash
git add cli/e2e/harness/daemon.ts
git commit -m "e2e: a daemon under test reads its grid manifest from this machine and runs no grid installer"
```

---

### Task 9: The setup removes the folders it made

**Depends on:** nothing. **Effort:** high.

`cli/vitest.setup.ts` is a setup file of both suites (`vitest.config.ts`, `vitest.e2e.config.ts`), so it runs before
every test file. Each time it makes `adapter-test-home-*`, `adapter-test-data-*` and `adapter-test-runtime-*` under
`os.tmpdir()` and never removes them. The unit suite's are inside the run's own folder, which goes with the run
(`src/__fixtures__/vitestRun.ts`); the end-to-end suite has none, so every file left three empty folders in TMPDIR.
Nothing reads them after the file: the next file's setup makes and points the environment at folders of its own.

**Files:**
- Create: `cli/src/testing/vitestSetupFolders.spec.ts`
- Modify: `cli/vitest.setup.ts` (the three `mkdtempSync` lines, 37, 46 and 47)

- [ ] **Step 1: Write the failing spec**

It runs Vitest as a child (`node node_modules/vitest/vitest.mjs run`, Vitest's own variables left out of its
environment) on a project of its own under a `mkdtempSync` root, with `TMPDIR`, `TEMP` and `TMP` set to `<root>/tmp`.
The project's config has `globals: true` and `setupFiles: [<cli>/vitest.setup.ts]`; it holds one file that passes
and one that fails, each of whose own `afterAll` records `HOME`, `ADAPTER_DATA_DIR` and `ADAPTER_RUNTIME_DIR` with
whether each is still there. `afterEach` removes the root.

```ts
expect(code).toBe(1)
expect(recorded).toHaveLength(6)
// Each was the file's own, in the child's temporary folder, and still there for the file's own afterAll.
for (const [folder, there] of recorded) expect([folder.startsWith(temp), there]).toEqual([true, true])
expect(made.filter((folder) => existsSync(folder))).toEqual([])
expect(readdirSync(temp).filter((name) => name.startsWith('adapter-test-'))).toEqual([])
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/testing/vitestSetupFolders.spec.ts`
Expected: 1 failed, the six folders still there.
Commit the spec alone: `e2e: a spec that vitest.setup.ts removes the folders it made when a file ends (red)`.

- [ ] **Step 3: Remove them when the file ends**

Keep each folder's path as the setup makes it, and register one `afterAll` that removes the three
(`rmSync(folder, { recursive: true, force: true })`). Registered before any of the file's own, it runs after them all
(Vitest's `sequence.hooks` is `stack`), once the file's `afterAll` has closed the daemons that used them, and it runs
when the file fails too. The paths are kept, not read from the environment then, so a test that changed `HOME` is
never followed elsewhere.

- [ ] **Step 4: Run the checks**

```bash
cd cli
npx vitest run src/testing/vitestSetupFolders.spec.ts src/config/envIsolation.spec.ts                           # 8 passed
mkdir -p /private/tmp/claude-502/hyg-t9
TMPDIR=/private/tmp/claude-502/hyg-t9/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/modelSwitch.e2e.ts   # 1 passed
ls -d /private/tmp/claude-502/hyg-t9/adapter-test-* 2>/dev/null                                                  # prints nothing
```

- [ ] **Step 5: Commit**

```bash
git add cli/vitest.setup.ts docs/plans/2026-11-14-e2e-harness-hygiene-plan.md
git commit -m "e2e: vitest.setup.ts removes the home, data and runtime folders it made when the file ends"
```

---

### Task 10: A daemon's temporary folder is in its root, and a failed close is seen

**Depends on:** nothing. **Effort:** high.

`e2e/agentBrowser.e2e.ts` left `$TMPDIR/browser/shot-<time>.jpg` (1 MiB) in the worker's TMPDIR, outside any root: a
plain agent's pane inherits the daemon's TMPDIR, the worker's, and `harness browser screenshot` writes to
`$TMPDIR/browser` (`cli/src/agentClient/browserOutput.ts`). The daemon under test gets `TMPDIR=<own>/t` instead (its
root, or for a daemon `beside` another its own `b<n>` folder), before the test's own env, which still wins. What it and
its children put in a temporary folder goes with the root.

No daemon-side Unix socket is made under TMPDIR: the daemon's is in its data folder (`lib/localSocket.ts`), the
bridge's in the connectors' vault (`lib/connectors/agents.ts`), the master and its core and services talk over an
`ipc` channel (`harnessd/master.ts`), and tmux has `TMUX_TMPDIR` (`src/testing/isolatedTmux.ts`). So the socket-room
check is unchanged: `<root>/data/daemon-65535.sock` stays the longest (92 bytes under a default macOS TMPDIR of 56), and
the one-letter `t` leaves a child 25 bytes for a socket there.

`backend.stop()` (`cli/e2e/harness/realBackend.ts`) closed every daemon with `.catch(() => {})`: a root that could not
be removed, or processes that would not end, were seen by no one. It closes every daemon, stops the services as before,
then throws an `AggregateError` naming each close that failed. No red test: the function is built inside the real
backend's boot, out of reach of `realBackendApi.spec.ts` without one.

**Files:**
- Modify: `cli/e2e/agentBrowser.e2e.ts` (the plain agent's screenshot)
- Modify: `cli/e2e/harness/daemon.ts` (`create`: `dirs.tmp`, `TMPDIR`)
- Modify: `cli/e2e/harness/realBackend.ts` (`stop`)

- [ ] **Step 1: Write the failing check**

After the plain agent's screenshot in `agentBrowser.e2e.ts`:

```ts
expect(path.startsWith(`${d.root}/`), path).toBe(true)
expect(existsSync(join(tmpdir(), 'browser', basename(path)))).toBe(false)
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && TMPDIR=/private/tmp/claude-502/hyg-t10/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts -t "a plain agent"`
Expected: 1 failed, the shot in `/private/tmp/claude-502/hyg-t10/browser/`.
Commit the check alone: `e2e: an agent's screenshot stays in its daemon's root, none in the worker's TMPDIR (red)`.

- [ ] **Step 3: The daemon's TMPDIR, and `stop`**

`dirs.tmp = join(own, 't')`, made with the others, and `TMPDIR: dirs.tmp` in the daemon's environment before
`...options.env`. In `stop`, each close's error is kept, and thrown once the services are stopped.

- [ ] **Step 4: Run the checks**

```bash
cd cli
TMPDIR=/private/tmp/claude-502/hyg-t10/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts   # 6 passed
TMPDIR=/private/tmp/claude-502/hyg-t10/ caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/noSocket.e2e.ts e2e/masterIpcExit.e2e.ts   # 3 passed
ls /private/tmp/claude-502/hyg-t10/browser 2>/dev/null                                                       # prints nothing
```

- [ ] **Step 5: Commit**

```bash
git add cli/e2e/harness/daemon.ts cli/e2e/harness/realBackend.ts docs/plans/2026-11-14-e2e-harness-hygiene-plan.md
git commit -m "e2e: a daemon under test keeps its temporary folder in its root, and backend.stop() throws the closes that failed"
```

---

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): every file boots
its own daemons under a throwaway root, with a private tmux server, ports of its own and fake engines, signed out,
its backend and grid manifest at `127.0.0.1:9`, grid's installer off. No sign-in, no account, no production, and nothing of the developer's daemon
(port 18473), `~/.harness`, `~/.claude` or `~/.codex`. None of these checks needs Ken himself.

Local checks run on this Mac (macOS, tmux), in `cli/`, one at a time, under `caffeinate -i`, with a TMPDIR of their
own so that the census sees this run only (other sessions' roots are in the Mac's default TMPDIR and are not touched):

```bash
cd cli && export TMPDIR=/private/tmp/claude-502/hyg-v/ && mkdir -p "$TMPDIR"
census() { ps -A -ww -o pid=,ppid=,pgid=,command= | grep -F "${TMPDIR}htmux-" | grep -v 'grep -F'; ls -d "${TMPDIR}"htmux-* 2>/dev/null; }
```

1. **`masterIpcExit.e2e.ts`**, the file that left two fake `codex app-server` processes and a grid folder.

   ```bash
   census; caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/masterIpcExit.e2e.ts; census
   ```

   To see: 1 passed; both censuses print nothing.

2. **`agentBrowser.e2e.ts`**, the file that left a fake `podman events`. Its `podman` is a fake first on the
   fixture's PATH; the real Podman is never run.

   ```bash
   census; caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts; census
   ```

   To see: 6 passed; both censuses print nothing.

3. **`leftBehind.e2e.ts`**.

   ```bash
   census; caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts; census
   ```

   To see: 7 passed; both censuses print nothing.

4. **Five minutes later**, so that a writer that outlived the close would have shown:

   ```bash
   sleep 300; census
   ```

   To see: it prints nothing.

5. **A TMPDIR too long**, as an agent's is here:

   ```bash
   long=/private/tmp/claude-502/hyg-v-a-temporary-folder-whose-path-is-longer-than-a-unix-socket-path-may-be
   mkdir -p "$long" && TMPDIR="$long" npx vitest run --config vitest.e2e.config.ts e2e/leftBehind.e2e.ts
   ls -d "$long"/htmux-* "$long"/harness-e2e-bundle-* 2>/dev/null; rm -rf "$long"
   ```

   To see: the run ends at once, before any test, with
   `TMPDIR is too long for the daemon's Unix socket: <long>/htmux-XXXXXX/data/daemon-65535.sock would be <n> bytes; a socket path has room for 96. Run with a shorter TMPDIR, for example TMPDIR=/tmp npm run test:e2e.`;
   `ls` prints nothing.

On GitHub, by hand, once, only on the orchestrator's go, after the branch is pushed (shared runners,
`docs/validation-and-release.md`). Report the run's link.

6. **The whole suite on Linux, and the full disk on macOS:** the existing workflow, eight Linux shards and one macOS
   runner, real backend with in-memory Mongo and Redis and its own test accounts.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/e2e-harness-hygiene
   ```

   To see: `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green. It proves the sweep ends
   nothing a test still needs, the Swarm readers of `launch-argv`, every `backend.api` call, and the socket check on
   both runners' TMPDIRs. A red test is reported with its link and whether main's last nightly run has it too.

**Temporary workflow:** none. The long check has a workflow already (`.github/workflows/cli-e2e.yml`, run by hand
from a branch and every night), and the local ones need this Mac's process table.

**Checks PR CI does not run:** Task 9's `cli/vitest.setup.ts` is shared by every CLI suite, so
`python3 scripts/local-checks.py --list` on the changed paths names the CLI local gates (`cli-core`, `cli-harnessd`,
`cli-portability`, `cli-pty` and the rest); their receipts go in the pull request (`--run` from a clean tree). PR CI's
`cli-typecheck` and `cli-tests` run the five new specs.
