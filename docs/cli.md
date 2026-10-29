# The daemon and CLI

One thing to know from the start: **the daemon only knows about panes it created.** Sessions you
start from the app are tmux sessions named `harness-*`, owned by the daemon. A `claude` you launch
by hand in your own tmux is not picked up. Another machine needs Node ≥ 20 and tmux; `sqlite3` only
for the engines that keep their conversations in SQLite (OpenCode, Kilo, Hermes, Devin). There is no
token to copy between machines: a durable computer id under `~/.harness` keeps later starts attached
to the same machine record.

`harness` is one pure-JS bundle run by the managed Node under `~/.harness/cli`. Everything below
works the same on a headless Linux server; the app is not required on a machine, only the daemon.

| Command | What it does |
|---|---|
| `harness login [--google\|--apple\|--qr] [--force] [--json]` | Sign in and save this computer's session: Google or Apple in the browser, or a QR a signed-in phone scans. With no flag at a terminal it asks which. `--force` signs in as a different account. `--json` emits NDJSON for GUI clients. |
| `harness start [-f] [--repair]` | Start the daemon from the saved session. `-f` runs in the foreground for a supervisor. `--repair` re-verifies the managed Node runtime. |
| `harness stop` · `harness logout` · `harness reset` | Stop the daemon · stop and clear the SSO session · stop and clear all local state. |
| `harness status` · `harness version` · `harness update [--force]` | Running, pid, machine id, session count · version · update now. |
| `harness dsh list` · `harness dsh update <owner/name>` | Installed harness package versions and available updates · update one package while preserving its workspaces. |
| `harness machines [list] [--json]` · `harness machines delete <id>` | This account's machines · remove another machine (never this one). |
| `harness machines engines <machine> [--engine E]… [--json]` | Asks that machine now, over the machine link, which engines it has (`engines_probe`, answered there): one JSON line per engine with `machineId`, `engine`, `installed` (`true` or `null`), `signedIn` (claude and codex only, else `null`), `installable` and `firstPrompt` (whether its Harness can start that engine with a first prompt; `null` from an older Harness). `null` means unknown, never "not there": the probe reads a missing command, a timed-out login shell and a failed spawn alike, so only a failed start says an engine is missing. `--engine` narrows the probe to the engines named, so the answer comes sooner. For a device that hands work to its person's machines (#1788). |
| `harness pair <code>` · `harness pairings` · `harness unpair <#\|fp\|--all>` | Pair a browser with the code the web client shows; list; unpair. |
| `harness pair <verb> [--json]` · `harness pair talk <words…>` · `harness pair mcp` | Your paired daemon's control interface (below): read every harness on every machine; talk to the daemon. |
| `harness remote-password set\|status\|clear` | This machine's persistent password for machine-to-machine links. |
| `harness link connect <id> [--name=<label>]` · `harness link list` · `harness link unlink <id>` | Let this machine reach another of yours, terminating E2EE here; list; unlink. |
| `harness remote` | From a Harness terminal tile: choose another of your machines (linking it on the spot if needed), open a terminal there and move this tile to it. |
| `harness devices [list] [--json]` · `show <#\|fp>` · `remove <fp>` · `history [--json]` · `dismiss [<#\|fp>]` · `rebaseline [--yes]` | The account's devices as this machine verified them (below): list · one in full · take one out on every device · every add and removal, newest first · mark new ones seen · review and trust a frozen list again. |
| `harness grid login [--force] [--json]` · `harness grid logout` | Sign the `grid` CLI in with this computer's account, no second browser. |
| `harness grid env <grid>` | `<grid>`'s relay address and key as shell exports, through the harness's own `grid`: `eval "$(harness grid env <grid>)"` before pointing an OpenAI-compatible client at `$OPENAI_BASE_URL`. |
| `harness flash [flags]` | Re-flash a plugged-in Harness device over USB. Flags pass straight to the flasher. |
| `harness autonomous-device discover\|status\|list\|pair\|revoke` | Pair Autonomous OS devices found on the LAN, directly, with no relay. |
| `harness autonomous-device addon state\|propose\|proposal` | Read what a paired device publishes, and propose what it might do ([device add-ons](autonomous-device-addons.md)). |

