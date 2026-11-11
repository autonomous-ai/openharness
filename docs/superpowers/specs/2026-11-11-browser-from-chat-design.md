# Browser from chat: any agent gets its Browser when needed, and drives it with a CLI

**Status:** design, not built.
**Date:** 2026-11-11
**Changes:** [Agent Browser](2026-11-10-agent-browser-design.md) (PR #3822). Everything that spec says about Podman,
setup, the container, the image, the proxy, the device, the settings, human input, challenge detection, the stream and
its viewer stands. This spec changes how a browser is turned on, how it is turned off, and how the agent drives it.
**Scope:** agents on macOS and Linux, Desktop on macOS and Linux, as today.

Marks: **(Ken)** decided by Ken in the 2026-11-11 brainstorm. **(main)** the main session's call. **(spec)** this
spec's call. Ken may override every (main) and (spec).

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
- **The agent may start it.** `harness browser start`, when its person asks for work that needs one.
- **Only the person stops it.**
- **The agent is told.** One line in its chat when its browser is ready, one when its person stops it.
- **Plain agents.** No launch argument, no MCP server, no checkbox.

## Non-goals

- Windows, the web build and the phone. They stay as they are (no button, no browser).
- Stopping a browser that sits idle. It runs until its person stops it or its agent ends.
- The agent installing Podman. That needs the person's password.
- Opening the panel by itself when the agent starts the browser.
- A browser for an agent that is not running, for an agent in a regular tab (it has no chat), or in the terminal
  interface.
- New browser tools. The commands are today's eleven tools, plus `start`.
- Any change to the container, the image, the stream, the proxy, the device, challenge detection or the browser limit.
- A Browser button for teammates or guests.

## Anti-goals (a failure even if it works)

- An agent that can stop its browser, or one agent's command reaching another agent's browser.
- A browser nobody can see or stop.
- An MCP server or any launch argument added to an agent for the browser.
- A line typed into an agent more than once per start, or at every daemon restart: that spends the person's tokens
  without them knowing.
- A login lost because the person pressed Stop.
- Image bytes on the agent's terminal, or a snapshot that floods its context.
- A browser started on a machine whose person did not ask for it and cannot see it (a guest's agent, an agent placed on
  a contributed machine).

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
  `browser` and its machine is the person's own (`desktop/lib/super_tabs/view.dart:2835-2851, 2976`). The frame's
  `browser` is `{state, step?, error?}`, present only for an agent with a browser.
- **Text into an agent.** `CoreApi.turns.deliver(agentId, text, deliveryId)` (`cli/src/core/api.ts:246`): the path
  Agent Messages, the Wi-Fi device and the orchestrator use. A delivery waits for the agent's turn to end, at most 5
  minutes (`cli/src/lib/sessionInput.ts:16`), and its outcome is heard through `onDelivery`. A service in its own
  process may deliver only when it is in `TURN_DELIVERERS` (`core/api.ts:934`).
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
4. **(Ken)** The agent may start the browser itself. Stop is the person's only: the agent has no stop command.
5. **(Ken)** When the browser starts, Harness tells the agent one line in its chat. When the person stops it, one line.
6. **(main)** Stop keeps the profile, so the login survives a later start. Only deleting the agent removes it.
7. **(main)** Only the agent's own person starts, stops and opens it from Desktop, enforced on the agent's machine
   (`mayOpenBrowser`). Guests are refused.
8. **(main)** `harness browser start` on a machine where Browser is not set up fails with a clear line. The agent
   cannot install. The panel shows Install, as today.
9. **(main)** When the agent starts the browser the panel does not open. The button shows that the browser runs.
10. **(main)** The browser runs until its person stops it, or its agent stops or is deleted. No idle stop.
11. **(main)** Closing the panel only hides it. Stop is its own control in the panel.
12. **(main)** Kept as they are: the settings per agent, the memory-based limit, owner-only viewing, challenge
    detection that has the agent ask its person in chat.
13. **(main)** An older Desktop that still sends `browser: true` at create: the browser starts once the agent runs.
14. **(main)** An agent launched with the MCP argument keeps working until it restarts. What really happens is under
    "What goes, and what stays for a while".

## Design

### On and off

- **(spec) One record.** The registry row's `browser` flag now means "this agent's Browser is on". It is set by a
  start (the person's, the agent's, or the create flag of an older Desktop) and cleared only by the person's Stop. The
  field keeps its name and shape, so nothing is migrated.
- **(spec) On survives the agent's stop.** A browser that is on when its agent stops is stopped with it, as today,
  and starts again when that agent runs again (a resume, an engine restart, a machine restart). A daemon restart
  leaves it running and takes it up again. That is today's code path (`createAgentBrowserLifecycle`), unchanged. Only
  the person's Stop turns it off.
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
| `agent_browser_run {pane, command, args}` | the agent's CLI | a local asker only | `start`, or one tool call, for the agent of that pane. Never stop. |

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
- **(spec) Whose agent.** Every command, `start` included, is refused with exit 5 for:
  - a guest's agent (the row's `guest`) and any agent that runs for someone other than the machine's own person: the
    machine's Podman, memory and network are its owner's, and only its owner could see that browser;
  - an agent with no chat on Desktop (one in a regular tab): nobody would have a button to see or stop its browser.
  - How the row tells each case is left to the builder, with a test per kind of agent the registry has.

