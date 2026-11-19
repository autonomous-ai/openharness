# OpenClaw in `harness show`: the first task, and every state, right

Status: approved by the orchestrator (decisions below are the child's, each reversible) · 2026-11-19 · branch
`fix/openclaw-show-goal`

## Why

A client program runs OpenClaw through Harness: it runs `harness new openclaw … -- <task>`, then polls `harness show
<agent> --json` every ~2 s for up to 45 s to decide whether the agent took the job (taken: state `working`, or an
ask, a tool call or an answer). With Hermes it sees `working` at once. With OpenClaw it sees `unknown` 4–5 times, then
`idle` with an empty ask; on the Gateway the first prompt arrives 15–45 s late, or never, even on a Gateway up for
hours. The client then closes the agent and tries again, and finally tells the person it could not start.

CLI 0.6.71 (#4480) made `show`, `ps`, `watch` and `wait` read the frame's `namedState` and count the OpenClaw states as
`held`. That did not reach this. The work is driven by a **goal test**: an end-to-end test that walks an OpenClaw agent
through every state on a real daemon and asserts what `show` (and `ps`, `wait`, `watch`, which share its model) says at
each step, red on `main` where it is wrong, plus a reproduction on a box shaped like the slow device it happens on.
Every bug found on this path is fixed in this one PR.

## What the reproduction found (real OpenClaw 2026.11.2, isolated, this Mac)

Isolated HOME, state folder, Gateway on a free port, a stub model (one run with a real cheap model), `IsolatedDaemon`.

1. **The first task is lost when OpenClaw's history load fails.** On a loaded or cold Gateway the TUI's first
   `chat.history` can take over 30 s. OpenClaw then prints `history failed: gateway request timeout for chat.history`,
   yet still marks itself connected and draws `gateway connected | idle` (tui 6031-6036, 7598-7601). Its history flag
   stays false, so it refuses every message (`session history not ready — wait or retry /session`) and puts the text
   back in its input box; nothing loads history again but `/session` or a reconnect. Harness reads that screen as
   ready (`contract.ts` STATUS.ready), takes the task off the row and types it once (`bind.ts` `handOverFirstTask`),
   presses Enter twice more 10 s apart (`lib/sessionInput.ts`, SUBMIT_MAX_RETRIES), then gives up with only a log
   line. `chat.send` never reaches the Gateway, and `show` says `idle`, empty ask, for ever.
2. **The first task is late.** Three waits add up: the TUI's reconnect backoff (1, 2, 4, 8, 16, then 30 s), Harness's
   5 s binding pass, which takes one pass each to clear a hold, bind the session and hand the task over (5–15 s), and
   the Gateway's own slow first `chat.send`.
3. **`show` is wrong while the first task waits.** Before the TUI draws its footer `show` says `unknown` with "wait
   until it stops working"; once the store stream attaches it says `idle` with an empty ask, though the task has not
   been typed. The OpenClaw busy pattern misses the TUI's `starting up`, `sending` and waiting words (a spinner, a
   random word such as `flibbertigibbeting…`, a `• Ns` timer).
4. **The Gateway hold flaps.** During a lasting outage the TUI redraws `gateway disconnected: <error> | idle` on each
   reconnect try and bare `disconnected | idle` (or `startup failed | idle`) between them on any redraw. Harness reads
   the bare lines as no state and, with the footer on screen, clears the hold ("working again"), then holds again on
   the next try. A drop that reconnects by itself within seconds holds (needsPerson, `wait` exit 3) on the first pass.
5. **OpenClaw's own race** (not Harness's): a Gateway started at the same moment as a TUI exits with `state … is
   undergoing offline maintenance`. Harness then rightly holds the agent: the Gateway is not running.

Exact screens from launch to ready: a banner with no footer (`🦞 OpenClaw 2026.11.2 (b556fdf) — <tagline>`), then
`connecting | idle`, then `⠙ starting up • 0s | subscribing to session events`, then `gateway connected | idle` (or
`gateway reconnected | idle`), which becomes `connected | idle` only at a later redraw. A run: `⠋ sending • 0s |
connected`, `⠼ <word>… • 0s | connected`, `⠦ running • 0s | connected`, back to `connected | idle`.

