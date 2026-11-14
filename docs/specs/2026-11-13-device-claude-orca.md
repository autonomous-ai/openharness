# The dial shows and talks to agents outside Harness (Diego, 2026-11-13)

Wave 1a of the device integration roadmap, on top of wave 0
([the Harness device without the app](2026-11-13-device-without-the-app.md)). Wave 0 lists the agents running
anywhere on this computer and shows their state; wave 1a lets the dial show what a Claude Code permission prompt waits
for, talk to an idle agent, and tap to open it in Orca.

## Changed after the dial check (Diego, 2026-11-14)

On a real round dial (firmware 0.1.0 and wave 0's 0.1.0-dev, Focus-only since #3848) nothing opens a question's
choices: the face shows the question in the recap's place and a tap there starts voice, by design ("the answer is given
in the app, so the face grows no buttons", `ui_habitat.c`). So Diego decided, replacing this spec's approvals:

- **The firmware stays as released.** No firmware change in wave 1a.
- **The dial only shows a permission prompt,** never answers it. The person answers in the app it is in (the terminal,
  Orca, the Claude app). The plugin's `PermissionRequest` hook only tells the daemon, then decides nothing at once; no
  path anywhere lets the dial approve a command.
- **Voice reaches a busy agent too,** as it already does for a Harness agent: the words are delivered and the engine
  queues them for after its turn. Only an ended session is refused (its terminal may hold a shell by then).
- **Opening an agent from the dial opens its app and focuses its pane,** with no new permission:
  - **Every host with a known bundle id** at least comes forward (`open -b <bundle id>` on macOS), Warp, Alacritty,
    VS Code and Cursor included.
  - **Focus on the exact pane** where a way needs no permission: Orca (`orca terminal switch`, then Orca forward);
    the Claude app (`com.anthropic.claudefordesktop`, recognised by `__CFBundleIdentifier`; its session through
    `claude://code/continue?session=<CLAUDE_CODE_HOST_SESSION_ID>`, the hint joining the allowlist once checked not to
    be a secret); WezTerm (`wezterm cli activate-pane --pane-id <WEZTERM_PANE>`); herdr (`herdr agent focus
    <HERDR_PANE_ID>`).
  - **The Claude app's continue link is undocumented** (read from the app, not published): when it fails or opens
    nothing, the app still comes forward and the daemon logs one line with no session id. It may change with any app
    release.
  - **Not in wave 1a:** Terminal, iTerm2 and Ghostty (AppleScript, a new Automation permission), tmux, Zellij and
    kitty (an app-side setting or more hints).
- The sections below that described approving from the dial (the 5-minute wait, the card's Allow and Deny, the
  `terminalOnly` rules, the approval route and queue) are replaced by "Waiting for permission".

## Why

Wave 0 shows Claude Code in Orca or Ghostty on the dial, but the dial can only watch it: a tap says "See it in Orca".
The two things a person most wants from across the room are to let a waiting agent go on, and to tell an idle one what
to do next.

## Decided (Diego, 2026-11-13)

- **Scope.** The Claude Code plugin and the Orca adapter. Codex's own adapter (`codex queue`) and herdr come later.
- **The dial shows a waiting permission prompt; it never answers one** (Diego, 2026-11-14; above).
- **A plugin of its own,** `harness-device`, in this repository's marketplace (`.claude-plugin/marketplace.json`,
  `plugins/harness-device/`), not inside the `harness` plugin. It holds the permission hook and the mod; one install, one
  consent.
- **Consent and install** happen in the Harness Device menu-bar app (wave 1b, another run). This run gives it the CLI:
  `harness device claude status --json` → `{ supported, installed, enabled, claudeVersion }`,
  `harness device claude enable`, `harness device claude disable`. No menu-bar UI here.
- **The permission hook only reports; the mod carries voice.**
- **Orca: actions only** (option A). Harness already sees Claude Code in Orca through its hooks (wave 0); the adapter adds
  voice (`orca terminal send`) and open (`orca terminal switch`) for those agents, found by their Orca terminal handle.
  No polling of Orca.
- **Voice reaches an agent whether it is idle or working** (Diego, 2026-11-14, replacing "only when not working"): the
  engine queues words given during a turn, as for a Harness agent. A session that has ended is refused.
- **Claude Code in a Harness pane keeps today's path:** the pane watcher sees the prompt and the dial keys the answer;
  the hook stands aside for those sessions.
