# The dial lands on a ChatGPT agent, and its words reach the ChatGPT app's Codex

## The report

A person on CLI 0.6.66, with Harness Desktop open, uses Codex through the ChatGPT app (bundle `com.openai.codex`,
shown on the dial as "ChatGPT"). Their dial's APPS screen says "ChatGPT · 7 agents". Tapping it leaves the face on
"Choose a pane" instead of a ChatGPT agent. Every word spoken to a ChatGPT agent fails: the daemon's log has
`[device] voice · codex-failed (exit 127)` followed by `[device] voice · no-answer`, 7 times in 8 minutes, and the dial
says "<name> did not answer."

The person's log is filtered (dial, observed, codex and app filter lines only). The reading below is from it and from
the code on `76f9a82582`. Two lines are still asked of the person (through the PM); "Open" says what each could change.

## Cause 1: the face holds no agent after the list was emptied, and nothing lands it

- The face says "Choose a pane" when the dial has no active agent (`ui_habitat.c:1144`, `s.active == -1`).
- A cable that attaches again empties the dial's list (`cable_client.c:915`, `s_agent_count = 0`), which leaves
  `s.active = -1` once the tiles go. The next list adds its agents (`ensure`), which never sets `s.active`: only a pick
  of another app (`app_landing`, `ui_land_after_reload`), a `focus` frame from the daemon, or a swipe
  (`ui_habitat.c:3145`) lands the face. Any list that went empty and filled again does the same (`agents → 0 of 22`
  at 16:42:21 in the log).