Code reading added: a long quiet tool step lets the frame's working claim expire (30 s, `lib/turnActivity.ts`), since
`lib/runtimeActivity.ts` takes screen evidence from Claude Code and Codex only, so `ps` says `unknown` while `show`
says `working`; `wait` and `watch` read one history page where `show` reads up to four; OpenClaw's TUI shows no
approval (the Gateway denies a headless exec approval at once), yet the generic question reader still runs on its
chat; a TUI that exits on `Missing gateway auth token.` leaves a plain terminal, so `show` cannot find the agent.

## Goals

- The first task reaches OpenClaw whenever the TUI becomes able to send it, typed once, confirmed by its user row;
  when it cannot within a bound, the agent says so and `show` reports a failure, never `idle` with no ask.
- Until the first task is taken, every verb says `starting`, never `unknown` or `idle`.
- `show`, `ps`, `wait` and `watch` agree on the state at every moment of the matrix below.
- The Gateway hold is set only for a lasting outage, and does not flap during one.
- Hermes and the other engines read exactly as before (their show/wait tests rerun, unchanged).

## Non-goals

- OpenClaw's own bugs (the history flag, the startup race, the reconnect backoff): reported in the PR, not patched.
- No new state word or command. No change to `tell`/`reply` delivery for engines other than OpenClaw, beyond what the
  shared first-task path needs.
- No Desktop or mobile change: they read `launch`, `namedState` and `activity` already.
- #4484 (a resume of a deleted Gateway session) stays its own item.

## Anti-goals

- A matrix that passes because the fake is shaped to the code: the fake TUI draws only screens recorded from OpenClaw
  2026.11.2 (`__fixtures__/screen-*.txt`) or captured by this reproduction (the exact strings above), and writes store
  rows shaped as the recorded `*.sql` fixtures.
- `needsPerson` or `wait` exit 3 on a state Harness or OpenClaw recovers from by itself: the client tells the person on
  exit 3.
- Pasting the task twice: the TUI keeps a refused message in its input box.

## Decisions (the child's, each reversible; the orchestrator delegated them)

1. **Ready means able to send.** An OpenClaw pane whose chat shows `history failed:` or `session history not ready`
   (since its last connection) is not ready: a new pane state, read like the others in `readOpenclawScreen`. Harness
   then types `/session <key>` — OpenClaw's own remedy — into an empty input box, at most once every 20 s and 5 times
   per connection; the task waits.
2. **The first task is kept until taken.** It stays the daemon's until its user row confirms it. A submission OpenClaw
   refused leaves the text in its input box: Harness submits that box (Enter only, never a second paste) once the pane
   is ready again, and does not count the time the pane was not ready against the retries. The whole wait is bounded:
   3 minutes from launch (the existing submit window measured on a slow device, 30 s, keeps its meaning for one try).
3. **Its end is visible.** A first task not taken within the bound sets the agent's launch to failed, code
   `FIRST_TASK_NOT_TAKEN`, detail `OpenClaw did not take the first task. Close it and start it again.`; `show` says
   `failed` with that line, `wait` exits 1. Reusing `launch` exposes no new data.
4. **`starting` from the frame.** While an agent's first task waits (on the row or awaiting confirmation) its frame's
   `launch` says `starting`, and the verbs read `starting` from it through one function in `agentClient/model.ts`;
   an OpenClaw agent with no session bound yet within a minute of launch is `starting` too. If the planner finds that
   `launch: starting` on a live row changes another behavior (input refusal, close, restore, Desktop), it uses a
   boolean frame field instead and says why.
5. **One pass, not three.** A binding pass that clears the hold or binds the session goes on to hand the task over in
   the same pass once the pane reads ready.
6. **The busy pattern covers a run.** A spinner line with a `• Ns` timer is work (`sending`, a waiting word,
   `running`, `streaming`), except `starting up` and `connecting`, which are `starting`. Inspect then answers
   `working`, and the runtime activity reader takes OpenClaw's changing run timer as work evidence, as it does Claude
   Code's and Codex's footers, so a quiet tool step stays `working` in `ps` too.
7. **The Gateway hold waits 10 s and holds through the outage.** `noGateway` is set once `gateway disconnected` has
   been read for at least 10 s with no `connected`/`reconnected` line between; bare `disconnected` and `startup failed`
   neither set nor clear it; only a ready line clears it.
8. **No token is a failed launch.** A TUI that exits printing `Missing gateway auth token.` fails the launch with
   `OPENCLAW_NO_TOKEN` and the `noToken` sentence, as a folder in use already does; `show` finds it and says `failed`.
9. **One history read.** `wait` and `watch` read the last turn as `show` does (more pages only when the first holds no
   turn, so the usual cost is unchanged).
