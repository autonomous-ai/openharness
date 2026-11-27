# Small fixes, 2026-11-28: implementation plan

> **For agentic workers:** REQUIRED: devcrew phase 3 runs this plan task by task. Each task with a test: a red commit
> (the failing test alone), then the code commit. A task with no failing test is one commit. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Seven small fixes in one pull request: a Codex session its daemon serves has its client's app (or its
multiplexer) as its host, through every later hook; a served Codex in tmux or herdr inside an app is on that app's page,
nested, at its pane; the deviceStopLook and deviceNotify unplug waits stop racing the fleet's scan; local requests are
not kept alive (no EPIPE on a reused connection); `pair` and `remote-password set` answer a word and an errno code; every
delete of `harness reset` retries a briefly held file and none is swallowed; a Claude SessionStart whose transcript is
not on disk yet is admitted when its path has the shape the core derives under its own Claude roots.

**Architecture:** Each item stays in the module that owns it: the observed source (`cli/src/cable/hosts/observed.ts`) and
the served lookup (`cable/hosts/codexServed.ts`, wired in `services/devices.ts`); the e2e desk (`cli/e2e/harness/desk.ts`);
the local transport (`lib/localTransport.ts`); the gateway's key routes (`gateway/keyRoutes.ts`); one held-delete helper in
`lib/deleteSecretFile.ts` used by `cli.ts clearAdapterState`; the transcript admission (`engines/transcriptBindings.ts`,
`lib/registry.ts`). Files of the core's process that change, as bug fixes: `lib/deleteSecretFile.ts`,
`engines/transcriptBindings.ts`, `lib/registry.ts` (all three already lines of `cli/src/architecture.coreFiles.txt`); the
only new import among them is `hostPlatform` from `engines/kit/windowsFiles.ts`, already a core file. So
`architecture.coreFiles.txt` does not change and `cli/src/core/` does not change. Not in the core's process:
`observed.ts`, `codexServed.ts`, `localTransport.ts`, `keyRoutes.ts`, `cli.ts`, `cli/e2e/`; `services/devices.ts` is a
service, under `test:core`'s 100%.

**Tech Stack:** TypeScript (Node 22/24), Vitest, `node:http` over a Unix socket or Windows named pipe, the e2e harness
(`IsolatedDaemon`, `Desk`, `FakeDial`).

**Spec:** [docs/plans/2026-11-28-small-fixes-1128-design.md](2026-11-28-small-fixes-1128-design.md)

## Global Constraints

- One pull request for items 1-7. Nothing of Zellij: a served Codex in Zellij keeps today's place (its own item).
- Platforms: macOS, Linux, Windows. Windows is proven by the PR's own CI (`windows-e2e`, by path); the Windows VM or the
  Dell only after the orchestrator hands one out. No CI rerun but a recorded flaky test's; no `workflow_dispatch` unless
  the orchestrator hands out the turn; no new workflow, not even a temporary one.