Interactive prompts read one line from stdin with `--stdin`; `--json` switches any of them to NDJSON.

The daemon answers on loopback at `http://127.0.0.1:18473` (`harness status` prints it as `local api`):
`/api/status` gives its health, this machine's fingerprint and its paired clients. It serves no web
page and never a transcript. Configuration is environment
variables (`BACKEND_WS_URL`, `WEB_URL`, `ADAPTER_DATA_DIR`, `ADAPTER_COMPUTER_ID`, `PORT`, and the
per-engine home directories); [`cli/README.md`](cli/README.md) has the full table and the
`.env.example`.

## Automation

The app is one client of the daemon. Any process of the same OS user can be another: the loopback
WebSocket at `ws://127.0.0.1:18473/api/local-ws` takes a `machine_select` frame first
(`{ machineId, localProtocolVersion: 1 }`, no `Origin` header), then request frames with a `requestId`
and answers them with `<type>_result`. Since 0.4.21 every loopback request (REST and this WebSocket)
shows the daemon's local credential, `X-Harness-Local: <credential>` (or `Authorization: Bearer
<credential>`): the contents of the 0600 `hook-credential` file in `ADAPTER_DATA_DIR`
(`~/.harness/cli/data`). Without it the daemon answers 401; `/api/status` then gives only its public fields. Selecting one of your other machines proxies the request
through this daemon's link to it.

What it answers: `agents_list`, `agent_create`, `agent_restart`, `agent_retarget`, `agent_delete`,
`agent_update`, `agent_recent`, `agent_handoff_prepare`, `agent_read_file` (media previews, in 128 KiB chunks),
`fs_list_dir`, `engines_probe`, `codex_profiles_list`, `codex_profile_link`, `models_list`,
`usage_read`, `question_response`, `message`, `cancel`, and `terminal_open` for a
binary terminal channel with scroll, resync and paste. The same frames travel from the web client
over the relay.

`agent_handoff_prepare` (`{ agentId, changeId, targetEngine }`, owner-only, sealed over the relay)
runs before the app's Change agent closes the old engine. It writes
`.harness/handoff/<agent>-<change>.md` and `.transcript.md` into the agent's project: the person's
requests, the last answer, git state and the tool calls already run, secrets redacted, files 0600
in 0700 folders. In a git repository it first adds `**/.harness/handoff/` to `.git/info/exclude`,
or writes nothing. The reply is `{ agentId, file, gitRepo, cwd, degraded }` (`file` is null when
there was nothing to hand off or it could not be written) and never carries prompt text; the app
writes the new engine's prompt itself. Errors: `MISSING_AGENT_ID`, `BAD_CHANGE_ID`, `BAD_ENGINE`,
`UNKNOWN_AGENT`, `NO_PROJECT`, `BUSY`, `TIMEOUT` (5 s, nothing written), `OWNER_REQUIRED`,
`UNSUPPORTED`, `INTERNAL`.

Whose history goes in: the agent's own session first. A fork that has not answered on its own yet
(no session, or one that read fine and was empty) inherits the conversation it was forked from, cut
at the moment of the fork, and both files say so. A fork records its source's session when it is
made, and exactly that session is read; a fork recorded before that reads the source's current
session only when the source was bound to it by the fork. Up to 5 fork links are followed, each
parent must still exist and work in the same folder, and the walk stops on a cycle. Forks of
database-backed engines (OpenCode, Kilo, Hermes, Devin), and transcripts without timestamps, inherit
nothing. A live agent that is not a fork and is not bound to a session yet may have its session
found: for Claude only through the process record Claude keeps for its pid, for the other file
engines only a session born to that process; never one another agent holds, or one just deleted.

`degraded` lists what fell short: `transcript` (the session could not be read and the mirror's
newest requests and recaps were used instead, or no history was found), `git` (not a repository,
its state was unclear, or the exclude line could not be added), `file` (nothing was written: the
repository state was unclear, the exclude line or the files could not be written, or `.harness`
is not a plain folder).

`question_response` carries the `requestId` of the `commander_question` it answers, and its
`question_response_result` comes back under that same id, to that client alone (sealed, over the relay):
`{ ok: true }` once the answer is typed, or `{ error: "STALE_QUESTION", detail }` when the dialog on
screen is no longer that question — nothing is typed then.

Engines report in over HTTP on the same port: `POST /api/hook/session-start`, `session-end`,
`turn-start`, `turn-stop`, `tool-start`, authenticated by a per-install token the daemon writes into
the hook it installs.

`harness new` makes a session from a shell, in the words the app's box uses, over this same socket:

```
harness new                                   claude, in the current directory
harness new codex --machine mini ~/code/auth  codex, on the machine called mini, in that folder
harness new codex my-game                     codex, in a new project ~/harnesses/my-game
harness new --plan --prompt "fix the flaky login test"
```

Words may come in any order: a path looks like a path, the first other word is the agent and a
second names a new project. `--machine <name>` picks the machine (id, name, or an unambiguous start
of a word in it); `@mini`, the old way, is refused with what to type instead. `--mode
auto|ask|plan|full`, `--name`, `--new [name]` and `--json` are the rest. There is still no
`harness split`: panes are arranged in the app.

`harness ps`, `show`, `wait`, `watch` and `close` take `--machine <name>` too, to read, wait for or close a
harness on another of your machines: `harness new claude --machine office --name check -- …`, then
`harness wait --machine office check` and `harness show --machine office check`.

A cloud agent starts the same way: `harness new devin-cloud --machine office --repo acme/api -- <task>`.
`--repo` takes `owner/name` or a GitHub address; Cursor Cloud needs one, Devin Cloud works without.
`--acu-limit <n>` caps Devin Cloud's spend (5 when left out). `show` and `wait` read it from the cloud: its
state, what it said after the last thing it was told, and its links (`links` in JSON). `harness reply <name> --
<words>` says the person's answer, or what to do next, to a cloud harness; an agent does not.

`harness reply` also gives more work to a harness in a pane, for a program acting for the person (a lamp that checked
the answer and found it wrong), when the person has turned on `programs-reply` (`harness settings`, off by default).
Only an idle harness takes it: one that is working is refused until it finishes (exit 1), and one that may be waiting
on a question or a permission is the person's to answer. The machine it runs on checks both again and types the words
in once its composer is free, never over a draft, with `tell`'s limits. Then `harness wait` and `harness show`, as
after a start: `wait` does not return on the answer to the work before. An agent uses `harness tell` instead, for a
harness it started.

`harness watch <name>` follows one harness for a program that acts on it: a line each time it changes, one JSON
object a line with `--json`, until it stops or is gone (exit 4) or `--timeout` passes (exit 124; `0`, the default,
follows it as long as it lives). It decides as `wait` does: the maker's state for a cloud harness; the daemon's
activity, then the screen, then two idle looks on one turn for one here. The first line is how it stands now.

| event | when | with |
|---|---|---|
| `started` | installing or starting | |
| `working` | it works (a draft in its box counts) | `ask`: the last thing it was told |
| `needs_person` | a question or a permission; for a cloud harness, its maker's own state | `question`: its last words, to `--chars` (4000) |
| `done` | idle after a turn | `summary`: its last answer, to `--chars`; `truncated`; `tools` |
| `idle` | idle with nothing asked of it, past its start | |
| `failed` | the cloud says it failed | `summary`, `links` |
| `stopped` | stopped or gone | `summary`: its last answer, when it has one |

Every line has `at`, `name`, `id`, `agent` and `state` (as `show` says it), and `cloud` and `links` for a cloud
harness. The same state with new words (a second question, a new answer) is a new line carrying the whole words again;
the same words are never said twice. **A cloud harness's state is its maker's, not a guess:** Devin Cloud says
`waiting_for_user` both when it asks and when it has only finished (#1449), so `needs_person` comes either way: read
`question` and `cloud.providerStatus` to tell. A Devin put to sleep once it finished is `stopped`
(`providerStatus` `suspended`/`inactivity`), with its answer as `summary`. The words are the harness's own, as they
are, Devin's `ATTACHMENT:` lines included; `ask` leaves out the line `harness new` puts before a task. It looks every
3 s, as `wait` does, so a watch of another machine's harness is one `agents_list` over the machine link every 3 s. It reads with the requests
`wait` makes, over the same socket: one `agents_list` a round, the screen for a harness here that the daemon does not
already say is working, and the last transcript page only when the harness changed. Nothing reports failing tests
during a turn yet, so there is no event for them.

`harness whoami` says, for an agent, where it is and what it may do before it acts (`--json` gives the same as
`context`); the top of an agent's `harness ps` begins with it, and `harness mcp` puts it in its instructions:

```
You: <agent> "<name>" (<id>), inside Harness, on <machine>.
Can start harnesses: <yes, or no and why>. <who can change it, and the command>
Yours: <open> open of <max> · <starts> of <max starts> starts in the last <minutes> minutes · other machines: <machine> (<state>), …
```

Run by the person, it prints the first line only: `You: the person, on <machine>.`

Every agent verb ends with what to run next, in one shape (`--json` gives the same as `next`, and `new` and `close`
add `effect`, what changed):

```
<name> on <machine>: starting. <agent>, in <folder>.
The person sees it in Harness, beside you.
Next: harness wait <name>  (until it has answered; then read it: harness show <name>)
```

`show` names `close` for an idle harness of the agent's own, `wait` for a working one, and the person for one that
needs the person; `close` says how many of the agent's own are still open; an agent's `ps` ends with its idle one to
read, its busy ones to wait for, or a start, and shows its own first and at most 15 rows (`--all` shows every one).
A harness waiting on a question or a permission is shown as `needs the person` (JSON keeps `needs-input` and adds
`needsPerson: true`). A refusal (`SPAWN_LIMIT`, `TURNED_OFF`, `NOT_YOURS`) exits 5, with `code`, `reason` and
`next` in its JSON. `harness help agents` prints the commands, states, exit codes and rules on one screen, and
`harness --help` starts with it when an agent runs it.

## Your devices

Signing in is what makes a device trusted: every computer and app signed in to the account adds its
key to the account's device key log, and the others trust it with no password. Nothing asks you to
confirm a device; instead every device shows you each one it did not know before.
`harness devices` is this machine's view, the same one Machines shows in the app (Computers, and
Phones & apps).

- **New.** A device added after this machine joined the account is flagged `new` (an OS notification
  in the apps) and stays flagged across restarts until you confirm it on one of your trusted devices,
  or review it on each. Confirming is "It's mine" in the apps, or `harness devices dismiss <#|fp>`
  here: it marks that device seen here and tells your other devices, which stop flagging it and show
  where it was confirmed (`harness devices show`: `confirmed on <device>`). Each device checks that
  confirmation itself: it counts only when signed by a device that device already trusts — not one
  that is itself new, suspended or removed there — and it never lifts a suspension. Reviewing
  (`harness devices dismiss` with no device, or opening Your devices in the apps) marks every one seen
  on that device only.