10. **No question parse on OpenClaw's chat**, if the goal test shows one firing on a numbered list.
11. **Settled with the plan.** The frame carries a boolean `starting` (decision 4's escape: `launch: starting` on a
    live row changes discovery, the reconciler, restore and `ensure`). A launch failed `FIRST_TASK_NOT_TAKEN` is left
    alone by discovery while the same TUI process runs. The typed-but-unconfirmed first task is tracked in memory: after
    a daemon restart in that window the agent reads as before (a known limit, no registry change). `wait` exits 1 only
    for a launch that failed here; a harness that never started and a failed cloud harness keep exit 4, which existing
    clients rely on. The 3-minute bound pauses while the agent is held, so a person who starts the Gateway late still
    gets the task delivered.
12. **Copy.** `starting` and `failed` copy follow `docs/cli.md` and the harness `SKILL.md`; both change only if a line
    above needs words they do not have.

## The state matrix

`<n>` is the agent's name, `<m>` the machine. "Today" is the code's prediction or the reproduction's observation; the
goal test decides and the PR body records the rows red on `main`.

| # | State (what the fake shows) | `show` line 1 / extra | JSON `state` · `needsPerson` · `namedState` | `next` | `ps` | `wait` | Today |
|---|---|---|---|---|---|---|---|
| 1 | Launched, no footer yet (banner) | `<n> on <m>: starting · OpenClaw · started by …` | `starting` | `wait` | starting | keeps waiting | `unknown` |
| 2 | `connecting \| idle`, `⠙ starting up • 0s \| subscribing…` | as 1 | `starting` | `wait` | starting | keeps waiting | `unknown`/`idle` |
| 3 | `gateway connected \| idle`, first task not yet typed | as 1 | `starting` | `wait` | starting | keeps waiting | `idle`, empty ask |
| 4 | History failed (`history failed: …`, `gateway connected \| idle`) then OpenClaw recovers after `/session` | `starting`, then `working` once the task is typed and its row lands | `starting` → `working` | `wait` | starting → working | keeps waiting, then 0 | `idle` for ever; task lost |
| 5 | History never recovers within 3 min | `failed`, `failed: OpenClaw did not take the first task. Close it and start it again.` | `failed`, `failure.error` `FIRST_TASK_NOT_TAKEN` | – | failed | exit 1 | `idle` for ever |
| 6 | First task typed, refused once (text back in the box), accepted on the next ready read | `starting` → `working` | | `wait` | | 0 at the end | lost after 2 Enters |
| 7 | Gateway down at launch, comes back 20 s later | `held` while down ≥ 10 s; then `starting` → `working` with the task typed in the pass that clears the hold | `held` · true → `starting` | tell the person → `wait` | held → working | exit 3 while held | held, then 3 passes |
| 8 | Lasting outage: `gateway disconnected: …` and `disconnected \| idle` alternating | `held` throughout, line 2 `held: OpenClaw Gateway is not running. Start it with openclaw gateway.` | `held` · true · sentence | `tell the person: <sentence>` | held | exit 3, `<n>: held · <sentence> Only the person can fix this.` | flaps held/idle |
| 9 | Drop under 10 s (`gateway disconnected: …` then `gateway reconnected \| idle`) | the state it had | unchanged | as before | as before | no exit 3 | held + exit 3 |
| 10 | No token (`Missing gateway auth token.`, exits) | `failed`, `failed: OpenClaw has no Gateway token. Run openclaw onboard.` | `failed` · `failure.error` `OPENCLAW_NO_TOKEN` | – | failed | exit 1 | not found |
| 11 | Working, rows arriving | `working` | `working` | `wait` | working | keeps waiting | green |
| 12 | Quiet tool step over 30 s (`⠦ running • 45s`) | `working` | `working` | `wait` | **working** | keeps waiting | `ps` `unknown` |
| 13 | Running on screen (`sending`, a waiting word), no open turn yet | `working` | `working` | `wait` | working | keeps waiting | `idle` |
| 14 | An exec that needs approval | `idle`, answer carries the Gateway's denial | `idle` | as idle | idle | exit 0 | test decides |
| 14b | A reply with a numbered list | `idle`, never `needs the person` | `idle` | as idle | idle | exit 0 | test decides |
| 15 | Idle after a turn | `idle`, `asked: …`, `answer: …` | `idle`, `ask`, `answer` | `tell`, then `close` when yours | idle | exit 0, `<n>: idle · read it: harness show <n>` | green |
| 16 | Final reply after tool calls, last history page all heartbeat runs | `answer (after N tool calls):` the text after the last tool | `answer`, `tools` | as idle | idle | exit 0; `watch` prints the answer | `wait`/`watch` may miss it |
| 17 | Failed run (`run error: …`, `connected \| error`, store `failed`) | `idle`, the answer is OpenClaw's error | `idle` | as idle | idle | exit 0 | test decides |
| 18 | Local run stopped (`local runtime stopped: <reason>`, `local stopped \| idle`) | `held: OpenClaw's local run stopped: <reason>` | `held` · true | tell the person | held | exit 3 | green (#4480) |
| 19 | Closed (`harness close`, or the TUI exits) | `stopped` | `stopped` | none | hidden (`--all` shows it) | exit 4 (0 when the caller closed it) | green |
| 20 | Launch refused: needs Node 24 | `new` refuses `ENGINE_CANNOT_RUN`, `OpenClaw needs Node 24.` | – | – | – | – | green |

Who needs the person (held, exit 3): every `OPENCLAW_STATES` sentence once it lasts (the Gateway one after 10 s) and
OpenClaw's local stop, as #4480 set them. Not held: a drop that reconnects within 10 s, the history load (Harness
recovers it), the other engines' reader states, a sentence this client does not know.

