# Small fixes, 2026-11-28: design

One pull request, seven fixes, batched by the maintainer ("fixes don't wait, batch small"). Each item was checked on
`main` at e000b662a9 first; none was already fixed. Every behavior change gets a test that fails first, at the layer
where the behavior lives.

Platforms: macOS, Linux, Windows. Windows CI runs by path; the Windows VM or the Dell x64 only after the orchestrator
hands it out.

## 1. A Codex session its daemon serves always says host `terminal`

**Cause.** `askServed` (`cli/src/cable/hosts/observed.ts` ~1283) clears the hints and sets
`a.host = detectHost({})`, which is always `terminal`. `placeServed` (~1312) then sets the app, outer, tty and bundle
but never the host; the scan path (~1919) goes through `placeServed` too. The dial row, the usage counts and the
notice's place ("In Terminal", `services/devices.ts` ~2092) carry `terminal` for a Codex TUI in Ghostty.

**Change.** `placeServed` sets `agent.host` from what placed it: the nest (item 2) when there is one, else the client's
app, else `terminal` (UNKNOWN_APP), as a Claude row's host is its app outside a multiplexer. Every later hook from the
same daemon runs `askServed`, which today clears the nest and the host before its early return for a daemon already
answered (`if (entry.served!.is) return true`), and is not asked again: those resets move below that return (or the
host, nest and pane are put back from the kept served answer there), so the place lasts past the first hook.

**Test (red first).** `observed.spec.ts`, "ObservedSource and a Codex session its own server runs": answered
`{ client }`, the row's host is the client's app, and stays so after a second hook (session-start, then turn-start);
answered `{}`, it stays `terminal`.

## 2. Codex in tmux inside an app is on no app's page and never nested

**Cause.** The served path, not the hook or scan path. Every hook's caller is Codex's managed daemon, whose parent is
the TUI, whose parent is the tmux server under launchd (evidence rig of the Needs-you-right Part 5 child). `askServed`
drops the hints (`TMUX_PANE`) and `a.nest` on purpose, and `codexServed.ts` (~106-114) finds the client TUI by its
folder but asks its app only of the walk up its parents, which ends at the tmux server with no app: `{}`, no app's
page. The by-process nested lookup the scan uses for Claude (`madeBy` + `nested`: `readMadeBy` with
`createTmuxNested` / `createHerdrNested`, wired in `services/devices.ts` ~985-996) is never asked for the client TUI.
So `outsidePresent` (`devices.ts` ~1738) never holds: notices ring loudly with the person present, and the dial does
not follow the prompt (a tester saw 20/20 `alert · rule:turn`).

**Change.**
1. `CodexServedDeps` takes the same `madeBy` and `nested` lookups the scan uses. When exactly one client TUI was found
   and its walk named no app, it is looked up by process; when the place names an app, the answer is that app, the
   place's tty and pid, its nest (`tmux` or `herdr`), its pane, and `clients: [{ pid: tui, generation }]`. `Served`
   gains `nest` and `pane`. Several TUIs in one app keep #4677's answer; several TUIs in a multiplexer with no app stay
   `{}` (named with Zellij below).
