# Harness for agents

October 11, 2026. First version built (branch `agent-client`).

Web, desktop, phone and `hn` are Harness for people. This is Harness for the agents running in it: a few
`harness` verbs an agent calls from its shell to see other harnesses, start one, read it, wait for it and close
it. Same daemon, no screen.

## Why

Agents already try to use Harness and build the missing parts themselves:

- The lamp team (October 10) made its own message IDs, coordination files in Git and a `team.sh` around a
  64-character key, and a Codex lead typed into a Claude pane with `tmux paste-buffer` because Harness had no
  way in. ([Agent Messages](2026-10-10-agent-messages.md) fixed the messaging; nothing yet covers start, read,
  wait or close.)
- Each piece exists apart: `harness new`, `harness send`, `harness search`, `harness orchestrator`, Harness
  Monitor's `hps`. None prints for a program, none waits, and none records that an agent started a harness.

The bet: agents will drive Harness far more than people do. A person opens 5 to 20 harnesses a day and reads
them; an orchestrating agent can open hundreds, around the clock, and check each one every few seconds. If that
holds, the agent verbs are the product and the windows become where people watch and steer.

### When an agent should use it

Only when Harness does what the agent's own tools cannot. A quick fan-out inside one task stays with the
engine's sub-agents (Claude Code's Agent tool, Codex sub-agents): cheaper, faster, results come straight back.
Harness is for:

1. **Another model**: Claude Code cannot start Codex, Gemini or Devin; Harness runs all thirteen engines.
2. **Another machine**: the Mac mini, the GPU box, a cloud agent.
3. **Work that outlives the caller**: a harness keeps running after the caller's turn, context or process ends,
   and resumes later.
4. **The person sees it**: what an agent starts appears as a pane on the desktop and the phone, where the person
   can watch, answer or stop it. Sub-agents are invisible.
5. **Existing peers**: harnesses the person started, in the agent's tab, while Agent Messages are on (Settings ▸
   Experimental, off by default).

Claude Code itself now has `ListAgents`, `SendMessage` and `notify_when_idle` for its own sessions on one
machine. The verbs below take the same shape on purpose; what Harness adds is every engine, every machine,
and the person's view of it.

## The agent's side

```
harness whoami                                      # who and where you are, whether you may start, your limits (2026-10-15-agent-experience.md)
harness ps [--all]                                  # the harnesses here: state, who started each, what each is about
harness new [agent] [--machine <name>] [folder] --name N -- <task>   # exists; now knows when an agent runs it
harness show <name> [--chars N]                     # its state, the last ask and the answer
harness wait <name>[,<name>…] [--any] [--timeout 30m]
harness send <name>[,<name>…] "text"                # exists (Agent Messages): teammates in its tab, while it is on, only
harness close <name> [--now]                        # save its screen and stop it; resumable
```

Text by default, for agents as much as people: they read it as well, and it is a third of JSON's size (`ps` on
the owner's Mac, 21 harnesses: 5.8 KB of text, 16.2 KB of JSON). `--json` for programs. Every error says what to run next.
`wait` exits 0 idle, 3 needs the person, 4 stopped or gone, 124 timed out. A refusal (limits, the person's
setting, a harness the caller did not start) exits 5, and every verb ends with `Next:` (2026-10-15-agent-experience.md). A harness the caller closed itself is
`closed (you closed it)` and exits 0 (`close` notes it in the ledger): a Codex lead that closed its harness and then
waited on it, as it had queued, was told it had failed (October 12).

**Close, not stop** (owner, October 11): `harness stop` stops the daemon, and an agent typing it with a name
left empty would have stopped Harness. `close` is the app's close (`agent_close`): it saves the screen, stops the
harness and keeps its conversation, and refuses while the harness is working unless `--now`. A harness still starting
is closed once its first conversation binds; one that has bound none within eight seconds is closed without one, and
says so (October 12: Codex 0.162.1 closed a second after its start was refused, its conversation not yet readable).

