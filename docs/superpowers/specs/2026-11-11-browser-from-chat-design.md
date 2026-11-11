# Browser from chat: any agent gets its Browser when needed, and drives it with a CLI

**Status:** design, not built.
**Date:** 2026-11-11
**Changes:** [Agent Browser](2026-11-10-agent-browser-design.md) (PR #3822). Everything that spec says about Podman,
setup, the container, the image, the proxy, the device, the settings, human input, challenge detection, the stream and
its viewer stands. This spec changes how a browser is turned on, how it is turned off, and how the agent drives it.
**Scope:** agents on macOS and Linux, Desktop on macOS and Linux, as today.

Marks: **(Ken)** decided by Ken on 2026-11-11, in the brainstorm or in his answers to this spec's first draft.
**(main)** the main session's call. **(spec)** this spec's call. Ken may override every (main) and (spec).

## Intent

Today a browser is chosen once, when an agent is created, and the agent gets it as an MCP server added to its launch.
That has three costs:

- An agent that already runs cannot get a browser. It has to be created again with the box ticked.
- MCP is added at launch, so a change needs a restart or a resume, and each engine takes MCP its own way. Only Claude
  Code and Codex are wired.
- It breaks the product rule that agents start as plain Claude Code or Codex with default settings.

So the browser moves to the agent's chat, and MCP goes. A person starts the browser for any of their agents when the
work needs it and stops it when done. The agent drives it with a shell command, `harness browser`, which works at once
in an agent that already runs, in every engine, with nothing added to its launch.

## Goals

- **From the chat.** The **Browser** button is in every chat of the person's own agents. The person starts the browser
  there and stops it there.
- **One way to drive it.** `harness browser <command>`, a shell CLI on the existing tool server. No MCP.
- **No restart.** A browser started for a running agent is usable in that agent's next command.
- **Only the person starts and stops it.** The agent uses its browser while its person has it on.
- **The agent is told.** One line when its person starts it and it is ready, one when its person stops it. That is how
  the agent learns the CLI.
- **Plain agents.** No launch argument, no MCP server, no checkbox, and no other line in its messages.

## Non-goals

- Windows, the web build and the phone. They stay as they are (no button, no browser).
- Stopping a browser that sits idle. It runs until its person stops it or its agent ends.
- The agent starting or stopping its browser, or installing Podman.
- A browser for an agent that is not running.
- A Browser button anywhere but the Swarm chat: not in a regular tab, not in the terminal interface.
- New browser tools. The commands are today's eleven tools.
- Any change to the container, the image, the proxy, the device, challenge detection or the browser limit. The stream
  changes only in what the panel shows (The window fits the panel).
- A Browser button for teammates or guests.

## Anti-goals (a failure even if it works)

- An agent that can start or stop its browser, or one agent's command reaching another agent's browser.
- An MCP server or any launch argument added to an agent for the browser.
- A read of the backend or of the Swarm on a command's path.
- A line typed into an agent more than once per start, or at every daemon restart: that spends the person's tokens
  without them knowing.
- Any change to how a person's or the Swarm's messages reach an agent.
- A login lost because the person pressed Stop.
- Image bytes on the agent's terminal, or a snapshot that floods its context.
- A guest's agent starting a browser on the owner's machine.

## What exists today (read 2026-11-11)

- **The checkbox.** `BrowserPill` in Swarm New agent (`desktop/lib/browser/browser_pill.dart`,
  `desktop/lib/widgets/new_harness_form.dart:2464`), its state in `desktop/lib/state/new_harness.dart:1051-1116`,
  turned on by `offersBrowser: true` (`desktop/lib/super_tabs/new_agent.dart:101`). Create sends `browser: true`
  (`desktop/lib/state/app_state.dart:15916`).
- **The flag.** The daemon copies it to the registry row, `browser?: true`, "created with Browser"
  (`cli/src/core/agents/launches.ts:541`, `cli/src/lib/registry.ts:193-197`). The row keeps it through a stop and a
  resume.
- **Start and stop with the agent.** `createAgentBrowserLifecycle` (`cli/src/core/agents/lifecycle.ts:150`) tells the
  service `attached` when an agent with the flag runs, at create, at resume and at daemon start
  (`cli/src/core/main.ts:2675`), and `stopped` once however the agent ends. A purge tells it `deleted`.
- **The service.** `cli/src/services/agentBrowser.ts` and `agentBrowser/browsers.ts`: `start`, `stop` (the container,
  its network and its proxy secret go; the profile volume and the settings stay), `delete`, `retry`, all in one queue
  per agent. It keeps `<data dir>/agent-browser.json`. It runs in the core's process or in its own
  (`services/agentBrowserProcess.ts`, `core/agentBrowserLink.ts`).
- **MCP.** `browserMcpArgs` (`cli/src/lib/browserMcpArgs.ts`) is added at create (`core/agents/create.ts:385-387`) and
  at every relaunch (`lib/launchOverrides.ts:326-327`), for Claude Code and Codex only. `harness browser-mcp`
  (`cli/src/cli.ts:2836`, `agentClient/browserMcp.ts`) is a stdio relay: it finds its agent by its pane, asks the
  daemon `agent_browser_state`, and pipes each call to `podman exec -i … node browser-tools.mjs`.
- **The tool server** (`cli/assets/browser/browser-tools.mjs`) keeps, in its own memory, the current tab and the refs of
  the last snapshot. So it has to live across calls.
- **Who may open, retry or change a browser.** `mayOpenBrowser` (`cli/src/core/api.ts:667`): a process on this
  computer, or another of the owner's own apps and computers; never a machine share, never a guest.
- **The button.** `BrowserButton` after Terminal in the agent chat's header, drawn only when the agent's frame carries
  `browser` and its machine is the person's own (`desktop/lib/super_tabs/view.dart:2826-2842, 2967`). The frame's
  `browser` is `{state, step?, error?}`, present only for an agent with a browser.
- **Text into an agent.** `CoreApi.turns.deliver(agentId, text, deliveryId)` (`cli/src/core/api.ts:246`): the path
  Agent Messages, the Wi-Fi device and the orchestrator use. A delivery waits for the agent's turn to end, at most 5
  minutes (`cli/src/lib/sessionInput.ts:16`), and its outcome is heard through `onDelivery`. A service in its own
  process may deliver only when it is in `TURN_DELIVERERS` (`core/api.ts:934`).
- **How a Swarm delivery is typed.** `SuperTabHost` puts every delivery's text together in one place
  (`cli/src/superTabs/host.ts:1504-1520`), in one of two shapes:
  - a person's own words in their agent's own 1:1 chat: exactly as typed and nothing else (`plainChat`,
    `host.ts:1552`; `plainText`, `host.ts:317`; anh Dee, 2026-11-09);
  - any other message: its context lines, its quote, the message and an Answer line (`prompt`, `host.ts:1779`). A
    notice for the agent alone is its text alone.
  - Before anything is typed, the host writes the delivery's journal entry (`stage: 'submitting'`, `host.ts:1525`),
    and it hears from the core when the delivery was written (`heard`, `host.ts:1824`).
  - In the agent's own chat it posts the agent's answer by matching the turn to a hash of what was typed
    (`host.ts:1526`, `cli/src/superTabs/agentReplies.ts`).
  - The host holds each agent's registry row in memory (`core.agents.byAgent`).
- **An agent verb's pane.** `runningPane` (`cli/src/superTabs/callerPane.ts`) proves the pane a command runs in from
  its parent processes, and refuses a `TMUX_PANE` that names another pane.
- **Counters** are one fixed list that the backend also holds and validates
  (`cli/src/lib/productUsageContract.ts:229`, `backend/src/types/productUsage.ts`,
  `backend/src/routes/productUsage.ts:20`).

## Decided

1. **(Ken)** Browser is not chosen at creation. The checkbox leaves New agent.
2. **(Ken)** The Browser button, beside Terminal, is on every chat of the person's own agents. The person starts the
   browser there and stops it there.
3. **(Ken)** No MCP. `harness browser-mcp`, `browserMcpArgs` and every launch-time wiring go. The one way an agent
   uses the browser is `harness browser <command>`. Agents that had a browser move to the CLI at their next run.
4. **(Ken)** Only the person starts and stops the browser. The agent has neither command: it uses its browser while
   its person has it on, and when it needs one that is off, it asks its person. (This replaces Ken's earlier answer,
   that the agent may start it.)
5. **(Ken)** The person's Start triggers the agent's context: when the browser is ready, Harness tells the agent one
   line that names the CLI. The person's Stop triggers one line too. These two lines are the only way the agent learns
   about its browser: no line is added to its messages, its own 1:1 chat stays plain (anh Dee's `plainChat` rule,
   untouched), nothing is added at launch. `harness browser --help` lists every command with a one-line example, and
   `harness help agents` lists `harness browser --help` in one line. (This replaces Ken's earlier answers, a Browser
   line in every delivery's context and then once per agent.)
6. **(main)** Stop keeps the profile, so the login survives a later start. Only deleting the agent removes it.
7. **(main)** Only the agent's own person starts, stops and opens it from Desktop, enforced on the agent's machine
   (`mayOpenBrowser`). Guests are refused.
8. **(main)** A command while the browser is off, or on a machine where Browser is not set up, tells the agent to ask
   its person to start it from its chat. The agent cannot install. The panel shows Install, as today.
9. **(main)** The browser runs until its person stops it, or its agent stops or is deleted. No idle stop.
10. **(main)** Closing the panel only hides it. Stop is its own control in the panel.
11. **(main)** Kept as they are: the settings per agent, the memory-based limit, owner-only viewing, challenge
    detection that has the agent ask its person in chat.
12. **(main)** An older Desktop that still sends `browser: true` at create: the browser starts once the agent runs.
13. **(main)** An agent launched with the MCP argument keeps working until it restarts. What really happens is under
    "What goes, and what stays for a while".
14. **(Ken)** The browser stops only when its person stops it or its agent stops. When the agent runs again, by any
    path, its browser starts again with it. It is kept by the agent's id: the flag on its registry row.
15. **(main)** The ready and stopped lines go to the agent only. They are not shown in the person's chat.
16. **(Ken)** Which agents: today's `mayOpenBrowser` rule, applied to the agent. An agent on this machine that is not
    a guest's may use its browser. The check uses what the daemon already has, never a read of the backend or of the
    Swarm on the command's path. An agent in a regular tab is not refused; its person starts, sees and stops its
    browser through the Swarm chat's Browser button.
17. **(Ken)** The stop line is `Your person stopped your browser.`
18. **(Ken)** The browser fits the panel without changing the screen: the screen keeps the Device setting's size, so
    `screen.width` never changes, and only Chrome's window follows the panel, as a person resizing a window that is
    not maximized. The panel shows that window at 1:1. See The window fits the panel.

## Design

### On and off

- **(spec) One record.** The registry row's `browser` flag now means "this agent's Browser is on". It is set by a
  start (the person's, or the create flag of an older Desktop) and cleared only by the person's Stop. The
  field keeps its name and shape, so nothing is migrated.
- **(Ken) It follows the agent, by its id.** A browser that is on when its agent stops is stopped with it, and starts
  again whenever that agent runs again, by any path: a resume, a relaunch, an engine that restarts in its pane, a
  daemon or machine restart. A daemon restart leaves a running browser running and takes it up again. Only the
  person's Stop turns it off.
  - The bug this fixes (seen on a teammate's Mac with the released build, 2026-11-11): today an engine that exits or
    restarts ends the browser (`createAgentBrowserLifecycle` `ended`), but only create, resume and daemon start attach
    it again, so the button disappeared for good while the agent ran on. Every path that registers a running agent
    must attach its browser when the flag is on; a test covers each path.
  - The other choice, turning it off whenever the agent stops, was not taken: an engine restart the person never
    asked for (a crash, an account switch) would silently take away a browser they started.
- **How it is set.** The service asks the core to set or clear the flag (a new `CoreApi.agents` call, with its query
  for the service's own process), then goes through the same `attached` and `stopped` paths as today.
- **The frame.** `browser` is present while the browser is on, with the same `{state, step?, error?}`. Absent means off.

### Requests

All names start with `agent_browser_`, so they stay out of the frame log (`cli/src/backendSocket.ts:78`): a command
carries what the agent types and the addresses it opens. The builder may rename them inside that prefix.

| Request | From | Allowed for | Does |
|---|---|---|---|
| `agent_browser_start {agentId}` | Desktop | `mayOpenBrowser` | Turns it on and starts it. Answers `{ok: true}` at once; progress comes in the frame. |
| `agent_browser_stop {agentId}` | Desktop | `mayOpenBrowser` | Turns it off and stops it. The profile and the settings stay. |
| `agent_browser_run {pane, command, args}` | the agent's CLI | a local asker only | One tool call, for the agent of that pane. Never start or stop. |

- `start` and `stop` are idempotent: a start of a browser that is on, and a stop of one that is off, answer
  `{ok: true}` and do nothing. A start of a failed browser tries again, as Retry does.
- `start` is refused `NOT_RUNNING` for an agent that does not run here.
- `agent_browser_start` and `agent_browser_stop` join the sealed machine requests beside `agent_browser_retry`
  (`cli/src/lib/e2ee/applicationFrames.ts:52`, `desktop/lib/e2ee/envelope.dart:78-82`), so the person's other Desktop
  can send them. The pinned `core.ts` does not change. The backend relays them as it relays `agent_browser_retry`.
- `agent_browser_run` is answered only to a local asker and is on no sealed list.
- **(spec) Settings while off.** `agent_browser_settings`, `agent_browser_settings_save` and
  `agent_browser_proxy_test` are answered, to the same askers as today, for any agent of this machine, on or off. A
  person can set a proxy before the first start, so the browser never connects from the machine's own address first.
  A save while off writes the settings entry; nothing starts.
- `agent_browser_available`, `agent_browser_setup`, `agent_browser_retry` and the stream's `agent_browser_open`,
  `_ack`, `_close` do not change.

### `harness browser`

- **Where the tool server runs (spec).** The daemon's service keeps one tool server per ready browser: the same
  `podman exec -i harness-browser-<agentId> node /opt/harness-browser/browser-tools.mjs` the relay started, started at
  the browser's first command, started again after it exits, ended when the browser stops. The CLI never runs
  `podman`. This is what keeps the current tab and the snapshot's refs between two commands, and puts the identity
  check, the order of commands and the person's Stop in one place.
- **How it finds its agent.** By the pane it runs in, as `harness send` and today's relay do: `$TMUX_PANE`, or
  `$HARNESS_PANE`, which every agent's shell already has. No agent id is an argument, so a command cannot name another
  agent. The pane is proven from the command's parent processes (`runningPane`); a pane variable that names another
  pane is refused. The daemon maps the pane to its agent (`agents.ofPane`).
  - `runningPane` is Swarm code behind its door (`cli/src/architecture.spec.ts` `SWARM_DOORS`). If the browser command
    cannot import it, the builder moves the proof to `lib/`.
- **How it reaches the daemon.** The local socket of the daemon that owns the pane, opened as a tool, as every agent
  verb does (`cli/src/agentClient/daemon.ts`). The socket is 0600 in a 0700 folder (`cli/src/lib/localTransport.ts`),
  so only the person's own processes can open it, and the daemon answers `agent_browser_run` only to a local asker.
- **What this does and does not stop.** An agent's commands reach its own browser and no other. A process that runs as
  the person can still talk to Podman or to the socket directly; the first spec accepted that ("Who can read the
  profile"), and nothing here changes it.
- **(Ken) Which agents.** `mayOpenBrowser` allows an asker that is on this machine and is not a guest. The same rule
  holds for the agent: its pane is on this machine, and its registry row is not a guest's (the row's `guest`). Every
  command is refused with exit 5 for a guest's agent: the machine's Podman, memory and network are its owner's.
  - The check reads the registry row and nothing else. No command waits on the backend or on a Swarm read.
  - An agent in a regular tab is allowed. It drives its browser with the CLI like any other.
  - Its person starts, sees and stops that browser from the agent's Swarm chat. An agent that is in no Swarm has no
    chat and so no button: it cannot get a browser.

**Commands.** Each maps to one tool in `browser-tools.json`, which stays the one source for the names, the arguments
and the help.

| Command | Tool | Prints |
|---|---|---|
| `navigate <url>` | `browser_navigate` | address · title |
| `back` | `browser_back` | address · title |
| `snapshot` | `browser_snapshot` | address · title, then the page's role tree with refs such as `e12` |
| `click <ref>` | `browser_click` | `Clicked` |
| `type <ref> <text> [--submit]` | `browser_type` | `Typed` |
| `press <key>` | `browser_press` | `Pressed` |
| `select <ref> <value>…` | `browser_select` | `Selected …` |
| `scroll <dy>` | `browser_scroll` | `Scrolled` |
| `screenshot` | `browser_screenshot` | the path of the saved image |
| `tabs [list \| new \| select <n> \| close [<n>]]` | `browser_tabs` | the tabs, or what it did |
| `wait <text>` or `wait --ms <n>` | `browser_wait` | `Done` |
| `--help` | — | every command, one line each, with an example |

- There is no `start` and no `stop`. `harness browser start` and `harness browser stop` are wrong commands (exit 2),
  whose usage line says that only the agent's person starts and stops its browser.
- **(Ken) `--help`** lists every command with a one-line example each, and needs no daemon and no browser. Each tool's
  entry in `browser-tools.json` gains its example, so the help cannot name a command or an argument the tool does not
  take. The builder may reword it; this is its shape:

```
Your browser: a Chrome your person can also see and use. Your person starts and stops it.
  harness browser navigate https://example.com   open a page in the current tab
  harness browser snapshot                       read the page; elements get refs such as e12
  harness browser click e12
  harness browser type e7 "hello" --submit       replaces what the field holds; --submit presses Enter
  harness browser press Enter
  harness browser select e9 "Viet Nam"
  harness browser scroll 600                     pixels; a negative number scrolls up
  harness browser screenshot                     saves a JPEG and prints its path; read that file
  harness browser tabs list                      also: tabs new, tabs select 2, tabs close
  harness browser wait "Inbox"                   or: wait --ms 2000
  harness browser back
```

- `type`'s text is one argument, or standard input when the argument is `-`, so text with quotes and new lines needs
  no shell escaping.
- **Output.** Plain text on standard output; a failure is one line on standard error. When a page asks for a person,
  the output ends with today's challenge line.
- **Screenshot to a file.** `screenshot` saves the JPEG and prints only its path. The agent reads the file with its
  own file tool. No image bytes go to the terminal.
- **Output size.** A command prints at most a fixed number of characters. Longer output (a large page's snapshot) is
  cut there, saved in full to a text file, and ends with a line that names the file. The number is set under what
  both engines keep of a shell command's output (see To measure first).
- **Where files go.** A `browser` folder in the agent's temporary folder (`$TMPDIR`, which a Swarm agent can read
  without being asked: `cli/src/lib/agentTmp.ts`). It keeps the newest 50 files; writing one more deletes the oldest.
- **Timeouts.** The tools keep theirs: 20 s, navigation 60 s, `wait` at most 30 s. The service gives a call 10 s more
  than its tool, then ends it and starts the tool server again. The CLI waits 5 s more than the service. So no command runs longer than 75 s.
- **One at a time (spec).** Commands for one browser run in the order they arrive, one at a time: the page is one
  shared thing. At most 8 wait; one more is refused with `Browser is busy. Try again.`

**Exit codes**, the agent verbs' own (`EXIT`, `cli/src/agentClient/commands.ts:130`):

| Code | Means | What the agent reads |
|---|---|---|
| 0 | done | the tool's words |
| 1 | failed | the tool's error (`Element not found; take a new snapshot`), or the browser's state: `Browser is starting`, `Podman is not running`, … |
| 2 | wrong command or arguments | the usage line |
| 4 | the browser is off | `Your browser is off. Ask your person to start it: Browser in your chat.`, or `Your person stopped your browser.` when the stop came during the command |
| 5 | refused; do not retry | see below |

Refusals (5): `Browser isn't available for this agent.` · `Run harness browser from your own Harness pane.` ·
`Browser doesn't run on Windows yet.`

### Start and stop, end to end

**The person starts it.**

1. The person opens the agent's chat and presses Browser. The panel shows that it is off, and **Start**.
2. Start sends `agent_browser_start`. The agent's machine checks the asker, sets the flag and starts the browser.
3. The frame's `browser` goes `starting` (or `setup` with its step), then `ready` or `failed`. The panel shows each, as
   today. Ready, it opens the stream and shows the screen.
4. The agent is told (see Telling the agent).

A machine with no Podman: the browser is on and `failed` with `needs_setup`. On that computer the panel shows Install,
which opens Set up Browser as today, and the browser starts when setup ends. From another computer it says where to
set it up.

**The agent needs one that is off.** Its command exits 4 and says to ask its person. The agent asks in its chat; the
person presses Start.

**The person stops it.**

1. **Stop** in the panel's header sends `agent_browser_stop`. No confirmation: the login is kept.
2. The agent's machine clears the flag and stops the browser: the viewers' streams end, the tool server ends, the
   container, its network and its proxy secret are removed. The volume and the settings stay.
3. The frame's `browser` goes. The panel shows off, the button is plain.
4. The agent is told.

**The agent stops or is deleted.** As today: a stop stops the browser and keeps the flag and the profile; a delete
removes the container, the volume, the network, the secret and the settings.

**At the same time.**

- *Stop while it starts.* The start ends without starting anything (the queue's generation guard, as today).
- *Stop while a command runs.* The tool server ends with the container. Every command that was running or waiting
  answers `Your person stopped your browser.` (exit 4).
- *Start right after Stop.* It waits for the stop in the queue, then starts a new container on the same profile.
- *Two Desktops.* The same queue. The last request wins, and both read the same frame.
- *A settings change or a crash while a command runs.* The container is created again, as today. That command fails
  with `Browser is starting`, and the next one after ready works. The refs are gone: `Element not found; take a new
  snapshot`.

### Telling the agent

- **The path (spec).** `CoreApi.turns.deliver`: the line is typed into the agent as a turn of its own, when its
  current turn ends. The service joins `TURN_DELIVERERS` for when it runs in its own process.
- **To the agent only (main).** It is the daemon's line: it is not posted in the person's Swarm chat, and the agent's
  answer to it is not posted there either (the Swarm posts only answers to the person's own messages,
  `cli/src/superTabs/agentReplies.ts`). The person reads the state on the button.
- **The copy.**
  - Ready: ``Your browser is ready: run `harness browser --help` ``
  - Stopped **(Ken)**: `Your person stopped your browser.` It names who stopped it, so the agent asks before it needs
    the browser again.
- **Once per start (spec).** The service keeps one mark per browser in its state file, `told`. A browser that is on and
  not told is owed the ready line; it is given when the browser is ready, and the mark is set once the line is
  written. The person's Stop clears the mark.
  - A daemon restart, and an agent that resumes with its browser on, type nothing: the mark is set.
  - An agent that had a browser before this change has no mark. It is told once, the first time its browser is ready
    under the new daemon. That is how it learns the CLI.
  - An agent whose conversation was replaced (a handoff to another engine) is not told again.
    `harness help agents` lists the command.
- **The stop line** is typed when the person's Stop turns off a browser whose agent runs, with two exceptions:
  - one of the agent's commands answered with the stop line: that output is the line, and nothing is typed;
  - the ready line is still waiting to be typed: it is taken back (`cancelDelivery`) and no stop line is typed. That
    agent never knew.
- **Not told otherwise:** a browser that fails, restarts after a crash or is created again for new settings. The next
  command says the state.
- **When it cannot be typed.** A line the core gives up on (the agent stayed busy 5 minutes) is delivered again, at
  most 3 times, then logged and counted. The browser stays owed, so the next time it gets ready the line is tried
  again.

### How an agent finds the command

- **(Ken) From its person's Start.** The ready line is the agent's first word about its browser, and it names
  `harness browser --help`. No other line reaches the agent: deliveries, their context lines and the own chat's plain
  text (`plainChat`) do not change.
- An agent that runs a command while its browser is off reads exit 4 and how to ask for it.
- `harness help agents` lists `harness browser --help` in one line, for an agent that looks.
- **Nothing at launch.** The launch arguments and the Swarm's basics do not change.

### The window fits the panel

- **(Ken) Why not the screen.** Changing the X screen to the panel's size would give odd sizes (1137x843) and a
  `screen.width` that changes mid-session, two signals bot checks weigh. A window's size changes all the time for
  real people, so `innerWidth` following the panel is ordinary.
- **The screen** stays the Device setting's size (`screen`, default 1920x1080), as today.
- **The window.** Chrome's window sits at 0,0 and takes the panel's size in screen pixels, at least 1024x640 and at
  most the screen. It is not maximized. Its size changes through the tool server's CDP connection
  (`Browser.getWindowForTarget`, then `Browser.setWindowBounds`), not through the window manager.
- **The request.** `agent_browser_window {agentId, width, height}` from Desktop, sealed beside `agent_browser_start`,
  allowed for `mayOpenBrowser`, answered only while the browser is ready. The machine clamps the size; it is not
  stored (Chrome keeps the window's last size in the profile). Any other asker, or a browser that is not ready: refused
  by name, and the panel keeps showing what it has.
- **When it is sent.** When the panel opens on a ready browser, and when the panel's size has stopped changing for
  300 ms (a drag sends one request, at its end). Closing the panel sends nothing: the window keeps its last size.
- **Two Desktops.** The last request wins. The other panel shows the same window and scales it to fit.
- **What the panel shows.** The viewer page clips noVNC to the window's rectangle at 0,0 (`clipViewport`, no viewport
  drag) at 1:1. When the window is smaller than the panel (the 1024x640 floor, or another Desktop's size), or the panel
  is larger than the screen, it scales that rectangle to fit, as `scaleViewport` does today. The page learns the
  window's size from the request's answer.
- **The agent** is not told: its pages reflow as on any resize. A screenshot is of the page, at its new size.
- **Failures.** A request that fails (`window_failed`: the CDP call did not answer in 5 s) is logged by name; the panel
  keeps scaling the whole screen, as today, and tries again at the next resize.
- **Cost.** One request per settled resize. The stream does not change: the rest of the screen is Chrome's backdrop and
  sends almost nothing.

### Desktop

- **New agent.** The Browser pill, its "Needs setup" line and its setup-on-Start step go. Create sends no `browser`.
- **The button.** `BrowserButton` after Terminal, for every agent that runs on one of the person's own machines. Not
  on a machine shared with them, not on the web build, not on Windows Desktop: as today.
  - Selected while its panel is open, as today.
  - **(spec)** It carries a running mark while the frame's `browser.state` is `ready`. The design doc names the mark,
    from what the design system already has. Its tooltip stays `Browser`; its accessible label says `Browser, running`.
- **The panel.**

```
Off                                   Running
┌──────────────────────────────┐      ┌──────────────────────────────────────┐
│ Browser          [⚙] [⎘]   ✕ │      │ Browser         ( Stop ) [⚙] [⎘]   ✕ │
│──────────────────────────────│      │──────────────────────────────────────│
│                              │      │ ┌──────────────────────────────────┐ │
│   A sandboxed Chrome the     │      │ │ mail.google.com                  │ │
│   agent drives               │      │ │                                  │ │
│          ( Start )           │      │ │ (the screen, as today)           │ │
│                              │      │ └──────────────────────────────────┘ │
└──────────────────────────────┘      └──────────────────────────────────────┘
```

| Frame's `browser` | Button | Panel |
|---|---|---|
| absent (off) | plain | `A sandboxed Chrome the agent drives` and **Start**. The gear works. |
| `setup`, `starting` | plain | today's progress, and **Stop** in the header |
| `ready` | running mark | the screen, and **Stop** |
| `failed` | plain | today's line and its button (Install, Retry), and **Stop** |

- **Stop** is in the header while the browser is on, in every state. It turns a failed browser off too.
- **A machine that cannot take the request.** `UNSUPPORTED` (an older CLI): `Update Harness on <machine> first`.
  A Windows machine: `Browser doesn't run on Windows yet`. For that, the daemon on Windows answers the two new
  requests with a name of its own, not `UNSUPPORTED`. Any other refusal: today's one grey line.
- **Closing the panel** (×, or opening Info, Instructions or Terminal) ends the stream and nothing else.
- **Set up Browser** opens from the panel's Install only. Its words do not change.
- **The design doc** (`desktop/design/desktop-design-system.md`) and its gallery change in the same pull request: the
  "Browser in New agent" entry goes; the agent chat's header, the Browser panel and Set up Browser entries are
  rewritten; the gallery draws the button plain and running, and the panel off, running and failed.

### What goes, and what stays for a while

**Goes, in this pull request:**

- `cli/src/agentClient/browserMcp.ts`, `cli/src/lib/browserMcpArgs.ts`, their specs, and `case 'browser-mcp'` in
  `cli/src/cli.ts`.
- The two places that add the launch arguments (`core/agents/create.ts:385-387`,
  `lib/launchOverrides.ts:326-327`). Their specs now check that no launch carries a browser argument.
- In `browser-tools.mjs`: the answers to `initialize`, `tools/list` and `ping`, which only an MCP client asked. The
  call line stays as it is; the service writes it now. A container still on the image from before runs the old tool
  server, which takes the same line, and a relay still running writes the same line to the new one.
- Desktop: `BrowserPill`, the form's browser state and `setUpBrowser` in `new_harness.dart`, `offersBrowser` in
  `HarnessLaunchIntegration` and `new_agent.dart`, and the `browser` argument of create in `app_state.dart`.
- The meaning "created with Browser" of the row's flag, and its comments.
- Words in `cli/AGENTS.md`'s process table ("one container per agent created with Browser"), and one line under the
  first spec's Status that points here.

**Stays for compatibility, each with its date in a comment:**

| Kept | For | Can go |
|---|---|---|
| `agent_create` reading `browser: true` and setting the flag | A Desktop from before this change, which still has the checkbox. The browser starts once the agent runs, and the agent is told the ready line. | 30 days after the Desktop release that drops the checkbox |
| `agent_browser_state` | The relay of an agent that was launched with the MCP argument and still runs. Its process is the old code in memory; it asks this for every call. | 30 days after the CLI release that carries this change |

**What really happens to an agent launched with MCP:**

- It keeps its browser: its row has the flag, which now reads "on".
- Until it restarts, its MCP tools work as before, through its old relay and `agent_browser_state`. It is also told
  the ready line once, so it can use the CLI at once.
- At its next run it is launched without the argument. Its MCP tools are gone, and the CLI is its one way.
- If its engine starts the MCP server again before that, `harness browser-mcp` no longer exists and the tools go
  then. The agent has been told the CLI.
- After `agent_browser_state` is removed, an agent that has run since before this change without one restart reads
  `Browser isn't available right now` from its MCP tools, and uses the CLI.

### Security

- **Who.** Start, stop, retry, settings and viewing: `mayOpenBrowser`, checked on the agent's machine. Guests are
  refused twice, as today (the guest policy, then this check). The agent's commands: a local asker, the agent of the
  proven pane, and never a guest's agent, all from what the daemon already holds.
- **Stop is not the agent's.** The CLI has no stop command, and `agent_browser_run` takes none. A process that writes
  its own client to the local socket is outside this, as it is for every local request.
- **Nothing new on the network.** Commands travel the local socket and `podman exec`. No port, and no frame type the
  backend's relay has to learn.
- **What is logged.** No `agent_browser_*` frame is logged. A command's arguments, a page's text, an address and a
  file's path never reach a log, a counter or an error sent to the apps. The service logs a command by its name and
  its outcome only.
- **A page's text is data.** A snapshot is printed as the page gave it. What an agent does with it is its skill's, as
  the first spec says. `navigate` still refuses anything but http and https.
- **Screenshots** are files of the person's own account in the agent's temporary folder (0700).

### Failures

Each has a name, a log line and a state shown to someone who can act. The browser's own failed states and their panel
copy are today's. New here:

| Failure | Named | Who sees what |
|---|---|---|
| Start or Stop sent to an older CLI | `UNSUPPORTED` | The person: `Update Harness on <machine> first` |
| Start sent to a Windows machine | the builder's name | The person: `Browser doesn't run on Windows yet` |
| Start or Stop from a guest or a machine share | `NOT_OWNER` | The person: `Only its owner can open this browser` |
| Start for an agent that does not run | `NOT_RUNNING` | The person: one grey line |
| A command while the browser is off | `OFF` | The agent: exit 4 and how to start |
| A command while it starts or failed | the state's name | The agent: exit 1 and the state's words |
| `start` where Browser is not set up | `needs_setup` | The agent: exit 5, ask your person. The person: Install in the panel |
| A command from a guest's agent | `NOT_ALLOWED` | The agent: exit 5, `Browser isn't available for this agent.` |
| A command from no agent's pane | `NO_AGENT` | The caller: exit 5 |
| A call the tool server did not answer in time | `tool_timeout` | The agent: exit 1, `<command> timed out`. The tool server is started again |
| The tool server cannot start | `tool_failed` | The agent: exit 1, `Browser is not reachable` |
| More than 8 commands waiting | `BUSY` | The agent: exit 1, try again |
| The daemon cannot be reached | `DAEMON_UNREACHABLE` | The agent: exit 1, the agent verbs' own line |
| A line that could not be typed after 3 tries | `notice_failed` | A log line and a counter. The agent learns the state from its next command |

### Measures (standard 8)

New counters, each a fixed name with no id, address, path, command name or text. The backend's list gains them first.

- `agent_browser_started`: the person's Start that turned a browser on.
- `agent_browser_stopped`: the person's Stop.
- `agent_browser_command_ok`, `agent_browser_command_failed`: the agent's tool calls.
- `agent_browser_notice_failed`: a line given up on.

Kept: every counter the first spec added. `agent_browser_enabled` still counts an agent's first start.
`agent_browser_failed_browser_limit` matters more now: any agent can be given a browser.

## Hot path (standard 4)

- **The daemon at rest.** One idle tool server per ready browser that was used, at most 8. It waits on its input and
  does nothing. The pull request shows the daemon's CPU at rest with a ready browser, before and after: within 1% of
  one core, and no higher than today, when the same process ran under the relay.
- **The agent's frame.** Unchanged: `browser` is sent only when it changes.
- **Swarm delivery.** Not touched.
- **Terminals, the relay.** Not touched. A command is one request on the local socket, and reads nothing outside the
  daemon.
- **A command's own cost.** A command is a new CLI process each time, where an MCP call was not. That is the price of
  decision 3. The pull request reports the wall time of `snapshot` on one page, p50 and p95, through the relay before
  and through the CLI after.

## Data and design checklist

- **Growth.**
  - No new store. The row's flag exists. The state file gains one mark per browser (`told`).
  - A settings entry can now exist before a first start. It is deleted with its agent, as today, including when the
    service was down at the time.
  - Files: at most 50 per agent in its temporary folder, which is swept as that folder is.
  - Limits, unchanged: at most 8 running browsers per daemon by memory, 4 viewers per browser. New: one tool server
    per ready browser, 8 commands waiting per browser.
- **Concurrency.** Per agent: start, stop, delete and retry run in the service's one queue for that agent; commands
  run one at a time per browser. Different agents run side by side. The flag is written inside that queue.
- **Read cost.** Only what changed: the frame's `browser` on a change. Nothing reads whole state. A command reads the
  registry row and the service's own memory.
- **Scale (10x).** Browsers per machine are bounded by its memory, not by the number of agents. Ten times the agents
  means the limit is reached more often: `agent_browser_failed_browser_limit` warns first, then
  `agent_browser_start_failed`. Nothing here adds load on the backend.
- **Compatibility.**
  - Backend first (the counters' names), then CLI, then Desktop.
  - Contracts are only extended: three requests for the apps (start, stop, window), one for the CLI. An older CLI
    answers `agent_browser_window` `UNSUPPORTED`, and the panel scales the whole screen, as today. `agent_create`'s `browser` and the
    frame's `browser` keep their shapes.
  - A Desktop from the last 30 days against the new CLI: its checkbox still gives a browser; its button shows for a
    browser that is on; it has no Start or Stop.
  - The new Desktop against an older CLI: a browser made with the checkbox still opens; Start and Stop say
    `Update Harness on <machine> first`.
  - The phone and the web are not affected.
- **Migration and rollback.** No migration: the flag and the state file keep their shapes, and a missing mark reads
  as not told. Rolling the CLI back: an agent with the flag gets its browser and its MCP argument as before; one the
  person stopped has none; a settings entry made while off stays until its agent is deleted. Rolling Desktop back brings the checkbox back, which the new CLI still honours.
- **Audience.** Enforced on the agent's machine: `mayOpenBrowser` for the person's requests; for the agent's, a local
  asker, the proven pane and a row that is not a guest's. The backend only relays.
- **Identity.** The browser runs on the agent's person's own machine, as that person. The lines are the daemon's own,
  typed into the agent: never sent as the person, never posted as the agent. No account or login of the machine's owner is
  used.
- **Failure.** See Failures.
- **Platforms.**
  - Agents' machines: macOS and Linux. Every process the service starts uses `ownProcessGroup()`, as today.
  - Windows: unsupported, as today. The daemon starts nothing and answers the new requests by name, and
    `harness browser` prints its Windows line and exits 5 before it starts anything, so no window can open.
  - Desktop: macOS and Linux. Windows Desktop, the web build and the phone draw nothing new.

## To measure first

Before the plan fixes its numbers, on Claude Code and on Codex, in a Swarm agent's default mode:

- how long a shell command may run by default, and how much of its output the engine keeps. These set the output cap,
  and whether `--help` must tell the agent to give `navigate` more time;
- that `harness browser …` runs without asking the person, as `harness send` does, and that the agent can read a
  JPEG saved in its temporary folder;
- what a typed line does when the agent is mid-turn or at a question, and whether the turn it starts raises a recap or
  a notification for the person. It should not;
- the CLI's own start time per command.

If an engine cannot read the image file, or asks the person for every command, this spec is revised before the CLI is
built.

Measured 2026-11-11 ([measurements](2026-11-11-browser-from-chat-measurements.md)). **(Ken)** The two lines are
delivered quiet: the turn each starts makes no recap and no notification; and `harness browser` joins the commands
both engines run without asking.

## Testing

- **CLI specs.**
  - Each command builds the tool call its schema asks for; wrong arguments, `start` and `stop` exit 2; `--help` runs with no
    daemon, lists every tool, and each of its examples parses as that command.
  - The pane: a command with no pane, and one that names another pane, are refused.
  - Each exit code and its line, from a fake daemon's answers.
  - `screenshot` writes a JPEG and prints only its path; long output is cut, saved and named; the folder keeps 50
    files.
- **Service specs**, with the fake `podman`.
  - `agent_browser_start` and `_stop`: refused for a guest and a machine share, allowed for the person's other
    Desktop; idempotent; the flag set and cleared; a stop keeps the volume and the settings and removes the rest.
  - `agent_browser_run`: refused to a remote asker; the pane gives the agent; refused for a guest's agent; allowed
    for an agent in a regular tab; answered with the backend and the Swarm unreachable; off, starting and failed each
    answer by name.
  - The tool server: started at the first command, once; started again after it exits; ended at stop; a stop answers
    every running and waiting command; a call past its limit is ended; commands run in order; the ninth waits no
    more.
  - Telling: once per start; nothing at a daemon restart or a resume; an entry with no mark is told once; the stop
    line, typed unless a command already said it; a ready line taken back by a stop; three tries, then the counter.
  - Settings read and saved while off.
- **Core specs.** The lifecycle when the flag changes while the agent runs; the link to the service's own process;
  no launch carries a browser argument (create and relaunch); `agent_create` with `browser: true` still starts one;
  `agent_browser_state` still answers.
- **Swarm host specs.** Unchanged: a delivery to an agent, its own 1:1 chat included, is typed exactly as before,
  with or without a browser.
- **End to end, real daemon, fake `podman`** (`cli/e2e/agentBrowser.e2e.ts`): create a plain agent; start its browser
  as the app does; see `ready`; run `harness browser snapshot` from the agent's pane; stop; see the frame without
  `browser` and the volume kept; run `harness browser snapshot` from the pane and see exit 4 with the
  ask-your-person line; start it again as the app does and see it ready (the agent is in no Swarm, and the backend
  is not reachable); delete; see everything removed. The fault case stays.
- **Real Podman** (`cli/e2e/agentBrowserPodman.e2e.ts`, run once by hand, `agent_browser_podman`). Its driver changes
  from the `browser-mcp` relay to `harness browser` run in the agent's pane.
  - Changed: the first case creates a plain agent and starts its browser with `agent_browser_start`; the tools case
    and the challenge case read the CLI's output, and the screenshot case reads the file.
  - Changed: "a stop keeps the login" becomes two cases, the person's Stop then Start, and the agent's stop then
    resume.
  - New: a command while off exits 4; `harness browser start` and `harness browser stop` exit 2; the person's Stop
    during a `wait` ends that command with the stop line.
  - Unchanged but for how tools are called: the stream, the host that cannot be reached, the crash restart, Device,
    the proxy, the delete.
- **The window** (service spec, fake tool server): `agent_browser_window` refused for a guest, a machine share and a
  browser that is not ready; the size clamped to 1024x640 and to the screen; a CDP call that does not answer is
  `window_failed`. Viewer page (`viewer.test.mjs`): clipped at 1:1 to the answered rectangle; scaled when the
  rectangle is smaller than the panel or the panel larger than the screen. Real Podman: a window request changes
  `window.innerWidth` and leaves `screen.width` as the Device setting.
- **Flutter, clicking as a person does.**
  - The window: opening the panel on a ready browser sends one window request with the panel's size; dragging the
    divider sends one request after the drag ends; closing the panel sends none.
  - An agent with no browser: the Browser button is there; press it, see off; press Start, see the request, then
    starting, then the screen; the button shows running; press Stop, see the request, then off.
  - Started from the person's other Desktop: the frame turns ready, the panel stays closed, the button shows
    running; press it, see the screen.
  - Needs setup: Start, then Install on this computer opens Set up Browser; from another computer, the line.
  - An older CLI: Start shows `Update Harness on <machine> first`.
  - No button on a shared machine, on the web build, on Windows.
  - New agent shows no Browser pill, and create sends no `browser`.
  - Gallery goldens, light and dark, with the design doc in the same pull request.
- **By hand, recorded in the pull request,** on macOS and on Linux, with a real Claude Code agent and a real Codex
  agent that were both running before the update and are not restarted:
  - press Start, see the line typed, ask for a page's title, see the agent use the CLI;
  - ask for a screenshot and see each engine read the file;
  - press Stop mid-task, see the line, and see the login still there after the next Start;
  - press Stop, ask for more work in the web app, and see the agent ask for the browser in chat;
  - with a new agent whose browser was never on, ask "check gmail" in its own 1:1 chat, see that message arrive exactly
    as typed, then press Start and see the agent use the CLI after the ready line.

## Left to the builder

- The request names, inside `agent_browser_`, and the error names.
- How the service asks the core to set the flag, and its query for the service's own process.
- Who writes the screenshot and the full-snapshot files, the CLI or the service, and their names.
- The output cap's number, from the measurements.
- The running mark on the button, the Stop control's shape, and any copy that reads better under the naming rules.
- How the typed line is kept from raising a recap or a notification, if the core can tell it apart.
- Whether `agent_browser_retry` folds into start. This spec keeps it.

## Open for Ken

Each has the answer this spec takes.

1. **An agent in no Swarm has no chat, so no Browser button.** It cannot get a browser. Taken: accepted.

Closed: how an agent finds the command (decision 5), and that only the person starts it (decision 4).
