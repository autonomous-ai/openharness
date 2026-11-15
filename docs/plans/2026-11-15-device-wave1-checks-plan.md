# The dial with tmux and VS Code, app closed (wave 1 checks): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Tasks 1, 2, 3, 5, 6 and 7 are test-first: a
> red commit (the tests alone), then the code commit. Tasks 4 and 8 are one commit each. Steps use checkbox (`- [ ]`)
> syntax for tracking. `cli/e2e/scratchWave1.e2e.ts` in the worktree is the check's scratch file: no task stages it.

**Goal:** With Harness Desktop closed, an agent in the person's own tmux is listed on the dial and a tap shows its
pane (F1), a tap on a Harness agent opens Desktop on it (F2), and a tap on a Claude Code session in the VS Code
extension's tab shows that tab (F3).

**Architecture:** The engines' hook (`cli/hook/notify.mjs`) and the devices process only (`cli/src/cable/`,
`cli/src/services/devices.ts`). The hook sends a session in a tmux pane the person opened down the path a paneless
session takes (`/api/hook/observed`), with two more hints. The devices name the host, check the pane's process before
they switch the person's own tmux client to it, start Harness Desktop and hand it the tap once its window connects,
and open the VS Code extension's own link. Everything is in memory: nothing is stored. The firmware and Desktop do
not change, and the core changes by one comment line.

**Tech Stack:** TypeScript (Node 22 here, CI pins 24), the hook in plain Node built-ins (`.mjs`), Vitest, tmux. No new
dependency.

**Spec:** [docs/specs/2026-11-15-device-wave1-checks.md](../specs/2026-11-15-device-wave1-checks.md). Read it with
this plan, the root `AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md` and `cli/src/core/AGENTS.md` (rule 7).
The spec is the authority.

## Before any task

- **The base is `main` with #4331 merged.** #4311 and #4326 are on `main` already (`f979a5c6c3`, `aad8dcd535`), and
  #4331 (`feat/dial-terminal-follow`) is being rebased onto it. **No code before #4331 is on `main`**, and it is the
  only pull request code waits for (PM, 2026-11-15). Then rebase `fix/device-wave1-checks` onto `origin/main`.
- This plan was written against two trees that are not one yet: `origin/feat/dial-terminal-follow` at `c6f5b7ecd6`
  for #4331's code, and `origin/main` at `aad8dcd535` for #4326's. It names functions, never line numbers. Each task
  has a **Re-check after the rebase** list: do it first, against `main` with #4331 in it, and stop and report if a
  named function is gone or does something else.
- Where #4326 or #4331 has code beside a function this plan changes, the task says so.

## Decided

By the PM, 2026-11-15, all in the spec:

- F1, F2 and F3 in one pull request, each test first.
- Q1 = A: the devices process may run only `tmux switch-client` (or a select) to a person's own pane that a hook named
  and whose process it checked. It never types, creates or closes there, and never writes to a pane or session
  Harness made. The rule goes into `cli/src/services/AGENTS.md` in this pull request (Task 4).
- Q2 = A: F3 lands here. The pull request keeps `hold` until manual check 3 passes on Diego's Mac; if it fails, F3's
  commits come out. So F3 is one task, in commits of its own, and no task depends on it (Task 7).
- No firmware change, no Desktop change, and no change to the core's code: one comment line (answer 5 below).

By the PM, 2026-11-15, on this plan's five questions (the spec holds each):

1. **The tap names the tmux client it moves** (`switch-client -c`): the one used last among those **not on a session
   Harness made**, by the owner rules the hook reads (the `@harness_daemon` tag, the `harness-` session prefix). A
   client on a Harness session is never moved. With no such client nothing is switched, and only the app comes
   forward (Task 3; Task 8 proves it with two clients).
2. **Code waits for #4331 only.** #4326 is on `main` (`aad8dcd535`).
3. **No Orca handle is kept for an agent whose hook names `TMUX_PANE`.** Its voice is the mod's only (Task 3).
4. **`TERM_PROGRAM=tmux` with a bundle id no table lists** (tmux in Alacritty) is on the `tmux` page, as with no
   bundle id (Task 2).
5. **One comment line in the core:** `MAX_HINTS`'s comment in `cli/src/core/observedHook.ts` says the hook caps what
   it sends at this number. No code changes in the core. It rides in the task that adds the hook's cap (Task 1).

And: **the pull request's body gives the measured cost of the new tmux calls for a `Notification` in a Harness pane.**
Task 1 measures it and writes the numbers into its code commit's message; the body copies them from there.

While planning, from the code (say so if one is wrong):

- **The hint list's order.** `TMUX_PANE` goes after `ZELLIJ`, where `detectHost` reads it. `CLAUDE_CODE_ENTRYPOINT`
  (F3) goes last: it is the one the cap drops first, and a tap without it still brings VS Code forward.
  `TERM_PROGRAM` and `__CFBundleIdentifier` stay first: every agent's page and app come from them.
- **`tmux` is the sixteenth app id**, the firmware's `CABLE_MAX_APPS`. It fits; the next app id needs a decision.
- **The command runner gives stdout too.** `OrcaDeps.run` answered only an exit code, and the pane's process is
  tmux's stdout. One runner for every command: `run` now answers `{ code, stdout }`.
- **`· not its pane` is logged only when tmux named a process and the agent's chain does not hold it.** Any other
  miss (tmux did not answer, the process table could not be read, no client of the person's to move) is the existing
  `· fallback` line. Nothing is ever switched without the check.
- **How the client is chosen** (answer 1). One `tmux list-clients` call after the check, with the format
  `#{client_activity}|#{client_name}|#{@harness_daemon}|#{session_name}`. A client is on a Harness session when its
  tag is not empty or its session's name begins `harness-` (`lib/harnessSessionLabel.ts`: `HARNESS_OWNER_OPTION`,
  `isHarnessSession`). The tag is read through the pane the client shows, so a client showing a Harness pane the
  person moved into a session of their own is not moved either. Of the rest, the greatest `client_activity` wins.
  tmux gives it in whole seconds, so on equal seconds the one tmux lists later wins: it attached later, which is the
  one a bare `switch-client` moved (seen on tmux 3.6b).
- **F2's `f` follows the launcher.** The devices give the cable host a way to start Desktop on macOS only
  (`launchDesktop`); a host given one says `focus: true` for Harness agents. No platform is read twice, and every
  existing test keeps `sva`.
- **F2: every tap runs `open -b` and replaces the waiting open; the 30 s start at the tap.** `open -b` is idempotent,
  and a window that connects while `open` still runs must find the open waiting.
- **F3 depends on Task 6 only for its place in the history:** its commits must be the last on `open.ts` and
  `open.spec.ts`, so they come out without a conflict (Q2). The longest chain is three tasks: 3 or 5, then 6, then 7.
- **The end-to-end cases are a task of their own, after the code** (Task 8), so Tasks 1 to 5 can run apart. Each
  case is seen to fail once with its code switched off, as #4331 did ("Can it fail?").

## Open questions

None. The five this plan asked are answered in Decided.

## Global Constraints

- No code under `cli/src/core/` changes: one comment line, on `MAX_HINTS` in `core/observedHook.ts` (Task 1).
  `src/architecture.coreFiles.txt` gains no line. Nothing under `devices/` (firmware), `desktop/` or `device-app/`
  changes.
- Every value from a hook is checked against its own form before use: pane id `/^%[0-9]{1,9}$/`, session id a
  lower-case UUID, entrypoint the word `claude-vscode`, bundle id VS Code's own (`com.microsoft.VSCode`). Each command
  runs with no shell, every value one argument, under `RUN_TIMEOUT_MS` (10 s).
- No hint carries a secret. `TMUX` (the socket path) and VS Code's IPC paths are never read or sent.
- tmux is the daemon's: the name `tmux` on its `PATH` and its own environment, as `lib/tmux.ts` runs it. Never `-L`
  or `-S`.
- The devices run three tmux commands and no other: `display-message -p` and `list-clients -F` (both only read), and
  `switch-client -c <client> -t <pane>`. Never a bare `switch-client`: the client is always named, and it is never
  one on a session Harness made.
- Log lines name the app only, never a pane, a pid, a session or a path. The lines, verbatim:
  `[device] open · tmux · not its pane`, `[device] open · harness · no window`, and the existing
  `[device] open · <app> · fallback`.
- Copy, verbatim: `Harness did not open it.` (the existing `<host> did not open it.`).
- Values, verbatim: `MAX_HINTS` 10, `WALK_PARENTS` 16, `HARNESS_OPEN_WAIT_MS` 30 000, the bundle id
  `ai.autonomous.harness`, the link `vscode://anthropic.claude-code/open?session=<uuid>`.
- Nothing is typed into a tmux pane the person owns: no `send-keys`. Voice reaches such an agent through its mod only.
- Platforms: macOS all three; Linux F1 only (listing, voice, the switch, no app forward); Windows none.
- **No test moves anything on the developer's Mac** (`cli/AGENTS.md` rule 6). Unit specs record commands and run
  none. An end-to-end test sends `agent.open` only to an agent with no bundle id and no other app's pane in its
  hints, and no end-to-end test sends `agent.open` to a Harness agent with no window: on macOS that would run the real
  `/usr/bin/open -b ai.autonomous.harness`.

## Found while reading the code

- `hookNotify.spec.ts` "lists as many hint names as the core takes" pins the list's length to `MAX_HINTS`. Task 1
  replaces it: the list is longer now, and the hook sends the first ten set.
- `cli/e2e/dialAppFilter.e2e.ts` uses `TERM_PROGRAM: 'tmux'` twice as "an unknown terminal". It names the `tmux` app
  after Task 2, so those two cases take another unknown name.