- After a push the daemon re-asserts only its focus record (`cableSession.ts`, after `agents.end`), and only when the
  record names an agent of the list just sent. After an attach the record is often empty, or it names an agent of the
  ring shown before (here, Harness's). Either way it names none of this ring's agents, so nothing is sent and the face
  stays on "Choose a pane".
- The person then opens APPS and taps ChatGPT, the app already shown. The daemon answers `same` with nothing
  (`cableSession.ts`, `app.pick`), and the firmware lands only on a pick of another app (`app_pick`). The face stays
  on "Choose a pane". The log: `agents → 6 of 6 (requested)` and `7 of 7` at 16:50:03-05 after a reattach, then
  `app filter: picker` at 16:50:08 and 16:50:11 with no switch to ChatGPT; four more pickers with no switch at
  16:48:47-16:49:34. The `switched · pick` at 16:50:11 is a pick of Harness (`16 of 22`, the Harness ring's bound of
  16 out of its 22 agents), most likely the person trying something else.

## Cause 2: `codex queue` runs a `codex` that cannot start in the devices process

- A Codex session found outside Harness takes the dial's words through `codex queue` (`cable/hosts/codexQueue.ts`),
  run with the `codex` on the daemon's own PATH (`resolveBinaryOnPath(engineBin('codex'))`) and the daemon's own
  environment. The daemon runs under launchd (or is started by an app) and never read the person's shell profile
  (`lib/loginShellEnv.ts` says why), while launches get their PATH from the person's interactive shell
  (`lib/engineLaunch.ts`).
- Exit 127 means a `codex` was found, so it is not "no binary", and it could not run what it starts. On macOS the npm
  `codex` is `#!/usr/bin/env node` (`@openai/codex/bin/codex.js`, checked on this Mac), and `env` exits 127 when no
  `node` is on PATH. Since the runtime went private, a machine with no node on the daemon's PATH is the normal case
  (`engineLaunch.ts`, `harnessNode`). A shell shim left behind by a moved or removed app exits 127 the same way.
- The ChatGPT app ships its own Codex CLI: `ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`,
  a native arm64 program (`bin/codex` beside it is a `/bin/sh` shim that execs it). On this Mac it is
  `codex-cli 0.169.0-alpha.11.1`, and `codex queue --thread <id> --message <text>` is there. It is the app's own
  version, so it queues into the app's threads with no PATH, no node and no shell.
- After a definite failure the observed source falls through to typing into a pane. A session in the ChatGPT app has
  none, so the person hears "<name> did not answer.", which says nothing they can act on.

## The fix

Nothing in the core: both changes are in the devices process (`cli/src/cable/`, `cli/src/services/devices.ts`).

### A. A ring with agents never leaves the face on none (daemon)

In `CableSession`, after `agents.end` of a **machine list** (`view: 'machine'`, any dial on this computer's agents,
with or without `appFilter`), the record becomes the list's first agent and its `focus` frame is sent when all of
these hold:

- the list has agents;
- the dial's list was empty before this push: the ring last sent (`lastRing`) had no agents. That is the first push
  since the port opened (`lastRing` is emptied there), the push after an empty list, or the push that answers the
  dial's own `agents.list`. A dial asks for the list only when it holds none, for example after its 15 s silence rule
  empties it while the port stays open, so `lastRing` is emptied before that answer (PM, 2026-11-18). These are
  exactly the cases where the firmware is left with `s.active = -1`: it adds a list's agents before it removes the
  old ones, so a ring that replaces a non-empty one always leaves some agent on the face;
- the focus record names none of the list's agents (a record in the list is re-asserted as today);
- no follow is in flight (`appFocusUnsent` is false). A follow writes its record before its push and sends its own
  focus after it (`cableSession.ts` `follow`), and landing on the first agent first would step the dial through it.

Notes:

- This is the firmware's own landing for a picked app ("its first agent goes on the face", `app_pick`), applied where
  the firmware lands nothing.
- An agent that leaves a ring with others in it is not covered: the firmware moves to a neighbour, as today.
- On a window's tab (no `view`) nothing changes: there "Choose a pane" is the window having no focused tile, and the
  window says where the dial goes.
- A focus the daemon sends moves the dial only. It is not a person's move, so it calls no `host.focus` and brings
  nothing forward, as the existing re-assert does not. The host still hears what the dial shows (`dialShows`), as for
  every write of the record.
- `same` on `app.pick` still sends nothing: with A, the shown app's ring has already landed its face.
- Like the re-assert, the landing sets the expected echo for 750 ms (`APP_FOCUS_SETTLE_MS`). The firmware sends no
  echo for a daemon focus, so a swipe in that window is dropped. This happens once per attach or refill, which is
  accepted.
- A daemon or devices process that restarts behind a plugged dial lands it on the first agent. Accepted: the port
  closed, so the firmware emptied its list anyway (PM, 2026-11-18).
- With two dials on one host, the dial that landed last becomes the host's shown agent (`cableHost.dialShows`, the last
  report wins), as it does for any move. Accepted.

### B. The ChatGPT app's Codex sessions are queued through the app's own CLI (devices)

1. **Which `codex`.** For a session in the ChatGPT app (`agent.app === 'codex'` and `agent.engine === 'codex'`, the
   same test `codexApp.ts` `paneOf` uses), `codex queue` runs the app's CLI: the first of
   `/Applications/ChatGPT.app` and `~/Applications/ChatGPT.app` whose
   `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` is executable. It runs the native program directly,
   with no shell, as the queue does today. macOS only. Every other session, and an app session with no app CLI found,
   uses the `codex` a launch would run: `CODEX_PATH` when set (as `engineBin` reads it now, and as the end-to-end
   daemon names its fake), else `codex` on the login shell's PATH, then on the daemon's. Each look holds 30 s, as
   now. A look taken before the login shell's environment was read holds only until it is read.
2. **Whether it can.** `can()` takes the same input as `send()`: whether the session is the app's. An app session is
   queue-able when the app CLI or the other `codex` is there. Voice for it (`observed.ts` capabilities) follows from
   that, so an app session on a computer with no `codex` on any PATH still takes the dial's words.
