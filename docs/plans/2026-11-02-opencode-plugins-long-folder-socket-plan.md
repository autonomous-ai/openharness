# OpenCode plugins and long data folders stop sending tokens to the port: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CLI's engine plugins (OpenCode, Kilo, Pi, Amp), companions' OpenCode plugins, and any client of a daemon whose data folder is too long for a socket, send nothing to the daemon's or the bridge's TCP port on macOS and Linux.

**Architecture:** One rule for a socket's path, in every client: `<folder>/<name>` when it fits in 96 bytes, else `<home>/.harness/s/<first 16 hex of sha256(folder)>/<name>`, a 0700 folder of this account's. Home, not a temp folder: `/tmp` is shared (audit M1) and `TMPDIR` differs between launchd and a shell, so clients would disagree. The plugins take the socket's path and post through `node:http`, which OpenCode's runtime and Node both have.

**Tech Stack:** TypeScript and Node built-ins in the CLI; plain Node ESM in `notify.mjs` and Store's `localDaemon.mjs`; Dart with `cryptography` in Desktop.

**Spec:** Task #2112 (left open by #2566 and #2576). Audit H1: `docs/security/2026-11-02-team-account-boundary.md`.

## Global Constraints

- No path may send a key, token or request to the port where a socket can be. No fallback to TCP.
- A client checks the socket before sending: this account's, owner only, in a real folder nobody else can write to.
- The default data folder's socket does not move: same path, same behaviour.
- Windows is unchanged.
- Store packages stay free of dependencies, and `localDaemon.mjs` stays identical in every copy.
- No test writes to the real `~/.harness`: a test that makes a long-folder socket sets `HOME`.

## Review Focus

1. A home so long the short path doesn't fit either: the one remaining TCP case, as today, and it says so in the code.
2. `.harness/s` already there, and looser or owned by another account: the daemon tightens or refuses, and clients refuse it.
3. `HOME` differing between the daemon and a client (`env -i`, a guest): the client finds no socket and says the daemon is down; nothing goes to the port.
4. Two data folders at once: different hashes, so neither takes the other's socket.
5. A plugin's answer over 64 KB, or a timeout mid-answer: `null`, as the `fetch` version gave, and the request is cut.

## Design

- Growth: `harness reset` removes this data folder's short folder; otherwise one folder per long data folder.
- Concurrency: one listener per socket, as today (`listenLocalSocket`).
- Read cost: N/A because the rule is a string and one hash, once per lookup.
- Scale: N/A because no client makes more connections than it did.
- Compatibility: an old client on a long folder still uses TCP, and a daemon from #2550 refuses its secret from another account. A new client with an old daemon on a long folder finds no socket and says it is down until the daemon updates.
- Migration + rollback: no data. A rollback returns long folders to TCP.
- Audience: the filesystem enforces it.
- Identity: the OS account; no login is read.
- Failure: a folder that cannot be made or is not private fails the listen, which is logged, and clients say the daemon is down.
- Platforms: macOS and Linux. TUI is unchanged: it never used the port, and on a long folder it still can't connect (in the PR's Still open).

---

### Task 1: The rule, in the CLI

**Files:**
- Modify: `cli/src/lib/localSocket.ts`, `cli/src/lib/localTransport.ts`, `cli/src/lib/connectors/agents.ts`, `cli/src/cli.ts` (reset)
- Test: `cli/src/lib/localSocket.spec.ts`, `cli/src/cloud/bridge.socket.spec.ts`

**Interfaces:**
- Produces: `socketPathIn(folder: string, name: string, home?: string): string | null` in `localSocket.ts`; `unixSocketPath` and `bridgeSocketPath` both use it.