- **The plugin reaches Harness through its launcher:** `~/.local/bin/harness` first, then `harness` on `PATH`; with
  neither, the hook decides nothing and the mod stays idle.
- **Platforms:** macOS and Linux. Windows later.
## Decided, continued

- **The waiting line** names the prompt and the app to answer in: "<summary> · answer in {Host}".

## The spike (2026-11-13, Claude Code 2.1.323)

A throwaway mod and hook, run in a real interactive session:

1. **The mod's `tool.check` cannot carry approvals.** Holding the check on a timer is cut at the hook's 10 s budget; holding
   it on `$.http.fetch` works and its `allow` lets the call run. But in auto mode `tool.check` sees the same `ask`
   before the classifier, so it would hold calls the classifier then allows; and `$.ui.ask` cannot be dismissed when the
   dial answers first: the stale dialog stays.
2. **`PermissionRequest` carries them.** A command hook in the plugin's `hooks/hooks.json`:
   - runs only when a person is about to be asked (in auto mode, only after the classifier sends the call to the person);
   - the terminal's own prompt appears while the hook still waits;
   - the hook's `allow` closes that prompt and the call runs;
   - when the person answers the prompt first, Claude Code kills the hook at once, and its open request to the daemon
     closes with it;
   - a hook that ends with no decision leaves the prompt as it was.
