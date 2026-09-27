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
| `harness login [--force] [--json]` | Browser SSO; save this computer's session. `--force` signs in as a different account. `--json` emits NDJSON for GUI clients. |
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
| `harness grid login [--force] [--json]` · `harness grid logout` | Sign the `grid` CLI in with this computer's account, no second browser. |
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
`agent_update`, `agent_recent`, `agent_files`, `agent_read_file` (text, or media in 128 KiB chunks),
`fs_list_dir`, `engines_probe`, `codex_profiles_list`, `codex_profile_link`, `models_list`,
`usage_read`, `question_response`, `voice_route`, `message`, `cancel`, and `terminal_open` for a
binary terminal channel with scroll, resync and paste. The same frames travel from the web client
over the relay.

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