- [ ] **Step 1: Write the failing tests:** `socketPathIn` keeps a short path; a long folder gives `<home>/.harness/s/<16 hex>/daemon-1.sock`, the same each time and different for another folder; a long home gives `null`. `listenLocalSocket` on that path makes a 0700 folder and a 0600 socket, and refuses a folder of the wrong owner or mode it can't tighten.
- [ ] **Step 2: Run:** `npx vitest run src/lib/localSocket.spec.ts`. Expected: FAIL, `socketPathIn` is not defined.
- [ ] **Step 3: Implement** `socketPathIn`; `listenLocalSocket` makes the short folder; `localSocketRoute` uses the rule for recorded ports; reset removes the short folder.
- [ ] **Step 4: Run** the same, plus every spec that named a long folder as TCP, now with a long `HOME`. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: A long folder sends nothing to the port, in every other client

**Files:**
- Modify: `cli/hook/notify.mjs`, `store/tools/local-daemon.mjs` and its four copies, `desktop/lib/ws/local_daemon_transport.dart`
- Test: `store/tools/port-holder.test.mjs`, `cli/e2e/hookclient.e2e.ts` or the hook's own spec, `desktop/test/local_daemon_transport_test.dart`

**Interfaces:**
- Consumes: the rule from Task 1, as a pinned vector: folder `/x` gives hash `sha256('/x')[0..16]`, the same in Node and Dart.

- [ ] **Step 1: Write the failing tests:** each Store client with a long data folder and a listener on the port: it hears nothing, and each works over a fake daemon on the short socket. The hook: nothing on the port, and the post arrives over the short socket. Desktop: the same path as the vector.
- [ ] **Step 2: Run:** `node --test store/tools/port-holder.test.mjs`. Expected: FAIL, the holder hears the credential.
- [ ] **Step 3: Implement** the rule in each.
- [ ] **Step 4: Run** the same and each package's suite. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: The OpenCode plugins post over the socket

**Files:**
- Modify: `companions/src/memory/adapters/opencodeMemoryPlugin.ts`, `opencodeRecallPlugin.ts`, the three `companions/scripts/memory-native-opencode-*-probe.mjs` that embed them
- Test: both adapters' specs

**Interfaces:**
- Produces: `opencodeMemoryPluginSource(socket: string)`, `opencodeRecallPluginSource(socket: string)`.

- [ ] **Step 1: Write the failing tests:** with a listener on a port and a real server on a private socket, each plugin's post arrives on the socket with its token, and the listener hears nothing. A socket that isn't private: no post, `null`. An answer over 64 KB: `null`. An abort: `null`, and the request is cut.
- [ ] **Step 2: Run:** `npx vitest run src/memory/adapters`. Expected: FAIL, the plugin called `fetch` on the port.
- [ ] **Step 3: Implement** one helper in each source, on `node:http` and `node:fs`, loaded by dynamic import.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 4: The CLI's engine plugins post over the socket

**Files:**
- Modify: `cli/src/engines/{opencode,kilo,pi,amp}/contract.ts`, their shared template kit, and their golden fixtures
- Test: a new `cli/src/engines/pluginPosts.spec.ts`

**Interfaces:**
- Consumes: `unixSocketPath` from Task 1.
- Produces: a template argument `socket: string | null`, and one `harnessPost(path, body)` helper in each plugin's source. A plugin's version moves, so a daemon reinstalls it at start.

- [ ] **Step 1: Write the failing test:** each of the four plugins, rendered and run in Node with a listener on the port and a server on a private socket: the session-start and its token arrive on the socket, and the listener hears nothing. With the socket missing or not private: no post, and nothing on the port. With no socket (Windows, or a home too long): the post goes to the port, as today.
- [ ] **Step 2: Run:** `npx vitest run src/engines/pluginPosts.spec.ts`. Expected: FAIL, the listener hears the token.
- [ ] **Step 3: Implement** the helper on `node:http` and `node:fs`, and the argument.
- [ ] **Step 4: Run** the same and the engines' golden specs. Expected: PASS once the goldens are regenerated, with the diff read.
- [ ] **Step 5: Commit.**

## Left open

- No real OpenCode, Kilo, Pi or Amp session has run the new plugin source unless one is installed where the Tester runs.