- **Already on your account.** The first time a device reads the log it announces nothing; the apps
  show the devices that were already there once, until you press Got it.
- **Joined and left before you looked.** A new device that was removed before you saw it stays listed,
  with who removed it, until you dismiss that one: `harness devices dismiss <fp>`, or its own Got it
  in the apps.
- **Removed.** When another device is removed, the others say who removed it, or that it signed out.
  It is marked in red when a device you have not looked at yet did the removing.
- **Held by another key.** If another key already holds this computer's place (`harness status`
  says `not registered — another key holds this computer`), an earlier install is the usual reason:
  remove it from another device and this computer joins on its own. Marked in red when that key
  appeared after this computer joined.
- **Frozen.** When the backend serves a log that does not match what this machine verified, the list
  freezes and adds nothing until you review it: `harness devices rebaseline` shows what would change,
  `--yes` trusts it (Trust again in the apps). If devices disagree about the log, keys added after the
  point where they split are also **suspended** — not trusted here until that review, or until you
  `dismiss` one that is yours.
- **Another account.** The list belongs to the account this device last signed in to here. If the
  backend starts serving another account's list, the list freezes and Trust again refuses to switch:
  sign in again (`harness login`) to change accounts. Each account's marks are kept for when you
  return to it.
- **History.** `harness devices history` lists every add, rename, removal and sign-out, newest first,
  with who did it. Each entry is checked against what this machine already verified, so the backend
  cannot rewrite it; offline, it shows only the recent part.

