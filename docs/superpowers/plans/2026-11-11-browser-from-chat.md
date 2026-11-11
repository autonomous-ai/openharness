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
- The daemon's `agentBrowser` service keeps one tool server per ready browser (`podman exec -i … browser-tools.mjs`),
  runs the agent's commands through it one at a time, sizes Chrome's window through it, and types two lines into
  the agent (`CoreApi.turns.deliver`): one when the person's Start is ready, one at the person's Stop.
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
| `cli/src/lib/registry.ts`, `cli/src/core/agents/lifecycle.ts`, `cli/src/core/api.ts`, `cli/src/core/agentBrowserLink.ts`, `cli/src/core/main.ts` | the flag, set by the core | 2, 12, 15 |
| `cli/src/lib/e2ee/applicationFrames.ts` | the three sealed requests | 2 |
| `cli/src/core/agents/create.ts`, `cli/src/lib/launchOverrides.ts` | launches with no browser argument | 3 |
| `cli/src/lib/callerPane.ts` (moved) | the pane a command runs in | 4 |
| `cli/assets/browser/browser-tools.json`, `cli/src/agentClient/browserArgs.ts` | commands, examples, help | 5 |
| `cli/src/agentClient/browserOutput.ts` | the cap and the files | 6 |
| `cli/src/services/agentBrowser/toolServers.ts` | one tool server per ready browser | 7 |
| `cli/src/services/agentBrowser/notices.ts`, `stateFile.ts` | the two lines and the `told` mark | 8 |
| `cli/assets/browser/browser-tools.mjs`, `browser-tools-lib.mjs` | the tool server: calls and the window | 9 |
| `desktop/tool/browser_viewer/viewer.js`, `desktop/assets/browser/browser_viewer.html` | the page clips to the window | 10 |
| `cli/src/services/agentBrowser.ts`, `agentBrowserProcess.ts`, `agentBrowser/browsers.ts`, `agentBrowser/settings.ts` | the requests | 12, 15 |
| `cli/src/agentClient/browser.ts`, `cli/src/cli.ts`, `cli/src/agentClient/help.ts` | the command | 13 |
| `desktop/lib/state/app_state.dart`, `desktop/lib/e2ee/envelope.dart` | Desktop's requests | 11, 14 |
| `desktop/lib/browser/browser_panel.dart`, `desktop/lib/super_tabs/view.dart`, `browser_bridge.dart` | button and panel | 16, 19 |
| `desktop/design/desktop-design-system.md`, `desktop/test/swarm_elements_gallery_test.dart`, goldens | design doc and gallery | 11, 16, 19 |
| `cli/e2e/agentBrowser.e2e.ts`, `cli/e2e/agentBrowserPodman.e2e.ts` | end to end | 17, 18 |

## Waves

A wave's tasks depend on nothing in the same wave and share no file, tests included. Run a wave's subagents together,
within the machine's capacity. After each wave: cherry-pick in task order, check each task's red commit comes before
its code commit, run the wave's commands below.

| Wave | Tasks |
|---|---|
| 0 (by hand, gate) | 0 |
| 1 | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 |
| 2 | 12, 13, 14 |
| 3 | 15, 16 |
| 4 | 17, 18, 19 |

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
  src/agentClient/help.spec.ts src/architecture.spec.ts --maxWorkers=4
(cd ../desktop && flutter analyze lib test && flutter test --no-pub --concurrency=2 --timeout=60s \
  test/browser/browser_requests_test.dart test/e2ee/encrypted_down_types_test.dart test/ws_conn_test.dart)
```

**Wave 3 verify:**

```bash
npm run typecheck
npx vitest run src/services/agentBrowser.spec.ts src/services/agentBrowserProcess.spec.ts src/core/api.spec.ts \
  src/core/agentBrowserLink.spec.ts src/services/agentBrowser/settings.spec.ts \
  src/backendSocket.agentBrowser.spec.ts --maxWorkers=4