- Item 7's four rules, each with its own refusal test (orchestrator's conditions):
  1. the name is `<sessionId>.jsonl`, the hook's session id checked against the UUID form before any name is built
     from it (no `/`, `..` or other characters);
  2. the parent folder is exactly one segment under a Claude root the core already holds (`scope.directories` of
     `transcriptRootEvidence`), compared by file identity (dev and inode: the realpath, case-blind on Windows);
  3. the parent, when present, is a real folder by `lstat`, owned by this user; a symlink or a junction at the parent or
     at the file is refused;
  4. the file is a proven absent leaf.
  When the file appears it is read through today's checks, never trusted because its path was admitted. On Windows a
  name compares case-insensitively, as folders already do by identity. Any other missing reported path stays held (#1137).
- The retry stays `deleteSecretFile`'s: EBUSY and EPERM (and ENOTEMPTY for a recursive delete), 3 tries, 400 ms apart.
  The devices listener's 2 s close and `MAX_CLIENTS` (16) do not change.
- Never an error's message, a path or a session id in an answer or a log line: `PAIR_FAILED (<code>)`,
  `REMOTE_PASSWORD_NOT_SET (<code>)`, `STATE_NOT_DELETED (<code>)`, `[gateway] POST KEY_ROUTE_FAILED · <errorKind>`.
- Tests: red first, at the layer where the behavior lives; no fixed sleeps (a deliberate hold of the loop with
  `Atomics.wait` is a repro, not a wait); never the developer's own `~/.claude`, `~/.codex`, daemon (18473), tmux or
  processes.
- Comments say why and name the incident: the tester's 20/20 `alert · rule:turn` (item 2), this Mac's
  `SessionStart held · IdentityReadUnavailable` until the first prompt (item 7), #4675 (item 5), #2605 (item 4).
- The PR body says why the core changed (item 6: a held file failed reset at once; item 7: a new pane's bind held until
  its first prompt), carries item 4's measured cost (task 5), and the receipts of `test:core` and `test:portability`.
- Copy short. Docs in English.

## Review Focus

1. A streamed answer over the socket (the devices' `streamDevices`, the VS Code stream) once requests are not kept
   alive: its chunks still arrive before its end, on a connection of its own (task 5 tests it).
2. A Claude hook after `/clear` or a `cd`, whose `cwd` is not the project's folder, and a long folder name Claude
   truncated: admitted by shape; the folder's name is never compared with `cwd` (task 10 tests both).
3. An error whose `code` is not an errno code (a path, words): answered and logged as `UNKNOWN` or its kind, never its
   text (task 6 tests it).
4. Two Codex TUIs in the session's folder, one in tmux inside Ghostty and one in Terminal, or both in tmux with no app:
   no by-process lookup is asked, the answer stays `{}` (task 2 tests both).
5. A Claude project folder owned by another account, a regular file at its name, or a Claude root not on disk yet:
   refused, so held as today (task 9 tests each).

---

## Items 1-2: a Codex session its own daemon serves

`observed.ts` and `observed.spec.ts` are shared by tasks 1 and 3: they run in that order. Line numbers are on e000b662a9.

### Task 1: its host is its client's app, through every later hook

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`askServed` ~1251-1292, `placeServed` ~1312-1320)
- Test: `cli/src/cable/hosts/observed.spec.ts` (describe "ObservedSource and a Codex session its own server runs")

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces: `placeServed(entry, served)` sets `entry.agent.host = served.client?.app ?? UNKNOWN_APP` (task 3 puts the
  nest first). In `askServed`, `delete a.nest` and `a.host = detectHost(entry.hints)` move below
  `if (entry.served!.is) return true`: a daemon already answered (or asked again with its place kept) keeps its host and
  nest; `entry.hints = {}`, `entry.caller` and the other resets stay above it.

- [ ] **Step 1: Write the failing tests:**
  - `its host is its client's app once placed, and stays so through its next hooks`: `served()`, session-start, answer
    `[{ client: CLIENT }]` → `agent().host === 'terminal-app'`; a turn-start (no new ask) → still; a second
    session-start (asked again) → still `terminal-app` before and after its answer.
  - `with no client known its host is terminal`: answer `[{}]` → `host === 'terminal'`, and after a turn-start.
  - in "the scan places a session a Codex server holds by its client, never by the server's parents", add: its host is
    the client's app.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts -t "its own server runs"` — the new
  assertions fail (`terminal`).
- [ ] **Step 3: Implement.** The comment says why: the dial row, the usage counts and the notice's place
  (`services/devices.ts` ~2092, "In Terminal") read the host, which was always `terminal` for a Codex TUI in Ghostty.
- [ ] **Step 4: Run** the whole spec file — all pass. **Step 5: Commit** red, then code.

### Task 2: the served lookup asks the scan's by-process lookup for a TUI in tmux or herdr

**Files:**
- Modify: `cli/src/cable/hosts/codexServed.ts`, `cli/src/services/devices.ts` (`observedSource`: `served:`)
- Test: `cli/src/cable/hosts/codexServed.spec.ts`, `cli/src/services/devices.spec.ts` (its `servedLookup` mock, ~271)

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces:
  - `export interface Served { client?: Outer; clients?: readonly ServedClient[]; nest?: Nest; pane?: Pane }`
    (`Nest` from `./types.js`, `Pane` from `./adapter.js`); `nest` and `pane` come only with a `client`.
  - `CodexServedDeps` gains `madeBy?(pids: readonly number[], rows: readonly ProcessName[]): Promise<ReadonlyMap<number, Omit<Nested, 'pid' | 'rows'>>>`
    and `nested?: NestedLookup` (`outer.ts`), the same as `ObservedDeps`'.
  - `servedLookup(platform: NodeJS.Platform, nesting: Pick<CodexServedDeps, 'madeBy' | 'nested'> = {})`.
- The rule, in `codexServed` after the client apps are read: when exactly one TUI was found for an ask and its walk named
  no app, and both lookups are given: `madeBy([tui], names)`; a maker whose host is `tmux` or `herdr` is asked
  `nested({ ...maker, pid: tui, rows: names })` (no `fresh`: a served ask runs once a start, as the scan's does); a place
  naming an app answers `{ client: { app, tty, pid }, nest: host, pane, clients: [{ pid: tui, generation }] }` (the
  place's tty and pid as the lookup gives them, the generation from the table as the several-TUIs answer has it).
  Anything else, a `madeBy` that rejects included, answers `{}` as today. Several TUIs keep today's answers (#4677).
- `services/devices.ts`: `served: servedLookup(platform, nesting)` (the `nesting` `observedSource` already takes;
  `{}` where the scan learns no app, Windows).

- [ ] **Step 1: Write the failing tests** in `codexServed.spec.ts` (`deps()` gains optional `madeBy` and `nested`
  fakes; `PANE` a tmux pane as tmux's nested lookup gives one):
  - `places a session whose one TUI runs in tmux inside Ghostty at Ghostty, nested in tmux, at its pane`: a tmux server
    `row(30, 1, '/opt/homebrew/bin/tmux', 'tmux')`, its shell `row(31, 30, '-zsh')`, the TUI `row(700, 31, BREW, 'codex')`
    on `ttys010` in `/work/app`, the daemon `row(900, 1, DAEMON_BIN, DAEMON_ARGS)`; `madeBy` names
    `{ host: 'tmux', tty: 'ttys010', maker: 30 }` for 700; `nested` answers
    `{ app: 'ghostty', tty: '/dev/ttys003', pid: 650, pane: PANE }` → `[{ client: { app: 'ghostty', tty: '/dev/ttys003', pid: 650 }, nest: 'tmux', pane: PANE, clients: [{ pid: 700 }] }]`;
    `madeBy` called with `[700]` and the walk's rows, `nested` with `{ host: 'tmux', tty: 'ttys010', maker: 30, pid: 700, rows }`.
  - the same with a herdr maker → `nest: 'herdr'`.
  - `leaves it on no app's page when the lookup names no app, the maker read names none or fails, or no lookup is given`:
    `nested` → `{}`; `madeBy` → empty map (`nested` not called); `madeBy` rejects; deps with neither → `[{}]` each.
  - Review Focus 4: two TUIs in `/work/app`, one in tmux with no app and one in Terminal → `[{}]`; two in tmux with no
    app → `[{}]`; `madeBy` never called in either.
  - `servedLookup('darwin', { madeBy, nested })` is a function.
  - `devices.spec.ts`: the `servedLookup` mock records its calls: the devices started on `linux` call it with
    `('linux', { madeBy: expect.any(Function), nested: expect.any(Function) })`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/codexServed.spec.ts src/services/devices.spec.ts` — the
  new cases fail (`[{}]`; called with one argument).
- [ ] **Step 3: Implement.** The file's doc comment gains the why: a served hook's hints are the first TUI's, so the
  served path never asked the by-process lookup; a Codex in tmux in an app was on no app's page and never nested, and
  notices rang loudly with the person there (20/20 `alert · rule:turn`). Zellij is not looked up by process (its own
  item).
- [ ] **Step 4: Run** both specs — pass. **Step 5: Commit** red, then code.

### Task 3: the served place is nested, kept through every hook, and left when either client exits

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`Entry`, `askServed`, `placeServed`, `tick` ~2192-2217)
- Test: `cli/src/cable/hosts/observed.spec.ts` (same describe)

**Depends on:** task 1 (same files; its moved resets), task 2 (`Served.nest`, `Served.pane`). **Effort:** high.

**Interfaces:**
- Consumes: task 2's `Served`.
- Produces: `Entry.servedPane?: Pane`, the served answer's pane. `placeServed(entry, served)` sets `entry.agent.nest`
  (deleted when `served.nest` is none), `host = served.nest ?? served.client?.app ?? UNKNOWN_APP`, and
  `entry.placed = entry.servedPane = served.pane`. `ingest` still clears `entry.placed` on each hook (~1442); `askServed`
  puts it back from `entry.servedPane` for a daemon whose `is` is true, below task 1's return. The tick judges
  `[...(outer.pid !== undefined ? [{ pid: outer.pid }] : []), ...(servedClients ?? [])]`: the multiplexer's client and
  the TUI; either gone, `placeServed(e, {})`, and the next turn-start asks again (no client known).

- [ ] **Step 1: Write the failing tests** (pids below 1000: the spec's table runs only those):
  - `in tmux inside Ghostty its place is nested: host tmux, on Ghostty's and tmux's pages, and a tap shows its pane, through its next hooks`:
    answer `[{ client: { app: 'ghostty', tty: '/dev/ttys003', pid: 650 }, nest: 'tmux', pane: PANE, clients: [{ pid: 700, generation: 'g700' }] }]`
    → `nest === 'tmux'`, `host === 'tmux'`, `pagesOf(agent())` is `['ghostty', 'tmux']`; a tap opens
    `com.mitchellh.ghostty` at `PANE`, as the scan's nested place opens iTerm2 at its pane; `paneOf(id, 'tmux')` is
    undefined (no words reach it); after a turn-start all the same and the lookup asked once.
  - `it.each` over the TUI (700) and the multiplexer client (650): `gens.set(pid, null)`, `tick()` → no nest, host and
    app `terminal`, a tap opens no pane; the next turn-start asks again (`lookup` called twice).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts -t "its own server runs"` — fail (no nest).
- [ ] **Step 3: Implement.** Comments say why the pane is kept on the entry (a served daemon is asked once, while each
  hook clears the scan's pane) and why the tick checks both clients (a detach or a re-attach in another app is seen,
  not left on the app's page with a dead tty).
- [ ] **Step 4: Run** the whole spec file — pass. **Step 5: Commit** red, then code.

## Item 3: the unplug waits

### Task 4: wait until no attached row is left, through one helper

**Files:**
- Modify: `cli/e2e/harness/desk.ts`, `cli/e2e/deviceStopLook.e2e.ts` ("no dial: no block", ~401),
  `cli/e2e/deviceNotify.e2e.ts` ("with the dial unplugged it prints no dial", ~516)

**Depends on:** none. **Effort:** high. No product change.

**Interfaces:**
- Produces, in `desk.ts`: `Desk.forget(serial: string): FakeDial | undefined` rewrites `dials.json` without that dial
  and does not close it (the seam; `write()` stays private); `unplug(serial)` becomes `await this.forget(serial)?.close()`.
  `export function untilUnplugged(window: LocalClient, serial: string): Promise<void>`: `until` (30 s, every 500 ms) an
  answer of `harness_devices_list` that carries a `status` and has no device with that id attached; absent counts.

- [ ] **Step 1: Write the failing test.** "no dial: no block" forces the order that broke: `const dial = desk!.forget('E2E-A')`;
  `until` the daemon's log since then matches `/cable: closed \(daemon stopping\) \[usb E2E-A\]/` (30 s, every 50 ms);
  `await dial!.close()`; then today's wait (`attached === false`), unchanged. The red commit holds `forget` and this.
- [ ] **Step 2: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceStopLook.e2e.ts -t "no dial: no block"`
  — fails at "the dial to read as unplugged" (the row went from attached to absent).
- [ ] **Step 3: Implement** `untilUnplugged`; both tests use it in place of their inline wait. Its comment says why:
  the fleet shows `attached: false` only from the port's close to its next 2 s scan, which drops a dial no longer in
  `dials.json`, so absent is unplugged too (`cable.isConnected` is false either way).
- [ ] **Step 4: Run** both files (Verification 3) — pass; the case 3 times in a row. **Step 5: Commit** red, then code.

`docs/validation-and-release.md` "Recorded flaky tests" holds no row for either test (checked on e000b662a9): nothing to
remove.

## Item 4: local requests are not kept alive

### Task 5: `overSocket` opens a connection per request

**Files:**
- Modify: `cli/src/lib/localTransport.ts` (`overSocket` ~76, `tolerated`)
- Test: `cli/src/lib/localTransport.spec.ts` (replaces "fifty requests over one kept-alive socket leave one error listener")

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces: `request({ ..., agent: false })`; the `tolerated` WeakSet goes; `req.on('socket', (s) => s.on('error', () => {}))`
  stays on each request (Linux EPIPE after a refused request, #2605). Every local caller (daemon socket, Windows pipe,
  cloud bridge, devices listener) goes through it; nothing else changes.

- [ ] **Step 1: Write the failing tests**, `describe.skipIf(process.platform === 'win32')('fetchOverSocket and a listener that closes each connection after its answer')`:
  - `three requests in a row are each answered, on a connection of their own, and each handled once`: a
    `listenLocalSocket` server that counts connections and handled requests, answers, then ends the connection; three
    POSTs through `fetchOverSocket` → all 200, handled 3, connections 3. Red today: the second rejects with EPIPE (its
    `cause.code`). It must be red on every run (5 runs); if the race needs it, hold the client's loop with `Atomics.wait`
    after reading an answer, as the cause says (a loop held past the close). If it cannot be made red every run, stop and
    report.
  - Review Focus 1: `a streamed answer's first chunk arrives before its end`: the server writes one chunk and ends only
    when the test, having read that chunk from the body's reader, tells it to (no sleep).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/localTransport.spec.ts` — the first fails.
- [ ] **Step 3: Implement.** The comment says why: the devices listener closes 2 s after its last answer, a client
  whose loop was held then reads the close a turn late and writes its next request on it (EPIPE); a retry cannot tell a
  handled ECONNRESET from an unhandled one, so a `notice` could arrive twice.
- [ ] **Step 4: Run** the spec — pass. Measure on this Mac (a throwaway script, not committed): 1,000 sequential POSTs
  through `fetchOverSocket` to a local socket, `process.cpuUsage()` per request, before and after; the PR states both
  (the spec measured about 30-35 µs more). **Step 5: Commit** red, then code.

## Item 5: `pair` and `remote-password set` answer a word and a code

### Task 6: `said(word, run)`

**Files:**
- Modify: `cli/src/gateway/keyRoutes.ts`
- Test: `cli/src/gateway/keyRoutes.spec.ts` (replaces "says a pairing's or a password's own failure in its message, …")

**Depends on:** none (it imports `errnoOf` from `lib/deleteSecretFile.ts`, unchanged by task 7: no shared file).
**Effort:** xhigh (an answer that named a path).

**Interfaces:**
- Produces: `routes(ops: KeyOps, log: (line: string) => void)`, `keyRoutes` passing its `log`; inside it
  `said(word: string, run: () => Promise<HttpAnswer>): Promise<HttpAnswer>`: a throw logs
  `[gateway] POST KEY_ROUTE_FAILED · ${errorKind(error)}` and answers `500 { error: `${word} (${errnoOf(error)})` }`.
  `/api/pair` uses `PAIR_FAILED`, `/api/remote-password/set` `REMOTE_PASSWORD_NOT_SET`. Pair's known codes stay values
  (`gateway/start.ts`); `cli.ts pairCommand` already prints an unknown code in its generic line: no client change.

- [ ] **Step 1: Write the failing test** `says a pairing's or a password's own failure in a word and its errno code, never its message, and logs it by its kind`:
  pair rejects `new Error('round failed /home/someone/.harness/e2e/x')` → `{ error: 'PAIR_FAILED (UNKNOWN)' }`; set
  rejects `Object.assign(new Error('EACCES: open /home/someone/x'), { code: 'EACCES' })` →
  `REMOTE_PASSWORD_NOT_SET (EACCES)`; set rejects `'not an error'` → `(UNKNOWN)`; Review Focus 3: a `code` of
  `'/home/someone/x'` → `(UNKNOWN)`; the logs gain `· Error`, `· EACCES`, `· string`, `· Error` for these in order;
  no answer or log line contains `/home/someone`. The clear, group, pairs and `null`-body cases stay as they are.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/gateway/keyRoutes.spec.ts` — fails.
- [ ] **Step 3: Implement.** The comment names #4675 (which fixed `clear` only) and why the failure is logged now (the
  catch-all never saw it).
- [ ] **Step 4: Run** the spec — pass. **Step 5: Commit** red, then code.

## Item 6: `harness reset` and a briefly held file

### Task 7: one held-delete helper

**Files:**
- Modify: `cli/src/lib/deleteSecretFile.ts` (a core-process file)
- Test: `cli/src/lib/deleteSecretFile.spec.ts` (its `node:fs` `rmSync` queue)

**Depends on:** none. **Effort:** xhigh (core).

**Interfaces:**
- Produces: `export function deleteHeld(path: string, recursive: boolean, wait: Wait = pauseSync): void`:
  `rmSync(path, { recursive, force: true })`; EBUSY or EPERM, and ENOTEMPTY when `recursive` (a folder whose held child is
  pending deletion on Windows), tried again, `TRIES` 3, `RETRY_WAIT_MS` 400 apart; any other failure, or the last, thrown
  as it came. `deleteSecretFile(file, word, wait)` becomes `deleteHeld(file, false, wait)` with its throw wrapped in
  `SecretNotDeleted(word, errnoOf(error))`. The doc comment says why one loop (Node's `maxRetries` is recursive-only and
  invisible to the `node:fs` mock seam).

- [ ] **Step 1: Write the failing tests**, `describe('deleting a path Windows may hold for a moment')`: a folder with a
  file, recursive, failing `['EBUSY']` → gone, 2 deletes, waits `[400]`; `['ENOTEMPTY']` recursive → gone, 1 wait;
  `['EBUSY', 'EBUSY', 'EBUSY']` → throws an error whose `code` is `EBUSY`, 3 deletes, 2 waits; `['EACCES']` → throws at
  once, no wait; not recursive `['ENOTEMPTY']` → throws at once. The existing `deleteSecretFile` cases stay.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/deleteSecretFile.spec.ts` — fail (`deleteHeld` missing).
- [ ] **Step 3: Implement.** **Step 4: Run** — pass. **Step 5: Commit** red, then code.

### Task 8: `clearAdapterState` deletes through it, and swallows nothing

**Files:**
- Modify: `cli/src/cli.ts` (`clearAdapterState` ~1820-1858)
- Test: `cli/src/cliSecretDelete.spec.ts`

**Depends on:** task 7 (`deleteHeld`). **Effort:** high.

**Interfaces:**
- Consumes: `deleteHeld`. Every `rmSync` there becomes `deleteHeld(path, recursive)` (the named state files and
  `shortSocketFolder(dir)` and a separate `dataDir` recursive, a socket or `daemon-*.json` not). The `try { … } catch {}`
  around the socket loop narrows to `readdirSync(dir)` alone (no such folder). `resetCommand` is unchanged: a throw is
  `STATE_NOT_DELETED (<code>)`.

- [ ] **Step 1: Write the failing test** `it.skipIf(!modesHold)('reset: a socket record it cannot delete is said in a word, never skipped')`:
  seed `<root>/cli/daemon-1.json`, lock `<root>/cli` (and unlock it in `afterEach` as `auth` and `data/e2e` are);
  `run(root, ['reset', '--from-sign-out-button'], backend.base)` → status 1, stderr has `STATE_NOT_DELETED (EACCES)` and
  not `root`, stdout lacks `Cleared local machine CLI state`, the record still exists. The existing reset case stays
  green (`EACCES|ENOTEMPTY`; ENOTEMPTY is now retried, then thrown).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cliSecretDelete.spec.ts` — fails (reset says it cleared).
- [ ] **Step 3: Implement.** **Step 4: Run** — pass; `cd cli && npm run typecheck`. **Step 5: Commit** red, then code.

## Item 7: a Claude transcript announced before it is written

### Task 9: the shape check, in the transcript evidence

**Files:**
- Modify: `cli/src/engines/transcriptBindings.ts` (a core-process file; `transcriptEvidence`'s derived branch ~83-95)
- Test: `cli/src/engines/transcriptBindings.spec.ts`; Create `cli/src/engines/transcriptBindings.win32.spec.ts`

**Depends on:** none. **Effort:** xhigh (core, security).

**Interfaces:**
- Produces:
  - `export const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` (the registry's
    `GROK_SESSION_RE`, moved here by task 10).
  - `export function namedForSession(path: string, sessionId: string): boolean`: false unless
    `SESSION_UUID.test(sessionId)`; then `basename(path)` equals `${sessionId}.jsonl`, compared case-insensitively when
    `hostPlatform()` is `win32` (`./kit/windowsFiles.js`).
  - `transcriptEvidence(engine, path, profile, 'derived', …)` for a `'store'` root whose `sessionStoreOf(engine).byId.layout`
    is `'projects'` (Claude) no longer throws "no deterministic root"; it runs this, on the one `files`:
    ```
    refuse '..' as a path step                                     -> nativeUnavailable
    grand  = files.locate(dirname(dirname(path)), true)
    root   = scope.directories with nativeFileKey(info) === nativeFileKey(grand.info)
    no grand or no root (outside the roots, or two segments deep)  -> { valid: false, files, matchingRoots: [], verify }
    step   = join(grand.path, basename(dirname(path)))
    parent = files.locate(dirname(path), true)
    parent present: parent.path !== step (a link at the parent)    -> nativeUnavailable
                    not a directory, or uid not this process's     -> nativeUnavailable (as today's messages)
    parent absent:  !files.paths.absentLeaf(step) (a dangling link) -> nativeUnavailable
    actual = join(parent?.path ?? step, basename(path)); parent present and !absentLeaf(actual) -> nativeUnavailable
    -> { valid: true, files, matchingRoots: [root], verify(selected = path) { files.verify(selected); if (!roots) scope.verify() } }
    ```
    Any other `'store'` engine (Codex) still throws "the unwritten transcript has no deterministic root". The comment
    says why: Claude reports its transcript at SessionStart and writes it at the first prompt (and after `/clear`); an
    exact `projectDirectoryName(cwd)` match broke on `/tmp` vs `/private/tmp`, truncated names and the `/clear` cwd.

- [ ] **Step 1: Write the failing tests** in `transcriptBindings.spec.ts` (Claude's root is the stubbed
  `<root>/claude/projects`, created by each test that needs it; `P = <root>/claude/projects/-work/<A>.jsonl`):
  - admitted: `-work` present (owned) and absent → `transcriptEvidence('claude', P, undefined, 'derived').valid` true and
    `verify()` passes; `mkdirSync(-work)` or writing `P` after → `verify()` throws `changed`;
  - rule 2: the root reached through a symlink alias (`CLAUDE_PROJECTS_DIR` set to the alias, `P` spelled by the real
    path, and the reverse) → admitted; two segments deep (`-work/sub/<A>.jsonl`), a folder outside the roots
    (`<root>/elsewhere/-work/<A>.jsonl`), and the root not on disk → `valid` false;
  - rule 3: `-work` a symlink to a sibling `-other` in the root, to an outside folder, and dangling → each throws; `-work`
    a regular file → throws `not a directory`; `-work` of another uid (the `lstatSync` mock the owner test uses) → throws
    `owner`; a `..` step → throws;
  - rule 4: `P` a dangling symlink under a present `-work` → throws `absent leaf`;
  - Codex with `'derived'` and a missing path → still throws `no deterministic root`;
  - rule 1, `namedForSession`: true for `(P, A)`; false for `(P, B)`, `(…/x.jsonl, A)`, `(…/<A>.json, A)`, and the ids
    `'../x'`, `'a/b'`, `''`, `${A}/..`; on POSIX an upper-case name → false;
  - the later read: once admitted, `P` written with Claude's opening for A → `controlTranscriptEvidence('claude', A, P).path`
    is `P`; written with B's → throws (`different or delegated`); replaced by a symlink to an outside file → throws.
  In `transcriptBindings.win32.spec.ts` (`vi.mock('node:path')` to `win32`, as `lib/pathContainment.win32.spec.ts`
  does; `node:fs` `lstatSync`/`readlinkSync` from a case-insensitive NTFS fixture, as
  `engines/kit/nativePaths.windows.spec.ts` builds one, uid this process's; the roots passed as `transcriptEvidence`'s
  `roots`): `c:\users\u\.claude\projects\C--work\<A>.jsonl` under the root `C:\Users\u\.claude\projects` → admitted;
  a junction at `C--work` → throws (reparse point); `namedForSession` with an upper-case name → true.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/engines/transcriptBindings.spec.ts src/engines/transcriptBindings.win32.spec.ts`
  — fail (`no deterministic root`; `namedForSession` missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both specs and `npx vitest run src/architecture.spec.ts` (no file joins the core) — pass.
  **Step 5: Commit** red, then code.

### Task 10: the registry admits a Claude path of that shape

**Files:**
- Modify: `cli/src/lib/registry.ts` (a core-process file; `GROK_SESSION_RE` ~519, its uses ~2239-2243, `derived` and
  `evidenceUnder` ~2289-2303)
- Test: `cli/src/lib/registry.admission.spec.ts`

**Depends on:** task 9 (`SESSION_UUID`, `namedForSession`, the store branch). **Effort:** xhigh (core, security).

**Interfaces:**
- Consumes: task 9's exports. `GROK_SESSION_RE` goes; grok's, agy's and copilot's checks use `SESSION_UUID` (the same
  rule). `derived` gains, first: `engine === 'claude' && transcriptPath && namedForSession(transcriptPath, sessionId) ? transcriptPath : …`;
  `evidenceUnder` passes `'derived'` when `derived === effectiveTranscriptPath` (the `!transcriptPath &&` goes: only
  Claude's branch is set with a reported path). The comment beside Command Code's says why, and that any other reported
  path stays held (#1137).

- [ ] **Step 1: Write the failing tests** (Claude's root is `<root>/claude/projects` from the spec's `CLAUDE_CONFIG_DIR`;
  a Claude process agent opened at `%3`; posts through `httpFixture` with `engine: 'claude'`, `hookEvent: 'SessionStart'`):
  - `it.each(['present', 'absent'])('admits a Claude SessionStart before its transcript is written, the project folder %s')`:
    `{ status: 200, body: { ok: true } }`, `f.reasons` empty, the row bound to the path (today `{ pending: true }`,
    "not yet available");
  - Review Focus 2: the hook's `cwd` another folder (after `/clear` or a `cd`), and a 200-character folder name → admitted;
  - held (`{ pending: true }`, a hold reason): `session.jsonl`, `<B>.jsonl`, the session ids `'../x'` and `'a/b'` with
    a name built from them, two segments deep, a folder outside the roots, a linked parent folder;
  - the file written after the bind with Claude's opening: the next UserPromptSubmit commits (`{ ok: true }`).
  - "rechecks an unwritten derived locator proof under the lock and never grants it to a reported path" (Command Code)
    stays green, unchanged.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/registry.admission.spec.ts` — the admissions fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec, `npx vitest run src/lib/registry` (every registry spec) and `src/architecture.spec.ts` —
  pass. **Step 5: Commit** red, then code.

### Task 11: a transcript announced before its file is read from its start (guard)

**Files:** Modify `cli/src/engines/worker/liveRequests.spec.ts`.

**Depends on:** none. **Effort:** medium. **No failing test:** it pins what the spec relies on (the reader takes ENOENT at
offset 0 as empty, `engines/worker/liveStreams.ts`); one commit.

- [ ] **Step 1:** `claude: a transcript announced before its file is an empty stream, and the file written later is read from its first record`,
  through `engineLiveRequests('claude')` as the file's other cases drive it: attach with the path absent → no frame, no
  error; write a prompt and an answer; the next read → both, from the first.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/engines/worker/liveRequests.spec.ts` — passes. If it fails, stop and
  report: the spec's "safe on attach" does not hold. **Commit.**

---

## Verification

1. **Unit, per task**, as each task's steps run them; `cd cli && npm run typecheck` on the final head.
2. **Local gates (PR CI does not run them), on the final head, from a clean tree:** `python3 scripts/local-checks.py --run`
   from the repository root. For these paths it runs `cli-core` (`npm run test:core`: `services/devices.ts` and
   `devices.spec.ts` change, and the core-process files of items 6 and 7) and `cli-portability`
   (`npm run test:portability`: `lib/registry*.ts`), each at 100% per file. Its fence goes in the PR body before it is
   marked ready.
3. **End to end, this Mac, local (item 3).** An arm64 Node, Xcode's command line tools (the process-image helper), the
   final head:
   ```bash
   cd cli
   TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceStopLook.e2e.ts e2e/deviceNotify.e2e.ts
   for i in 1 2 3; do TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceStopLook.e2e.ts -t "no dial: no block" || break; done
   ```
   Isolated by the harness (`e2e/harness/daemon.ts`, cli/AGENTS.md rule 6): each daemon in a throwaway home with its own
   data folder, port and private tmux server, fake Claude Code and Codex engines, signed out, the backend at
   `ws://127.0.0.1:9`; the dial is a `FakeDial` on a pseudo-terminal the daemon finds through `dials.json`
   (`HARNESSD_TEST_DIAL_PORT`). The person's daemon (18473), tmux, `~/.claude` and `~/.codex` are never touched; no
   account is used. Seen: both files pass, and the case passes three times in a row; on task 4's red commit the case
   fails at "the dial to read as unplugged". On GitHub, `linux-e2e` runs both files by path (Verification 4); by hand
   only if the orchestrator hands out the turn (**CI → Run workflow**, `scope=linux-e2e`, `e2e_files` naming the two).
4. **The PR's own CI, by path.** `cli/src/cable/` (tasks 1-3) selects `windows-e2e` on x64: the dial end to end on a
   stand-in dial and the Windows CLI specs, among them `src/devices/listenerPipe.windows.real.spec.ts` and
   `src/lib/windows/`, which send every request over a real pipe through `overSocket` (task 5's `agent: false`). The e2e
   files (task 4) select `linux-e2e`, with its canary (`cli/e2e/harness/desk.ts`) and the dial app eval's six (all of
   `cli/src/cable/hosts/`, `services/devices.ts`, `desk.ts`); `cable/hosts/` and `desk.ts` select `dial-hosts`. Seen:
   `ci/required` green. `transcriptBindings.win32.spec.ts` (task 9) fakes Windows on any OS and runs in the Linux unit
   suite; its name does not select `windows-e2e`'s arm64. The Windows VM or the Dell only if CI shows a Windows-only
   failure and the orchestrator hands one out; items 4 and 6 are unit-tested there (the pipe spec, the `node:fs` seam).
5. **Items 1 and 2: a real Codex on a local model stub, this Mac (orchestrator, 2026-11-28).** A tester runs a real
   Codex 0.167+ (its managed daemon serves the TUI) pointed at a local model stub on 127.0.0.1, as #4677's tester and
   the Needs-you-right Part 5 rig did (`/private/tmp/claude-502/-Users-nqhieu84-orca-workspaces-openharness-needs-you-right-stop-look/75c3b500-2eec-40cb-a363-920b6532374e/scratchpad/hostrig/`
   if it still exists: `env.sh`, `stub-codex.mjs`, `t.sh`), in a throwaway `CODEX_HOME`, against an isolated daemon
   built from the final head (its own data folder, port and tmux server; never the person's daemon 18473, their
   `~/.codex` or an account). Scenario: Codex in tmux inside Orca or Ghostty; the dial row (`harness_devices_list` /
   the observed rows) shows the app, host `tmux`, nest `tmux` and the pane, through a second turn; detaching the tmux
   client is seen (the row leaves the app's page). If building the stub rig for Codex costs more than about 30 minutes,
   the tester drops it and the PR body says why; the unit tests then stand alone. No login of the user's is used.
6. **Items 5 and 7: no further end-to-end check.** Item 5's answers are the routes' own (`keyRoutes.spec.ts`;
   `e2e/keyRoutes.e2e.ts` has no throwing case and stays as it is). Item 7 is proven at the evidence and admission
   layers (tasks 9-10) and the reader (task 11); its core change is argued in the PR body.

## Summary

11 tasks. Dependencies: 3 on 1 and 2; 8 on 7; 10 on 9; the rest none. Longest chain: two tasks (1 → 3, 2 → 3, 7 → 8,
9 → 10).

## Open questions

None.