A `history` or `dismiss` that answers *This needs a newer Harness running here* means the daemon
still running is an older version: `harness stop && harness start`.

## The daemon's control interface

`harness pair <verb>` is how the paired daemon ([daemons/BRAIN.md](../daemons/BRAIN.md)) reads and
drives Harness, and how you can too. A pairing code is never one of these verbs, so `harness pair <code>`
still pairs a browser. Every verb prints the daemon's JSON reply (`--json` for one line) and exits 1 on
a refusal.

```
harness pair status                               is pairing on, and with which daemon
harness pair list_machines                        the machines it can see (others while Harness is open here)
harness pair list_harnesses [--machine <id>]      every harness: working, waiting, idle, failed, stopped
harness pair read_harness <agentId> [--machine id] the open question with its options, recaps, asks
harness pair brief [--since <minutes>]            what happened since then, on every machine
harness pair talk <words…>                        talk to your daemon: starts or wakes its pair harness
```

The writes — `answer_question <agentId> <requestId> <choice>`, `send_prompt <agentId> <text…>`,
`stop_turn`, `start_harness <engine> <folder> [--name n] [-- prompt…]`, `pause_harness`,
`resume_harness`, and `say <line…>` — belong to the pair harness: they need its per-launch
`HARNESSD_PAIR_TOKEN` (or `HARNESSD_PAIR_TOKEN_FILE`) and are refused `TOKEN_REQUIRED` without it. Then the
account's autonomy dial decides: `watch` refuses them, `suggest` turns each into a line that waits for
your `y`, `act-on-key` lets the daemon drive harnesses it started and batches the rest behind one key.
Whatever the dial, it never deletes, restarts, forks or bypasses, never types into a terminal or its own
harness, and never approves a prompt that pushes, forces, deletes, deploys, publishes, drops or merges.

Per machine, `~/.config/harness/pair.jsonc` (or under `$XDG_CONFIG_HOME`; JSON with comments) holds
`"model": true` to let the daemon ask one small model for better status-line words (off by default),
and the `rules` it runs while the dial is `act-within-rules`: `{ "harness": "api*", "engine": "claude",
"project": "~/code/api", "question": "^Approve Bash command: npm test", "choice": "Yes" }`. A rule never
answers a push/force/delete/deploy/publish/drop/merge prompt, never picks "don't ask again", and approves
a permission prompt only when it is a read, test, build, formatter or in-project edit. What it did is
journaled and reported.

`harness pair mcp [--token-file <path>]` serves the same tools as a stdio MCP server named `harnessd`, for
an engine that speaks MCP. Both speak the loopback `pair` request (`{ verb, …arguments }` →
`pair_result`) after a `machine_select` with `tool: true`: a tool client is answered like any other but is
never counted as a person at this computer.