**Commands.** Each maps to one tool in `browser-tools.json`, which stays the one source for the names, the arguments
and the help.

| Command | Tool | Prints |
|---|---|---|
| `start` | — | ``Your browser is ready: run `harness browser --help` `` |
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
| `--help` | — | the commands, one line each, from `browser-tools.json` |

- There is no `stop`. `harness browser stop` is a wrong command (exit 2).
- `--help` needs no daemon and no browser.
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
  than its tool, then ends it and starts the tool server again. The CLI waits 5 s more than the service. `start` waits
  at most 100 s for ready. So no command runs longer than 100 s.
- **One at a time (spec).** Commands for one browser run in the order they arrive, one at a time: the page is one
  shared thing. At most 8 wait; one more is refused with `Browser is busy. Try again.`

**Exit codes**, the agent verbs' own (`EXIT`, `cli/src/agentClient/commands.ts:130`):

| Code | Means | What the agent reads |
|---|---|---|
| 0 | done | the tool's words |
| 1 | failed | the tool's error (`Element not found; take a new snapshot`), or the browser's state: `Browser is starting`, `Podman is not running`, … |
| 2 | wrong command or arguments | the usage line |
| 4 | the browser is off | `Your browser is off. Start it: harness browser start`, or `Your person stopped your browser.` when the stop came during the command |
| 5 | refused; do not retry | see below |
| 124 | `start` only: still starting when its wait ended | `Browser is starting. You'll be told here when it's ready.` |

Refusals (5): `Browser isn't set up on this machine. Ask your person to open Browser in your chat and install it.` ·
`Browser isn't available for this agent.` · `Run harness browser from your own Harness pane.` ·
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

**The agent starts it.**

1. The agent runs `harness browser start`. The service checks the pane and who may start, sets the flag and starts
   the browser, as for the person.
2. The command waits. Ready: it prints the ready line and exits 0. Failed: it prints why (exit 1, or 5 for
   `needs_setup`). Still starting after 100 s (an image build, a setup): exit 124, and the ready line comes in chat.
3. The panel does not open. The button shows that the browser runs.
4. A start that failed leaves the browser on and failed, so the person's panel shows what the machine lacks and the
   button for it (Install, Retry).

**The person stops it.**

1. **Stop** in the panel's header sends `agent_browser_stop`. No confirmation: the login is kept.
2. The agent's machine clears the flag and stops the browser: the viewers' streams end, the tool server ends, the
   container, its network and its proxy secret are removed. The volume and the settings stay.
3. The frame's `browser` goes. The panel shows off, the button is plain.
4. The agent is told.

**The agent stops or is deleted.** As today: a stop stops the browser and keeps the flag and the profile; a delete
removes the container, the volume, the network, the secret and the settings.

**At the same time.**

- *The person and the agent both start it.* Both go through the service's one queue per agent, and start is
  idempotent. One browser starts, and the agent is told once.