3. **Its environment.** `oneShotParentEnv()` (the login shell's environment with the daemon's on top, the documented
   safety rule in `loginShellEnv.ts`), with two overrides. PATH becomes the login shell's PATH followed by the daemon's,
   the same order the `codex` was found in, so the `node` an npm `codex` asks for comes from where `codex` came from.
   `CODEX_HOME` is the daemon's Codex home, as now. The devices process reads the login shell's environment
   (`warmLoginShellEnvironment`) on the first `can()` or `send()` on macOS or Linux, never on Windows, and not at
   start: a computer whose dial never meets a Codex session never pays for the interactive shell. Until it has been
   read, the daemon's environment is used, as today.
4. **Its failure.** A definite failure (`exit <n>` or `no binary`) for a session with no pane to type into answers
   `Update ChatGPT, then try again.` for an app session and `Codex could not take it. Try again.` for another. The log
   line keeps its form and says which `codex` ran: `voice · codex-failed (exit 127 · app)` or `(… · path)`, with no
   path and no app name.

The binary choice and the environment live in `codexQueue.ts`. `observed.ts` passes whether the session is the app's.
`codexApp.ts` stays as it is.

A session whose app is not known yet (a hook before `learnApp` answers, or an open-scan session whose walk failed,
`observed.ts`) is not the app's. It takes the other `codex` and the other copy. This is accepted: the app becomes
known on its next hook.

## Measures

The `voice · codex-failed (…)` line gains `· app` or `· path`, so a fleet's logs show whether the app CLI ran.
`voice · codex` (queued) is unchanged. The dial's landing needs no new line: the existing `cable: agents →` line
already marks each push.

## Tests (red first)

- `cableSession.spec.ts`:
  - the first machine list after an attach, with no record or a record of another ring, sends `focus` on its first
    agent;
  - so does a machine list after an empty one;
  - a ring that replaces a non-empty ring sends no new landing;
  - a record in the list is re-asserted as before;
  - a follow in flight lands only its own agent;
  - a window's tab with no record sends no focus.
- `codexQueue.spec.ts`:
  - an app session runs the app's CLI when it is there, else the other `codex`;
  - `CODEX_PATH` comes before the login shell's PATH, which comes before the daemon's;
  - `can()` is true for an app session with only the app CLI;
  - the run's environment is `oneShotParentEnv()` with PATH login-then-daemon and `CODEX_HOME` the daemon's;
  - the login shell is read on first use, never at creation and never on Windows;
  - Windows still never runs it.
- `observed.spec.ts`: an app session whose queue fails definitively answers the app copy. Another session answers the
  other copy. The log line names `app` or `path`.
- End to end, `cli/e2e/deviceCodex.e2e.ts`: a ChatGPT-app Codex session, with the PATH `codex` exiting 127 and a fake
  app CLI under a test root, takes the dial's words through the app CLI: one queue call, the right thread and words
  (macOS only, `it.skipIf(process.platform !== 'darwin')`, as `dialAppFilter.e2e.ts` skips).
  `cli/e2e/dialAppFilter.e2e.ts`: a dial that attaches over an app's ring gets a `focus` on its first agent.
- The test root for the app CLI comes in the way Orca's app launcher does (`HARNESS_ORCA_APP_BIN`,
  `devices/orcaHomes.ts`): one environment variable for the end-to-end suite, read nowhere else.

## Platforms

macOS (both parts), Linux and Windows (A only; B's app CLI is macOS-only, and Windows never runs `codex queue`).

## Out of scope, follow-ups

- Firmware: on an app's ring, a list with agents never leaves `s.active = -1` (the same rule as A, on the dial). Its own
  item, with an OTA (PM, 2026-11-18).
- The tab flipping seen at 16:50:20-16:51:03: `swarms → 2 (on 84f4…)` and `(on 2122…)` alternate every few seconds,
  likely two Desktop windows each reporting their active tab. Its own item if the PM wants it.

## Open (asked of the person through the PM)

- `ls -l "$(command -v codex)"; head -1 "$(command -v codex)"; command -v node` in their Terminal: which `codex` exits
  127. With an npm shim and no node, B.2 also fixes their terminal Codex sessions. With a dead shim, only B.1 does.
- The cable lines around 16:49:50-16:50:25: whether the face was emptied by an attach (A covers it) or by something A
  does not cover.