(cd ../desktop && flutter analyze lib test && flutter test --no-pub --concurrency=2 --timeout=60s test/browser \
  test/swarm_v4_journey_test.dart test/swarm_elements_gallery_test.dart)
```

**Wave 4 verify:**

```bash
npm run typecheck
E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/agentBrowser.e2e.ts
(cd ../desktop && flutter analyze lib test && flutter test --no-pub --concurrency=2 --timeout=60s test/browser)
```

`e2e/agentBrowserPodman.e2e.ts` is typechecked here and run once by hand at the end (see At the end).

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

**Depends on:** Tasks 5, 7, 12.

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

---

## Wave 4

### Task 17: End to end on the real daemon, fake `podman`

**Files:**
- Modify: `cli/e2e/agentBrowser.e2e.ts`

**Depends on:** Tasks 13 and 15.

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
  case.
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

---

## At the end

1. **Final review** (ken15dev phase 4): one fresh Opus subagent that wrote none of it reviews the branch against
   `main` and both specs, and fixes what it finds. It also checks: `git diff --stat main -- cli/src/superTabs`
   shows only Task 4's move and import; `git grep -n "browser-mcp\|browserMcp\|created with Browser\|Browser ticked"
   -- cli desktop` finds nothing but the dated compatibility comments.
2. **Local receipts** (`docs/validation-and-release.md`; PR CI does not run these). `python3 scripts/local-checks.py
   --list $(git diff --name-only main...HEAD)` prints what the pull request must carry. Expected, once each, on
   the final head, recorded in the PR body's `harness-local-checks` fence:
   - `cli-core`: `npm run test:core` (`src/core/`, `src/services/` at 100% per file);
   - `cli-portability`: `npm run test:portability` (`launchOverrides`, `createAgentPane`, `registry`);
   - `cli-resume`: `npm run test:resume` (`resumeAgentService.ts`, a comment);
   - `make desktop-test` on a Mac (`desktop-macos`): not required by path, run once because the panel's webview is
     macOS and Linux UI.
   `test:harnessd` is not needed: nothing under `src/harnessd/` changes.
3. **CI, once:** push, open the pull request ready with the `hold` label. `ci/required` runs `cli-typecheck`,
   `cli-tests`, `desktop-tests`, `backend-desk`, `backend-integration`, `mobile-checks` and `process-checks`.
4. **Heavy end to end, once, by hand:** Actions, CLI end to end, Run workflow on the branch with
   `agent_browser_podman` ticked (Task 18's file alone). Put the run's link in the pull request. A second run only
   after a fix to what it found.
5. **By hand, recorded in the pull request** (the spec's list), on macOS and on Linux, with a real Claude Code
   agent and a real Codex agent that ran before the update and are not restarted: Start and the typed line; a
   screenshot each engine reads; Stop mid-task and the login kept; Stop then a request that needs the browser; a
   new agent's first message arriving exactly as typed; and that `harness browser` runs without asking the person
   (Task 0's stand-in, now the real command). Resize the panel and see `innerWidth` follow and `screen.width` stay.
6. **Hot-path numbers in the pull request** (standard 4): the daemon's CPU at rest with one ready browser whose
   tool server is idle, on `main` and on the branch (at most 1% of one core, no higher than before); the wall time
   of `snapshot` on one page, p50 and p95 over 20 runs, through the relay on `main` and through the CLI on the
   branch; Task 0's start time beside them.
7. **The pull request says:** platforms (above); the release order (backend, CLI, Desktop); migration (none) and
   rollback (the spec's paragraph); the two compatibility entries and their date.

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
15. **A recap or a notification raised by a typed line** has no task: the core cannot tell these deliveries apart
    today. Task 0 measures it and stops the plan if it happens.
16. **The compatibility dates** assume a release by 2026-11-18.

## Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-11-browser-from-chat.md`. Execution is **ken15dev
phase 3**. Please review the plan: does it capture what you want? No code before Ken's go.
