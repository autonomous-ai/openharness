# Windows: the connectors bridge off a held port, and over a proven pipe — Implementation Plan

> **For agentic workers:** This plan is implemented by the Engineer task by task, test first (project instructions,
> Engineer role), not by subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, the bridge moves off a port another account holds, and MCP clients (the stdio shim) and Harness's
own route (`cloud/bridge.ts` `bridgeRoute`) reach the bridge over a named pipe that proves itself, never the port.

**Architecture:** `portHolderIsThisAccount` asks Windows who owns the listener (`Get-NetTCPConnection -State Listen`,
owner SID against this account's, as W1's peer check does), so `listen` in `services/connectors.ts` can move. The
bridge also listens on a pipe of its own, `\\.\pipe\harness-<random id>`, new at each start, through
`listenLocalSocket(..., { token })`: every request proves a random token and every answer proves it back
(`lib/windows/pipeAuth.ts`). The pipe, the edge process's pid and the token are written to `bridge-pipe.json` in the
vault's private folder. The shim (`mcpShimSource.ts`, `--pipe <record> <code>`) and `bridgeRoute` read that record for
each request, dial only while the recorded process runs (EPERM is another account's, so no), and take only a proven
answer. Where a pipe exists the keys leave the port as on macOS (`rotateHarnessKey`, `retireBridgeKey`).

**Tech Stack:** TypeScript (cli/), Node `http` over named pipes, Windows PowerShell 5.1 (`Get-NetTCPConnection`,
`Win32_Process.GetOwnerSid`), vitest.

**Spec:** Task #2162 (Scholes), from Reed's security review of PR #2605 (W1); macOS's version: #2558 (stdio shim),
#2550 (credential to the real daemon only). Report: `docs/security/2026-11-02-team-account-windows.md`.

## Global Constraints

- Build on W1's branch (`fix/windows-w1-local-credential-pipe`, PR #2605) until it merges.
- Nothing goes to the bridge's port from a new agent's entry or from Harness's route on Windows; with no live pipe they
  say Harness / Connections is not running.
- Anything but a clear yes from Windows is not "mine" for a listener; a lookup that fails says nothing (null), as today.
- PowerShell inputs go in environment variables, never in the script's text.
- The shim stays Node built-ins only and holds no key; the pipe token is read from the private record per request.
- Swarm code stays out of `cli/src/core`. `src/services/connectors.ts` stays at 100% coverage (`npm run test:core`).
- PR body starts with "Requested by scholes@autonomous.ai through Harness."; two security reviews (Reed, Quinn 2); a real
  Windows workflow run on the final head.

## Review Focus

- A pipe of the recorded name made by another account after the edge process exits: the recorded pid gone or EPERM sends
  nothing; a pid reused by this account's own process sends the request, and the proof refuses the answer.
- An answer without the bridge's proof (a squatter): no byte of it reaches the MCP client or `bridgeRoute`'s caller.
- A record that is a link, not a local pipe name (`\\host\pipe\…`), or holds a short token: not dialled.
- A listener of this account's own (a second daemon, a handover) is still waited out, never moved from.
- An agent still running on the old address keeps working until its key retires (24 h), as on macOS.

---

### Task 1: Windows says who holds the bridge's port

**Files:**
- Modify: `cli/src/lib/peerAccount.ts` (`portHolderIsThisAccount`, new `windowsListenerQuery`)
- Test: `cli/src/lib/peerAccount.spec.ts`, `cli/src/team/windowsBoundary.spec.ts`,
  new `cli/src/lib/windows/bridgePort.windows.real.spec.ts`

**Interfaces:**
- Produces: `windowsListenerQuery(port: number): { script: string; inputs: Record<string, string> }` printing `yes`,
  `no` or `none`; `portHolderIsThisAccount(port, platform = process.platform, run: WindowsPeerRun = runWindowsPeer)`:
  on win32 `yes` → true, `no` → false, `none`, a failure or a timeout → null.

- [ ] **Step 1: Failing tests.** peerAccount.spec: on win32 a run answering `no` is false, `yes` true, `none` null,
  status 1 / null / thrown null; the port is in `inputs.HARNESS_LISTEN_PORT`, not in the script. windowsBoundary.spec
  ("the bridge on Windows"): another account's listener reads false, so the bridge moves. Real spec (Windows only): a
  listener this process opened is `true`; a free port is `null`.
- [ ] **Step 2: Run** `npx vitest run src/lib/peerAccount.spec.ts src/team/windowsBoundary.spec.ts` — FAIL (null on win32).
- [ ] **Step 3: Implement.** Script: listeners on the port (`-State Listen -LocalPort`); none → `none`. Each row's
  process must exist and have started before the row (as `windowsPeerQuery`), else it is not this account's. Any row of
  this account's SID → `yes` (wait, never move from our own), else `no`.
- [ ] **Step 4: Run** — PASS. Commit test first, then code.

### Task 2: The bridge listens on a proven pipe on Windows, and the keys leave the port

**Files:**
- Modify: `cli/src/lib/connectors/bridge.ts` (new `serveBridgePipe`), `cli/src/lib/connectors/agents.ts`
  (`bridgePipeRecord`, `readBridgePipe`, `bridgeLocal`), `cli/src/services/connectors.ts`
- Test: new `cli/src/lib/connectors/bridgePipe.spec.ts`, `cli/src/services/connectors.spec.ts`

**Interfaces:**
- Produces: `serveBridgePipe(vault: Store, path = newPipePath()): Promise<LocalSocketServer>` — serves the bridge's
  socket handler behind `listenLocalSocket(handler, path, { token })` with a fresh 32-byte token, then writes
  `bridge-pipe.json` `{ pipe, pid: process.pid, token: <64 hex> }` under the vault lock.
- `bridgePipeRecord(vault: Store): string` (the record's path).
- `readBridgePipe(vault: Store, runs = ownProcessRuns): PipeTarget | null` — null unless the pipe passes `isPipePath`,
  the pid is a positive integer this account's process runs, and the token is 64 hex.
- `bridgeLocal(vault: Store, platform = process.platform): boolean` — a socket path, or win32.
- `startConnectors(core, overrides & { platform?: NodeJS.Platform })`: on win32 serves the pipe (retrying as the socket
  does) and rotates / retires the keys as where a socket is.

- [ ] **Step 1: Failing tests.** bridgePipe.spec (a Unix socket named `harness-<id>` stands for the pipe): a request
  without the token's auth is 401 and reaches no connection; one with it reaches the MCP server and its answer carries
  the proof; the record names the pipe, this pid and the token; `readBridgePipe` is null for a dead pid, a pid answering
  EPERM, a non-pipe name and a short token. connectors.spec: with `platform: 'win32'` the pipe is served, the record is
  written, and Harness's key is rotated socket-only.
- [ ] **Step 2: Run** — FAIL (no `serveBridgePipe`).
- [ ] **Step 3: Implement** as the Interfaces say.
- [ ] **Step 4: Run**, plus `npm run test:core` for connectors.ts at 100%. Commit test first, then code.

### Task 3: The shim reaches the bridge over the pipe, and agents' entries name it on Windows

**Files:**
- Modify: `cli/src/lib/connectors/mcpShimSource.ts` (`--pipe RECORD CODE`), `cli/src/lib/connectors/agents.ts`
  (`project`, `sync(vault, env, list?, platform?)`)
- Test: `cli/src/lib/connectors/mcpShim.spec.ts` (group "over the pipe")

**Interfaces:**
- Consumes: Task 2's record and `serveBridgePipe`.
- Produces: entries `{ command: managedNodePath(), args: [shim, '--pipe', bridgePipeRecord(vault), code] }` on win32.

- [ ] **Step 1: Failing tests.** Over a served pipe, a holder of the old port hears nothing and tools work; with the
  record's pid dead, or the record a link, the client is told Harness is not running and the pipe hears nothing; a
  squatter answering without the proof gets the request but none of its answer reaches the client (an error does); the
  entry on win32 names the shim and the record, no port and no key.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Per request: lstat the record (a plain file, opened and the same file), parse, check the
  pipe name (`\\.\pipe\harness-<32 hex>` on Windows; a socket named so elsewhere), the pid (`kill 0`; any error is no),
  the token; send `x-harness-auth`, check `x-harness-proof` before relaying.
- [ ] **Step 4: Run** the shim spec whole. Commit test first, then code.

### Task 4: Harness's own route over the pipe

**Files:**
- Modify: `cli/src/cloud/bridge.ts` (`bridgeRoute(vault, platform = process.platform)`), `cli/src/lib/localTransport.ts`
  (new `fetchOverPipe(target: () => PipeTarget | null): typeof fetch`)
- Test: `cli/src/cloud/bridge.socket.spec.ts` (group "on Windows")

- [ ] **Step 1: Failing tests.** On win32 with the pipe served: list, API and MCP calls go over it and a holder of the
  port hears nothing; with no live record it says Connections is not running and sends nothing to the port; an
  unproven answer is refused.
- [ ] **Step 2: Run** — FAIL (win32 goes to the port).
- [ ] **Step 3: Implement**: base `http://connections.invalid/<harnessKey>`, fetch over `readBridgePipe`.
- [ ] **Step 4: Run**. Commit test first, then code.

### Task 5: Report, real Windows check, evidence

- [ ] The report's W1 "Still open" bridge line becomes fixed by this task, stating the false-answers risk before it.
- [ ] Real Windows spec: the bridge on a real pipe answers the shim, and `portHolderIsThisAccount` on a real listener.
  The Windows workflow runs `src/lib/windows`; ask the PM for one run on the final head.
- [ ] Red/green in a PR comment; `npx tsc --noEmit`; affected specs; `npm run test:core`.