## Approaches

1. **End-to-end with a fake OpenClaw TUI and store (chosen for the goal test).** `cli/e2e/harness/fakeOpenclaw.mjs`,
   built as `fakeHermes.mjs` is: on `OPENCLAW_PATH`, answers `--version`, renames its process `openclaw`, keeps
   `<stateDir>/state/openclaw.sqlite` open, creates the agent store from `schema.sql`, draws the recorded frames (title,
   chat, status line, footer, the input box between two rules) in raw mode, behaves as the real TUI does on input
   (refuses a message while its history is not loaded and keeps it in the box; reloads on `/session`), writes the user
   row when it accepts one, and follows a JSONL step file the test appends to. `cli/e2e/openclawShow.e2e.ts` walks the
   matrix on `IsolatedDaemon` and asserts `show` text and `--json`, `ps --json`, `wait` and `watch`. Harness never talks
   to the Gateway, so the Gateway's states reach it only through the TUI and the store, which the fake draws and writes.
2. **The real OpenClaw, as a check (not in CI).** The reproduction's isolated run (a Gateway on a free port, a stub
   model, a proxy that drops one `chat.history`) is rerun on the branch by a tester, and so is the slow-device box
   below. They need OpenClaw installed, so they stay out of the committed suite.
3. **Unit matrix only.** Fakes exactly the daemon answers that are wrong; used only for each fix's red test.

## Constraints

- The core rules (`cli/AGENTS.md`): the fixes are to OpenClaw's binding, the first-task path and the turn/screen
  readers the core already owns; no feature and no new file in the core's process (`architecture.coreFiles.txt`
  unchanged), 100% coverage (`npm run test:core`).
- Nothing pasted twice; every retry and wait bounded; no fixed sleeps in tests.
- The PR and commits describe the client generically ("a client polling show after new") and name no customer.
- Platforms: shared TypeScript (macOS, Linux, Windows). The goal test runs on macOS and Linux; Windows by unit tests.

## Verification

- Red on `main`: the goal test run once at the base with the fake copied in; the PR lists the rows that failed.
- Green on the branch: the goal test, `e2e/agentClient.e2e.ts`, `e2e/identityHoldVisible.e2e.ts` and the Hermes and
  other-engine e2e files, on a temporary workflow (Linux) that runs only those files; the goal test once on this Mac.
- The real OpenClaw reproduction (scratch rig, isolated, stub model): the history-drop scenario delivers the task.
- The slow-device box (Podman, arm64 Debian 12, CPU-limited to about the device's slow cores, 4 GB, throttled disk;
  scripted in the scratch rig): N runs of `new` + polling `show`, on `main` and on the branch, with how often the first
  task was late or lost and `show`'s states over time, in the PR. A real-model run uses a key file only inside the
  isolated box, removed afterwards.
- Local gates: `npm run typecheck`, the unit tests of what changed, `npm run test:core`.

## Left to the builder

The fake's step-file format; the bookkeeping for the 10 s hold and the `/session` tries; where the first task's
bound is kept; whether `launch: starting` is safe (decision 4); the "create watch failed · readiness publication
unavailable" line the reproduction logged once (look at it; fix it here if it is on this path).
