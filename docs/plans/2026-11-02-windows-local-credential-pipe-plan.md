# Windows: the Owner's Local Credential Never Reaches Whoever Holds the Daemon's Port — Implementation Plan

> **How this is worked:** by this project's Engineer, task by task, test first (the failing test committed before its
> code), as the project's instructions say. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close audit W1 (`docs/security/2026-11-02-team-account-windows.md`): on Windows no client sends the daemon's local
credential over loopback TCP, and the daemon counts it over TCP only from a process of its own account.

**Architecture:** Three layers, each closing the hole alone. (1) The daemon asks Windows who owns the calling end of a TCP
connection that carried a valid secret (`lib/peerAccount.ts`), as it already asks `lsof` and `/proc` elsewhere. (2) Engine
hooks post over the daemon's proven pipe (`hook/notify.mjs`), the pipe auth that Desktop and the agent verbs use. (3) The CLI's
fetch helper and its WebSocket clients go over that pipe on Windows, and `localCredentialHeaders` gives TCP nothing there.

**Tech Stack:** TypeScript, Node, Windows PowerShell 5.1 (`Get-NetTCPConnection`, CIM), Vitest.

**Spec:** Task #2095's brief, and W1 of the report above.

## Global Constraints

- macOS and Linux behave exactly as before.
- Never run a test that signs this Mac out of the real CLI; never test against the real daemon, port 18473 or data folder.
- A lookup that fails, times out or is ambiguous answers no: this guards a credential.
- The token never travels: only the pipe auth's HMAC and the daemon's proof.
- `hook/notify.mjs` stays one file with no imports but Node's: Windows copies it alone to `cli\notify.mjs`.
- Two independent security reviews before merge (Quinn 2, Luna).

## Design

- Growth: N/A, nothing stored.
- Concurrency: the peer lookup runs once per TCP connection, after the secret matched, cached on the socket as on macOS.
- Read cost: one PowerShell per TCP connection carrying a valid secret on Windows, about a second: old engine plugins
  until their pane restarts, old CLIs, and every new connection to the connectors bridge (an MCP client can only dial its
  configured HTTP address). New CLI clients and hooks use the pipe and cost nothing. A native lookup in `harness-pty` would
  take this to milliseconds: a follow-up.
- Scale: hooks fire per prompt; after this change they no longer touch TCP, so the lookup does not scale with prompts.
- Compatibility: an old CLI or a loaded plugin with the old `notify.mjs` still sends the credential over TCP; the daemon
  takes it from this account and refuses it from another. A new client with an old daemon (no pipe record) gets "Harness
  is not running" from the pipe-only paths. Every Windows daemon since the native CLI writes its pipe in its record.
- Migration and rollback: none; reverting restores TCP.
- Audience: the daemon enforces it (the peer check), not the client.
- Identity: the account is the process's token SID, never a name.
- Failure: a refused credential is logged once per connection (`[peer] refused a valid secret`); a client with no pipe says
  the daemon is not running.
- Platforms: Windows only; macOS and Linux unchanged.

## Review Focus

- A lookup that says yes for another account: two connections on the same ports (127.0.0.2), a process that exited, a
  PowerShell that printed something else.
- A hook that still reaches TCP on Windows: no record, a dead pid, a record naming something that is not a local pipe.
- An answer taken without the daemon's proof: the hook must drop a reply whose proof is wrong.
- A CLI path still putting the credential on TCP on Windows: every caller of `localCredentialHeaders`.
- An upload over the pipe: a 10 MB multipart body, not a string.

---

### Task 1: The daemon refuses the credential over TCP from another account on Windows

**Files:** Modify `cli/src/lib/peerAccount.ts`; test `cli/src/lib/peerAccount.spec.ts`, `cli/src/team/windowsBoundary.spec.ts`;
create `cli/src/lib/windows/peerAccount.windows.real.spec.ts` (runs on Windows only).

**Interfaces:** Produces `windowsPeerQuery(peerPort, ownPort): { script; inputs }` and
`peerIsThisAccount(socket, platform, run?)`, with `run` the PowerShell runner (async), injected by tests.

- [ ] **Step 1:** Turn the W1 test around: a stranger's socket on Windows reads as not this account. Add: yes only when the
  query printed `yes`; no for `no`, other text, a failure, a timeout, or addresses other than 127.0.0.1 at both ends.
- [ ] **Step 2:** Run; expected FAIL (Windows answers yes today).
- [ ] **Step 3:** Implement the query and the Windows branch.
- [ ] **Step 4:** Run; expected PASS. Red evidence: the old `return Promise.resolve(true)` back.

### Task 2: Hooks post over the daemon's pipe on Windows

**Files:** Modify `cli/hook/notify.mjs` (`hookRoute`, `post`); test `cli/src/hookNotify.spec.ts`.

