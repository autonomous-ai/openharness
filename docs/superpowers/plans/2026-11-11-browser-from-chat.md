# Browser from chat Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **ken15dev phase 3**: wave by wave, one Opus subagent per
> task, each in its own worktree; every task commits its failing test first, then the code that makes it pass; no
> per-task review; one final review of the whole branch; full suites once, on CI. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A person starts and stops the browser of any of their running agents from the Browser button in the agent's
Swarm chat, and the agent drives it with `harness browser <command>`: no MCP, no launch argument, no checkbox.

**Architecture:**

- The registry row's `browser` flag now means "on". The service asks the core to set or clear it
  (`CoreApi.agents.setBrowser`), and the core tells the browser's port `attached` or `stopped` in the same turn, so
  the flag's order is the service queue's order.
- A browser left on follows its agent, by the agent's id (decision 14): it stops when the agent stops and is
  attached again on every path that runs that agent again. Create, resume and daemon start attach it as before; the
  reconciler's look at each running agent (`core/agents/discovery.ts` `onObserved`) attaches any it finds left out,
  so no path has to remember to (Task 23).
- A browser moves with its pane (decision 19): when a new agent row takes the pane its previous agent ended in, the
  core tells the browser's port both ids, the service moves the settings entry and its profile in its queue, and
  then asks the core to move the flag (`CoreApi.agents.moveBrowser`). A browser's container, network, volume and
  proxy secret are named by the entry's `profile` id, not by the agent's, so nothing on disk is renamed
  (Tasks 24 to 26).
- The daemon's `agentBrowser` service keeps one tool server per ready browser (`podman exec -i … browser-tools.mjs`),
  runs the agent's commands through it one at a time, sizes Chrome's window through it, and types two lines into
  the agent (`CoreApi.turns.deliver`): one when the person's Start is ready, one at the person's Stop. Both are quiet
  deliveries: the turn each starts ends with no recap and no notification.
- `harness browser` is a thin CLI: it proves its pane, asks the pane's daemon `agent_browser_run` over the local
  socket, prints the tool's words, and writes screenshots and long output to files in the agent's `$TMPDIR`.
- Desktop: the Browser button is on every running agent of the person's own machines; the panel has Start, Stop
  and a window that follows the panel's size. New agent loses the pill.

**Tech Stack:** TypeScript (CLI daemon, backend), plain ESM in the image (`cli/assets/browser`), Flutter (Desktop),
noVNC page (`desktop/tool/browser_viewer`). No new dependency.

**Spec:** [2026-11-11-browser-from-chat-design.md](../specs/2026-11-11-browser-from-chat-design.md), which changes
[2026-11-10-agent-browser-design.md](../specs/2026-11-10-agent-browser-design.md). Read both; this plan argues from
them and does not repeat them.

## Global Constraints

- **No MCP.** After this branch nothing adds a browser argument to a launch, and `harness browser-mcp` does not exist.
- **Only the person starts and stops.** `agent_browser_run` takes no start and no stop; `harness browser start` and
  `harness browser stop` exit 2.
- **Nothing else reaches the agent.** No file under `cli/src/superTabs/` changes, except the move of `callerPane.ts`
  and the import in `command.ts` (Task 4). Deliveries, their context lines and `plainChat` are untouched.
- **Quiet lines (Ken, 2026-11-11, option b).** The turn the ready line or the stop line starts makes no recap and no
  notification, on the daemon and so on every app. The turn path's change is general and small: a `quiet` mark on a
  delivery, carried to its turn's end (Tasks 21, 22). The code on that path (`core/deliveries.ts`,
  `core/turns/recaps.ts`, `lib/commander.ts`, `services/recaps.ts`) names no feature. `turns.onEnd` still tells that
  end: the Swarm still types the agent its next thing.
- **The browser follows its agent, by its id (Ken, 2026-11-11, decision 14).** Only the person's Stop clears the
  flag. An agent that stops has its browser stopped; whenever a row with the flag has a running engine again, by any
  path, its browser is attached, and nothing is typed (its `told` mark stays).
- **The browser moves with its pane (Ken, 2026-11-11, decision 19).** The flag, the settings entry and the profile
  go to another agent's id in one case only: a new row takes the pane its previous agent ended in (`adoptEngine`
  in the shell an exit left; `openProcessAgent` evicting the pane's row). The entry moves first, the flag after it,
  so a move that fails leaves both agents as they were (`browser_move_failed`). The new agent is typed the ready
  line; the previous one keeps no browser. No name in Podman is made from an agent's id but through its profile.
- **No asking (Ken, 2026-11-11).** `harness browser …` is in both engines' allow rules, as `harness send` is
  (Task 20). It has no MCP tool.
- **No read of the backend or of the Swarm on a command's path.** `agent_browser_run` reads the registry row, the
  pane's process and the service's memory.
- **Logs and counters carry no content.** A command's arguments, a page's text, an address and a file's path never
  reach a log, a counter or an error sent to the apps. A command is logged by its name and outcome only. No
  `agent_browser_*` frame is logged (`backendSocket.ts` `UNLOGGED_BROWSER`, by prefix: already true for the new ones).
