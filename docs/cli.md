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
| `harness pair <code>` · `harness pairings` · `harness unpair <#\|fp\|--all>` | Pair a browser with the code the web client shows; list; unpair. |
| `harness pair <verb> [--json]` · `harness pair talk <words…>` · `harness pair mcp` | Your paired daemon's control interface (below): read every harness on every machine; talk to the daemon. |
| `harness remote-password set\|status\|clear` | This machine's persistent password for machine-to-machine links. |
| `harness link connect <id> [--name=<label>]` · `harness link list` · `harness link unlink <id>` | Let this machine reach another of yours, terminating E2EE here; list; unlink. |
| `harness remote` | From a Harness terminal tile: choose another of your machines (linking it on the spot if needed), open a terminal there and move this tile to it. |
| `harness devices [list] [--json]` · `show <#\|fp>` · `remove <fp>` · `history [--json]` · `dismiss [<#\|fp>]` · `rebaseline [--yes]` | The account's devices as this machine verified them (below): list · one in full · take one out on every device · every add and removal, newest first · mark new ones seen · review and trust a frozen list again. |
| `harness grid login [--force] [--json]` · `harness grid logout` | Sign the `grid` CLI in with this computer's account, no second browser. |
| `harness grid env <grid>` | `<grid>`'s relay address and key as shell exports, through the harness's own `grid`: `eval "$(harness grid env <grid>)"` before calling a Jev model at `$OPENAI_BASE_URL/systemone`. |
| `harness flash [flags]` | Re-flash a plugged-in Harness device over USB. Flags pass straight to the flasher. |
| `harness autonomous-device discover\|status\|list\|pair\|revoke` | Pair Autonomous OS devices found on the LAN, directly, with no relay. |

Interactive prompts read one line from stdin with `--stdin`; `--json` switches any of them to NDJSON.

The daemon also serves a loopback dashboard at `http://127.0.0.1:18473`: health, this machine's
fingerprint, paired clients, stop. It never renders a transcript. Configuration is environment
variables (`BACKEND_WS_URL`, `WEB_URL`, `ADAPTER_DATA_DIR`, `ADAPTER_COMPUTER_ID`, `PORT`, and the
per-engine home directories); [`cli/README.md`](cli/README.md) has the full table and the
`.env.example`.

## Automation

The app is one client of the daemon. Anything on the same computer can be another: the loopback
WebSocket at `ws://127.0.0.1:18473/api/local-ws` takes a `machine_select` frame first
(`{ machineId, localProtocolVersion: 1 }`, no `Origin` header), then request frames with a `requestId`
and answers them with `<type>_result`. Selecting one of your other machines proxies the request
through this daemon's link to it.

What it answers: `agents_list`, `agent_create`, `agent_restart`, `agent_retarget`, `agent_delete`,
`agent_update`, `agent_recent`, `agent_handoff_prepare`, `agent_read_file` (media previews, in 128 KiB chunks),
`fs_list_dir`, `engines_probe`, `codex_profiles_list`, `codex_profile_link`, `models_list`,
`usage_read`, `question_response`, `voice_route`, `message`, `cancel`, and `terminal_open` for a
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
harness new                          claude, in the current directory
harness new codex @mini ~/code/auth  codex, on the machine called mini, in that folder
harness new codex my-game            codex, in a new project ~/harnesses/my-game
harness new --plan --prompt "fix the flaky login test"
```

Words may come in any order: `@` marks the machine (id, name, or an unambiguous start of a word in
it), a path looks like a path, the first other word is the agent and a second names a new project.
`--mode auto|ask|plan|full`, `--name`, `--new [name]` and `--json` are the rest. There is still no
`harness split`: panes are arranged in the app.

## Your devices

Signing in is what makes a device trusted: every computer and app signed in to the account adds its
key to the account's device key log, and the others trust it with no password. Nothing asks you to
confirm a device; instead every device shows you each one it did not know before.
`harness devices` is this machine's view, the same one Settings ▸ Your devices shows in the app.

- **New.** A device added after this machine joined the account is flagged `new` (an OS notification
  in the apps) and stays flagged across restarts until you look: `harness devices dismiss` marks every
  one seen, `dismiss <#|fp>` just one; opening Your devices does the same in the apps.
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