The agent's instructions are a skill, [plugins/harness/skills/harness/SKILL.md](../../plugins/harness/skills/harness/SKILL.md):
when to use Harness at all, the rule below, the verbs and the limits. Agents outside Harness get it as a Claude Code
and Codex plugin from this repository (`claude plugin install harness@openharness`, `codex plugin add
harness@openharness`, after adding the marketplace; see [harness.autonomous.ai/agents](https://harness.autonomous.ai/agents)).
Every Claude Code and Codex harness Harness starts is told, as it starts (owner, October 11):

```
You are running in Harness, and the person can watch you. You can hand work to other agents (Claude Code, Codex)
that run in their own harnesses: `harness new`, `harness wait`, `harness show`, `harness close` (see `harness
--help`). Start one only for work that can run in parallel, needs another model, or takes long; do quick work
yourself, and close each one once you have its answer. Only use or close harnesses you started.
```

The sentence on when to start one, and to close it, was added on October 12 (owner: "we need to be very careful about
when to start a new agent so we don't waste user token and we need to properly clean up after too"), once agents ran
the verbs with no approval prompts. The skill, the MCP server's instructions and harness.autonomous.ai/agents say the
same.

Claude Code gets it with `--append-system-prompt`, joined into one with a grid's or a store harness's own (an engine may
keep only the last of a repeated flag), and records it with the rest of the system prompt on the first request
(`--system-prompt-snapshot`). Codex gets it in `developer_instructions`, after the person's own value and before the
pull request instruction, in one `-c` (a second would replace the first); not at all where a folder's
`.codex/config.toml` sets that key. Only while the account lets agents start agents (Settings ▸ Experimental, off by
default): off, it is left out of every launch after. `lib/agentAttribution.ts` `HARNESS_INSTRUCTIONS`, `EngineLaunch.harnessInstructions`.

### ⌘N or ⌘P: new harness or an existing one

This is the choice ⌘B's router makes for a person ([auto router](2026-10-09-auto-router.md)). An agent makes it
itself: it is a capable model and knows its own task better than any router. It needs what the router sees,
which `harness ps` gives it (name, what it is about, state, engine, machine, folder, how long ago it stopped),
and one rule, in its startup note:

1. **Ownership first.** An agent may give work only to a harness it started, or to a teammate in its tab while
   Agent Messages are on. A harness a person is driving is read-only to agents: `show` and `wait` it, never `send`.
2. **Then sameness.** If a harness it may use is on the same work on the same subject (the router's question),
   is idle or resumable, and is its teammate in its tab while Agent Messages are on, send there: it holds the context.
   Otherwise `new`: a follow-up with the fuller task, unrelated work, work to run in parallel, another engine or
   machine, or the matching harness is busy with something else. Starting a harness gives no way to message it
   (below, "Agent Messages off means off").

No Jev: Jev is for ⌘B only.

## Who started it

Every harness an agent starts is recorded: one line in `<data>/agent-client/started.jsonl` of the daemon that owns
the agent's pane, with who started it (id, name, engine, machine), the new harness, the time and its depth. A
harness with no line was started by the person. `ps` shows it (STARTED BY: `person`, `you`, or a name), and
limits, `close` and measurement read it.

It is a file the CLI appends to, not a field in the core's registry, so this first version changes nothing in the
core and can be removed whole. Like Agent Messages it is a collaboration scope, not a sandbox: any process of the
same user can write it. The registry keeps two facts of it: the row's `startedBy` is `agent`, for the pull request
line below, and, when the starter is a harness on the same machine, its agent id (`parentAgentId`, sent by `harness
new` with `agent_create`; one the machine does not know is left out). The depth, and starters outside Harness or on
another machine, stay in the file.

### The person sees it (October 11)

Found in a clean VM with CLI 0.3.75: a Codex harness asked for a second opinion from Claude Code ran `harness new
claude …`, and the child ran and answered but appeared nowhere in the app, only in the Harnesses count and ⌘O. The
owner chose, from a mockup: **the child opens as a pane in the same tab, beside the agent that started it, marked
with who started it.**

```
┌─ code ─────────────────────────────────────────┐
│┌ lead (Codex) ─────────┐┌ python-opinion ─────┐│
││ › get a second opinion││ started by lead     ││
││   from claude code…   ││ Claude Code · Opus  ││
││ • Ran harness new     ││ › Give your opinion ││
││ • Waiting…            ││ • I recommend spaces││
│└───────────────────────┘└─────────────────────┘│
└────────────────────────────────────────────────┘
```

Every agent frame carries `parentAgentId` (null for the rest). A desktop window that first sees such a harness live,
after it has read that machine's list once, and shows its starter in a tab, adds it right after the starter in that
tab (the first in the row where two show it, so every computer picks the same one) without moving focus or taking the
terminal (`desktop/lib/state/started_children.dart`). Never what the first list brings (the window's restore), one the window
has shown before (the person closed it), a stopped one, or one started more than five minutes ago (a laptop waking).
The shell an exited engine leaves under a new id does not inherit the starter.
Every window showing the starter does this, and it is still one pane: the desk's `pane.add` is idempotent, and a
window the desk reaches first finds it already in a tab. The header says `started by <starter's current name>` where
it says `forked from` for a fork. Not yet: the phone, and harnesses started by agents outside Harness (no pane to open
beside), which stay in ⌘O as before.

The task a harness is started with carries one header line, so the new harness knows it is from an agent and not
the person (the lamp team's tmux paste read as the owner's), and that its answer is read where it is:

```
[from lead · Claude Code · studio, the harness that started you. It reads your answer itself.]

Review 3f2a9c1 …
```

Until October 11 the header went on `; to ask it something while you work: harness send lead "…"`, and `new`
offered `message it: harness send kid`. Both are gone with the lineage exception (below). The names `new` offers
for `show` and `wait` are the name when it is a plain word or two, else the start of the id: an unnamed harness is
called by its session title, a sentence that can hold the comma `wait` splits names on (found in the live trial:
"so we have built harness web,").

### Agents outside Harness

Most agents do not run in a harness: Claude Code or Codex in a terminal app, an editor, or the person's own tmux.
With no harness pane to tell them by, they were the person, with no limits and the right to close every harness.
They are told by what they set in the shells they run commands in: `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID`
(Claude Code), `CODEX_THREAD_ID` (Codex), `AI_AGENT` (others; one caller for all of that agent's sessions). One
session is one caller in the record (`claude-code:<session>`), with the limits and the header a harness gets:

```
[from Claude Code outside Harness · studio, the agent that started you. It reads your answer itself.]
```

It may close only what its session started. Nothing can message it, having no pane. A person who runs `harness`
through their agent (Claude Code's `!`) is that agent here; a plain terminal is the person.

An agent that installs Harness starts the daemon from its shell, and a tmux server the daemon starts hands its
environment to every pane: every harness would have been that agent's session, with its messaging token. The
master and the core drop those variables before they start anything, and the core removes them from a tmux
server's environment as it removes harnessd's own (`lib/agentSessionEnv.ts`).

### MCP

`harness mcp` serves the verbs as MCP tools on stdin and stdout, for agents that reach tools through MCP rather
than a shell (Claude Desktop, Cursor, Windsurf; Claude Code and Codex with the Harness plugin): `harness_list`,
`harness_start`, `harness_wait`, `harness_read`, `harness_close`, and `harness_send` only in a harness's own pane,
since nothing can message an agent outside one, and then only to teammates in its tab while Agent Messages are on. Each
call runs the verb as `harness` in a process of its own, so the rules above decide what it may do, and the tool's
answer is the text the verb prints. `initialize` carries the when-to-use rules as the server's instructions.

The server is one agent's session. An MCP server's environment need not name the session (Codex's does not), so the
server says it: `AI_AGENT` from the client's name in `initialize` (`codex-mcp-client` is Codex, `cursor-vscode`
Cursor, `claude-ai` Claude Desktop) and `HARNESS_AGENT_SESSION` from its parent, the agent that started it. A
`harness_wait` waits two minutes unless told (ten at most), within what clients allow a call, and says to call it
again; ending on the person, a stop or the clock is an answer, not an error.

Checked with real clients on October 11: Claude Code (`claude -p --mcp-config`) and Codex (`codex exec -c
mcp_servers.harness…`) each listed the harnesses through it and were told "You are Claude Code, outside Harness." and
"You are Codex, outside Harness."

Signed out, all of this works: the daemon runs as this computer, and `harness new` now asks for that identity as
`harness start` does (#1183). It used to read the sign-in file alone and refuse.
### Pull requests

A harness an agent started adds one line to the pull requests it opens, beside the engine's own, so every reader of
the pull request, and their agents, sees where it was made: the loop that spread "Generated with Claude Code"
(approved by the owner, October 11). A harness the person started adds nothing.

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
🤝 Started by another agent in [Harness](https://harness.autonomous.ai) — agents that run agents.
```

`harness new` from an agent's pane sends `startedBy: agent` with `agent_create`; the row keeps it, and every launch
of that harness (create, restart, resume, restore, retarget) is given the line, read again each time
(`lib/agentAttribution.ts`). A fork is the forker's and gets none. Each engine is told in its own words, declared on
its launch contract (`EngineLaunch.attribution`) and applied by `engines/kit/attribution.ts`:

- **Claude Code**: its own setting, `attribution.pr`, given with `--settings`. Set, it replaces Claude Code's line
  (2.1.296: `pr: h.pr ?? <own line>`), so the value is Claude Code's line, or the person's own text, then ours.
  `--settings` merges over the person's settings key by key, so their `attribution.commit` stays. Nothing is added
  where they hid the line: `attribution: false`, `pr: ""`, or the older `includeCoAuthoredBy: false`, which setting
  `pr` would end, bringing Claude Code's commit trailer back.
- **Codex** has no setting for the text (0.162.1): its own line is an instruction in its developer message
  (`<git_attribution>`), on or off by workspace. Ours goes the same way, `-c developer_instructions=…`, worded as
  Codex words its own. `-c` replaces the person's value, so theirs comes first; one Harness cannot read exactly (a
  multi-line string, an escape), or one a folder's own `.codex/config.toml` sets, is left alone and nothing is added.
- Pull requests only: no commit trailer.

Only while the account has it on: "Mark pull requests from agent-started harnesses" in Settings ▸ Experimental
(`agent_pull_request_line`), or `harness settings pull-request-line on`, off by default. It is read at each launch,
so a harness running when it is turned off keeps its line until it restarts. Not covered yet: the other eleven engines
(no contract), the orchestrator's harnesses, and a machine whose daemon predates `startedBy`, which ignores it.

## What the person lets agents do

Three switches, each an experiment of the account in Settings ▸ Experimental (backend lib/experimentalSettings.ts),
the same on every computer it signs in to, and each off until the person turns it on: **Agents can start other
agents** (`agents_start_agents`), **Mark pull requests from agent-started harnesses** (`agent_pull_request_line`)
and **Agents in the same tab can message each other** (`agent_messages`, 2026-10-10-agent-messages.md). From a
terminal, `harness settings` lists them and `harness settings <name> on|off` turns one for the account.

They began as each computer's own Settings ▸ Agents, kept by its daemon and on by default (October 11 and 12). On
October 12 the owner made them the account's and off for all, since none had been announced: one choice holds on
every computer, and a person who never turned one on gets none of them.

Launches cannot wait on the network, so each daemon keeps a copy in its data folder, `<data>/agent-settings.json`
(`lib/agentSettings.ts`), written only by the core's sync (`core/experiments.ts` `createAgentSettingsSync`):

- It reads `GET /api/experimental-settings` as the core starts, at every `desk_changed` (a change to the
  experiments publishes one), and every 5 minutes as a safety net, and keeps what every answer the windows get
  through this daemon says, so a switch turned in this computer's window holds here at once.
- The copy names the account and this computer's machine in it. Signed out, or signed in to another account, it
  reads as all off: no copy kept for the installation may turn one account's experiments on for another (the
  desktop's own rule for its experiments). An answer for a sign-in that changed while it was asked is not kept.
- A sync that turns Agent Messages on asks for its process at once, so its agents get its note.
- `harness settings <name> on|off` goes through this computer's daemon (`PATCH /api/agent-settings`), which writes
  it to the account and keeps the answer; signed out it says to sign in. An older window's Settings ▸ Agents
  reaches the same route and so writes through to the account too.

## Limits

Spawning is cheap, so runaway spawning is the risk (the Jev loops cost $60 at one caller), and every harness started
spends the person's tokens. Every limit refuses with a clear error; nothing is dropped silently.

- Live harnesses started by one harness: 4 (8 until October 12).
- Live harnesses started by agents, per machine: 40.
- Depth: one level. A harness another agent started may not start harnesses itself (two levels until October 12):
  `A harness another agent started may not start harnesses itself. Do the work yourself, or say in your answer what
  else is needed.` Told by its line in the record, or by the core's row when the record has none: every frame says
  `startedBy: agent` for a harness another agent started, from another machine or from outside Harness too (the
  record is kept where the starter ran, and only `parentAgentId` was in the frame before; the review of #1234).
- `new` per harness: 20 in 10 minutes.
- An agent never answers a permission dialog, and never closes a harness it did not start.
- Agents start harnesses only while the account lets them (Settings ▸ Experimental, `harness settings
  agents-start-agents on`), off by default: otherwise every agent's `harness new` and `harness_start` is refused with
  where the person turns it on, and reading, waiting and closing what it started still work. The person is never
  refused.

### No permission prompts (owner, October 12, 2026)

"No asking. Just do. The best UX." Every verb needs the daemon, which Codex's sandbox cannot reach, so Codex asked
the person before each one: about four questions for one hand-off (new, wait, show, close). In its auto mode it
answered itself, but only after a failed try inside the sandbox. The safety is Harness's own, above: the switch for
agents starting agents, the limits, closing only what you started, and Agent Messages only within a tab. So the engines run
the verbs without asking.

- **Codex, shell.** `<CODEX_HOME>/rules/harness.rules`, which Harness owns whole (written at every daemon start and
  before a launch in another profile): `prefix_rule(pattern=["harness", ["ps", "show", "wait", "new", "close",
  "send"]], decision="allow")`, the same for the managed Node with the CLI's bundle, and
  `host_executable(name="harness", paths=["<launcher>"])`. An `allow` match runs the command outside the sandbox on
  its first try when every command in the line matches one (codex-rs `exec_policy.rs`, `Skip { bypass_sandbox }`,
  0.162.1). Codex reads an absolute path by its last part, so without `host_executable` a `harness` an agent wrote in
  its own folder ran outside the sandbox by its full path (true of `send` before this change); with it, only the
  launcher's path counts as `harness`, and a person's own rule for `harness <verb>` covers it too. Codex ranks
  forbidden over prompt over allow, so the person's rule wins. `harness settings` is not in it and still asks.
- **Codex, MCP.** `harness_start` and `harness_send` say they are neither destructive nor open-world, so Codex's
  auto rule no longer asks, and `codex exec` no longer refuses them ("MCP tool call requires approval, but approval
  policy is never"). The plugin's own Codex manifest, `.codex-plugin/plugin.json`, sets
  `default_tools_approval_mode = "approve"` for its server, which covers `harness_close` too; a setting the person
  makes in `config.toml` for that server wins.
- **Claude Code.** `Bash(harness <verb>:*)` and `Bash(<launcher> <verb>:*)` for each verb, and its tool by name under
  both server names (`mcp__harness__harness_start`, `mcp__plugin_harness_harness__harness_start`), added to
  `permissions.allow` in `settings.json` beside the hooks. Not `mcp__harness__*`: another product's MCP server is
  often added as `harness` too. A verb's commands (or its tool) get no allow in any spelling when the person's deny or
  ask names it in any spelling, or something broader (`Bash(harness:*)`): Claude Code does not count the launcher's
  path as `harness`. A rule the person deletes comes back at the next start; a deny or ask keeps it out. Claude Code
  checks deny, then ask, then allow, and resolves a narrow allow before auto mode's classifier.
- **Full mode stays the person's.** With nobody asked, `harness new --mode full` from an agent would start one with
  its permission checks and sandbox off (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`)
  from a sandboxed agent. An agent's `new` in full mode is refused; auto, the default, keeps each engine's own checks.
- **Verified** with the real engines in a throwaway home against a local mock model (Codex 0.162.1, Claude Code
  2.1.296): without the rules `harness ps` ran in Codex's sandbox and could not reach the stand-in daemon, and Claude
  Code answered "This command requires approval"; with them both ran it at once, by name or the launcher's path, and
  `harness new … && harness wait …` too. A `harness` written into the workspace and run by its full path stayed in
  the sandbox (on `main` its `send` ran outside). `harness settings` stayed sandboxed; a person's deny and ask still
  refused; a tool of another server named `harness` still asked; Codex's `harness_start` and `harness_close` ran
  under `approval_policy = "never"`, and a person's `default_tools_approval_mode = "prompt"` refused close again.
- **What still asks.** A `harness` command piped or joined with another one (`| head`, `; echo $?`, a variable set
  in front): the rule matches commands, not lines. The CLI's sandbox error says to run it by itself.
- **What it does not close.** A folder on Codex's PATH that its sandbox can write (a project's activated `.venv/bin`)
  could hold a `harness` of the agent's own, which the bare name would then reach outside the sandbox: a rule names
  a command, not a file.

## Cleaning up (October 12)

Owner, October 12: "we need to properly clean up after too". What an agent starts and forgets either goes on working
for no one or sits in the person's windows. Harness closes those itself, in a service (`services/agentCleanup.ts`, in
the edge host; `core/agentCleanupLink.ts` is the core's side). A close is `harness close`'s: the screen saved, the
process stopped, the conversation kept, so the person can resume it and `harness show` still reads its answer. One log
line for each (`[agent-cleanup] closed kid (3f2a9c1e): …`).

- **With its starter.** Closing a harness closes the harnesses it started on this machine (registry `parentAgentId`),
  at once and working or not: an orphan that keeps working spends tokens for a starter that will never read it. Every
  stop goes through one place in the core (`core/agents/lifecycle.ts` `stopAgent`): a window's or the phone's close
  (`agent_close`), Stop Harness (`agent_delete`), `harness close` and a purge, so the apps, the CLI and an agent
  closing its own are all covered. The core tells the cleanup once the stop is done (`AgentCleanupPort.closed`). Not
  once the starter is live again (resumed while the notice was held for a process that was down), and once for two
  notices of one stop. A close that fails is tried twice more, five seconds apart.
- **When idle.** A harness another agent started (`startedBy: agent`, so an agent outside Harness's too) that has sat
  30 minutes (`IDLE_CLOSE_MS`) after its last answer is closed, once its screen says it is idle: never one that works,
  waits for the person or holds a draft (`agent_close` `idle`). Looked at once a minute, by when its conversation last
  moved (the latest dated work in its transcript), so a look reads no screen until one has been quiet that long; one
  that would not close is asked again five minutes later. A run of its process counts as moving: a resume or a
  restore writes nothing a conversation's time is read from, and a child the person resumed to read was closed again
  within a minute (the review of #1234). So the cleanup closes nothing in its first half hour after it starts, and an
  engine that keeps no dated transcript (only Claude Code and Codex declare one) is never closed for being idle.
- **Never the person's.** Neither touches a harness the person typed or pasted into from a window or the phone (a
  `message` frame, or terminal input that is more than what the terminal sends by itself: focus, its attributes, the
  mouse, `lib/typedInput.ts`). It is theirs from then on, kept in `<data>/agent-cleanup.json` across restarts. A harness
  the person started is never one the cleanup may close: the core decides (`CoreApi.agents.closeStarted` refuses any
  other).

A close of a harness already closed, the same conversation, is answered closed (`closeAgentService.ts` `closedAlready`):
a window closing a tab closes its panes one at a time, and the starter's close had already taken the next pane's
harness with it; that pane's close was answered `AGENT_CHANGED` and shown as "Could not confirm that it stopped".

Agents are told too: `harness show` on an idle harness of theirs ends with `Next: harness close <name>  (once you
have what you need)`, and an agent's `harness ps` ends with `Next: harness show <name>  (read its answer, then close
it: harness close <name>)`; the MCP tools name `harness_close` instead (2026-10-15-agent-experience.md). `wait` on one Harness closed says where
its answer still is: `kid: stopped · it was stopped; its answer is kept: harness show kid`.

Not covered: harnesses an agent started on another machine when its starter closes (each machine's cleanup sees only
its own); a cascade cut short by a restart (it is kept in memory; the idle close catches what then goes quiet); a
harness the person drives from a tmux of their own, which no window carries; and a harness the person typed into
before this version, which nothing recorded (closable, conversation kept, once idle half an hour after the upgrade).

## How it works

`cli/src/agentClient/`, a CLI module outside the core, composed only of requests the daemon already answers.
No core change, no new service.

- **The line.** The daemon that owns the caller's pane (`@harness_daemon`, as `harness send` finds it), over its
  Unix socket, as a **tool**, not a window: a window's registration turns on the question watcher and counts as
  someone looking. `harness new` registered as a window too; it no longer does.
- **Who is calling.** `$TMUX_PANE`, matched against the harnesses the daemon lists, offline ones included:
  matching active ones only made an agent "the person" whenever the daemon listed it offline for a moment (found by
  the end to end). A person's terminal (in any state: the core marks every session inactive as it starts), or a pane
  Harness did not make, is the person. A pane Harness made whose harness it no longer knows is what is left of an
  agent, and so is a caller the daemon did not answer about: they may look, not close or start.
- **Listing.** Live harnesses only, unless a verb needs the stopped ones (`ps --all`, a name no live harness has,
  a waited-on harness that left the list): with every stopped one the list took 128 ms against 10 ms here (391
  harnesses, 21 live).
- **`ps`**: `agents_list`, plus `agent_recent` (the daemon's stored turn summaries and the person's last asks,
  no transcript read) for up to 40 live harnesses. 0.8 s for 22 harnesses on the owner's Mac.
- **`show`**: `agent_close` in `inspect` mode for needs-input (the screen, as the windows read it), and
  `session_get` with a `limit`, a page at a time from the end, at most four pages: never the whole transcript
  (the attach OOM, October 3). The answer is the text after the turn's last tool call.
- **`wait`**: a round every 3 s: one live list per machine, and the screen (`inspect`) only for a harness the daemon
  does not already call working. Done when it is idle on two looks in a row with the same last turn, and it either
  worked while waited on or has answered (text after its last tool call). A draft in its box is not done. The history
  readers end every newest page with a `done` event whether the turn ended or not, so `done` is never read as the
  end (the review caught `wait` returning at once after a `send`). A harness with nothing asked of it two minutes
  after it started is done. Cost per round here: a live list 10 ms, an inspect 29 to 48 ms, a transcript page 7 ms.
- **`close`**: `agent_close`, `idle` mode (or `now`). An agent closes only what it started; the person anything.
- **`new`**: `lib/newCommand.ts` asks `agentOrigin()` when run from an agent's pane: the limits, the header, the
  record. The limits count the caller's harnesses on other machines as those machines list them (one closed there
  frees its place); a machine that cannot be asked has its last day's starts counted. A harness started on another
  machine is recorded there too (Agent Messages' `started`, from another of the owner's machines only), so its depth
  and that machine's limits count it; an older daemon there that cannot keep it is said in words. A launch the daemon
  holds is asked after by its creation id for up to a minute, so a held launch is not left running with an agent's
  task and no record. `new` also stopped printing "Created" for a launch the daemon refused or could not confirm.
  Two starts at the same moment from one harness can both pass the limits: they count what was recorded before.
- **`send`**: nothing of its own. A harness messages another only in a tab the two share, while Agent Messages are
  on, like any teammate (`harness send` also takes the start of an id there).
- **Another machine.** `new --machine mini` (it was `new @mini` until 2026-10-14); `show`, `wait` and `close` find a
  harness the caller started there through its record and reach it over the paired relay. Anyone, a person or a
  program outside Harness, names the machine for the rest: `ps`, `show`, `wait` and `close` take `--machine <name>`
  too. A program on the lamp started `lamp-first-task` on office and could not read its answer, since only an
  agent's starts are recorded (2026-10-14). `@mini` is refused with what to type instead, so a script that still
  says it fails rather than starting a project called "@mini" here.

### Agent Messages off means off (owner, October 11, 2026)

The first version let a harness and the harnesses it started message each other with no tab at all, on the same
machine (the lineage exception), kept in a `started` log beside the tabs' logs, and the new harness's header invited
it to. With CLI 0.3.75 live, the owner found agents messaging each other before turning Agent Messages on
anywhere, and decided: **Agent Messages off means off; a harness started by another gets no exception.** A harness
may message another only where the person turned Agent Messages on, like any teammate: then a tab's chat icon,
since October 12 one switch of the account, off by default, within a tab the two share (Settings ▸ Experimental,
2026-10-10-agent-messages.md).

- `messages/service.ts` reads who started what only to keep another machine's record (`started`, for limits and
  depth); `send`, `harness send` alone and delivery go through the tabs alone. A send to a harness one started, with
  no shared tab, is refused with the same words as any other recipient: `MESSAGES_OFF` while Agent Messages are off
  on the computer, `NO_TEAMMATES` for a harness alone in its tab or in none, `UNKNOWN_RECIPIENT` ("No teammate named
  …") otherwise.
- A message an older version queued under `started` is never delivered: it is failed and its inbox file withdrawn
  as the service starts, before the directory is read (the hook takes what waits in an inbox without asking, and a
  directory that cannot be read would have left it there), even between two that now share a tab.
- The record (`agent-client/started.jsonl`) stays: `ps`, the limits, the depth and `close` read it.
- For a follow-up to a harness it started, an agent starts it with everything in the task, or, where the two share
  a tab and Agent Messages are on, sends.

### Verified

- Unit: the module (47 tests), `harness new` (17), Agent Messages (21, with lineage, id prefixes and the
  `started` record; since October 11 the lineage tests assert the refusal). An independent review found the `done`
  misreading, the day-long count of other machines' harnesses, the limits restarting on another machine, a caller
  taken for the person on errors, held launches and the ledger's compaction losing lines; each is fixed and tested
  above.
- End to end on the real daemon with the fake engines (`e2e/agentClient.e2e.ts`, 10 s): from an agent's pane,
  `ps`, `new` with a task, `wait`, `show` (the header and the echoed answer), `send` both ways with no tab on
  (refused since October 11), `close` refused for its own harness and for one its child did not start, then allowed
  for its child. Since October 12 also: a harness another agent started refused `new`, `show` and `ps` ending with
  their hints, a window's close (`agent_close`) and the person's `harness close` each closing what the closed harness
  started, and a harness the person sent a message to left open, with the cleanup in the edge host's process. The
  30-minute close is unit-tested on a fake clock (`services/agentCleanup.spec.ts`). The fake
  engine now takes a first message on the command line, as both CLIs do; it used to drop it.
- Live, on the owner's Mac from this session's own pane against the running daemon: `ps` (22 harnesses, 0.8 s),
  `new claude --name probe-child -- "Reply with the single word ready"` (0.4 s), `wait` (idle in 7 s), `show`
  (the header and "ready"), `close` refused for "Harness OS", allowed for the child. `send` answered
  `UNSUPPORTED` there: that daemon is a dev build whose Agent Messages backend is not deployed until Monday.
- Not claimed: whether agents choose well (the eval below).

## Measuring it

- **Use:** harnesses started per day by people and by agents, and the ratio. Agents passing 10× people on our
  own machines within two weeks is the signal to invest.
- **Choice:** an eval in the style of `cli/scripts/route-eval/` (English only, with a red team and a held-out
  set): a desk, a task, and whether a Claude Code and a Codex agent pick `send` to the right harness, `new`, or
  their own sub-agents.
- **Outcome:** for the same tasks, with and without the verbs, does the work finish and is it better.

### First eval (October 11, three Claude Code agents, the skill given as a file)

| Task | Right choice | What the agent did |
|---|---|---|
| A second opinion from Codex on a function, then one follow-up to the same reviewer | `new`, then `send` | `ps`, `new codex --name window-sum-review`, `wait`, `show`; the follow-up went to the same reviewer with `send` ("mine, idle, on the same subject"), and when `send` failed it did not start a second Codex to work around it |
| Count test files in two folders | its own tools | `find`; started nothing ("a one-line local command") |
| "Have billing-fix do it": a harness the person started | not `send` | read it with `show`, refused to give it work, did the one-line change itself and said why |

3 of 3 chose right. What it changed: the first message's 2,000-character cap (long tasks now go in a file), and the
header's reply invitation (every child sent its report back as a message too; it now says the starter reads the
answer itself). Not yet run: Codex as the starting agent, a red team, a held-out set, and the outcome comparison.

## Not now

An MCP server (a thin wrapper once the CLI holds), agents outside Harness (a Claude Code plugin, `npx`, the MCP
registries), the windows' tree of who started whom beyond the pane beside its starter, `ps` across all machines (today: this one, and what you
started elsewhere).