- **Exact copy** (the spec's; do not reword):
  - Ready line: ``Your browser is ready: run `harness browser --help` ``
  - Stop line: `Your person stopped your browser.`
  - Off: `Your browser is off. Ask your person to start it: Browser in your chat.`
  - Refusals: `Browser isn't available for this agent.` · `Run harness browser from your own Harness pane.` ·
    `Browser doesn't run on Windows yet.`
  - Busy: `Browser is busy. Try again.` · Timeout: `<command> timed out` · Tool server: `Browser is not reachable`
  - Desktop: `A sandboxed Chrome the agent drives` · `Start` · `Stop` · `Update Harness on <machine> first` ·
    `Browser doesn't run on Windows yet` · `Only its owner can open this browser` · label `Browser, running`
- **Numbers:** 8 commands waiting per browser; tool limits 20 s, navigation 60 s, wait 30 s; the service gives a
  running call 10 s more; the CLI waits 5 s more than the service (35 s, 75 s, 45 s); 50 files per agent; 3 tries
  for a line; window at least 1024x640, at most the Device setting's screen; window call 5 s; resize settles 300 ms.
- **Compatibility, each with a dated comment** (`Delete on or after 2026-12-18`: 30 days after a release assumed
  by 2026-11-18; whoever releases later moves the date): `agent_create` reading `browser: true`;
  `agent_browser_state` and `CoreApi.agents.ofPane` without `ancestors`, for relays still running.
- **Order of release:** backend (the counters' names: it refuses a report with a name it does not know), then CLI,
  then Desktop.
- **Platforms:** agents' machines macOS and Linux; the daemon on Windows starts nothing and answers by name; the CLI
  on Windows exits 5 before it starts anything; Desktop macOS and Linux; web, phone and Windows Desktop draw nothing
  new. Every process the service starts goes through `podman.spawn` (`ownProcessGroup()`).
- **Standards:** root `AGENTS.md` code standards, `cli/AGENTS.md` (a feature is a service; 100% per-file coverage
  for `src/core/` and `src/services/`), `desktop/AGENTS.md` (design doc and gallery in the same pull request).

## Review Focus

Inputs the spec implies and a person will meet. Each has its test in the task that owns the code.

1. **A private tmux server inside an agent's pane whose pane id equals another agent's** (pane ids restart in every
   server; re-check 2 of #2093): the command is refused, never run on the other agent's browser. Tasks 13 and 15.
2. **A screenshot larger than the local socket's 512 KiB request limit:** the reply still arrives and the file is the
   whole JPEG. Task 17.
3. **`$TMPDIR` unset, or its `browser` entry a file or not writable:** one line on standard error, exit 1, no image
   bytes on the terminal. Task 6.
4. **Text that looks like a flag, or holds quotes and new lines** (`type e7 -- --submit`, `type e7 -` with standard
   input, empty standard input): typed as text. Task 5.
5. **The agent ends, or its engine restarts, while a line waits to be typed:** nothing is retried against an agent
   that is gone, nothing is typed twice, and the browser stays owed its ready line. Task 8.
6. **A line's turn whose start is heard before, or after, the recaps hear that turn start** (the input says `started`
   inside the funnel for an exact echo, and a moment later for an engine whose prompt is read back): quiet either
   way, and the person's next turn tells as any turn does. Task 22.
7. **A quiet turn that starts a sub-agent and ends while it still runs, and the turn after it:** the held end stays
   quiet when it is let go, and the next turn does not inherit the mark. Task 21.
8. **A person who denied or asks for `harness browser` in their own Claude Code rules:** no allow is added, in either
   spelling. Task 20.
9. **An agent the daemon took for exited while its engine ran on** (a restore that could not see it, two missed
   scans): archived, its browser stopped, then back under its own id with nothing restarted. Its browser is attached
   again, once, and every later scan tells the service nothing. Task 23.
10. **The previous agent, resumed after its browser moved, and its person presses Start** (the spec: "a new, empty
    one"): its own id is the name of the volume the pane's new agent now holds. Its new entry gets a profile id of
    its own; that volume is never mounted for it, and a stop or a delete of the previous agent touches nothing
    named by its id. Task 24.
11. **The previous agent resumed in another pane before its old pane gets a new agent:** its browser came back with
    it (decision 14) and stays with it; the engine typed into the old shell is a new agent with no browser.
    Tasks 25 and 26.
12. **The state file cannot be written at the move, or the core does not answer after it:** both flags stay as they
    were, nothing is started for the new agent, nothing is typed, and one line names `browser_move_failed`.
    Task 26.

## Contract

Every task uses these names. Requests are answered by `cli/src/services/agentBrowser.ts`.

| Request | Asker | Answer |
|---|---|---|
| `agent_browser_start {agentId}` | `mayOpenBrowser` | `{ok: true}`, or `error`: `NOT_OWNER`, `NOT_RUNNING`, `NOT_ALLOWED` (a guest's agent), `LOCAL_ONLY` (a failed install retried from another computer), `NOT_ON_WINDOWS` |
| `agent_browser_stop {agentId}` | `mayOpenBrowser` | `{ok: true}`, or `error`: `NOT_OWNER`, `NOT_ON_WINDOWS` |
| `agent_browser_window {agentId, width, height}` | `mayOpenBrowser` | `{width, height}` as set, or `error`: `NOT_OWNER`, `NO_BROWSER`, `NOT_READY`, `INVALID_REQUEST`, `WINDOW_FAILED`, `NOT_ON_WINDOWS` |
| `agent_browser_run {pane, ancestors, command, args}` | local only | `{ok: true, text, image?, failed?}`, or `error`: `LOCAL_ONLY`, `NO_AGENT`, `NOT_ALLOWED`, `INVALID_REQUEST`, `OFF`, `STOPPED`, `NOT_READY` (with `state`), `BUSY`, `TOOL_TIMEOUT`, `TOOL_FAILED`, `NOT_ON_WINDOWS` |

- `command` is the tool's name without `browser_` (`navigate`); `args` is the tool's arguments as
  `browser-tools.json`'s `inputSchema` names them. `ancestors` is the command's parent pids (`runningPane`).
- `text` is the tool's text parts joined by a new line; `image` is the JPEG as base64; `failed` is the tool's
  `isError`. `state` is `setup`, `starting` or the failed browser's error name.
- An older daemon answers any of them `UNSUPPORTED`.

| What `harness browser` gets | Exit | Prints |
|---|---|---|
| `ok` | 0 | `text` on standard output (cut at the cap); for `image`, the saved file's path only |
| `ok` with `failed` | 1 | `text` on standard error |
| `NOT_READY` | 1 | the state's words (the `NOT_READY` table of today's `browserMcp.ts`) |
| `BUSY` · `TOOL_TIMEOUT` · `TOOL_FAILED` | 1 | the three lines above |
| the daemon unreachable, or no answer in time | 1 | the agent verbs' own line · `<command> timed out` |
| `UNSUPPORTED`, `LOCAL_ONLY`, `INVALID_REQUEST`, any other | 1 | `Browser isn't available right now` |
| a wrong command or arguments, `start`, `stop` | 2 | the usage line |
| `OFF` · `STOPPED` | 4 | the off line · the stop line |
| `NOT_ALLOWED` · `NO_AGENT`, no proven pane · Windows | 5 | the three refusals |

## File map

| File | Holds | Task |
|---|---|---|
| `backend/src/types/productUsage.ts`, `cli/src/lib/productUsageContract.ts` | the counters, byte-identical | 1 |
| `cli/src/lib/registry.ts`, `cli/src/core/agents/lifecycle.ts`, `cli/src/core/api.ts`, `cli/src/core/agentBrowserLink.ts`, `cli/src/core/main.ts` | the flag, set by the core | 2, 12, 15 (`api.ts` and `main.ts` also 22; `lifecycle.ts` and `main.ts` also 23; `registry.ts` also 25; all but `registry.ts` also 26) |
| `cli/src/core/agents/discovery.ts` | a browser left on, attached on every look at its running agent; a pane's new agent, told to the browser | 23, 26 |
| `cli/src/lib/registry.ts`, `cli/src/lib/stoppedAgents.ts` | the shell's name for the agent that ended in its pane; a stopped record's flag | 25 |
| `cli/src/services/agentBrowser/containers.ts`, `browsers.ts`, `stateFile.ts` | a browser named by its profile; an entry that moves | 24 |
| `cli/src/lib/e2ee/applicationFrames.ts` | the three sealed requests | 2 |
| `cli/src/core/agents/create.ts`, `cli/src/lib/launchOverrides.ts` | launches with no browser argument | 3 |
| `cli/src/lib/callerPane.ts` (moved) | the pane a command runs in | 4 |
| `cli/assets/browser/browser-tools.json`, `cli/src/agentClient/browserArgs.ts` | commands, examples, help | 5 |
| `cli/src/agentClient/browserOutput.ts` | the cap and the files | 6 |
| `cli/src/services/agentBrowser/toolServers.ts` | one tool server per ready browser | 7 |
| `cli/src/services/agentBrowser/notices.ts`, `stateFile.ts` | the two lines and the `told` mark | 8, 22 (`notices.ts`) |
| `cli/assets/browser/browser-tools.mjs`, `browser-tools-lib.mjs` | the tool server: calls and the window | 9 |
| `desktop/tool/browser_viewer/viewer.js`, `desktop/assets/browser/browser_viewer.html` | the page clips to the window | 10 |
| `cli/src/services/agentBrowser.ts`, `agentBrowserProcess.ts`, `agentBrowser/browsers.ts`, `agentBrowser/settings.ts` | the requests; the move, in the service's queue | 12, 15 (`agentBrowser.ts` and `agentBrowserProcess.ts` also 26) |
| `cli/src/agentClient/browser.ts`, `cli/src/cli.ts`, `cli/src/agentClient/help.ts` | the command | 13 |
| `desktop/lib/state/app_state.dart`, `desktop/lib/e2ee/envelope.dart` | Desktop's requests | 11, 14 |
| `desktop/lib/browser/browser_panel.dart`, `desktop/lib/super_tabs/view.dart`, `browser_bridge.dart` | button and panel | 16, 19 |
| `desktop/design/desktop-design-system.md`, `desktop/test/swarm_elements_gallery_test.dart`, goldens | design doc and gallery | 11, 16, 19 |
| `cli/e2e/agentBrowser.e2e.ts`, `cli/e2e/agentBrowserPodman.e2e.ts` | end to end | 17, 18 (`agentBrowser.e2e.ts` also 26) |
| `cli/src/engines/facets/hooks.ts`, `cli/src/engines/kit/hookSettings.ts`, `cli/src/engines/__fixtures__/hook-installers.golden.json`, `cli/e2e/agentClient.e2e.ts` | `harness browser` in both engines' allow rules | 20 |
| `cli/src/lib/commander.ts` | a quiet turn's end: no recap, no notification | 21 |
| `cli/src/core/deliveries.ts`, `cli/src/services/turnsLink.ts`, `cli/src/core/turns/recaps.ts`, `cli/src/services/recaps.ts` | the quiet mark, from a delivery to its turn's end | 22 |

## Waves

A wave's tasks depend on nothing in the same wave and share no file, tests included. Run a wave's subagents together,
within the machine's capacity. After each wave: cherry-pick in task order, check each task's red commit comes before
its code commit, run the wave's commands below.

| Wave | Tasks |
|---|---|
| 0 (by hand, gate) | 0 |
| 1 | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 |
| 2 | 12, 13, 14, 20, 21, 23 |
| 3 | 15, 16, 24, 25 |
| 4 | 17, 18, 19, 22 |
| 5 | 26 |

Tasks 20 to 22 were added after Task 0 (Ken, 2026-11-11). Why they sit where they do: 20 and 21 share no file with
12, 13 or 14 and depend on none of them; 22 changes `core/api.ts` (Tasks 12 and 15) and `core/main.ts` (Task 15), so
it follows both, and it needs Task 21's `ingest`. No fifth wave is needed.

Task 23 was added while wave 2 ran (Ken, 2026-11-11, decision 14). It is in wave 2: it depends on Task 2 alone, and
its files (`core/agents/lifecycle.ts`, `core/agents/discovery.ts`, `core/main.ts`, the first two's specs and
`lib/registry.spec.ts`) are changed by none of 12, 13, 14, 20 and 21 (checked against their worktrees' diffs). It
cannot sit in wave 3 or 4: `core/main.ts` is Task 15's there, then Task 22's. Started after the others finish, it
is still wave 2: it is cherry-picked last, before wave 3 starts, and Tasks 15 and 22 edit `main.ts` as it leaves
it.

Tasks 24 to 26 were added as wave 2 ended (Ken, 2026-11-11, decision 19). 24 and 25 are in wave 3: their files
(`agentBrowser/containers.ts`, `browsers.ts`, `stateFile.ts`; `lib/registry.ts`, `lib/stoppedAgents.ts`; each one's
spec) are changed by neither Task 15 nor Task 16, and they need nothing from them: until Task 26 no browser has
moved, so every profile is its agent's id and Task 15's `containers.execArgs(agentId, …)` names the same container.
Started after 15 and 16, they are still wave 3: cherry-picked after them, before wave 4 starts.
26 cannot sit in wave 3 or 4: it changes `core/api.ts`, `core/main.ts`, `core/agentBrowserLink.ts`,
`services/agentBrowser.ts` and `agentBrowserProcess.ts` (Task 15's; `api.ts` and `main.ts` then Task 22's) and
`e2e/agentBrowser.e2e.ts` (Task 17's), and it needs 24 and 25. So a fifth wave, of one task: the core's half and the
service's half meet at one port call and one ask, and one task holds both ends of them. The end to end case is
Task 26's, not Task 17's: in wave 4 the code it runs is not there.

**Wave 1 verify** (in `cli/` unless said):

```bash
npm run typecheck
npx vitest run src/lib/registry.spec.ts src/core/api.spec.ts src/core/agents/lifecycle.spec.ts \
  src/core/agentBrowserLink.spec.ts src/lib/e2ee/relayLink.spec.ts src/core/guestPolicy.spec.ts \
  src/core/agents/create.spec.ts src/lib/launchOverrides.spec.ts src/lib/callerPane.spec.ts \
  src/superTabs/command.spec.ts src/architecture.spec.ts src/agentClient/browserArgs.spec.ts \
  src/agentClient/browserOutput.spec.ts src/services/agentBrowser/toolServers.spec.ts \
  src/services/agentBrowser/notices.spec.ts src/services/agentBrowser/stateFile.spec.ts \
  src/services/agentBrowser/browserToolsLib.spec.ts src/services/agentBrowser/assets.spec.ts --maxWorkers=4
(cd ../backend && npx vitest run src/lib/productUsage.test.ts src/routes/productUsage.test.ts)
(cd ../desktop/tool/browser_viewer && npm ci && npm test)
(cd ../desktop && flutter analyze lib test && flutter test --no-pub --concurrency=2 --timeout=60s \
  test/new_harness_form_test.dart test/super_tab_new_agent_launch_test.dart test/browser/browser_requests_test.dart \
  test/swarm_elements_gallery_test.dart test/browser/viewer_asset_test.dart)
```

**Wave 2 verify:**

```bash
npm run typecheck
npx vitest run src/services/agentBrowser.spec.ts src/services/agentBrowserProcess.spec.ts \
  src/services/agentBrowser/browsers.spec.ts src/core/api.spec.ts src/agentClient/browser.spec.ts \
  src/agentClient/help.spec.ts src/architecture.spec.ts src/engines/kit/hookSettings.spec.ts \
  src/engines/hookInstallers.golden.spec.ts src/engines/removeHooks.spec.ts src/agentClient/mcp.spec.ts \
  src/lib/commanderNotifications.spec.ts src/lib/commander.spec.ts src/lib/commanderReplay.spec.ts \
  src/services/recaps.spec.ts src/core/agents/lifecycle.spec.ts src/core/agents/discovery.spec.ts \
  src/lib/registry.spec.ts src/core/agents/create.spec.ts src/lib/resumeAgentService.spec.ts --maxWorkers=4
(cd ../desktop && flutter analyze lib test && flutter test --no-pub --concurrency=2 --timeout=60s \
  test/browser/browser_requests_test.dart test/e2ee/encrypted_down_types_test.dart test/ws_conn_test.dart)
```

**Wave 3 verify:**

```bash
npm run typecheck
npx vitest run src/services/agentBrowser.spec.ts src/services/agentBrowserProcess.spec.ts src/core/api.spec.ts \
  src/core/agentBrowserLink.spec.ts src/services/agentBrowser/settings.spec.ts \
  src/backendSocket.agentBrowser.spec.ts src/services/agentBrowser/containers.spec.ts \
  src/services/agentBrowser/browsers.spec.ts src/services/agentBrowser/stateFile.spec.ts \
  src/lib/registry.spec.ts src/lib/stoppedAgents.spec.ts --maxWorkers=4
(cd ../desktop && flutter analyze lib test && flutter test --no-pub --concurrency=2 --timeout=60s test/browser \
  test/swarm_v4_journey_test.dart test/swarm_elements_gallery_test.dart)
```

**Wave 4 verify:**

```bash
npm run typecheck
npx vitest run src/core/deliveries.spec.ts src/services/turnsLink.spec.ts src/core/turns/recaps.spec.ts \
  src/core/recapsLink.spec.ts src/services/recaps.spec.ts src/services/recapsProcess.spec.ts \
  src/services/agentBrowser/notices.spec.ts src/services/agentBrowser.spec.ts \
  src/services/agentBrowserProcess.spec.ts src/lib/commanderNotifications.spec.ts --maxWorkers=4
E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts
(cd ../desktop && flutter analyze lib test && flutter test --no-pub --concurrency=2 --timeout=60s test/browser)
```

`e2e/agentBrowserPodman.e2e.ts` is typechecked here and run once by hand at the end (see At the end).

**Wave 5 verify:**

```bash
npm run typecheck
npx vitest run src/core/agents/discovery.spec.ts src/core/agents/lifecycle.spec.ts src/core/api.spec.ts \
  src/core/agentBrowserLink.spec.ts src/services/agentBrowser.spec.ts src/services/agentBrowserProcess.spec.ts \
  src/services/agentBrowser/browsers.spec.ts src/services/agentBrowser/containers.spec.ts \
  src/backendSocket.agentBrowser.spec.ts src/lib/registry.spec.ts --maxWorkers=4
E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts
```

---

## Wave 0

### Task 0: Measure the engines (by hand, before any code)

This cannot be a test: it needs a real Claude Code and a real Codex, each as a Swarm agent in its default mode, on a
Mac with Harness installed. The main session runs it with Ken's Desktop (or one Opus subagent that drives two real
agents through `harness new` and `harness show`). It gates wave 1: Tasks 5 and 6 read its numbers.

**Files:**
- Create: `docs/superpowers/specs/2026-11-11-browser-from-chat-measurements.md`

**Depends on:** nothing.

- [ ] **Step 1: Shell time.** Ask each agent to run `sleep 80; echo done-80`, then `sleep 130; echo done-130`,
  naming no timeout. Record per engine: finished, cut (after how long), or moved to the background.
- [ ] **Step 2: Output kept.** Ask each agent to run
  `node -e 'for(let i=0;i<4000;i++)console.log(String(i).padStart(6,"0")+" "+"x".repeat(43))'` (200,000
  characters) and to report the first and the last line number it can see and any truncation notice. Record the
  characters kept per engine.
- [ ] **Step 3: No asking.** Ask each agent to run `harness whoami` and `harness send --help`. Record whether the
  person was asked. `harness browser` is the same binary on the same local socket, so this stands in for it until
  the by-hand run at the end.
- [ ] **Step 4: The image.** Save any JPEG as `$TMPDIR/browser/probe.jpg` in each agent's pane
  (`mkdir -p "$TMPDIR/browser"`), ask the agent to read that file and say what it shows. Record: read without
  asking, asked, or could not.
- [ ] **Step 5: A typed line.** From another pane type a line into each agent through the delivery path
  (`harness send <agent> "probe line"`, Agent Messages on) while it runs `sleep 60`, and again while it waits at a question. Record
  when the line arrives, what happens to the question, and whether Desktop shows a recap or a notification for the
  turn the line starts.
- [ ] **Step 6: Start time.** `for i in $(seq 20); do /usr/bin/time -p harness whoami >/dev/null; done` in a pane.
  Record p50 and p95 of `real`.
- [ ] **Step 7: Write the file** with one table (measure, Claude Code, Codex) and these three results:
  - `OUTPUT_CAP_CHARS`: 80% of the smaller "characters kept", rounded down to a thousand, never above 20,000.
    **Until measured: 8,000.**
  - `HELP_TIME_LINE`: `yes` when either engine cuts or backgrounds a command before 75 s. **Until measured: yes.**
  - Stop rules. Stop and tell Ken, before wave 1, when: an engine cannot read the JPEG; an engine asks the person
    for every `harness` command; or a typed line raises a recap or a notification (keeping the core from doing so
    is a change to the turn path this plan has no task for).
- [ ] **Step 8: Commit** `docs: browser from chat, engine measurements`.

**Done 2026-11-11** ([measurements](../specs/2026-11-11-browser-from-chat-measurements.md)): `OUTPUT_CAP_CHARS`
8,000; `HELP_TIME_LINE` yes. Codex was not signed in, so its column is read from its binary, not measured. Two
findings had no task, and Ken put both in scope: `harness browser` is outside both engines' allow rules (Step 3's
stand-ins are inside them): Task 20; a typed line's turn raises a recap and a `done` notification: Tasks 21 and 22.

---

## Wave 1

### Task 1: The counters, backend and CLI

**Files:**
- Modify: `backend/src/types/productUsage.ts:229-233`, `cli/src/lib/productUsageContract.ts:229-233` (the two files
  stay byte-identical: `backend/src/lib/productUsage.test.ts` "keeps the client and server vocabulary identical")
- Test: `backend/src/lib/productUsage.test.ts`

**Depends on:** nothing.

**Interfaces:** Produces, in `PRODUCT_USAGE_AGENT_BROWSER_METRICS`: `agent_browser_started`, `agent_browser_stopped`,
`agent_browser_command_ok`, `agent_browser_command_failed`, `agent_browser_notice_failed`.

- [ ] **Step 1: Red.** Add the case `names the browser-from-chat counters`: each of the five names is in
  `PRODUCT_USAGE_METRICS`, and `PRODUCT_USAGE_METRICS` has no duplicate.
- [ ] **Step 2:** `cd backend && npx vitest run src/lib/productUsage.test.ts`: FAIL (names missing). Commit
  `test: browser-from-chat counters are named`.
- [ ] **Step 3: Green.** Append the five names to the list in both files, with the same bytes.
- [ ] **Step 4:** Same command plus `src/routes/productUsage.test.ts`: PASS. Commit
  `feat: counters for the person's Start and Stop, the agent's commands and a line given up on`.

### Task 2: The flag means "on", and the core sets it

**Files:**
- Modify: `cli/src/lib/registry.ts` (new `setBrowser`; the `browser` field's comment at `:193-197`, `:1773`),
  `cli/src/core/agents/lifecycle.ts:150`, `cli/src/core/api.ts` (`CoreApi.agents`, `CoreApiDeps`, `createCoreApi`,
  `TURN_DELIVERERS`, the port's comments), `cli/src/core/agentBrowserLink.ts`, `cli/src/core/main.ts`
  (`:1079`, `:2675`), `cli/src/lib/e2ee/applicationFrames.ts:52`
- Modify, comments only ("created with Browser" and "Browser ticked" become "its Browser is on"; the dated
  compatibility comment on `agent_create`'s `browser`): `cli/src/core/agents/launches.ts:541`,
  `cli/src/backendSocket.ts:220`, `cli/src/lib/createAgentPane.ts:112`, `cli/src/lib/resumeAgentService.ts:53`,
  `cli/src/services/AGENTS.md:231`
- Test: `cli/src/lib/registry.spec.ts`, `cli/src/core/agents/lifecycle.spec.ts`, `cli/src/core/api.spec.ts`,
  `cli/src/core/agentBrowserLink.spec.ts`, `cli/src/lib/e2ee/relayLink.spec.ts:223`,
  `cli/src/core/guestPolicy.spec.ts:39`

**Depends on:** nothing. Not `create.ts`, `launchOverrides.ts` (Task 3) or any file under `cli/src/services/*.ts`.

**Interfaces, produces:**

```ts
// registry.ts: the live row with the flag set or cleared and saved, or null when no live row has that id.
setBrowser(agentId: string, on: boolean): RegisteredSession | null

// api.ts
export type BrowserSwitch = { ok: true; changed: boolean } | { error: 'NOT_RUNNING' | 'NOT_ALLOWED' }
// CoreApi.agents (optional, as `ids` is): the flag, then the browser's own start or stop, in one turn.
setBrowser?(agentId: string, on: boolean): Promise<BrowserSwitch>
// CoreApiDeps
setBrowser?: (agentId: string, on: boolean) => BrowserSwitch
export const TURN_DELIVERERS = [...Object.keys(EXPERIMENTS), 'messages', 'agentBrowser']

// lifecycle.ts
createAgentBrowserLifecycle(
  browser: () => Pick<AgentBrowserPort, 'attached' | 'stopped'> | null,
  rows: { byAgent(agentId: string): RegisteredSession | undefined; setBrowser(agentId: string, on: boolean): RegisteredSession | null },
): { attached(session): void; ended(agentId): void; set(agentId: string, on: boolean): BrowserSwitch }

// agentBrowserLink.ts answer(): query `set_browser {agentId, on}` answers the BrowserSwitch.
// applicationFrames.ts MACHINE_REQUESTS gains 'agent_browser_start', 'agent_browser_stop', 'agent_browser_window'.
```

`set` rules: on, no live row: `NOT_RUNNING`; on, the row has `guest`: `NOT_ALLOWED`; on: set the flag (when it was
off: `changed: true`), then `attached(row)` every time; off, no live row or the flag already clear:
`{ok: true, changed: false}`; off: clear the flag, then `ended(agentId)`. In `main.ts` the lifecycle is created
before `createCoreApi` (it needs only `ports` and the registry) and handed in as `setBrowser`.

- [ ] **Step 1: Red.** Cases:
  - `registry.spec.ts` `setBrowser sets and clears the flag on a live row, saves it, and answers null for no row`.
  - `lifecycle.spec.ts`, in "the agent browser, as its agent starts and ends": `turned on while the agent runs, its
    browser is attached; turned off, it is stopped once and the flag is clear`; `on twice attaches twice and changes
    once`; `off for a browser that is off changes nothing and tells nothing`; `an agent that does not run is
    NOT_RUNNING, a guest's is NOT_ALLOWED, and neither row changes`; `a browser turned off is not attached again when
    its agent resumes; one left on is`.
  - `api.spec.ts`: `agents.setBrowser is the dep's answer, and absent without one`; `TURN_DELIVERERS` contains
    `agentBrowser`.
  - `agentBrowserLink.spec.ts`: `set_browser sets the flag through the core and answers what it said; a payload
    without an id or a boolean is INVALID_REQUEST`.
  - `relayLink.spec.ts:223`: add the three types to the sealed loop, and `agent_browser_run is on no sealed list`
    (`MACHINE_REQUESTS` does not hold it). `guestPolicy.spec.ts:39`: add
    `agent_browser_start`, `agent_browser_stop`, `agent_browser_window`, `agent_browser_run` (already refused: the
    policy is an allow list; these pin it).
- [ ] **Step 2:** `npx vitest run src/lib/registry.spec.ts src/core/agents/lifecycle.spec.ts src/core/api.spec.ts
  src/core/agentBrowserLink.spec.ts src/lib/e2ee/relayLink.spec.ts src/core/guestPolicy.spec.ts`: FAIL
  (`setBrowser` and `set` do not exist; the three types are not sealed). Commit `test: the core turns an agent's
  browser on and off`.
- [ ] **Step 3: Green.** Implement the interfaces above; wire `main.ts`; reword the comments.
- [ ] **Step 4:** Same command and `npm run typecheck`: PASS. Commit `feat: the row's browser flag means on, set and
  cleared by the core`.

### Task 3: No launch carries a browser argument

**Files:**
- Delete: `cli/src/lib/browserMcpArgs.ts`, `cli/src/lib/browserMcpArgs.spec.ts`
- Modify: `cli/src/core/agents/create.ts:385-387` (and the `...browserMcp` in `extraArgs`),
  `cli/src/lib/launchOverrides.ts:326-327`, `cli/AGENTS.md` (the process table: "one container per agent whose
  Browser is on"; started "on demand: an agent whose Browser is on, a request, or its state file at start"),
  `docs/superpowers/specs/2026-11-10-agent-browser-design.md` (one line under Status: how a browser is turned on,
  off and driven is changed by the 2026-11-11 spec, with its link)
- Test: `cli/src/core/agents/create.spec.ts:949-966`, `cli/src/lib/launchOverrides.spec.ts:429-436`

**Depends on:** nothing.

- [ ] **Step 1: Red.** Replace the three cases with: `create.spec.ts` `no launch carries a browser argument: Claude
  Code, Codex and OpenCode, with browser:true and without` (the argv handed to `buildEngineLaunchArgv` contains
  neither `browser-mcp` nor `mcp_servers.browser` nor `"browser"`); `launchOverrides.spec.ts` `a relaunch of an agent
  whose browser is on adds no browser argument` (same three strings, Claude Code and Codex). Keep `create.spec.ts:752`
  (the row says so and the browser is attached).
- [ ] **Step 2:** `npx vitest run src/core/agents/create.spec.ts src/lib/launchOverrides.spec.ts`: FAIL (the args are
  there). Commit `test: no launch carries a browser argument`.
- [ ] **Step 3: Green.** Remove both call sites, their comments and imports, and the two files.
- [ ] **Step 4:** Same command and `npm run typecheck`: PASS. Commit `feat: agents launch plain; the browser MCP
  arguments go`.

### Task 4: The pane proof moves out of the Swarm's code

`harness browser` is not Swarm code and may not import `superTabs/` (`architecture.spec.ts` `SWARM_DOORS`).

**Files:**
- Move: `cli/src/superTabs/callerPane.ts` to `cli/src/lib/callerPane.ts`, `cli/src/superTabs/callerPane.spec.ts` to
  `cli/src/lib/callerPane.spec.ts`
- Modify: `cli/src/superTabs/command.ts:13` (the import); `cli/vitest.super-tabs.config.ts` only if it names the file

**Depends on:** nothing.

- [ ] **Step 1: Red.** `git mv` the spec alone and fix its imports to `./callerPane.js`.
- [ ] **Step 2:** `npx vitest run src/lib/callerPane.spec.ts`: FAIL (no such module). Commit `test: the pane proof
  lives in lib`.
- [ ] **Step 3: Green.** `git mv` the source, fix its relative imports and `command.ts`'s. No behaviour changes.
- [ ] **Step 4:** `npx vitest run src/lib/callerPane.spec.ts src/superTabs/command.spec.ts src/architecture.spec.ts`
  and `npm run typecheck`: PASS. Commit `refactor: the pane proof moves to lib, for commands outside the Swarm`.

### Task 5: The commands and their help, from `browser-tools.json`

**Files:**
- Modify: `cli/assets/browser/browser-tools.json` (each tool gains `example`, and `note` where the spec's help has
  one), `cli/src/lib/browserToolsAsset.ts` (the type gains the two fields and is renamed `BrowserTool`; its comment
  no longer names the relay)
- Create: `cli/src/agentClient/browserArgs.ts`, `cli/src/agentClient/browserArgs.spec.ts`

**Depends on:** Task 0 (`HELP_TIME_LINE`).

**Interfaces, produces:**

```ts
export type BrowserCall = { command: string; args: Record<string, unknown>; stdin?: 'text' }
/** `argv` is what follows `harness browser`. `usage` is one line; `help` asks for the help. */
export function parseBrowserArgs(argv: readonly string[]): BrowserCall | { usage: string } | { help: true }
export function browserHelp(): string
export const START_STOP_USAGE = 'Only your person starts and stops your browser: Browser in your chat.'
```

Forms (the spec's table): `navigate <url>` · `back` · `snapshot` · `click <ref>` · `type <ref> <text> [--submit]`
(`<text>` is one argument; `-` sets `stdin: 'text'`; after `--` everything is text) · `press <key>` ·
`select <ref> <value>…` (`values`) · `scroll <dy>` (a number, negative allowed) · `screenshot` ·
`tabs [list | new | select <n> | close [<n>]]` (bare `tabs` is `list`; `index`) · `wait <text>` or `wait --ms <n>`.
`--help`, `-h` and no argument are `{help: true}`. `start` and `stop` are `{usage: START_STOP_USAGE}`.
`browserHelp()` is the spec's block: its first line, then one line per tool in the JSON's order, `example` padded,
then `note`; when Task 0 says `HELP_TIME_LINE: yes` it ends with
`navigate and wait can take up to 75 s: give the command that long.`

- [ ] **Step 1: Red.** Cases in `browserArgs.spec.ts`:
  - `every tool has an example, and its example parses to a call its schema takes`: for each tool, split `example`
    as a shell would (the spec's own quoting), parse, and check `command`, every `required` key present, each value
    of the schema's type, `enum` held (a ten-line checker in the spec file, no dependency).
  - `the help lists every tool once, in order, and needs nothing but the JSON`.
  - One case per form above with its exact `args`, including `select e9 a b`, `tabs`, `tabs close`, `tabs select 2`,
    `wait --ms 2000`, `scroll -300`.
  - `start and stop are the usage line that names the person`; `an unknown command, a missing argument, a
    non-number where one is asked, and one argument too many are usage`.
  - Review Focus 4: `type e7 -- --submit` is the text `--submit` with no submit; `type e7 -` asks for standard
    input; `type e7 "a \"b\"\nc"` keeps the quotes and the new line.
- [ ] **Step 2:** `npx vitest run src/agentClient/browserArgs.spec.ts`: FAIL (no module). Commit `test: harness
  browser's commands build the tools' calls`.
- [ ] **Step 3: Green.** Add the fields to the JSON with the spec's examples; implement the two functions.
- [ ] **Step 4:** Same command plus `src/services/agentBrowser/assets.spec.ts`: PASS. Commit `feat: harness browser's
  commands and help come from browser-tools.json`.

### Task 6: The output cap and the files

**Files:**
- Create: `cli/src/agentClient/browserOutput.ts`, `cli/src/agentClient/browserOutput.spec.ts`

**Depends on:** Task 0 (`OUTPUT_CAP_CHARS`).

**Interfaces, produces:**

```ts
export const OUTPUT_CAP_CHARS = 8_000   // Task 0's number when it has one
export const KEPT_FILES = 50
/** `$TMPDIR/browser`, made 0700. Throws `BrowserFilesError` (one line) when TMPDIR is unset or the folder cannot be made. */
export function browserFolder(env: NodeJS.ProcessEnv): string
/** Writes the JPEG as `shot-<yyyymmdd-hhmmss-mmm>.jpg`, keeps the newest 50 files, and gives its path. */
export function saveScreenshot(env: NodeJS.ProcessEnv, base64: string, now?: Date): string
/** `text` as it is when it fits; else its first OUTPUT_CAP_CHARS characters, the whole saved as
 *  `output-<stamp>.txt`, then the line `Cut at <cap> characters. The whole output: <path>`. */
export function capOutput(env: NodeJS.ProcessEnv, text: string, now?: Date): string
export class BrowserFilesError extends Error {}
```

- [ ] **Step 1: Red.** Cases, each in a throwaway folder: `a screenshot is written whole and only its path comes
  back`; `text under the cap is printed as it is and writes no file`; `longer text is cut at the cap, saved whole,
  and ends with the line that names the file`; `the folder keeps the newest 50 files: the 51st deletes the oldest,
  whatever its kind`; `the folder is 0700`; Review Focus 3: `with no TMPDIR, with browser a file, and with a folder
  that cannot be written, it throws one line and writes nothing elsewhere`.
- [ ] **Step 2:** `npx vitest run src/agentClient/browserOutput.spec.ts`: FAIL. Commit `test: screenshots and long
  output go to the agent's temporary folder`.
- [ ] **Step 3: Green.** Implement; set `OUTPUT_CAP_CHARS` from the measurements file.
- [ ] **Step 4:** Same command: PASS. Commit `feat: a screenshot is a file, and long output is cut, saved and named`.

### Task 7: One tool server per ready browser

**Files:**
- Create: `cli/src/services/agentBrowser/toolServers.ts`, `cli/src/services/agentBrowser/toolServers.spec.ts`

**Depends on:** nothing.

**Interfaces, produces:**

```ts
export interface ToolChild {
  stdin: Writable; stdout: Readable; stderr?: Readable | null
  once(event: 'exit' | 'error', listener: () => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}
export type ToolReply = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean }
export type ToolFailure = 'BUSY' | 'STOPPED' | 'ENDED' | 'TOOL_TIMEOUT' | 'TOOL_FAILED'
export const MAX_WAITING = 8
export const WINDOW_MS = 5_000
/** The tool's own limit plus 10 s: 70_000 for browser_navigate, 40_000 for browser_wait, 30_000 for the rest. */
export function runLimitMs(tool: string): number
export class ToolServers {
  constructor(deps: { spawn: (agentId: string) => ToolChild; log: (line: string) => void })
  /** One tool call, after those that arrived before it. `gone` aborts a call that still waits. */
  call(agentId: string, tool: string, args: Record<string, unknown>, human: string, gone?: AbortSignal): Promise<{ reply: ToolReply } | { error: ToolFailure }>
  /** Chrome's window, written at once, beside whatever call runs. */
  window(agentId: string, width: number, height: number): Promise<{ width: number; height: number } | { error: 'WINDOW_FAILED' }>
  /** Ends the agent's tool server and answers every running and waiting call with `why`. How many it answered. */
  end(agentId: string, why: 'STOPPED' | 'ENDED'): number
  endAll(): void
}
```

The line written for a call is today's relay's:
`{"jsonrpc":"2.0","id":<n>,"method":"tools/call","params":{"name","arguments","_harness":{"human"}}}`; for the
window: `{"jsonrpc":"2.0","id":<n>,"method":"window","params":{"width","height"}}`. No `initialize` is written.
Rules: the child starts at the first call or window and again after it exits; a child that cannot start, or exits
before it ever answered, fails the running call `TOOL_FAILED`; one that exits after answering fails it `ENDED`;
calls that wait stay and the next starts a new child; a call past `runLimitMs` is `TOOL_TIMEOUT`, the child is
killed, and the next call starts a new one; a window not answered in `WINDOW_MS`, or answered with an error (an
image from before has no such method), is `WINDOW_FAILED` and kills nothing; `stderr` is read and dropped (it can
name an address); a line that is not JSON, or answers no waiting id, is ignored.

- [ ] **Step 1: Red.** Cases, with a fake child (two `PassThrough`s and an emitter) and fake timers:
  `the first call starts the child once and a second reuses it`; `calls run in the order they arrive, one at a
  time`; `eight wait and the ninth is BUSY`; `each call carries its human mode`; `a call past its limit is
  TOOL_TIMEOUT, its child is killed, and the next call starts another` (30 s, 70 s for navigate, 40 s for wait);
  `a child that exits after answering fails the running call ENDED and the next call starts another`; `a child that
  cannot start is TOOL_FAILED`; `end answers the running call and every waiting one with its reason, says how many,
  and ends the child's input`; `a call whose asker went while it waited never runs`; `the window is written while a
  call runs, answers its size, and is WINDOW_FAILED after 5 s or on an error, killing nothing`; `garbage and
  unknown ids on the child's output are ignored`; `endAll ends every child`.
- [ ] **Step 2:** `npx vitest run src/services/agentBrowser/toolServers.spec.ts`: FAIL. Commit `test: the daemon
  keeps one tool server per ready browser`.
- [ ] **Step 3: Green.** Implement.
- [ ] **Step 4:** Same command with `--coverage --coverage.include=src/services/agentBrowser/toolServers.ts`: PASS at
  100%. Commit `feat: a daemon-held tool server per ready browser, one command at a time`.

### Task 8: Telling the agent, once per start

**Files:**
- Create: `cli/src/services/agentBrowser/notices.ts`, `cli/src/services/agentBrowser/notices.spec.ts`
- Modify: `cli/src/services/agentBrowser/stateFile.ts` (`BrowserStateData` gains `told?: Record<string, true>`; a
  file without it reads as nobody told)
- Test: `cli/src/services/agentBrowser/stateFile.spec.ts`

**Depends on:** nothing (`agent_browser_notice_failed` is a string here; Task 1 names it).

**Interfaces, produces:**

```ts
export const READY_LINE = 'Your browser is ready: run `harness browser --help`'
export const STOPPED_LINE = 'Your person stopped your browser.'
export const NOTICE_TRIES = 3
export const NOTICE_RETRY_MS = 30_000   // times the try: 30 s, then 60 s
export class Notices {
  constructor(deps: {
    state: StateFile
    turns: Pick<CoreApi['turns'], 'deliver' | 'cancelDelivery' | 'onDelivery'>
    measure: (name: string) => void
    log: (line: string) => void
  })
  /** The browser is ready: an agent with no mark, and no ready line already on its way, is typed the ready line. */
  ready(agentId: string): void
  /** The person's Stop. `saidByCommand`: one of the agent's commands already answered with the stop line. */
  stopped(agentId: string, saidByCommand: boolean): void
  /** The agent stopped or was deleted: what waits for it is taken back and never tried again. The mark stays. */
  ended(agentId: string): void
  close(): void
}
```

Rules. Delivery ids are `agent-browser:<agentId>:<ready|stopped>:<uuid>`; every other id heard is ignored. The
mark is set when the ready line is `delivered` or `started`, and for `unknown` too (it may have been written, and a
line is never typed twice), with a log line. `rejected`: tried again after `NOTICE_RETRY_MS × try`, three tries in
all, then one log line `notice_failed` and `agent_browser_notice_failed`; no mark, so the next `ready` tries again.
`stopped`: clears the mark; then (a) a ready line that waits is taken back (`cancelDelivery`), and only if it is
later heard `delivered` or `started` is the stop line typed (unless `saidByCommand`), and that late `delivered`
sets no mark; (b) else, when the mark was set and not `saidByCommand`, the stop line is typed, with the same three
tries; (c) else nothing: that agent never knew. A state file that cannot be read types nothing and logs why.

- [ ] **Step 1: Red.** Cases, with fake turns and fake timers:
  `the first ready types the ready line once, and the mark is set when it is written`; `a second ready, a daemon
  restart (a new Notices on the same file) and a resume type nothing`; `an entry with no mark is told once`;
  `the person's Stop types the stop line and clears the mark, and the next ready is told again`; `a command that
  said the stop line: nothing is typed`; `a ready line still waiting is taken back and no stop line follows`;
  `a ready line that was already being written when Stop came is followed by the stop line, and leaves no mark`;
  `a line the core gives up on is delivered again after 30 s and 60 s, then logged and counted, and the browser
  stays owed`; `an unknown outcome sets the mark and types nothing more`; `a stop for an agent that was never told
  types nothing`; Review Focus 5: `the agent ends while a line waits: it is taken back, no retry follows, and the
  next ready after its resume types the ready line`; `another service's deliveries are ignored`; `an unreadable
  state file types nothing and is logged`; `close stops hearing`.
  `stateFile.spec.ts`: `a file with no told reads as nobody told, and update keeps a told it does not know`.
- [ ] **Step 2:** `npx vitest run src/services/agentBrowser/notices.spec.ts
  src/services/agentBrowser/stateFile.spec.ts`: FAIL. Commit `test: the agent is told once per start, and at its
  person's Stop`.
- [ ] **Step 3: Green.** Implement.
- [ ] **Step 4:** Same command with coverage for `notices.ts` and `stateFile.ts`: PASS at 100%. Commit `feat: the
  ready line once per start, and the stop line at the person's Stop`.

### Task 9: The tool server answers calls and the window, and no MCP handshake

**Files:**
- Modify: `cli/assets/browser/browser-tools.mjs` (`answer`, the header comment, the unused `TOOLS` read),
  `cli/assets/browser/browser-tools-lib.mjs`
- Test: `cli/src/services/agentBrowser/browserToolsLib.spec.ts`

**Depends on:** nothing. The script itself runs only in the image (no `playwright-core` in the CLI's modules), so
what it decides moves into the lib, which the spec imports; Task 18 proves it in a real container.

**Interfaces, produces (in `browser-tools-lib.mjs`):**

```js
/** The answer to one line: `tools/call` is `call(params)`, `window` is `window(params)`, anything else null
 *  (the script answers null as "Unknown method", as today). */
export async function answer(message, { call, window })
/** Chrome's window at 0,0 with this size, not maximized: `Browser.getWindowForTarget`, then
 *  `Browser.setWindowBounds({windowId, bounds: {left: 0, top: 0, width, height, windowState: 'normal'}})`, then the
 *  bounds read again. Gives `{width, height}` as Chrome has them. `send(method, params)` is the page's CDP session. */
export async function setWindow(send, { width, height })
```

In the script, `window` is `setWindow` over `(await page()).context().newCDPSession(await page())`, inside
`withTimeout(…, TOOL_MS, 'window')`. A line from a relay that still runs (`initialize`, `tools/list`, `ping`) is now
an unknown method; its `tools/call` is unchanged.

- [ ] **Step 1: Red.** Cases: `answer routes tools/call to call and window to window`; `initialize, tools/list and
  ping are unknown methods`; `setWindow asks for the window, sets it at 0,0 with the size and windowState normal,
  and answers the bounds Chrome reports`; `setWindow passes a CDP failure on`.
- [ ] **Step 2:** `npx vitest run src/services/agentBrowser/browserToolsLib.spec.ts`: FAIL. Commit `test: the tool
  server answers calls and the window only`.
- [ ] **Step 3: Green.** Implement both; the script uses them.
- [ ] **Step 4:** Same command plus `src/services/agentBrowser/assets.spec.ts`: PASS. Commit `feat: the tool server
  drops the MCP handshake and sizes Chrome's window`.

### Task 10: The viewer page clips to the window

**Files:**
- Modify: `desktop/tool/browser_viewer/viewer.js`, `desktop/assets/browser/browser_viewer.html` (rebuilt:
  `npm run build` in `desktop/tool/browser_viewer`)
- Test: `desktop/tool/browser_viewer/viewer.test.mjs`

**Depends on:** nothing.

**Interfaces, produces:** the page takes `{t: 'window', width, height}` from its host. Until one arrives it scales
the whole screen, as today (`scaleViewport = true`).

- [ ] **Step 1: Red.** Cases: `before any window message the screen is scaled to fit, as before`; `a window the
  size of the page is clipped to that rectangle at 0,0 at 1:1` (`clipViewport` true, `scaleViewport` false,
  `dragViewport` false, the element the size of the rectangle); `a window larger or smaller than the page is that
  rectangle scaled to fit`; `the page resizing scales again without another message`; `a new connection keeps the
  last window`. Keep `the committed html equals a fresh build`.
- [ ] **Step 2:** `cd desktop/tool/browser_viewer && npm ci && npm test`: FAIL. Commit `test: the viewer page shows
  Chrome's window at 1:1`.
- [ ] **Step 3: Green.** Implement in `viewer.js`; rebuild the html.
- [ ] **Step 4:** `npm test`, and in `desktop/`: `flutter test --no-pub test/browser/viewer_asset_test.dart`: PASS.
  Commit `feat: the viewer page clips to Chrome's window and scales only when it must`.

### Task 11: New agent without Browser

**Files:**
- Delete: `desktop/lib/browser/browser_pill.dart`, `desktop/test/goldens/swarm-elements/browser-pill-light.png`,
  `browser-pill-dark.png`
- Modify: `desktop/lib/state/new_harness.dart:1051-1116` and `:625`, `:4968`; `desktop/lib/widgets/new_harness_form.dart:980-990`
  and `:2464-2472`; `desktop/lib/state/harness_launch_integration.dart:45,64-65`;
  `desktop/lib/super_tabs/new_agent.dart:101`; `desktop/lib/state/app_state.dart:15879,15916` (create's `browser`);
  `desktop/lib/browser/browser_availability.dart` (the comment on `browserOffered`);
  `desktop/design/desktop-design-system.md` (the "Browser in New agent" entry goes; "Set up Browser" says it opens
  from the Browser panel's Install on a computer with no Podman, Install starts the setup, Cancel does nothing)
- Test: `desktop/test/new_harness_form_test.dart:997-1125`, `desktop/test/super_tab_new_agent_launch_test.dart`,
  `desktop/test/browser/browser_requests_test.dart:211`, `desktop/test/swarm_elements_gallery_test.dart:853-874`

**Depends on:** nothing.

- [ ] **Step 1: Red.** `super_tab_new_agent_launch_test.dart`: replace the Install case with `New agent shows no
  Browser pill, and Start creates the agent with no browser and no setup request` (opens the form as a person
  does, presses Start; `find.byKey(ValueKey('new-harness-field-browser'))` finds nothing; the `agent_create`
  payload has no `browser` key; no `agent_browser_setup` and no `agent_browser_available` was sent).
  `browser_requests_test.dart:211`: `createAgent sends no browser`. Remove the group at
  `new_harness_form_test.dart:997` and the gallery's `browser-pill` section.
- [ ] **Step 2:** `flutter test --no-pub test/super_tab_new_agent_launch_test.dart
  test/browser/browser_requests_test.dart`: FAIL (the pill is there; `browser` is sent). Commit `test: New agent
  has no Browser pill`.
- [ ] **Step 3: Green.** Remove the pill, the form's browser state and `setUpBrowser`, `offersBrowser`, and the
  `browser` argument of create; delete the two goldens; change the design doc.
- [ ] **Step 4:** The Desktop command under Wave 1 verify: PASS. Commit `feat: Browser leaves New agent`.

---

## Wave 2

### Task 12: Start, Stop and telling in the service; settings while off

**Files:**
- Modify: `cli/src/services/agentBrowser.ts`, `cli/src/services/agentBrowserProcess.ts`,
  `cli/src/services/agentBrowser/browsers.ts:375-381` (`remove` also deletes the agent's `told`),
  `cli/src/core/api.ts:714` (`AGENT_BROWSER_REQUESTS` gains `agent_browser_start`, `agent_browser_stop`; its comment)
- Test: `cli/src/services/agentBrowser.spec.ts`, `cli/src/services/agentBrowserProcess.spec.ts`,
  `cli/src/services/agentBrowser/browsers.spec.ts`, `cli/src/core/api.spec.ts:283`

**Depends on:** Tasks 1, 2, 8.

**Interfaces:**
- Consumes: `core.agents.setBrowser` and `BrowserSwitch` (Task 2); `Notices` (Task 8).
- Produces: the two requests of the Contract; in `agentBrowserProcess.ts`, `agents.setBrowser` asked as
  `set_browser`, and the turns of `turnsLink(ask)` handed to `processCoreApi` (`deliveries`), with `onEvent`
  passing each payload to `deliveries.heard` first.

Rules:
- `agent_browser_start`: `NOT_OWNER` unless `mayOpenBrowser`; a browser that is `failed` is tried again exactly as
  `agent_browser_retry` does (its `LOCAL_ONLY` rule too); one that is on answers `{ok: true}`; else
  `core.agents.setBrowser(agentId, true)`: its error is the answer, and `changed` counts `agent_browser_started`.
  The browser itself starts through the port's `attached`, which the core calls.
- `agent_browser_stop`: `NOT_OWNER` unless `mayOpenBrowser`. For a browser the service has: add the agent to
  `byPerson`, `notices.stopped(agentId, false)` (Task 15 passes what the tool servers said), then
  `core.agents.setBrowser(agentId, false)`; `changed` counts `agent_browser_stopped`. For one it does not have:
  the switch alone. Always `{ok: true}`.
- The port's `stopped(agentId)`: `byPerson.delete(agentId)` says whether this stop is the person's; when it is
  not, `notices.ended(agentId)`. `deleted` calls `notices.ended` too.
- `changed`: a browser that turned `ready` calls `notices.ready(agentId)`.
- Settings while off: `agent_browser_settings`, `_settings_save` and `_proxy_test` answer for any agent in
  `core.agents.ids()` (live or stopped), whether or not it has a browser; an id that is not this machine's is
  `NO_BROWSER`. A save while off writes the entry and starts nothing. `agent_browser_retry` keeps `NO_BROWSER`.
- Windows (`unsupported()`): `agent_browser_start` and `_stop` answer `NOT_ON_WINDOWS`; the rest as today.
- Comments: the file's header, and the dated compatibility line on `agent_browser_state`.

- [ ] **Step 1: Red.** Cases in `agentBrowser.spec.ts` (fake `podman`, a fake core whose `setBrowser` calls the
  port as the core does):
  - `start is refused NOT_OWNER for a guest and a machine share, and allowed for the person's other Desktop`; the
    same for stop.
  - `start sets the flag, starts the browser and counts agent_browser_started; a second start does nothing`.
  - `start of a failed browser tries again as Retry does`; `start for an agent that does not run is NOT_RUNNING`;
    `start for a guest's agent is NOT_ALLOWED`.
  - `stop clears the flag, removes the container, its network and its proxy secret, keeps the volume and the
    settings, and counts agent_browser_stopped; a stop of one that is off answers ok and does nothing`.
  - `stop while it starts ends the start without a container; start right after stop waits for it`.
  - `the ready line is typed once when the person's Start is ready, and the stop line at the person's Stop`.
  - `the agent's own stop types nothing and keeps the mark; its resume types nothing`.
  - `an agent created with browser:true by an older Desktop is started when it runs and told once`.
  - `settings are read and saved for an agent whose browser is off, a save starts nothing, and an id of no agent
    here is NO_BROWSER`; `a settings entry made while off goes with its agent`.
  - `on win32 start and stop answer NOT_ON_WINDOWS and no process starts`.
  - Update `declares its requests and answers each` and the two win32 cases for the longer list.
  `agentBrowserProcess.spec.ts`: `asks the core to set the flag, and answers what it said`; `delivers its lines
  through the core and hears what became of them`; `a core that does not answer the switch rejects`.
  `browsers.spec.ts`: `a delete removes the agent's told mark with its settings`. `api.spec.ts:283`: the list.
  Where a case checks a line's delivery, it checks the agent, the text and the id's prefix, never the whole
  argument list or payload: Task 22 adds an option to it.
- [ ] **Step 2:** `npx vitest run src/services/agentBrowser.spec.ts src/services/agentBrowserProcess.spec.ts
  src/services/agentBrowser/browsers.spec.ts src/core/api.spec.ts`: FAIL. Commit `test: the person's Start and Stop
  on the agent's machine`.
- [ ] **Step 3: Green.** Implement the rules.
- [ ] **Step 4:** Same command and `npm run typecheck`: PASS. Commit `feat: agent_browser_start and
  agent_browser_stop, the two lines, and settings before the first start`.

### Task 13: `harness browser`; `harness browser-mcp` goes

**Files:**
- Create: `cli/src/agentClient/browser.ts`, `cli/src/agentClient/browser.spec.ts`
- Delete: `cli/src/agentClient/browserMcp.ts`, `cli/src/agentClient/browserMcp.spec.ts`
- Modify: `cli/src/cli.ts:2766,2836-2839` (`case 'browser'` replaces `case 'browser-mcp'`),
  `cli/src/agentClient/help.ts`
- Test: `cli/src/agentClient/help.spec.ts`

**Depends on:** Tasks 4, 5, 6. The daemon is a fake in the spec, so not Task 15.

**Interfaces:**
- Consumes: `parseBrowserArgs`, `browserHelp` (Task 5); `saveScreenshot`, `capOutput`, `BrowserFilesError`
  (Task 6); `runningPane` (Task 4); `whereFor`, `openDaemon`, `AgentClientError`, `EXIT`; `runLimitMs` is not
  imported from the service: the three waits are constants here (35 s, 75 s for navigate, 45 s for wait).
- Produces:

```ts
export function browserCommand(argv: readonly string[], io?: { stdout: Writable; stderr: Writable; stdin: Readable },
  deps?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; probe?: PaneProbe; where?: (pane: string) => Where; open?: typeof openDaemon }): Promise<number>
```

Order: on `win32`, every form prints the Windows line and exits 5, before anything else; help prints and exits 0
with no daemon; a usage error exits 2; then the pane: `runningPane(env, probe, platform)`, and a refusal or no
proven pane exits 5 with the pane line (a ptyhost pane on macOS or Linux is not proven and is refused); `type … -`
reads standard input; one request `agent_browser_run {pane, ancestors, command, args}` with the command's wait;
then the Contract's second table. The `NOT_READY` words move here from `browserMcp.ts`. `help.ts` gains one line:
`harness browser --help   your browser, when your person has started it`.

- [ ] **Step 1: Red.** Cases in `browser.spec.ts` (a fake daemon that records the request and answers from a table):
  `--help prints every command and opens no daemon`; `start and stop exit 2 with the line that names the person`;
  `a wrong command exits 2 with its usage`; `on Windows it prints its line, exits 5 and starts nothing`;
  `with no pane, and with a TMUX_PANE that names another pane, it exits 5 and asks nothing`; `the request carries
  the proven pane, its parents and the tool's call, and never an agent id`; one case per row of the Contract's
  second table (exit code, the stream it prints on, the exact line); `navigate waits 75 s, wait 45 s, the rest
  35 s, and says <command> timed out after`; `a screenshot prints only its path and the file is the JPEG`; `long
  output is cut and names its file`; `type - sends standard input as the text`; `a folder that cannot be written
  is one line and exit 1`; `the daemon unreachable is exit 1 with the agent verbs' line`.
  `help.spec.ts`: `names harness browser --help in one line` (and still fits 40 lines).
- [ ] **Step 2:** `npx vitest run src/agentClient/browser.spec.ts src/agentClient/help.spec.ts`: FAIL. Commit `test:
  harness browser, by exit code`.
- [ ] **Step 3: Green.** Implement; swap the case in `cli.ts`; delete the relay and its spec.
- [ ] **Step 4:** Same command plus `src/architecture.spec.ts` and `npm run typecheck`: PASS. Commit `feat: harness
  browser drives the agent's browser; harness browser-mcp goes`.

### Task 14: Desktop's Start, Stop and window requests, sealed

**Files:**
- Modify: `desktop/lib/state/app_state.dart:2963-2973`, `desktop/lib/e2ee/envelope.dart:77-83`
- Test: `desktop/test/browser/browser_requests_test.dart` (red), `desktop/test/e2ee/encrypted_down_types_test.dart`
  (unchanged: it reads the CLI's list from Task 2 and fails if a sent type is not sealed)

**Depends on:** Tasks 2 and 11.

**Interfaces, produces:**

```dart
Future<void> agentBrowserStart(String machineId, String agentId)
Future<void> agentBrowserStop(String machineId, String agentId)
/// The window as the machine set it; null when it could not (an older CLI, a browser not ready, a failed call).
/// Never throws; a refusal is logged by its code alone.
Future<({int width, int height})?> agentBrowserWindow(String machineId, String agentId, int width, int height)
```

Start and stop throw as `agentBrowserRetry` does (`WsRequestFailure` with the machine's code, `StateError` for a
machine that cannot be asked).

- [ ] **Step 1: Red.** Cases: `start and stop send their requests with the agent's id`; `a refusal reaches the
  caller with the machine's code`; `the window sends the size and reads the size set; UNSUPPORTED, NOT_READY and
  WINDOW_FAILED are null`; extend `nothing is sent to a machine shared with this account` with the three.
- [ ] **Step 2:** `flutter test --no-pub test/browser/browser_requests_test.dart`: FAIL. Commit `test: Desktop asks
  a machine to start, stop and size an agent's browser`.
- [ ] **Step 3: Green.** Add the three methods and the three types to `encryptedDownTypes`.
- [ ] **Step 4:** The Desktop command under Wave 2 verify: PASS. Commit `feat: Desktop's start, stop and window
  requests, sealed`.

### Task 20: `harness browser` runs without asking, in both engines

Task 0 found `browser` outside the verbs Harness allows in the engines' own rules. Claude Code in Ask mode asks the
person before each command (measured with the unlisted `harness status`: `This command requires approval`); Codex
tries it in its sandbox, which cannot reach the daemon, before it asks to leave (`hooks.ts:91-95`). `harness send`
is in those rules, and `harness browser` joins it. What a command may do stays Harness's to decide, as for the other
verbs: only the person starts and stops (exit 2), a command reaches only the browser of the pane it runs in
(Tasks 13, 15), and a guest's agent is refused.

**Files:**
- Modify: `cli/src/engines/facets/hooks.ts:91-99` (the verbs and their comment),
  `cli/src/engines/kit/hookSettings.ts:132-149` (`harnessRules`),
  `cli/src/engines/__fixtures__/hook-installers.golden.json` (recorded again, never edited by hand),
  `cli/e2e/agentClient.e2e.ts:483-518` (the lists that case expects: `browser` with its two `Bash` rules and no
  `mcp__` rule, and in Codex's two lists)
- Test: `cli/src/engines/kit/hookSettings.spec.ts:155-262`, `cli/src/agentClient/mcp.spec.ts:88-96`

**Depends on:** nothing. Not Task 13: a rule for a command that does not exist yet allows nothing.

**Interfaces, produces (`facets/hooks.ts`):**

```ts
/** Agent commands that are a shell command only, never an MCP tool: `browser` drives the agent's own browser, and
 *  nothing of it is MCP (docs/superpowers/specs/2026-11-11-browser-from-chat-design.md). */
export const HARNESS_SHELL_VERBS = ['browser'] as const
export type HarnessAgentVerb = keyof typeof HARNESS_AGENT_TOOLS | (typeof HARNESS_SHELL_VERBS)[number]
export const HARNESS_AGENT_VERBS: HarnessAgentVerb[] =
  [...(Object.keys(HARNESS_AGENT_TOOLS) as HarnessAgentVerb[]), ...HARNESS_SHELL_VERBS]
```

`HARNESS_AGENT_TOOLS` does not change: `mcp.spec.ts:94` holds every key of it to a tool of `harness mcp`, and
`browser` has none. `harnessRules` makes a rule that names `{tool}` only for a verb that has a tool, and a verb's
group of a kind with no rule left is no group (`withRules` adds a group together or not at all). `removeHooks.ts`
reads `harnessRules`, so an uninstall takes the new rules with the rest. `RULES_HEADER` lists the verbs, so Codex's
file changes in its header too, and the daemon writes it again at its next start (`writeRulesFile` compares the
whole text).

What lands on a computer, written by the daemon as it starts, as today:
- Claude Code, `permissions.allow`: `Bash(harness browser:*)` and `Bash(<launcher> browser:*)`, after `tell`'s
  rules; no `mcp__…` rule for it. A deny or an ask of the person's that touches either keeps both out (`unless`).
- Codex, `rules/harness.rules`: `"browser"` last in each `{verbs}` list and in the header's list of commands.

- [ ] **Step 1: Red.** In `hookSettings.spec.ts`:
  - the helpers follow the code: `claudeRules` gives a verb its `mcp__` rules only when `HARNESS_AGENT_TOOLS` has
    it, and `codexRulesFile` names `"browser"` after `"tell"`, in the header too. The cases that use them
    (`allows Harness's agent commands and MCP tools in Claude Code…`, `adds the rules an earlier release did not
    have…`, `allows Harness's agent commands in a Codex rules file of its own…`, `rewrites the Codex rules file an
    earlier release wrote…`) then fail;
  - new: `allows harness browser in Claude Code by name and by the launcher's path, and no MCP tool for it` (the
    two `Bash` rules are in `allow`; no rule holds `undefined`, `{tool}` or `browser` after `mcp__`);
  - new, Review Focus 8: `a deny or an ask for harness browser keeps its allow out in both spellings`;
  - `allows only Harness's own MCP tools…` expects the tools of `HARNESS_AGENT_TOOLS`' verbs;
  - new: `harnessRules gives a verb with no tool its commands alone, and no empty group`.
  In `mcp.spec.ts`: `browser is an agent verb and no MCP tool` (`HARNESS_AGENT_VERBS` holds it, `HARNESS_AGENT_TOOLS`
  does not, and no tool of `TOOLS` runs it).
- [ ] **Step 2:** `npx vitest run src/engines/kit/hookSettings.spec.ts src/agentClient/mcp.spec.ts`: FAIL (no rule
  names `browser`). Commit `test: harness browser is in both engines' allow rules`.
- [ ] **Step 3: Green.** Implement. Record the fixture: `RECORD_HOOK_GOLDEN=1 npx vitest run
  src/engines/hookInstallers.golden.spec.ts`; `git diff --stat` on it shows only the rules' lines (the `Bash`
  rules in Claude Code's lists, the verbs in Codex's file). Change the lists `e2e/agentClient.e2e.ts` expects.
- [ ] **Step 4:** `npx vitest run src/engines/kit/hookSettings.spec.ts src/engines/hookInstallers.golden.spec.ts
  src/engines/removeHooks.spec.ts src/agentClient/mcp.spec.ts src/lib/uninstall/command.spec.ts`, `npm run
  typecheck`, and `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/agentClient.e2e.ts -t "without
  asking"`: PASS. Commit `feat: agents run harness browser without asking, in Claude Code and Codex`; its message
  says the fixture was recorded again and why, as the fixture's spec asks.

### Task 21: A quiet turn ends with no recap and no notification

Task 0, from the code: every live turn's end makes a recap (`commander.ts:653-712`) and, unless it is a replay, a
sub-agent's, empty or at a question, a `done` notification (`agentNotifications.ts:24-31`) that Desktop turns into
an unread mark, a sound, a banner and an OS notification (`app_state.dart:23238-23258`, `:14703-14751`). Nothing
asks who started the turn. This task gives the turn's end a mark to read; Task 22 sets it for a delivery marked
`quiet`.

**Desktop has no task, and needs none.** Its alert has one cause: a `turn_summary` whose `notification` is of kind
`done` (`app_state.dart:23238-23258`, since 2026-09-28, #444), and the daemon makes that notification. A quiet
turn sends none, so no Desktop alerts, the released ones included: no Desktop code can be made to fail first.
`desktop/test/notification_parity_test.dart` already holds it (`a sub-agent turn end is not`; `raw, failed, aborted
and replayed turn ends are silent`, whose `turn_summary` carries no notification). It is seen on a real Desktop, new
and released, in the by-hand run at the end.

**Files:**
- Modify: `cli/src/lib/commander.ts` (`SessionState`, `ingest` at `:402-530`, `onTurnEnded` at `:653`)
- Test: `cli/src/lib/commanderNotifications.spec.ts`

**Depends on:** nothing.

**Interfaces, produces:**

```ts
/** `quiet`: the turn that ends in this batch was started by a line typed for the agent alone (a delivery marked
 *  quiet, core/api.ts `DeliveryOptions`): nobody asked for it, so its end makes no recap and no notification. */
ingest(events: LiveEvent[], sessionId: string, options?: { replay?: boolean; quiet?: boolean }): void
```

Rules:
- The mark is the turn's (`SessionState.quiet`): a `turn_started` clears it; a batch said `quiet` sets it at its
  `turn_ended`, before that end is handled, so an end held for sub-agents keeps it until it is let go
  (`releaseTurnEnd`), and a new prompt that supersedes a held end drops it.
- A quiet end, in `onTurnEnded` after the duplicate-close check and before anything is read: the turn closes; the
  transcript is not read (`readLastTurn`), no summary is cut (`summarize`), nothing is stored (the session's recaps
  and last full text stay the last real turn's), and `notifications.cancelled(sessionId)` so a second close cannot
  ring. The devices get `{kind: 'done'}`, which clears the busy card as an empty turn's end
  does, and no `summary` card. The apps get one `turn_summary` whose payload is `{sessionId, tier: 'silent'}`: no
  `summary`, no `notification`. Desktop reads only the notification; a phone that waits for a tier files nothing
  (`mobile/lib/notify/done_notice.dart:108`) instead of telling the end by its old rule four seconds later.
- One trace line, `turn-end · quiet → done, no recap`, with no content.
- An interrupted quiet turn takes the cancel path, as any. A batch that does not say `quiet` ends as today.
- Standard 4: a quiet end does less than any end today (no file read, no summary, no save); every other turn pays
  one boolean read.

- [ ] **Step 1: Red.** A new group in `commanderNotifications.spec.ts`, `a quiet turn`, with the file's `setup`:
  - `ends with no recap and no notification: the card goes done, the apps hear a silent tier and nothing else, and
    nothing is read or cut` (the device's kinds end with `done` and hold no `summary`; `desktop` is exactly one
    `turn_summary` with `payload: {sessionId: 's', tier: 'silent'}`; `summarize` and `readLastTurn` were not called);
  - `leaves the agent's last recap as it was` (a real turn, then a quiet one: `mirror.recent('s')` and
    `mirror.snapshot('s')` are what they were after the first);
  - `the turn after it tells as any turn does` (a third turn, not said quiet, sends its `done` notification);
  - Review Focus 7: `an end held for sub-agents stays quiet when it is let go` (the turn starts a sub-agent that
    still runs at its end; after `subagent_finished` and the settle, no summary and no notification), and `a quiet
    mark does not reach a turn that began after a held end`;
  - `a quiet end heard twice is told once`; `an interrupted quiet turn is cancelled as any`.
- [ ] **Step 2:** `npx vitest run src/lib/commanderNotifications.spec.ts`: FAIL (a summary and a `done` notification
  are sent). Commit `test: a quiet turn ends with no recap and no notification`.
- [ ] **Step 3: Green.** Implement.
- [ ] **Step 4:** `npx vitest run src/lib/commanderNotifications.spec.ts src/lib/commander.spec.ts
  src/lib/commanderReplay.spec.ts src/services/recaps.spec.ts` and `npm run typecheck`: PASS. Commit `feat: a turn
  said quiet ends with no recap and no notification`.

### Task 23: A browser left on follows its agent on every run path

**(Ken, 2026-11-11, decision 14.)** The bug, on the released build: an agent's browser is ended wherever the agent
ends (`createAgentBrowserLifecycle` `ended`), and attached again only by the three paths that were handed
`attachBrowser`. An agent that came back by any other path ran on with its flag set and no browser, and its button
was gone for good. The cause is a list of paths that must each remember; the fix is one place every running agent
passes, whatever started it: the reconciler's look at it (`discovery.ts` `onObserved`, where its DSH is attached
again for the same reason, `:196-197`).

**Files:**
- Modify: `cli/src/core/agents/lifecycle.ts:140-185` (`createAgentBrowserLifecycle` gains `observed`; its comment),
  `cli/src/core/agents/discovery.ts` (`DiscoveryDeps`, `:196-197`; the file's header),
  `cli/src/core/main.ts:1989-2007` (`createDiscoveryHandlers` is handed `attachBrowser: agentBrowsers.observed`; the
  comment at `:844-845`)
- Test: `cli/src/core/agents/lifecycle.spec.ts`, `cli/src/core/agents/discovery.spec.ts`,
  `cli/src/lib/registry.spec.ts:2065`
- Not changed: `cli/src/core/agents/create.ts:464`, `cli/src/lib/resumeAgentService.ts:424` and
  `cli/src/core/main.ts:2678` (they attach before the engine is seen, so the browser starts with the agent, not a
  scan later); `cli/src/lib/retainExitedSession.ts`, `cli/src/core/agents/forget.ts` (how a browser ends);
  `cli/src/core/api.ts`, `cli/src/core/agentBrowserLink.ts`, anything under `cli/src/services/`.

**Depends on:** Task 2. Nothing in wave 2.

**Interfaces, produces:**

```ts
// lifecycle.ts, beside `attached`, `ended` and `set`. Said on every look at a running agent: a browser that is on
// and has not been attached since its agent last ended is attached; any other look is one Set lookup.
observed(session: RegisteredSession): void

// discovery.ts, DiscoveryDeps (required: the compiler holds main.ts to it)
attachBrowser: (session: RegisteredSession) => void
```

**Every way an agent comes to run, and its browser today** (read from the code at wave 1's head). "Ends" is
whether `ended` is reached on the way:

| Path | Code | Id | Ends | Attached today |
|---|---|---|---|---|
| Create with `browser: true` (an older Desktop) | `create.ts:464` | new | no | yes (`create.spec.ts:752`) |
| The person's Start | `lifecycle.ts` `set` | same | no | yes (Task 2) |
| Resume of a stopped agent: Desktop, the Swarm (`superTabs/inCore/agents.ts:37`), with new launch words or mode | `resumeAgentService.ts:424` | same | yes, at its stop | yes (`resumeAgentService.spec.ts:411`) |
| Daemon start, for the rows the registry kept; a machine restart, whose restore relaunches into those rows (`restoreAgents.ts`, `restoreLaunch.ts`); a held launch started later (`heldLaunches.ts`) | `main.ts:2678` | same | no | yes, no unit test |
| **Back from the archive:** the daemon took a running engine for exited (a restore that could not see it, `restoreAgents.ts:496`, `main.ts:2555`; two missed scans, `discovery.ts:267`), archived it, and the next scan finds that same process | `discovery.ts:148` `reinstateArchived` | same | yes | **no** |
| Restart in its pane (`agent_restart`, with or without new launch words), a move to a grid or back (`retarget.ts`), a move to the pty host and its fallback (`hostMove.ts`): all relaunch through `relaunchOverrides` and `restartAgent` with the route held | `restart.ts`, `swap.ts` | same | no | not needed: never ended. No test says so |
| An engine that exits and comes back in its pane before two scans retire its row, its start hook (with its process) first: the row is re-registered in place and keeps the flag (`registry.ts:2144`) | `registry.ts` `register` | same | no | not needed (`registry.spec.ts:2065`) |
| A start that went dormant and wakes; a launch that turns ready | `discovery.ts:208-240` | same | no | not needed |
| The same, a scan first: a new agent is opened in the pane and the bound row is forgotten | `discovery.ts:94-131` `openProcessAgent` | **new** | yes | no: the new row has no flag |
| The engine exits, two scans retire the row (`retainExitedSession`): its pane is left a shell under a new id, the flag taken off it (`registry.ts:2380`), and an engine is typed again there | `discovery.ts:163-165` `adoptEngine` | **new** | yes | no: no flag |
| An engine that never came up, or that a restore could not relaunch: the row stays, a terminal under its id, flag kept; an engine typed there is that agent again | `newPane.ts:139`, `restoreAgents.ts:528,785` | same | no | not needed |
| Fork, Change agent, an adopted outside conversation, a guest's agent, `--resume` in a second pane | `fork.ts`, `externalResume.ts`, `guestCreate.ts` | new | – | no flag: another agent |

So one path lacks it today: back from the archive. The paths with no test of their own (daemon start, a restart
in its pane) get one on the real daemon in Task 17's case, and every one that keeps its id is held by this task's
look. The two that come back under a new id are not this task's: the flag is kept by id (Where the spec needed a
call, 21). Decision 19 came after: on those two paths the browser moves to the new id (Tasks 24 to 26), and Task 26
turns this task's two pins of call 21 into its red tests.

Rules:
- **lifecycle.ts.** `observed(session)`: `session.browser` set and the agent not in `running`: `attached(session)`.
  Else nothing. `attached`, `ended` and `set` do not change: a Start still attaches every time.
- **discovery.ts.** In `onObserved`, beside the DSH's line and on the row the registry holds now: a row with
  `browser` is handed to `attachBrowser`. One line serves every path: an agent back from the archive passes it
  (`:157` calls `onObserved` again with the row that came back), and so does every running agent on every scan.
  `onDiscovered` is not changed: a row it opens is new, and one it re-observes reaches `onObserved` a scan later.
- **main.ts.** `attachBrowser: agentBrowsers.observed`. The loop at `:2678` stays: it takes up the browsers of rows
  that are not seen running yet (a held launch, a restore under way).
- **Nothing is typed.** A browser that comes back with its agent keeps its `told` mark (Tasks 8 and 12): this task
  touches no service file.
- **Standard 4.** A scan runs while the daemon is idle. Added per observed agent: one property read; per agent
  whose Browser is on: one Set lookup more. No event, no timer, no read of the service. Step 5 measures it.

- [ ] **Step 1: Red.**
  - `lifecycle.spec.ts`, in "the agent browser, as its agent starts and ends":
    - `an agent that ended and is seen running again gets its browser back, once: every later look tells the
      browser nothing` (attached, `ended`, then `observed` three times: the port's `attached` is called twice in
      all, and `ended` after it still stops one browser);
    - `a look at an agent that is attached already tells nothing: one created with Browser, one its person
      started, one there at daemon start`;
    - `a look at an agent whose Browser is off, or that its person turned off, attaches nothing`.
  - `discovery.spec.ts`, each through `handlers.onObserved` with the registry's row carrying `browser: true`:
    - in "an archived harness whose own engine never stopped": `comes back with its browser: the flag its archive
      kept is handed to the browser's attach, with the row that came back` (Review Focus 9);
    - in "a row's own process": `tells the browser of a running agent whose Browser is on, on every scan, and of
      no agent whose Browser is off`;
    - `a start that went dormant and wakes, and a launch that turns ready, are told too` (the two cases at `:339`
      and `:363`, with the flag);
    - `a terminal that kept its id and its flag is told once an engine runs in it again`;
    - by id, both pass as written and pin call 21: `an engine typed into the shell an exit left is that shell's
      agent: it has no flag and nothing is attached`; `a process that takes a bound agent's pane opens a new agent
      with no browser, and the agent it replaced is forgotten`.
  - `registry.spec.ts:2065`, one line more, a pin that passes as written: an agent `reinstateArchived` brings back
    keeps `browser` (the row is rebuilt from its archive; a rebuild from named fields would drop it).
- [ ] **Step 2:** `npx vitest run src/core/agents/lifecycle.spec.ts src/core/agents/discovery.spec.ts
  src/lib/registry.spec.ts`: FAIL (`observed` does not exist; discovery never calls `attachBrowser`). Commit
  `test: a browser left on is attached on every look at its running agent`.
- [ ] **Step 3: Green.** Implement the rules. Comments: `createAgentBrowserLifecycle`'s says how a browser comes back
  (create, resume and daemon start at once; any other path at the next scan); discovery's header names the browser
  beside the DSH.
- [ ] **Step 4:** Same command with `--coverage --coverage.include=src/core/agents/lifecycle.ts
  --coverage.include=src/core/agents/discovery.ts`: PASS at 100%. Then `npx vitest run
  src/core/agents/create.spec.ts src/lib/resumeAgentService.spec.ts` (the two paths that attach at once, untouched)
  and `npm run typecheck`: PASS.
- [ ] **Step 5: Numbers (standard 4),** in the task's report, for the pull request. A throwaway script run with
  `npx tsx`, not committed: 1,000,000 `onObserved` calls of one awake, bound agent whose Browser is on and
  attached, through `createDiscoveryHandlers` with deps that do nothing; three runs on the task's base commit and
  three on its head, the medians side by side. Not slower beyond the spread of the three runs.
- [ ] **Step 6:** Commit `feat: a browser left on comes back with its agent, however the agent runs again`.

---

## Wave 3

### Task 15: The agent's commands and the window, in the service

**Files:**
- Modify: `cli/src/services/agentBrowser.ts`, `cli/src/services/agentBrowserProcess.ts`,
  `cli/src/services/agentBrowser/settings.ts` (`clampWindow`),
  `cli/src/core/api.ts` (`AGENT_BROWSER_REQUESTS` gains `agent_browser_run`, `agent_browser_window`; `ofPane`;
  `CoreApiDeps.panePid`), `cli/src/core/agentBrowserLink.ts:109-112`, `cli/src/core/main.ts` (`panePid`, from
  `terminals.backendFor(runtime)?.paneInfo(runtime)` as at `:1268`)
- Test: `cli/src/services/agentBrowser.spec.ts`, `cli/src/services/agentBrowserProcess.spec.ts`,
  `cli/src/services/agentBrowser/settings.spec.ts`, `cli/src/core/api.spec.ts:270,283`,
  `cli/src/core/agentBrowserLink.spec.ts:123`

**Depends on:** Tasks 5, 7, 12; Task 23 (`core/main.ts` as it leaves it).

**Interfaces:**
- Consumes: `ToolServers`, `runLimitMs` (Task 7); `browserTools()` for the tools' names (Task 5).
- Produces:

```ts
// CoreApi.agents: the live agent of the pane, and whether it is a guest's. With `ancestors`, null unless the
// pane's own process, read from the daemon's terminal backend, is among them.
ofPane?(pane: string, ancestors?: number[]): Promise<{ agentId: string; guest: boolean } | null>
// CoreApiDeps
panePid?: (session: RegisteredSession) => Promise<number | null>
// agentBrowserLink `agent_of_pane {pane, ancestors?}` answers {agentId, guest} or {agentId: null}.
/** The size the window takes: whole numbers, at least 1024x640, at most `screen` ("1920x1080"); null for anything
 *  that is not two positive numbers. Exported from services/agentBrowser/settings.ts. */
export function clampWindow(width: unknown, height: unknown, screen: string): { width: number; height: number } | null
```

Rules:
- One `ToolServers`, whose `spawn` is `podman.spawn(containers.execArgs(agentId, ['node',
  '/opt/harness-browser/browser-tools.mjs']))`. `changed`: a browser that is not `ready` gets
  `toolServers.end(agentId, 'ENDED')`. The port's `stop()` calls `endAll()`.
- The person's Stop (Task 12's handler) first takes `said = toolServers.end(agentId, 'STOPPED') > 0` and passes it
  to `notices.stopped`. While the agent is in `byPerson` (Task 12), a command that arrives answers `STOPPED`.
- `agent_browser_run`, in this order and without `begin()` (a command never wakes Podman): not local:
  `LOCAL_ONLY`; `ofPane(pane, ancestors)` null, or no `ancestors`: `NO_AGENT`; `guest`: `NOT_ALLOWED`;
  `browser_<command>` not a tool, or `args` not an object: `INVALID_REQUEST`; in `byPerson`: `STOPPED`; no browser:
  `OFF`; not ready: `NOT_READY` with the state; then `toolServers.call(…, humanMode(settings), closed)`. `ENDED`
  answers `NOT_READY` with the state now (`starting` when it still reads ready); the other failures answer by
  their names. Counts `agent_browser_command_ok` for a reply that is not an error, `agent_browser_command_failed`
  for anything else after the checks. Logs `agent browser <agentId>: <command> <outcome>` and nothing more.
- `agent_browser_window`: `NOT_OWNER`; no browser: `NO_BROWSER`; not ready: `NOT_READY`; `clampWindow(width,
  height, settings.screen)` null: `INVALID_REQUEST`; then `toolServers.window`: its size is the answer;
  `WINDOW_FAILED` is logged as `window_failed`. Nothing is stored. On Windows: `NOT_ON_WINDOWS`, as `_run`.
- `agent_browser_state` reads `(await ofPane(pane))?.agentId`.

- [ ] **Step 1: Red.** Cases in `agentBrowser.spec.ts` (fake `podman` whose `exec` child the spec drives):
  - `run is refused to a remote asker`; `the pane gives the agent`; `a guest's agent is NOT_ALLOWED`; `an agent in
    a regular tab is allowed`; `it answers with the backend and the Swarm unreachable` (the fake core's `backend`
    and `superTabs` throw if touched).
  - `off, starting, setting up and each failed state answer by name, and start nothing`.
  - `the first command starts the tool server once; it starts again after it exits; a state that leaves ready
    ends it`.
  - `the person's Stop answers the running command and every waiting one STOPPED, and then types no stop line`;
    `a Stop with no command running types the stop line`.
  - `a settings change while a command runs answers NOT_READY starting, and the next after ready works`.
  - `a call past its limit is TOOL_TIMEOUT`; `the ninth waiting is BUSY`; `each call carries the human mode of the
    settings now`.
  - `a command counts ok or failed, and its log line holds its name and outcome and none of its arguments or the
    page's text` (assert on the captured log).
  - `the window is refused NOT_OWNER for a guest and a machine share, NO_BROWSER when off and NOT_READY while it
    starts`; `the size is clamped to 1024x640 and to the screen setting, and the clamped size is what is sent`;
    `a tool server that does not answer in 5 s is WINDOW_FAILED and logged window_failed`; `nothing is written to
    the state file`.
  - `on win32 run and window answer NOT_ON_WINDOWS`. `settings.spec.ts`: `clampWindow rounds, holds 1024x640 and
    the screen, and is null for anything but two positive numbers`.
  - Review Focus 1, in `api.spec.ts`: `ofPane with ancestors is null when the pane's process is not among them
    (another tmux server's pane of the same id), and the agent when it is; without ancestors it answers as before`.
  - `agentBrowserLink.spec.ts:123` and `agentBrowserProcess.spec.ts:83`: the answer's new shape and the
    `ancestors` passed on.
- [ ] **Step 2:** `npx vitest run src/services/agentBrowser.spec.ts src/services/agentBrowserProcess.spec.ts
  src/services/agentBrowser/settings.spec.ts src/core/api.spec.ts src/core/agentBrowserLink.spec.ts`: FAIL. Commit
  `test: an agent's commands reach its own browser, and the window follows the panel`.
- [ ] **Step 3: Green.** Implement.
- [ ] **Step 4:** Same command, `src/backendSocket.agentBrowser.spec.ts` and `npm run typecheck`: PASS. Commit
  `feat: agent_browser_run and agent_browser_window on a daemon-held tool server`.

### Task 16: Browser on every agent; Start and Stop in the panel

**Files:**
- Modify: `desktop/lib/browser/browser_panel.dart`, `desktop/lib/super_tabs/view.dart:2823-2843,2967-2985,4937-4953`,
  `desktop/design/desktop-design-system.md` (the agent chat's header at `:457-460`; the Browser panel entry at
  `:564-584`)
- Create: `desktop/test/browser/browser_from_chat_test.dart`
- Test: `desktop/test/browser/browser_panel_test.dart`, `desktop/test/browser/browser_button_test.dart`,
  `desktop/test/swarm_v4_journey_test.dart:236-291`, `desktop/test/swarm_elements_gallery_test.dart:897-927`,
  `desktop/test/goldens/swarm-elements/browser-bar-light.png`, `browser-bar-dark.png`

**Depends on:** Tasks 11 and 14.

**Interfaces:**
- Consumes: `agentBrowserStart`, `agentBrowserStop` (Task 14).
- Produces: `BrowserButton({required bool open, bool running = false, required VoidCallback onPressed})`.

Decisions the spec leaves:
- **The button** shows for an agent whose machine is the person's own (not `isShared`, not `isSharedMachine`) and
  lists the agent as running, never on the web build or on Windows Desktop. `view.dart`'s `_browserAgent` becomes
  `bool _offersBrowser(SuperTabAgent agent)`; the panel is built whenever it is true.
- **The running mark** is a 6-point dot in `AppPalette.online` (the connection dot's colour) at the glyph's top
  right, drawn while the frame's `browser.state` is `ready`. Tooltip `Browser`; semantics label `Browser, running`.
- **Stop** is a compact quiet `DesktopPill` labelled `Stop`, key `swarm-browser-stop`, before the gear, drawn
  whenever the frame has `browser`. No confirmation.
- **Off** (the frame has no `browser`): `A sandboxed Chrome the agent drives` and a blue `Start`
  (key `swarm-browser-start`). The gear works; Paste is off.
- **Refusals** under the line, 12 grey: `UNSUPPORTED`: `Update Harness on <machine> first`; `NOT_ON_WINDOWS`:
  `Browser doesn't run on Windows yet`; `NOT_OWNER`: `Only its owner can open this browser`; any other: today's
  `Browser isn't available on <machine> right now`.

- [ ] **Step 1: Red.** `browser_from_chat_test.dart`, a full `SuperTabView` with the fixture of
  `browser_button_test.dart` and an app that records `agentBrowserStart` and `agentBrowserStop`, each case clicking
  as a person does:
  - `an agent with no browser: Browser is there; pressing it shows off; Start sends the request; the frame turns
    starting, then ready and the screen shows; the button shows running; Stop sends the request; the frame loses
    its browser and the panel shows off`.
  - `started from the person's other Desktop: the frame turns ready, the panel stays closed, the button shows
    running; pressing it shows the screen`.
  - `needs setup: Start, then Install on this computer opens Set up Browser; from another computer the line says
    where`.
  - `an older CLI: Start shows Update Harness on Mac Studio first`; `a Windows machine: Browser doesn't run on
    Windows yet`; `a guest: Only its owner can open this browser`.
  - `Stop turns a failed browser off`; `closing the panel sends no request`.
  `browser_button_test.dart`: `every running agent on the person's own machines shows Browser, with or without a
  browser; a shared machine, the web build and Windows show none` (the `browserOffered` case that left
  `new_harness_form_test.dart` moves here); `the button's label is Browser, running while it is ready`.
  `browser_panel_test.dart`: `off shows the line and Start, and the gear opens the settings`; `Stop is in the
  header in every state but off`. Update the journey test to start from the button. Gallery: the `browser-bar`
  section draws the button plain, open and running, and the panel off, running (a fake `BrowserView`) and failed.
- [ ] **Step 2:** `flutter test --no-pub test/browser/browser_from_chat_test.dart test/browser/browser_button_test.dart
  test/browser/browser_panel_test.dart`: FAIL. Commit `test: a person starts and stops an agent's browser from its
  chat`.
- [ ] **Step 3: Green.** Implement; rewrite the two design doc entries (the mark named, Start and Stop, the off
  state, the refusals; "the gallery draws the button plain and running, and the panel off, running and failed");
  regenerate the two goldens with `flutter test --no-pub --update-goldens test/swarm_elements_gallery_test.dart`
  and look at them.
- [ ] **Step 4:** The Desktop command under Wave 3 verify: PASS. Commit `feat: Browser on every agent's chat, with
  Start and Stop`.

### Task 24: A browser is named by its profile, and its entry can move

**(Ken, 2026-11-11, decision 19.)** Today a browser's container, network and volume are `harness-browser-<agentId>`
and its secret `harness-proxy-<agentId>`: a login cannot follow its pane to another id without a rename on disk.
This task names them by a profile id kept in the settings entry, and gives the service the move itself. Nothing
calls the move until Task 26, and until then every profile is its agent's id: no name changes.

**Files:**
- Modify: `cli/src/services/agentBrowser/stateFile.ts:12` (`browsers`' entry type; the header),
  `cli/src/services/agentBrowser/browsers.ts` (`profile`, `move`; `settings`, `saveSettings`, `launch`, `stop`,
  `remove`; the file's header), `cli/src/services/agentBrowser/containers.ts` (`start`, `stop`, `remove`, `ready`,
  `execArgs`, `create`, `sweep`; the header)
- Test: `cli/src/services/agentBrowser/stateFile.spec.ts`, `cli/src/services/agentBrowser/browsers.spec.ts`,
  `cli/src/services/agentBrowser/containers.spec.ts`
- Not changed: `cli/src/services/agentBrowser.ts`, `agentBrowserProcess.ts` and `agentBrowser/settings.ts` (Task 15's,
  in this wave: `BrowserSettings` gains no field, so `parseSettings`, `publicSettings` and `settingsHash` never see
  `profile`); `agentBrowser/fakePodman.ts`; `agentBrowser/notices.ts`; `agentBrowser/events.ts` (an exit is told by
  the `harness.agent` label, which stays the agent's id).

**Depends on:** Task 12 (`browsers.ts` as it leaves it). Nothing in wave 3.

**Interfaces, produces:**

```ts
// stateFile.ts. `profile`: the id the browser's container, network, volume and proxy secret are named by. Absent,
// it is the agent's own id: every browser that never moved, and every one made before this field.
export type SavedBrowser = BrowserSettings & { profile?: string }
export interface BrowserStateData { browsers: Record<string, SavedBrowser>; … }

// browsers.ts
/** The id [agentId]'s browser is named by: its entry's `profile`, else its own id. Null for an agent with no entry
 *  whose id another entry holds as its profile: its browser went with its pane, and nothing of that name is its. */
profile(agentId: string): string | null
/** [from]'s entry, its profile with it, becomes [to]'s (decision 19): [from]'s browser is stopped first, in both
 *  agents' queues. False, changing nothing, when [from] has no entry or is being deleted, or [to] has an entry of
 *  its own. Rejects when the state file cannot be written: both entries are as they were. */
move(from: string, to: string): Promise<boolean>

// containers.ts: named by the profile, labelled with the agent.
start(agentId: string, profile: string, image: string, settings: BrowserSettings, timeZone: string, secretId: string)
stop(profile: string) · remove(profile: string) · ready(profile: string) · execArgs(profile: string, cmd: string[])
// By the agent's label, as today: running(), exitCode(agentId), sweep(listedAgentIds).
```

Rules:
- **Names.** `harness-browser-<profile>` for the container, its network and its volume, `harness-proxy-<profile>`
  for the secret; the labels stay `harness.agent=<agentId>` and `harness.daemon`. The spec names the volume and
  the container; the network and the secret share their name function today and go with them (Where the spec
  needed a call, 26).
- **`profile(agentId)`** reads the state file, as `settings()` does. `Browsers` resolves it once for each start,
  stop and remove (once per `launch`, not once per ready try) and hands it to `Containers`. A null profile has
  nothing to stop or remove: no Podman call is made.
- **An entry made new** (`launch`'s `??=`, a save while off) for an agent whose id another entry holds as its
  profile gets `profile: randomUUID()`. Any other new entry has no `profile`: the file of a browser that never
  moved is byte for byte what an older CLI writes, which is the spec's rollback line.
- **`profile` is the service's, never the person's.** `settings()` returns the entry without it (as it does the
  proxy's `secretId`), so the apps, `settingsHash` and the container's label never see it; `saveSettings` keeps
  the entry's `profile` whatever is saved.
- **`move(from, to)`**, one piece of work in `from`'s queue and, inside it, in `to`'s: when `from` shows a state,
  it is forgotten, its viewers are closed and its container, network and secret are removed (a removal that fails
  is logged, as a stop's is, and the move goes on); then one `state.update`: `to` takes `from`'s entry with
  `profile: entry.profile ?? from`, `from`'s entry and its `told` mark go, `to` gets no `told` mark. A move that
  happened logs `agent browser <to>: took the browser of <from>` and nothing of the settings. The volume is never
  touched.
- **`remove(agentId)`** removes the volume of the agent's own profile and no other; with no entry it removes
  nothing in Podman and only takes the id off `deleting`.
- **`Containers.create`.** A create Podman refuses because the name is in use (`/already in use/i`: a container the
  previous agent's failed stop left, under that agent's label) removes the container of that name and creates
  again, once. The usual path gains no call.
- **`Containers.sweep`.** A stray is stopped by the name Podman lists for it (`Names[0]`), never by a name made
  from its label: after a move, `harness-browser-<an agent's id>` can be another agent's running browser.
- **Standard 4.** Nothing on a command's path or at rest: the state file is read where a container is started,
  stopped or removed, as today.

- [ ] **Step 1: Red.**
  - `stateFile.spec.ts`: `an entry's profile is read back as written, and an entry without one is read as before`.
  - `containers.spec.ts`: `a browser whose profile is not its agent's id is created, started, checked, exec'd into,
    stopped and removed under the profile's names, labelled with the agent` (the argv of each); `a create refused
    because the name is in use removes that container and creates again, once; a second refusal fails`; `sweep
    stops a stray by its own name, and never the container named after the stray's agent`. Every existing case
    passes with the profile equal to the agent's id.
  - `browsers.spec.ts` (its fake `Containers`, a real `StateFile`):
    - `a browser with no profile in its entry is named by its agent's id` (start, stop, delete: what `Containers`
      is handed);
    - `a move gives the new agent the entry and the profile, takes the previous agent's entry and told mark, and
      touches no volume`; `a moved entry moves again and keeps its first profile`;
    - `a move stops the previous agent's browser first when it runs, and makes no Podman call when it does not`;
      `a stop that fails is logged and the entry still moves`;
    - `a move with no entry, of an agent being deleted, or to an agent that has an entry, changes nothing and
      answers false`;
    - `a move that cannot write the state file rejects, and both entries are as they were`;
    - `a move waits for the work already queued for either agent` (a start of `to` asked first finishes first);
    - Review Focus 10: `the previous agent's next start gets a profile of its own: the moved volume is not
      mounted for it, and its stop and its delete remove nothing named by its id`;
    - `a delete removes the volume of the agent's own profile, and a delete of the new agent removes the moved
      one`; `a delete of an agent with no entry removes nothing in Podman`;
    - `settings never show the profile, and a save keeps it`; `a save while off for an agent whose id is another's
      profile makes its entry with a profile of its own`.
- [ ] **Step 2:** `npx vitest run src/services/agentBrowser/stateFile.spec.ts
  src/services/agentBrowser/containers.spec.ts src/services/agentBrowser/browsers.spec.ts`: FAIL. Commit `test: a
  browser is named by its profile, and its entry moves to another agent`.
- [ ] **Step 3: Green.** Implement the rules.
- [ ] **Step 4:** Same command with `--coverage` and a `--coverage.include=` for each of the three files: PASS at
  100%. Then `npx vitest run src/services/agentBrowser.spec.ts src/services/agentBrowserProcess.spec.ts` (Task 15's,
  as the wave's base has them: no name changed) and `npm run typecheck`: PASS. Commit `feat: a browser's container
  and volume are named by its profile; Browsers.move`.

### Task 25: A shell names the agent that ended in its pane

**(Ken, 2026-11-11, decision 19.)** The core cannot tell today whose pane a shell was: `releaseEngine` gives the
shell a new id and keeps nothing of the old one, and an evicted row's flag is gone with the row before the caller
reads `evicted`. A search of the saved agents by pane is not proof: pane ids restart with every tmux server. This
task keeps the two facts Task 26 needs, and lets a stopped record's flag be written.

**Files:**
- Modify: `cli/src/lib/registry.ts` (`RegisteredSession`, beside `browser` at `:194-198`; the load list at `:1439`;
  `openProcessAgent`'s `evicted` at `:1615` and `:1690`; `resumePendingAgent` at `:1848`; `reinstateArchived` at
  `:2301`; `adoptEngine` at `:2333`; `releaseEngine` at `:2379-2380`), `cli/src/lib/stoppedAgents.ts` (`save` at
  `:112`; `patch` at `:166` and its comment)
- Test: `cli/src/lib/registry.spec.ts`, `cli/src/lib/stoppedAgents.spec.ts`
- Not changed: `cli/src/lib/retainExitedSession.ts`, `cli/src/core/` (Task 26), `cli/src/lib/agentFrame.ts` (a frame
  is built from named fields: the new one is on none).

**Depends on:** Task 2. Nothing in wave 3.

**Interfaces, produces:**

```ts
// registry.ts, RegisteredSession. On the shell an exit left (`releaseEngine(id, true)`): the agent whose engine
// ended in this pane. The pane's next agent takes that agent's browser (decision 19). Gone once an engine is
// adopted here, and once that agent runs again under its own id.
previousAgentId?: string
// openProcessAgent's answer: the evicted row's Browser was on.
evicted: { agentId: string; sessionId: string; browser?: true } | null

// stoppedAgents.ts: one field of a saved record, in place. `browser: true` sets the flag, `browser: undefined`
// takes it out of the file.
patch(agentId: string, patch: Partial<Pick<RegisteredSession, 'cwd' | 'browser'>>): boolean
```

**Design** (one stored field more than the spec's Data line names; Where the spec needed a call, 23):
- growth: one id on a shell's row; it goes when an engine is adopted there, when the agent it names runs again,
  and with the row. Never in a saved record;
- concurrency: the registry's own writes, one turn each;
- read cost: read only where a terminal adopts an engine; nothing per scan;
- scale: N/A because it is one string on rows that already exist;
- compatibility: an older CLI rebuilds a row from named fields and drops it: after a rollback nothing moves;
- migration and rollback: none; the field is absent until an engine exits under the new CLI;
- audience: on no frame; identity: N/A because it names an agent of this machine, never a login; failure: a
  hand-edited value that is not an id is dropped at load; platforms: all.

Rules:
- **`releaseEngine(agentId, true)`**: the shell's `previousAgentId` is the released agent's id. Its `browser` is
  still taken off (`:2380`): the flag stays with the agent until a new agent takes the pane. A release in place
  (no second argument) names nobody: that row keeps its id and its flag.
- **`adoptEngine`** takes `previousAgentId` off: the row is an agent now. Task 26 reads it before it adopts.
- **`resumePendingAgent(saved, …)` and `reinstateArchived(…, saved, …)`**: every row that names `saved.agentId`
  loses the name. The agent runs again and its browser came back with it (decision 14): its old pane's next agent
  takes nothing (Review Focus 11). One pass over the live rows, at a resume only.
- **Load** keeps it only as an agent id (`parentAgentIdOf`) on a row whose engine is `terminal`, in the explicit
  list at `:1439`.
- **`openProcessAgent`**: `evicted.browser` is the evicted row's flag.
- **stoppedAgents.ts.** `save` never keeps `previousAgentId` (a stopped shell that is opened again is a new
  pane). `patch` takes `browser` beside `cwd`, with the same promise: no rename, no `touchedAt`.

- [ ] **Step 1: Red.**
  - `registry.spec.ts`:
    - `the shell an exit leaves names the agent that ended in its pane, through a save and a load; a release in
      place names nobody` (and the case at `:2065` still holds: the shell has no `browser`);
    - `the name goes when an engine is adopted in the shell`;
    - `the name goes when the agent it names runs again: a resume, and a return from the archive` (two shells
      naming it, both cleared; a shell naming another agent keeps its name);
    - `a hand-edited name that is not an id, or on a row that is not a terminal, is dropped at load`;
    - `a process that takes a bound agent's pane says whether the agent it evicted had its Browser on`.
  - `stoppedAgents.spec.ts`: `a saved record never keeps previousAgentId`; `patch sets and clears browser in
    place: the name and touchedAt stay, a cleared flag is absent from the file, and an id with no record answers
    false`.
- [ ] **Step 2:** `npx vitest run src/lib/registry.spec.ts src/lib/stoppedAgents.spec.ts`: FAIL. Commit `test: a
  shell names the agent that ended in its pane`.
- [ ] **Step 3: Green.** Implement the rules.
- [ ] **Step 4:** Same command, `npx vitest run src/core/agents/discovery.spec.ts src/lib/retainExitedSession.spec.ts`
  and `npm run typecheck`: PASS. Commit `feat: the shell an exit leaves keeps its agent's id; a stopped record's
  Browser flag can be written`.

---

## Wave 4

### Task 17: End to end on the real daemon, fake `podman`

**Files:**
- Modify: `cli/e2e/agentBrowser.e2e.ts`

**Depends on:** Tasks 13, 15 and 23.

The fake `podman` gains an `exec -i … browser-tools.mjs` that answers each `tools/call` line (a snapshot's text; a
screenshot's image of 1 MiB) and each `window` line. The command runs in the agent's pane through the fixture's
tmux (`send-keys`, its output and exit code written to a file in the fixture).

- [ ] **Step 1: Red.** Replace the first case with `a plain agent: the app starts its browser, the agent drives it,
  the person stops it, and a delete removes it`: create with no `browser`; `agent_browser_start`; the frame is
  `ready`; `harness browser snapshot` in the pane exits 0 with the fake's tree; `harness browser screenshot`
  prints a path whose file is the fake's 1 MiB JPEG, byte for byte (Review Focus 2); `agent_browser_window
  {width: 800, height: 500}` answers `{width: 1024, height: 640}`; `agent_browser_stop`; the frame has no
  `browser` and no `volume rm` was called; `harness browser snapshot` exits 4 with the off line; start again and
  see `ready`, with the backend unreachable and the agent in no Swarm; purge; the container, the volume, the
  network and the secret are removed. Add `an older Desktop's browser:true still gives a browser`. Keep the fault
  case. Add `a browser left on follows its agent` (decision 14; it passes on Task 23's code as written, and holds
  on the real daemon the paths no unit test sees whole): with the browser `ready`, `agent_restart` answers ok and
  the fake's log gains no `rm --force` of its container; `agent_delete` (Stop Harness) removes the container and
  never the volume, and the agent is listed stopped; `agent_resume` brings its frame back to `ready` with no
  `agent_browser_start`; after `d.restart()` (the daemon) its frame is `ready` again.
- [ ] **Step 2:** `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts` on Tasks 13
  and 15's code with the old fake: FAIL (the fake answers no `exec`). Commit `test: a browser started from the app
  and driven by harness browser, end to end`.
- [ ] **Step 3: Green.** Finish the fake `podman` and the pane helper. Product code changes only if the run finds a
  bug: then a red unit test in the owning spec first.
- [ ] **Step 4:** Same command: PASS. Commit `test: the fake podman answers the tool server's lines`.

### Task 18: Real Podman drives through `harness browser`

**Files:**
- Modify: `cli/e2e/agentBrowserPodman.e2e.ts`

**Depends on:** Tasks 9, 13, 15. Not run by the wave: it builds the image. It is typechecked here and run once by
hand at the end; a subagent with Podman on its Mac may run it (`npx vitest run --config vitest.e2e.config.ts
e2e/agentBrowserPodman.e2e.ts`), and says so in its report either way.

- [ ] **Step 1:** The driver changes from the `browser-mcp` relay to `harness browser` run in the agent's pane.
  Cases, as the spec's Testing lists them:
  - changed: the first case creates a plain agent and starts its browser with `agent_browser_start`; the tools
    case and the challenge case read the CLI's output; the screenshot case reads the file;
  - "a stop keeps the login" becomes two: the person's Stop then Start, and the agent's stop then resume;
  - new: `a command while off exits 4`; `harness browser start and stop exit 2`; `the person's Stop during a wait
    ends that command with the stop line`; `the tool server calls initialize an unknown method`; `a window request
    changes window.innerWidth and leaves screen.width as the Device setting` (read through `harness browser` on a
    page that prints both);
  - unchanged but for how tools are called: the stream, the host that cannot be reached, the crash restart,
    Device, the proxy, the delete.
- [ ] **Step 2:** `npm run typecheck`: PASS. Commit `test: the agent browser on real Podman, driven by harness
  browser`.

### Task 19: The panel sizes Chrome's window

**Files:**
- Modify: `desktop/lib/browser/browser_bridge.dart`, `desktop/lib/browser/browser_panel.dart`,
  `desktop/design/desktop-design-system.md` (the Browser panel entry: the screen shows Chrome's window at 1:1, the
  window follows the panel, and it is scaled only when it cannot fit)
- Create: `desktop/test/browser/browser_window_test.dart`
- Test: `desktop/test/browser/browser_bridge_test.dart`

**Depends on:** Tasks 10, 14, 16.

**Interfaces:**
- Consumes: `agentBrowserWindow` (Task 14); the page's `{t: 'window', width, height}` (Task 10).
- Produces: `void BrowserBridge.window(int width, int height)`, which posts that message.

Rules: the size is the panel's screen area in logical pixels, rounded. One request when the stream opens on a
ready browser, and one 300 ms after the size last changed (`BrowserPanel.windowSettle`); a size equal to the last
one sent sends nothing; closing the panel sends nothing. An answer is posted to the page; null posts nothing, so
the page keeps what it shows, and the next settled resize asks again.

- [ ] **Step 1: Red.** `browser_window_test.dart`, the panel beside the chat in a `SuperTabView`:
  `opening the panel on a ready browser sends one window request with the panel's size, and the page is told the
  size the machine set`; `resizing in steps sends one request, 300 ms after the last step` (the window's surface
  is resized with `tester.binding.setSurfaceSize`, time moved with `tester.pump`); `closing the panel sends none`;
  `a machine that cannot size it (null) leaves the page scaling, and the next resize asks again`; `no request
  while the browser starts or is off`. `browser_bridge_test.dart`: `window posts the size to the page`.
- [ ] **Step 2:** `flutter test --no-pub test/browser/browser_window_test.dart test/browser/browser_bridge_test.dart`:
  FAIL. Commit `test: the browser's window follows the panel`.
- [ ] **Step 3: Green.** Implement; change the design doc entry.
- [ ] **Step 4:** The Desktop command under Wave 4 verify: PASS. Commit `feat: Chrome's window takes the panel's
  size`.

### Task 22: A quiet delivery marks the turn it starts; the browser's two lines are quiet

**(Ken, 2026-11-11, option b.)** The mark rides the delivery path every deliverer already uses: said with the
delivery, kept by its id, and, when the input says that delivery's turn `started`, carried by the core to that
turn's end, where Task 21 reads it. Nothing here names the browser but the one option in `notices.ts`.

**Files:**
- Modify: `cli/src/core/api.ts` (`DeliveryOptions` at `:591-595`, `TurnLifecycle`'s `events` at `:1021`, and their
  comments), `cli/src/core/deliveries.ts` (`DeliveriesDeps`, `settled` at `:97`, `deliver`, `answer` at `:174`),
  `cli/src/services/turnsLink.ts:67`, `cli/src/core/turns/recaps.ts` (`RecapDeps`, `mirror.ingest` at `:111`,
  `cancel`, `forget`, `deleteHistory`, the returned `quietTurn`), `cli/src/core/main.ts` (`createDeliveries` at
  `:827`, `createRecaps` at `:1497`), `cli/src/services/recaps.ts:124`,
  `cli/src/services/agentBrowser/notices.ts` (`Turns.deliver`, and `:122`)
- Test: `cli/src/core/deliveries.spec.ts`, `cli/src/services/turnsLink.spec.ts:28`,
  `cli/src/core/turns/recaps.spec.ts`, `cli/src/services/recaps.spec.ts`,
  `cli/src/services/agentBrowser/notices.spec.ts`
- Not changed: `cli/src/core/recapsLink.ts` and `cli/src/services/recapsProcess.ts` (the lifecycle event crosses
  whole), `cli/src/core/turns/funnel.ts`, `cli/src/core/turns/ends.ts`, `cli/src/lib/sessionInput.ts`,
  `cli/src/superTabs/`, Desktop, the phone.

**Depends on:** Tasks 8 and 21; Tasks 12 and 15 (`api.ts` and `main.ts` as they leave them; Task 12 hands the
service's own process the turns of `turnsLink`).

**Interfaces, produces:**

```ts
// api.ts. `quiet` marks a line a service types for the agent alone: the turn it starts is nobody's news, and
// ends with no recap and no notification. `turns.onEnd` still tells that end.
export interface DeliveryOptions { answersQuestion?: true; writtenAt?: number; personsOwn?: true; quiet?: true }
// TurnLifecycle: the turn that ends in this batch was started by a quiet delivery.
| { kind: 'events'; session: RecapSession; events: LiveEvent[]; replay: boolean; quiet?: true }

// deliveries.ts, DeliveriesDeps: the turn a quiet delivery started is open in [agentId], said once, as the input
// says that delivery `started`.
quietStarted?: (agentId: string) => void

// core/turns/recaps.ts. RecapDeps: whether the funnel has a turn open in the session (`turnStartedAt`, as
// main.ts:866 reads it).
turnRunning: (sessionId: string) => boolean
// Returned beside `mirror`: the turn open in [agentId] was started by a quiet delivery.
quietTurn(agentId: string): void

// services/agentBrowser/notices.ts
export interface Turns {
  deliver(agentId: string, text: string, deliveryId: string, options?: { quiet?: true }): void
  …
}
```

Rules:
- **deliveries.ts.** A quiet delivery's id is kept from `turns.deliver` (the core's process) and from `answer`'s
  `deliver` (`payload.quiet === true`, a service's own process), as `personsOwn` is, the oldest going past
  `KEPT_DELIVERERS`. Heard `started`: the id is taken off and `quietStarted(event.sessionId)` is said, once. Heard
  `rejected` or `unknown`: taken off, nothing said (a turn nobody can tie to the line tells as any turn). `queued`
  and `delivered` keep it. A delivery not marked costs `settled` one lookup in an empty Set.
- **turnsLink.ts** sends `quiet: true` with the query, beside `answersQuestion` and `personsOwn`. A core older than
  the service ignores it: that turn tells as before, and nothing fails.
- **core/turns/recaps.ts.** `quietTurn(agentId)`: the agent's session (`resolve`); none, or no turn running there
  (`turnRunning`): one line `[recap] quiet · no open turn`, nothing kept (the end was already told; it cannot be
  taken back). Else the session is kept in a Set. `mirror.ingest`: a batch that is not a replay and holds a
  `turn_ended` takes the session off and says `quiet: true` with that batch; no other batch looks. `cancel`,
  `forget` and `deleteHistory` take it off. So the Set holds at most the sessions with a turn open.
- **Why at the end, by batch.** The input says `started` inside the funnel (`funnel.ts:156`), before the recaps
  hear that batch, for an exact echo; and a moment later, after reading the engine's own record (`echoes`), for a
  prompt the engine wrapped. A mark said with the end is right in both orders. A typed delivery waits for an idle
  pane (`core/input.ts:67-69`), so the turn before it ended in an earlier batch, and `turnStartedAt` is set
  (`funnel.ts:151`) before the input is told.
- **main.ts.** `quietStarted` calls the recaps' `quietTurn` through a reference filled when the recaps are built,
  as `holdOfRef` is; `turnRunning: (sessionId) => turnStartedAt.has(sessionId)`.
- **services/recaps.ts:124** hands `quiet: event.quiet` to `mirror.ingest` (Task 21).
- **notices.ts.** Both lines are delivered with `{quiet: true}`, each try.
- **Compatibility.** No frame changes shape for a turn that is not quiet. For a quiet one the apps get a
  `turn_summary` with a `tier` and no `summary`: every Desktop reads only `notification` there (2026-09-28, #444),
  so a Desktop from the last 30 days does not alert either. The phone reads only `tier` there, and `silent` files
  nothing (a Swarm agent's turns are already `silent` on it, `notifyTier.ts:55`); a phone too old to read tiers
  tells that end as it tells any. An older CLI types no line at all (Start is `UNSUPPORTED`).
- **Standard 4.** No timer, no file, no wait, nothing while idle. Per event batch: the `turn_ended` test `ingest`
  already makes, then one Set removal on a batch that ends a turn. Per delivery event: one Set lookup.

- [ ] **Step 1: Red.**
  - `deliveries.spec.ts`: `says once that a quiet delivery's turn started, delivered from the core's process and
    from a service's own, and never for a delivery that is not quiet`; `forgets a quiet delivery that is rejected
    or past knowing, and keeps one that is queued or only written`; `keeps the last quiet deliveries only`;
    `says nothing where nobody listens for it` (no `quietStarted`).
  - `turnsLink.spec.ts:28`: `sends answersQuestion, personsOwn and quiet with the delivery`.
  - `core/turns/recaps.spec.ts`: `says a turn's end is quiet when a quiet delivery started it, once: the batches
    before the end, and the next turn's end, do not say it`; Review Focus 6: `the mark holds whether it comes
    before the recaps hear the turn start or after`; `a mark for an agent with no session, or with no turn
    running, is dropped and logged`; `a replayed end leaves the mark; a cancel, a forget and a purge take it off`.
  - `services/recaps.spec.ts`, through `port.lifecycle`: `a turn the core says is quiet gets no recap and no
    notification, and the session's last recap stays` (the apps' frame is the silent tier alone).
  - `notices.spec.ts`: `the ready line and the stop line are delivered quiet, each try`.
- [ ] **Step 2:** `npx vitest run src/core/deliveries.spec.ts src/services/turnsLink.spec.ts
  src/core/turns/recaps.spec.ts src/services/recaps.spec.ts src/services/agentBrowser/notices.spec.ts`: FAIL.
  Commit `test: a quiet delivery's turn is told to the recaps as quiet`.
- [ ] **Step 3: Green.** Implement the rules.
- [ ] **Step 4:** Same command with `--coverage` and a `--coverage.include=` for each of `src/core/deliveries.ts`,
  `src/core/turns/recaps.ts`, `src/services/recaps.ts`, `src/services/turnsLink.ts` and
  `src/services/agentBrowser/notices.ts`: PASS at 100%. Then `npx vitest run src/services/agentBrowser.spec.ts
  src/services/agentBrowserProcess.spec.ts src/core/recapsLink.spec.ts src/services/recapsProcess.spec.ts
  src/lib/commanderNotifications.spec.ts` and `npm run typecheck`: PASS.
- [ ] **Step 5: Numbers (standard 4),** in the task's report, for the pull request. A throwaway script run with
  `npx tsx`, not committed: 200,000 `mirror.ingest` calls of one `text_delta` batch through the core's
  `createRecaps` with a port that drops, and 200,000 `settled` calls of a `delivered` event with one listener;
  three runs each on the task's base commit and on its head, the medians side by side. Not slower beyond the
  spread of the three runs.
- [ ] **Step 6:** Commit `feat: quiet deliveries; the browser's ready and stop lines raise no recap and no
  notification`.

---

## Wave 5

### Task 26: The browser moves with its pane

**(Ken, 2026-11-11, decision 19; the spec's "The browser moves with its pane".)** The person quits the engine and
types it again in the same pane: the pane's agent has a new id, and today its Browser is off and its logins stay
with a stopped agent. From here the browser goes with the pane: the core sees the new row take the pane and tells
the browser's port both ids; the service moves the entry and the profile (Task 24) in its queue and then asks the
core to move the flag; the core attaches the new agent, which starts the browser and is typed the ready line.

**Files** (line numbers as of wave 2's head; Tasks 15 and 22 move them):
- Modify: `cli/src/core/api.ts` (`AgentBrowserPort` at `:1079-1093`, `AGENT_BROWSER_FALLBACKS`;
  `CoreApi.agents.moveBrowser` beside `setBrowser` at `:231`; `CoreApiDeps.moveBrowser` at `:2047`),
  `cli/src/core/agents/lifecycle.ts` (`createAgentBrowserLifecycle`: `taken`, `move`, a third argument; its comment),
  `cli/src/core/agents/discovery.ts` (`DiscoveryDeps`; `onDiscovered` after the forget at `:115-128`; `onObserved` at
  the adopt, `:166-169`; the header), `cli/src/core/agentBrowserLink.ts` (the port's `moved`; `move_browser`; the
  header), `cli/src/core/main.ts` (`:847`, `:1037`, `:1993`), `cli/src/services/agentBrowser.ts` (the port's `moved`;
  `unsupported`; every `containers.execArgs` caller; the header), `cli/src/services/agentBrowserProcess.ts` (the
  `moved` event; `moveBrowser`; the header), `cli/e2e/agentBrowser.e2e.ts`
- Test: `cli/src/core/agents/discovery.spec.ts` (`:114-123` and `:255-263`, Task 23's two pins of call 21, become
  this task's red tests), `cli/src/core/agents/lifecycle.spec.ts`, `cli/src/core/api.spec.ts`,
  `cli/src/core/agentBrowserLink.spec.ts`, `cli/src/services/agentBrowser.spec.ts`,
  `cli/src/services/agentBrowserProcess.spec.ts`
- Not changed: `cli/src/lib/registry.ts`, `cli/src/lib/stoppedAgents.ts` (Task 25), `cli/src/services/agentBrowser/`
  (Task 24), `cli/src/core/agents/forget.ts`, `cli/src/lib/retainExitedSession.ts`, `cli/src/superTabs/`, Desktop (the
  button is already on every running agent: Task 16), the backend (no counter, no frame).

**Depends on:** Tasks 24 and 25; Tasks 15 and 22 (`api.ts`, `main.ts`, `agentBrowserLink.ts`, `agentBrowser.ts` and
`agentBrowserProcess.ts` as they leave them); Task 17 (the e2e file and its fake `podman`); Task 23.

**Interfaces, produces:**

```ts
// core/api.ts, AgentBrowserPort. The pane [from] ended in has a new agent, [to] (decision 19): [from]'s settings
// and profile go to [to], and then the service asks `agents.moveBrowser`. [on]: [from]'s Browser was on.
moved(from: string, to: RegisteredSession, on: boolean): void
// CoreApi.agents. The agent browser moved [from]'s entry to [to], and [from]'s Browser was on: [from]'s flag is
// cleared and [to]'s is set, each where its row is, live or stopped; a live [to] is attached in the same turn.
moveBrowser?(from: string, to: string): Promise<BrowserSwitch>
// CoreApiDeps
moveBrowser?: (from: string, to: string) => BrowserSwitch

// lifecycle.ts, beside `attached`, `ended`, `observed` and `set`
taken(from: string, to: RegisteredSession, on: boolean): void   // discovery's word: tells the port
move(from: string, to: string): BrowserSwitch                   // the service's ask, for a flag that was on
// createAgentBrowserLifecycle's third argument: where a stopped agent's flag is written (Task 25).
stopped: Pick<StoppedAgentStore, 'get' | 'patch'>

// discovery.ts, DiscoveryDeps (required: the compiler holds main.ts to it)
moveBrowser: (from: string, to: RegisteredSession, on: boolean) => void
stoppedAgents: Pick<StoppedAgentStore, 'finishResume' | 'get' | 'list' | 'remove' | 'resumeReservedAt'>

// agentBrowserLink: `service_event {kind: 'moved', from, session, on}`; the query `move_browser {from, to}`,
// answered as `set_browser` is.
```

Rules:
- **discovery.ts, the shell an exit left** (`onObserved`). `current.previousAgentId` is read before `adoptEngine`
  (Task 25 takes it off there). After an adopt with a name: the named agent's saved record (`stoppedAgents.get`),
  unless a resume of it is under way (`resumeReservedAt`). A record: `moveBrowser(previous, adopted, record.browser
  === true)`. No record (purged since), a resume under way, or a store that cannot be read (one warning, as
  `archivedOwner`'s): nothing moves. Any engine typed there takes it, not only the one that left.
- **discovery.ts, a scan before the hook** (`onDiscovered`). `opened.evicted` with `opened.isNew`: after the
  `forgetSession` that is there today, `moveBrowser(evicted.agentId, opened.entry, evicted.browser === true)`.
  After, so the evicted browser's stop is ahead of the move in the service's queue.
- **Not a takeover:** an agent back from the archive (`reinstateArchived`: its own id, Task 23); a terminal that
  kept its id; a plain terminal nobody ended in; fork, Change agent, an adopted outside conversation, a guest's
  create, `--resume` in a second pane. None of them reaches either line above.
- **lifecycle.ts `taken`.** Nothing for a guest's `to`, or a `to` whose Browser is on already (it keeps its own:
  Where the spec needed a call, 25). Else `browser()?.moved(from, to, on)`. No flag changes here.
- **lifecycle.ts `move`.** `to` is looked up first, live then stopped; in neither: `{error: 'NOT_RUNNING'}` and
  `from` keeps its flag. Then `from`'s flag is cleared where its row is (live: `rows.setBrowser(from, false)` and
  `ended(from)`; stopped: `stopped.patch`; an evicted row is nowhere, and that is done), and `to`'s is set: live,
  `attached(rows.setBrowser(to, true)!)`; stopped, `stopped.patch(to, {browser: true})`, so its resume brings the
  browser. `{ok: true, changed: true}`.
- **agentBrowserLink.ts.** The port's `moved`: `forget(from)`, then the event, held until the process hears it
  (`untilDelivered`, as a stop); the process is asked for only when `on`, as an attach asks. `move_browser`:
  `INVALID_REQUEST` unless two ids; `UNSUPPORTED` without `core.agents.moveBrowser`.
- **agentBrowserProcess.ts.** `moved` reaches `port.moved` when `from` is an id, `session` is a session and `on`
  a boolean, before the `agentId` check the other events share. `moveBrowser` asks `move_browser` within
  `SWITCH_TIMEOUT_MS` and reads the answer with `switchOf`.
- **agentBrowser.ts, the port's `moved(from, to, on)`.** `notices.ended(from)` and `attached.delete(from)` at once;
  then, not awaited: `browsers.move(from, to.agentId)` (Task 24: stop, then the entry, in both queues). False, or
  true with `on` false (no flag to move): done. True with `on`: `core.agents.moveBrowser(from, to.agentId)`. A
  rejected move, a core that answers an error, and a core that does not answer each log
  `agent browser <to>: browser_move_failed (<why>)` once, `why` being `state_unwritable`, the core's error name or
  `no_answer`: never a path or a setting. Nothing is started here: the core's `attached` starts the browser, and
  the ready line follows from `changed`, since `to` has no `told` mark. A move never calls `begin()`: with no
  state file there is no entry, and it ends at one read.
- **agentBrowser.ts, names.** The stream's exec (`streamCommand`) and the tool server's spawn (Task 15) name the
  container by `browsers.profile(agentId)`. On Windows `moved` does nothing.
- **Counters.** None: a move is not a Start. `agent_browser_enabled` is not counted for `to` (it is listed by the
  time it is attached), and `agent_browser_started` is the request's alone.
- **Standard 4.** A scan of a running agent gains nothing: both lines run only where a terminal adopts an engine
  or a new row evicts one. No timer, no poll, nothing at rest.

- [ ] **Step 1: Red.**
  - `discovery.spec.ts`, the two pins rewritten (their comment "kept by the agent's id" goes):
    - `an engine typed into the shell an exit left takes the browser of the agent that ended there: the browser's
      move is told the previous agent, the adopted row, and the flag its record kept` (twice: the record's flag
      on, and off);
    - `a process that takes a bound agent's pane takes its browser: the move is told after the evicted agent is
      forgotten, with the flag the evicted row had`;
    - `nothing moves for a shell that names nobody, for a previous agent with no saved record, while its resume
      is under way, or when the saved agents cannot be read` (Review Focus 11 at this layer: Task 25 drops the
      name at a resume);
    - `an agent back from the archive, and a row re-observed in place, move nothing`.
  - `lifecycle.spec.ts`, in "the agent browser, as its agent starts and ends":
    - `a pane's new agent is told to the browser with both ids, and no flag changes until the service asks`;
    - `a guest's new agent, and one whose Browser is on already, are told nothing`;
    - `the service's ask clears the stopped agent's flag in its record, sets the new agent's and attaches it, in
      one turn`; `a previous agent that runs again loses its flag and its browser is stopped`; `an evicted
      agent, in no list, is done`;
    - `a new agent that stopped meanwhile gets the flag in its record and nothing is attached`; `one that is
      nowhere answers NOT_RUNNING and the previous agent keeps its flag`.
  - `api.spec.ts`: `moveBrowser answers what the lifecycle said, and is absent without it`.
  - `agentBrowserLink.spec.ts`: `a move is said to the process with both ids and the flag, held until it hears,
    and asks for the process only when the flag is on`; `the previous agent's state, command and viewers go at
    once`; `move_browser asks the core and answers what it said; anything but two ids is INVALID_REQUEST`.
  - `agentBrowserProcess.spec.ts`: `a move the core says reaches the port`; `a move without a session or a flag
    is dropped`; `asks the core to move the flag and answers what it said; a core that does not answer rejects`.
  - `agentBrowser.spec.ts` (fake `podman`, a fake core whose `moveBrowser` calls the port as the core does):
    - `the browser moves with its pane: the previous agent's container is removed, the entry and its profile are
      the new agent's, the core is asked to move the flag, the container is created again under the new agent's
      label on the same volume, and the new agent is typed the ready line once`;
    - `a move with the flag off moves the entry, asks the core nothing and starts nothing; the new agent's Start
      then mounts the same volume`;
    - `the stream and the tool server of a moved browser exec into its profile's container`;
    - Review Focus 12: `a state file that cannot be written leaves both agents as they were, asks the core
      nothing, types nothing, and logs browser_move_failed`; `a core that refuses or does not answer is logged
      browser_move_failed, and nothing is started`;
    - `a move of an agent with no entry asks the core nothing and makes no Podman call`; `a move counts
      nothing`; `a line owed to the previous agent is taken back`;
    - `a delete of the previous agent after the move removes no volume, and a delete of the new agent removes
      the moved one` (through the port's `deleted`);
    - `on win32 a move does nothing and no process starts`.
  - `e2e/agentBrowser.e2e.ts`, a new case, `the browser moves with its pane`: a plain agent, `agent_browser_start`,
    `ready`; `!exit` typed into its pane (as `paneLifecycle.e2e.ts` does) and the `agent_deleted` that names the
    shell as `successor`; the fixture's `claude` typed into that pane; the successor's frame turns `ready` with no
    `agent_browser_start`; the fake's log has a `create` named `harness-browser-<the first id>` labelled
    `harness.agent=<successor>` and no `volume rm`; the state file lists the successor with `profile: <the first
    id>` and not the first agent; `harness browser snapshot` in the pane exits 0; the pane shows the ready line;
    the first agent is listed stopped, and after `agent_resume` its frame has no `browser`.
- [ ] **Step 2:** `npx vitest run src/core/agents/discovery.spec.ts src/core/agents/lifecycle.spec.ts
  src/core/api.spec.ts src/core/agentBrowserLink.spec.ts src/services/agentBrowser.spec.ts
  src/services/agentBrowserProcess.spec.ts`: FAIL. `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts
  e2e/agentBrowser.e2e.ts -t "moves with its pane"`: FAIL (the successor never shows a browser). Commit `test: the
  browser moves with its pane to the agent that takes it`.
- [ ] **Step 3: Green.** Implement the rules. Comments: `createAgentBrowserLifecycle`'s says the one case a flag
  changes id, and that the entry moves first; discovery's header names the takeover; the three headers
  (`agentBrowserLink.ts`, `agentBrowserProcess.ts`, `agentBrowser.ts`) name `moved` and `move_browser` beside what
  they list today.
- [ ] **Step 4:** The unit command with `--coverage` and a `--coverage.include=` for each of
  `src/core/agents/discovery.ts`, `src/core/agents/lifecycle.ts`, `src/core/agentBrowserLink.ts`,
  `src/services/agentBrowser.ts` and `src/services/agentBrowserProcess.ts`: PASS at 100%. Then the commands under
  Wave 5 verify: PASS.
- [ ] **Step 5:** Commit `feat: a pane's new agent takes its browser: the settings, the profile and the flag`.

---

## At the end

1. **Final review** (ken15dev phase 4): one fresh Opus subagent that wrote none of it reviews the branch against
   `main` and both specs, and fixes what it finds. It also checks: `git diff --stat main -- cli/src/superTabs`
   shows only Task 4's move and import; `git grep -n "browser-mcp\|browserMcp\|created with Browser\|Browser ticked"
   -- cli desktop` finds nothing but the dated compatibility comments; no caller of `turns.deliver` but
   `agentBrowser/notices.ts` passes `quiet`; and the quiet path names no feature: `git diff main --
   cli/src/core/deliveries.ts cli/src/core/turns/recaps.ts cli/src/lib/commander.ts cli/src/services/recaps.ts
   cli/src/services/turnsLink.ts | grep -i '^+.*browser'` finds nothing. And for decision 14: `git grep -n
   "attachBrowser" -- cli/src ':!*.spec.ts'` shows create, resume and discovery, each handed the lifecycle in
   `core/main.ts` (`agentBrowsers.attached` twice, `agentBrowsers.observed` once), and Task 23's table still names
   every caller of `registry.openPendingAgent`, `resumePendingAgent`, `openProcessAgent`, `reinstateArchived`,
   `adoptEngine` and `releaseEngine`: a path added since gets its row and its test. And for decision 19: `git grep
   -n "moveBrowser\|\.moved(" -- cli/src ':!*.spec.ts'` shows discovery's two lines (the adopt, the eviction), the
   lifecycle, the link, the service's own process and the service, and no other caller; in
   `cli/src/services/agentBrowser/containers.ts` no name is made from an agent's id (`nameOf` and `secretOf` take a
   profile), and every `containers.execArgs` caller passes `browsers.profile(…)`; `git grep -n "kept by the agent's
   id" -- cli/src` finds nothing (Task 23's two pins are Task 26's tests now); and `previousAgentId` is on no frame
   (`git grep -n previousAgentId -- cli/src/lib/agentFrame.ts desktop mobile` finds nothing).
2. **Local receipts** (`docs/validation-and-release.md`; PR CI does not run these). `python3 scripts/local-checks.py
   --list $(git diff --name-only main...HEAD)` prints what the pull request must carry. Expected, once each, on
   the final head, recorded in the PR body's `harness-local-checks` fence:
   - `cli-core`: `npm run test:core` (`src/core/`, `src/services/` at 100% per file);
   - `cli-portability`: `npm run test:portability` (`launchOverrides`, `createAgentPane`, `registry`);
   - `cli-resume`: `npm run test:resume` (`resumeAgentService.ts`, a comment; `stoppedAgents.ts`, Task 25);
   - `make desktop-test` on a Mac (`desktop-macos`): not required by path, run once because the panel's webview is
     macOS and Linux UI.
   `test:harnessd` is not needed: nothing under `src/harnessd/` changes. Tasks 20 to 23 add no receipt: their
   files ask for `cli-core` alone (`local-checks.py --list`), already here; `cli/src/engines/` and
   `cli/src/lib/commander.ts` are covered by `cli-tests` on CI. Tasks 24 to 26 add none either: their files ask for
   the same three (`cli-core`; `cli-portability` and `cli-resume` for `registry.ts` and `stoppedAgents.ts`).
3. **CI, once:** push, open the pull request ready with the `hold` label. `ci/required` runs `cli-typecheck`,
   `cli-tests`, `desktop-tests`, `backend-desk`, `backend-integration`, `mobile-checks` and `process-checks`.
4. **Heavy end to end, once, by hand:** Actions, CLI end to end, Run workflow on the branch with
   `agent_browser_podman` ticked (Task 18's file alone). Put the run's link in the pull request. A second run only
   after a fix to what it found. `e2e/agentClient.e2e.ts`, whose rules case Task 20 changed, ran that case locally
   in Task 20 and runs whole in the workflow's schedule: no second heavy run for it.
5. **By hand, recorded in the pull request** (the spec's list), on macOS and on Linux, with a real Claude Code
   agent and a real Codex agent that ran before the update and are not restarted: Start and the typed line; a
   screenshot each engine reads; Stop mid-task and the login kept; Stop then a request that needs the browser; a
   new agent's first message arriving exactly as typed. Resize the panel and see `innerWidth` follow and
   `screen.width` stay. The browser follows its agent, and the two things Task 0 found, which no unit test can see
   whole:
   - **It follows its agent (Task 23, decision 14).** With the browser on and a site signed in, in Claude Code and
     in Codex. An engine restart in its pane (Restart, ⌘⇧E): the button stays, running, and the page and the login
     are there after. The engine ended in its pane (`/exit`) and its tile gone to a terminal, then the agent
     resumed: the button stays and the browser comes back, signed in, with no ready line typed again. A daemon
     restart (an update does one), then a restart of the Mac: the same, once the agent is back.
   - **It moves with its pane (Tasks 24 to 26, decision 19).** With the browser on and a site signed in, in Claude
     Code and in Codex: quit the engine (`/exit`) and type it again in the same pane. The button stays, on the
     pane's new agent; the browser comes back signed in; the ready line is typed to it once. Then, from the saved
     list, resume the agent that ended: its Browser is off, its Start opens an empty profile, and the pane's agent
     is still signed in. Delete that resumed agent: the pane's agent is still signed in. Once more with the browser
     stopped before the quit: the new agent's Browser is off, and its Start opens the signed-in profile. And the
     other order: quit, resume the agent from the saved list first, then type the engine into the old shell: the
     resumed agent keeps its browser and the shell's new agent has none.
   - **No asking (Task 20).** `harness browser snapshot` runs with no question in Claude Code's Ask mode and Auto
     mode and in Codex's default mode (sign Codex in first: Task 0 could not), on an agent started after the
     update. For the two agents that ran before it, record whether each engine took the new rule without a restart.
   - **Quiet lines (Tasks 21, 22).** With the agent off screen and Harness not in front, press Start, wait for the
     agent to answer the ready line, press Stop: no unread mark, no sound, no banner, no OS notification, and the
     agent's last recap unchanged, on the branch's Desktop and on the released Desktop (an older one) against the
     branch's CLI; the daemon's log shows `turn-end · quiet` for both turns, in Claude Code and in Codex. A turn the
     person asks for right after still alerts.
6. **Hot-path numbers in the pull request** (standard 4): the daemon's CPU at rest with one ready browser whose
   tool server is idle, on `main` and on the branch (at most 1% of one core, no higher than before); the wall time
   of `snapshot` on one page, p50 and p95 over 20 runs, through the relay on `main` and through the CLI on the
   branch; Task 0's start time beside them; Task 22's two medians, before and after (the recaps' `ingest` per
   batch and `settled` per delivery event); Task 23's medians, before and after (a scan's `onObserved` per agent).
   Tasks 24 to 26 have no number: read from the diff, nothing is added to a scan of a running agent, to a
   delivery or to a command (the takeover's lines run only where a terminal adopts an engine or a new row evicts
   one; a profile is read where a container is started, stopped, removed or exec'd into).
7. **The pull request says:** platforms (above); the release order (backend, CLI, Desktop); migration (none) and
   rollback (the spec's paragraph); the two compatibility entries and their date; what an older Desktop and an
   older phone do at a quiet turn's end (Task 22, Compatibility); that the hook fixture was recorded again for
   `harness browser`'s rules (Task 20); and decision 19's data: the entry's `profile` and the shell row's
   `previousAgentId` (Task 25's Design lines and the spec's Data line), no migration, and the rollback the spec
   accepts (an older CLI finds a moved browser's volume under no name it knows: orphaned until its agent is
   deleted; the move's log line names both ids).

## Where the spec needed a call

Each is built as written here; Ken may change any.

1. **`needs_setup` to the agent.** The Failures table gives "`start` where Browser is not set up" exit 5, but the
   agent has no `start`, and the exit-code table and the list of refusals give a failed browser exit 1. Built: exit
   1, `Browser isn't set up`.
2. **The 75 s bound and 8 waiting commands** cannot both hold if a waiting command's time counts. Built: the
   service's limit starts when a call starts running; the CLI's own wait (35, 75, 45 s) is the bound, and a call
   whose CLI has gone is dropped from the queue.
3. **A command that dies with its container** answers `Browser is starting` (the spec's words) even when Podman's
   event has not yet arrived; `Browser is not reachable` only when the tool server never started.
4. **Pane ids restart in every tmux server.** `runningPane` alone would let a private tmux server's pane stand for
   another agent's. Built: the CLI also sends its parents' pids and the core holds the pane's process to them
   (`ofPane(pane, ancestors)`), as `inDaemonPane` does for the Swarm.
5. **A ptyhost pane on macOS or Linux** (opt-in backend) cannot be proven by `runningPane`. Built: refused, exit 5.
6. **The stop line for an agent that was never told** (Stop while it starts, or failed). Built: nothing is typed,
   as for a ready line taken back: that agent never knew.
7. **A line whose outcome is `unknown`** (the core's link dropped). Built: counted as typed, so it is never typed
   twice.
8. **Stop for an agent that is not running.** Its flag is in its stopped record, and no button shows for it. Built:
   `{ok: true}`, nothing changes, and its browser comes back at its resume.
9. **Start for a guest's agent** is not named by the spec. Built: refused `NOT_ALLOWED` by the core, since every
   command of that agent would be refused.
10. **`agent_browser_enabled`** ("an agent's first start") is detected by the settings entry being absent. A proxy
    saved before the first Start makes that start uncounted. Built as today; say if a `started` mark is wanted.
11. **The other Desktop's panel** "shows the same window and scales it to fit", but the page learns the window's
    size only from its own request's answer. Built: no push; it shows its last rectangle until its next resize.
12. **"Dragging the divider".** Panes beside the chat are half and half, with no divider to drag. Built: the test
    resizes the window. A draggable divider would be new UI.
13. **"The panel's size in screen pixels."** Built: logical pixels (one remote pixel is one logical pixel, noVNC's
    1:1), not device pixels.
14. **`browser-tools.json` stays in the image** (`COPY .`), where nothing reads it once `tools/list` goes. Left:
    the spec changes nothing in the image.
15. **A recap or a notification raised by a typed line.** Task 0 found both, from the code. **(Ken, 2026-11-11,
    option b)** built as a quiet delivery (Tasks 21, 22). Four things stay; say if one should go:
    - Desktop still counts that turn among its finished turns (`turn_ended` is not marked: its own counters, and
      the once-per-computer phone offer, `app_state.dart:23268-23318`);
    - the line is kept among the agent's last asks and as its last prompt (`commander.ts` `rememberAsk`, the
      funnel's `prompts`): both are written as the turn starts, before the delivery is known to be its start;
    - the mark does not outlive a daemon restart: an agent whose last turn was a quiet one, attached after a
      restart, has that turn recapped as history (`commander.ts` `catchUp`: on the tile, with no notification);
    - a line typed while the turn before it holds its end for sub-agents still at work takes that held end's
      place, as any new prompt does today (`commander.ts:409-414`): that earlier turn is then not recapped or
      announced. The mark is not known when the line's turn starts, so the commander cannot tell it from a prompt.
16. **The compatibility dates** assume a release by 2026-11-18.
17. **`browser` is an agent verb with no MCP tool.** `HARNESS_AGENT_TOOLS` maps each verb to its tool, and
    `mcp.spec.ts` holds every key to a tool of `harness mcp`. Built: a second list, `HARNESS_SHELL_VERBS`, joined
    into `HARNESS_AGENT_VERBS`; the map does not change.
18. **An engine that ran before the update** reads its rules when it chooses: not measured. Until it reads the new
    one it does what Task 0 measured for an unlisted verb (Claude Code in Ask mode asks; Codex tries in its sandbox
    first). The by-hand run records it.
19. **A quiet line's turn is marked only when the input says `started`.** A line the input cannot tie to the turn
    that followed (`unknown`, `prompt_mismatch`) is not marked, and that turn alerts as today: no turn is made
    quiet on a guess.
20. **Desktop has no task for the quiet lines.** Its alert is raised only by the daemon's notification, which a
    quiet turn does not send; a Desktop test for it would pass before any change (Task 21).
21. **The same pane, another agent. Decided by Ken (2026-11-11, decision 19): the browser moves with its pane**
    (Tasks 24 to 26). As asked then: decision 14 keeps the browser by the agent's id, and an engine comes back in
    its own pane under a new id in two ways (Task 23's table): the engine exits, its pane is left a shell under a
    new id, and the engine is typed again there; or a new engine process is seen in a bound agent's pane before its
    start hook arrives. Task 23 was built by id; on these two paths the flag, the settings and the profile now go
    to the pane's new agent, and the agent that ended keeps no browser.
22. **Two places a browser outlives its engine**, read from the code on the way, not run, and left as today (they
    are about how a browser ends, not how it comes back): a row whose engine never came up, or that a restore could
    not relaunch, stays a terminal under its id with its flag, so its browser runs beside a shell until the pane
    closes; and an agent archived as the daemon starts (its engine exited while the daemon was down) was never
    attached by that daemon, so `ended` tells the service nothing and a container that outlived the old daemon
    runs until that agent is resumed or purged. Say if either should stop it.
23. **How the core knows whose pane a shell was** (decision 19). The spec's Data line names one stored field, the
    entry's `profile`. Built with one more: the shell's registry row keeps the id of the agent that ended in its
    pane (`previousAgentId`, Task 25). A search of the saved agents by pane is not proof: pane ids restart with
    every tmux server, and a saved agent of last week would give its logins to a stranger's pane.
24. **The agent that ended runs again before its old pane has a new agent** (resumed from the saved list, in
    another pane). Its browser came back with it, as decision 14 says. Built: the old shell forgets it, and the
    engine typed there later is a new agent with no browser. Taking a browser from a running agent is not what
    "replaced" means.
25. **The pane's new agent already has a browser of its own** (its Browser is on, or it has a settings entry: a
    Start or a save on the shell before the engine was typed). Built: it keeps its own and nothing moves; the agent
    that ended keeps its flag and its logins.
26. **The names by profile.** The spec names the volume and the container. Built: the network and the proxy secret
    too (`harness-browser-<profile>`, `harness-proxy-<profile>`): they share one name function today, and a secret
    left under the agent's id would outlive its container.
27. **"Its person can Start a new, empty one."** The previous agent's id is the name of the volume it gave away
    (a profile is the agent's id until it moves). Built: a new entry for an agent whose id another entry holds as
    its profile gets a profile id of its own (a UUID); any other new entry has no `profile`, as before. Without it
    two agents would share one volume, and a delete of one would take the other's logins.
28. **Failures the spec does not name.** A core that refuses or does not answer after the entry moved: the entry
    stays with the pane's new agent, both flags stay as they were, and it is logged `browser_move_failed`; the new
    agent's Start finds the logins. An agent evicted by a scan has no saved record, so a move that fails leaves its
    entry under an id no agent has, and the next service start deletes it with its volume, as it does today. A
    stop of the previous browser that Podman fails: logged, the entry still moves, and the new agent's start
    removes the container left under that name.
29. **Any engine typed into the shell takes the browser**, Codex after Claude Code too: the browser is the pane's.
30. **A move tells nobody but the new agent.** The agent that ended is not running and is typed nothing. No
    counter: the spec asks for the log line alone.

## Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-11-browser-from-chat.md`. Execution is **ken15dev
phase 3**. Please review the plan: does it capture what you want? No code before Ken's go.

Amended 2026-11-11, after Task 0 and with wave 1 under way: Tasks 20 (wave 2), 21 (wave 2) and 22 (wave 4), for the
allow rules and the quiet lines (Ken: both in scope; quiet lines, option b).

Amended 2026-11-11, with wave 2 under way: Task 23 (wave 2), for decision 14 (Ken: the browser follows its agent on
every run path), with its case in Task 17's end to end run and its line in the by-hand list.

Amended 2026-11-11, as wave 2 ended: Tasks 24 and 25 (wave 3) and 26 (a new wave 5), for decision 19 (Ken: the
browser moves with its pane to the agent that replaces it; call 21 decided). Task 26 turns Task 23's two pins of
call 21 into its red tests and carries the end to end case; calls 23 to 30 are what the spec left.
