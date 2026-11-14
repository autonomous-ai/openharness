# Port pick races outside the e2e harness: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Tasks 1 to 5 are test-first: a red commit
> (the tests alone), then the code commit. Tasks 6 and 7 change a test's own fixture and are one commit each. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nothing in `cli/src` or `backend/src` picks a loopback port by closing a listener and handing the number to
something else to bind: the binder picks its port and says which, or the caller checks who answers.

**Architecture:** Seven places, seven independent tasks, no shared code. Ollama and llama.cpp are started on port 0
and their port is read from their own log line. The Grid probe asks `/v1/models` whose engine answers before it reads
anything into the answer. The connectors service tells a spec the port its bridge bound. Three specs stop picking a
port (a held port and the daemon's record, a Unix socket, port 1).

**Tech Stack:** TypeScript, Node (v23.11.0 on this Mac; CI 22.23.2 for the backend), Vitest 4, ioredis 5. Real
binaries only in Verification: Ollama 0.32.6, llama.cpp 9550, redis-server 8.0.1. No new dependency.

**Spec:** [docs/plans/2026-11-14-port-pick-races-design.md](2026-11-14-port-pick-races-design.md). Read it with this
plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/services/AGENTS.md`. The spec is the authority; its decisions
are not reopened here.

## Answered questions

1. **The Cursor end-to-end test's full run.** Not run under Ken's login (orchestrator, 2026-11-14). Task 4 shows the
   red and the green up to the first step that needs Cursor signed in; the pull request says
   "not run (needs a signed-in Cursor agent)". Verification check 6 is not run.
2. **Logs already on disk.** Left where they are; nothing removes them (orchestrator, 2026-11-14).

## Global Constraints

- The rule (spec): the process that binds picks the port (port 0) and says which it got; where it cannot, the caller
  checks that whatever answers is the one it started. No retries.
- The daemon core does not change: no file under `cli/src/core/`, and no file in `cli/src/architecture.coreFiles.txt`
  (`appModels.ts`, `localModels.ts` and `services/connectors.ts` are not in it).
- Not touched: `cli/src/dsh/viewer.ts` and `HARNESS_VIEWER_PORT`; `lib/stunSelect.spec.ts`;
  `agentClient/daemon.spec.ts`; `lib/windows/bridgePort.windows.real.spec.ts`;
  `services/agentBrowser/proxyRelay.spec.ts`. Nothing under `cli/e2e/` (branch `fix/e2e-free-port-race` owns it; this
  branch does not depend on it and shares no file with it).
- `cli/src/lib/appModels.ts`: the change stays in `freePort` (deleted), `start`, `background`'s open flag, the new
  wait and their imports. `exec`, `scanAppModels`, `ready`, `alive`, `loadedContext`, `stop` and LM Studio's path are
  not edited (`fix/service-child-leaks` changes `exec`).
- Verbatim, `appModels.ts`: `OLLAMA_HOST=127.0.0.1:0`; `--port 0`; the two lines read are Ollama's
  `Listening on 127.0.0.1:<port>` and llama.cpp's `server is listening on http://127.0.0.1:<port>`; the messages
  `Ollama could not start. Try again.`, `llama.cpp could not load the model. Try again.` and
  `Update llama.cpp to build 4240 or newer, then try again.`; the deadlines stay 60 000 ms (Ollama) and 600 000 ms
  (llama.cpp), each covering the port line and health together.
- Verbatim, `localModels.ts`: the expected id is `candidate.aliases?.[0] ?? candidate.file`, compared exactly with
  `data[].id` of `/v1/models`. `freePort` stays there. The join's arguments do not change.
- Verbatim, `connectors.ts`: `listening?: (port: number) => void` on `ConnectorsOverrides`. Production passes none.
- Coverage gates stay at 100% per file: `cli/src/services/connectors.ts` (`npm run test:core`) and
  `cli/src/lib/localModels.ts` (`npm run test:local-models`).
- `backend/src/lib/redisRateCounter.test.ts` gets no skipped test: `backend/scripts/redis-tests-ran.mjs` fails
  `backend-desk` when a file that reads `REDIS_TEST_URL` has a test that did not run.
- Nothing a task runs touches the person's own things: not Ollama on 11434, `~/.ollama` or any model; not the daemon
  on 18473; not the default tmux server; not `~/.cursor` (the one exception is Verification check 6, on Ken's yes). A
  new test waits on a condition with a bound, never a fixed sleep, and ends the processes it started by their exact
  pids.
- A task runs the specs it names. No full local suite: PR CI runs it. The local gates run once, at the end
  (Verification check 3).
- A commit adds its files by name. The two documents under `docs/plans/` are untracked and are no task's.
- `cli/node_modules` is installed in this checkout (2026-11-14); `backend/node_modules` is not. A task in another
  checkout installs first: `npm ci --no-audit --no-fund` in `cli/` or `backend/`.
- Comments say why, in plain sentences, and name the cause: a port freed for someone else to bind can be taken by any
  process in between.
- Platforms: `appModels.ts` and `localModels.ts` on macOS and Linux; the specs on macOS and Linux (none is in
  `windows.yml`'s list); the backend test's own server on macOS and Linux where `redis-server` is installed.
- One pull request. Its body names the platforms and carries: each task's red and green output; the hand-forced races
  of Tasks 6 and 7; the Verification results; the `cli-core` and `cli-local-models` receipts; the Cursor run's status;
  and the two gaps the spec lists (Grid should take `--endpoint-port 0` and report the port its engine bound; the DSH
  viewer's `HARNESS_VIEWER_PORT` contract).

## Found while reading the code

Checked at `39c675b7af` on this Mac (macOS 26, arm64).

- **Baseline.** `npx vitest run` on the six CLI specs: `appModels` 10, `localModels` 238, `connectors` 31,
  `bridge.socket` 16, `cableHost` 107, `gridReads` 40, all passed; `localE2e.spec.ts` 1 skipped. `npm run
  test:local-models`: 272 passed, 100%.
- **`npm run test:core` applies.** No core file changes, but the gate `cli-core` covers `cli/src/services/*`
  (`scripts/local-checks.py`, `cli/AGENTS.md` rule 4) and Task 3 changes `cli/src/services/connectors.ts` and its spec.
  `python3 scripts/local-checks.py --list` on this plan's paths names `cli-core` and `cli-local-models`, nothing else.
- **The real lines, read today.** Ollama 0.32.6, `OLLAMA_HOST=127.0.0.1:0`, a throwaway `HOME`:
  `time=2026-11-14T16:07:52.187+07:00 level=INFO source=routes.go:1990 msg="Listening on 127.0.0.1:64374 (version 0.32.6)"`.
  llama.cpp 9550, `--port 0 --alias probe-alias`, the 1.2 MB test model:
  `0.00.227.185 I srv  llama_server: server is listening on http://127.0.0.1:64619`, and `/v1/models` listed
  `["probe-alias"]`. Ollama does not end on SIGALRM: stop it by pid.
- **Grid 0.3.43, as the spec says.** `shared/engine/launcher.py:214-216` adds `--alias <alias>`;
  `remote/serve.py:552-568` reads `endpoint_port or 8081` and starts on `free_port_from(port + 1)` when it is taken.
- **The appModels fake works as planned.** A script with `#!/usr/bin/env node` named `ollama`, spawned detached with
  its output in a file: `ps -o command=` shows `node <dir>/ollama serve` (what `ours()` looks for), a line written in
  two parts is read whole once its newline arrives, and SIGTERM to its group leaves no pid within 25 ms.
- **The probe change holds the gate.** Tried and reverted: with Task 2's change and tests, `npm run
  test:local-models` passes at 100%, once the suite's default `request` answers `/v1/models` as Grid's engine would.
- **The seam holds the gate.** Tried and reverted: with Task 3's change, `connectors.spec.ts` passes (32) with
  `connectors.ts` at 100%, `bridge.socket.spec.ts` passes (16), `tsc --noEmit` is clean.
- **Port 1 and Node's `fetch`.** `ws` and `net` get `ECONNREFUSED` from `127.0.0.1:1` at once (`cableHost.spec.ts`).
  Node's `fetch` never dials port 1: it refuses the port itself (`fetch failed`, cause `bad port`), which lands in the
  same `catch` of `gridReader.readOverview` (`unreachable`). Tried: both specs pass with port 1 (147 passed).
- **The Cursor spec is not isolated by itself.** It uses `~/.cursor/hooks.json` and the default tmux server of
  whoever runs it. Task 4 runs it with a throwaway `HOME` and a private tmux server, which also signs Cursor out.
- **Ollama's failure path does not stop the engine** it started (`appModels.ts:240`). That stays as it is.
- `fix/service-child-leaks` has no commit on `appModels.ts` yet.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/lib/appModels.ts` | port 0, the port read from the engine's log, one log per engine and model; `freePort` removed | 1 |
| `cli/src/lib/__fixtures__/fakeAppEngine.ts` | new: a fake `ollama` / `llama-server` that binds what it is asked and prints the engine's line | 1 |
| `cli/src/lib/appModels.spec.ts` | 8 new cases against the fake | 1 |
| `cli/src/lib/localModels.ts` | `probeEngine` checks `/v1/models` before it reads an answer | 2 |
| `cli/src/lib/localModels.spec.ts` | the default `request` answers `/v1/models`; 5 new cases | 2 |
| `cli/src/services/connectors.ts` | the `listening` seam | 3 |
| `cli/src/services/connectors.spec.ts` | 1 new case; `freePort` removed, its 5 uses on the seam | 3 |
| `cli/src/cloud/bridge.socket.spec.ts` | the closed listener and the start (`:197-201`) become one start on the seam | 3 |
| `cli/src/engines/cursor/localE2e.spec.ts` | the configured port is held; the bound port comes from the daemon's record | 4 |
| `backend/src/lib/redisRateCounter.test.ts` | its own `redis-server` on a Unix socket; 1 new case | 5 |
| `cli/src/cable/cableHost.spec.ts` | `:1781-1788`: port 1 | 6 |
| `cli/src/lib/gridReads.spec.ts` | `:178-181`: port 1 | 7 |

## Review Focus

Each line is pinned by a test in the task that owns the code.

- The engine's port line arrives in two writes, cut inside the number: the whole port is read, never its first
  digits. Task 1.
- A model started a second time: the port read is this run's, not the one still in the log from the last run. Task 1.
- A llama.cpp that prints `HTTP server is listening, hostname: 127.0.0.1, port: 0` before it loads the model: that
  line is not its port, and the start does not ask for an update. Task 1.
- Whatever holds the port lists the model under the name the grid shows it by (`small-q4`), not the one the engine
  was started under (`Small-Q4.gguf`): not this engine, and the relay check judges. Task 2.
- A model with routing names of its own: its engine is known by the first one, not by its file. Task 2.

---

### Task 1: Ollama and llama.cpp pick their own port

**Depends on:** nothing. **Effort:** xhigh.

**Files:**
- Create: `cli/src/lib/__fixtures__/fakeAppEngine.ts`
- Modify: `cli/src/lib/appModels.spec.ts` (imports `:1-2`; a new `describe` at the end)
- Modify: `cli/src/lib/appModels.ts` (imports `:5-9`; `freePort` `:156-165`; `background` `:211`; `start` `:234-251`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing another task uses. `AppEngineOps`, `AppEngineRecord` and `llamaServerArgs` keep their shapes.

- [ ] **Step 1: The fake engine**

`fakeAppEngine.ts`, in the manner of `fakeGrid.ts`:

```ts
export type FakeEngineFault = 'exits' | 'port-zero' | 'split-line' | 'early-line'
export interface FakeEngineStart { pid: number; argv: string[]; host: string | null; port: number | null }
export interface FakeAppEngine {
  /** The fake's path: a file named `ollama` or `llama-server`, so `ps` shows the name Stop checks for. */
  binary: string
  /** Every start of the fake, oldest first: its pid, its arguments, its OLLAMA_HOST and the port it bound. */
  starts: () => FakeEngineStart[]
  /** Ends every fake still running, each by its pid, then deletes the folder. */
  dispose: () => void
}
export function fakeAppEngine(kind: 'ollama' | 'llama.cpp', fault?: FakeEngineFault): FakeAppEngine
```

The script (`#!/usr/bin/env node`, CommonJS, mode 0755, in a folder of its own,
`mkdtempSync(join(tmpdir(), 'fake-engine-'))`):
- reads the port it is asked for (Ollama: after the colon of `OLLAMA_HOST`; llama.cpp: the value after `--port`) and
  listens there on `127.0.0.1` with an HTTP server that answers every request `200 {}`;
- once listening, appends one JSON line to `starts.jsonl` beside it (`pid`, `argv`, `host`, the bound `port`), then
  prints the engine's own line with the bound port, as the real ones printed it on 2026-11-14:
  - Ollama, on stderr: `time=2026-11-14T16:07:52.187+07:00 level=INFO source=routes.go:1990 msg="Listening on 127.0.0.1:<port> (version 0.32.6)"`
  - llama.cpp, on stdout: `0.00.227.185 I srv  llama_server: server is listening on http://127.0.0.1:<port>`
- exits 0 on SIGTERM.

Faults: `exits` appends its start with `port: null`, prints
`Error: listen tcp 127.0.0.1:0: bind: operation not permitted`, binds nothing and exits 1. `port-zero` binds as asked
and prints its line with `0` for the port. `split-line` prints the line in two writes, cut after the port's first two
digits, the rest and the newline 300 ms later. `early-line` prints
`main: HTTP server is listening, hostname: 127.0.0.1, port: 0, http threads: 9` before the real line.

- [ ] **Step 2: Write the failing tests**

`appModels.spec.ts`, a new `describe` at the end. Add `afterEach`, `beforeEach` and `vi` to the vitest import, and
import `AppStartError` and the types `AppEngineOps`, `AppEngineRecord`, `AppModel`; `processExists`
(`./processLiveness.js`); `fakeAppEngine` and its types `FakeAppEngine`, `FakeEngineStart`; and `mkdtempSync`,
`readdirSync`, `readFileSync`, `rmSync`, `tmpdir`, `join`.

```ts
// A port picked here and freed for the engine could be taken by any process before the engine bound it. The engine
// picks its own (port 0) and says which in its log; these run a fake that does what Ollama 0.32.6 and llama.cpp 9550 do.
describe.skipIf(process.platform === 'win32')('an engine started on a port it picks itself', () => {
  const ops = appEngineOps({ PATH: process.env.PATH })
  const ollama = (binary: string): AppModel =>
    ({ id: 'app:ollama:qwen3:8b', name: 'qwen3:8b', app: 'ollama', engine: 'ollama', ref: 'qwen3:8b', binary, sizeBytes: GiB })
  const llama = (binary: string): AppModel =>
    ({ id: 'app:llama.cpp:tiny Q4.gguf', name: 'tiny Q4', app: 'llama.cpp', engine: 'llama.cpp', ref: '/m/tiny Q4.gguf', binary, sizeBytes: GiB })
  const record = (model: AppModel, started: Awaited<ReturnType<AppEngineOps['start']>>): AppEngineRecord =>
    ({ spec: 1, modelId: model.id, grid: 'g', name: model.name, ...started })
  const fakes: FakeAppEngine[] = []
  const fake = (...args: Parameters<typeof fakeAppEngine>) => { const made = fakeAppEngine(...args); fakes.push(made); return made }
  let logs: string
  beforeEach(() => { logs = mkdtempSync(join(tmpdir(), 'app-logs-')) })
  afterEach(() => { for (const made of fakes.splice(0)) made.dispose(); rmSync(logs, { recursive: true, force: true }) })

  it.each([
    ['ollama', ollama, 'ollama-qwen3%3A8b.log', (start: FakeEngineStart) => start.host, '127.0.0.1:0'],
    ['llama.cpp', llama, 'llama-tiny%20Q4.log', (start: FakeEngineStart) => start.argv.slice(-2).join(' '), '--port 0'],
  ] as const)('starts %s on port 0 and records the port the engine says it bound', async (kind, model, log, asked, zero) => {
    const engine = fake(kind), mine = model(engine.binary)
    const started = await ops.start(mine, 65536, logs)
    const [seen] = engine.starts()
    expect(asked(seen)).toBe(zero)
    expect(seen.port).toBeGreaterThan(0)
    expect(started).toMatchObject({ engine: kind, port: seen.port, pid: seen.pid })
    expect(readdirSync(logs)).toEqual([log])
    expect(await ops.alive(record(mine, started))).toBe(true)
    await ops.stop(record(mine, started))
    expect(processExists(seen.pid)).toBe(false)
  })

  it("empties a model's log at each start, so the port read is this run's", async () => {
    const engine = fake('ollama'), mine = ollama(engine.binary)
    await ops.stop(record(mine, await ops.start(mine, 65536, logs)))
    const again = await ops.start(mine, 65536, logs)
    expect(again.port).toBe(engine.starts()[1].port)
    expect(readFileSync(join(logs, 'ollama-qwen3%3A8b.log'), 'utf8').match(/Listening on/g)).toHaveLength(1)
    await ops.stop(record(mine, again))
  })

  it.each([
    ['ollama', ollama, 'Ollama could not start. Try again.'],
    ['llama.cpp', llama, 'llama.cpp could not load the model. Try again.'],
  ] as const)('says %s could not start, at once, when it exits before naming a port', async (kind, model, message) => {
    const began = Date.now()
    const error = await ops.start(model(fake(kind, 'exits').binary), 65536, logs).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AppStartError)
    expect((error as Error).message).toBe(message)
    expect(Date.now() - began).toBeLessThan(10_000)
  })

  it('stops a llama.cpp too old to say its port, and says to update it', async () => {
    const engine = fake('llama.cpp', 'port-zero')
    const error = await ops.start(llama(engine.binary), 65536, logs).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(AppStartError)
    expect((error as Error).message).toBe('Update llama.cpp to build 4240 or newer, then try again.')
    await vi.waitFor(() => expect(processExists(engine.starts()[0].pid)).toBe(false))
  })

  it('reads the whole port from a line that arrives in two writes', async () => {
    const engine = fake('ollama', 'split-line'), mine = ollama(engine.binary)
    const started = await ops.start(mine, 65536, logs)
    expect(started.port).toBe(engine.starts()[0].port)
    await ops.stop(record(mine, started))
  })

  it('does not take the line llama.cpp printed before loading for its port', async () => {
    const engine = fake('llama.cpp', 'early-line'), mine = llama(engine.binary)
    const started = await ops.start(mine, 65536, logs)
    expect(started.port).toBe(engine.starts()[0].port)
    await ops.stop(record(mine, started))
  })
})
```

- [ ] **Step 3: Run them to see them fail**

```bash
cd cli && npx vitest run src/lib/appModels.spec.ts
```

Expected: `4 failed | 14 passed (18)`. Failing: both `starts … on port 0` cases (a non-zero port was passed), the
log case (`ENOENT`: today's file is `ollama-<port>.log`) and the too-old llama.cpp case (the start resolves). The
exit, two-writes and early-line cases pass before and after: today's start never reads the log, and they pin the new
wait. No fake process is left: `ps -A -ww -o pid=,command= | grep -F fake-engine- | grep -v grep` prints nothing.
Commit the fixture and the spec: `models: specs that Ollama and llama.cpp start on port 0 and say their port (red)`.

- [ ] **Step 4: `start` passes port 0 and reads the port the engine says**

In `appModels.ts`:

- Delete `freePort` and the `node:net` import. Add `open` to the `node:fs/promises` import.
- `background` removes the log and opens a new one with `'w'` in place of `'a'`: made new at each start, so only this
  run's lines are in it, and an engine still running from an earlier start writes on into the old file, not this one.
- The log's name, one per engine and model: `ollama-${encodeURIComponent(model.name).slice(0, 200)}.log` and
  `llama-${encodeURIComponent(model.name).slice(0, 200)}.log`. Percent-encoding keeps two names two files
  (`qwen3:8b` is `ollama-qwen3%3A8b.log`), so two engines never write one file.
- The new wait, beside `ready`:

```ts
/** What each engine prints once it has bound the port the system gave it. */
const SAYS_PORT = {
  ollama: /Listening on 127\.0\.0\.1:(\d{1,5})\b/,
  'llama.cpp': /server is listening on http:\/\/127\.0\.0\.1:(\d{1,5})\b/,
} as const
const LOG_POLL_MS = 100

/** The port [engine] says it bound, from its log as the log grows. Null when its process ends or [deadline] passes first. */
const saidPort = async (engine: keyof typeof SAYS_PORT, logFile: string, deadline: number, pid: number): Promise<number | null> => {
  const log = await open(logFile, 'r')
  try {
    const chunk = Buffer.alloc(64 * 1024)
    let offset = 0, unfinished = ''
    for (;;) {
      for (let read = await log.read(chunk, 0, chunk.length, offset); read.bytesRead > 0; read = await log.read(chunk, 0, chunk.length, offset)) {
        offset += read.bytesRead
        // Whole lines only: a write cut inside the number would read as a shorter port.
        const lines = (unfinished + chunk.toString('latin1', 0, read.bytesRead)).split('\n')
        unfinished = lines.pop()!.slice(-4096)
        for (const line of lines) { const said = SAYS_PORT[engine].exec(line); if (said) return Number(said[1]) }
      }
      if (!processExists(pid) || Date.now() >= deadline) return null
      await sleep(LOG_POLL_MS)
    }
  } finally { await log.close() }
}
```

- `start`, Ollama: `OLLAMA_HOST: '127.0.0.1:0'`; one `deadline = Date.now() + 60_000`;
  `port = await saidPort('ollama', join(logDir, log), deadline, pid)`; then
  `ready(\`http://127.0.0.1:${port}/api/version\`, deadline - Date.now(), pid)`. No port (null, or a line naming 0, which
  no Ollama in use prints) or not ready: `AppStartError('Ollama could not start. Try again.')`, as now.
- `start`, llama.cpp: `llamaServerArgs(model, ctx, 0)`; one `deadline = Date.now() + 10 * 60_000`; `saidPort`, then
  `ready` on `/health` with what is left. A port of `0`: SIGTERM to the engine's group (`process.kill(-pid, 'SIGTERM')`,
  as the load-failure path does) and `AppStartError('Update llama.cpp to build 4240 or newer, then try again.')`. Null
  or not ready: the group's SIGTERM and `AppStartError('llama.cpp could not load the model. Try again.')`, as now.
- The returned `port` is the one the engine said.
- The comment at `start` says why: a port picked here and freed for the engine could be taken before the engine bound
  it, and the engine then failed or this talked to whoever held the port.

- [ ] **Step 5: Run the checks**

```bash
cd cli
npx vitest run src/lib/appModels.spec.ts src/lib/localModels.spec.ts src/services/models.spec.ts   # all pass; appModels 18
npm run typecheck                                                                                  # clean
ps -A -ww -o pid=,command= | grep -F fake-engine- | grep -v grep                                   # prints nothing
```

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/appModels.ts
git commit -m "models: Ollama and llama.cpp pick their own port, read from their log"
```

---

### Task 2: The Grid probe checks who answers

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/src/lib/localModels.spec.ts` (the default `request`, `:92-98`; new cases in
  `describe('stepping down to the context that actually runs')`, before `:1513`)
- Modify: `cli/src/lib/localModels.ts` (`freePort`'s comment `:73`; `probeEngine` `:646-678`; its call `:1202`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing another task uses. `probeEngine` is private.

- [ ] **Step 1: The suite's engine answers `/v1/models`, and the failing tests**

In `beforeEach`'s `request`, after the catalog branch:

```ts
// The engine on this machine, as Grid starts it: llama-server --alias <the first --advertise-as, else the --serve value>.
if (String(url).includes('127.0.0.1') && String(url).endsWith('/v1/models')) {
  const join = calls.findLast(args => args.includes('join')) ?? []
  const advertised = join.indexOf('--advertise-as')
  return response({ object: 'list', data: [{ id: join[advertised >= 0 ? advertised + 1 : join.indexOf('--serve') + 1] }] })
}
```

New cases:

```ts
// Grid starts its engine on another port, without saying, when the one it was asked for is taken (grid 0.3.43,
// remote/serve.py). Whatever answers on the port Harness picked may then be another process: it is never read as the engine.
it.each([
  ['lists another model', () => response({ object: 'list', data: [{ id: 'someone-elses-model' }] })],
  ['lists the model as the grid shows it, not as it was started', () => response({ object: 'list', data: [{ id: 'small-q4' }] })],
  ['answers /v1/models with something that is not JSON', () => new Response('<html>busy</html>')],
  ['does not answer /v1/models', () => { throw new Error('socket closed') }],
])('leaves the judgement to the relay check when whatever holds the port %s', async (_case, models) => {
  catalogCards[0].fit.ctx = 262144
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url, init) => {
    if (!String(url).includes('127.0.0.1')) return original(url, init)
    if (String(url).endsWith('/health')) return new Response('{"status":"ok"}')
    if (String(url).endsWith('/v1/models')) return models()
    // Read as the engine's, this answer stepped the window down to the floor and then said the computer had no memory.
    return new Response(JSON.stringify({ error: { code: 500, message: 'Compute error.', type: 'server_error' } }), { status: 500 })
  })
  await service.act('home', 'org/Small-GGUF', 'start'); await service.settled()
  expect(joinedAt()).toEqual([262144])
  expect(calls.some(args => args.includes('leave'))).toBe(false)
  expect(request.mock.calls.some(([url]) => String(url).includes('127.0.0.1') && String(url).endsWith('/chat/completions'))).toBe(false)
  expect(request.mock.calls.some(([url]) => String(url).includes(RELAY_CHAT))).toBe(true)
  expect((await service.list('home', true)).models[0].operation?.phase).toBe('done')
})

it('knows its engine by the first name it was started under, where it has names of its own', async () => {
  catalogCards = []; serving = true
  await writeFile(join(home, 'models', 'Small-Q4.gguf'), Buffer.alloc(64))
  await writeFile(join(records, 'remote.json'), JSON.stringify({ node_id: 'local-node',
    engines: [{ models: ['Small-Q4.gguf'] }], advertise_as: ['team/my-model', 'team/second'] }))
  await writeFile(join(records, 'remote.heartbeat'), '')
  const id = (await service.list('home')).models[0].id
  await service.act('home', id, 'stop'); await service.settled()
  trainedWindow = 262144
  gpuHolds(131072)
  const fresh = modelFixture({ stateDir, processEnv: { GRID_HOME: home }, run, request: request as typeof fetch, inventory })
  await fresh.act('home', id, 'start'); await fresh.settled()
  expect(calls.findLast(args => args.includes('join'))).toEqual(expect.arrayContaining(['--advertise-as', 'team/my-model', 'team/second']))
  // Judged as its own: the engine's out of memory stepped it down.
  expect(joinedAt()).toEqual([262144, 131072])
})
```

- [ ] **Step 2: Run them to see them fail**

```bash
cd cli && npx vitest run src/lib/localModels.spec.ts
```

Expected: `4 failed | 239 passed (243)`: each of the four rows with
`expected [ 262144, 131072, 65536 ] to deeply equal [ 262144 ]`. The alias case passes before and after (today
nothing asks who answers); it fails if the change compares with the file's name instead.
Commit the spec alone: `models: specs that a foreign answer on the engine's port is never read as the engine (red)`.

- [ ] **Step 3: `probeEngine(port: number, served: string)`**

After `/health` answers 200 and before the completion: `GET ${base}/v1/models` (`AbortSignal.timeout(5_000)`,
`redirect: 'error'`); the engine is this one when `rows(obj(body).data)` has a row whose `id === served`. Any other
answer, a body that is not JSON, or a failed request returns `'unknown'`. The call passes
`candidate.aliases?.[0] ?? candidate.file`. The method's comment gains the reason (the comment above the new cases, in
the method's words), and `freePort`'s comment says it is the port Grid is asked for, which Grid may not use.

- [ ] **Step 4: Run the checks**

```bash
cd cli
npm run test:local-models      # 277 passed; Statements, Branches, Functions, Lines 100%
npm run typecheck              # clean
```

- [ ] **Step 5: Commit**

```bash
git add cli/src/lib/localModels.ts
git commit -m "models: the engine probe checks who answers before it reads the answer"
```

---

### Task 3: The connectors bridge says which port it bound

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/src/services/connectors.spec.ts` (import `:11`; `freePort` `:60-66`; its uses `:505`, `:524`, `:565`,
  `:641`, `:658`; one new case before `:612`)
- Modify: `cli/src/services/connectors.ts` (`ConnectorsOverrides` `:154-163`; after `bridge.unref()` `:186`)
- Modify: `cli/src/cloud/bridge.socket.spec.ts` (`:197-201`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ConnectorsOverrides.listening?: (port: number) => void`, called with the port the main bridge bound each
  time it starts listening (its first listen, and again after a move). Used by the two specs here only.

- [ ] **Step 1: Write the failing test**

`connectors.spec.ts`, before `'waits for its port while another process holds it'`:

```ts
it('says which port its bridge bound, to a spec that asked for any', async () => {
  const said: number[] = []
  startConnectors(fakeCore(), emptyPorts(), { vault: new Store(join(home, 'store'), env), env, port: 0, offered: async () => ({}),
    listening: (port) => { said.push(port) } })
  await vi.waitFor(() => expect(said).toHaveLength(1))
  expect(said[0]).toBeGreaterThan(0)
  // The bridge answers there (refused, with no key).
  expect(await answered(`http://127.0.0.1:${said[0]}/x/linear/mcp`)).toBe(404)
})
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd cli && npx vitest run src/services/connectors.spec.ts -t "says which port its bridge bound"
```

Expected: 1 failed, `expected [] to have a length of 1` (no seam yet). Commit the spec alone:
`connectors: a spec that the bridge says which port it bound (red)`.

- [ ] **Step 3: The seam, and the specs on it**

`connectors.ts`: the field on `ConnectorsOverrides`, with its comment (a spec's way to the port the bridge bound when
it asked for any; production passes none), and after `bridge.unref()`:
`bridge.on('listening', () => overrides.listening?.((bridge.address() as AddressInfo).port))`.

`connectors.spec.ts`: delete `freePort`; import `type ConnectorsOverrides`; add

```ts
/** The service started on a port of its bridge's own choosing, and that port once the bridge listens on it. */
const startedOnAnyPort = (overrides: ConnectorsOverrides): Promise<number> =>
  new Promise(listening => { startConnectors(fakeCore(), emptyPorts(), { ...overrides, port: 0, listening }) })
```

At `:505`, `:524`, `:565` and `:641`, `const port = await startedOnAnyPort({ …the same overrides, without port… })`
replaces the `freePort()` and the `startConnectors` call (at `:641` inside the `try`). At `:658` the port is never
dialled: `port: 0`.

`bridge.socket.spec.ts:197-201`: the closed listener and the start become one line,
`const port = await new Promise<number>(listening => { startConnectors(fakeCore(), emptyPorts(), { vault, env, port: 0, offered: async () => ({}), retryMs: 60_000, listening }) })`.

- [ ] **Step 4: Run the checks**

```bash
cd cli
npx vitest run --config vitest.core.config.ts src/services/connectors.spec.ts --coverage.include=src/services/connectors.ts   # 32 passed, 100% in all four
npx vitest run src/cloud/bridge.socket.spec.ts                                                                                # 16 passed
npm run typecheck                                                                                                             # clean
grep -n "freePort" src/services/connectors.spec.ts src/cloud/bridge.socket.spec.ts                                            # prints nothing
```

- [ ] **Step 5: Commit**

```bash
git add cli/src/services/connectors.ts cli/src/services/connectors.spec.ts cli/src/cloud/bridge.socket.spec.ts
git commit -m "connectors: specs take the port the bridge bound, not one freed a moment ago"
```

---

### Task 4: The Cursor end-to-end test reaches the daemon where it bound

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/src/engines/cursor/localE2e.spec.ts` (imports `:1-13`; `freePort` `:45-54`; the test `:128`, `:147`,
  `:169`, `:185`, `:214`, the `finally` `:311`)

**Interfaces:**
- Consumes: `readDaemonRecord(dataDir, configuredPort)` from `../../lib/daemonRecord.js` (exists; no daemon change).
- Produces: nothing.

Every run in this task is isolated, since the spec by itself uses the person's `~/.cursor` and default tmux server:

```bash
RUN="$(mktemp -d /tmp/ppr-cursor.XXXXXX)" && mkdir -p "$RUN/tmux"
cd cli && env -u TMUX -u TMUX_PANE HOME="$RUN" TMUX_TMPDIR="$RUN/tmux" NO_OPEN_BROWSER=1 RUN_CURSOR_E2E=1 \
  npx vitest run src/engines/cursor/localE2e.spec.ts
```

It needs Cursor's `agent` and `tmux` on PATH (both are on this Mac; `agent --version` answers under a throwaway
`HOME`). There Cursor is signed out, so this run can show the port handling and nothing after it. Remove `$RUN` by its
exact name afterwards. On a machine without `agent`, the task records "not run: no Cursor CLI here" and still commits.

- [ ] **Step 1: The configured port is held (the race, made certain)**

`heldPort()` replaces `freePort()`:

```ts
/** A loopback port held for the whole test, which hangs up on whoever dials it. The daemon is configured with it, so
 *  it must move to a port of its own and say which in `daemon-<configured>.json` (lib/daemonRecord.ts). */
async function heldPort(): Promise<{ port: number; release: () => Promise<void> }>
```

Its listener is `createServer((socket) => socket.destroy())` on `127.0.0.1`, port 0, and stays open until `release()`.

In the test: `const held = await heldPort()` and `const hookPort = held.port` in place of `await freePort()`;
`await held.release()` in the `finally`. Nothing else yet.

- [ ] **Step 2: Run it to see it fail**

The command above. Expected, after about 30 s: 1 failed, `timed out waiting for adapter health; latest=false` (the
health call reached the holder; the adapter log in the failure says
`control port <n> unavailable; assigning a separate port for this user`). Commit the spec alone:
`cursor e2e: the configured port is held, so the daemon must move (red)`.

- [ ] **Step 3: The bound port comes from the daemon's record**

- `const configured = held.port`, passed as `PORT: String(configured)`.
- Right after the daemon is spawned and its output is collected:

```ts
// The daemon moved off its configured port and wrote the one it bound, once bound (lib/daemonRecord.ts).
const hookPort = (await waitUntil('the port the daemon bound, in its record',
  () => readDaemonRecord(dataDir, configured)?.port ?? null, (port) => port !== null))!
expect(hookPort).not.toBe(configured)
```

- The health and status calls use `hookPort`, as they are written today.
- `await installTemporaryCursorHooks(hookPort, dataDir)` moves from before the daemon's start to right after the
  `adapter health` wait: the port the hooks carry is known only then. It stays before the `tmux new-session`.

- [ ] **Step 4: Run the checks**

The command above, then `npm run typecheck` (clean). Expected with a signed-out Cursor: the run gets past
`the port the daemon bound, in its record`, `adapter health` and `adapter backend websocket`, and stops at a later
wait that needs Cursor signed in (`Cursor agent_synced frame` or the one after). Report the label it stopped at; a
stop at any of the three earlier labels is a failure of this task. The full pass is Verification check 6.

- [ ] **Step 5: Commit**

```bash
git add cli/src/engines/cursor/localE2e.spec.ts
git commit -m "cursor e2e: reach the daemon on the port its record names"
```

---

### Task 5: The rate counter test's own Redis listens on a socket

**Depends on:** nothing. **Effort:** medium.

**Files:**
- Modify: `backend/src/lib/redisRateCounter.test.ts`

**Interfaces:** none.

First, once: `cd backend && npm ci --no-audit --no-fund`. Every run here unsets CI's variable, so the test starts its
own server: `env -u REDIS_TEST_URL npm test -- src/lib/redisRateCounter.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it('reaches a redis-server of its own over a socket in its folder, which listens on no TCP port', async () => {
  // CI's Redis service is reached by its URL, and nothing of this test's own is started. Not skipped there:
  // scripts/redis-tests-ran.mjs fails the job on a test of this file that did not run.
  if (url) return
  expect(await redis.config('GET', 'port')).toEqual(['port', '0'])
  expect(await redis.config('GET', 'unixsocket')).toEqual(['unixsocket', expect.stringMatching(/^\/tmp\/rrc-[^/]+\/redis\.sock$/)])
})
```

- [ ] **Step 2: Run it to see it fail**

Expected: `1 failed | 2 passed (3)`; the new case fails on `port` (a five-digit port, not `0`). Commit the test alone:
`backend: a spec that the rate counter's own redis-server has no TCP port (red)`.

- [ ] **Step 3: A socket in a folder of the run's own**

In `beforeAll`, in place of the closed listener: `folder = mkdtempSync(join('/tmp', 'rrc-'))` (short: a socket's path
has a limit an agent's TMPDIR can pass, as `bridge.socket.spec.ts:26` does), `socket = join(folder, 'redis.sock')`,
`spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })`
and `new Redis({ path: socket, lazyConnect: true, retryStrategy: () => 50 })`. The connect loop stays. `afterAll`
removes `folder` after `server?.kill()`. The `node:net` import goes; `mkdtempSync`, `rmSync` and `join` come in. The
file's header comment says its own server has no TCP port and why.

- [ ] **Step 4: Run the checks**

```bash
cd backend
env -u REDIS_TEST_URL npm test -- src/lib/redisRateCounter.test.ts     # 3 passed
npx tsc --noEmit                                                       # clean
ls -d /tmp/rrc-* 2>/dev/null; ps -A -ww -o pid=,command= | grep -F /tmp/rrc- | grep -v grep   # both print nothing
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/redisRateCounter.test.ts
git commit -m "backend: the rate counter test's redis-server listens on a socket in its own folder"
```

---

### Task 6: The cable spec's refused lane is port 1

**Depends on:** nothing. **Effort:** medium. One commit, no red test: the fixture has no behavior of its own.

**Files:**
- Modify: `cli/src/cable/cableHost.spec.ts` (`:1781-1788`)

**Interfaces:** none.

- [ ] **Step 1: Force the race by hand with today's fixture, and keep the output**

Not committed. After `probe.close(...)` (`:1785`), another listener takes the freed port:

```ts
const taker = new WebSocketServer({ port, host: '127.0.0.1' })
await new Promise<void>((resolve) => taker.once('listening', () => resolve()))
stops.push(() => new Promise<void>((resolve) => { for (const client of taker.clients) client.terminate(); taker.close(() => resolve()) }))
```

```bash
cd cli && npx vitest run src/cable/cableHost.spec.ts -t "runs one backoff over the real lane"
```

Expected: 1 failed, `AssertionError: expected 1 to be greater than or equal to 2` (the dial was accepted, not
refused). Keep the output for the pull request, then `git checkout -- src/cable/cableHost.spec.ts`.

- [ ] **Step 2: Port 1**

The four `probe` lines go; `backendWsBase: 'ws://127.0.0.1:1'`. The comment says why: an unprivileged process cannot
listen on port 1, so the dial is refused at once, where a port freed a moment ago could be taken by another listener.

- [ ] **Step 3: Run it, and commit**

```bash
cd cli && npx vitest run src/cable/cableHost.spec.ts        # 107 passed
git add cli/src/cable/cableHost.spec.ts
git commit -m "cable: the refused lane dials port 1, not a port freed a moment ago"
```

---

### Task 7: The grid-reads spec's refused relay is port 1

**Depends on:** nothing. **Effort:** medium. One commit, no red test: the fixture has no behavior of its own.

**Files:**
- Modify: `cli/src/lib/gridReads.spec.ts` (`:178-181`)

**Interfaces:** none.

- [ ] **Step 1: Force the race by hand with today's fixture, and keep the output**

Not committed. After `closed.close(...)` (`:181`), another listener takes the freed port and answers as a grid:

```ts
const taker = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ nodes: [], models: [] })) })
await new Promise<void>((resolve) => taker.listen(Number(new URL(refused).port), '127.0.0.1', resolve))
```

```bash
cd cli && npx vitest run src/lib/gridReads.spec.ts -t "a refused connection reads"
```

Expected: 1 failed, the section's `state` is `"awake"` where `"unknown"` is expected. Keep the output for the pull
request, then `git checkout -- src/lib/gridReads.spec.ts`.

- [ ] **Step 2: Port 1**

The four `closed` lines become `const refused = 'http://127.0.0.1:1'`, with the reason in a comment: nothing can be
listening there, and Node's `fetch` refuses the port before it dials, so the read fails at once every time.

- [ ] **Step 3: Run it, and commit**

```bash
cd cli && npx vitest run src/lib/gridReads.spec.ts          # 40 passed
git add cli/src/lib/gridReads.spec.ts
git commit -m "grid reads: the refused relay is port 1, not a port freed a moment ago"
```

---

## Verification

On the final head, after the review. Nothing here signs in to Harness, reaches a backend or production, or touches the
daemon on 18473. The engines run under a throwaway `HOME` with models of their own, on ports they pick: never the
person's Ollama (11434), `~/.ollama` or models. A real `grid join --serve` is not run: Grid has no local or disposable
backend, only its production control plane; Task 2's cases and check 1's `/v1/models` line stand for it. Only check 6
needs Ken himself.

Local, on this Mac (macOS arm64):

1. **`appModels` against the real Ollama and llama.cpp.** `/usr/local/bin/ollama` 0.32.6 and
   `/opt/homebrew/bin/llama-server` 9550, with the 1.2 MB model llama.cpp's own tests use.

   ```bash
   RUN="$(mktemp -d /tmp/ppr-engines.XXXXXX)" && mkdir -p "$RUN/gguf" "$RUN/scripts" "$RUN/home"
   curl -sL -o "$RUN/gguf/stories260K.gguf" https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf
   shasum -a 256 "$RUN/gguf/stories260K.gguf"   # 270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d
   ```

   `$RUN/scripts/real-engines.mts`:

   ```ts
   import { execFileSync } from 'node:child_process'
   import { readdirSync, readFileSync } from 'node:fs'
   import { join } from 'node:path'

   const [checkout, run, gguf] = process.argv.slice(2)
   const { appEngineOps } = await import(join(checkout, 'cli/src/lib/appModels.ts'))
   const ops = appEngineOps({ ...process.env, HOME: join(run, 'home'), OLLAMA_MODELS: join(run, 'ollama-models') })
   const logs = join(run, 'logs')
   const models = [
     { id: 'app:ollama:probe:latest', name: 'probe:latest', app: 'ollama', engine: 'ollama', ref: 'probe:latest', binary: '/usr/local/bin/ollama', sizeBytes: 1 },
     { id: 'app:llama.cpp:stories260K.gguf', name: 'stories260K', app: 'llama.cpp', engine: 'llama.cpp', ref: gguf, binary: '/opt/homebrew/bin/llama-server', sizeBytes: 1 },
   ]
   for (const model of models) {
     const record = { spec: 1, modelId: model.id, grid: 'verify', name: model.name, ...await ops.start(model, 2048, logs) }
     try {
       const base = `http://127.0.0.1:${record.port}`
       const listener = execFileSync('lsof', ['-nP', `-iTCP:${record.port}`, '-sTCP:LISTEN', '-t']).toString().trim()
       const health = (await fetch(base + (model.engine === 'ollama' ? '/api/version' : '/health'))).status
       console.log(`${model.engine}: record port ${record.port} pid ${record.pid} | listening pid ${listener} | health ${health} | alive ${await ops.alive(record)}`)
       if (model.engine === 'llama.cpp') {
         const listed = await (await fetch(`${base}/v1/models`)).json()
         console.log(`  /v1/models ids ${JSON.stringify(listed.data.map((m) => m.id))} | n_ctx ${await ops.loadedContext(record)}`)
       }
     } finally {
       await ops.stop(record)
       console.log(`  stopped: alive ${await ops.alive(record)}`)
     }
   }
   for (const name of readdirSync(logs)) console.log(name, '|', readFileSync(join(logs, name), 'utf8').split('\n').find((line) => /Listening on|server is listening on/.test(line))?.trim())
   ```

   ```bash
   cd cli && npx tsx "$RUN/scripts/real-engines.mts" "$(git rev-parse --show-toplevel)" "$RUN" "$RUN/gguf/stories260K.gguf"
   rm -rf "$RUN"
   ```

   To see, for each engine: `listening pid` equals the record's `pid`; `health 200`; `alive true`, then
   `stopped: alive false`. For llama.cpp: `/v1/models ids ["stories260K"]` (the `--alias`, which is what `probeEngine`
   compares) and `n_ctx 2048`. Last, two files, `llama-stories260K.log` and `ollama-probe%3Alatest.log`, each with
   its engine's line naming the same port as its record. Run `pgrep -fl 'ollama serve|llama-server'` before and
   after: the same output both times (today: nothing), so no engine of this check is left.

2. **The backend test's own server (PR CI never starts one).** After `npm ci --no-audit --no-fund` in `backend/`:

   ```bash
   cd backend && env -u REDIS_TEST_URL npm test -- src/lib/redisRateCounter.test.ts
   ls -d /tmp/rrc-* 2>/dev/null; ps -A -ww -o pid=,command= | grep -F /tmp/rrc- | grep -v grep
   ```

   To see: 3 passed; the two listings print nothing. Linux for this path is not run by anything: the pull request
   lists it as unverified there.

3. **The checks PR CI does not run:** `cli-core` (Task 3 is under `cli/src/services/`) and `cli-local-models`, from a
   clean tree at the final commit.

   ```bash
   python3 scripts/local-checks.py --run
   ```

   To see: `npm run test:core` and `npm run test:local-models` passed, 100% in every file; the printed
   `harness-local-checks` fence goes into the pull request's body. No other local gate matches this plan's paths.

4. **The specs on macOS** (PR CI runs them on Linux):

   ```bash
   cd cli && npx vitest run src/lib/appModels.spec.ts src/lib/localModels.spec.ts src/services/connectors.spec.ts \
     src/cloud/bridge.socket.spec.ts src/cable/cableHost.spec.ts src/lib/gridReads.spec.ts
   ps -A -ww -o pid=,command= | grep -F fake-engine- | grep -v grep
   ```

   To see: 6 files passed (18, 243, 32, 16, 107, 40), none skipped; the listing prints nothing.

On GitHub:

5. **PR CI, not started by hand.** `cli-typecheck` and `cli-tests` (the fake engines on Linux), `backend-desk` (the
   rate counter file against CI's Redis service, where its step `The Redis-backed tests ran` must stay green),
   `backend-integration`, and the checks a `cli/` change selects. To see: `ci/required` green.

Needs Ken himself:

6. **The Cursor end-to-end test, whole** (open question 1; only on his yes, under his own Cursor login, with no other
   Cursor agent in use on this Mac meanwhile).

   ```bash
   T="$(mktemp -d /tmp/ppr-cursor-tmux.XXXXXX)"
   cd cli && env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$T" npm run test:cursor-e2e; rm -rf "$T"
   ```

   To see: 1 passed, in about 4 minutes, and `~/.cursor/hooks.json` byte for byte what it was (`shasum` before and
   after). Without the yes, the pull request says: red shown, green shown up to the first step that needs Cursor
   signed in, full run not run.

**Heavy workflows:** none. `cli-e2e.yml` and `windows.yml` run nothing this branch changes.

**Temporary workflow:** none. No check here is long; checks 1 and 6 need this Mac's engines and sign-in, and check 3
is local by the repo's rule. Proposal, not part of this branch: a step in `backend-desk` that runs
`redisRateCounter.test.ts` once more without `REDIS_TEST_URL`, so the test's own server is exercised on Linux.
