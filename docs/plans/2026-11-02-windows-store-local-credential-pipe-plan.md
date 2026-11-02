# Windows: the Store Packages Reach the Daemon over Its Proven Pipe, Never Its Port — Implementation Plan

> **How this is worked:** by this project's Engineer, task by task, test first (the failing test committed before its
> code), as the project's instructions say. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close audit W1 for the Store packages (`docs/security/2026-11-02-team-account-windows.md`): on Windows the machine
monitor, harness monitor, memories, autonomous grid and `store/tools` never send the owner's local credential to the daemon's
TCP port; they reach the daemon over its named pipe with W1's proof.

**Architecture:** Every package already carries one identical file for the daemon's transport, `lib/localDaemon.mjs` (a copy of
`store/tools/local-daemon.mjs`, pinned by `store/tools/port-holder.test.mjs`). It learns the Windows pipe exactly as W1's hook does
(`cli/hook/notify.mjs` `windowsDaemonPipe`): the daemon's record `daemon-<port>.json` names the pipe and the core's pid, the pid must
run, the token file is read under the same link and junction rules, each request carries a fresh `X-Harness-Auth`, and an answer or a
WebSocket open is taken only with the daemon's `X-Harness-Proof`. With no pipe it says Harness is not running and never tries the
port. The five `localCredentialHeaders` give nothing on Windows, and their 401 probe never runs there.

**Tech Stack:** Node ES modules with no dependencies (each package stands alone), `node:test`, GitHub Actions on Windows.

**Spec:** Task #2161's brief; W1 of the report above; PR #2605 (W1), whose pipe auth (`cli/src/lib/windows/pipeAuth.ts`) is the
protocol.

## Global Constraints

- macOS and Linux behave exactly as before (the socket, or TCP only for a home too long to hold one).
- On Windows nothing goes to the TCP port: no credential, no probe, no fallback.
- The token never travels: only `<nonce>.<HMAC-SHA256(token, 0x01‖nonce)>`, the nonce starting with the pipe's id; the answer must
  carry `HMAC-SHA256(token, 0x00‖nonce)`.
- `localDaemon.mjs` stays one file with no imports but Node's, byte-identical in every package and `store/tools`.
- Swarm code stays out of `cli/src/core`.
- Two independent security reviews before merge (Reed, Quinn 2), and a real Windows workflow run on the final head.

## Design

- Growth: N/A, nothing is stored.
- Concurrency: N/A, no shared state; each request reads the record and token once.
- Read cost: two small file reads (record, token) and a `kill(pid, 0)` per request or WebSocket; the packages keep one socket per
  machine, so this is per poll at most, a few per minute.
- Scale: 10x panes is 10x those reads, microseconds each; the first warning would be the daemon's nonce window (4,096), far above.
- Compatibility: a new package with an old daemon that records no pipe says Harness is not running (every native Windows daemon
  records it). An old package on Windows still sends the credential to the port; W1's peer check makes it useless to another
  account, and a Store update replaces the package.
- Migration and rollback: none; reverting restores TCP.
- Audience: the daemon enforces the pipe auth; the client refuses any answer without the proof.
- Identity: the token in this account's data folder, never a name.
- Failure: no pipe, a dead pid, a bad token or an unproven answer each fail the call with a sentence (Harness is not running, or
  something other than Harness answered); nothing falls back silently.
- Platforms: Windows only; macOS and Linux unchanged (their tests pass as they are).

## Review Focus

- A Windows path that still reaches TCP: no record, a record naming a file or `\\host\pipe\…`, a dead pid, no token, a linked token.
- An answer taken without the daemon's proof: a REST body read, or a WebSocket `open` fired, before the proof is checked.
- A 401 probe or credential read that still runs on Windows (`credentialRefused`, `localCredentialHeaders`).
- The record found by the bound port when the URL names the port the daemon was given instead (`daemon-<configured>.json`).
- The copies drifting: one package's `localDaemon.mjs` differing from `store/tools/local-daemon.mjs`.

---

### Task 1: The shared transport reaches the daemon over its pipe on Windows, and never the port

**Files:** Modify `store/tools/local-daemon.mjs` and its four copies `store/agents/{machine-monitor,harness-monitor,memories,autonomous-grid}/lib/localDaemon.mjs`;
test: create `store/tools/windows-pipe.test.mjs`.

**Interfaces:**
- Produces: `daemonPipe(port: number, env = process.env, platform = process.platform): { path: string, headers: { 'X-Harness-Auth': string }, proven(value: unknown): boolean } | null`
  — a fresh one-request route each call; null off Windows or with nothing to dial.
- `DaemonWebSocket` and `daemonFetch` keep their signatures; on Windows they use `daemonPipe`, and with none they fail with
  `HARNESS_NOT_RUNNING` (exported string) without dialling anything.