- A Notification in a Harness pane returned before any tmux call. Whether a pane is the person's own is tmux's to
  say, so it now costs `tmux -V` and one `display-message` (each under the hook's 2 s step limit). Every other event
  already made both. Task 1 measures it for the pull request.
- `services/devices.spec.ts` mocks `cable/hosts/scannedApp.js` with `learnApps` alone; a second import from it needs
  a second name in the mock (Task 3).
- `ObservedSource.focus` (#4331) opens, then selects the tab whose tty is the agent's. For an agent in tmux inside
  Terminal, iTerm2 or Ghostty that tty is the pane's, which no tab holds: Harness Device answers `none`
  (`Selected::NoTab`; #4331's spec, "What the apps offer", "The agent's tty"). The tmux pane decides, through
  `actions.open`, which runs first.
- A tmux server keeps the environment it was started in. Started in an Orca terminal, its panes carry that terminal's
  `ORCA_TERMINAL_HANDLE`, and `ObservedSource.send` would type the dial's words into it. So no handle is kept
  (answer 3).
- Every terminal Harness has open is a control-mode client on the daemon's tmux server
  (`tmux -C attach-session -t <pane>`, `lib/tmuxStream.ts`). `tmux switch-client -t <pane>` with no `-c` moves the
  client used last, a control-mode one included. Checked on tmux 3.6b, on a private server, with one `-C` client on
  a session of the person's and a later one on a tagged pane in a session named `harness-claude-1`: the bare switch
  moved the Harness one; `switch-client -c <the person's> -t <pane>` moved the person's and left the other. So the
  client is named (answer 1).
- In the same check: `list-clients -F` lists clients in the order they attached; `#{@harness_daemon}` reads the tag
  of the pane the client shows; `#{client_activity}` is in whole seconds, and a control client's commands do not move
  it; a control client's `#{client_name}` is `client-<pid>`, a terminal's is its tty; with no client the call exits
  0 and prints nothing.
- **Not covered by answer 1's rule, and left as it is.** A Harness terminal attaches to the session its pane is in.
  If the person moved a Harness agent's window into a session of their own, that terminal's client is on a session
  Harness did not make. While that session shows another window, its tag reads empty, and it can be the client the
  tap moves. It takes a moved window, an open Harness terminal on it, and no client of the person's used since. The
  rule is the PM's, per session; a rule per client would need Harness to mark its own clients (Left out).
- In the end-to-end harness `d.tmux.run` runs tmux with the test shell's environment, not `d.env`. A pane made that
  way can inherit the developer's `__CFBundleIdentifier` or `ORCA_TERMINAL_HANDLE`, and a tap would then act on the
  developer's own apps. Task 8 blanks every hint name in the pane.
- Before tmux 3.7 the server can crash when a control client attaches beside a session being made or closed
  (`lib/tmuxControlGate.ts`; Ubuntu 24.04 ships 3.4). Task 8 makes every session first, then attaches.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/hook/notify.mjs` | `ownPane`, `MAX_HINTS`, `TMUX_PANE` hint (1); `CLAUDE_CODE_ENTRYPOINT` hint (7) | 1, 7 |
| `cli/src/hookNotify.spec.ts` | their cases | 1, 7 |
| `cli/src/core/observedHook.ts` | `MAX_HINTS`'s comment, one line; no code | 1 |
| `cli/src/cable/hosts/hostDetect.ts`, `hostDetect.spec.ts` | host and app `tmux` (2); `HARNESS_BUNDLE` (6, source only) | 2, 6 |
| `cli/e2e/dialAppFilter.e2e.ts` | two cases take another unknown terminal | 2 |
| `cli/src/cable/hosts/orca.ts`, `orca.spec.ts` | `run` answers stdout | 3 |
| `cli/src/cable/hosts/open.ts`, `open.spec.ts` | the tmux pane and the client it moves (3); `desktop` (6); the VS Code link (7) | 3, 6, 7 |
| `cli/src/cable/hosts/observed.ts`, `observed.spec.ts` | `openTarget`'s third argument, no Orca handle in tmux (3); the session id (7) | 3, 7 |
| `cli/src/services/devices.ts`, `devices.spec.ts` | `processes` (3); `launchDesktop`, `desktopTimedOut` (6) | 3, 6 |
| `cli/src/services/AGENTS.md` | the Q1 rule | 4 |
| `cli/src/cable/hosts/harness.ts`, `harness.spec.ts` | `focus` where Desktop can be started | 5 |
| `cli/src/cable/cableHost.ts`, `cableHost.spec.ts` | the waiting open | 5 |
| `cli/e2e/deviceWithoutApp.e2e.ts` | a Harness agent's caps on macOS (6); the tmux cases (8) | 6, 8 |
| `cli/e2e/harness/ownTmux.ts` | new: Claude Code in the test's own tmux session, and control clients | 8 |

## Review Focus

Each line is pinned by a test in the task that owns the code.

- **A terminal Harness has open (Desktop, a phone, `hn`) is the tmux client used last.** The tap never moves it: the
  person's own client is moved, or none. Task 3, `open.spec.ts` "the client switched is the one used last among those
  not on a session Harness made" and "with no client of the person's nothing is switched"; Task 8's second case, on
  a real tmux.
- **tmux started inside an Orca terminal.** The dial's words are never typed into that terminal: the agent has voice
  only once its mod polls. Task 3, `observed.spec.ts`, "an agent in tmux takes the dial's words through its mod only".
- **A Notification from a Harness pane while tmux is too slow to answer.** It is told to nobody, as before, and the
  hook ends inside its step limits. Task 1, "tmux too slow to answer".
- **The window says its tabs while `open -b` still runs, and again a moment later.** The agent is opened once.
  Task 5, "a window that comes while Desktop is still being started" and "a second word from the window".
- **The session moved to another pane, or its process is gone by the tap.** The pane and process checked are its
  latest event's; a process that is gone is "not its pane". Task 3, `observed.spec.ts` "the pane a tap opens is its
  latest event's" and `open.spec.ts` "an agent whose process is gone".

No test can pin this one: Desktop may say its tabs before it can open a tile, and then drop the `dial_open` it is
handed. Manual check 5 is the proof, and a miss there is a Desktop change, which this work does not make.

---

### Task 1: The hook tells the devices of a session in the person's own tmux pane

**Depends on:** nothing. **Effort:** xhigh.

**Files:**
- Modify: `cli/hook/notify.mjs` (`HOST_HINTS`, `hostHints`, `main`; new `ownPane`, `MAX_HINTS`)
- Test: `cli/src/hookNotify.spec.ts`
- Modify: `cli/src/core/observedHook.ts` (the comment line above `MAX_HINTS`; no code)

**The test that fails before the change:** `cli/src/hookNotify.spec.ts`, "claude in a tmux pane the person opened
posts to /api/hook/observed with TMUX_PANE, and registers nothing".

**Interfaces:**
- Produces: `hostHints.TMUX_PANE` on every observed event of such a session; at most `MAX_HINTS` hints, in
  `HOST_HINTS`' order. Task 7 appends one name to `HOST_HINTS` and to the spec's `HINTS`.

**Re-check after the rebase:** `main()` still begins with `paneless`, the `Notification` return and
`routeToPaneOwner`, in that order; `describePane` still caches per pane; `paneFacts` still answers
`{ pid, taken }` with `taken` `'yes' | 'no' | 'if-held'`; `core/observedHook.ts` still has
`export const MAX_HINTS = 10` under the comment "As many as the hook's list holds…".

- [ ] **Step 1: Write the failing tests**, inside `describe('hook notify: a session outside a pane')`, where `HINTS`,
  `noHints` and `folder` are. `HINTS` gains `'TMUX_PANE'` after `'ZELLIJ'`.

```ts
const own = { tmuxPane: '%7', paneSession: 'mine' }
const typed = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: '/w', prompt: 'prompt-secret' }
const waits = { hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 'sess-1', cwd: '/w' }
const urls = (requests: Array<{ url: string }>) => requests.map((request) => request.url)

it.each(['claude', 'codex'] as const)('%s in a tmux pane the person opened posts to /api/hook/observed with TMUX_PANE, and registers nothing', async (engine) => {
  const { port, requests } = await collect()
  await runHook({ port, engine, ...own, env: noHints, codexHome: folder('adapter-hook-own-codex-'), input: typed })
  expect(urls(requests)).toEqual(['/api/hook/observed'])
  expect(requests[0].body).toMatchObject({ engine, sessionId: 'sess-1', event: 'turn-start', callerPid: process.pid })
  expect(requests[0].body.hostHints).toEqual({ TMUX_PANE: '%7' })
  expect(JSON.stringify(requests[0].body)).not.toContain('prompt-secret')
})

it('its Notification is told, as a paneless session\'s is', async () => {
  const { port, requests } = await collect()
  await runHook({ port, ...own, env: noHints, input: waits })
  expect(requests.map((request) => [request.url, request.body.event])).toEqual([['/api/hook/observed', 'needs-input']])
})

// The recorded prompt, as 'hook notify terminal scope' sends it.
it.each([
  ['a Harness pane', { paneSession: 'harness-claude-1790000000000' }],
  ['a pane another daemon tagged', { paneSession: 'mine', paneOwner: 'abcdef0123456789' }],
  ['a pane in a session an older build named', { paneSession: 'claude-1790000000000' }],
  ['a pane tmux cannot describe', {}],
])('%s is in a pane, as before: its prompt goes to the daemon, its Notification nowhere', async (_what, pane) => {
  const { port, requests } = await collect()
  const recorded = JSON.parse(readFileSync(new URL('./lib/__fixtures__/prompt-hooks.json', import.meta.url), 'utf8')).claude.input
  await runHook({ port, tmuxPane: '%7', ...pane, input: recorded })
  await runHook({ port, tmuxPane: '%7', ...pane, input: waits })
  expect(urls(requests)).toEqual(['/api/hook/session-start'])
})

// The shipped budget, so tmux's step limit is its 2 s: the shim answers after 3.
it('tmux too slow to answer: a Notification in a pane is still told to nobody', async () => {
  const { port, requests } = await collect()
  await runHook({ port, ...own, tmuxDelaySeconds: 3, env: { HARNESS_HOOK_DEADLINE_MS: '4500' }, input: waits })
  expect(requests).toEqual([])
})

it('sends the first MAX_HINTS of the names set, in the list\'s order', async () => {
  const { port, requests } = await collect()
  const set = Object.fromEntries(HINTS.filter((name) => name !== 'TMUX_PANE').map((name, index) => [name, `hint-${index}`]))
  await runHook({ port, ...own, env: set, input: typed })
  expect(HINTS.length).toBeGreaterThan(MAX_HINTS)
  expect(Object.keys(requests[0].body.hostHints as object)).toEqual(HINTS.slice(0, MAX_HINTS))
})
```

  The "is in a pane, as before" cases and "tmux too slow to answer" pass before the change too: they pin what must
  not move. If the base posts another list for the recorded prompt, the base's list is the expectation.

  Change three existing cases in the same `describe`:
  - "hostHints carries only the allowlist…" and "the largest body the hook can build is under 4096 bytes" build their
    hints from `HINTS.filter((name) => name !== 'TMUX_PANE').slice(0, MAX_HINTS)`: `runHook` sets no `TMUX_PANE`
    without a pane, and the hook sends ten at most.
  - "lists as many hint names as the core takes" becomes "lists its hint names in this order, and sends no more than
    the core takes": `expect(listed).toEqual(HINTS)`, and
    `expect(Number(/const MAX_HINTS = (\d+)/.exec(readFileSync(HOOK, 'utf8'))?.[1])).toBe(MAX_HINTS)` in place of the
    length check.

- [ ] **Step 2: Run them**

  Run: `cd cli && npx vitest run src/hookNotify.spec.ts -t 'tmux pane the person opened|its Notification is told|first MAX_HINTS|in this order'`
  Expected: FAIL. The first posts `/api/hook/session-start`; the list has no `TMUX_PANE` and no `MAX_HINTS`.

- [ ] **Step 3: Commit the red tests**: `test(hook): a session in the person's own tmux pane is told to the devices (red)`

- [ ] **Step 4: Implement in `cli/hook/notify.mjs`**
  - `const MAX_HINTS = 10`, beside `HOST_HINTS`: the core's observed route takes no more
    (`core/observedHook.ts`, which `hookNotify.spec.ts` keeps this equal to). In `hostHints()` the comment "more
    hints than this list holds" becomes "more hints than `MAX_HINTS`".
  - `HOST_HINTS`: `'TMUX_PANE'` after `'ZELLIJ'`. Its comment says what the order is for: the app's names first, then
    the hosts from the nearest, so a session with more than ten set loses the farthest.
  - `hostHints()` stops once it holds `MAX_HINTS`.
  - `async function ownPane(pane)` → boolean: the pane id is `%<digits>`, `describePane(pane)` answered, its `owner` is
    empty, and `paneFacts(pane, paths().dataDir)` reads `taken: 'no'`. False for anything else, a pane tmux could not
    describe included. Its comment names the rule it shares with registration (`paneFacts`) and the spec.
  - `main()`: `const paneless = (!tmuxPane && !PTY_PANE) || await ownPane(tmuxPane)`. Nothing else moves: the
    `Notification` return, `routeToPaneOwner` and the paneless branch read `paneless` as they do. Update the comments
    there and the file's header line "Outside a pane".

- [ ] **Step 5: The core's comment, and nothing else in the core** (answer 5). In `cli/src/core/observedHook.ts`
  the one comment line above `MAX_HINTS` becomes:

```ts
/** The hook caps what it sends at this number (hook/notify.mjs MAX_HINTS): its list holds more names, and it sends the first of those set. */
```

  `git diff --stat -- cli/src/core` must show that file alone, one line changed. A comment moves no coverage:
  `npm run test:core`, the gate for `src/core/`, runs in Tasks 3 and 6 and on the final head (Verification 1).

- [ ] **Step 6: Run**

  Run: `cd cli && npx vitest run src/hookNotify.spec.ts src/core/observedHook.spec.ts src/architecture.spec.ts`
  Expected: PASS, every case; none skipped that ran before.

- [ ] **Step 7: Measure the new cost, for the pull request's body.** A `Notification` in a Harness pane returned
  before any tmux call; it now makes two. On a private tmux server (`src/testing/isolatedTmux.ts`), with one session
  named `harness-measure`, time each call twenty times and take the medians, in milliseconds:
  `tmux -V` and `tmux display-message -p -t <pane> '#{pane_pid}|#{session_name}|#{@harness_daemon}'`.
  Nothing of this is committed as code.

- [ ] **Step 8: Commit**: `hook: a session in the person's own tmux pane is told to the devices, and registers nothing`

  The commit message's body carries the measure, in these words, so it travels with the branch:

```text
A Notification in a Harness pane now asks tmux whose pane it is before it returns:
tmux -V <x> ms + display-message <y> ms (medians of 20, tmux <version>, macOS arm64). Before: no tmux call.
```

  Report the two numbers with the task's SHAs. The pull request's body copies these lines under its numbers
  ("For the pull request", at the end of this plan).

### Task 2: The host and the app `tmux`

**Depends on:** nothing. **Effort:** medium.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts`
- Test: `cli/src/cable/hosts/hostDetect.spec.ts`
- Modify: `cli/e2e/dialAppFilter.e2e.ts` (two cases)

**The test that fails before the change:** `cli/src/cable/hosts/hostDetect.spec.ts`, "TMUX_PANE names the host tmux,
after herdr, Rex and Zellij and before kitty and WezTerm".

**Interfaces:**
- Produces: `detectHost` answers `'tmux'`; `detectApp` answers `'tmux'`; `hostDisplayName('tmux')` and
  `appDisplayName('tmux')` are `'tmux'`; `APP_IDS` holds 16.

- [ ] **Step 1: Write the failing tests** in `hostDetect.spec.ts`

```ts
it('TMUX_PANE names the host tmux, after herdr, Rex and Zellij and before kitty and WezTerm', () => {
  expect(detectHost({ TMUX_PANE: '%3' })).toBe('tmux')
  expect(detectHost({ TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.mitchellh.ghostty' })).toBe('tmux')
  for (const own of ['HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ']) expect(detectHost({ [own]: '1', TMUX_PANE: '%3' })).not.toBe('tmux')
  for (const own of ['KITTY_WINDOW_ID', 'WEZTERM_PANE', 'ORCA_AGENT_SESSION_ID']) expect(detectHost({ [own]: '1', TMUX_PANE: '%3' })).toBe('tmux')
  // TERM_PROGRAM alone names no host: a pane is what a tap switches to.
  expect(detectHost({ TERM_PROGRAM: 'tmux' })).toBe('terminal')
})

it('tmux in Ghostty is on Ghostty\'s page; with no app named, tmux has a page of its own', () => {
  expect(detectApp({ TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.mitchellh.ghostty' })).toBe('ghostty')
  expect(detectApp({ TERM_PROGRAM: 'tmux' })).toBe('tmux')
  expect(detectApp({ TMUX_PANE: '%3' })).toBe('tmux')
  expect(detectApp({ TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', KITTY_WINDOW_ID: '1' })).toBe('tmux')
  // tmux in Alacritty: a bundle id no table lists (PM, 2026-11-15).
  expect(detectApp({ TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'org.alacritty' })).toBe('tmux')
  expect([hostDisplayName('tmux'), appDisplayName('tmux')]).toEqual(['tmux', 'tmux'])
})
```

  Change in the same file: "an unknown bundle id or TERM_PROGRAM gives the unknown app" reads
  `detectApp({ TERM_PROGRAM: 'rio' })`; "APP_IDS has 15 ids, at most 16…" becomes 16 ids, still at most 16 (the
  firmware's `CABLE_MAX_APPS`); the last case's `others` has 14.

- [ ] **Step 2: Run them**: `cd cli && npx vitest run src/cable/hosts/hostDetect.spec.ts`. Expected: FAIL, `'terminal'`
  where `'tmux'` is expected, and 15 ids.

- [ ] **Step 3: Commit the red tests**: `test(dial): TMUX_PANE names the host tmux, and tmux has a page (red)`

- [ ] **Step 4: Implement in `hostDetect.ts`**
  - `NAMES`: `tmux: 'tmux'` after `zellij`. Say in its comment that sixteen is the firmware's bound.
  - `PROGRAM_APPS`: `tmux: 'tmux'`.
  - `detectHost`: `if (has('TMUX_PANE')) return 'tmux'` after the `ZELLIJ` line.

- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable/hosts src/cable/cableHost.spec.ts`. Expected: PASS.

- [ ] **Step 6: `cli/e2e/dialAppFilter.e2e.ts`**: in "an agent in an unknown terminal is in the app named Other…" and
  "an unknown terminal in front… does not turn the dial to Other", `{ TERM_PROGRAM: 'tmux' }` becomes
  `{ TERM_PROGRAM: 'rio' }`. Run both:
  `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts -t 'unknown terminal'`.
  Expected: 2 passed.

- [ ] **Step 7: Commit**: `dial: TMUX_PANE names the host tmux, and tmux with no app named has a page of its own`

### Task 3: A tap switches the person's tmux client to the agent's pane

**Depends on:** nothing. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/cable/hosts/orca.ts` (`OrcaDeps.run`, `orcaDeps`), test `cli/src/cable/hosts/orca.spec.ts`
- Modify: `cli/src/cable/hosts/open.ts` (`Pane`, `openTarget`, `paneOf`, `OpenDeps`, `focus`, `open`), test
  `cli/src/cable/hosts/open.spec.ts`
- Modify: `cli/src/cable/hosts/observed.ts` (`ingest`), test `cli/src/cable/hosts/observed.spec.ts`
- Modify: `cli/src/services/devices.ts` (the `createOpenActions` call), test `cli/src/services/devices.spec.ts`

**The test that fails before the change:** `cli/src/cable/hosts/open.spec.ts`, "tmux: the pane holds the agent, the
person's client is switched to it, then its app comes forward".

**Interfaces:**
- Produces, for Tasks 6 and 7:
  - `OrcaDeps.run(file, args, timeoutMs): Promise<{ code: number | null; stdout: string }>`
  - `type Pane = { app: 'orca' | 'wezterm' | 'herdr' | 'claude'; id: string } | { app: 'tmux'; id: string; pid: number }`
  - `openTarget(host: string, hints: Readonly<Record<string, string>>, from: { pid: number }): OpenTarget`
  - `OpenDeps.processes(): Promise<readonly Pick<ProcessName, 'pid' | 'ppid'>[]>` (`ProcessName` from
    `scannedApp.ts`); it rejects when the table cannot be read.

**Re-check after the rebase:**
- `open.ts`: `createOpenActions` returns `{ can, open, claudeShow }` (#4326; #4331 does not change the file).
  `claudeShow` calls `focus({ app: 'claude', id })` and reads a boolean as `'ok'` or `'failed'`: keep it reading
  "reached or not".
- `observed.ts` `ObservedSource.focus`: `actions.open(e.agent.id, e.opens)` runs first, and only then a `tty` pane is
  selected (`tabSelect(…, true)`). If the merged `focus` shows a pane before or in place of `e.opens`, stop and
  report: the tmux pane must decide.
- `observed.ts` `shownPane`: its kinds are `orca`, `claude` (#4326) and `tty` (#4331). A tmux pane is not one: no
  member is added, so a rest on a tmux agent switches nothing.
- `observed.ts` `learnTty` still reads the tty by the hook's caller. For an agent in tmux that is the pane's pty, and
  `device-app/src-tauri/src/tabs_macos.rs` still answers `Selected::NoTab` for a tty no tab holds.
- `devices.ts`: `createOpenActions({ ...apps, orcaSwitch, log })`, and `learnApps` imported from `scannedApp.js`.
- `lib/harnessSessionLabel.ts` still exports `HARNESS_OWNER_OPTION` (`'@harness_daemon'`) and `isHarnessSession`,
  and `cable/hosts/observed.ts` still reaches that file through `lib/sessionSearch/externals/support.ts`: the
  devices process loads it already, so `open.ts` importing it adds nothing to the process.

- [ ] **Step 1: Write the failing tests**

  `open.spec.ts`. `recorder(over, codes, said: { pane?: string; clients?: string } = {})` takes what tmux prints:
  its `run` returns `{ code, stdout }` with `said.pane ?? ''` for `display-message`, `said.clients ?? ''` for
  `list-clients` and `''` for anything else, and it gives `processes: async () => TABLE`.
  `target(hints, from = { pid: 100 })` passes `from` on. Every other `OpenDeps` literal in the file gains `processes`,
  and its `run` a `stdout`.

```ts
const PANE = '%3'
const IN_GHOSTTY = { TMUX_PANE: PANE, TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.mitchellh.ghostty' }
/** The agent (100) in its shell (90), the pane's process, under tmux's server (80). */
const TABLE = [{ pid: 100, ppid: 90 }, { pid: 90, ppid: 80 }, { pid: 80, ppid: 1 }, { pid: 4242, ppid: 1 }]
const TAG = 'abcdef0123456789'
/** One line of `list-clients`, as tmux prints it: when it was used last, its name, the tag of the pane it shows, its session. */
const client = (activity: number, name: string, tag: string, session: string) => `${activity}|${name}|${tag}|${session}\n`
/** The pane holds the agent's shell, and the person's one client is on a session of their own. */
const OWN = { pane: '90\n', clients: client(1794700050, '/dev/ttys004', '', 'work') }
const asked: Call = run('tmux', 'display-message', '-p', '-t', PANE, '#{pane_pid}')
const listed: Call = run('tmux', 'list-clients', '-F', '#{client_activity}|#{client_name}|#{@harness_daemon}|#{session_name}')
const switched = (name = '/dev/ttys004'): Call => run('tmux', 'switch-client', '-c', name, '-t', PANE)
const ghostty = forward('com.mitchellh.ghostty')
const fallback = ['[device] open · tmux · fallback']

it('tmux: the pane holds the agent, the person\'s client is switched to it, then its app comes forward', async () => {
  const { calls, logs, opener } = recorder({}, [], OWN)
  expect(target(IN_GHOSTTY)).toEqual({ bundle: 'com.mitchellh.ghostty', pane: { app: 'tmux', id: PANE, pid: 100 } })
  expect(opener.can(target(IN_GHOSTTY))).toBe(true)
  expect(await opener.open('a1', target(IN_GHOSTTY))).toBe(true)
  expect(calls).toEqual([asked, listed, switched(), ghostty])
  expect(logs).toEqual([])
})

it('the pane\'s process is the agent\'s own or one of sixteen parents, and no further', async () => {
  const chain = Array.from({ length: 19 }, (_, i) => ({ pid: 100 + i, ppid: 101 + i }))
  const tap = async (panePid: number) => {
    const { calls, opener } = recorder({ processes: async () => chain }, [], { ...OWN, pane: `${panePid}\n` })
    await opener.open('a1', target(IN_GHOSTTY))
    return calls.some((call) => call.args[0] === 'switch-client')
  }
  expect([await tap(100), await tap(116), await tap(117)]).toEqual([true, true, false])
})

it('a pane of that id that holds another process is not switched to: its app comes forward, with one line', async () => {
  const other = recorder({}, [], { ...OWN, pane: '4242\n' })
  expect(await other.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
  // No client is even listed: the check comes first.
  expect(other.calls).toEqual([asked, ghostty])
  expect(other.logs).toEqual(['[device] open · tmux · not its pane'])
  // With no app to bring forward the tap is false, and the line is still said.
  const bare = recorder({}, [], { ...OWN, pane: '4242\n' })
  expect(await bare.opener.open('a1', target({ TMUX_PANE: PANE }))).toBe(false)
  expect(bare.calls).toEqual([asked])
  expect(bare.logs).toEqual(['[device] open · tmux · not its pane'])
})

// Its pid may be another process's by now: a pid the table does not hold matches nothing, itself included.
it('an agent whose process is gone is not in its pane', async () => {
  for (const pane of ['90\n', '100\n']) {
    const gone = recorder({ processes: async () => TABLE.filter((p) => p.pid !== 100) }, [], { ...OWN, pane })
    expect(await gone.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect(gone.calls).toEqual([asked, ghostty])
    expect(gone.logs).toEqual(['[device] open · tmux · not its pane'])
  }
})

// Desktop's terminals, a phone's and hn's are tmux clients too, on the same server: a tap never moves one of them.
it('the client switched is the one used last among those not on a session Harness made', async () => {
  const clients = [
    client(1794700100, 'client-501', TAG, 'harness-claude-1790000000000-x'), // a Harness terminal, used last of all
    client(1794700090, 'client-502', '', 'harness-codex-1790000000000-y'),   // a session a build before the tag named
    client(1794700080, 'client-503', TAG, 'work'),                           // showing a Harness pane the person moved
    client(1794700050, '/dev/ttys004', '', 'work'),
    client(1794700070, '/dev/ttys009', '', 'notes|2'),                       // a session's name may hold a bar
    client(1794700070, 'client-777', '', 'notes|2'),                         // the same second: the one listed later
    'not a client\n', 'soon|/dev/ttys010||work\n', '1794700099|||work\n',    // no line tmux prints: each is passed over
  ].join('')
  const { calls, logs, opener } = recorder({}, [], { pane: '90\n', clients })
  expect(await opener.open('a1', target(IN_GHOSTTY))).toBe(true)
  expect(calls).toEqual([asked, listed, switched('client-777'), ghostty])
  expect(logs).toEqual([])
})

it('with no client of the person\'s nothing is switched: the app comes forward, as a fallback', async () => {
  const harnessOnly = client(1794700100, 'client-501', TAG, 'harness-claude-1790000000000-x') + client(1794700090, 'client-502', '', 'harness-codex-1790000000000-y')
  for (const clients of ['', harnessOnly]) {
    const none = recorder({}, [], { pane: '90\n', clients })
    expect(await none.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect([none.calls, none.logs]).toEqual([[asked, listed, ghostty], fallback])
    const linux = recorder({ platform: 'linux' }, [], { pane: '90\n', clients })
    expect(await linux.opener.open('a1', target(IN_GHOSTTY))).toBe(false)
    expect(linux.calls).toEqual([asked, listed])
  }
})

it('tmux that does not say, a process table not read, or a switch that fails: the app comes forward, as a fallback', async () => {
  for (const pane of ['', '\n', 'abc\n', '-5\n']) {
    const silent = recorder({}, [], { ...OWN, pane })
    expect(await silent.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect([silent.calls, silent.logs]).toEqual([[asked, ghostty], fallback])
  }
  const failed = recorder({}, [1], OWN)
  expect(await failed.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
  expect([failed.calls, failed.logs]).toEqual([[asked, ghostty], fallback])
  const unread = recorder({ processes: async () => { throw new Error('process table not read') } }, [], OWN)
  expect(await unread.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
  expect([unread.calls, unread.logs]).toEqual([[asked, ghostty], fallback])
  const unlisted = recorder({}, [0, 1], OWN)
  expect(await unlisted.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
  expect([unlisted.calls, unlisted.logs]).toEqual([[asked, listed, ghostty], fallback])
  // The client went between the list and the switch.
  const detached = recorder({}, [0, 0, 1], OWN)
  expect(await detached.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
  expect([detached.calls, detached.logs]).toEqual([[asked, listed, switched(), ghostty], fallback])
})

it('a nearer host\'s pane wins over tmux\'s', async () => {
  for (const nearer of [{ HERDR_PANE_ID: 'w1:p2' }, { WEZTERM_PANE: '7' }, { ORCA_TERMINAL_HANDLE: HANDLE }]) {
    const { calls, opener } = recorder({}, [], OWN)
    await opener.open('a1', target({ ...nearer, TMUX_PANE: PANE }))
    expect(calls.map((call) => call.file)).not.toContain('tmux')
  }
})

it('on Linux the client is switched, and nothing comes forward', async () => {
  const linux = recorder({ platform: 'linux' }, [], OWN)
  expect(linux.opener.can(target(IN_GHOSTTY))).toBe(true)
  expect(await linux.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
  expect(linux.calls).toEqual([asked, listed, switched()])
})
```

  Add to "a hint not in its own form never reaches a command": `['TMUX_PANE', '3']`, `['TMUX_PANE', '%']`,
  `['TMUX_PANE', '%3; rm -rf /']`, `['TMUX_PANE', '%1234567890']`, `['TMUX_PANE', '-t']`, `['TMUX_PANE', '%3 ']`; the
  case also expects no call whose `file` is `'tmux'`. In the existing case "a pane not reached still brings its app
  forward, and says so in one line…", add a tmux pane not reached (`recorder({}, [1], OWN)`): its one line holds no
  `PANE`, `'90'`, `'100'`, `'ttys004'` or `'/'`.

  `observed.spec.ts`, in `describe('ObservedSource actions')` and, for the last, `describe('ObservedSource tabs')`:

```ts
it('the pane a tap opens is its latest event\'s, with that event\'s process', async () => {
  const { actions } = fakeActions()
  const { src, ev } = setup({ actions })
  src.ingest(ev('session-start', { callerPid: 100, hostHints: { TMUX_PANE: '%3' } }))
  src.ingest(ev('session-start', { callerPid: 200, hostHints: { TMUX_PANE: '%9' } }))
  expect(await src.focus(src.list()[0])).toBe(true)
  expect(actions.open.mock.calls).toEqual([[src.list()[0].id, { pane: { app: 'tmux', id: '%9', pid: 200 } }]])
})

// tmux started in an Orca terminal: its panes carry that terminal's handle.
it('an agent in tmux takes the dial\'s words through its mod only', async () => {
  const { actions, ready } = fakeActions()
  const { src, ev } = setup({ actions })
  src.ingest(ev('session-start', { hostHints: { TMUX_PANE: '%3', ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE } }))
  const agent = src.list()[0]
  expect(src.capabilities(agent)).toMatchObject({ voice: false, focus: true })
  expect(src.hasPane(agent)).toBe(false)
  expect(await src.send(agent, 'run the tests')).toEqual({ ok: false, reason: 'proj did not answer.' })
  ready.add('s1')
  expect(src.capabilities(agent)).toMatchObject({ voice: true })
  expect(await src.send(agent, 'run the tests')).toEqual({ ok: true })
  expect(actions.orcaSend).not.toHaveBeenCalled()
  expect(actions.orcaSwitch).not.toHaveBeenCalled()
})

it('an agent in tmux inside Terminal: a tap opens through its tmux pane', async () => {
  const t = tabs()
  t.src.ingest(t.ev('session-start', { hostHints: { ...inTerminal.hostHints, TMUX_PANE: '%3' } }))
  await t.reads[0].answer('/dev/ttys031')
  expect(await t.src.focus(t.agent())).toBe(true)
  expect(t.actions.open.mock.calls).toEqual([[t.agent().id, { bundle: 'com.apple.Terminal', pane: { app: 'tmux', id: '%3', pid: 100 } }]])
})
```

  `orca.spec.ts`: "a non-zero exit is false" expects `{ code: 3, stdout: '' }` and `{ code: null, stdout: '' }`; add
  "run answers what the command printed": a fake that prints `4242` answers `{ code: 0, stdout: '4242\n' }`.

  `devices.spec.ts`: the `scannedApp.js` mock gains `readProcessNames: readers.processes`
  (`vi.fn(async () => [] as Array<{ pid: number; ppid: number; executable: string }>)`, reset in `beforeEach`); every
  fake `run` answers `stdout: ''` beside its code. In `describe('the mod\'s voice and Orca…')`:

```ts
it('an agent in the person\'s own tmux lists f, and its tap checks the pane\'s process, then switches the person\'s client', async () => {
  readers.processes.mockResolvedValue([{ pid: 4242, ppid: 4000, executable: 'claude' }, { pid: 4000, ppid: 1, executable: 'zsh' }])
  const says = ['4000\n', '9999\n']
  // A Harness terminal used last, and the person's own client.
  const clients = '1794700100|client-501|abcdef0123456789|harness-claude-1790000000000-x\n1794700050|/dev/ttys004||work\n'
  const { port } = startHere({ orca: { ...mac, run: async (file, args, timeoutMs) => {
    orcaRuns.push([file, args, timeoutMs])
    return { code: 0, stdout: args[0] === 'display-message' ? says.shift()! : args[0] === 'list-clients' ? clients : '' }
  } } })
  // Warp is no tab app: no tty is read.
  port.observed(hook('session-start', { hostHints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'dev.warp.Warp-Stable' } }))
  attach(port)
  expect(await listed()).toEqual([{ id: ID, name: 'api', caps: 'sf' }])
  expect(await host().openAgent(ID)).toBeUndefined()
  const asked: [string, string[], number] = ['tmux', ['display-message', '-p', '-t', '%3', '#{pane_pid}'], 10_000]
  const clientsAsked: [string, string[], number] = ['tmux', ['list-clients', '-F', '#{client_activity}|#{client_name}|#{@harness_daemon}|#{session_name}'], 10_000]
  const warp: [string, string[], number] = ['/usr/bin/open', ['-b', 'dev.warp.Warp-Stable'], 10_000]
  expect(orcaRuns).toEqual([asked, clientsAsked, ['tmux', ['switch-client', '-c', '/dev/ttys004', '-t', '%3'], 10_000], warp])
  expect(said()).toEqual([])
  // The pane holds another process now: nothing is listed or switched.
  expect(await host().openAgent(ID)).toBeUndefined()
  expect(orcaRuns.slice(4)).toEqual([asked, warp])
  expect(said()).toEqual(['[device] open · tmux · not its pane'])
})
```

- [ ] **Step 2: Run them**

  Run: `cd cli && npx vitest run src/cable/hosts/open.spec.ts src/cable/hosts/observed.spec.ts src/cable/hosts/orca.spec.ts src/services/devices.spec.ts`
  Expected: FAIL (and the typecheck too: `openTarget` takes two arguments, `run` has no `stdout`).

- [ ] **Step 3: Commit the red tests**: `test(devices): a tap switches the person's tmux client to the agent's pane, once the pane's process is checked (red)`

- [ ] **Step 4: `orca.ts`**: `run` answers `{ code, stdout }`; `orcaDeps().run` passes on what `execFile` read, and
  `''` at its deadline.

- [ ] **Step 5: `open.ts`**
  - `const TMUX_PANE_ID = /^%[0-9]{1,9}$/`; the `Pane` union and `openTarget`'s third argument as in Interfaces;
    `OpenDeps.processes`.
  - ``const TMUX_CLIENTS = `#{client_activity}|#{client_name}|#{${HARNESS_OWNER_OPTION}}|#{session_name}` ``, with
    `HARNESS_OWNER_OPTION` and `isHarnessSession` imported from `../../lib/harnessSessionLabel.js`: the daemon's own
    names for the tag and the prefix, which the hook mirrors. The session's name is last because it may hold a bar.
  - `paneOf(hints, from)`: after Orca's line and before the Claude app's,
    `{ app: 'tmux', id: hints.TMUX_PANE, pid: from.pid }` when the id passes.
  - `focus`, case `'tmux'`, in this order:
    1. `deps.run('tmux', ['display-message', '-p', '-t', pane.id, '#{pane_pid}'], RUN_TIMEOUT_MS)`. Exit 0 and a
       positive integer on stdout, or the pane is not reached.
    2. `deps.processes()`; a rejection is "not reached". Walk that one table from `pane.pid`: the agent's own row,
       then at most `WALK_PARENTS` parents (stop at pid 1, and at a pid met twice). The pane's pid must be one of the
       rows met; a pid the table does not hold meets none. If not: log `[device] open · tmux · not its pane`, and the
       pane is refused.
    3. `deps.run('tmux', ['list-clients', '-F', TMUX_CLIENTS], RUN_TIMEOUT_MS)`. Not exit 0: not reached. Each line
       is cut at its first three bars into activity, name, tag and session. A line with fewer fields, an activity
       that is not a whole number, or an empty name is passed over. A client is on a Harness session when its tag is
       not empty or `isHarnessSession(session)`: it is never moved. Of the rest, the greatest activity; on equal
       activity the one listed later. None left: not reached, and no `switch-client` runs.
    4. `deps.run('tmux', ['switch-client', '-c', name, '-t', pane.id], RUN_TIMEOUT_MS)`; exit 0 is reached.
  - Comment on step 3, the why: every terminal Harness has open is a tmux client on this server, and a bare
    `switch-client` moves the client used last, one of those included (the spec, F1 "The tap"). Before tmux 3.0 the
    tag is the window's; it counts wherever it is read, since the mistake that costs nothing is not to switch.
  - `open`: a refused pane still brings the app forward on macOS, and writes no `· fallback` line: its own line was
    said. A pane not reached is the existing fallback.
  - The file's header comment names tmux among the panes, and Q1's rule in one sentence.

- [ ] **Step 6: `observed.ts` `ingest`**
  - `entry.opens = openTarget(a.host, e.hostHints, { pid: e.callerPid })`.
  - `entry.handle` is kept only when the event names no `TMUX_PANE`. Comment: a tmux server keeps the environment it
    was started in, so the handle names the terminal tmux began in, and what is typed there lands in whichever pane
    that client shows.

- [ ] **Step 7: `devices.ts`**: `createOpenActions({ ...apps, orcaSwitch: …, processes: readProcessNames, log })`, with
  `readProcessNames` imported beside `learnApps`.

- [ ] **Step 8: Run**

  Run: `cd cli && npm run typecheck && npx vitest run src/cable/hosts src/cable/cableHost.spec.ts src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts`
  Expected: PASS.
  Run: `cd cli && npm run test:core`
  Expected: 100% per file, `services/devices.ts` among them.

- [ ] **Step 9: Commit**: `devices: a tap switches the person's tmux client to the agent's pane, once the pane's process is checked`

### Task 4: The tmux rule in the services' rules

**Depends on:** nothing. **Effort:** medium.

**Files:**
- Modify: `cli/src/services/AGENTS.md` ("Do not", its last bullet)

**The test that fails before the change:** none: no behavior.

- [ ] **Step 1: Replace the bullet** `- Do not write to tmux, the registry or another service's files.` with:

```markdown
- Do not write to tmux, the registry or another service's files. A service never writes to Harness's tmux: no pane or
  session Harness made. One thing is allowed in the person's own tmux (PM, 2026-11-15,
  [the spec](../../../docs/specs/2026-11-15-device-wave1-checks.md)): the devices process may run `switch-client` (or
  a select) to the pane a hook named, once it has checked that the pane's process is the agent's or one of its parents
  (`cable/hosts/open.ts`). It names the client it moves, and never one on a session Harness made. It never types,
  creates or closes anything there. Harness's panes and the person's can share one tmux server, so the rule is held
  per pane and session, by the owner tag the hook reads (`hook/notify.mjs` `paneFacts`).
```

- [ ] **Step 2: Check the link resolves** from `cli/src/services/`, and that #4331's and #4326's edits to the devices
  paragraph above are untouched. The bullet's line may have moved with them: it is the one that begins
  "Do not write to tmux".

- [ ] **Step 3: Commit**: `docs(services): the one thing the devices may do in a person's own tmux`

### Task 5: A tap on a Harness agent waits for Desktop's window

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/harness.ts`, test `cli/src/cable/hosts/harness.spec.ts`
- Modify: `cli/src/cable/cableHost.ts` (`CableHostWiring`, the constructor, `setSwarms`, `machineSnapshot`,
  `openAgent`), test `cli/src/cable/cableHost.spec.ts`

**The test that fails before the change:** `cli/src/cable/cableHost.spec.ts`, "with no window a tap starts Desktop,
and the open waits for the window".

**Interfaces:**
- Produces, for Task 6:
  - `CableHostWiring.launchDesktop?: () => Promise<boolean>`: brings Harness Desktop forward, starting it when it is
    not running; absent where a tap cannot (off macOS).
  - `CableHostWiring.desktopTimedOut?: () => void`: no window came for a waiting open in `HARNESS_OPEN_WAIT_MS`.
  - `export const HARNESS_OPEN_WAIT_MS = 30_000` (`cableHost.ts`).
  - `new HarnessSource(now?: () => number, opens?: boolean)`: `capabilities().focus` is `opens`.

**Re-check after the rebase:** `openAgent` still answers an outside agent first, then `machineOf`, then
`wiring.opened`; `setSwarms` only stores; the `AppFilter` is given `after: wiring.appTimer ?? unrefAfter`. #4326 adds
`appSettled` and `latestFront` beside them: leave them.

- [ ] **Step 1: Write the failing tests**

  `harness.spec.ts`:

```ts
it('focus only where Harness Desktop can be started for a tap', () => {
  expect(capsLetters(new HarnessSource(() => 1_000, true).capabilities())).toBe('svfa')
  expect(capsLetters(new HarnessSource(() => 1_000).capabilities())).toBe('sva')
})
```

  `cableHost.spec.ts`, a new `describe('a tap on a Harness agent with no window')` inside
  `describe('the dial with no window: this computer\'s agents')`, whose `sessions` it uses (h1, h2 on machine `mine`):

```ts
const setup = (over: Partial<CableHostWiring> = {}) => {
  const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = []
  const w = wiring({
    sessions, opened: vi.fn(), launchDesktop: vi.fn(async () => true), desktopTimedOut: vi.fn(),
    appTimer: (ms, run) => { const timer = { ms, run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true } },
    ...over,
  })
  const host = new DaemonCableHost(w, fleetOf([]))
  host.setRegistry(new HostRegistry([host.harness]))
  host.setSwarms(null)
  return { host, w, timers }
}

it('with no window a tap starts Desktop, and the open waits for the window', async () => {
  const { host, w, timers } = setup()
  expect((await host.listAgentSnapshot()).agents.map((a) => a.caps)).toEqual(['svfa', 'svfa'])
  expect(await host.openAgent('h1')).toBeUndefined()
  expect(w.launchDesktop).toHaveBeenCalledTimes(1)
  expect(w.opened).not.toHaveBeenCalled()
  expect(timers.map((timer) => timer.ms)).toEqual([HARNESS_OPEN_WAIT_MS])
  onTab(host, [])
  expect(vi.mocked(w.opened!).mock.calls).toEqual([['mine', 'h1']])
  expect(timers[0].cancelled).toBe(true)
})

it('a second word from the window opens nothing more', async () => {
  const { host, w } = setup()
  await host.openAgent('h1')
  onTab(host, [])
  onTab(host, ['h1'])
  expect(w.opened).toHaveBeenCalledTimes(1)
})

it('a window that comes while Desktop is still being started is handed the open, once', async () => {
  let started!: (ok: boolean) => void
  const { host, w } = setup({ launchDesktop: () => new Promise<boolean>((resolve) => { started = resolve }) })
  const tap = host.openAgent('h1')
  onTab(host, [])
  started(true)
  expect(await tap).toBeUndefined()
  expect(vi.mocked(w.opened!).mock.calls).toEqual([['mine', 'h1']])
})

it('no window in HARNESS_OPEN_WAIT_MS: the open ends, and is said once', async () => {
  const { host, w, timers } = setup()
  await host.openAgent('h1')
  timers[0].run()
  expect(w.desktopTimedOut).toHaveBeenCalledTimes(1)
  onTab(host, [])
  expect(w.opened).not.toHaveBeenCalled()
})

it('the last tap wins', async () => {
  const { host, w, timers } = setup()
  await host.openAgent('h1')
  await host.openAgent('h2')
  expect(w.launchDesktop).toHaveBeenCalledTimes(2)
  expect(timers.map((timer) => timer.cancelled)).toEqual([true, false])
  onTab(host, [])
  expect(vi.mocked(w.opened!).mock.calls).toEqual([['mine', 'h2']])
})

it('an agent that leaves the list is not opened', async () => {
  let listed = sessions()
  const { host, w, timers } = setup({ sessions: () => listed })
  await host.openAgent('h1')
  listed = listed.filter((s) => s.agentId !== 'h1')
  await host.listAgentSnapshot()
  expect(timers[0].cancelled).toBe(true)
  onTab(host, [])
  expect(w.opened).not.toHaveBeenCalled()
})

it('Desktop that does not start answers the dial, and nothing waits', async () => {
  const { host, w } = setup({ launchDesktop: async () => false })
  expect(await host.openAgent('h1')).toEqual({ ok: false, error: 'Harness did not open it.' })
  onTab(host, [])
  expect(w.opened).not.toHaveBeenCalled()
})

it('a question screen, an open window, another machine\'s agent and a host with no launcher start nothing', async () => {
  const asked = setup()
  expect(asked.host.openAgent('h1', 'question')).toBeUndefined()
  expect(asked.w.launchDesktop).not.toHaveBeenCalled()
  expect(asked.w.opened).toHaveBeenCalledWith('mine', 'h1', 'question')
  const open = setup()
  onTab(open.host, ['h1'])
  open.host.openAgent('h1')
  expect(open.w.launchDesktop).not.toHaveBeenCalled()
  expect(open.w.opened).toHaveBeenCalledWith('mine', 'h1', undefined)
  const none = setup({ launchDesktop: undefined })
  expect((await none.host.listAgentSnapshot()).agents.map((a) => a.caps)).toEqual(['sva', 'sva'])
  none.host.openAgent('h1')
  expect(none.w.opened).toHaveBeenCalledWith('mine', 'h1', undefined)
})
```

  The other machine's agent: one more case built as "names the machine, and routes an open, for an agent heard from
  before it was listed" builds its host (`crossFleet({ other: [] })`, `noteAgent('other', 'r9')`), with a
  `launchDesktop` wired: `openAgent('r9')` with no window calls `opened('other', 'r9', undefined)` and never
  `launchDesktop`.

- [ ] **Step 2: Run them**: `cd cli && npx vitest run src/cable/hosts/harness.spec.ts src/cable/cableHost.spec.ts`.
  Expected: FAIL (`sva`, `launchDesktop` never called, no `HARNESS_OPEN_WAIT_MS`).

- [ ] **Step 3: Commit the red tests**: `test(dial): a tap on a Harness agent with no window starts Desktop and waits for its window (red)`

- [ ] **Step 4: `harness.ts`**: the constructor's second argument and `focus: this.opens`; the class comment's "No
  focus" sentence says when there is one.

- [ ] **Step 5: `cableHost.ts`**
  - `HARNESS_OPEN_WAIT_MS`, with the spec's reason (a cold start, the sign-in check, the first connect; not measured
    on Diego's Mac).
  - The two wiring members. `appTimer`'s comment names its second use.
  - `harness` is built in the constructor: `new HarnessSource(Date.now, wiring.launchDesktop !== undefined)`.
  - One waiting open at a time: `{ machineId, agentId }` and its timer's cancel.
  - `openAgent`, after `machineOf`: with no window, no `reason`, the agent on this computer (`localId()`) and a
    launcher, the tap is recorded as the waiting open (replacing one, whose timer is cancelled), its timer starts,
    and `launchDesktop()` runs. False, or a rejection, drops the open if it is still this tap's and answers
    `{ ok: false, error: `${hostDisplayName('harness')} did not open it.` }`. Anything else takes the path it has.
  - `setSwarms`: a window that is there with an open waiting takes it through `wiring.opened(machineId, agentId)`,
    with the existing `cable: open …` log line, once.
  - `machineSnapshot`, after `harness.update`: a waiting open whose agent is no longer listed is dropped.
  - The timer firing drops the open and calls `desktopTimedOut`.

- [ ] **Step 6: Run** `cd cli && npm run typecheck && npx vitest run src/cable`. Expected: PASS.

- [ ] **Step 7: Commit**: `dial: a tap on a Harness agent with no window starts Desktop and hands its window the open`

### Task 6: The devices start Harness Desktop

**Depends on:** Task 5 (the wiring it fills), Task 3 (`OrcaDeps.run`'s `{ code, stdout }`, which its fakes answer,
and `open.spec.ts`'s `recorder`). **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts` (`HARNESS_BUNDLE`, `BUNDLE_APPS`' comment)
- Modify: `cli/src/cable/hosts/open.ts` (`createOpenActions`' answer), test `cli/src/cable/hosts/open.spec.ts`
- Modify: `cli/src/services/devices.ts` (the cable host's wiring), test `cli/src/services/devices.spec.ts`
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts` (one expectation)

**The test that fails before the change:** `cli/src/services/devices.spec.ts`, "on macOS a Harness agent with no
window lists f, and its tap starts Harness Desktop".

**Interfaces:**
- Consumes: Task 5's `launchDesktop`, `desktopTimedOut`, `HARNESS_OPEN_WAIT_MS`; Task 3's `run` and `recorder`.
- Produces: `export const HARNESS_BUNDLE = 'ai.autonomous.harness'` (`hostDetect.ts`);
  `createOpenActions(deps).desktop?: () => Promise<boolean>`, there on macOS only.

- [ ] **Step 1: Write the failing tests**

  `open.spec.ts`:

```ts
it('Harness Desktop comes forward by its bundle id, on macOS only', async () => {
  const { calls, opener } = recorder({}, [0, 1])
  expect(await opener.desktop!()).toBe(true)
  expect(await opener.desktop!()).toBe(false)
  expect(calls).toEqual([forward('ai.autonomous.harness'), forward('ai.autonomous.harness')])
  expect(recorder({ platform: 'linux' }).opener.desktop).toBeUndefined()
})
```

  `devices.spec.ts`, in `describe('the mod\'s voice and Orca…')`, with `harnessAgent()` moved up to the file's helpers
  (it lists `h1`):

```ts
const caps = async () => (await listed()).map(({ id, caps }) => ({ id, caps }))

it('on macOS a Harness agent with no window lists f, and its tap starts Harness Desktop', async () => {
  vi.useFakeTimers()
  const core = harnessAgent()
  const { port } = startHere({ core, orca: mac })
  attach(port)
  expect(await caps()).toEqual([{ id: 'h1', caps: 'svfa' }])
  expect(await host().openAgent('h1')).toBeUndefined()
  expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', 'ai.autonomous.harness'], 10_000]])
  const opens = () => vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame).filter((frame) => frame.type === 'dial_open')
  expect(opens()).toEqual([])
  port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
  expect(opens()).toEqual([{ type: 'dial_open', payload: { machineId: host().localMachine().id, agentId: 'h1' } }])
  // The next tap finds no window in 30 s.
  port.swarms(null)
  await host().openAgent('h1')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(said().filter((line) => line === '[device] open · harness · no window')).toHaveLength(1)
  port.swarms({ active: 't1', swarms: [], tiles: [] })
  expect(opens()).toHaveLength(1)
})

it('Harness Desktop that is not installed answers the dial', async () => {
  const { port } = startHere({ core: harnessAgent(), orca: { ...mac, run: async (file, args, timeoutMs) => { orcaRuns.push([file, args, timeoutMs]); return { code: 1, stdout: '' } } } })
  attach(port)
  expect(await host().openAgent('h1')).toEqual({ ok: false, error: 'Harness did not open it.' })
})

it('off macOS a Harness agent lists no f, and a tap starts nothing', async () => {
  const { port } = startHere({ core: harnessAgent() })
  attach(port)
  expect(await caps()).toEqual([{ id: 'h1', caps: 'sva' }])
  host().openAgent('h1')
  expect(orcaRuns).toEqual([])
})
```

- [ ] **Step 2: Run them**: `cd cli && npx vitest run src/cable/hosts/open.spec.ts src/services/devices.spec.ts -t 'Harness Desktop'`.
  Expected: FAIL (`desktop` is undefined; `sva`).

- [ ] **Step 3: Commit the red tests**: `test(devices): on macOS a tap on a Harness agent with no window starts Harness Desktop (red)`

- [ ] **Step 4: Implement**
  - `hostDetect.ts`: `HARNESS_BUNDLE`, used as `BUNDLE_APPS`' key. Its comment: no hint's bundle id ever opens
    Harness; a tap on a Harness agent with no window starts it by this id alone (`open.ts` `desktop`).
  - `open.ts`: `desktop: mac ? () => forward(HARNESS_BUNDLE) : undefined` in what `createOpenActions` returns, and in
    its return type. `HARNESS_BUNDLE` does not join `BUNDLES`.
  - `devices.ts`, the `DaemonCableHost` wiring: `launchDesktop: opener.desktop` and
    `desktopTimedOut: () => log('[device] open · harness · no window')`, with a comment that it is a measure: the
    app's name only.

- [ ] **Step 5: `cli/e2e/deviceWithoutApp.e2e.ts`**, "with no window the dial lists a paneless claude and a tmux
  harness agent…": the Harness row's caps are `process.platform === 'darwin' ? 'svfa' : 'sva'`, with a comment that
  no test here taps it: the tap would start the developer's own Harness Desktop.

- [ ] **Step 6: Run**

  Run: `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts && npm run test:core`
  Expected: PASS; 100% per file.
  Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts -t 'with no window the dial lists'`
  Expected: 1 passed.

- [ ] **Step 7: Commit**: `devices: on macOS a tap on a Harness agent with no window starts Harness Desktop`

### Task 7: A tap opens the VS Code extension's tab (F3)

**Depends on:** Task 1 (the hint list and its cap), Task 3 (`Pane`, `openTarget`'s third argument), Task 6 (not its
code: F3's commits must be the last on `open.ts` and `open.spec.ts`, so they come out cleanly, Q2). **Effort:** xhigh.

**Files:**
- Modify: `cli/hook/notify.mjs` (`HOST_HINTS`), test `cli/src/hookNotify.spec.ts`
- Modify: `cli/src/cable/hosts/open.ts`, test `cli/src/cable/hosts/open.spec.ts`
- Modify: `cli/src/cable/hosts/observed.ts` (`ingest`, one line), test `cli/src/cable/hosts/observed.spec.ts`

**The test that fails before the change:** `cli/src/cable/hosts/open.spec.ts`, "the VS Code extension's tab: its
session's link, then VS Code comes forward".

**Interfaces:**
- Consumes: Task 3's `Pane` and `openTarget(host, hints, from)`; Task 1's `HOST_HINTS` and `MAX_HINTS`.
- Produces: nothing another task uses. **Only these two commits hold F3**: no other change rides in them.

- [ ] **Step 1: Write the failing tests**

  `open.spec.ts`; `target`'s default `from` becomes `{ pid: 100, sessionId: UUID }`:

```ts
const UUID = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
const VSCODE = 'com.microsoft.VSCode'
const TAB = { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }
const link = run(OPEN, `vscode://anthropic.claude-code/open?session=${UUID}`)

it('the VS Code extension\'s tab: its session\'s link, then VS Code comes forward', async () => {
  const { calls, opener } = recorder()
  expect(target(TAB)).toEqual({ bundle: VSCODE, pane: { app: 'vscode', id: UUID } })
  expect(await opener.open('a1', target(TAB))).toBe(true)
  expect(calls).toEqual([link, forward(VSCODE)])
})

it('no link without all three: the extension\'s word, VS Code\'s own bundle id, a UUID', async () => {
  const cases: Array<[Record<string, string>, string, string]> = [
    [{ __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'cli' }, UUID, VSCODE],
    [{ __CFBundleIdentifier: VSCODE }, UUID, VSCODE],
    // The app is VS Code by TERM_PROGRAM alone: inferred, so no link.
    [{ TERM_PROGRAM: 'vscode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, UUID, VSCODE],
    [{ __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, UUID, 'com.todesktop.230313mzl4w4u92'],
    [TAB, 'sess-1', VSCODE], [TAB, UUID.toUpperCase(), VSCODE], [TAB, `${UUID}&x=y`, VSCODE], [TAB, `${UUID}/..`, VSCODE],
  ]
  for (const [hints, sessionId, bundle] of cases) {
    const { calls, opener } = recorder()
    expect(await opener.open('a1', target(hints, { pid: 100, sessionId }))).toBe(true)
    expect(calls, JSON.stringify([hints, sessionId])).toEqual([forward(bundle)])
  }
})

it('a link that fails still brings VS Code forward, in one line with no session; on Linux nothing runs', async () => {
  const failed = recorder({}, [1])
  expect(await failed.opener.open('a1', target(TAB))).toBe(true)
  expect(failed.calls).toEqual([link, forward(VSCODE)])
  expect(failed.logs).toEqual(['[device] open · vscode · fallback'])
  expect(failed.logs.join()).not.toContain(UUID)
  const linux = recorder({ platform: 'linux' })
  expect(linux.opener.can(target(TAB))).toBe(false)
  expect(await linux.opener.open('a1', target(TAB))).toBe(false)
  expect(linux.calls).toEqual([])
})
```

  `observed.spec.ts`, in `describe('ObservedSource actions')`:

```ts
it('a session in the VS Code extension\'s tab opens by its own session id', async () => {
  const { actions } = fakeActions()
  const { src, ev } = setup({ actions })
  const sessionId = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
  src.ingest(ev('session-start', { sessionId, hostHints: { __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
  expect(await src.focus(src.list()[0])).toBe(true)
  expect(actions.open.mock.calls[0][1]).toEqual({ bundle: 'com.microsoft.VSCode', pane: { app: 'vscode', id: sessionId } })
})
```

  `hookNotify.spec.ts`: `HINTS` gains `'CLAUDE_CODE_ENTRYPOINT'`, last, and:

```ts
it('says how Claude Code was started, beside the app it runs in', async () => {
  const { port, requests } = await collect()
  await runHook({ port, env: { ...noHints, __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
    input: { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: '/w', prompt: 'hi' } })
  expect(requests[0].body.hostHints).toEqual({ __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
})
```

- [ ] **Step 2: Run them**: `cd cli && npx vitest run src/cable/hosts/open.spec.ts src/cable/hosts/observed.spec.ts src/hookNotify.spec.ts -t 'VS Code|how Claude Code was started|in this order|without all three'`.
  Expected: FAIL (no pane, no link, the hint is not sent).

- [ ] **Step 3: Commit the red tests**: `test(devices): a tap opens the VS Code extension's tab on its session (red)`

- [ ] **Step 4: Implement**
  - `notify.mjs`: `'CLAUDE_CODE_ENTRYPOINT'` last in `HOST_HINTS`; the comment above says what it is (a fixed word
    naming how Claude Code was started, `claude-vscode` from the extension; not a secret).
  - `open.ts`: `const VSCODE_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`; `'vscode'`
    joins the first `Pane` member's apps; `openTarget`'s `from` is `{ pid: number; sessionId: string }`; `paneOf`'s
    last line reads the pane only with all three (`hints.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode'`,
    `hints.__CFBundleIdentifier === APP_BUNDLES.vscode`, the session id passing); `paneOn` holds the link to macOS as
    it holds the Claude app's; `focus`, case `'vscode'`:
    `exitsZero(OPEN, [`vscode://anthropic.claude-code/open?session=${pane.id}`])`. VS Code then comes forward as
    after any pane but the Claude app's.
  - `observed.ts` `ingest`: `openTarget(a.host, e.hostHints, { pid: e.callerPid, sessionId: e.sessionId })`.

- [ ] **Step 5: Run** `cd cli && npm run typecheck && npx vitest run src/hookNotify.spec.ts src/cable/hosts src/services/devices.spec.ts`.
  Expected: PASS.

- [ ] **Step 6: Commit**: `devices: a tap opens the VS Code extension's tab on its session`

- [ ] **Step 7: Prove it comes out.** On a throwaway branch at the task's head:
  `git revert --no-edit <code commit> <red commit>`, then
  `cd cli && npm run typecheck && npx vitest run src/hookNotify.spec.ts src/cable/hosts`. Expected: no conflict, PASS.
  Delete the branch. Report both SHAs: they are what comes out if manual check 3 fails.

### Task 8: End to end: Claude Code in the test's own tmux session

**Depends on:** Tasks 1, 2 and 3. **Effort:** high.

**Files:**
- Create: `cli/e2e/harness/ownTmux.ts`
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts` (two cases, the header's list, the `afterEach`)

**The test that fails before the change:** none: no behavior. It adds the end-to-end cases for Tasks 1 to 3, in one
commit. Each case is seen to fail once before it is kept (step 4).

**Interfaces:**
- Consumes: the hook's `TMUX_PANE` hint (Task 1), host `tmux` (Task 2), the tap's switch and the client it names
  (Task 3).

- [ ] **Step 1: `cli/e2e/harness/ownTmux.ts`**

```ts
/** Claude Code (the fake engine) in a tmux session the test opened on the daemon's private server, as a person opens
 *  one by hand: not a session Harness made, so its hooks tell the devices and register nothing. */
export class InOwnTmux {
  readonly pane: string        // '%N'
  readonly pid: number         // the engine's, from its SessionStart line in d.hookLog()
  readonly sessionId: string
  get id(): string             // observedAgentId('claude', sessionId)
  static start(d: IsolatedDaemon, session: string, folder: string): Promise<InOwnTmux>
  /** Typed at its prompt, then Enter: `send-keys -l`, then `send-keys Enter`, as e2e/hookclient.e2e.ts types. */
  type(text: string): Promise<void>
  ran(event: string, times?: number): boolean
}

/** A client of the test's own in control mode (`tmux -C attach-session -t <target>`), as a person's second terminal
 *  is and as every Harness terminal is (src/lib/tmuxStream.ts), and where it is now. [target] is a session's name or
 *  a pane's id. */
export function controlClient(d: IsolatedDaemon, target: string): Promise<{
  where(): Promise<string>     // '<session> <pane>' of this client: its line of
                               // `list-clients -F '#{client_pid} #{session_name} #{pane_id}'`, by the child's pid
  close(): Promise<void>
}>
```

  Rules the bodies hold:
  - `start` runs `d.tmux.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, '-c', cwd, …flags, d.env.CLAUDE_PATH!)`.
    The flags: `-e NAME=value` from `d.env` for `HOME`, `ZDOTDIR`, `PATH`, `CODEX_HOME`, `CLAUDE_PATH`, `CODEX_PATH`
    (as `hookclient.e2e.ts`), and `-e NAME=` for **every** name in the hook's `HOST_HINTS` but `TMUX_PANE` and
    `TERM_PROGRAM`. Read the names from `hook/notify.mjs` with the pattern `hookNotify.spec.ts` uses, so a hint added
    later is blanked too. Why, in a comment: `d.tmux.run` carries the test shell's environment, and a bundle id or an
    Orca handle from it would have a tap act on the developer's own apps.
  - `controlClient` spawns `tmux -S d.tmux.socket -f /dev/null -C attach-session -t <target>` with `d.tmux.env`, its
    stdin held open, and resolves once tmux has answered its first command (write `display-message -p attached`, wait
    for `attached` on stdout). Every session the test needs is made before it is called, clients attach one at a
    time, each awaited, and `close` ends the client before any session is closed (`src/lib/tmuxControlGate.ts`:
    before tmux 3.7 the server can crash otherwise).

- [ ] **Step 2: Two cases in `deviceWithoutApp.e2e.ts`**

```ts
/** The mod's poll over the daemon's socket, as the mod sends it: its status and what it was answered. */
const inboxPoll = (d: IsolatedDaemon, sessionId: string): Promise<{ status: number; body: unknown }> => …

it('Claude Code in a tmux session the person opened is listed with host tmux, works, and takes the dial\'s words through its mod', async () => {
  const { d, desk } = await fresh()
  const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
  await heard(dial, (m) => m.t === 'agents.end', 'the first list')
  const engine = await InOwnTmux.start(d, 'own-claude', 'in-tmux')
  const roster = await showing(dial, 'the agent listed', (r) => r.rows.find((row) => row.id === engine.id)?.host === 'tmux')
  expect(roster.rows.find((r) => r.id === engine.id)).toMatchObject({ name: 'in-tmux', engine: 'claude', host: 'tmux', caps: 'sf' })
  // Nothing was registered for the pane.
  const client = await LocalClient.connect(d)
  expect(((await client.request('agents_list', { includeStopped: true }, 30_000)).agents as Array<{ tmuxPane?: string }>)
    .filter((agent) => agent.tmuxPane === engine.pane)).toEqual([])
  client.close()
  const since = dial.messages.length
  await engine.type('hello from tmux')
  await heard(dial, (m) => m.t === 'turn.started' && m.agentId === engine.id, 'its turn started', since)
  await heard(dial, (m) => m.t === 'turn.done' && m.agentId === engine.id, 'its turn done', since)
  const poll = inboxPoll(d, engine.sessionId)
  await showing(dial, 'voice once its mod polls', (r) => r.rows.find((row) => row.id === engine.id)?.caps === 'svf')
  dial.send({ t: 'turn.send', agentId: engine.id, text: 'from the dial' })
  expect(await poll).toEqual({ status: 200, body: { text: 'from the dial' } })
})

it('a tap on it switches the person\'s tmux client to its pane, never one on a Harness session, and brings no app forward', async () => {
  const { d, desk } = await fresh()
  const client = await LocalClient.connect(d)
  // A session Harness made: an agent's, tagged and named as the daemon does both.
  const harness = await create(d, client, 'in-harness')
  const harnessPane = String((await row(client, harness))?.tmuxPane)
  const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
  await showing(dial, 'the harness agent listed', (r) => ids(r).includes(harness))
  const engine = await InOwnTmux.start(d, 'own-claude', 'in-tmux')
  await d.tmux.run('new-session', '-d', '-s', 'own-other', 'sleep 600')
  await showing(dial, 'the agent listed', (r) => r.rows.find((row) => row.id === engine.id)?.caps === 'sf')
  // Every session is made; now the clients. The person's first, then one as Desktop's terminal on the Harness agent is:
  // it attached later, so it is the client used last, the one a bare switch-client moves.
  const person = await controlClient(d, 'own-other')
  clients.push(person)
  const terminal = await controlClient(d, harnessPane)
  clients.push(terminal)
  expect(await person.where()).toMatch(/^own-other /)
  const stays = await terminal.where()
  expect(stays.startsWith('harness-') && stays.endsWith(` ${harnessPane}`), stays).toBe(true)
  const since = dial.messages.length
  dial.send({ t: 'agent.open', agentId: engine.id })
  await until('the person\'s client on the agent\'s pane', async () => (await person.where()) === `own-claude ${engine.pane}`, 30_000, 100)
  await heard(dial, (m) => m.t === 'focus' && m.agentId === engine.id, 'the dial on the agent', since)
  expect(await terminal.where()).toBe(stays)
  expect(dial.messages.slice(since).some((m) => m.t === 'toast')).toBe(false)
  // No app to bring forward and no pane refused: nothing was said.
  expect(d.log()).not.toContain('[device] open · tmux')
  client.close()
})
```

  `clients` (declared beside `outside`) is closed first in `afterEach`, one at a time, before the desk and the daemon.
  The file's header gains a line for the agent in the person's own tmux. No test taps the Harness agent
  (Global Constraints).

- [ ] **Step 3: Run both**

  Run: `cd cli && caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts`
  Expected: every case passed, the two new ones among them, none skipped.

- [ ] **Step 4: See each fail once**, with a local change that is never committed, and report what each run said:
  - `notify.mjs` `ownPane` returning `false`: the first case fails waiting for "the agent listed" (the dial's list has
    `total: 0`).
  - `open.ts`, the tmux case answering "not reached": the second case fails waiting for "the person's client on the
    agent's pane".
  - `open.ts`, the tmux case taking every client for the person's (no client passed over as Harness's): the second
    case fails the same wait, since the client moved is the one on the Harness agent's session. Say where that
    client was (`terminal.where()`) when it failed.

  Then `git checkout -- cli/hook/notify.mjs cli/src/cable/hosts/open.ts` and run step 3 again.

- [ ] **Step 5: Commit**: `e2e: Claude Code in the person's own tmux is on the dial, and a tap moves only the person's client`

---

## Left out

- A rest of the dial on a tmux agent switches nothing: the spec gives the tap alone.
- Selecting the terminal tab that holds the tmux client, typing into a person's tmux pane (`send-keys`), VS Code's
  integrated terminal, Cursor's tab, F2 off macOS, the face tap that opens: the spec's "Out of scope".
- The open scan does not learn the app `tmux` from a parent named `tmux`.
- `cli/AGENTS.md`'s row for the devices process is not edited: the spec names `services/AGENTS.md` only.
- A rule per client instead of per session: Harness marking its own tmux clients, so that one on a session the
  person named is passed over too ("Found while reading the code", the moved window). It would change
  `lib/tmuxStream.ts`, which the core runs.
- No end-to-end test for F2: it would start the developer's own Harness Desktop. Its proof is the unit specs and
  manual check 5.

## Verification

On the final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and 6): every end-to-end
file boots its own daemon under a throwaway root, with a private tmux server, fake engines and a fake dial on a
pseudo-terminal, signed out. Never Diego's daemon (port 18473), his tmux server, his dial or his apps; nothing here
reaches production. Checks 1 to 4 need nobody but a tester; check 5 is Diego's.

Local, on this Mac (macOS arm64, Node 22, tmux), in `cli/`, one command at a time:

1. **The specs, the typecheck and the gates PR CI does not run.**

   ```bash
   npm run typecheck
   npx vitest run src/hookNotify.spec.ts src/cable src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts
   cd .. && python3 scripts/local-checks.py --run     # from a clean tree: npm run test:core, with its receipt
   ```

   To see: no type error; every spec passed; `test:core` at 100% per file with `services/devices.ts` in it; the
   core's file list unchanged, and `git diff origin/main --stat -- cli/src/core` naming `observedHook.ts` alone, one
   line. The receipt goes into the pull request's body before the push.

2. **The end-to-end files this work changes, or whose path it changes, on macOS.**

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts \
     e2e/deviceWithoutApp.e2e.ts e2e/dialAppFilter.e2e.ts e2e/hookclient.e2e.ts
   ```

   To see: three files passed, none skipped. In `deviceWithoutApp`: the two tmux cases (in the second, the person's
   client is on the agent's pane and the client on the Harness agent's session has not moved), and the Harness row
   with `svfa`. In `dialAppFilter`: "Other" still holds the unknown terminal. In `hookclient`: an engine in a tmux
   session opened by hand is still no agent, daemon down or up. No window or app on this Mac moves during the run.
   About a quarter of an hour.

3. **F3 comes out cleanly** (Q2). On a throwaway branch at the final head: `git revert --no-edit` of Task 7's two
   commits, then check 1's first two commands. To see: no conflict, all passed. Delete the branch.

On GitHub, by hand, once, after the branch is pushed and not beside another heavy workflow
(`docs/validation-and-release.md`):

4. **The whole CLI suite on Linux**: the hook changes for every engine in every pane, and Linux is one of F1's
   platforms.

   ```bash
   gh workflow run cli-e2e.yml --ref fix/device-wave1-checks
   ```

   To see: `e2e (1)` to `e2e (8)`, the macOS full-disk job and `e2e-summary` green, with
   `e2e/deviceWithoutApp.e2e.ts` and `e2e/dialAppFilter.e2e.ts` among the verified files. A red test is reported with
   its link and whether main's last nightly run has it too. Report the run's link.

With Diego, in one session after the pull request is up (PM, 2026-11-15). **Not a tester's.** On his Mac and dial:
the CLI from this branch (`make install-cli`; `harness --version` names the branch's build, since a dev daemon does
not update itself), Harness Desktop installed, the harness-device plugin on, the dial's firmware as it is.

5. **The five checks of the spec**, in its order:
   1. Claude Code in a VS Code extension tab: it is on VS Code's page (not Other, not Ghostty); words said at the
      dial start a turn in that tab; a notice tap shows that tab.
   2. Claude Code in VS Code's terminal: the same three, where the tap only brings VS Code forward; and with VS Code
      started by `code .` from Ghostty, which page it is on.
   3. Two VS Code windows, the session's tab in the other one: the tap shows the tab that is there, and opens no
      second tab. **This one decides F3:** the pull request keeps `hold` until it passes, and if it fails Task 7's
      two commits are reverted before the merge.
   4. Ghostty with tmux, Claude Code in a pane, Desktop quit: it is listed; its voice works; a notice tap shows its
      pane and Ghostty. With a second terminal attached to another session of the person's, the tap moves the one
      used last.
   5. A Harness agent's notice tap with Desktop quit: Desktop starts and opens that agent.
      Then, with that agent's terminal just opened in Desktop and nothing typed in Ghostty since (Desktop's is now
      the tmux client used last), tap the tmux agent's notice of check 4 again: Ghostty's tmux shows the agent's
      pane, and Desktop's terminal still shows its own agent.

   Each is written into the pull request as seen, or as not seen.

**Temporary workflow:** none. The long check has a workflow already (`.github/workflows/cli-e2e.yml`, by hand from a
branch and every night), and the new cases are in a file it already runs, so they keep running without a new check.

**For the pull request's body:**
- Platforms: macOS all three; Linux F1; Windows none.
- The red and the green commit of each task.
- **Numbers: the cost of the new tmux calls for a `Notification` in a Harness pane**, copied from Task 1's code
  commit: `tmux -V` and `display-message`, the median of twenty each, the tmux version and the machine; before, no
  tmux call.
- The core: one comment line in `core/observedHook.ts`, no code (PM, 2026-11-15).
- The receipt of check 1; the link of check 4; `hold` until manual check 3.