2. `placeServed` sets `agent.nest`, `host` (item 1) and the placed pane, and clears them when the answer has no nest.
   `ingest` clears `entry.placed` on every hook (`observed.ts` ~1442) before `askServed`, and an answered daemon is not
   asked again: the served nest and pane are kept on the entry and put back on each hook (item 1's move).
3. The tick that checks a served session's client is still running (`observed.ts` ~2198) checks both the TUI (the
   served clients) and the multiplexer client (`outer.pid`): either gone, `placeServed(e, {})` clears the place, and
   the next turn-start asks again (a detach or re-attach is seen, not left on the app's page with a dead tty).
4. `services/devices.ts` passes the lookups it already has (`nesting`) to `servedLookup(platform, nesting)`.

**Not covered: Zellij.** The by-process lookup knows tmux and herdr only; Zellij's lookup needs the session name from
the hints (`createZellijOuter`), and a served hook's hints are the first TUI's. Codex in Zellij keeps today's place;
it is its own item (Decisions). Windows is unchanged (`nesting()` is empty there).

**Tests (red first).** `codexServed.spec.ts`: a tmux server under launchd, the TUI on its pane, the daemon; fake
`madeBy` and `nested` name Ghostty: the answer is Ghostty with nest `tmux` and the pane (today `{}`); a `nested` that
names no app still answers `{}`. `observed.spec.ts`: answered with a nest, the row is nested, host `tmux`, on Ghostty's
and tmux's pages, and a tap shows the pane, still after a second hook; the TUI exiting and the multiplexer client
exiting are each seen by the tick, which clears the place.

## 3. Flaky end to end: deviceStopLook "no dial: no block"

**Cause (the test, not the product).** `desk.unplug('E2E-A')` (`cli/e2e/harness/desk.ts`) rewrites `dials.json`
first, then closes the dial's bridge. The test then waits for the E2E-A row to read `attached: false`. The fleet
(`cli/src/cable/cableFleet.ts`) shows `attached: false` from the port's close until its next 2 s scan, which removes a
dial no longer in `dials.json`. When the scan lands first (the file rewritten, the bridge not yet gone), the row goes
straight from attached to absent and the wait times out. The product is right: a real unplug drops the row within 2 s,
the Devices screen shows only plugged-in dials, and the stop hook's "no dial" reads `cable.isConnected`, false either
way. `deviceNotify.e2e.ts` "with the dial unplugged it prints no dial" has the same wait.

**Change.** Both tests wait until no attached E2E-A row is left (an answer with a status, so an error answer does not
pass), through one helper in `desk.ts`.

**Test (red first).** "no dial: no block" forces the order that broke: rewrite the file, wait for the scan's
`cable: closed (daemon stopping) [usb E2E-A]` log line, then unplug. Red with today's wait every time, green with the
new one. `Desk` gains a small seam that rewrites the file without closing the dial (`write()` is private today). No
product change.

## 4. EPIPE on a reused local connection

**Cause.** `overSocket` (`cli/src/lib/localTransport.ts` ~76) sends through Node's global agent, which keeps
connections alive. The devices listener (`services/devicesListener.ts`) closes a connection 2 s after its last answer.
A client whose loop is held over 2 s right when the answer lands reads the answer first and the close only a turn
later, so its next request is written on the closed connection: EPIPE. Reproduced with the real `fetchOverSocket`
against a server that closes right after its answer. The daemon's socket has the same cause.

**Change.** Local requests are not kept alive (`agent: false`): each opens its own connection. A retry on EPIPE is not
enough (its twin, ECONNRESET when the listener's timer runs before it reads, cannot tell a handled request from an
unhandled one, so a `notice` could arrive twice), and a safe age needs a custom agent. Every local caller (daemon
socket, Windows pipe, cloud bridge, devices listener) goes through `overSocket`; nothing relies on reuse (pipe proof is
per request). The keep-alive-only bookkeeping (the `tolerated` WeakSet) goes; the no-op `socket.on('error')` listener
stays (Linux EPIPE after a refused request, #2605). Cost measured on this Mac: about 30-35 µs of CPU more per request; the callers are
low-rate (watch tells, a 30 s inbox poll, one-shot commands), no hot path.

**Test (red first).** `localTransport.spec.ts`: three POSTs in a row through `fetchOverSocket` to a server that
closes each connection right after its answer: all 200 and all three handled (today the second fails with EPIPE). The
old "kept alive" test, which asserts the reuse, is replaced.

## 5. `remote-password set` and `pair` answer the raw error message

**Cause.** `said` (`cli/src/gateway/keyRoutes.ts`) answers a thrown error with `error.message`, which may name a path.
#4675 fixed `clear` only.

**Change.** A failure of either route answers a fixed word and the errno code (`errnoOf`, `UNKNOWN` when there is
none): `PAIR_FAILED (<code>)` and `REMOTE_PASSWORD_NOT_SET (<code>)`. `said` catches today, so these failures are
never logged: `said(word, run)` logs the door's one failure line (`[gateway] POST KEY_ROUTE_FAILED · <errorKind>`) and
answers the word and code. Clients are safe: pair's known codes come back as values, not throws (`gateway/start.ts`),
and the CLI, Desktop and TUI fall back to a generic line for an unknown code.

**Test (red first).** `keyRoutes.spec.ts`: a pair that throws `Error('… /home/someone/…')` and a set that throws one
with `code: 'EACCES'` answer the word and code, never the message, and each is logged by its kind.

## 6. `harness reset` fails at once on a briefly held file (Windows)

**Cause.** `clearAdapterState` (`cli/src/cli.ts` ~1820) deletes with `rmSync` and no retry, so an antivirus or indexer
holding a file for a moment reports `STATE_NOT_DELETED` at once.

**Change.** Every delete in `clearAdapterState` goes through the same retry as `lib/deleteSecretFile.ts` (EBUSY/EPERM,
3 tries, 400 ms apart): the loop is taken out into one helper both use, recursive or not; a recursive delete also
retries ENOTEMPTY (on Windows a folder whose held child is pending deletion fails with it). One way to retry a held
delete; Node's own `maxRetries` is recursive-only and invisible to the existing `node:fs` mock seam. The same cause is
hidden at `cli.ts` ~1850-1854: a `try { … } catch {}` swallows every failed socket or `daemon-*.json` delete, so reset
says success; that try narrows to `readdirSync` alone.

**Test (red first).** A unit test of the helper: a recursive delete that fails EBUSY (and one ENOTEMPTY) once, then
succeeds, removes the folder and waited once; one that fails EBUSY every time throws after 3 tries; EACCES (and
ENOTEMPTY when not recursive) is not retried. A reset whose socket record cannot be deleted reports
`STATE_NOT_DELETED`. The existing `cliSecretDelete.spec.ts` reset case stays green.

## 7. A new pane logs "SessionStart held · IdentityReadUnavailable" until its first prompt

**Cause.** Claude Code reports its transcript path at SessionStart before writing the file; it writes it at the first
prompt (also after `/clear`). The registry (`cli/src/lib/registry.ts` ~2306-2320) allows a missing file only for a path
the core derives itself (commandcode, grok, agy, copilot); a reported path must exist (#1137). So the bind is held and
retried every 1 s until the first prompt; meanwhile the row carries the hold reason and a close waits on it. Seen in
this Mac's log for Claude only; Codex's file exists at SessionStart.

**Change.** A Claude path that is not on disk yet is admitted only when it has the shape of the path the core derives
for Claude, under the core's own Claude roots:
- its name is `<sessionId>.jsonl`, with this hook's session id, matching Claude's id rule;
- its parent folder is one segment directly under one of the Claude transcript roots the core already holds
  (`scope.directories` from `transcriptRootEvidence`, so no new import enters the core);
- that parent, when present, is a real folder owned by this user (no link);
- the file itself is a proven absent leaf.

The orchestrator's conditions, each with its own refusal test:
- the session id is checked against Claude's id form (a UUID) before any name is built from it: no `/`, `..` or other
  characters;
- the Claude roots are compared by their realpath; the parent is a real folder checked with `lstat`: a symlink or a
  junction at the parent or at the file is refused;
- when the file appears later, it is read through the same checks the core runs today, never trusted because its path
  was admitted;
- on Windows, paths compare case-insensitively, as the core already does.

An exact `projectDirectoryName(cwd)` match was the first idea; it is fragile (no realpath fallback, `/tmp` vs
`/private/tmp`; Claude truncates long folder names; after `/clear` or a `cd` the hook's `cwd` is the shell's folder, so
the `/clear` case would stay held). Any other missing reported path stays held (#1137: a hook cannot bind a path it
chose outside the engine's roots). `engines/transcriptBindings.ts`'s derived branch, which refuses `'store'` roots
today, gains a store branch built on `scope.directories`. Safe on attach: Claude has no first-line header rule, and its
reader treats ENOENT at offset 0 as empty (`engines/worker/liveStreams.ts`); the watcher reports the file when it
appears.

**Tests (red first).** `registry.admission.spec.ts`: a Claude SessionStart with such a path, the project folder
present and absent, the file absent: admitted and bound, no hold reason (today `pending` with "not yet available"); a
wrong file name, another session's id, a folder two segments deep, a folder outside the roots, and a linked parent
folder stay held; the file written after the bind is tailed from its start. The commandcode test "never grants it to a
reported path" stays green. Both files are core files: `npm run test:core` at 100%.

## Decisions

- Item 2, Zellij: a served Codex in Zellij needs a new by-process Zellij lookup (the hints are not usable on the served
  path). This pull request covers tmux and herdr; Zellij is its own item (orchestrator, 2026-11-28).
- Item 7 changes the core: it admits a missing path only when it has the shape the core derives under the core's own
  Claude roots (item 7's four rules, replacing the exact `cwd` match after the builder check), a test shows every other
  missing path refused, `test:core` stays at 100%, and the pull request says why the core changed (orchestrator).

## Verification

Unit tests per item (above). Required local gate: `npm run test:core` (item 7 touches core files). End to end: the
`deviceStopLook` and `deviceNotify` e2e files on this Mac (item 3). Windows: CI by path; item 6's retry and item 4's
pipe path are unit-tested, the VM only if CI shows a Windows-only failure.