**Interfaces:**
- Consumes: the record `daemon-<port>.json` (`{ port, pipe, pid }`, `lib/daemonRecord.ts`), the token file `daemon-token`
  (64 hex digits, `lib/windows/pipeAuth.ts`), the auth `x-harness-auth: <nonce>.<HMAC-SHA256(token, 0x01‖nonce)>` with a
  nonce of the pipe's 32-hex id then 32 random hex digits, and the proof `x-harness-proof: HMAC-SHA256(token, 0x00‖nonce)`.
- Produces: in `notify.mjs`, `hookRoute(port)` on Windows returns `{ address: { socketPath: pipe }, token: '', pipe: { token, nonce } }`
  or null; `post` sends the auth and no credential, and takes a reply only with the proof.

- [ ] **Step 1: Write the failing tests** in `hookNotify.spec.ts`, with a preload that sets `process.platform` to `win32` and
  maps a `\\.\pipe\harness-<id>` socket path to a Unix socket of that id (Node on a Mac cannot open a Windows pipe):
  - "posts over the daemon's pipe on Windows, with the pipe auth and no credential": a `listenLocalSocket` server with the
    token gets `/api/hook/session-start`, `isTrustedLocal(req)` is true, no `x-harness-hook-token`; a TCP listener on the
    port gets nothing.
  - "posts nothing on Windows without a live pipe": no record, a record whose pid is not running, a record whose pipe is not
    a local `\\.\pipe\harness-<32 hex>`, no token, a token that is a link: the pipe server and the TCP listener get nothing.
  - "takes no reply on Windows without the daemon's proof": a server answering 200 with a wrong proof and a reply that would
    print context; the hook prints nothing of it.
- [ ] **Step 2: Run** `npx vitest run src/hookNotify.spec.ts -t Windows`. Expected: FAIL (hooks use TCP).
- [ ] **Step 3: Implement** the route and the proof check in `notify.mjs`; the three existing Windows credential tests move
  to the token file (the same refusals of a link).
- [ ] **Step 4: Run** `npx vitest run src/hookNotify.spec.ts`. Expected: PASS.

### Task 3: The CLI never puts the credential on TCP on Windows

**Files:** Modify `cli/src/lib/localCredential.ts`, `lib/localTransport.ts`, `lib/daemonEndpoint.ts` (control calls stop
falling back to TCP on Windows), `lib/newCommand.ts`, `cli.ts`, `remoteCommand.ts`, `devices/client.ts`,
`orchestrator/command.ts`; tests in `lib/localTransport.spec.ts`, `lib/daemonEndpoint.spec.ts`,
`lib/windows/daemonPipe.spec.ts`, `team/localCredential.spec.ts`, `team/windowsBoundary.spec.ts`.

**Interfaces:**
- `localCredentialHeaders(dataDir, platform)`: `{}` on Windows.
- `PipeRequest.body?: string | Buffer`, `PipeRequest.signal?: AbortSignal`.
- `daemonFetch(dataDir, port, base?, platform?, pipe?: (dataDir, port) => Promise<PipeTarget | null>)`: on Windows a request
  to the daemon goes over `pipe` (`daemonPipe` by default), and with none it fails as `fetch` does (`TypeError('fetch failed')`,
  cause `ECONNREFUSED`), never TCP.
- `openLocalWs<S>(dataDir, port, connect: (url, headers) => S, platform?, pipe?: (dataDir, port) => PipeTarget | null): S`:
  elsewhere `connect(localWsTarget(...))`; on Windows `pipeWebSocket(target)`, and with no target it throws the "Harness
  is not running" text. `daemonPipeNow(dataDir, port)` is that sync target: the record, the token, the pid alive (the
  socket's upgrade proof refuses a squatter before anything is sent).

- [ ] **Step 1: Write the failing tests:**
  - `windowsBoundary.spec.ts` "a client never puts the credential on a TCP request on Windows":
    `localCredentialHeaders(data, 'win32')` is `{}`.
  - `localTransport.spec.ts` "on Windows, daemonFetch goes over the pipe": a JSON request and a 10 MB multipart body reach a
    pipe server with the auth, the reply is taken; `base` is never called. "with no pipe it fails as fetch does": rejects
    with a `TypeError`, `base` never called. A request to another address uses `base`.
  - "openLocalWs on Windows opens the pipe and never the port": with a target, a pipe WebSocket (its upgrade carries the
    auth); with none, it throws "not running" and `connect` is never called; elsewhere it calls `connect` with the socket URL.
- [ ] **Step 2: Run** `npx vitest run src/lib/localTransport.spec.ts src/team/windowsBoundary.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and move the four WebSocket clients to `openLocalWs`.
- [ ] **Step 4: Run** the specs of every file changed, then `npm run typecheck` and `npm test`. Expected: PASS.

### Task 4: Pull request

- [ ] Report: W1 marked fixed in `docs/security/2026-11-02-team-account-windows.md`.
- [ ] Pull request with the "Requested by" line, the checklist, red/green evidence, and the one Windows command as a
  release note; two review steps (Quinn 2, Luna).