- *Stop while it starts.* The start ends without starting anything (the queue's generation guard, as today). An
  agent's `start` that was waiting prints the stop line.
- *Stop while a command runs.* The tool server ends with the container. Every command that was running or waiting
  answers `Your person stopped your browser.` (exit 4).
- *Start right after Stop.* It waits for the stop in the queue, then starts a new container on the same profile.
- *Two Desktops.* The same queue. The last request wins, and both read the same frame.
- *A settings change or a crash while a command runs.* The container is created again, as today. That command fails
  with `Browser is starting`, and the next one after ready works. The refs are gone: `Element not found; take a new
  snapshot`.

### Telling the agent

- **The path (spec).** `CoreApi.turns.deliver`: the line is typed into the agent as a turn of its own, when its
  current turn ends. The service joins `TURN_DELIVERERS` for when it runs in its own process. It is the daemon's line:
  it is not posted in the person's Swarm chat, and the agent's answer to it is not posted there either (the Swarm
  posts only answers to the person's own messages, `cli/src/superTabs/agentReplies.ts`).
- **The copy.**
  - Ready: ``Your browser is ready: run `harness browser --help` ``
  - Stopped **(spec)**: `Your person stopped your browser.` It names who stopped it, so the agent does not start it
    again unless asked. (Ken's example was "Your browser stopped".)
- **Once per start (spec).** The service keeps one mark per browser in its state file, `told`. A browser that is on and
  not told is owed the ready line; it is given when the browser is ready, and the mark is set once the line is
  written. The person's Stop clears the mark.
  - When the agent's own `start` is still waiting as the browser gets ready, the command's output is the line.
    Nothing is typed: a second line would start a turn nobody asked for.
  - A daemon restart, and an agent that resumes with its browser on, type nothing: the mark is set.
  - An agent that had a browser before this change has no mark. It is told once, the first time its browser is ready
    under the new daemon. That is how it learns the CLI.
  - An agent whose conversation was replaced (a handoff to another engine) is not told again. `harness help agents`
    lists `harness browser --help` in one line, which is also how an agent that was never told finds `start`.
- **The stop line** is typed when the person's Stop turns off a browser whose agent runs, with two exceptions:
  - one of the agent's commands answered with the stop line: that output is the line, and nothing is typed;
  - the ready line is still waiting to be typed: it is taken back (`cancelDelivery`) and no stop line is typed. That
    agent never knew.
- **A `start` that ended still starting** (exit 124) promised an answer. That agent is told either way: the ready
  line, or `Your browser didn't start: <the state's words>`.
- **Not told otherwise:** a browser that fails, restarts after a crash or is created again for new settings. The next
  command says the state.
- **When it cannot be typed.** A line the core gives up on (the agent stayed busy 5 minutes) is delivered again, at
  most 3 times, then logged and counted. The browser stays owed, so the next time it gets ready the line is tried
  again.

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
  proven pane, and only an agent of the machine's own person that has a chat.
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
| A command from an agent that may not have a browser | `NOT_ALLOWED` | The agent: exit 5 |
| A command from no agent's pane | `NO_AGENT` | The caller: exit 5 |
| A call the tool server did not answer in time | `tool_timeout` | The agent: exit 1, `<command> timed out`. The tool server is started again |
| The tool server cannot start | `tool_failed` | The agent: exit 1, `Browser is not reachable` |
| More than 8 commands waiting | `BUSY` | The agent: exit 1, try again |
| The daemon cannot be reached | `DAEMON_UNREACHABLE` | The agent: exit 1, the agent verbs' own line |
| A line that could not be typed after 3 tries | `notice_failed` | A log line and a counter. The agent learns the state from its next command |

### Measures (standard 8)

New counters, each a fixed name with no id, address, path, command name or text. The backend's list gains them first.

- `agent_browser_started_person`, `agent_browser_started_agent`: a start that turned a browser on.
- `agent_browser_stopped`: the person's Stop.
- `agent_browser_command_ok`, `agent_browser_command_failed`: the agent's tool calls.
- `agent_browser_notice_failed`: a line given up on.

Kept: every counter the first spec added. `agent_browser_enabled` still counts an agent's first start.
`agent_browser_failed_browser_limit` matters more now: any agent can ask for a browser.

## Hot path (standard 4)

- **The daemon at rest.** One idle tool server per ready browser that was used, at most 8. It waits on its input and
  does nothing. The pull request shows the daemon's CPU at rest with a ready browser, before and after: within 1% of
  one core, and no higher than today, when the same process ran under the relay.
- **The agent's frame.** Unchanged: `browser` is sent only when it changes.
- **Terminals, Swarm delivery, the relay.** Not touched. A command is one request on the local socket.
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
- **Read cost.** Only what changed: the frame's `browser` on a change; a waiting `start` is answered by the state
  change, not by a poll. Nothing reads whole state.
- **Scale (10x).** Browsers per machine are bounded by its memory, not by the number of agents. Ten times the agents
  means the limit is reached more often: `agent_browser_failed_browser_limit` warns first, then
  `agent_browser_start_failed`. Nothing here adds load on the backend.
- **Compatibility.**
  - Backend first (the counters' names), then CLI, then Desktop.
  - Contracts are only extended: two requests for the apps, one for the CLI. `agent_create`'s `browser` and the
    frame's `browser` keep their shapes.
  - A Desktop from the last 30 days against the new CLI: its checkbox still gives a browser; its button shows for a
    browser that is on; it has no Start or Stop.
  - The new Desktop against an older CLI: a browser made with the checkbox still opens; Start and Stop say
    `Update Harness on <machine> first`.
  - The phone and the web are not affected.
- **Migration and rollback.** No migration: the flag and the state file keep their shapes, and a missing mark reads
  as not told. Rolling the CLI back: an agent with the flag gets its browser and its MCP argument as before; one the
  person stopped has none; a settings entry made while off stays until its agent is deleted. Rolling Desktop back
  brings the checkbox back, which the new CLI still honours.
- **Audience.** Enforced on the agent's machine: `mayOpenBrowser` for the person's requests, a local asker and the
  proven pane for the agent's. The backend only relays.
- **Identity.** The browser runs on the agent's person's own machine, as that person. The lines are the daemon's own,
  typed into the agent: never sent as the person, never posted as the agent. No account or login of the machine's
  owner is used.
- **Failure.** See Failures.
- **Platforms.**
  - Agents' machines: macOS and Linux. Every process the service starts uses `ownProcessGroup()`, as today.
  - Windows: unsupported, as today. The daemon starts nothing and answers the new requests by name, and
    `harness browser` prints its Windows line and exits 5 before it starts anything, so no window can open.
  - Desktop: macOS and Linux. Windows Desktop, the web build and the phone draw nothing new.

## To measure first

Before the plan fixes its numbers, on Claude Code and on Codex, in a Swarm agent's default mode:

- how long a shell command may run by default, and how much of its output the engine keeps. These set the output cap,
  and whether `--help` must tell the agent to give `navigate` and `start` more time;
- that `harness browser …` runs without asking the person, as `harness send` does, and that the agent can read a
  JPEG saved in its temporary folder;
- what a typed line does when the agent is mid-turn or at a question, and whether the turn it starts raises a recap or
  a notification for the person. It should not;
- the CLI's own start time per command.

If an engine cannot read the image file, or asks the person for every command, this spec is revised before the CLI is
built.

## Testing

- **CLI specs.**
  - Each command builds the tool call its schema asks for; wrong arguments and `stop` exit 2; `--help` runs with no
    daemon.
  - The pane: a command with no pane, and one that names another pane, are refused.
  - Each exit code and its line, from a fake daemon's answers.
  - `screenshot` writes a JPEG and prints only its path; long output is cut, saved and named; the folder keeps 50
    files.
- **Service specs**, with the fake `podman`.
  - `agent_browser_start` and `_stop`: refused for a guest and a machine share, allowed for the person's other
    Desktop; idempotent; the flag set and cleared; a stop keeps the volume and the settings and removes the rest.
  - `agent_browser_run`: refused to a remote asker; the pane gives the agent; refused for a guest's agent and for
    one with no chat; off, starting and failed each answer by name.
  - The tool server: started at the first command, once; started again after it exits; ended at stop; a stop answers
    every running and waiting command; a call past its limit is ended; commands run in order; the ninth waits no
    more.
  - Telling: once per start; by the command's output when its `start` waited, typed otherwise; nothing at a daemon
    restart or a resume; an entry with no mark is told once; the stop line, typed unless a command already said it; a
    ready line taken back by a stop; a `start` that ended still starting told a failure; three tries, then the
    counter.
  - Settings read and saved while off.
  - The person and the agent starting at once start one browser and tell once.
- **Core specs.** The lifecycle when the flag changes while the agent runs; the link to the service's own process;
  no launch carries a browser argument (create and relaunch); `agent_create` with `browser: true` still starts one;
  `agent_browser_state` still answers.
- **End to end, real daemon, fake `podman`** (`cli/e2e/agentBrowser.e2e.ts`): create a plain agent; start its browser
  as the app does; see `ready`; run `harness browser snapshot` from the agent's pane; stop; see the frame without
  `browser` and the volume kept; delete; see everything removed. The fault case stays.
- **Real Podman** (`cli/e2e/agentBrowserPodman.e2e.ts`, run once by hand, `agent_browser_podman`). Its driver changes
  from the `browser-mcp` relay to `harness browser` run in the agent's pane.
  - Changed: the first case creates a plain agent and starts its browser with `agent_browser_start`; the tools case
    and the challenge case read the CLI's output, and the screenshot case reads the file.
  - Changed: "a stop keeps the login" becomes two cases, the person's Stop then Start, and the agent's stop then
    resume.
  - New: the agent starts an off browser with `harness browser start`; a command while off exits 4; `harness browser
    stop` exits 2; the person's Stop during a `wait` ends that command with the stop line.
  - Unchanged but for how tools are called: the stream, the host that cannot be reached, the crash restart, Device,
    the proxy, the delete.
- **Flutter, clicking as a person does.**
  - An agent with no browser: the Browser button is there; press it, see off; press Start, see the request, then
    starting, then the screen; the button shows running; press Stop, see the request, then off.
  - The agent starts it: the frame turns ready, the panel stays closed, the button shows running; press it, see the
    screen.
  - Needs setup: Start, then Install on this computer opens Set up Browser; from another computer, the line.
  - An older CLI: Start shows `Update Harness on <machine> first`.
  - No button on a shared machine, on the web build, on Windows.
  - New agent shows no Browser pill, and create sends no `browser`.
  - Gallery goldens, light and dark, with the design doc in the same pull request.
- **By hand, recorded in the pull request,** on macOS and on Linux, with a real Claude Code agent and a real Codex
  agent that were both running before the update and are not restarted:
  - press Start, see the line typed, ask for a page's title, see the agent use the CLI;
  - ask for a screenshot and see each engine read the file;
  - with the browser off, ask for work in a web app and see the agent start it;
  - press Stop mid-task, see the line, and see the login still there after the next Start.

## Left to the builder

- The request names, inside `agent_browser_`, and the error names.
- How the service asks the core to set the flag, and its query for the service's own process.
- How the row tells an agent that may not start a browser.
- Who writes the screenshot and the full-snapshot files, the CLI or the service, and their names.
- The output cap's number, from the measurements.
- The running mark on the button, the Stop control's shape, and any copy that reads better under the naming rules.
- How the typed line is kept from raising a recap or a notification, if the core can tell it apart.
- Whether `agent_browser_retry` folds into start. This spec keeps it.

## Open for Ken

Each has the answer this spec takes; a different answer changes a few lines, not the design.

1. After you press Stop, may the agent start the browser again on its own? Taken: yes (decision 4), and the stop line
   names you so it does not unless asked.
2. A browser that was on when its agent stopped: back with the agent, or off until started again? Taken: back.
3. The stop line: `Your person stopped your browser.`, or your "Your browser stopped"? Taken: the first.
4. An agent in a regular tab has no chat and no button. Taken: its commands are refused. The other answer is a
   Browser button for regular tabs, which is a new surface.
5. Should the person see the two lines in the chat? Taken: no; the button shows the state.