- [ ] **Step 1: Write the failing tests** in `store/tools/windows-pipe.test.mjs`, with `process.platform` set to `win32`, a TCP
  holder on the URL's port recording all it hears, and a daemon listening at `\\.\pipe\harness-<id>` (a real pipe on Windows; on
  macOS and Linux a socket of that name in the test's working folder) that checks the auth and answers with the proof:
  - `no Windows client sends anything to the port with no pipe`: each package's REST call (`listMachines`), and WebSocket call
    (`listAgents` ×2, `listHarnesses`, `harnessExecute`) fails, and the holder heard nothing.
  - `each package reaches the daemon over its pipe with the proof, and the port hears nothing`: the same calls succeed; every request
    the pipe daemon got carried a valid `x-harness-auth` and no `x-harness-local`; the holder heard nothing.
  - `an answer without the daemon's proof is never taken`: a pipe daemon answering with a wrong proof: REST fails, the WebSocket
    never opens, no frame is sent.
  - `nothing is dialled for a record that is not a live local pipe`: a record naming a file, `\\host\pipe\harness-<id>`, a dead pid;
    a missing token; a token reached through a link.
  - `the record is found by the bound port`: `daemon-18473.json` holding `port: <url port>`.
- [ ] **Step 2: Run** `node --test store/tools/windows-pipe.test.mjs` — expected FAIL: the holder hears the credential (main sends it).
- [ ] **Step 3: Implement** `daemonPipe` in `store/tools/local-daemon.mjs` (the rules of `cli/hook/notify.mjs` `windowsDaemonPipe`
  and `readWindowsStateFile`); `UnixWebSocket` takes `{ headers, proven }` and checks the proof on the upgrade before `open`, and the
  private-socket check only when no proof is given; `daemonFetch` checks the proof before reading the body. Copy the file to the four
  packages.
- [ ] **Step 4: Run** the new test, `store/tools/local-daemon.test.mjs` and `store/tools/port-holder.test.mjs` — expected PASS.
- [ ] **Step 5: Commit.**

### Task 2: The five credential readers give nothing on Windows, and never probe the port

**Files:** Modify `store/agents/machine-monitor/lib/daemon.mjs`, `store/agents/harness-monitor/lib/bridge.mjs`,
`store/agents/memories/lib/bridge.mjs`, `store/agents/autonomous-grid/lib/harness.mjs`, `store/tools/local-credential.mjs`;
tests: each package's `test/credential.test.mjs`, `store/tools/local-credential.test.mjs`.

**Interfaces:**
- Consumes: `daemonPipe`, `HARNESS_NOT_RUNNING` from Task 1.
- Produces: `localCredentialHeaders(env)` returns `{}` on Windows; `credentialRefused` returns false there without a request.
  `store/tools/local-credential.mjs` `daemonBridge(port, env)` on Windows returns
  `{ url: 'ws://localhost/api/local-ws', headers, createConnection, proven }`, and `openDaemonBridge(WebSocket, port?, env?)` opens a
  `ws` WebSocket from it that is terminated on an unproven upgrade; the `dsh-*.mjs` tools use `openDaemonBridge`.

- [ ] **Step 1: Turn around the failing tests:** "on Windows the credential is read whatever mode…" becomes "on Windows no credential
  is read: it never goes to the port", asserting `{}` for a valid credential file; `daemonBridge` on Windows gives the pipe route's
  auth and no `X-Harness-Local`, and throws `HARNESS_NOT_RUNNING` with no pipe.
- [ ] **Step 2: Run** each `credential.test.mjs` and `local-credential.test.mjs` — expected FAIL (the credential is still read).
- [ ] **Step 3: Implement:** `process.platform === 'win32'` returns `{}` before anything is read, and the Windows mode exception goes;
  `credentialRefused` returns false on Windows; `daemonBridge`/`openDaemonBridge` as above; the three `dsh-*.mjs` call it.
- [ ] **Step 4: Run** all store package tests touched — expected PASS.
- [ ] **Step 5: Commit.**

### Task 3: A real Windows run, the README and the report

**Files:** Create `store/tools/windows-ci/store-pipe.mjs`; modify `.github/workflows/windows.yml` (one step in the install job, one in
the specs step), `store/tools/README.md`, `docs/security/2026-11-02-team-account-windows.md` (the W1 line).

- [ ] **Step 1:** `store-pipe.mjs` runs, against the installed daemon, machine monitor `daemonStatus` (REST) and `listHarnesses`,
  harness monitor and memories `listAgents`, over the pipe: it prints each result and
  exits 1 on any failure. The workflow runs it after "Check the install", and runs `store/tools/windows-pipe.test.mjs` natively.
- [ ] **Step 2:** README's "Daemon checks" and the report's W1 row and Fixed list name the Store packages.
- [ ] **Step 3: Commit,** then ask the PM to start the Windows workflow on the final head.
