# Port pick races outside the e2e harness — design

## Problem

Several places pick a loopback port by listening on port 0, close that listener, and then hand the number to
something else that binds it (a child process, or a component under test). Between the close and the bind, any other
process can take the port. The child then fails to bind, or binds somewhere else, while the caller talks to whatever
now holds the port.

The e2e harness has the same race and is fixed separately (`fix/e2e-free-port-race`). This branch covers `cli/src`
and `backend/src`. It does not depend on that branch.

## The places

A search of `cli/src` and `backend/src` for a port read from a closed listener found these:

| Place | What gets the port | Kind |
|---|---|---|
| `cli/src/lib/appModels.ts:156` `freePort` | `ollama serve` (`OLLAMA_HOST`) and `llama-server --port` | product |
| `cli/src/lib/localModels.ts:74` `freePort` | `grid join --serve --endpoint-port` | product |
| `cli/src/dsh/viewer.ts:118` `freeLoopbackPort` | the DSH viewer command (`HARNESS_VIEWER_PORT`) | product (gap, see below) |
| `cli/src/services/connectors.spec.ts:61` `freePort` (5 uses) | `startConnectors({ port })` | test |
| `cli/src/cloud/bridge.socket.spec.ts:199` | `startConnectors({ port })` | test |
| `cli/src/engines/cursor/localE2e.spec.ts:45` `freePort` (opt-in) | the daemon (`PORT`) and the Cursor hooks (`--port`) | test |
| `backend/src/lib/redisRateCounter.test.ts:29` | `redis-server --port` | test |
| `cli/src/cable/cableHost.spec.ts:1784` | a port that must refuse, given to `DeviceLink` | test (same cause) |
| `cli/src/lib/gridReads.spec.ts:180` | a port that must refuse, given to the fake Grid | test (same cause) |

