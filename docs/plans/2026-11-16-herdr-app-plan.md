# The dial lists, follows, talks to and switches Herdr's agents through Herdr Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(devices): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** With Herdr open on this Mac, every agent its window shows is on the dial with its live state, hook or no hook; a tap, and a swipe while Herdr is in front, switch Herdr's window to that agent's terminal; the dial's words reach it as its next prompt, only while it is idle or done. And a stale herdr 0.8.0 socket is said once and never retried.

**Architecture:**
- **One client** (`cli/src/cable/hosts/hcClient.ts`, new) speaks Herdr Core's socket (`hc`, JSON-RPC 2.0, one message a line): `hello`, one held `events.subscribe`, and `terminal.get` then `terminal.send` for words. It checks the socket's owner, bounds every line, and never throws or logs.
- **One source** (`cable/hosts/hcSource.ts`, new, id `herdr-app`) lists the terminals Herdr's window shows from that subscription. It runs only while a dial is attached, on macOS, pushed and never polled.
- **The Herdr adapter** (`cable/hosts/herdrApp.ts`, new, id `herdr-app`): a tap is `open -b dev.herdr.app` then `herdr-app do agent.focus --terminal <t>`; a swipe is `agent.focus` alone; words go through the client.
- **What both herdrs share is one copy:** the line connection, the socket's stamp and the folder watch move to `cable/hosts/unixSocket.ts`; the wait, the retries and the stale rule (with its one retry for a socket under 2 s old) move to `cable/hosts/socketAttempts.ts` (spec Q6, Q8).
- **The hook** sends `HC_TERMINAL_ID`, and `hostDetect.ts` reads it as `herdr`, so a hooked agent in Herdr is on the herdr page and folds with the listed copy by its pane key `herdr-app:<address>`.
- Everything is in the devices process and the hook. Nothing goes through the core, and nothing is stored.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`) and the hook (`cli/hook/notify.mjs`). The recording and the end-to-end check run Herdr Core 0.1.21 as installed on this Mac, in a private session.

**Spec:** `docs/plans/2026-11-16-herdr-app-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, and the herdr 0.8.0 work this builds on (`docs/specs/2026-11-16-device-herdr.md`).

**Open questions:** none. The draft's five were answered (spec, "Answered after the draft plan", Q4 to Q8) and are folded into the tasks; see "Decided".

## Base

- `fix/herdr-socket-path` at `ae81a1f077` (`main` after #4340, with #4366). The spec is untracked there.
- The tasks name functions, never lines:
  - `cable/hosts/herdrClient.ts`: `connect`, `socketStamp`, `watchHerdrSocket`, `MAX_LINE_BYTES`, `HERDR_KIND`.
  - `cable/hosts/herdrSource.ts`: `connect`, `soon`, `open`, `started`, `listed`, `closed`, `fail`, `wait`, `changed`, `close`, `clear`, `shown`, `RETRIES_S`, `LIVE_MS`.
  - `herdrSource.spec.ts`: `setup`, `live`, `listRead`, `giveUp`, `LOG_LINE`.
  - `services/devices.ts`: `herdrAt`, `herdrClient`, `herdrAdapter`, `herdrNoted`, `noting`, `adapters`, `timerIn`, `voiced`, `herdr` (the source), `outsideTurn`, `dialAttached`, `registry`.
  - `devices.spec.ts`: `start`, `watched`, `herdr`, `herdrCalls`, `fakeListener`, and the herdr describe's `withHerdr`, `onMac`, `attach`, `listed`, `said`, `host`.
- If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The recording | `cli/src/testing/fakeHc.ts` (new), `docs/plans/2026-11-16-herdr-app-design.md` | none | xhigh | none: no behavior (a spike, one commit) |
| 2 One Unix socket file | `cli/src/cable/hosts/unixSocket.ts` (new), `unixSocket.spec.ts` (new), `herdrClient.ts`, `herdrClient.spec.ts`, `cli/src/services/devices.ts`, `devices.spec.ts` | none | high | `unixSocket.spec.ts` |
| 3 herdr 0.8.0's stale socket | `cli/src/cable/hosts/herdrSource.ts`, `herdrSource.spec.ts`, `cli/e2e/deviceHerdr.e2e.ts` | none | xhigh | `herdrSource.spec.ts` |
| 4 One way to wait on a socket | `cli/src/cable/hosts/socketAttempts.ts` (new), `socketAttempts.spec.ts` (new), `herdrSource.ts` | 3 | xhigh | `socketAttempts.spec.ts` |
| 5 `HC_TERMINAL_ID` is herdr | `cli/src/cable/hosts/hostDetect.ts`, `hostDetect.spec.ts` | none | medium | `hostDetect.spec.ts` |
| 6 The hook sends `HC_TERMINAL_ID` | `cli/hook/notify.mjs`, `cli/src/hookNotify.spec.ts` | 1 | high | `hookNotify.spec.ts` |
| 7 The hc client | `cli/src/cable/hosts/hcClient.ts` (new), `hcClient.spec.ts` (new), `cli/src/testing/fakeHc.ts` | 1, 2 | xhigh | `hcClient.spec.ts` |
| 8 The hc source | `cli/src/cable/hosts/hcSource.ts` (new), `hcSource.spec.ts` (new), `cli/src/testing/fakeHc.ts` | 4, 7 | xhigh | `hcSource.spec.ts` |
| 9 The Herdr adapter | `cli/src/cable/hosts/herdrApp.ts` (new), `herdrApp.spec.ts` (new), `adapter.ts`, `types.ts` | 7 | xhigh | `herdrApp.spec.ts` |
| 10 The devices run the hc source | `cli/src/services/devices.ts`, `devices.spec.ts` | 2, 5, 8, 9 | xhigh | `devices.spec.ts` |
| 11 End to end, a private Herdr Core | `cli/e2e/deviceHerdrApp.e2e.ts` (new), `cli/e2e/harness/hcCore.ts` (new) | 1, 10 | xhigh | none: no behavior (the end-to-end test of Tasks 5 to 10; a swipe, and a tap only through #4373's fake `open`) |
| 12 Say it in the docs | `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md`, `docs/specs/2026-11-16-device-herdr.md` | none | medium | none: no behavior |

Longest chain: 3 → 4 → 8 → 10 → 11 (or 1 → 7 → 8 → 10 → 11): five tasks.

- Tasks 1, 2, 3, 5 and 12 share no file and start at once. Tasks 8 and 9 share no file and run beside each other.
- `herdrSource.ts` is shared by Tasks 3 and 4. `devices.ts` and `devices.spec.ts` are shared by Tasks 2 and 10. `fakeHc.ts` is shared by Tasks 1, 7 and 8. Each pair is ordered by a dependency above.
- **Tasks that depend on what Task 1 finds:** 6 (the named-session variables), 7 and 8 (the recorded lines), 11 (how a private core is started and stopped). See "What Task 1 settles".

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/unixSocket.ts`, `socketAttempts.ts`, `hcClient.ts`, `hcSource.ts`, `herdrApp.ts`, `herdrClient.ts`, `herdrSource.ts`, `hostDetect.ts`, `adapter.ts`, `types.ts` | **Devices service process**, and only there | Their specs |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/hook/notify.mjs` | The hook: one file that ships alone, run by the agent | `src/hookNotify.spec.ts` |
| `cli/src/testing/fakeHc.ts` | Test: a fake Herdr Core on a Unix socket in a temp folder | none |
| `cli/e2e/deviceHerdrApp.e2e.ts`, `cli/e2e/harness/hcCore.ts`, `cli/e2e/deviceHerdr.e2e.ts` | Test: the real daemon, a fake dial, a private core | Verification 1 and 2 |
| The docs of Task 12 | Repo files, no process | none |

No file under `cli/src/core/` changes, and `cli/src/architecture.coreFiles.txt` gains no line (cli/AGENTS.md, Protect the core, rule 7). `cable/cableHost.ts`, `cableSession.ts`, `observed.ts`, `open.ts`, `registry.ts`, `herdr.ts` and `cli/vitest.setup.ts` do not change.

## Global Constraints

- **Never the person's own Herdr.** No task, spec or check stops, restarts or calls Diego's own hc (the default session), Herdr.app, `~/.config/herdr`, `~/.local/state/herdr-core/default` or herdr 0.8.0. None runs a bare `hc`, `herdr-core`, `herdr-app` or `herdr`, and none drives Herdr's real window. Herdr.app's layout doc (hc doc `herdr-app`) is never read or written. No process reads another process's environment.
- **The socket** (Task 1, F1). `HC_SOCKET` when it is absolute; else, with an absolute `XDG_RUNTIME_DIR`, `<XDG_RUNTIME_DIR>/herdr-core/<HC_SESSION>.sock`; else `<XDG_STATE_HOME>/herdr-core/<HC_SESSION>/<HC_SESSION>.sock`, a relative or unset `XDG_STATE_HOME` read as `~/.local/state`, an unset or invalid `HC_SESSION` read as `default`. From the devices process's own environment only. Before each connection it must be a socket owned by this user (`lstat`). A `socket` in hc's `config.toml` is not read.
- **Framing.** JSON-RPC 2.0, one message a line. An answer counts only under its own id. An error counts by its `data.kind` in `[a-z_]{1,64}`, never by its message. A request is one connection. The subscription's connection writes `hello` then `events.subscribe` together.
- **`hello`** with `generation: 1`. `unsupported_generation`, or any other generation, is `bad_answer`.
- **Bounds.** A line from hc, a request's or the subscription's: 8 MiB (its snapshot is one line with every terminal of the core). A request's deadline: 10 s (`RUN_TIMEOUT_MS`). A send's deadline: 75 s. A subscription that hears nothing for 45 s ends (`timeout`). At most 64 agents listed. Names cut to 64 characters, control characters removed. `cwd` cut to 4096 characters.
- **Forms.** An address is `/^t[0-9][0-9a-z]{0,15}$/`, never `machine/t7`. A kind is `HERDR_KIND`, `^[a-z][a-z0-9_-]{0,31}$`. A status is one of `idle`, `working`, `done`, `blocked`, `error`.
- **Kinds.** `claude-code` → `claude`, `codex` → `codex`. Any other app keeps its own word when it fits `HERDR_KIND`.
- **Listed.** A live terminal of this machine whose labels hold `herdr.space`, whose status is one of the five, and whose app gives a kind.
- **States.** `idle` is idle, and after `working` or `blocked` it is done with `unseenDone` false; `working` is working; `blocked` is needs-you; `done` is done with `unseenDone`; `error` is error.
- **Words.** 1 to `MAX_TEXT` (2,000) characters, control characters become spaces. `terminal.get` first: live, `idle` or `done`, the kind the caller named. Then `terminal.send`, with `if: "idle"` when it was idle and no `if` when it was done. Never `force`. `status_mismatch` is `busy`. A timeout is `no-answer`, and nothing is sent twice.
- **Tap and swipe.** A tap: `/usr/bin/open -b dev.herdr.app`, then `herdr-app do agent.focus --terminal <address>`. A swipe: `agent.focus` alone, with Herdr in front. No shell, the address checked again before the command, 10 s each. `herdr-app` is on `PATH`, else `/Applications/Herdr.app/Contents/MacOS/Herdr`.
- **Push, not poll.** One subscription. With no socket, a folder watch. Retries after `1, 2, 4, 8, 16, 32, 60` s, then only the watch.
- **A stale socket.** A socket refused on the first connection of an attempt, with nothing subscribed on that socket's stamp, is said once (`socket · stale`), starts no retry timer, and waits on the watch. A refusal after a subscription started on that stamp keeps the retries.
- **A young socket** (spec Q8). A socket whose ctime is under 2 s (`YOUNG_MS = 2_000`) before the source's wall clock (`now()`) when it refuses, with nothing subscribed on its stamp, gets one retry after 1 s (`retry · 1`) before its refusal counts as stale. One such retry per stamp. The age is read from the stamp; tests set it and the clock, and never sleep.
- **A stamp** is `<inode>:<ctime in ns>` (`socketStampOf`, both clients). A stamp of another form has no age, and is never young.
- **Log lines**, with no id, name, path or text: `[herdr] socket · none|stale|live` and `[herdr-app] socket · none|stale|live`, each said when it changes; `[herdr-app] listed · <n> agents`, `list · <fault>`, `closed · <reason>`, `retry · <seconds>`, `over · <n> left out`; `[herdr-app] focus · failed`.
- **Counters.** `[device] voice · herdr-app` when sent; `busy`, `waiting`, `too-long`, `no-answer` when refused.
- **The dial's sentences**, as the observed source says them: `<name> is busy. Say it when it is done.`, `<name> is waiting for your answer in herdr.`, `Too long. Say it shorter.`, `<name> did not answer.` A blocked agent's line is `Waiting for you · herdr`.
- **The hint.** `HC_TERMINAL_ID` joins `HOST_HINTS` and counts toward `MAX_HINTS` (10). The app id stays `herdr`: no seventeenth app.
- **The kill switch.** `HARNESS_DEVICE_OBSERVED=off` stops the hc source too. It runs only while a dial is attached, and only with Herdr installed.
- **Platforms.** macOS only for the hc client, source and adapter. Linux and Windows: no change.
- **Repo rules.** Test first, at the layer where the behavior lives. No fixed sleeps. Every list bounded. Comments say why. No spec touches the developer's daemon (18473), tmux server, dial or Herdr: every socket is a fake server's in a temp folder. Socket specs are `describe.skipIf(process.platform === 'win32')`. `src/services` stays at 100% per file.

## Review Focus

1. **Herdr is closed when the dial is tapped.** `open -b` returns before Herdr's window is up, so `agent.focus` may fail. Herdr still comes forward, the tap is not an error on the dial, and the log says `[herdr-app] focus · failed` once. Task 9, `agent.focus that fails after Herdr came forward is true, with one line and no address in it`. Whether the window then lands on the terminal is Verification 6 (Diego's own).
2. **Herdr saves its layout while the dial is attached.** A `doc` event of several MiB arrives on the subscription. It is dropped, the subscription stays, and the next status still reaches the dial. Task 7, `a 2 MiB doc line is dropped and the next event is still told; a line over 8 MiB closes the subscription oversize`.
3. **A core that is still starting.** Its socket is bound a moment before it listens. A core started after the dial was plugged in must still be listed with no daemon restart. The young socket's one retry covers the moment (spec Q8): Task 3, `a young socket whose server listens by the retry is followed as any other`, and the same in Task 4's and Task 8's specs; end to end, Task 11, `a core started after the dial is listed with no daemon restart, and goes when it stops`, and the same test of `deviceHerdr.e2e.ts` for herdr 0.8.0.
4. **An agent leaves its terminal, and another starts there.** The status clears when the shell returns, and the next agent may be another app. The row goes at once, and the next one is a new row with a new id, never the old one's state. Task 8, `a status that clears drops the row; another app at that address is another row with another id`.
5. **Words while a send is still under way.** hc holds a send up to 60 s behind a person's draft. A second transcript to that terminal is `busy`, and a send that times out is said once and never typed later by a retry. Task 7, `a send with no answer in 75 s is failed, timeout … nothing is sent again`; Task 9, `a second prompt to one terminal while one is under way is busy`.

## Decided (PM for Diego, 2026-11-16)

The spec's "Decided" section holds each: the scope (a Herdr Core adapter, with herdr 0.8.0's stale-socket fix kept in it); Q1 (tap and swipe are `herdr-app do agent.focus`, with `open -b dev.herdr.app` for a tap, no shell, the address checked); Q2 (only terminals labeled `herdr.space` that report an agent status are listed); Q3 (words only while idle or done, a 75 s deadline, a timeout is "no answer" and never sent again); `HC_TERMINAL_ID` counts toward the hint cap; Herdr.app's layout doc is never written.

