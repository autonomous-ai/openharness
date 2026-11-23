# Voice to a resting ChatGPT app thread opens it, then queues the words to that thread

Branch: `fix/dial-chatgpt-voice-resting-thread`. Component: `cli/` (the devices process only). Platforms: macOS,
Windows and Linux, wherever the ChatGPT app's `codex://threads/<id>` link opens and Codex's queue runs (§ 6). No
firmware, Desktop or core change.

## Intent

Diego (2026-11-23, CLI 0.6.83): on the dial's ChatGPT page some Codex threads take no voice; a face tap shows
"See it in ChatGPT" (firmware `ui_habitat.c`: the row's caps lack `CABLE_CAP_V`).

Success: speaking to (or sending a voice draft to) a resting ChatGPT thread on the dial opens exactly that thread in the
app, and the words reach exactly that thread. A failure says so on the dial and in one fixed log line. **No prompt ever
reaches another thread** (the eval's wrong-session gate). The same cause is fixed wherever it drops voice from a thread
that could take it.

## What is there today (read on this branch, 2026-11-23)

- `codexAppSource.ts` lists the app's newest 16 threads from its metadata (`~/.codex/state_5.sqlite`), loaded or not,
  as idle rows, `resting: true`, id `observedAgentId('codex', threadId)`. Its `capabilities()` says `voice: false`; it
  has no `send`. A thread's row is that source's until the observed source lists a live copy with the same session key
  (the observed source comes first in `registry.ts`).
- The observed source (`observed.ts`) lists a Codex session from its hooks, or from the open scan every 60 s
  (`OPEN_SCAN_MS`), which finds a rollout a Codex process holds open. A live app thread takes voice through
  `codex queue --thread <id> --message=<text>` (`codexQueue.ts`), the app's own Codex CLI on macOS and Windows.
- A tap opens the thread by `codex://threads/<id>` (`codexApp.ts`, `appLink.ts`): macOS `open -b com.openai.codex`,
  Windows `windowsRaise.link`, Linux `xdg-open` once `xdg-mime` names an app for `codex://`. On macOS and Windows a tap
  whose link failed brings the app forward by its bundle (`forward`).
- The Claude app's resting sessions take voice through `AppWake` (`appWake.ts`, #4535): open by link, wait until that
  session's observed copy is live **and** its mod polls, then deliver; one wake at a time; 30 s.

## What Codex does (read from its source, `openai/codex` at `rust-v0.169.0`; the app's CLI is `0.169.0-alpha.11.1`)

1. **Opening a thread fires no hook.** `SessionStart` is queued when a session is created or resumed and run only at
   the start of its next turn (`run_pending_session_start_hooks`, called from `codex-rs/core/src/session/turn.rs`).
   So the app loading a thread by its link gives Harness no hook until a turn runs; only the open scan, up to 60 s
   later, sees the loaded thread. **Waiting for a hooked copy before sending, as the Claude wake does, would never be
   ready in 30 s.** This is why the PM's reading ("wait until the hooked Codex process for that thread id is live")
   cannot work as written for Codex; the design below keeps its intent (open, then that thread alone) another way.
2. **Codex's queue is durable and bound to the thread id.** `codex queue` sends `thread/queue/add` with the thread id
   (`codex-rs/tui/src/session_queue_commands.rs`) to the local app-server daemon, else to one it embeds. The server
   accepts a thread that is not loaded, from the thread store (`require_thread`,
   `codex-rs/app-server/src/request_processors/thread_queue_processor.rs`), and stores the message in Codex's durable
   queue (`codex-rs/ext/queue`, "Durable, storage-neutral user-message queue and idle dispatch"). A thread that is
   archived, a spawned sub-agent not loaded, or an unknown id is refused (exit 1).
3. **Every app-server picks up queued messages it did not write.** `watch_external_messages` ticks every 10 s and,
   after a thread is resumed in that server (`on_thread_resume`), looks for that thread's queue at the next tick, then
   starts the message when the thread is idle (`wake_if_loaded`, `start_if_idle`). This is how the dial's words reach a
   live app thread today: `codex queue` writes, the app's own server starts the turn.
4. `codex queue --resume` would resume the thread on the local daemon: not the app's own server, so it could load the
   thread in a second process. It is not used.

## Design

### 1. A resting row takes voice where its link opens and the queue runs

`CodexAppSource.capabilities(agent)` (it now takes the agent, as `ClaudeAppSource`'s does; `cableHost.ts` asks per
agent) says `voice: true` for a listed row when all three hold:
- the thread's link can open on this computer: `codexApp.canLink(pane)` (`appLink.ts`: true on macOS and Windows, on
  Linux once `xdg-mime` answered that `codex://` has an app). `createCodexAppAdapter`'s type gains
  `Pick<AppLinkVerbs, 'canLink'>`, as the Claude adapter's has;
- `codexQueue.can(true)`: the app's CLI, or a `codex` a launch would run;
- the queue's Codex home is the app's: `env.CODEX_HOME` resolves to the app's home (`~/.codex`, `devices.ts`
  `codexAppHome`). `codex queue` runs under `CODEX_HOME` (`codexQueue.ts`); under another home it would answer
  `thread not found` every time, so the row does not promise voice it cannot give (the live copy's `queueable` holds
  the same rule through its rollout's path). Computed once in `devices.ts` and handed in as a flag.

Nothing else in its caps changes. The firmware and the cable session then let the person talk to it as to any agent
with voice: `cableHost.sendTurn` calls the row's source's `send` (`cableHost.ts`), and the cable session no longer
refuses the voice start for it.

### 2. `CodexAppSource.send` hands the words to the wake

`send(agent, text)` finds its row and calls the devices' one `AppWake` with the row's values **at the moment the words
arrive**: thread id, agent id, name. Nothing re-reads the row after that. A row no longer listed answers
`<name> did not answer.` and opens nothing. `CodexAppSource.stop()` stops a ChatGPT wake only (`wake.stop('codex')`):
it runs at every attach where the app is not found, and must not stop a Claude wake under way.

### 3. The wake: `AppWake` gets a second target, not a fork

`appWake.ts` keeps one class and one instance for the whole devices process (one opening at a time for every dial and
both apps). What is shared: the too-long check before anything opens, the one-wake-at-a-time refusal, the link without
the opener's fallback, `stop()` on detach, the bound, and the fixed log and count words. What differs is what the words
wait for after the link, so a target says which app it is:

- **Claude app** (unchanged): wait until its observed copy is live and its mod polls, then `observed.send`.
- **ChatGPT app**: nothing to wait for once the link opened: the words go at once to Codex's durable queue of that very
  thread, `codexQueue.send(threadId, text, true)`, and the app's own server starts them when it has loaded the thread
  (Codex fact 3, within about 10 s of the load). Its answer is the wake's answer.

Shape (names are the plan's to settle, the split is not):
- `WakeTarget` becomes a union with an `app` field: `{ app: 'claude', localId, sessionId, agentId, name }` or
  `{ app: 'codex', threadId, agentId, name }`.
- `AppWakeDeps` keeps the Claude deps and gains the ChatGPT ones: `openThread(threadId, agentId): Promise<PaneSwitch>`
  and `queue: Pick<CodexQueue, 'send'>`. The one instance in `devices.ts` (today `claudeWake`) is renamed `appWake`
  and built before both sources.
- The log prefix, the count word and the app's name in the copy come from the target's app (`say` takes the app):
  `[claude-app] wake · …` / `wake-…` as today, `[codex-app] wake · …` / `codex-wake-…`. The count goes through the
  devices' `voiced` (`[device] voice · <word>`), as today.
- `waitsFor(sessionId)` answers true for a Claude wake that still waits (it gates the Claude mod's inbox) and for a
  ChatGPT wake whose link still runs, for its thread id (it gates the live copy's `codex queue`: a hook can list the
  thread before the wake queued, and the next words would go ahead of the first; once queueing, `codexQueue` refuses
  them itself). Found in the final review, 2026-11-23.
- `stop(app)` stops only that app's wake.

Steps for a ChatGPT target:

0. **Too long** (over `MAX_TEXT`): refused before anything opens, `Too long. Say it shorter.`
1. **One wake at a time**: words that come while any wake runs (for this row, another, or the Claude app) are refused:
   `Still opening <name of the one opening>. Try again in a moment.` A ChatGPT wake lasts about the link plus one
   `codex queue` (0.1 to 0.45 s, `QUEUE_TIMEOUT_MS` 10 s at most).
2. **Open first**, through the noted ChatGPT adapter's `show` (`devices.ts` `codexNoted.show(codexPane(threadId),
   agentId)`): the link alone, no `forward` (`appLink.ts` `show` never runs it, and does not ask whether the app is in
   front). A forward brings the app on whatever thread it shows, and words queued for a thread the app never loads
   would wait unseen. `codexNoted.show` notes the dial's own switch of that thread (`codexSwitches.note`) and the move,
   so the window title the app then reports is the dial's echo, not a person's pick. **Not `noteLink`**: that is the
   Claude app's attach echo, and without the ChatGPT note a late title of the thread shown before could move the dial
   back to it, and the person's next words would go there (the builder check's wrong-session finding).
   - `'failed'`: `<name> did not open in ChatGPT.`, **nothing is queued**.
   - `'busy'` (a rest of the same row is opening its link): refused as busy, nothing queued.
3. **Then queue** to the target's thread id only. Nothing else is read to choose the thread: not the dial's current
   row, not the app's front thread, not the window title.
4. **Phases.** Linking: `stop` and the 30 s timer end it (`stopped`, `timeout`), and a link answer that comes after
   either queues nothing. Queueing: the queue's own answer stands (it may already be queued); `stop` does not change it.
5. **Bound**: the queue's own 10 s timeout and the link's `RUN_TIMEOUT_MS`, under the wake's 30 s timer (`WAKE_MS`).

"Sent" means queued, as for a live thread today (docs/specs/2026-11-15-device-codex.md). Order is kept: Codex's queue
runs messages in order, and `codexQueue` refuses a second send to the same thread while one is being queued.

**Words after the first.** Once the thread's turn starts, its hooks list the observed copy, which takes the row and its
voice through its own `codex queue` path, to the same thread. Before that the row stays the source's: the next words
take a wake again, whose link reopens the thread already shown (harmless) and queue behind the first.

| Case | Dial | Log | Count |
|---|---|---|---|
| the link failed | `<name> did not open in ChatGPT.` | `[codex-app] wake · open failed` | `codex-wake-open-failed` |
| another wake is running, or a rest of this row is opening its link | `Still opening <name>. Try again in a moment.` | `[codex-app] wake · busy` | `codex-wake-busy` |
| too long | `Too long. Say it shorter.` | `[codex-app] wake · too long` | `codex-wake-too-long` |
| the dial detached before the queue | `<name> did not answer.` | `[codex-app] wake · stopped` | `codex-wake-stopped` |
| no answer in 30 s | `<name> did not open in ChatGPT. Try again.` | `[codex-app] wake · timeout` | `codex-wake-timeout` |
| queued | (the usual transcript) | `[codex-app] wake · sent · <ms> ms` | `codex-wake-sent` |
| the last words to that thread are still being queued | `<name> has not taken your last words yet.` | `[codex-app] wake · pending` | `codex-wake-pending` |
| `codex queue` timed out (it may be queued: never retried) | `<name> did not answer.` | `[codex-app] wake · queue timeout` | `codex-wake-queue-timeout` |
| `codex queue` failed (no binary, a non-zero exit) | `Update ChatGPT, then try again.` | `[codex-app] wake · queue failed` | `codex-wake-queue-failed` |
| `codexQueue` refused the id or the text before running, or `codex queue` threw | `<name> did not answer.` | `[codex-app] wake · refused` | `codex-wake-refused` |

The Claude target's lines and counts stay as they are (`[claude-app] wake · …`, `wake-…`). No id, name, folder or
text in any line or count.

### 4. Running threads that lose voice: the same cause

The cause is one: a ChatGPT thread whose row is the source's (no live observed copy) has no voice. Every running case
read here is that case, and § 1-3 fix it:

- **Loaded in the app, no turn since** (the person opened it, or a tap did): no hook (Codex fact 1); the open scan
  lists it up to 60 s later. Until then the row is the source's: now it takes voice; the link shows the thread already
  open; the app's server, which holds it loaded, starts the queued words at its next 10 s tick.
- **A thread whose hooked copy ended** (the app quit; `HostAgent.ended`) gives its row back to the source: now with
  voice, and the link starts the app again.
- **A live observed copy** (hooked, or found by the scan) already takes voice through `codex queue` when its rollout is
  in Harness's Codex home and a `codex` can run (`observed.ts` `queueable`); unchanged.

Read and left as they are (not this cause), each in the final report:
- A thread started in a terminal is on its terminal's page, not ChatGPT's (`X10`); unchanged.
- A live copy whose app is not learnt yet (its first hook, before the caller walk answers) queues through the `codex` a
  launch would run instead of the app's: it has voice when that `codex` is there.
- A person whose `CODEX_HOME` is not `~/.codex`: the app's threads are in `~/.codex`, Harness's queue and `queueable`
  use `CODEX_HOME`. Their live app threads already have no voice (`queueable`'s path check); their resting rows get
  none either (§ 1), so the dial never offers what always fails. Queueing into the app's home for them is its own item.

### 5. The dial meanwhile

No new frame, copy or firmware: the dial's sending state until the answer, and its voice error view for a failure.

### 6. Platforms

| OS | Open path | Queue | This feature |
|---|---|---|---|
| macOS | `open -b com.openai.codex codex://threads/<id>` | the app's CLI in `ChatGPT.app`, else `codex` | on |
| Windows | `windowsRaise.link` (`harness-pty open-link`, then a raise) | the package's `app\resources\codex.exe`, else `codex` | on; a signed-in queue into an app thread end to end is unverified on Windows (as today for live threads) |
| Linux | `xdg-open codex://…` once `xdg-mime` names an app | `codex` a launch would run | on once both hold; voice stays off otherwise |

The new code is in the devices' import graph only; the core's static graph does not change
(`src/architecture.spec.ts`).

### 7. What does not change

The core, the firmware, Desktop, the thread reader, the Claude app's wake, a live thread's voice path (but for the
wake's `waitsFor` gate while that thread's link runs, § 3), `codex queue`'s
arguments (no `--resume`, Codex fact 4).

## Tests (fakes and throwaway homes only; never the real ChatGPT app or `~/.codex`)

- `codexAppSource.spec.ts`: caps say voice exactly when `canLink`, `can(true)` and the home flag all say so, per
  agent; `send` passes the row's values at that moment; a row gone answers `did not answer` and opens nothing;
  `stop()` stops the ChatGPT wake only.
- `appWake.spec.ts`, ChatGPT target (fake link, fake queue recording **which thread ids received words**):
  link then one queue call with the target's id and the exact text; a failed or busy link queues nothing; too long
  opens nothing; a second prompt while a wake runs (same row, another row, or a Claude wake) is refused busy and
  nothing reaches its thread; stopped, or timed out, during the link queues nothing, and the link's late answer queues
  nothing; stopped during the queue keeps the queue's answer; each queue outcome gives its text; `waitsFor` is true
  for a ChatGPT wake's thread alone and only while its link runs; `stop('codex')` leaves a Claude wake running; every line and count is one of the fixed ones. The
  Claude target's tests stay green unchanged.
- `devices.spec.ts`: voice to a resting ChatGPT row through the devices' real wiring runs one `codex://threads/<id>`
  link, no forward (no bare `open -b com.openai.codex`, no Windows raise without the link), and one
  `codex queue --thread <id>`, link first; the dial's own switch is noted, so the app's window title of that thread
  right after does not count as a person's pick, and a late title of the thread shown before does not move the dial;
  on `linux` with no scheme app the row's caps lack `v`; with `CODEX_HOME` not the app's home they lack `v`; on
  `win32` the link goes through the Windows raise fake.
- `cableSession.spec.ts`: a voice draft's send to such a row resolves with the wake's refusal text.
- The dial eval: a new ChatGPT scenario `X12`, "Voice on a resting thread: it opens, then the exact words are queued to
  it once", with the existing step and check kinds: `codex.write ['t1']`, `listed('chatgpt', ['t1'])`, `voice`;
  checks `open` (`link: true`) and `voice` (`path: 'codex'`, reached, once, exact, graded from the fake `codex queue`'s
  record by `--thread`); probe: the same words on the ghost thread. No hook: the thread is only in the metadata. Kept
  small; rebased onto `feat/dial-eval-iterm2` once it merges. The eval cannot yet fail a forward or check that the
  link came before the queue: those are pinned by `devices.spec.ts` above, not by new eval kinds.

## Verification (end to end, for the plan)

- `devices.spec.ts` above runs the real wiring with fakes on all three platforms' branches.
- The dial eval's tier A run of `X12` on this Mac (fakes only).
- An end-to-end test on the real daemon with fakes only (`cli/e2e/`, beside `deviceCodexAppThreads.e2e.ts`): the app's
  threads from `codexAppFixture` in the daemon's throwaway home, the app's CLI as the harness's fake
  (`harness/codexAppCli.ts`, its queue ledger), `open` and on Linux `xdg-open`/`xdg-mime` as the harness's fakes, a
  fake dial. Voice to a resting thread: the fake opener records exactly one `codex://threads/<id>` link and no bare
  `open -b`, then the app CLI's ledger records exactly one queue call with `--thread <id>` and the exact words, after
  the link; the other threads get nothing. Then the fake Codex "resumes" the thread as the app's server would (Codex
  fact 3): its hooks for that thread id (SessionStart `resume`, UserPromptSubmit) make the observed copy, which takes
  the row on the ChatGPT page, working, with voice. A failed link (the fake opener exits non-zero) queues nothing and
  the dial gets `did not open in ChatGPT`. macOS and Linux, as that file runs.
- **No real engine runs on this Mac** (PM, 2026-11-23: Diego's rule, no real engine in a temp folder, npm or the app's
  CLI). Codex facts 1-4 are read from its source only. After the merge, a check for Ken or Diego on a real ChatGPT app,
  written in the PR body as numbered steps: 1. quit nothing; on the dial's ChatGPT page pick a thread not opened since
  the app started; 2. speak a short sentence; 3. the app opens that thread, and within about 10 s its turn starts with
  those words; 4. no other thread gets them; 5. with the ChatGPT app quit, speak to a resting thread: the app starts on
  that thread and runs the words. Windows: the same steps on the Windows VM.

`cli/AGENTS.md`'s devices row says the ChatGPT app's threads are spoken to through the wake, as the Claude app's are.

## Decisions for the PM

1. **No wait for a hooked process** (Codex fact 1): the words go to Codex's durable queue of that thread id right after
   the link opened, through the same `AppWake` (one class, a second target). Recommended. The alternative, waiting for
   the open scan to list the thread, takes up to 60 s, past the 30 s bound and the dial's 65 s reply wait.
2. **Link first, then queue**; a failed link queues nothing. Recommended: queued words for a thread the app never loads
   would wait unseen.
3. **One wake at a time across both apps** (the existing rule for every dial). Recommended.
4. `--resume` not used (Codex fact 4). Recommended.
5. **No voice on a resting row when `CODEX_HOME` is not the app's home** (§ 1): honest caps instead of a queue that
   always fails. Recommended; queueing into the app's home is its own item.

## Out of scope

- `CODEX_HOME` other than `~/.codex` for the app's threads (§ 4).
- The dial's own-turn mark for the queued turn (`observed.ts` `dialPrompt`): there is no observed copy to mark when the
  words are queued; the turn is then read as a person's prompt. The dial already shows that thread.
- A voice draft's resend after a refusal (`voiceDraft.ts`, every agent).