3. **The built-in guard** (`cc-plugin-sec-default`, loaded with managed settings or a Team or Enterprise login) passes
   over `classic.*` hooks in a user's mod, but not over a plugin's `hooks/hooks.json` hooks. A `PermissionRequest`
   `allow` still yields to deny and ask rules (Claude Code's hooks reference). In the Desktop app and VS Code the hook
   runs beside the host's own prompt, and whichever decides first applies.

## Goal

With Claude Code running in Orca, Ghostty or any terminal on this computer and the plugin enabled, a person at the dial
sees which agent waits for permission and for what, says the next prompt to an idle agent, and taps an agent in Orca to
bring its terminal forward. Every prompt is answered in its own app.

## Design

### Data flow

```
Claude Code (outside a Harness pane), plugin harness-device enabled
  ├─ PermissionRequest hook → hooks/asked → `harness device claude asked`   (fire and forget, decides nothing)
  │     POST /api/hook/observed { event: "asked", summary } ── core: check, bound, forward ──▶ devices: the agent waits,
  │     with the line "<summary> · answer in {Host}"; the session's next hook event or its transcript check
  │     clears it
  └─ mod (hooks/device.js), voice only
        POST /api/hook/inbox (long poll ≤ 25 s) ── core ──▶ devices: Inbox ◀── a transcript for this session
        ◀── { text } → $.prompt.submit({ text, asUser: true })

Claude Code or Codex in an Orca terminal (hint ORCA_TERMINAL_HANDLE from the wave 0 hook)
  devices: Orca actions ── `orca terminal send --terminal h --text … --enter --wait-submit 5` (voice)
                        └─ `orca terminal switch --terminal h` (open)
```

### The plugin (`plugins/harness-device/`)

- `.claude-plugin/plugin.json`: name `harness-device`; added to `.claude-plugin/marketplace.json` beside `harness`.
- `hooks/hooks.json`: `modules: ["./device.js"]`, and one `PermissionRequest` command hook for every tool, running
  `"${CLAUDE_PLUGIN_ROOT}/hooks/asked"` with a 5 s timeout.
- `hooks/asked` (POSIX sh, a few lines): runs `~/.local/bin/harness device claude asked` if it is executable, else
  `harness device claude asked` if `harness` is on `PATH`, else exits 0 with no output. The launcher reads stdin
  itself; the script passes no environment of its own.
- `hooks/device.js`, the mod (voice only; below).
- A README with what it does (the dial shows a waiting prompt and gives an idle agent a spoken prompt), what it never
  does (answer a prompt, approve anything, send anything off the computer), and how to remove it.

### Waiting for permission

**The hook's client, `harness device claude asked`** (hidden from `--help`; CLI only, never in the daemon):

- Reads the hook's stdin JSON, at most 256 KB; anything else is nothing sent.
- Skips the tools that are the person's anyway (`AskUserQuestion`, `ExitPlanMode`): nothing sent.
- Builds a summary of one line, at most 200 bytes of UTF-8, cut on a character boundary: Bash → the command's first
  non-blank line, with " …" when there is more; Edit, Write, NotebookEdit, Read → the file path; WebFetch → the URL's
  host; an MCP tool → its server and tool name; anything else → the tool's name. The rest of `tool_input` stays in the
  hook.
- Posts `{ engine: "claude", sessionId, event: "asked", tool, summary, cwd }` to `/api/hook/observed` over the daemon's
  Unix socket only (no socket, nothing sent), fire and forget: it waits only until the request is written, 1 s at most.
- **Prints nothing and exits 0, always.** It reads no answer from the daemon, so nothing the daemon or anyone else sends
  can become a decision; the prompt is the app's.
- Sends no environment variable: Orca's `ORCA_PAIRING_CODE` and `ORCA_AGENT_SESSION_SPAWN_TOKEN` sit in the same
  environment and must never leave the hook.

**The core.** `/api/hook/observed` (wave 0's route, `core/observedHook.ts`) gains the event `asked` with two optional
fields, `tool` ≤ 64 characters and `summary` ≤ 200 bytes, checked and bounded like the others and forwarded as an
observed event. The core keeps nothing. There is no approval route, no held request and no answer path.

**In the devices process.** An `asked` event makes the observed agent `needs-you` with the activity line
"<summary> · answer in {Host}" (the host's display name: Orca, Ghostty, Terminal, …), through the same activity path as
wave 0's "Waiting for you · {Host}", which it replaces for that session, so the two never show as two lines or flicker.
The next hook event of that session (UserPromptSubmit, Stop, StopFailure, SessionEnd) clears it, and so does the open
session's transcript check (every 3 s), which sees a prompt answered in the app. PostToolUse is not used: Harness does
not run its hook script on every tool call, and adding one would start a process per tool call. A character the round
dial cannot draw becomes `?`. The summary goes only to the dial over its cable: never to the backend, the phone, the
router or a log line.

**With a window open nothing changes,** as in wave 0: the dial holds the active tab, which has no observed agents.

### Voice

**The mod (`hooks/device.js`).** On `session.start` it runs the launcher once (`harness device claude link --json`,
hidden) to learn the daemon's Unix socket path (a request over that socket is already trusted, so no credential is
handed out), then keeps one long poll open from a timer:

- `POST /api/hook/inbox { sessionId }` over that socket (`$.http.fetch` with `socketPath`); the daemon holds it up to
  25 s and answers `{ text }` or nothing.
- On `{ text }`: `$.prompt.submit({ text, asUser: true })`, not awaited inside the loop.
- No launcher, no daemon, or no device (the core answers at once when the devices process is not running): try again in
  60 s. A route this daemon does not know (an older Harness): try again in 10 minutes.
- It registers no tool, command, interface or `classic.*` hook, and touches no settings.

**The core route `/api/hook/inbox`** (in `hookServer.ts` beside `/api/hook/observed`, with the same authentication
(`hookOk`); its checks and forwarding live in `core/deviceHookCalls.ts`, listed in `src/architecture.coreFiles.txt`;
it first checks that the devices process is connected and a dial is watching, and otherwise answers 503 at once, so
it never starts the devices process): `sessionId` ≤ 128, body ≤ 1 KB, one open poll per session (a newer one replaces
it); each poll gets an id and goes to the devices process as a call with a 25 s deadline. When the client goes first, or
a newer poll replaces it, the core sends `inbox.gone { pollId }`, so the devices process always knows which polls are
open.

**In the devices process.** An observed agent can take voice (`v`) when its session has a poll open, or one closed under
35 s ago (the mod opens the next at once), or when it has an Orca terminal handle. A transcript for it goes:

1. Refused when the session has ended ("<name> did not answer."). Idle or working, the words go on: the mod's
   `$.prompt.submit` waits for the turn to end before it starts the next, and Claude Code queues what is typed into its
   running TUI. Through Orca, an agent waiting on a permission prompt is refused ("<name> is waiting for your
   answer in {Host}."): text and Enter typed then would answer the prompt itself (a leading digit can even pick "don't
   ask again"), and the dial never approves anything; Harness's own path refuses the same case. Only Claude Code's hooks
   say a prompt opened, so through Orca any other engine is refused while it works ("<name> is busy. Say it when it is
   done."): Codex's approval overlay takes `y` or Enter as an approval, and no hook of it tells. The mod's route has no
   such risk and delivers in every state.
2. To the mod when its session has a poll open, or opens one within 5 s: the text is the answer to that poll, and that is
   "sent" (the mod sends no acknowledgement). No poll in 5 s: "<name> did not answer."
3. Else to Orca (`orca terminal send … --enter --wait-submit 5`).

**The dial's voice path.** Today a transcript for an agent goes through `CableHost.sendTurn` (synchronous) to the fleet
and the core, and `lacks('v')` refuses an agent without `v` (wave 0). `sendTurn` becomes async: for an agent the registry
holds outside Harness it calls that source's `send` and answers its `SendResult`; Harness agents keep today's path. The
dial shows the existing `voice.transcript` or `voice.error`.

### Orca actions (`cli/src/cable/hosts/orca.ts`)

- **The handle.** `ORCA_TERMINAL_HANDLE` joins the hook's hint allowlist (`cli/hook/notify.mjs`).
  `ORCA_PANE_KEY` is not needed: the handle is what the CLI takes. Wave 0 dropped `ORCA_APP_VERSION`, and the Claude
  app's `CLAUDE_CODE_HOST_SESSION_ID` joined after the dial check, so the allowlist has 10 names, and the core's
  `MAX_HINTS` (`cli/src/core/observedHook.ts`) equals it: 10. A test holds the two equal, so
  no hint is cut when every one is set and the core takes no more than an honest hook can send.
- **Per agent.** `ObservedSource` reads the hints on every event, not only when it first creates the agent, and keeps the
  handle when it matches `^term_[0-9a-f-]{36}$`. Its `capabilities(agent)` becomes per agent: `s` always, `v` and `f` as
  this section and Voice say.
- **Open (`f`).** An agent with a handle has `f`. A tap (`agent.open` with no `reason`) runs `orca terminal switch
  --terminal <h> --json`, then on macOS `open -b com.stablyai.orca` so Orca comes forward. An `agent.open` with
  `reason: "question"` (a question screen that came up by itself) never switches Orca. A failure is a toast: "Orca did
  not open it."
- **Voice.** `orca terminal send --terminal <h> --text <t> --enter --wait-submit 5 --json`, under the rule above (an ended session is refused).
- **The command.** `orca` on `PATH`, else `/Applications/Orca.app/Contents/Resources/bin/orca` on macOS. Run with
  `execFile` (no shell), 10 s timeout, text ≤ 2000 characters, at most one Orca command at a time per agent.
- Orca chat sessions have no terminal handle: they take voice only through the mod, and no open.

### The CLI for the menu-bar app

In the `harness` CLI (`cli/src/cli.ts`, a new `device` command), never in the core:

- `harness device claude status --json` → `{ supported, installed, enabled, claudeVersion }`:
  - `claudeVersion`: `claude --version`, found as Harness already finds Claude Code; `null` when not found.
  - `supported`: macOS or Linux and Claude Code ≥ 2.1.287.
  - `installed`, `enabled`: `harness-device@openharness` at user scope in `claude plugin list --json`.
- `harness device claude enable`: adds the marketplace if missing (`claude plugin marketplace add autonomous-ai/openharness
  --sparse .claude-plugin plugins`, as the README already says), then `claude plugin install harness-device@openharness`
  (user scope), or `claude plugin enable` when it is installed but off. Doing it twice does it once. Unsupported:
  exits 1 with "Claude Code 2.1.287 or later is needed."
- `harness device claude disable`: `claude plugin uninstall harness-device@openharness`; the marketplace stays.
- Every `claude` call has a timeout (60 s for install, 15 s for the rest) and its failure is one line on stderr and exit 1.

### The wire and the firmware

No new frame and no new field beyond wave 0's: the waiting line is wave 0's activity line, and `caps` stays `s`, `v`,
`f` for an agent outside Harness (never `a`). No firmware change. Harness Pro is not part of wave 1a.

## Out of scope

Codex's adapter, herdr, cmux and the terminals' own adapters; polling Orca or listing agents from it; answering any
prompt or question from the dial; the menu-bar app (wave 1b);
Windows.

## Done when

**Tests**

- `harness device claude asked`: the summary per tool; nothing sent for `AskUserQuestion` and `ExitPlanMode`; prints
  nothing and exits 0 whatever the daemon answers, `{"decision":"allow"}` included; nothing sent with no socket; the
  posted body never carries `ORCA_PAIRING_CODE`, `ORCA_AGENT_SESSION_SPAWN_TOKEN` or any other environment variable.
- `notify.mjs`: `ORCA_TERMINAL_HANDLE` is posted; `ORCA_PAIRING_CODE` and `ORCA_AGENT_SESSION_SPAWN_TOKEN` are never
  posted, with both set; all 10 allowlisted hints set at once reach the devices uncut; the core takes 10 and refuses 11.
- Core: `asked` with its bounded `tool` and `summary`; the inbox route's bounds, 503 at once with no device (the
  process is not started), `inbox.gone`, the fallbacks; 100% per file (`npm run test:core`).
- Waiting: `asked` gives the agent `needs-you` and "<summary> · answer in {Host}" in place of wave 0's line; the next
  event of that session clears it, another session's does not; no `question` frame is sent and no `answer` or
  `answer.reviewed` frame can approve anything; the summary reaches no backend request, router candidate or log line.
- Voice: delivered to a working Claude Code (not refused), never typed into a working Codex in Orca; refused once the
  session ended; the mod route when a poll is open or opens within 5 s; the Orca route
  otherwise; `sendTurn` reaches `source.send` for an agent outside Harness; `v` and `f` per agent, following the poll
  and the handle (read on every event).
- Orca actions against a fake `orca`: the arguments, no shell, the timeout, the handle check, the toast on failure; a
  question screen's `agent.open` never switches Orca.
- The CLI's status, enable and disable against a fake `claude`, enable twice.
- The plugin: `claude plugin validate plugins/harness-device` passes; `claude plugin test` for the mod (a delivered text is
  submitted as the user; no daemon → retry later); `hooks/asked` with no launcher exits 0 with no output.
- End to end: the real daemon, a fake dial, and the real `harness device claude asked` fed a `PermissionRequest` input:
  the client exits at once with no output; the dial gets the waiting line; a later Stop clears it; no dial → nothing.

**On a dial** (Diego's Mac and his real Claude Code, after wave 0 merges; the CLI from this branch with
`make install-cli`, the plugin enabled with `harness device claude enable`; afterwards the release CLI is put back,
`harness device claude disable` runs and the folder marketplace is removed. The dial is asked for from the orchestrator
first. The voice checks 4-6 run against a daemon on the staging env file (`HARNESS_ENV_FILE`), never production.)

1. Claude Code in an Orca terminal asks to run a command: the dial shows the agent waiting, with "<command> · answer in
   Orca". Answered in Orca (or the terminal), the line goes.
2. Auto mode: a command the classifier allows never reaches the dial.
3. `harness device claude disable`: the next prompt never reaches the dial.
4. An idle Claude Code in Ghostty: a spoken prompt starts a turn. Said while it works, the words are taken and queued for
   after its turn.
5. Codex in an Orca terminal, idle: a spoken prompt starts a turn.
6. Claude Code in an Orca chat: a spoken prompt starts a turn (through the mod).
7. A tap on an Orca agent brings its terminal forward in Orca. A Claude Code in the Claude app, opened from the dial,
   brings the Claude app forward on that session.
8. `harness device claude disable`: the next prompt never reaches the dial.

## Design notes

- **Data.** Nothing is written to disk. The devices process holds a waiting agent's summary (200 bytes) until that
  session's next hook event, and a transcript only until the mod takes it (5 s). The summary goes to the dial over its cable, never to the backend, the phone or another machine. Logs carry no
  summary, command, path or transcript: counts and outcomes only.
- **Measures** (daemon log lines, as the dial's notify tally). Waiting prompts shown and cleared;
  voice sends by route (mod, Orca) and refusals by reason. No content and no identifiers.
- **Cost.** One short `harness` process per permission prompt (it exits once its post is written). With no dial the mod
  polls once a minute per Claude Code session; with a dial, one held poll per session (25 s). Nothing polls Orca.
- **Failure.** The hook never decides, so any error leaves the prompt to its app, as it would be with no plugin.
- **Security.** Nothing approves a command: the hook's client prints no decision and reads no answer, and no dial frame
  maps to one. The core takes typed, bounded fields; the tool input is cut to a summary outside the core. The hook's client reaches the daemon over its local, credential-checked transport, and the
  mod over the Unix socket only the person can open; `link` prints the socket path and no credential.
  Orca's secret variables never leave the hook.
- **Compatibility.** The plugin may be newer than the daemon: an unknown event or route means nothing shown and an idle mod.
- **Platforms.** macOS and Linux; the end-to-end and the dial checks run on macOS. On Windows `status` says
  `supported: false` and `enable` refuses.