Answered after the draft plan (the spec's "Answered after the draft plan", Q4 to Q8), and folded in:
- **Q4** The e2e never runs the real `/usr/bin/open`: it swipes through the fake `herdr-app`. The tap's two commands and their order are held by specs with a recording runner (Tasks 9 and 10). A tap goes into the e2e only through #4373's `HARNESS_OPEN_BIN` fake, and only when the feature branch already holds it (Task 11, step 1). A real tap, with Herdr open and closed, is Diego's own check before the merge (Verification 6).
- **Q5** The hook sends `HC_TERMINAL_ID` on macOS only (Task 6).
- **Q6** One shared file for the wait, the retries and the stale rule (Task 4), `herdrSource.spec.ts` passing unedited by the move.
- **Q7** Words to an errored agent: `<name> did not answer.`, counted `no-answer`. No new copy (Task 8).
- **Q8** A socket younger than 2 s (its ctime) gets one retry after 1 s before its refusal counts as stale, red test first, on injected clocks (Task 3, moved by Task 4, used by Task 8).

## Decided here, where the spec was silent

- **`unixSocket.ts` holds three things**, not the connection alone: `connectLines`, `socketStampOf` and `watchSocket` (herdr's `watchHerdrSocket`, renamed, its folders unchanged). Both clients need each, and a second copy would be a second way.
- **A request's connection writes no `hello`**: the spec's "a request is one connection". Task 1 confirms hc answers it (A3).
- **The subscription keeps each terminal's facts**, 1,024 at most, and tells a whole terminal after each change. So an event that names one fact needs no second read, the source never sees a line of hc's, and a terminal that gains `herdr.space` or its first status is listed from what was kept.
- **`cwd` is the foreground's** (`foreground.cwd`) when hc gives one, else the terminal's: a person may `cd` before they start an agent.
- **A terminal that is not live, or reports no app**, is `not_that_agent` to a prompt.
- **`list ·` and `closed ·`.** A subscription that ends before its snapshot because hc's answer was no snapshot of generation 1 (`rejected`, `bad_answer`) says `[herdr-app] list · <fault>`. Every other end says `closed · <reason>`.
- **A socket found stale at once says only `socket · stale`**: no `closed · refused` before it, as nothing opened.
- **`stale` is said only of a socket that refused.** A program that answers and never lists (another generation, a refusal) is given up on after the last retry as today, and is not called stale: its `list ·` and `closed ·` lines said why.
- **The stale rule needs one condition, not two.** "Refused, with nothing subscribed on that stamp" is always the attempt's first connection: a second one is opened only after a subscription started.
- **The socket's word is kept across a detach.** A dial plugged in again to the same state says nothing. Which stamp a subscription started on is forgotten at `stop()`.
- **The young socket's retry (Q8) lands in Task 3**, not Task 4: Task 3 owns the stale rule and edits `herdrSource.spec.ts`, and Task 4's move must leave that spec unedited, so the rule and its red tests come before the move. Task 4 moves it with the rest.
- **The young retry says `[herdr] retry · 1`** (the retries' own line) and no `closed · refused` before it: nothing opened, as for "stale at once". It does not count toward the `1 … 60` s ladder. Refused again, the stamp is stale at once.
- **One young retry per stamp, kept across a detach** as the socket's word is: a dial plugged in again within 2 s of a socket's birth gets no second retry, so the replug test of `deviceHerdr.e2e.ts` does not depend on how fast the daemon starts. Only the last stamp given its retry is kept.
- **A ctime ahead of `now()` is not young** (a clock set back is no socket being born). So the specs' fixed wall clock (`WALL`, 2023) keeps every real socket of the fake servers old, and only a test that sets a stamp's ctime meets the young rule. `stampAt(ms)` in the specs is `` `7:${BigInt(ms) * 1_000_000n}` ``.
- **The age is read from the stamp** (`bornAt(stamp)`: its ctime in ms, none for another form) rather than a second `lstat` or a new client member: the stamp is already read at each refusal, and Task 3 then touches no file Task 2 does. Task 2's spec pins the stamp's form.
- **`HC_SESSION` is valid** as `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- **When `open -b` fails, `agent.focus` does not run**, and the tap is false. With no `herdr-app` binary, Herdr still comes forward and the line is `focus · failed`.
- **One run per terminal** answers both verbs: `focus` reads whether Herdr came forward, `show` whether `agent.focus` exited 0.
- **Every listable terminal is kept** (the client's 1,024), and the first 64 are listed. So when one leaves, the next is listed with no new snapshot. `over` is said when its number changes.
- **`HC_TERMINAL_ID` sits after `HERDR_PANE_ID` in `HOST_HINTS`**, and after `TMUX_PANE` in `detectHost`: a multiplexer inside an hc terminal is the nearer host.
- **The adapter has no pane off macOS**, so nothing there can change.
- **The hook's rule reads `HC_SESSION` alone.** A core on its own `HC_SOCKET` under the default name is not told apart: the devices process, started by launchd, would not see that `HC_SOCKET` either.
- **The devices' test seam is the client** (`DevicesDeps.hc`), as `DevicesDeps.herdr` is.
- **One end-to-end test for the stale herdr socket** goes in `deviceHerdr.e2e.ts`, in a describe that needs no herdr installed: it is the fix a person sees.
- **The docs task** is not in the spec. `cli/AGENTS.md` lists what the devices process does.

## What Task 1 settles

The spec read hc's help and schema (0.1.21) and no line from a running core. This plan is written to the left column. Task 1's report ends with `assumptions: all hold`, or the ones that do not.

| | The plan assumes | Used by | If the private core says otherwise |
|---|---|---|---|
| A1 | The socket rule of "Global Constraints" | 7 | Stop and report |
| A2 | Requests are `{"jsonrpc":"2.0","id","method","params"}`. `hello {generation}` answers `{generation, …}` or `unsupported_generation`. `events.subscribe {}` answers `{seq, terminals}`. `terminal.get {terminal}` answers a terminal. `terminal.send {terminal, text, if?}` answers `{turn, …}`, or `status_mismatch`, `blocked`, `finished`, `not_found` | 7 | The recorded line wins, and the findings say what differs. A method or field named here that hc lacks: stop and report |
| A3 | A request on a connection that sent no `hello` is answered | 7 | Stop and report |
| A4 | A terminal has `address`, `state` (`live`, `finished`), `labels`, `status` (`{state, app}` or null), `name`, `cwd`, `foreground.cwd` | 7, 8 | The recorded line wins |
| A5 | After the snapshot come `event`, `heartbeat` and `missed` notifications. An event names its kind, its `seq` and its terminal | 7 | The recorded line wins. Finding F5 says, kind by kind, which fields a line carries |
| A6 | The private core's launchd label names its session and is gone after its own `hc server stop` | 11 | **Stop and ask the orchestrator** (PM): no e2e then starts a core |
| A7 | A terminal of a named session has `HC_SESSION=<name>` in its environment | 6 | Stop and report |
| A8 | `HC_TERMINAL_ID` fits `/^t[0-9][0-9a-z]{0,15}$/` | 6, 9 | Stop and report |
| A9 | A program run directly keeps the status it reports | 11 | Stop and report |

The tasks that use an assumption that does not hold wait for this plan's update.

---

### Task 1: The recording

**Layer:** test fixture and the spec. **Depends on:** none. **Effort:** `xhigh` (it starts a program on the person's Mac, beside their own session).

**Red test:** none: no behavior. A spike: its scripts are thrown away, its fixture and its findings are kept. One commit.

**Files:**
- Create: `cli/src/testing/fakeHc.ts`
- Modify: `docs/plans/2026-11-16-herdr-app-design.md` (a `## Task 1 findings` section, appended)

**Rules of the spike (PM, binding):**
- Every `hc` is run through the wrapper of step 1, and only as these: `--version`, `--help`, `<command> --help`, `--skill`, `schema`, `server start`, `server status`, `server stop`, `run`, `ls`, `get`, `label`, `kill`, `rm`. Never `update`, `machine`, `attach`, `server restart`.
- Never `herdr-app`, never `herdr`, never `launchctl` with anything but `list`, never `kill` on a process the spike did not start as its own child.
- The scratch scripts speak to the private core's socket and to no other. hc's own guide asks the same of a test: its own `HC_SESSION` and scratch XDG paths.
- The fake agent reads its own environment only. Nothing reads another process's.
- **Stop and ask the orchestrator**, after stopping the private core through its own session, when:
  1. a `dev.herdr.core.*` label that appeared does not hold the private session's name;
  2. a label that appeared is still listed 30 s after the private `hc server stop`;
  3. the core is not a child of the spike's shell and no label that appeared holds the session's name;
  4. the core's pid or one of its holders' (`pid` and `holders[].pid` of its own `server status`, read before the stop) still runs 30 s after the stop (`ps -p`);
  5. an assumption marked "stop" in "What Task 1 settles" does not hold.

  In each case the report names the label and the pids. The spike removes no job and ends no such process.

**Interfaces:**
- Produces, in `cli/src/testing/fakeHc.ts`, a server that behaves as the spike saw hc 0.1.21 behave:
  ```ts
  /** A terminal as a spec names one; the fake writes it as hc writes a terminal (RECORDED). */
  export interface FakeHcTerminal {
    address: string
    state?: 'live' | 'finished'                          // live
    labels?: Record<string, string>                      // { 'herdr.space': 's1' }
    status?: { state: string; app?: string } | null      // { state: 'idle', app: 'claude-code' }
    name?: string | null                                 // null
    cwd?: string                                         // '/work/api'
    /** Any other field of hc's terminal, written as given. */
    more?: Record<string, unknown>
  }
  /** What a method answers: a result, hc's error by its `data.kind`, bytes as they are, nothing with the connection
   *  held open (`hold`), or nothing with it ended (`close`). */
  export type FakeHcAnswer = { result: unknown } | { error: string } | { raw: string } | 'hold' | 'close'
  export interface FakeHcRequest { connection: number; request: unknown }
  export interface FakeHc {
    readonly path: string                                // <a fresh temp folder>/hc.sock
    /** The terminals it holds: the snapshot, `terminal.get` and `terminal.send` answer from these. */
    terminals: FakeHcTerminal[]
    readonly requests: readonly FakeHcRequest[]
    readonly connections: number
    got(method: string, n: number): Promise<FakeHcRequest>
    ended(connection: number): Promise<void>
    answer(method: string, answer?: FakeHcAnswer): void
    /** Changes a terminal it holds, or adds one, and tells each live subscription as hc does: the `event` lines hc
     *  writes for that change, in the recorded shape, each with the next `seq`. */
    change(address: string, to: Partial<FakeHcTerminal>): void
    /** hc's `removed`. */
    remove(address: string): void
    /** An `event` of a kind that changes no terminal here (`doc`, `size`, `title`, `turn`, `keep`), as recorded. */
    event(kind: string, body?: Record<string, unknown>): void
    heartbeat(): void
    /** `missed`, then a fresh snapshot of `terminals`, as recorded. */
    missed(): void
    send(raw: string | Uint8Array): void
    drop(): void
    stop(): Promise<void>
    stale(): Promise<void>
    start(): Promise<void>
  }
  export function fakeHc(): Promise<FakeHc>
  /** What hc 0.1.21 wrote in the spike, line by line: folders read /work/hh, the core is `core`, ids and times are fixed. */
  export const RECORDED: {
    hello: string; helloRefused: string
    /** A subscription from its answer on: the snapshot (the agent's terminal and a hidden worker's), then the scenario. */
    subscription: string[]
    get: string; getUnknown: string
    sent: string; mismatch: string; blocked: string; finished: string
    /** `missed` and what follows it; absent when the spike could not provoke one. */
    missed?: string[]
    /** The agent's address and the worker's, as the lines name them. */
    agent: string; worker: string
  }
  ```
  - It answers `hello` (`unsupported_generation` for any generation but 1), `events.subscribe` (a snapshot of `terminals`, then the connection carries notifications only), `terminal.get` (`not_found` for an address it does not hold) and `terminal.send` (`not_found`, `finished`, `blocked` for a blocked terminal, `status_mismatch` when `if` is not its status; else `RECORDED.sent`'s shape). Any other method: hc's answer to an unknown method, as recorded.
  - `got`, `ended`, `stale` and `start` work as `fakeHerdr.ts`'s do, so no spec polls it.
  - Where the spike could not record a line (`missed`), the fake writes the nearest recorded shape and a comment says it is an assumption.

- [ ] **Step 1: The scratch root, the wrapper, and the labels before.** Before any `hc` runs:
  ```sh
  ROOT=$(mktemp -d /tmp/hh-XXXXXX)          # short: a socket path must fit sun_path (104 bytes)
  mkdir -p "$ROOT/home" "$ROOT/state" "$ROOT/config" "$ROOT/data" "$ROOT/cache" "$ROOT/run" "$ROOT/work/hh"
  S=harness-$(openssl rand -hex 4)
  launchctl list | awk '$3 ~ /^dev\.herdr\.core\./ { print $3 }' | sort > "$ROOT/labels.before"
  ```
  The wrapper, `$ROOT/hc` (mode 700), with `ROOT` and `BIN` (`realpath ~/.local/bin/herdr-core`) written in as its first two lines:
  ```sh
  #!/bin/sh
  # Every hc of the spike: a private session, and nothing of the person's (no HC_*, XDG_* or HOME of the shell).
  case "$HC_S" in harness-*) ;; *) echo "no private session" >&2; exit 64 ;; esac
  exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin USER="$USER" LOGNAME="$USER" SHELL=/bin/sh \
    TERM=xterm-256color LANG=en_US.UTF-8 HOME="$ROOT/home" XDG_STATE_HOME="$ROOT/state" \
    XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$ROOT/cache" \
    XDG_RUNTIME_DIR="$ROOT/run" HC_SESSION="$HC_S" ${HC_SOCK:+HC_SOCKET="$HC_SOCK"} "$BIN" "$@"
  ```
  It is run as `HC_S=$S HC_SOCK=$ROOT/c.sock "$ROOT/hc" …`. `--version` prints `0.1.21`; another version is recorded as it is. Any `hc` command may start the core, so the labels are noted first.
- [ ] **Step 2: Start, and the label.** `"$ROOT/hc" server start`. Then the labels again, and the ones that appeared (`comm -13`). Check stop conditions 1 and 3. Record: the command, the label with the session's name replaced, the core's pid, its holders' pids and its parent pid (`server status`, `ps -o ppid= -p`), where the socket is (`ls -la "$ROOT/c.sock"`), and whether `hc server start --help` or `hc --help` names a way to run the core in the foreground as a child.
- [ ] **Step 3: The lines.** A scratch Node script writes to the socket and appends every line that comes back, with its arrival time, to a file under `$ROOT`:
  - `hello` with `generation: 1`, and with `generation: 2`;
  - `terminal.get` on a connection that sent no `hello` (A3);
  - `hello` then `events.subscribe`, the connection held for the whole scenario.
- [ ] **Step 4: The fake agent and the scenario.** A scratch Node script, started by `terminal.run` with `argv` (its absolute `node` and its path: no shell, whose return clears status), `cwd` `$ROOT/work/hh`, labels `{ "herdr.space": "s1" }`:
  - it writes each name and value of its own environment that starts `HC_`, and `TERM_PROGRAM` and `__CFBundleIdentifier`, to a file under `$ROOT`;
  - it reports status as hc's own guide tells a program to (OSC 7501: the exact bytes from the private `hc --skill` or `--help`), with app `claude-code`;
  - it prints `fake> `, and `GOT[<line>]` for each line it reads;
  - a line on a Unix socket of its own under `$ROOT` is the status it reports next.

  With a second terminal, a hidden worker (`/bin/sleep 600`, no label), four parts, in this order:
  1. **The scenario**, on step 3's held subscription, which is closed after it: the agent `working`, `blocked`, `working`, `done`, `idle`, `error`, `idle`; the worker gains `herdr.space=s1`, then loses it; the worker is killed, then removed; `doc.set` on the key `harness-spike` (never `herdr-app`), once small and once about 200 KiB; one `heartbeat` (awaited, 20 s at most); a `size` event if a plain request can cause one. These lines are `RECORDED.subscription`.
  2. **The requests**, each on a connection of its own, with no subscription open: `terminal.get` of the agent, and of `t99`; `terminal.send` to the idle agent with `if: "idle"` (the answer, and how long it took); to the working agent with `if: "idle"`; to the blocked agent with no `if`; to the agent while `done` with no `if`; to the removed worker.
  3. **`missed`**, on a new subscription: the subscriber stops reading while the agent reports 20,000 changes, then reads again (30 s at most, else "not provoked").
  4. **The exit:** the agent is told to exit, then `terminal.get` of it.
- [ ] **Step 5: Stop, and the label again.** `"$ROOT/hc" server stop`. Wait until the socket refuses or is gone. The labels now equal `labels.before`, line for line. Check stop conditions 2 and 4.
- [ ] **Step 6: The socket with no `HC_SOCKET`.** A second session name, `HC_SOCK` unset: steps 2 and 5 again, with the agent started once for its environment file. Record where the socket landed under `$ROOT/state` (A1).
- [ ] **Step 7: Write `fakeHc.ts`** as "Interfaces" says, and the findings, numbered:
  - **F1** where the socket landed, with and without `HC_SOCKET`;
  - **F2** how the core started and stopped, its label's form, and the start the e2e may use (the launchd job when A6 holds; a foreground child if hc has one, said for the orchestrator; else none);
  - **F3** the agent's variables in both sessions, names and redacted values;
  - **F4** `hello`'s answers, and whether a request with no `hello` was answered;
  - **F5** every notification kind seen, and for each the fields its line carries (the whole terminal, or which facts);
  - **F6** each `terminal.send` answer and how long the taken one took;
  - **F7** the status report's bytes, and what the terminal reads after its program exits (part 4);
  - **F8** what was not recorded and is assumed in the fake.

  Every path, user name, host name, core id, pid and session name is replaced (`/work/hh`, `core`, `harness-test`, fixed numbers). `grep -n "$USER\|$(hostname -s)\|/Users/\|/tmp/hh-" cli/src/testing/fakeHc.ts docs/plans/2026-11-16-herdr-app-design.md` prints nothing.
- [ ] **Step 8: Clean up and check.** Both sessions' cores and holders are gone (`ps -p` of the pids noted) and the labels equal `labels.before`. Then `rm -rf "$ROOT"`. `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 9: Commit** `test(devices): a fake Herdr Core server, from lines recorded on a private core`. If the spec is still untracked, this commit adds it.

### Task 2: One Unix socket file

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (a move across six files; `services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/cable/hosts/unixSocket.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/unixSocket.ts`, `cli/src/cable/hosts/unixSocket.spec.ts`
- Modify: `cli/src/cable/hosts/herdrClient.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/cable/hosts/herdrClient.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces, in `unixSocket.ts`:
  ```ts
  export type LineEnd = 'refused' | 'ended' | 'oversize'
  /** One connection that writes `out` once connected, and tells each line that comes back, in order, until the socket is
   *  destroyed. `end` says why it ended: a line past `maxLineBytes` as soon as it is past, before the rest is read. */
  export function connectLines(path: string, out: string, maxLineBytes: number,
    line: (text: string) => void, end: (fault: LineEnd) => void): Socket
  /** The socket's inode and change time while it is a socket of that user's; else none. */
  export function socketStampOf(path: string, uid: number): string | undefined
  /** herdrClient.ts's watchHerdrSocket, as it is: the nearest existing folder of the socket's, its parent and `home`. */
  export function watchSocket(at: { socketPath: string; home: string }, changed: () => void): () => void
  ```
- What moves, and nothing is copied:
  - `herdrClient.ts`'s `connect` becomes `connectLines`, its bound a parameter. Both of the client's calls pass `MAX_LINE_BYTES`.
  - The body of the client's `socketStamp` becomes `socketStampOf`. The client's own keeps its Windows answer and calls it.
  - `watchHerdrSocket` becomes `watchSocket`. `herdrClient.ts` exports it no more.
  - `devices.ts` imports `watchSocket` from `unixSocket.js`.
  - `devices.spec.ts`'s `vi.mock` of the watch names `../cable/hosts/unixSocket.js` and `watchSocket`. No expectation changes.
  - The three watch tests of `herdrClient.spec.ts` move to `unixSocket.spec.ts`, their expectations as they are.

- [ ] **Step 1: Write the failing tests** in `unixSocket.spec.ts`, `describe.skipIf(process.platform === 'win32')`, on a `net` server of the test's own in a temp folder.
  - `it writes out once connected, and tells each line in order; a line split across two chunks is told once`.
  - `a line of the bound it was given is told; one byte more ends oversize, before its newline comes`: bound 16.
  - `a connection that never opened ends refused; one the server closed ends ended`.
  - `socketStampOf is none for no file, a file that is no socket and another user's socket; another once a server starts again at the same path`.
  - `socketStampOf is <inode>:<ctime in ns>, which the sources read a socket's age from`: it matches `/^\d+:\d+$/`, and equals `` `${s.ino}:${s.ctimeNs}` `` of `lstatSync(path, { bigint: true })`.
  - The three watch tests, moved.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/unixSocket.spec.ts`. Expected: FAIL (no `./unixSocket.js`).
- [ ] **Step 3: Implement** the move. The file's header says why it is one file (two programs' sockets, one way to reach each).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`, and no expectation of `herdrClient.spec.ts`, `herdrSource.spec.ts` or `devices.spec.ts` edited. Then `git grep -n "watchHerdrSocket" -- cli` prints nothing.
- [ ] **Step 5: Commit** `devices: one file for another program's Unix socket: its lines, its stamp, its watch`.

### Task 3: herdr 0.8.0's stale socket

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (a reconnect state machine: timers, a watch, late answers).

**Red test:** `cli/src/cable/hosts/herdrSource.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/herdrSource.ts`
- Test: `cli/src/cable/hosts/herdrSource.spec.ts`, `cli/e2e/deviceHerdr.e2e.ts`

**Interfaces:**
- Produces, in `herdrSource.ts` (no signature changes):
  - The source keeps the stamp a subscription last started on (`started` sets it, `stop` forgets it).
  - **Stale at once:** `closed` with `refused`, when no subscription started on the attempt's stamp: no `closed` line, no retry timer; it waits on that stamp (`wait(this.stamp)`), as after the last retry today.
  - **Young, first** (spec Q8): that same refusal, when `bornAt(stamp)` is `B`, `0 <= now() - B < YOUNG_MS`, and the stamp has not had its young retry: no `closed` line; it says `[herdr] retry · 1`, notes the stamp as given its retry, and connects again after 1,000 ms (`after`). The retries' count does not move. A refusal then is stale at once.
    - `const YOUNG_MS = 2_000`; `bornAt(stamp: string | undefined): number | undefined`, `Number(BigInt(<second part>) / 1_000_000n)` when the stamp is `/^\d+:\d+$/`, else none. Both private to the file until Task 4 moves them.
    - The stamp given its retry is kept across `stop`, one stamp at most.
  - A refusal on a stamp a subscription started on, and every other fault, keep today's path.
  - **The socket's word**, each said when it differs from the last one said, and kept across `stop`:
    - `[herdr] socket · none` when it waits with no socket;
    - `[herdr] socket · stale` when it waits on a socket whose last attempt was refused (at once, or after the last retry);
    - `[herdr] socket · live` when a subscription starts.

    A wait after the last retry of any other fault (a herdr that answers, and not with a list) says no word: its `list ·` or `closed ·` lines said why.

- [ ] **Step 1: Write the failing tests.** The fake's `stale()` renames the socket, which changes its stamp. So a test that means "the server died and left its socket" holds the stamp still: `setup({ client: { ...real, socketStamp: () => old } })`, with `real = herdrClient()` and `old = stampAt(WALL - 60_000)`. `stampAt` is the spec's own helper ("Decided here"). A real socket's ctime is after `WALL`, so it is never young.
  - New, the red test: `a stale socket is said once, and nothing retries`. The stamp held at `old`. `await server.stale()`, `start()`, `await s.until(() => s.watchers.size === 1)`. Then `s.log` is `['[herdr] socket · stale']`, `s.timers` is `[]`, `server.connections` is `0`; after `s.fire()` and `s.advance(120_000)` all three are the same.
  - New, red: `a socket younger than 2 s that refuses is tried once more after 1 s, then is stale`. The stamp held at `stampAt(WALL - 500)`, `await server.stale()`, `start()`. `s.log` is `['[herdr] retry · 1']` and `s.timers` one of 1,000 ms. `s.advance(1_000)`, then `await s.until(() => s.watchers.size === 1)`: `s.log` is `['[herdr] retry · 1', '[herdr] socket · stale']`, `s.timers` is `[]`.
  - New, red: `a young socket whose server listens by the retry is followed as any other` (Review Focus 3). The stamp held at `stampAt(WALL - 500)`, one agent, `await server.stale()`, `start()`, then `await server.start()` and `s.advance(1_000)`: the agent is listed, and `s.log` is `['[herdr] retry · 1', '[herdr] socket · live', '[herdr] listed · 1 agents']`.
  - New, red: `a socket 2 s old, or with a ctime ahead of the clock, is stale at once`: the stamp held at `stampAt(WALL - 2_000)`, and at `stampAt(WALL + 5_000)`: each `['[herdr] socket · stale']`, no timer.
  - New, red: `a socket gets its one young retry once, across a detach too`: as the young test, to `socket · stale`; then `stop()`, `start()` and `s.advance(1_000)` add no log line and no timer.
  - New: `a socket refused after a subscription started on it keeps the retries, then is stale, said once`. The stamp held at `stampAt(WALL - 500)` (young, which a started subscription overrules), one agent, live, then `server.stale()`. The log from the drop on is `closed · ended`, `retry · 1`, then `closed · refused` and `retry · <n>` for 2, 4, 8, 16, 32 and 60, then `closed · refused`, `[herdr] socket · stale`; `s.timers` is `[]`.
  - New: `the socket's word is said when it changes, never twice`. No socket: `['[herdr] socket · none']`. `stop()` and `start()` add nothing. The server starts and the watch fires: `socket · live` follows. A drop and a retry that lists add no second `live`.
  - New: `a herdr that answers and never lists is given up on after the last retry, and is not called stale`. `agent.list` answers `refusal('agent_not_found')` every time: after the 60 s retry fails the watch is held, no timer runs, and the log holds `socket · live` and no `socket · stale`.
  - Replaced by the first: `a refused connection retries after 1, 2, 4, 8, 16, 32 and 60 s, then waits on the watch with no timer`. `giveUp` goes with it.
  - Changed, and only these:
    - Each expectation of the whole log, where a subscription started, gains `'[herdr] socket · live'` as its first line: `started with herdr running …`, `65 agents …` (both), the two `list · rejected` tests, and `stop while the list is in flight …`, whose log is that one line.
    - `after giving up, a change beside the same stale socket connects nothing …`: it awaits the watch in place of `giveUp`, and `s.log.slice(said)` is `['[herdr] socket · live', '[herdr] listed · 1 agents']`.
    - `a dropped subscription keeps its agents until the first retry …`: the stamp held at `old`. Its expectations stay.
    - `a herdr that starts again while the last retry fails is tried within the second`: the retries' loop goes. `moved = true` right after `start()`, then `await s.until(() => s.timers.length === 1)`. The rest stays.
    - `LOG_LINE` gains `socket · (none|stale|live)`.
  - `deviceHerdr.e2e.ts`, a new describe that is not skipped without herdr: `a stale herdr socket is said once, and nothing retries`. The daemon's `bin` holds a `herdr` that only exits 0 (so herdr reads installed). `<home>/.config/herdr/herdr.sock` is a socket bound and left by a process that exited. A dial plugs in. The log gains `[herdr] socket · stale`, with at most one `[herdr] retry · 1` before it (the test's socket may still be under 2 s old when the dial plugs in; no wait makes it older). The dial unplugged and plugged in again (its list heard again) adds no `[herdr] socket` and no `[herdr] retry` line.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdrSource.spec.ts`. Expected: FAIL in the new and changed tests only.
- [ ] **Step 3: Implement.** The comment over the rule says why a refusal with nothing subscribed is no server (the socket of Aug 20 on the Mac this was found on: retried from 1 s to 60 s at every plug-in), why a socket under 2 s old gets one retry (a server binds a moment before it listens), and why a refusal after a subscription still retries (a herdr that is starting again on the same file).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck`. Expected: PASS, `devices.spec.ts` unedited. Then, on this Mac, `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdr.e2e.ts`. Expected: PASS, the new test not skipped.
- [ ] **Step 5: Commit** `devices: a stale herdr socket is said once and never retried, a newborn one tried once more; the log says which socket answered`.

### Task 4: One way to wait on a socket

Spec Q6: one file both sources use.

**Layer:** devices service process. **Depends on:** Task 3 (the same file). **Effort:** `xhigh` (it moves a reconnect state machine out of working code).

**Red test:** `cli/src/cable/hosts/socketAttempts.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/socketAttempts.ts`, `cli/src/cable/hosts/socketAttempts.spec.ts`
- Modify: `cli/src/cable/hosts/herdrSource.ts`

**Interfaces:**
- Produces, in `socketAttempts.ts`:
  ```ts
  export const RETRIES_S = [1, 2, 4, 8, 16, 32, 60]
  export const LIVE_MS = 60_000
  /** A socket this young may be bound before its server listens: its first refusal is tried once more (spec Q8). */
  export const YOUNG_MS = 2_000
  /** A stamp's ctime in ms (`<inode>:<ctime in ns>`, unixSocket.ts socketStampOf); none for another form. */
  export function bornAt(stamp: string | undefined): number | undefined
  export interface SocketAttemptsDeps {
    /** The word its lines start with, in brackets: `herdr`, `herdr-app`. */
    name: string
    socketStamp(): string | undefined
    watch(changed: () => void): () => void
    after(ms: number, run: () => void): () => void
    /** The wall clock, which a socket's ctime is read against. */
    now(): number
    monotonic(): number
    log(line: string): void
    /** Opens an attempt on the socket that is there. */
    open(): void
    /** Ends the attempt under way: its connections and its own timers. */
    close(): void
    /** Drops what was listed: another socket, a retry that failed, a wait. */
    clear(): void
  }
  export class SocketAttempts {
    constructor(deps: SocketAttemptsDeps)
    /** Looks for the socket: waits on the watch with none, else opens an attempt. */
    start(): void
    /** Its timer and its watch go; its retries and the stamp a subscription started on are forgotten. */
    stop(): void
    /** A subscription started on the socket: `socket · live`. */
    started(): void
    /** The attempt listed: its agents are followed from now. */
    listed(): void
    /** The attempt failed, by the client's word. It says `<said> · <fault>`, unless it is a refusal with nothing
     *  started on its stamp: then `retry · 1` once for a young socket, else stale at once. */
    failed(said: 'closed' | 'list', fault: string): void
  }
  ```
- What moves out of `HerdrSource`, as Task 3 left it: `connect`, `fail`, `wait`, `changed`, the retry timer, the young rule, and the fields they keep (the stamp, the stale stamp, the stamp a subscription started on, the stamp given its young retry, since when it is live, the retries, the socket's last word). `RETRIES_S`, `LIVE_MS`, `YOUNG_MS` and `bornAt` go with them. `HerdrSource` passes its own `now` as the attempts' `now`.
- What stays in `HerdrSource`: `soon` and its own timer, `open`, `started`, `listed`, `closed`, `close`, `clear`, `event`, `drop`, `read`, `status`. Each calls the attempts where it called the moved methods.
- `herdrSource.ts` now exports `shown`, `MAX_AGENTS` and `MAX_CWD`, for Task 8.

- [ ] **Step 1: Write the failing tests** in `socketAttempts.spec.ts`: fake `deps` only (a stamp the test sets, a watch it fires, a timer queue it runs, a wall clock and a monotonic clock it sets), and no socket.
  - `its lines start with the name it was given`: `name: 'herdr-app'` says `[herdr-app] socket · none`.
  - `with no socket it says none once, watches, and opens when a socket appears`.
  - `a refusal with nothing started on that stamp says stale once and no closed line, starts no timer, and opens only for another stamp`.
  - `a failure after a start says its line and retries after 1, 2, 4, 8, 16, 32 and 60 s`: `failed('closed', 'ended')` says `[herdr-app] closed · ended`, then `[herdr-app] retry · 1`. After the last retry, refused: `socket · stale`.
  - `failed('list', 'bad_answer') says list · bad_answer; given up on after the last retry, it says no word`.
  - `the wait goes back to 1 s only after it was listed for 60 s`.
  - `a drop keeps what was listed for the first retry; a retry that fails clears it; another stamp clears it before it opens`.
  - `stop cancels its timer and its watch; started again it says no word it said last`.
  - `bornAt reads a stamp's ctime in ms, and none of another form`: `'7:1700000000123456789'` is `1_700_000_000_123` (whole ms, read as a BigInt: ns past 2^53 lose digits as a Number); `'one'`, `''`, `'7:'`, `':5'`, `'7:5:5'` and undefined give none.
  - `a refusal on a socket younger than 2 s by now() is tried once after 1 s, then stale`: the stamp `stampAt(now - 500)`, `failed('closed', 'refused')` with nothing started: the log is `['[herdr-app] retry · 1']`, one timer of 1,000 ms; run, `open()` called again, refused again: `[herdr-app] socket · stale`, no timer.
  - `2 s old, a ctime ahead of now(), or a stamp of no ctime is stale at once`: `stampAt(now - 2_000)`, `stampAt(now + 5_000)`, `'one'`.
  - `a young socket's one retry is not one of the 1 … 60 s, and is not given again after stop`: after the young retry a start and a drop say `retry · 1` from the ladder's start; `stop()` and `start()` on the same stamp, refused: stale at once, no timer.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/socketAttempts.spec.ts`. Expected: FAIL (no `./socketAttempts.js`).
- [ ] **Step 3: Implement** the move. The comments that say why (herdr's log beside its socket, the 60 s that put the wait back, the stale rule, the young socket's one retry) move with their code.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck`. Expected: PASS, and **not one line of `herdrSource.spec.ts` or `devices.spec.ts` edited**. An expectation that has to change is a finding: stop and report it.
- [ ] **Step 5: Commit** `devices: the wait on another program's socket, its retries and its stale rule, in one file`.

### Task 5: `HC_TERMINAL_ID` is herdr

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/hostDetect.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts`
- Test: `cli/src/cable/hosts/hostDetect.spec.ts`

**Interfaces:**
- Produces, in `hostDetect.ts`:
  - `detectHost`: `HC_TERMINAL_ID` gives `herdr`, after `TMUX_PANE` and before `KITTY_WINDOW_ID`.
  - `detectApp`: `HC_TERMINAL_ID` gives `herdr`, before the bundle id and `TERM_PROGRAM` are read.
  - `APP_IDS`, `APP_BUNDLES` and `NAMES` do not change.

- [ ] **Step 1: Write the failing tests.**
  - `detectHost`'s table gains `[{ HC_TERMINAL_ID: 't7' }, 'herdr']`, `[{ HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' }, 'herdr']` and `[{ HC_TERMINAL_ID: 't7', __CFBundleIdentifier: 'com.mitchellh.ghostty' }, 'herdr']`.
  - `a multiplexer inside a Herdr terminal is the nearer host`: `REX_BLOCK`, `ZELLIJ` and `TMUX_PANE` beside `HC_TERMINAL_ID` give `rex`, `zellij` and `tmux`; `KITTY_WINDOW_ID`, `WEZTERM_PANE` and `ORCA_AGENT_SESSION_ID` beside it give `herdr`.
  - `an hc terminal is on herdr's page, whatever it says of its terminal`: `detectApp` is `herdr` for `{ HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' }`, with `__CFBundleIdentifier: 'dev.herdr.core'`, with `__CFBundleIdentifier: 'com.stablyai.orca'`, and with `TMUX_PANE: '%3'`.
  - `APP_IDS has 16 ids` stays as it is.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hostDetect.spec.ts`. Expected: FAIL (`ghostty`, `terminal`).
- [ ] **Step 3: Implement.** The comment says why it comes before `TERM_PROGRAM` (hc gives its programs `TERM_PROGRAM=ghostty`, and its own bundle is `dev.herdr.core`).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: an agent in a Herdr Core terminal is on herdr's page, not Ghostty's`.

### Task 6: The hook sends `HC_TERMINAL_ID`

Spec Q5: macOS only.

**Layer:** the hook. **Depends on:** Task 1 (A7 and A8: finding F3). **Effort:** `high` (what leaves the agent's process).

**Red test:** `cli/src/hookNotify.spec.ts`.

**Files:**
- Modify: `cli/hook/notify.mjs`
- Test: `cli/src/hookNotify.spec.ts`

**Interfaces:**
- Produces, in `notify.mjs`:
  - `HOST_HINTS` gains `'HC_TERMINAL_ID'`, right after `'HERDR_PANE_ID'`.
  - `hostHints()` leaves it out, before the cap counts it, when `process.platform` is not `darwin`, or when the hook's own `HC_SESSION` is set and is not `default`.
  - Sent, it counts toward `MAX_HINTS` as every hint does. No other `HC_` variable is read or sent.
  - The comment over `HOST_HINTS` says what `HC_TERMINAL_ID` is (hc's address of the terminal, `t7`: an id, no credential), and why a named session's is left out (its addresses start again, and the devices follow the default session).

- [ ] **Step 1: Write the failing tests.**
  - The spec's copy of the list, `HINTS`, gains `'HC_TERMINAL_ID'` at the same place. `SENT` is new: `HINTS` as this platform's hook sends them (without `HC_TERMINAL_ID` off macOS). `panelessHints`, and each expectation that cuts the list to `MAX_HINTS`, read `SENT`. `noHints` still unsets every name of `HINTS`.
  - `runHook` deletes `HC_SESSION` from the environment it hands the hook, beside `HERDR_SESSION`, for the same reason.
  - `it.runIf(process.platform === 'darwin')`:
    - `sends HC_TERMINAL_ID from an hc terminal`: `{ ...noHints, HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' }` posts `hostHints` `{ TERM_PROGRAM: 'ghostty', HC_TERMINAL_ID: 't7' }`; the same with `HC_SESSION: 'default'`.
    - `leaves out HC_TERMINAL_ID in a terminal of a named hc session`: with `HC_SESSION: 'side'` and `HC_SOCKET: '/h/.local/state/herdr-core/side/side.sock'`, `hostHints` is `{}`, one event is posted, and the body does not match `/side/`.
    - `a named hc session's address takes none of the MAX_HINTS`: every name set and `HC_SESSION: 'side'`: the keys are `HINTS` without `TMUX_PANE` and `HC_TERMINAL_ID`, cut to `MAX_HINTS`.
  - `it.runIf(process.platform !== 'darwin')`: `off macOS HC_TERMINAL_ID is left out, and takes none of the MAX_HINTS`.
  - `lists its hint names in this order …` stays as it is: it reads the hook's own list.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/hookNotify.spec.ts -t "outside a pane"`. Expected: FAIL (the list, and on macOS the three new tests).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/hookNotify.spec.ts src/testing/daemonEnvironment.spec.ts src/architecture.environment.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `hook: an agent in a Herdr Core terminal says which terminal, in the default session only`.

### Task 7: The hc client

**Layer:** devices service process. **Depends on:** Tasks 1 (the fixture, A1 to A5) and 2. **Effort:** `xhigh` (a socket of another program; outside input; the dial's words).

**Red test:** `cli/src/cable/hosts/hcClient.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/hcClient.ts`
- Modify: `cli/src/testing/fakeHc.ts` (only what a spec needs that the recorded lines hold and the fake lacks)
- Test: `cli/src/cable/hosts/hcClient.spec.ts`

**Interfaces:**
- Consumes: `connectLines`, `socketStampOf` (Task 2); `HERDR_KIND`, `MAX_LINE_BYTES` (`./herdrClient.js`); `CONTROL`, `MAX_TEXT`, `RUN_TIMEOUT_MS` (`./orca.js`); `fakeHc`, `RECORDED` (Task 1).
- Produces:
  ```ts
  /** hc's address of a terminal of this machine, `t7`, `t1b`: never another machine's `vps/t7`. */
  export const HC_TERMINAL = /^t[0-9][0-9a-z]{0,15}$/
  /** The key a hooked copy and a listed copy of one agent share (registry.ts). */
  export const hcPaneKey = (address: string): string => `herdr-app:${address}`

  export interface HcClientDeps { socketPath: string; home: string; uid: number; platform: NodeJS.Platform }
  export function hcSocketPath(vars: NodeJS.ProcessEnv, home: string): string
  export function hcClientDeps(): HcClientDeps      // process.env, homedir(), process.getuid(), process.platform
  /** hc's `app` word as an engine's kind: the closed table, else its own word when it fits HERDR_KIND. */
  export function hcKind(app: unknown): string | undefined

  export type HcStatus = 'idle' | 'working' | 'done' | 'blocked' | 'error'
  export type HcFault = 'no_socket' | 'refused' | 'timeout' | 'ended' | 'oversize' | 'bad_json' | 'bad_answer' | 'rejected'
  export type HcFailure = { fault: Exclude<HcFault, 'rejected'> } | { fault: 'rejected'; kind: string }
  export type HcAnswer = { ok: true; result: Record<string, unknown> } | ({ ok: false } & HcFailure)
  export type HcPrompt = { outcome: 'sent' | 'busy' }
    | ({ outcome: 'failed' } & (HcFailure | { fault: 'bad_request' | 'not_that_agent' }))
  /** A terminal of this machine as hc tells it, each field checked. */
  export interface HcTerminal {
    address: string
    live: boolean
    /** Its labels hold `herdr.space`: Herdr's window shows it. */
    space: boolean
    status?: HcStatus
    kind?: string
    name?: string
    cwd?: string
  }
  /** hc's terminal, read: none for another machine's, or one with no address in its form. */
  export function hcTerminal(value: unknown): HcTerminal | undefined
  export interface HcSubscriber {
    /** hc's snapshot, at the start and after `missed`: every terminal of this machine in it. It replaces what was told. */
    snapshot(terminals: readonly HcTerminal[]): void
    /** One terminal as it is after a change; `live: false` once it finished or was removed. */
    changed(terminal: HcTerminal): void
    closed(reason: HcFault): void
  }
  export interface HcClient {
    request(method: string, params: Record<string, unknown>, deadlineMs?: number): Promise<HcAnswer>
    subscribe(to: HcSubscriber): { close(): void }
    prompt(address: string, kind: string, text: string): Promise<HcPrompt>
    socketStamp(): string | undefined
  }
  export function createHcClient(deps: HcClientDeps): HcClient
  ```
- Rules:
  - **`hcSocketPath`** and **`hcKind`**: as "Global Constraints" says.
  - **`socketStamp`**: none unless `deps.platform` is `darwin`; else `socketStampOf`. With none, `request` answers `no_socket` and `subscribe` tells `closed('no_socket')`, and nothing connects.
  - **`hcTerminal`**: `address` in `HC_TERMINAL`; `live` is hc's state `live`; `space` is an own, non-empty `herdr.space` label; `status` only when hc's word is one of the five; `kind` is `hcKind` of the status's app; `name` and `cwd` when strings (`cwd` as "Decided here").
  - **`request`**: one connection, one line `{"jsonrpc":"2.0","id":<a fresh id>,"method","params"}`, the bound 8 MiB, the first line back, a deadline of `deadlineMs` (10 s by default).
    - `result` an object under its own id: ok. `error` under its own id: `rejected` with its `data.kind` when that fits `[a-z_]{1,64}`, else `bad_answer`. Any other object or id: `bad_answer`. No object: `bad_json`.
  - **`subscribe`**: one connection that writes `hello {generation: 1}` and `events.subscribe {}` together, the bound 8 MiB.
    - `hello`'s answer: a result whose `generation` is 1, else `bad_answer` (`unsupported_generation` too); any other error is `rejected`.
    - `events.subscribe`'s answer, after `hello`'s: its terminals are read, kept, and told as `snapshot`. An error is `rejected`. Neither answer in 10 s: `timeout`.
    - Then each notification, as Task 1 recorded them (F5):
      - an event whose `seq` is not above the last snapshot's: dropped;
      - an event of kind `created`, `lost`, `restarted`, `finished`, `status` or `labels`: the kept terminal takes the facts the line names, and `changed` tells it;
      - `removed`: `changed` with `live: false`, and it is kept no more;
      - `missed`: the fresh snapshot replaces what was kept, and `snapshot` tells it;
      - `heartbeat`, and every other kind (`doc`, `size`, `title`, `turn`, `keep`, one hc adds later): nothing is told, and nothing of the line is kept.
    - Past `HC_MAX_TERMINALS` kept, a terminal is not kept and not told: the rest of a snapshot, and one an event adds.
    - `HC_SILENCE_MS` with no line at all: `closed('timeout')`. Every line puts it off.
    - `closed` is told once, and nothing after it. The caller's `close()` ends the connection and tells nothing.
  - **`prompt`**: an address or a kind not in its form, a text over `MAX_TEXT`, or one blank once its control characters are spaces: `failed`, `bad_request`, and nothing connects. Then:
    1. `request('terminal.get', { terminal: address })`. Not ok: `failed` with its fault. No terminal, or another address: `failed`, `bad_answer`. Not live, or a kind that is not `kind`: `failed`, `not_that_agent`. A status that is neither `idle` nor `done`: `busy`.
    2. `request('terminal.send', { terminal: address, text: <the line>, if: 'idle' }, HC_SEND_MS)` when it was idle; with no `if` when it was done. Never `force`. Ok: `sent`. `rejected` with `status_mismatch`: `busy`. Else `failed` with its fault. Nothing is sent twice.
  - No member throws or rejects. The file logs nothing. Sockets and timers are unref'd.

- [ ] **Step 1: Write the failing tests** in `hcClient.spec.ts`, `describe.skipIf(process.platform === 'win32')`. Each client is `createHcClient({ socketPath: server.path, home: dirname(server.path), uid: process.getuid!(), platform: 'darwin' })`. Deadlines run on `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`, after `await server.got(…)`.
  - `the socket is HC_SOCKET when absolute; else <XDG_RUNTIME_DIR>/herdr-core/<session>.sock when that is absolute; else <XDG_STATE_HOME or ~/.local/state>/herdr-core/<session>/<session>.sock`: `({ HC_SOCKET: '/tmp/x/c.sock', HC_SESSION: 'side' }, '/h')` is `/tmp/x/c.sock`; `({ XDG_RUNTIME_DIR: '/run/me', HC_SESSION: 'side' }, '/h')` is `/run/me/herdr-core/side.sock`; `({}, '/h')` is `/h/.local/state/herdr-core/default/default.sock`; `({ XDG_STATE_HOME: '/s', HC_SESSION: 'side' }, '/h')` is `/s/herdr-core/side/side.sock`; a relative `XDG_RUNTIME_DIR`, `XDG_STATE_HOME` or `HC_SOCKET` counts as unset; `HC_SESSION` of `'../x'`, `'a/b'`, `'.'`, `''` and 65 characters read `default`.
  - `hcKind`: `claude-code` is `claude`, `codex` is `codex`, `pi` is `pi`; `'Claude Code'`, `''` and `7` give none; `'constructor'` gives `'constructor'`, its own word (the table is read by its own keys only).
  - `request writes one JSON-RPC line and answers the result under its own id`: the server got `{ jsonrpc: '2.0', id: expect.any(String), method: 'terminal.get', params: { terminal: 't7' } }`.
  - `each request is a connection of its own`.
  - `an error is rejected with its data.kind, never its message; a kind not in its form is bad_answer`: `not_found`; an error with no `data`; `data.kind` `'Bad Kind!'`.
  - `an answer under another id, or with neither result nor error, is bad_answer; a line that is no object is bad_json; one over 8 MiB is oversize`.
  - `no socket, a file that is no socket, another user's socket, and any platform but macOS are no_socket, and nothing connects` (`platform: 'linux'`, `'win32'`).
  - `a stale socket is refused; a connection that ends before its answer is ended; none in 10 s is timeout, and its connection closes`.
  - `subscribe writes hello then events.subscribe on one connection, and tells the snapshot once both answered`: the two requests are `hello { generation: 1 }` and `events.subscribe {}`; with `RECORDED.subscription`'s first lines, `snapshot` is told once with the agent's terminal (`{ address: RECORDED.agent, live: true, space: true, status: 'idle', kind: 'claude', cwd: '/work/hh' }`, and its name when hc gave one) and the worker's (`live: true, space: false`, no status).
  - `hc's own lines, in order, tell each change`: with all of `RECORDED.subscription`, the `changed` calls for the agent read `working`, `blocked`, `working`, `done`, `idle`, `error`, `idle`; the worker's read `space: true`, `space: false`, `live: false`, `live: false`; the `doc` lines, the heartbeat and any `size`, `title` or `turn` line tell nothing.
  - `a hello answered with another generation, or unsupported_generation, is closed bad_answer, and no snapshot is told`.
  - `events.subscribe refused is closed rejected; neither answer in 10 s is closed timeout`.
  - `an event that names one fact tells the whole terminal`: `server.change('t7', { status: { state: 'working', app: 'claude-code' } })` tells `{ address: 't7', live: true, space: true, status: 'working', kind: 'claude', cwd: '/work/api' }`.
  - `a terminal of another machine is never told`: `vps/t3` in the snapshot and in an event.
  - `missed brings a fresh snapshot, and an event whose seq is not above it is dropped`.
  - `a subscription that hears nothing for 45 s is closed timeout; a heartbeat puts it off`: at 44,999 ms nothing; a heartbeat, then 44,999 ms more, nothing; one ms more, `timeout`.
  - `a 2 MiB doc line is dropped and the next event is still told; a line over 8 MiB closes the subscription oversize` (Review Focus 2).
  - `events in the chunk that holds the snapshot, and a line split across two chunks, are each told once`.
  - `past 1,024 terminals a new one is neither kept nor told`.
  - `closed is told once, and nothing after it; close() ends the connection and tells nothing`.
  - `prompt reads the terminal, then sends the line: if idle when it was idle, no if when it was done, never force`: the requests are `terminal.get { terminal: 't7' }` then `terminal.send { terminal: 't7', text: 'run the tests', if: 'idle' }`; for `done`, `{ terminal: 't7', text: 'run the tests' }`. The answer is `{ outcome: 'sent' }`.
  - `working, blocked and error are busy, and nothing is sent; hc's status_mismatch is busy`.
  - `a terminal that finished, holds another kind, or reports no app is failed, not_that_agent; one hc does not know is failed, rejected, not_found`.
  - `the engine's kind is hc's app through the table`: kind `claude` and app `claude-code` are sent.
  - `hc's refusals of the send come back with their kind`: `blocked`, `finished`, `unavailable`, `cancelled`, `config`, `invalid_params`.
  - `a send with no answer in 75 s is failed, timeout, its connection closes, and nothing is sent again` (Review Focus 5): pending at 74,999 ms; `{ outcome: 'failed', fault: 'timeout' }` at 75,000; one `terminal.send` in `server.requests`.
  - `a read that is no terminal, or another terminal's, is failed, bad_answer, and nothing is sent`.
  - `control characters become spaces`: `'fix it\nrm -rf /\u001b[2J'` is sent as `'fix it rm -rf / [2J'`.
  - `an empty text, one blank once its control characters are spaces, one over 2000 characters, an address or a kind not in its form: failed, bad_request, and nothing connects`: `''`, `'\n\t'`, 2,001 characters (2,000 is sent), addresses `'t'`, `'T7'`, `'vps/t7'`, `'--help'`, `'t7; rm -rf /'` and 18 characters, kind `'Claude'`.
  - `socketStamp is none without a socket of this user's`.
  - The fixture's own pins: `the fake server, as hc, refuses a send to a blocked terminal, and one whose if is not its status`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hcClient.spec.ts`. Expected: FAIL (no `./hcClient.js`).
- [ ] **Step 3: Implement** `hcClient.ts`. Its header says what hc is and is not (Herdr Core, not herdr 0.8.0), why everything is checked here (the socket is another program's, the address came from a hook or from hc, the text from the dial), why `terminal.get` comes first, why a timed-out send is never sent again (hc's manual: it may still arrive), and why the file logs nothing.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: a client for Herdr Core's socket: one subscription, and words behind a fresh read`.

### Task 8: The hc source

Spec Q6 (the shared attempts), Q7 (an errored agent's words) and Q8 (the young socket, through the attempts).

**Layer:** devices service process. **Depends on:** Tasks 4 and 7. **Effort:** `xhigh` (reconnects, late answers, outside input, the dial's words).

**Red test:** `cli/src/cable/hosts/hcSource.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/hcSource.ts`
- Modify: `cli/src/testing/fakeHc.ts` (as Task 7)
- Test: `cli/src/cable/hosts/hcSource.spec.ts`

**Interfaces:**
- Consumes: `HcClient`, `HcTerminal`, `HcStatus`, `HcFault`, `HcPrompt`, `hcPaneKey`, `createHcClient` (Task 7); `SocketAttempts` (Task 4); `shown`, `MAX_AGENTS`, `MAX_CWD` (`./herdrSource.js`, Task 4); `MAX_TEXT` (`./orca.js`); `fakeHc` (Task 1).
- Produces:
  ```ts
  export interface HcSourceDeps {
    client: Pick<HcClient, 'subscribe' | 'socketStamp'>
    /** Tells of each change where hc's socket lives (unixSocket.ts watchSocket), until its stop is called. */
    watch(changed: () => void): () => void
    /** The dial's words: the Herdr adapter's prompt (herdrApp.ts). */
    prompt(address: string, kind: string, text: string): Promise<HcPrompt>
    /** A tap: the Herdr adapter's focus, as the devices hold it. */
    focus(address: string): Promise<boolean>
    /** Whether a rest can show it now, and the rest: the Herdr adapter's canShow and show. */
    canShow(address: string): boolean
    show(address: string, agentId: string): Promise<PaneSwitch>
    after(ms: number, run: () => void): () => void
    now(): number
    monotonic(): number
    uuid(): string
    platform: NodeJS.Platform
    log(line: string): void
    count(what: 'herdr-app' | 'busy' | 'waiting' | 'too-long' | 'no-answer'): void
  }
  export class HcSource implements HostSource {
    readonly id = 'herdr-app'
    constructor(deps: HcSourceDeps)
    start(): void
    stop(): void
    onChange(listener: () => void): () => void
    list(): HostAgent[]
    capabilities(): Caps                        // { status: true, voice: true, focus: true, answer: false }
    markSeen(agentId: string): void
    send(agent: HostAgent, text: string): Promise<SendResult>
    focus(agent: HostAgent): Promise<boolean>
    hasPane(agent: HostAgent): boolean
    showPane(agent: HostAgent): Promise<PaneSwitch>
    /** Whether Herdr's window shows that terminal: it is listed here. */
    shows(address: string): boolean
  }
  ```
- Rules, running:
  - `start()` does nothing unless `platform` is `darwin`, or when it already runs. Else the attempts start (`SocketAttempts`, `name: 'herdr-app'`, its `now` and `monotonic` the source's own).
  - `stop()` closes the subscription, stops the attempts, and empties the list. A call that comes later changes nothing.
  - An attempt is one `client.subscribe`. Its first `snapshot` is the attempts' `started()` and `listed()`.
  - `closed(reason)`: `failed('list', reason)` for `rejected` or `bad_answer` before a snapshot; else `failed('closed', reason)`.
- Rules, the rows:
  - **Listable:** `live`, `space`, a `status`, a `kind`. Every listable terminal is kept. `list()` is the first 64 of them, in the order they became listable.
  - `snapshot` replaces what is kept. `changed` adds, changes or drops one. A terminal that is no longer listable is dropped at once.
  - A row keeps its `id` while its address stays listable with the same kind. Another kind at that address, or a return after it left, is a new row with `uuid()`.
  - Fields: `engine` the kind; `cwd` cut to `MAX_CWD`; `name` hc's name through `shown`, else the folder's name the same way, else the kind; `host` and `app` `herdr`; `paneKeys` `[hcPaneKey(address)]`; no `sessionId`.
  - State from "Global Constraints", from hc's status and the one before it. `unseenDone` is set when the status becomes `done` or a row is first listed `done`; `markSeen` and any other status clear it. `lastActivityAt` is the wall clock at a row's first listing and at each change of its state.
  - `[herdr-app] listed · <n> agents` when the count differs from the last one said. `[herdr-app] over · <n> left out` when the number left out changes and is above 0. One `onChange` when anything a listed row shows changed.
- Rules, the verbs (each for a listed row; else false, no pane, `failed`, or `no-answer`):
  - `send`, in this order: over `MAX_TEXT`, `too-long`. Not listed, `no-answer`. Needs-you, `waiting`. hc's status `working`, `busy`. hc's status `error`, `no-answer` (spec Q7). Then `deps.prompt(address, kind, text)`: `sent` counts `herdr-app` and answers `{ ok: true }`; `busy` is `busy`; `failed` is `no-answer`. Each refusal counts once and answers its sentence.
  - `focus`: `deps.focus(address)`. `hasPane`: `deps.canShow(address)`. `showPane`: `deps.show(address, agent.id)`.
  - `shows(address)`: a listed row has that address.
  - `markSeen`: clears `unseenDone`, one `onChange`. It asks hc nothing.

- [ ] **Step 1: Write the failing tests** in `hcSource.spec.ts`, `describe.skipIf(process.platform === 'win32')`. `setup()` is as `herdrSource.spec.ts`'s: a `fakeHc()`, the real `createHcClient` on its path with `platform: 'darwin'`, `prompt` a spy over that client's `prompt`, `focus`, `canShow` and `show` spies, a timer queue and a watch the test runs by hand, `uuid` answering `u1`, `u2`, …, two clocks the test sets (the wall one from `WALL = 1_700_000_000_000`, so a real socket is never young), `stampAt` as Task 3's, and `until` asked again on each change, log line and count. `agent('t7')` is `{ address: 't7', cwd: '/work/api' }` with the fake's defaults.
  - `started with a core running, the terminals Herdr's window shows are listed with their fields`: the server holds `t7` (the agent), `t8` (no label), `t9` (labeled, no status), `t10` (labeled, app `'Weird App'`), `vps/t3` (labeled agent) and `t11` (labeled agent, finished). `list()` is `[{ id: 'u1', engine: 'claude', cwd: '/work/api', name: 'api', host: 'herdr', app: 'herdr', state: 'idle', unseenDone: false, lastActivityAt: <now>, paneKeys: ['herdr-app:t7'] }]`. The log is `['[herdr-app] socket · live', '[herdr-app] listed · 1 agents']`.
  - `each of hc's states is its dial state`: first listed and by change, `idle`, `working`, `blocked` (`needs-you`), `done` (`done`, `unseenDone: true`), `error` (`error`); a word hc does not have (`paused`) lists nothing.
  - `a turn that ends idle is done with nothing unseen; hc's done is done and unseen`: `working` then `idle`, and `blocked` then `idle`: `{ state: 'done', unseenDone: false }`, one `onChange`; `working` then `done`: unseen; `done` then `idle`, and `error` then `idle`: `idle`.
  - `a terminal that gains herdr.space, or its first status, is listed at once; one that loses its label, finishes or is removed goes at once`.
  - `a status that clears drops the row; another app at that address is another row with another id` (Review Focus 4): `t7` `claude-code`, then `status: null`, then `codex`: ids `u1` then `u2`, engine `codex`, state from its own status.
  - `claude-code is claude and codex is codex; another app keeps its word when it fits`: `pi` is engine `pi`.
  - `a name is hc's, else the folder's, else the kind; cut to 64, control characters removed; a cwd is cut to 4096`.
  - `65 listable terminals: 64 listed and one over line; when one leaves the 65th is listed, and the line is not said again`: `[herdr-app] over · 1 left out` once.
  - `missed: the fresh snapshot replaces the list, and a row that stays keeps its id`.
  - `the id is kept across a reconnect to the same socket while the address stays listed`.
  - `done is unseen until the dial turns to it`.
  - `with no socket it says none, watches, and lists when the core starts`: no timer in the queue; after `server.start()` and the watch firing, the agent is listed.
  - `a stale socket is said once, and nothing retries`: the stamp held at `stampAt(WALL - 60_000)`, `server.stale()`: the log is `['[herdr-app] socket · stale']`, no timer.
  - `a young socket that refuses is tried once after 1 s; a core listening by then is listed` (Review Focus 3): the stamp held at `stampAt(WALL - 500)`, `server.stale()`, `start()`: `['[herdr-app] retry · 1']`; `await server.start()`, `s.advance(1_000)`: the agent is listed, the log ends `socket · live`, `listed · 1 agents`. Without `server.start()`: `socket · stale` after the retry, no timer.
  - `a dropped subscription keeps its agents until the first retry; that retry failing empties the list`: `[herdr-app] closed · ended`, `[herdr-app] retry · 1`.
  - `45 s of silence is closed · timeout, and retried`.
  - `a core of another generation is list · bad_answer, retried, never listed, and never called stale`.
  - `while live it holds one connection, and no timer of its own`.
  - `stop while the snapshot is in flight: it lists nothing, and no connection, watch or timer is left`; `stop empties the list and tells once`; `start twice is one subscription`.
  - `off macOS start does nothing`: `platform: 'linux'` and `'win32'`: no request, no watch.
  - `voice`: idle, done and a turn that ended idle are sent (`deps.prompt` got `['t7', 'claude', 'run the tests']`, count `herdr-app`, `{ ok: true }`); needs-you is `{ ok: false, reason: 'api is waiting for your answer in herdr.' }` and `waiting`; working is `api is busy. Say it when it is done.` and `busy`, with no request; errored is `api did not answer.` and `no-answer`, with no request; a prompt the adapter answers `busy` is `busy`; 2,001 characters is `Too long. Say it shorter.` and `too-long`; a failed prompt and an agent no longer listed are `api did not answer.` and `no-answer`.
  - `a tap is deps.focus with the address; a rest is deps.canShow and deps.show; one no longer listed is false, no pane and failed`.
  - `shows answers for a listed address only`: not for `t8`, not for the 65th.
  - `no log line holds an address, a name, a folder or the words`: every line matches `/^\[herdr-app\] (socket · (none|stale|live)|listed · \d+ agents|over · \d+ left out|list · [a-z_]+|closed · [a-z_]+|retry · \d+)$/`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hcSource.spec.ts`. Expected: FAIL (no `./hcSource.js`).
- [ ] **Step 3: Implement** `hcSource.ts`. Its header says what it lists and what it leaves out (hidden workers, other machines, plain programs), that hc keeps running when Herdr is closed, so its agents are listed and take words then, and that a log line says only fixed words and counts.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: Herdr's agents, listed and followed over Herdr Core's socket, pushed and never polled`.

### Task 9: The Herdr adapter

**Layer:** devices service process. **Depends on:** Task 7. **Effort:** `xhigh` (it runs commands with an id a hook sent, and types the dial's words).

**Red test:** `cli/src/cable/hosts/herdrApp.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/herdrApp.ts`
- Modify: `cli/src/cable/hosts/adapter.ts` (the comment on `tap` names Herdr beside the Claude app), `cli/src/cable/hosts/types.ts` (the comments on `paneKeys` and `HostSource.id` name `herdr-app`)
- Test: `cli/src/cable/hosts/herdrApp.spec.ts`

**Interfaces:**
- Consumes: `HcClient`, `HcPrompt`, `HC_TERMINAL`, `hcPaneKey` (Task 7); `OrcaDeps`, `RUN_TIMEOUT_MS` (`./orca.js`); `OPEN` (`./open.js`); `APP_BUNDLES` (`./hostDetect.js`).
- Produces:
  ```ts
  /** Herdr.app's own binary, which ~/.local/bin/herdr-app links to. */
  export const HERDR_APP = '/Applications/Herdr.app/Contents/MacOS/Herdr'
  export interface HerdrAppDeps extends OrcaDeps {
    client: Pick<HcClient, 'prompt' | 'socketStamp'>
    /** Herdr is the app in front. */
    inFront(): boolean
    /** Whether Herdr's window shows that terminal: the hc source lists it (hcSource.ts shows). */
    shows(address: string): boolean
    log(line: string): void
  }
  export interface HerdrAppAdapter extends HostAdapter {
    canShow(pane: Pane): boolean
    show(pane: Pane, agentId: string): Promise<PaneSwitch>
    paneKey(pane: Pane): string
    /** The dial's words for that terminal: the hc source's door too (hcSource.ts). */
    prompt(address: string, kind: string, text: string): Promise<HcPrompt>
    /** Where `herdr-app` is: on PATH, else Herdr.app's own binary. None: Herdr is not installed. */
    binary(): string | null
  }
  export function createHerdrAppAdapter(deps: HerdrAppDeps): HerdrAppAdapter
  ```
  - `id: 'herdr-app'`, `tap: 'instead'`.
  - **Off macOS** (`deps.platform` is not `darwin`): `paneOf` answers none, `canFocus` and `canShow` are false, and it has no `type`.
  - `paneOf`: the hint `HC_TERMINAL_ID` in `HC_TERMINAL`, as `{ adapter: 'herdr-app', id }`. It reads no other hint.
  - `canFocus(pane)`: `deps.shows(pane.id)`. `canShow(pane)`: `deps.inFront()` and `deps.shows(pane.id)`.
  - `binary()`: `deps.onPath('herdr-app')`, else `HERDR_APP` when `deps.exists(HERDR_APP)`, else null.
  - **One run per terminal.** A `focus` or a `show` while one runs for that address joins it.
    - `focus`: an address not in its form is false. Else `deps.run(OPEN, ['-b', APP_BUNDLES.herdr], RUN_TIMEOUT_MS)` (`OPEN` as `open.ts` has it at the base; if a rebase brings #4373's `HARNESS_OPEN_BIN`, the open is the one the devices resolve from it, as #4373's own opens are, and Task 11's tap depends on that); not exit 0: false, and nothing more runs. Else `deps.run(binary, ['do', 'agent.focus', '--terminal', address], RUN_TIMEOUT_MS)`; not exit 0, or no binary: `deps.log('[herdr-app] focus · failed')`. True either way.
    - `show`: an address not in its form is `failed`. Else `agent.focus` alone: exit 0 is `ok`; else `failed`, with the same line.
    - Joined: `focus` answers whether Herdr came forward; `show` answers `ok` when `agent.focus` exited 0.
  - `prompt`: a prompt under way for that address answers `{ outcome: 'busy' }` and asks the client nothing. Else `deps.client.prompt(address, kind, text)`. It does not wait for a focus, and a focus does not wait for it.
  - `type`: `(await prompt(pane.id, engine, text)).outcome === 'sent'`. `canType`: `deps.client.socketStamp() !== undefined`. `paneKey`: `hcPaneKey(pane.id)`.

- [ ] **Step 1: Write the failing tests** in `herdrApp.spec.ts`, with a `recorder` as `herdr.spec.ts`'s: a runner that records each call and answers the next of `codes`, `onPath` answering `/fake/bin/herdr-app` for `herdr-app`, `platform: 'darwin'`, a client whose `prompt` answers what the test sets, `inFront` and `shows` the test sets (true by default), and a `log` it keeps.
  - `its id is herdr-app, and a tap is its own`: `tap` is `'instead'`; `type`, `show` and `canShow` are functions.
  - `off macOS it has no pane, no type, no focus and no show` (`'linux'`, `'win32'`): `paneOf` of a good hint is none; `canFocus` and `canShow` are false; `type` is undefined.
  - `paneOf takes hc's address, and refuses any other`: `t7` and `t1b` give `{ adapter: 'herdr-app', id }`, with `TERM_PROGRAM` and any bundle beside; `'vps/t7'`, `'T7'`, `'t'`, `' t7'`, `'--help'`, `'t7; rm -rf /'`, 18 characters and no hint give none.
  - `canFocus is true only for a terminal Herdr's window shows; canShow also needs Herdr in front`.
  - `focus opens Herdr, then switches its window to the terminal`: the calls are `[{ file: '/usr/bin/open', args: ['-b', 'dev.herdr.app'], timeoutMs: 10_000 }, { file: '/fake/bin/herdr-app', args: ['do', 'agent.focus', '--terminal', 't7'], timeoutMs: 10_000 }]`; true; no log line.
  - `herdr-app is found on PATH, else at Herdr.app's own binary`: `onPath` null and `exists` true for `HERDR_APP` runs `HERDR_APP`; `binary()` answers each, and null with neither.
  - `an open that fails is false, and agent.focus does not run`: codes `[1]`, one call.
  - `agent.focus that fails after Herdr came forward is true, with one line and no address in it` (Review Focus 1): codes `[0, 1]` and `[0, null]`; the log is `['[herdr-app] focus · failed']`. With no binary: one call, true, the same line.
  - `show runs agent.focus alone: ok, or failed with the line`.
  - `an address not in its form runs nothing`: `focus` false, `show` `'failed'`, no call.
  - `one run per terminal`, with a runner the test holds open: a second `focus` and a `show` for that address are the same two calls, and answer true and `'ok'`; another address runs beside it; the address is free again after a run that failed.
  - `type sends the words with the agent's engine, and is true only when sent; canType follows hc's socket`: the client's `prompt` got `['t7', 'claude', 'next']`; `busy` and `failed` are false.
  - `a second prompt to one terminal while one is under way is busy, and the client is asked once` (Review Focus 5); another terminal's runs; free again after `sent`, `busy` and `failed`.
  - `words and a tap do not wait for each other`: with a prompt held open, `focus` runs its two commands; with a focus held open, `prompt` asks the client.
  - `paneKey is herdr-app:<address>`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdrApp.spec.ts`. Expected: FAIL (no `./herdrApp.js`).
- [ ] **Step 3: Implement.** The header says why a tap opens Herdr first (hc outlives a closed window, and the window must be up to switch), why `open` runs by its own path and `herdr-app` with no shell, why a failed `agent.focus` is still a tap that came (Herdr is in front), and why words do not wait for a focus (hc types by address, whatever the window shows).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a tap and a swipe switch Herdr's window to the agent's terminal`.

### Task 10: The devices run the hc source

Spec Q4: the tap's two commands and their order are held here, with a recording runner.

**Layer:** devices service process. **Depends on:** Tasks 2 (the same files), 5, 8 and 9. **Effort:** `xhigh` (what starts and stops with the dial; three outside sources' cards; `services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `HcSource` (Task 8); `createHerdrAppAdapter` (Task 9); `createHcClient`, `hcClientDeps`, `HcClient` (Task 7); `watchSocket` (Task 2); `detectHost`, `detectApp` (Task 5, through the observed source).
- Produces, in `devices.ts`:
  ```ts
  /** For this service's tests: Herdr Core's socket (cable/hosts/hcClient.ts). */
  DevicesDeps.hc?: HcClient
  const hcAt = hcClientDeps()
  const hcClient = deps.hc ?? createHcClient(hcAt)
  const herdrApp = createHerdrAppAdapter({ ...apps, client: hcClient, log,
    inFront: () => cableHost.latestFront() === 'herdr', shows: (address) => hcSource?.shows(address) ?? false })
  const herdrAppNoted = noting(herdrApp)
  ```
  - `adapters`, in this order: herdr, tmux, Herdr (`herdrAppNoted`), WezTerm, Orca, the Claude app, VS Code, tabs. Each is wrapped by `noting`, as today.
  - `const hcSource = observed && apps.platform === 'darwin' ? new HcSource({ … }) : null`, with:
    - `client: hcClient`, `watch: (changed) => watchSocket(hcAt, changed)`, `platform: apps.platform`, `now: Date.now`, `monotonic`, `uuid: randomUUID`, `after: timerIn('herdr-app')`, `log`, `count: voiced`;
    - `prompt: herdrApp.prompt`;
    - `focus`: `herdrAppNoted.focus({ adapter: herdrApp.id, id: address })`, true only when it answered true;
    - `canShow`: `herdrApp.canShow` of that pane; `show`: `herdrAppNoted.show` of that pane and agent.
  - The registry is Harness, observed, herdr, then `hcSource`, each when it is there.
  - `hcSource.onChange` runs `outsideTurn`, as the other two do.
  - `dialAttached`: `part.call('herdr-app', () => on && herdrApp.binary() ? hcSource.start() : hcSource.stop())`. The devices' `stop` already calls `dialAttached(false)`.

- [ ] **Step 1: Write the failing tests.**
  - Beside `herdr`: `hcCalls`, and a recording `hc` client with no socket (`request` answers `no_socket`, `subscribe` tells `closed('no_socket')` in a microtask, `prompt` answers `sent`, `socketStamp` none). `start` passes `hc: over.hc ?? hc`. `hcCalls` is emptied in `beforeEach`.
  - In the herdr describe, `onMac.onPath` answers null for `herdr-app`, so that describe's watch expectations still hold one watch. This is the one edit of an existing test.
  - A new `describe("Herdr's agents, through Herdr Core (docs/plans/2026-11-16-herdr-app-design.md)")`. Its `withHc` is as `withHerdr`: a client the test drives (`subscribe` keeps each subscriber and whether it was closed; `prompt` records and answers the next of `prompts`; `socketStamp` answers `stamp`), `orca` on macOS with every command on the path, a `fakeListener`. `terminal('t7')` is `{ address: 't7', live: true, space: true, status: 'idle', kind: 'claude', cwd: '/work/api' }`. `live(terminals)` attaches the dial and tells the first subscriber's `snapshot`. `changed(over)` tells one change of `t7`.
    - `with a dial attached Herdr's agents are listed svf, on herdr's page; detached, the source stops`: `listed()` is `[{ id: expect.any(String), name: 'api', caps: 'svf' }]`, the agent's `host` and `app` are `herdr`, the log has `[herdr-app] listed · 1 agents`; after `seen.host.watching!(false)` the subscription is closed and nothing of Herdr is listed.
    - `a status change is a card`: `working` gives one `turnStarted` with text `''`; `blocked` one with `'Waiting for you · herdr'`; `done` one `turnDone`; `error` one `turnError`; `calls('question')` is `[]`.
    - `a turn that ends idle is a done card; an agent first listed done is none`.
    - `a Herdr agent mid-turn is reminded`: one more `turnStarted` after `REMIND_MS`.
    - `a hooked agent in a Herdr terminal is one row, its hook's, on herdr's page, and gets each card once`: a Claude hook with `hostHints` `{ HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' }`, and hc listing `t7`. `listed()` is one row, its id `observedAgentId('claude', 'sess-1')`; the snapshot's agent has `host: 'herdr'` and `app: 'herdr'`. After the hook's `turn-start` and hc's `working`, `calls('turnStarted')` has one call.
    - `the dial's words reach an idle Herdr agent, and each refusal is said once`: `sendTurn` is `{ ok: true }`, the client's `prompt` got `['t7', 'claude', 'run the tests']`, `said()` is `['[device] voice · herdr-app']`. Then working, blocked, 2,001 characters, errored and a failed prompt add `busy`, `waiting`, `too-long`, `no-answer`, `no-answer`.
    - `a hooked agent's words go through Herdr Core, counted herdr-app`: the hook above as a `turn-stop`, no mod: `sendTurn` is `{ ok: true }`, the same `prompt` call, `orcaRuns` is `[]`, and `said()` ends with `[device] voice · herdr-app`.
    - `a tap opens Herdr, then switches its window to the terminal, and is the dial's own move`: `host().openAgent(id)` answers undefined; `orcaRuns` is `[['/usr/bin/open', ['-b', 'dev.herdr.app'], 10_000], ['/opt/herdr-app/bin/herdr-app', ['do', 'agent.focus', '--terminal', 't7'], 10_000]]`. With a tab report waiting on its settle before the tap, the settle says `[device] tab · skipped · echo`.
    - `a tap on a hooked agent in a Herdr terminal runs the same two commands, and no second open`.
    - `a hooked agent in a terminal Herdr's window does not show takes words, and a tap brings Herdr forward only`: the hook's `HC_TERMINAL_ID` is `t8`, which hc does not list. `orcaRuns` is `[['/usr/bin/open', ['-b', 'dev.herdr.app'], 10_000]]`, and no `fallback` line is said.
    - `a rest with Herdr in front switches its window and brings nothing forward; with another app in front it has no pane`: after `host().front('herdr')`, `host().swipeSwitches(id)` is true, `host().swipeEnded(id, 'rest')` runs `[['/opt/herdr-app/bin/herdr-app', ['do', 'agent.focus', '--terminal', 't7'], 10_000]]` and says `[device] swipe · ok`; after `host().front('ghostty')`, `swipeSwitches` is false.
    - `herdr 0.8.0's agents and Herdr's are both listed, and neither folds the other`: a herdr client that lists `w1:p1` beside hc's `t7`: two rows.
    - `HARNESS_DEVICE_OBSERVED=off: nothing is subscribed or watched`; `off macOS nothing is subscribed or watched` (`'linux'`, `'win32'`); `with Herdr not installed nothing is subscribed or watched, and the next attach looks again` (`onPath` null for `herdr-app` and `exists` false, then installed).
    - `with no socket, the folder hc's socket goes in is watched while a dial is attached`: `watched.calls` holds `[hcClientDeps(), expect.any(Function)]`; detached, it is stopped.
    - `the devices stopping stops the source`: the subscription is closed, the watch stopped, `vi.getTimerCount()` is 0.
    - `a herdr-app part that throws costs the dial nothing` (`faults: ['herdr-app']`): the observed agent is still listed, and the log has `[devices] herdr-app failed · injected fault: herdr-app`.
    - `no log line holds an address, a name, a folder or the words`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the new describe only.
- [ ] **Step 3: Implement.** The comment over the source says it runs only while a dial is attached, behind the observed agents' switch, on macOS, and only with Herdr installed. The comment over `adapters` says why Herdr comes after tmux.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devicesProcess.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`, the core's file list unchanged, and no existing expectation edited but the herdr describe's `onMac`. Another that has to change is a finding: stop and report it.
- [ ] **Step 5: Commit** `dial: Herdr's agents are on the dial with their state, hook or no hook`.

### Task 11: End to end, a private Herdr Core

Spec Q4: the real `/usr/bin/open` never runs. It swipes through the fake `herdr-app`, and taps only through #4373's fake `open`, when the feature branch already holds it (step 1).

**Layer:** test. **Depends on:** Tasks 1 (finding F2: A6 and A9) and 10. **Effort:** `xhigh` (it starts a core on the person's Mac, beside their own).

**Red test:** none: no behavior (it adds the end-to-end test of what Tasks 5 to 10 built). One commit.

**Files:**
- Create: `cli/e2e/deviceHerdrApp.e2e.ts`, `cli/e2e/harness/hcCore.ts`

**Interfaces:**
- `hcCore.ts`: a Herdr Core of the test's own, never the person's.
  ```ts
  /** The installed hc: ~/.local/bin/herdr-core of the account that runs the tests (`userInfo().homedir`: the suite's
   *  HOME is a throwaway one). Null off macOS, or with none: the file is then skipped. */
  export const hcBinary: string | null
  export class PrivateHc {
    /** A session name and a short socket path of its own, before anything runs: the daemon is started with them. */
    static plan(): { session: string; socket: string; root: string }     // harness-<random>, /tmp/hh-<random>/c.sock
    static start(planned: ReturnType<typeof PrivateHc.plan>): Promise<PrivateHc>
    rpc(method: string, params?: Record<string, unknown>, deadlineMs?: number): Promise<Record<string, unknown>>
    /** A terminal Herdr's window would show (`herdr.space`), in <root>/work/<folder>, running the fake agent directly,
     *  reported idle: its address. */
    agent(folder: string): Promise<string>
    /** The fake agent reports that status next. */
    report(address: string, state: 'idle' | 'working' | 'blocked' | 'done' | 'error'): Promise<void>
    screen(address: string): Promise<string>                              // terminal.read
    stop(): Promise<void>
  }
  ```
  - Every `hc` it runs gets an environment built from nothing, as Task 1's wrapper built it: `HOME` and every `XDG_*` under `root`, `HC_SESSION` the private name, `HC_SOCKET` the private socket. It refuses to run with a session name that does not start `harness-`.
  - `start` and `stop` are the ones finding F2 names, and no other. `start` notes the `dev.herdr.core.*` labels before and after, and the core's and its holders' pids (`server.status`). `stop` is `server.stop` over the private socket, then it waits until the socket is gone or refuses, those pids are gone (`ps -p`), and the labels are those from before `start`. A label or a pid still there after 30 s fails the test and names it. It never runs `launchctl` with anything but `list`, and never ends a process it did not start as its own child.
  - The fake agent is Task 1's, written to `root`: Node, run by `terminal.run` with `argv` and no shell, app `claude-code`; it prints `fake> ` and `GOT[<line>]`; a line on its own Unix socket under `root` is the status it reports next.
  - `rpc` is the test's own few lines, not the product's client.
  - `stop` removes `root` once the core is gone.
- Consumes: `IsolatedDaemon`, `until`, `Desk`, `FakeBackend`, and the spoken turn as `deviceHerdr.e2e.ts` has it; `InOrca` (`e2e/harness/inOrca.ts`) and the `watch` of `dialClaudeAppFollow.e2e.ts` (the real `harness hardware watch --json`, a front app written on its stdin).

- [ ] **Step 1: Is there a fake `open`?** Run `gh pr view 4373 --json state --jq .state` and, on the feature branch, `git grep -n HARNESS_OPEN_BIN -- cli/src/services/devices.ts cli/e2e/harness/daemon.ts`. Rebasing is the main session's job, never this task's.
  - **The branch holds it** (the grep prints lines in both files): the tap test of step 3 is written, but only if the Herdr adapter's open (Tasks 9 and 10) runs the path `HARNESS_OPEN_BIN` names. If it still runs `/usr/bin/open` by its own path, no tap test: stop and report it as a finding.
  - **`MERGED`, and the branch does not hold it:** no tap test. The report says #4373 is on `main` and a rebase would let the e2e tap.
  - **Otherwise:** no tap test. Swipe only.
  - The report names which case held.
- [ ] **Step 2: Write** `hcCore.ts`.
- [ ] **Step 3: Write the tests** in `deviceHerdrApp.e2e.ts`, `describe.skipIf(!hcBinary)`. Each has a `PrivateHc.plan()` first, then a daemon of its own with `HC_SOCKET: <the planned socket>` and `CABLE_DISABLE: 'false'` in its environment, signed in as a fixture machine for the speech. The daemon's `bin` holds a fake `herdr-app`, a script that appends its arguments as one line to `<daemon root>/herdr-app.log` and exits 0. `afterEach` stops the core before the daemon. No test sends `agent.open` but step 1's tap test.
  - Before anything else in each test: `resolveBinaryOnPath('herdr-app', d.env)` is the fake's path.
  - `Herdr's agents are on the dial with their state and no hook, and take the dial's words`:
    1. The core runs with `api` idle. The dial plugs in and hears the row `{ name: 'api', engine: 'claude', host: 'herdr', caps: 'svf' }`.
    2. `report(t, 'working')`: `turn.started` for it. `report(t, 'blocked')`: a `turn.started` or `turn.activity` whose text is `Waiting for you · herdr`. `report(t, 'working')`, then `report(t, 'done')`: `turn.done`. `report(t, 'working')`, then `report(t, 'idle')`: `turn.done` again.
    3. The dial speaks `run the spoken tests`: it hears `voice.transcript`; `screen(t)` holds `GOT[run the spoken tests]` (awaited 90 s at most: hc's quiet pause); the log has `[device] voice · herdr-app`.
    4. `report(t, 'working')`, then the dial speaks `not now`: it hears `voice.error`; the log has `[device] voice · busy`; `screen(t)` holds no `not now`.
    5. The log has `[herdr-app] socket · live` and `[herdr-app] listed · 1 agents`, and holds no address, no folder's path and none of the words.
  - `a swipe with Herdr in front switches Herdr's window, through herdr-app alone`:
    1. A dial that says `appFilter: 'v1'`. Two hooked sessions in Orca (`InOrca`, started as `dialClaudeAppFollow.e2e.ts` starts them) hold its ring: Orca has more agents than Herdr until Herdr settles in front.
    2. The core runs with `api` idle: the dial's `apps` count `herdr` 1.
    3. The watch says `dev.herdr.app` is in front. The ring's switch to `herdr` is the settle, so nothing waits a fixed time; the row is heard.
    4. The dial sends `focus` for it: the log has `[device] swipe · ok`, and `herdr-app.log` is the one line `do agent.focus --terminal <t>`.
  - `a core started after the dial is listed with no daemon restart, and goes when it stops` (Review Focus 3):
    1. The dial plugs in with no core: the log has `[herdr-app] socket · none`.
    2. `PrivateHc.start` and `agent('api')`: the row is heard.
    3. `stop()`: a list without the row follows, and the log has `[herdr-app] closed · ended`.
  - Only in step 1's first case: `a tap opens Herdr through the test's fake open, then switches its window, through herdr-app`:
    1. Before anything else: the daemon's `HARNESS_OPEN_BIN` is the harness's fake `open` (as `dialAppFilter.e2e.ts` reads it), and `resolveBinaryOnPath('herdr-app', d.env)` is the fake `herdr-app`.
    2. The core runs with `api` idle; the dial hears the row and sends `agent.open` for it.
    3. The fake `open`'s record is the one call `-b dev.herdr.app`, and `herdr-app.log` is the one line `do agent.focus --terminal <t>`. Their order is the specs' (Tasks 9 and 10).
  - If hc will not start, or will not keep the fake agent's status, stop and report it. The test is not weakened.
- [ ] **Step 4: Run**, on this Mac: `cd cli && npm run typecheck && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdrApp.e2e.ts`. Expected: PASS, not skipped. Then `launchctl list | awk '$3 ~ /^dev\.herdr\.core\./ { print $3 }' | sort` prints what it printed before the run, and `ls /tmp | grep -c '^hh-'` prints 0.
- [ ] **Step 5: Commit** `e2e: Herdr's agents on the dial, from a private Herdr Core`.

Nothing registers the file: `vitest.e2e.config.ts` finds `e2e/**/*.e2e.ts`, a file with no hint in `cli/ci-e2e-durations.json` costs the default, and on a runner with no hc every test of it is skipped.

### Task 12: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior. One commit.

**Files:**
- Modify: `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md`, `docs/specs/2026-11-16-device-herdr.md`

- [ ] **Step 1:** Write the changes, in each file's own words and length:
  - `cli/AGENTS.md`, the devices row of the processes table: Herdr's agents (the Herdr app over Herdr Core), listed and followed over Herdr Core's socket while a dial is attached, on macOS (`cable/hosts/hcSource.ts`, `hcClient.ts`), and switched to by `herdr-app` (`cable/hosts/herdrApp.ts`); and, where it says a swipe switches Orca's pane, that it switches Herdr's terminal while Herdr is in front.
  - `docs/specs/2026-11-15-device-host-adapter.md`: a row for `herdr-app` in the adapters table (file, the hint `HC_TERMINAL_ID`, its show, its focus, its words), and Herdr beside the Claude app where a tap is the pane alone. One sentence each that points at `../plans/2026-11-16-herdr-app-design.md`.
  - `docs/specs/2026-11-16-device-herdr.md`, where it says a stale socket costs about two minutes of retries: one sentence that points at the new spec, where a socket nothing subscribed on is stale at once.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: Herdr's agents reach the dial through Herdr Core`.

---

## Verification

**Platforms the pull request names:** the daemon and the hook on macOS. Tested: the unit specs on Linux in PR CI and on this Mac; checks 1 and 2 on this Mac. Linux and Windows: nothing a person sees changes. Unit tests with `platform: 'linux'` and `'win32'` hold that the client finds no socket, the source never runs and the adapter has no pane (Tasks 7 to 10), and on a Linux runner that the hook sends no `HC_TERMINAL_ID` (Task 6).

**Never touched:** Diego's own Herdr window, his Herdr Core (the default session, `~/.local/state/herdr-core/default`), `~/.config/herdr`, herdr 0.8.0's server, his everyday daemon (port 18473), `~/.claude`, `~/.codex`, his tmux server, his dial, any backend, production.

**Temporary workflow:** none. Check 1 needs the Herdr Core installed on this Mac, which no GitHub runner has, and installing it there is out of the spec's scope. Check 3 has a workflow of the repo's own.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 3).

**Local gates**, recorded in the pull request (PR CI does not run them), on this Mac at the final head:
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/hookNotify.spec.ts`. The hook's macOS tests run only here.
- `npm run test:core`: 100% per file under `src/services/`, `services/devices.ts` named. This is the one gate the repo requires for this change: `python3 scripts/local-checks.py --list` answers `cli-core` alone for these paths (`docs/validation-and-release.md`, "What PR CI does not run").
- `npx vitest run src/architecture.spec.ts src/architecture.environment.spec.ts src/leanEntry.spec.ts`. `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/vitest.setup.ts` prints nothing.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. Its receipt goes in the pull request's body before the tested commit is pushed.
- Not needed: `npm run test:harnessd`, the serial and PTY specs, `cargo test` in `device-app`, `make device-test`, `make desktop-test`.

**1. A private Herdr Core, the real daemon, a fake dial**
- Where: this Mac only, at the final head. Herdr Core 0.1.21 at `~/.local/bin/herdr-core`. Only if Task 1 found a safe start (A6).
- Build: nothing by hand. The suite starts the daemon from the working tree.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdrApp.e2e.ts`.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6) and the helper's:
  - a throwaway home, data folder and Codex home, a private port and tmux server, a fake dial on a pseudo-terminal, a fake backend on loopback for the speech;
  - a Herdr Core of the test's own: a session named `harness-<random>`, its `HOME` and every `XDG_*` in a scratch root, its socket a short path under `/tmp`, started and stopped as Task 1 found safe, through its own session only;
  - a fake `herdr-app`, first on the daemon's `PATH`, checked before anything else; `/usr/bin/open` never runs: no test taps, but the one through #4373's fake `open` when the branch holds it (Task 11, step 1);
  - the daemon under test inherits no `HC_*` and no `XDG_*` (`src/testing/daemonEnvironment.ts`); the test gives it the private `HC_SOCKET` alone.
  - Before the run, note `launchctl list | awk '$3 ~ /^dev\.herdr\.core\./ { print $3 }' | sort`. After it, the same lines. No `hc` and no `herdr-app` is run outside the test.
- A person sees: three tests pass (four with the tap test, whose fake `open` record is the one call `-b dev.herdr.app`), none skipped. The first one's log has `[herdr-app] socket · live`, `[herdr-app] listed · 1 agents`, `[device] voice · herdr-app` and `[device] voice · busy`. The second one's log has `[device] swipe · ok`, and its `herdr-app.log` is the one line `do agent.focus --terminal <address>`. The third one's log has `[herdr-app] socket · none`, then `[herdr-app] closed · ended`. No private core is left, and Herdr's own window never moved.
- If hc is not installed, the file is skipped, or Task 1 stopped on A6: report it as not verified, never as passed.
- On GitHub: none. No runner has hc, and the file reads skipped there. **Proposal** (the spec's follow-up, not this pull request): a permanent workflow that runs it on a macOS runner with hc installed.

**2. herdr 0.8.0 still holds, and its stale socket is said once**
- Where: this Mac, at the final head. herdr 0.8.0 at `~/.local/bin/herdr`, and `cc`.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdr.e2e.ts e2e/dialTerminalFollow.e2e.ts`.
- Isolation: the suite's own, and `herdrServer.ts`'s private herdr server under the throwaway home. Before the run, note `ls -la ~/.config/herdr` and `ps -A -o pid=,command= | grep "[h]erdr server"`; after it, both read the same.
- A person sees: every test passes, none skipped. `herdr started after the dial …` passes on the new rule (Review Focus 3). The stale test's log has one `[herdr] socket · stale`, at most one `[herdr] retry · 1` before it (its socket was just made), and no `[herdr] retry` after the replug.

**3. The other dial flows still hold**
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `fix/herdr-socket-path` (`.github/workflows/cli-e2e.yml`). Every shard passes. `deviceHerdrApp.e2e.ts` and the herdr-server tests of `deviceHerdr.e2e.ts` read skipped there; its stale-socket test runs. The link goes in the pull request.
- Isolation: the suite's own. No account, no secret.
- What it shows: `deviceWithoutApp`, `deviceClaudeOrca`, `deviceCodex`, `dialPaneFollow`, `dialClaudeAppFollow`, `dialAppFilter`, `dialAppFilterOnDial` and `devicesProcess` pass on the changed adapter order and the third outside source.

**4. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run the specs of Tasks 2 to 10 on Linux, each socket spec on a fake server in a temp folder. Nothing is started by hand.

**5. Numbers:** none to take by a run. What the feature adds at rest is counted, and specs hold each count (root rule 4, idle daemon work):
- a core live and nothing changing: one connection, one line of under 100 bytes from hc every 15 s (its heartbeat), and one timer that line puts off; no poll (Task 7, the heartbeat test; Task 8, `while live it holds one connection, and no timer of its own`);
- Herdr saving its layout: one line parsed and dropped (Task 7);
- no core: a folder watch and no timer. A stale socket, herdr's or hc's: a folder watch and no timer, where `main` retried from 1 s to 60 s at each plug-in; one under 2 s old, one connection more after 1 s, once (Tasks 3, 4 and 8).

**6. On Diego's own dial and Herdr (person-only: needs Diego himself, his own login and his eye; spec Q4), before the merge:** after the branch's daemon runs on his Mac, by his own hand:
- with Herdr open, a tap on a Herdr agent brings Herdr forward on that agent's terminal;
- with Herdr closed, a tap opens it, and he says whether the window lands on the terminal or needs a second tap (Review Focus 1);
- his daemon's log has `[herdr] socket · stale` once and no `[herdr] retry` (done-when 6), and `[herdr-app] socket · live`;
- `harnessd-devices` stays at about 0% in Activity Monitor with Herdr open and idle.

No agent runs this check: it is his own session and his own eye.

**7. Against production:** none, and never.