**Not this pattern, left as they are:** `lib/stunSelect.spec.ts:237` (a UDP port taken by someone else only times out,
and the live server still wins, so the test holds), `agentClient/daemon.spec.ts:94` (the closed port only names a
daemon record and is never dialled), `lib/windows/bridgePort.windows.real.spec.ts:17` (a port free once closed is what
it tests), `services/agentBrowser/proxyRelay.spec.ts` (already fixed, #4165). Every other `listen(0)` keeps its listener
open for as long as the port is used.

**The daemon core.** No file under `cli/src/core/` has the pattern. Nothing here changes the core.

## Fix, per place

The rule: the process that binds picks the port (port 0) and says which it got, and the caller uses what it said. Where
the binder cannot do that, the caller checks that whatever answers is the one it started. No retries.

### 1. `appModels.ts`: Ollama and llama.cpp started for an app's model

Both take port 0 and say the port they bound (tried on this Mac: Ollama 0.32.6 logs
`Listening on 127.0.0.1:61906 (version 0.32.6)`; llama.cpp 9550 logs `server is listening on http://127.0.0.1:<port>`).

- `start` passes port 0: `OLLAMA_HOST=127.0.0.1:0` and `llama-server --port 0` (`llamaServerArgs` takes the port to
  pass, so the caller gives it 0).
- The log file name no longer carries the port, which is not known when the file opens. *(Builder's call)* One file per
  engine and model (`ollama-<model>.log`, `llama-<model>.log`, the model's name made safe for a file name), emptied at
  each start: only this run's lines are in it, and the folder stays bounded by the number of models (today's
  `-<port>.log` names grow by one file per start). A model is started once at a time (one record per model), so two
  engines never write one file.
- The wait for the engine reads its log as it grows until the engine's own line names the port, then checks health on
  that port as it does now. It gives up, as now, when the process exits or the deadline passes, with the same
  messages. *(Builder's call)* Only the two lines above are read (Ollama's `Listening on 127.0.0.1:<port>`, llama.cpp's
  `server is listening on http://127.0.0.1:<port>`). Ollama prints its line at once; llama.cpp prints it after the
  model loads, which the wait already allows for.
- Versions (read from their sources): Ollama binds port 0 and logs the bound address (`ln.Addr()`) from v0.1.20 (early
  2024) on, and accepts port 0 in `OLLAMA_HOST` in every version since; there is no Ollama in use too old for this.
  llama.cpp binds a free port for `--port 0` from build b4240 (December 2024); an older build binds one too but logs
  `:0`. The llama.cpp builds Harness meets are far newer (Homebrew 9550 on this Mac, Grid's own 10369). A
  `server is listening` line that names port 0 stops that engine and fails the start at once with:
  "Update llama.cpp to build 4240 or newer, then try again."
- `freePort` is removed from this file.
- Keep the change to `freePort`, `start` and the readiness wait: the `service-child-leaks` branch changes this file's
  `exec` (via `spawnTied`), and whichever merges second rebases.

The recorded `port` (`AppEngineRecord.port`) is the one the engine said, so `alive`, `loadedContext` and `stop` reach
the right process.

### 2. `localModels.ts`: `grid join --serve`

Grid is a separate tool. It treats `--endpoint-port 0` as unset (8081), and when the port it was given is taken it
starts llama-server on another port without telling the caller. So port 0 cannot be passed, and the port Harness picked
may not be the engine's.

- `probeEngine(port)` checks the answer is from this engine before it reads anything into it: after `/health` answers
  200, `/v1/models` must list, in `data[].id`, the name the engine was started under. Grid (0.3.43,
  `remote/serve.py` `_bring_up_one`, `shared/engine/launcher.py`) starts llama-server with `--alias <advertised[0]>`:
  the first `--advertise-as` alias, else the `--serve` value as given (the model file name), and llama-server answers
  `/v1/models` with that alias as the id. So the expected id is `candidate.aliases?.[0] ?? candidate.file`, compared
  exactly. Any other answer, or none, is `unknown`: the relay check that follows judges, as it already does when
  nothing listens. A foreign process on that port can then never make a start pass, fail or step down its window.
- `freePort` stays here: it is still the port Grid is asked for.
- Gap outside this repo: Grid should take `--endpoint-port 0` and report the port its engine bound. Listed in the PR.

### 3. Connectors tests: `connectors.spec.ts`, `cloud/bridge.socket.spec.ts`

The component under test binds the port. `startConnectors` gets a test seam, `listening?: (port: number) => void` on
`ConnectorsOverrides`, called with the port the bridge bound each time it starts listening. The tests pass `port: 0`
and use the port the seam gives. The `freePort` helper in `connectors.spec.ts` and the closed listener in
`bridge.socket.spec.ts` are removed. Production passes no `listening`, and nothing else changes for it.

### 4. `engines/cursor/localE2e.spec.ts` (opt-in, `RUN_CURSOR_E2E=1`)

The daemon already moves to another port when its own is taken and writes the port it bound to
`daemon-<configured>.json` (`lib/daemonRecord.ts`). The test keeps a configured port, reads the bound port with
`readDaemonRecord(dataDir, configured)` once the daemon is up, and uses that port for the health and status calls and
for the Cursor hooks it installs, which it now installs after the daemon is up. No daemon change.

### 5. `backend/src/lib/redisRateCounter.test.ts`

The local `redis-server` listens on a Unix socket in the test's temp folder (`--port 0 --unixsocket <path>`; port 0 is
Redis's "no TCP"), and the client connects by that path. No port is picked.

### 6. Refusing ports: `cable/cableHost.spec.ts:1784`, `lib/gridReads.spec.ts:180`

Both want a port that refuses at once, and take one freed a moment ago, which another listen can take. They use port 1
instead, as `authCommand.spec.ts` and this file's own earlier test already do: an unprivileged process cannot listen
there, so it refuses (in `gridReads.spec.ts` Node's `fetch` refuses port 1 itself as a bad port, which lands in the
same failure path as a refused connection). Neither spec runs on Windows: `windows.yml` runs a fixed list of CLI specs, and these two (and
`authCommand.spec.ts`) are not in it; on macOS and Linux a closed loopback port is refused at once.

### Gap: the DSH viewer (`dsh/viewer.ts`)

`HARNESS_VIEWER_PORT` is the public viewer contract (`store/spec`, `store/README.md`, about ten viewers in `store/`,
several of which refuse port 0). Port 0, or a listening socket handed over, would break every viewer written against it.
This branch does not change it. Today, when another process takes the port first, the viewer fails to bind and exits,
and the manager starts it again on a fresh port; the pane can show the wrong page until that exit. Listed as a gap in
the PR; changing the contract is its own decision.

## Tests

Each place gets a test at its own layer that fails before its change:

- `appModels.spec.ts`: a fake engine binary (a small Node script) that binds the port it is given and prints the
  engine's own listening line. `start` must pass port 0 and return the port the fake printed; it fails today (a
  non-zero port is passed). One case each for Ollama and llama.cpp, and one where the engine exits before naming a port.
- `localModels.spec.ts`: a join whose port answers `/health` 200 with another model's `/v1/models` makes the probe
  `unknown` (no step-down, no out-of-memory), where today it reads that process's answers as the engine's.
- `connectors.spec.ts`: with `port: 0`, `listening` gives the port the bridge answers on (fails today: no seam).
- `localE2e.spec.ts`: the test holds the configured port before the daemon starts, so the daemon must move; the test
  must still reach it. Red today (the health call reaches the holder). It is opt-in: run where Cursor's CLI is signed
  in, or recorded as not run.
- `redisRateCounter.test.ts`: the client is connected over the socket path (fails today: TCP).
- `cableHost.spec.ts`, `gridReads.spec.ts`: a change to a test's own fixture with no behavior of its own; the red step is
  the race forced by hand (another listener takes the freed port before the dial) and shown failing with the old
  fixture in the PR.

## Platforms

- `appModels.ts`, `localModels.ts`: macOS and Linux (they start POSIX process groups today); the fake engine runs on
  both.
- Connectors, cable and Grid-read tests: macOS and Linux CI. None of the changed specs is in `windows.yml`'s list.
- Backend test: CI uses its Redis service (`REDIS_TEST_URL`) and never starts its own server, so the changed path runs
  locally on macOS and Linux where `redis-server` is installed; it skips where neither is, as now.
