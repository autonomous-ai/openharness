# The pair brain

How the paired daemon watches every harness on every machine, triages what waits on you, briefs you
when you come back, and later starts work you hand it. Build step 3 of [README.md](README.md).
Paths are in `cli/src` unless they say otherwise.

## Where it runs: sense everywhere, think where you are

- **Every harnessd runs a `PairSensor`** for its own harnesses. No model. It follows the session events
  (`emitSessionEvents`, turn start/end with `replay` and `subagent` flags), questions (`QuestionWatcher`
  `onQuestion`/`onQuestionGone`) and recaps (`CommanderMirror`), runs the rules, and keeps a journal:
  `ADAPTER_DATA_DIR/pair/journal.jsonl`, mode 0600, a ring with `epoch` and `seq`.
- **The brain runs in the harnessd of the computer you are at** (the one with a window or `hn`
  attached): triage, the voice, and the full pair harness. It reads other machines through
  `RemoteRelayPool.acquireIsolated` and sealed `pair_*` requests.
- No backend brain (the backend holds no keys and cannot read questions), no leader election (actions
  are de-duplicated on the machine that owns the harness), no always-on machine (journals cover a
  sleeping laptop).

## Three tiers

0. **Template line**, said at once, from the daemon's roster `lines` (slot templates, filled from the
   event).
1. **One small model call** per new question, using the collection DSH's observed engine, model and
   effort (`pair/intelligence.ts`): about 1k tokens in, 80 out, 30 s budget. The experiment and watching
   consent gate it; there is no separate model opt-in. Until the DSH is set up, templates keep working.
   Its words replace the template line in place when they come back in time; the line is never delayed
   for them. Cached per `requestId`, capped per hour, only while you are at the computer. Replays,
   sub-agents, terminals, deny-class prompts and the pair harness itself are skipped. A brief never asks
   a model.
2. **One persistent Companions DSH for the collection**, opened with its viewer on the left and its
   real agent terminal on the right, paused when idle. Not a session fed
   every event: that would resend a ~20k-token prefix on every wake, grow without end, and hold write
   tools all the time.

## Control interface

One implementation, `pair/control.ts`, behind a local-only `pair` request. Exposed as
`harness pair <verb> --json` (every engine) and `harness pair mcp`, a stdio MCP server named
`harnessd` (the name `harness` is taken by `harnessWebTools.ts`). Write tools need a per-launch
`HARNESSD_PAIR_TOKEN`.

| tool | this machine | another machine | kind |
|---|---|---|---|
| `list_machines` | fleet machines | – | read |
| `list_harnesses` | owner: registry + stopped + sensor state | `pair_list` | read |
| `read_harness` (state, question, recaps, asks) | owner: sensor + mirror | `pair_read` | read |
| `brief` | journal | `pair_journal` (fleet) | read |
| `recall_memory` | development-gated coding memory; current collection's personal scope and launch token only | – | read |
| `answer_question` | owner → `answer({ requestId })` | `pair_answer` (allow-class only) | write |
| `send_prompt`, `stop_turn` | owner → message (deliveryId), cancel | – (`REMOTE_ANSWERS_ONLY`) | write |
| `start_harness` | owner → create, mode `ask`, never bypass | – (`REMOTE_ANSWERS_ONLY`) | write |
| `pause_harness`, `resume_harness` | owner → stop service (guarded), resume | – (`REMOTE_ANSWERS_ONLY`) | write |
| `say` | `daemon_say` (mood `say`, `from: 'pair'`) | – | rate-limited |

Every write, local or remote, runs through the owning machine's `PairOwner` (`pair/owner.ts`), so the
floor and the journal live where the harness does.

The experimental coding-memory service is enabled in **Settings → Experimental → Coding memory**,
in addition to the companion and watching controls. The choice is local to this computer and account,
defaults off, and takes effect without restarting. `HARNESS_CODING_MEMORY=1` remains a migration default
only until the owner saves a choice; an explicit off wins. `recall_memory { query, conditions? }` is an agent read, bound by
the host to the current collection, with a byte-bounded historical-context packet and an unverified
delivery receipt. Its token is required even at `watch`; it cannot select an owner, project, session,
or avatar. It cannot inspect the owner's whole library, correct records, change privacy, or forget.

The separate `pair { verb: "memory", action: … }` control is for the person. Even reads require a
verified loopback process outside Harness panes and belonging to the daemon's OS user; a pair token
is refused. Unix-socket callers whose PID cannot be established are refused, not assumed to be the
person. `harness pair memory list|status|show <id> --json` exposes the initial read-only CLI.
The internal owner API also supplies paginated listing, retained evidence, and correction/forget/
Learn/Recall previews. Applying a change needs a two-minute, one-use capability bound to owner,
process, connection, exact command, and the unchanged library snapshot. `confirmed: true` never
counts. The desktop viewer uses this transport in **Companions → Memories**. Two preference actions,
`experiment` and `configure_experiment { enabled, expected }`, remain available while companions are off;
the latter checks the saved revision. Neither can access memories or start learning with companions off.
Turning Coding memory off cancels its background work and keeps saved records. Real-model quality and
the rollout gates remain unverified. Like existing lesson approval, process checks do not defend against
arbitrary malware running as the same OS user with access to the memory files.

**Autonomy dial** (zoo op `zoo.autonomy`, default `watch`): `watch` (read tools only, facts; lines
carry only `[g]`) · `suggest` (it recommends, every action waits for your key) · `act-on-key` (it may
drive harnesses it started; everything else is a proposal, one key each) · `act-within-rules` (as
`act-on-key`, and runs `~/.config/harness/pair.jsonc` rules on the owning machine and reports after).
The zoo's level is a request: each daemon acts above `suggest` only once the person confirmed it at a
window there, and runs pair.jsonc only once they confirmed that exact file (see "Security").

**The floor, at every level**: no delete, restart, fork or bypass. It never types into terminals or
into its own harness, and never into a pane that shows a dialog. Deny-class prompts — push, force,
`rm -r`, `reset --hard`, `clean -f`, sudo, `| sh`, `curl … |`, `chmod -R`, `mkfs`, `dd if=`, deploy,
publish, drop, merge — read over the WHOLE dialog, get no `[y]` key and are never recommended or approved
automatically. A `[y]` is only ever a one-time yes, and only on an allow-class permission prompt (reads,
tests, builds, linters, formatters, in-project edits); no daemon action ever keys "don't ask again",
"always" or "allow all". Only a permission prompt is ever answered for the person — its decline, or that
one-time yes — never a question the agent asks or a plan to approve, whoever asks (a key, the pair, a
rule, another machine) and whichever harness (one the pair started too). Question text and recaps are
untrusted data; the floor is enforced in code on the owning machine.

## Security

**Threat model.** A process running as the same user on this computer can already drive tmux, read the
panes and type into them: a key a daemon accepts from this computer is not a hard boundary, and the
daemon does not pretend it is. What the daemon must never do is EXTEND such a process's reach — to
another machine, to more than it could do by typing, or past what the person agreed to. Question text,
recaps, file contents and anything a model says are untrusted data. So:

1. **Keys.** (a) `daemon_act`, `daemon_shown`, `daemon_confirm`, `daemon_talk` and `daemon_presence` are
   taken only over the daemon's Unix socket (0600, in a 0700 folder), never the TCP port any user's
   process can open (`LOCAL_SOCKET_REQUIRED`), and all but presence only from a window bound to this
   machine — not a tool, not a relayed machine's socket (`UI_ONLY`). (b) A key counts only for a line
   THIS connection received and acknowledged as displayed with `daemon_shown { id }`, at least 400 ms
   before the key (`NOT_SHOWN`, `TOO_SOON`), and only while the line lives (its ttl, a proposal's ten
   minutes, a brief's minute) — `pair/shown.ts`. A lesson's key needs that AND the person
   (`pair/learn/approval.ts`, [LEARNING.md](LEARNING.md) "Security"): its line id is a one-time nonce only
   windows and `hn` are sent, spent by `y` or `n`, and never a tool's or a process the daemon can see inside
   a harness pane (`PERSON_ONLY`, `INSIDE_HARNESS`; over the Unix socket it cannot see the process, so
   such a key rests on the socket, the acknowledgement and the nonce). (c) A key relayed to ANOTHER
   machine is only ever an answer to an allow-class prompt, re-checked there; six a minute and sixty an
   hour on each side; and journaled on both: here as `relayed` with the window it came from, there as
   `act { by: 'remote', origin }`. Nothing else crosses: `REMOTE_ANSWERS_ONLY`. (d) The owning machine
   never believes a `pair_*` request's `by`: a sealed request is `remote`; a loopback `pair_*` is refused
   (`REMOTE_ONLY`).
2. **The floor for every answer.** `answerFloor` re-checks allow-class whoever asks and whatever harness
   (one the pair started included): only a permission prompt, only its decline or a one-time yes to an
   allow-class prompt (`NOT_ALLOW_CLASS`). A proposal shows the harness by name and machine and, in full
   (`detail`), the exact command or diff it answers, the whole prompt, a start's folder and first prompt.
   There are no batches: one proposal, one key; at most five wait at once.
3. **Allow-class is read with certainty** (`pair/classify.ts`, `pair/shell.ts`): one line only; a small
   tokenizer splits on `;` `&` `&&` `||` `|` and refuses any expansion, substitution, heredoc, subshell,
   brace or comment; an environment prefix is not allow-class; write- and exec-capable forms are off the
   list (`sort -o`, `git --output`/`-O`/`--ext-diff`/`-c`, `sed` other than `-n …p`, `find
   -exec`/`-delete`/`-fprint`, `xargs`, `awk`, `rg --pre`, `go -exec`/`-vettool`, `cargo --config`,
   `npx -y` …). A painted Bash block of more than one line (a description line and a second command line
   look the same), a Codex command with a line under it, or an edit whose question is not the single one
   after the preview naming the header's file, gets no `[y]`. The transcript's open tool call
   (`CommanderMirror.openTools`) is preferred when exactly one matches the dialog: it has the exact
   command. Every path — an edit's file, a command's arguments, a redirection — is resolved through
   every symlink and must stay inside the project, never under `.git/`, `.harness/`, `.claude/`,
   `.codex/`, never a home dotfile, never a file with a second hard link.
4. **What the person agreed to** (`pair/gate.ts`). The zoo's autonomy (reachable through the loopback
   proxy with `x-adapter-local`), a guest window's dial and pair.jsonc are requests. Lowering, and
   watch → suggest, apply at once; a level above `suggest`, and a pair.jsonc with rules, the model on or a
   learning opt-in (`learn.borrow`, `learn.export`, `learn.agentsMd`), take effect only after
   `daemon_confirm { kind: 'autonomy' | 'rules', nonce }` from a window that displayed the request. Every
   change is announced with a `daemon_say`; `daemon_state` carries `autonomy`, `autonomyRequested` and
   `confirms`. What was confirmed is kept 0600 (`pair/confirmed.json`); lowering below it has to be
   confirmed again to go back, and a yes holds only under the consent it was given in (the zoo's
   `consent.at`): once consent is answered again, the daemon steps down to `suggest` and asks again. Rules apply only to
   allow-class permission prompts, never to a plan or a question the agent asks.
5. **Talk and the pair's words.** `talk` is only `daemon_talk` from a window (the `pair` verb answers
   `UI_ONLY`), six a minute and sixty an hour, each answer with a cost note. The pair harness's `say` is
   `from: 'pair'`, carries no keys, loses any `[y/n]`-looking start, and is capped at six a minute and
   thirty an hour.
6. **Secrets.** Every journal line is redacted (the learner's `guard.redact`) before it is written, a
   journal page again on its way out, the triage prompt and every read tool's answer to the pair
   harness too. What a window shows the person stays exact.
7. **Consent.** Until the zoo's `consent.watching` is true (op `zoo.consent`, from the first-day
   screen), nothing is paired: no sensor, no journal, no learner, and the dial asks for `watch`.
8. **Lessons** are the person's alone: approve, restore and export need a one-time nonce — a key as in 1,
   or the CLI's `challenge` answered only to a verified process outside every harness — never the pair
   token or a bare `confirmed`. Notes never touch a tracked file unless the project is opted in; sessions
   get read-only copies. Details: [LEARNING.md](LEARNING.md), "Security".

Out of scope, and why: a same-user process can read the pair token, the socket, the confirmation file and
the panes — it can type into tmux without us. Windows has no Unix socket, so none of these frames are
taken there. The zoo's `zoo.turn`, `zoo.lesson` and presence are self-reported (a person can only cheat
their own zoo).

## Frames

**Local only** (loopback, handled beside `app_focus`; never through `send()`, which uploads every
frame and leaves types outside `ENCRYPTED_UP_TYPES` unencrypted). Older daemons answer UNSUPPORTED
and clients keep the roster lines.

- daemon → client: `daemon_state { needs[], working, failing[], machines[], asks[], autonomy, confirms[] }`,
  `daemon_say { id, about, mood, line, actions: [{ key, label, choice }], ttlMs, from?, detail?, harness?, confirm? }`,
  `daemon_unsay { id, reason }`, `daemon_brief { items[] }`
- client → daemon, over the Unix socket only: `daemon_shown { id }`, `daemon_act { requestId, id, choice }` →
  `daemon_act_result`, `daemon_confirm { requestId, kind, nonce, accept }` → `daemon_confirm_result`,
  `daemon_talk { requestId, text }` → `daemon_talk_result`, `daemon_presence { active, awayMs }`

**Machine to machine**, sealed through new `PAIR_REQUESTS`/`PAIR_RESULTS` entries in
`lib/e2ee/applicationFrames.ts` (`core.ts` is hash-pinned and never touched): `pair_watch` (pushes
`pair_event` via `wrapTarget`), `pair_journal`, `pair_list`, `pair_read`, and the one write another
machine may ask for, `pair_answer` (allow-class prompts only; it re-checks that the dialog still shows the
same question before typing: `STALE_QUESTION` if not). `pair_send`, `pair_stop`, `pair_start`,
`pair_pause`, `pair_resume` are answered `REMOTE_ANSWERS_ONLY`. All are answered by the owning machine's
floor, which decides who asked from how the request arrived (`remote`), never from its `by`.

**Clients**: the desktop merges `daemon_state` into its face and shows a `daemon_say` for its `ttlMs`
(5.2 s); the keys come first in the line (`[y/n/g] …`), are clickable and bound to a key chord, and
work only while the line shows. A line with a `detail` shows it in full with the line, and the client
sends `daemon_shown { id }` once it has drawn both; its keys count 400 ms after that. A `from: 'pair'`
line is drawn as the pair speaking. A line with `confirm` is answered with `daemon_confirm`. The badge
shows `daemon_state.autonomy`. `[g]` opens the harness (the client's to do). `hn` handles them beside
`commander_question`, answering with `prefix y` / `prefix n`.

## Brief on return

A client reports an absence of 15 minutes or more (`daemon_presence`, or a reconnect after that
long). The brain gathers journals since then, local and remote, 3 s each, and says the daemon's back
line with its `{summary}` ("reattached. 2 done, 1 waiting 40m, api failed, laptop asleep."). The brief
is template facts only — no model — at most five items, what needs you first; a waiting item carries its
keys first in its line, working while the brief is up (60 s). A per-desk cursor stops repeats; a daemon
restart is a baseline, not a return.

## Build

- **P0 Contract and sealing**: this file; `applicationFrames.ts` entries. Tests: pair frames are
  sealed, `pair_event` opens, an unsealed `pair_*` gets `E2EE_REQUIRED`.
- **P1 PairSensor**: hooks at the session events, question watcher and the `someoneCanAnswer`
  gate; `alwaysGenerate` switchable with an `onSummary` hook; the `expectRequestId` answer guard.
  Tests: replays are baselines; sub-agents, terminals and the pair harness excluded; journal ring and
  epoch; a stale answer sends no keys; the `pair` request is local-only.
- **P2 Triage and one key**: `pair/{fleet,brain,triage,voice}.ts`, the local frames, then desktop and
  `hn`. Tests: timeout, bad JSON, an off-list suggestion and deny-class prompts fall back to the
  template; a reconnect does not repeat a line; answered elsewhere sends `unsay`; `daemon_act` reaches
  the right machine; `daemon_*` never reaches the cloud queue.
- **P3 Brief**: wording, unreachable machine named, nothing under 15 minutes, nothing after a restart.
- **P4 Pair harness**: a built-in `autonomous/pair` harness over `control.ts`, the CLI and the MCP
  server; excluded from notifications; paused when idle. Tests: each tool maps to the right RPC; the
  autonomy matrix; write tools refused without the token; MCP round trip.
- **P5 Rules and handing it work**: `pair.jsonc`, `start_project`, `zoo.autonomy`. Tests: rules never
  approve deny-class prompts; every action is journaled.

## As built (P0–P5)

- **The switch.** Only while daemons are on at all ([README.md](README.md), "Off switches": the server's
  `HARNESS_DAEMONS`, harnessd's probe, the local kill switch); off, none of this runs. Then pairing is on
  while the account's zoo (`GET /api/zoo`, re-read on `zoo_changed` and on every reconnect) has `pair` set
  to a roster id; the same read takes `autonomy`. Signed out, a guest
  window says which daemon its local zoo pairs, and its dial, with `daemon_presence { pair, autonomy }`.
  Off, every daemon senses nothing and answers `pair_*` with `PAIR_OFF`.
- **Local frames** go only to the loopback sockets bound to this computer's machine (`sendLocal`), and
  every one that carries a keyed id is recorded against the connections it reached (`pair/shown.ts`).
  `daemon_act`, `daemon_shown`, `daemon_confirm`, `daemon_talk` and `daemon_presence` are consumed and
  never forwarded, only over the Unix socket (`LOCAL_SOCKET_REQUIRED` on TCP), and all but presence only
  from a window bound to this machine (`UI_ONLY` for a tool or a relayed socket, whose presence carries
  no guest pair, dial or consent). A TOOL client (`machine_select { tool: true }`: `harness pair`, the MCP
  server) is answered but gets no `daemon_*` frames and is never presence.
  - `daemon_state { pair, needs: [{ machineId, machine, agentId, name, engine, requestId, question, options,
    deny, allow, since, id?, line?, actions? }], working, failing: [{ machineId, machine, agentId, name,
    reason }], machines: [{ machineId, name, status, local }], done: { count, last: [{ machineId, machine,
    agentId, name, recap, at }] }, asks: [{ id, line, actions, verb, from: 'pair', harness, detail, at } | a
    lesson's { id, line, actions, detail }],
    acted: [{ machineId, machine, agentId, name, by, action, text, at }], autonomy, autonomyRequested?,
    confirms: [{ id, kind, nonce, line, detail, actions, at, level? }] }` on change and to a client as it
    attaches; `pair: null` means use the roster lines (autonomy and confirms are there too). A need
    carries `detail` (the whole dialog) always, and `id/line/actions` only while its line shows. `status` is `ok`,
    `connecting`, `unreachable`, `asleep` (the account lists it offline: calm, never a failure),
    `unlinked`, `old` or `off`. `done` is the `+n` of finished turns, cleared by
    `daemon_presence { doneSeen: true }` or a brief; finished turns are never spoken.
  - `daemon_say { id, about, mood, line, actions, ttlMs, from?, detail?, harness?, confirm? }`, moods
    `need`, `fail`, `back`, `auto` (a rule or the pair acted: drawn like done), `say` (the pair talking,
    `from: 'pair'`, or a setting that changed: idle) and `ask` (a proposal, `from: 'pair'`, or a setting
    waiting for a yes, with `confirm { kind, nonce }`: need). Keys
    first, `ttlMs` 5.2 s; a second `daemon_say` with the same id replaces the line in place (the model's
    words), keeping the time it had left. At most one unsolicited line (`need`, `fail`, `auto`) every two
    minutes, never about `daemon_presence.focusAgentId` (+ `focusMachineId`, default this machine).
    `daemon_unsay { id, reason }` with `answered`, `gone`, `done`, `stale`, `declined` or `replaced`.
  - `daemon_brief { desk, line, items: [{ id, kind, machineId, machine, agentId?, name?, line, actions?, detail?,
    text? }] }`, `kind` one of `waiting`, `failed`, `unreachable`, `asleep`, `done`; at most five. A lesson's
    `[s]` sends one with a single `kind: 'lesson'` item, its `text` in full and the line's own id.
  - `daemon_presence { active, awayMs?, desk?, pair?, autonomy?, consent?, focusAgentId?, focusMachineId?,
    doneSeen? }`; `daemon_shown { id }` (this window drew the line and its detail); `daemon_act { requestId,
    id, choice }` → `daemon_act_result { requestId, id, ok, machineId?, open?, results?, learned?, skipped?,
    lesson?, error?, detail? }`. `choice` is an action's `choice` or its key; `g` answers `open` and types
    nothing; on a lesson `y`/`n`/`s` answer `learned`, `skipped` or `lesson` (its text). Errors:
    `LOCAL_SOCKET_REQUIRED`, `UI_ONLY`, `NOT_SHOWN`, `TOO_SOON`, `PERSON_ONLY`, `INSIDE_HARNESS` (a lesson's
    key), `PAIR_OFF`, `GONE`, `NOT_OFFERED`, `STALE_QUESTION` (the dialog on screen changed: nothing typed,
    the line goes as `stale`), `DENY_CLASS`, `NOT_ALLOW_CLASS`, `PERSISTENT`, `AUTONOMY_WATCH`, `UNTOUCHABLE`,
    `REMOTE_ANSWERS_ONLY`, `RATE_LIMITED`, `MACHINE_<STATUS>`.
  - `daemon_confirm { requestId, kind, nonce, accept }` → `daemon_confirm_result { requestId, kind, nonce,
    ok, accepted?, error? }` (`STALE_CONFIRM`, `NOT_SHOWN`, `TOO_SOON`, `UI_ONLY`).
  - `daemon_talk { requestId, text }` → `daemon_talk_result { requestId, ok, agentId?, started? | resumed?
    | sent?, error?, retryAfterMs?, cost }`: the person's words to the pair harness.
- **Machine to machine**, all sealed: `pair_watch { off? }` → `{ snapshot }`, then `pair_event { machineId,
  rev, agentId, harness, entry?, baseline?, removed? }`; `pair_journal { epoch?, seq? | at?, limit? }` →
  `{ epoch, seq, entries, reset?, truncated? }`; `pair_list` → `{ harnesses }`; `pair_read { agentId }` →
  `{ harness, row, recaps?, asks? }`; writes `pair_answer { agentId, expectRequestId, choice, by }`,
  `pair_send { agentId, text }`, `pair_stop`, `pair_start { engine, cwd, prompt?, name? }`, `pair_pause`,
  `pair_resume` → `{ ok, … }` or `{ error, detail? }`. The owning machine's `PairOwner` answers them: a
  sealed request is `by: 'remote'` whatever it says, may read and may answer an ALLOW-CLASS prompt (six a
  minute, sixty an hour per connection, journaled with its `origin`), and nothing else
  (`REMOTE_ANSWERS_ONLY`); a loopback `pair_*` is `REMOTE_ONLY`. The floor is the one a local key gets
  (`pair/owner.ts`): not a terminal or the pair harness (`UNTOUCHABLE`), `GONE`, `STALE_QUESTION` against
  its sensor and then against the dialog on screen (`AskQuestionController`, which types nothing),
  `NOT_OFFERED`, `DENY_CLASS`, `NOT_ALLOW_CLASS`, `PERSISTENT`, `QUESTION_OPEN` for a prompt sent into a
  dialog, `AUTONOMY_WATCH`. Pause is the guarded stop service (`agent_delete`: conversation kept). Every
  action is journaled as `act { by, action, text, origin? }`; the brain reports `rule`/`pair` ones
  afterwards (`auto`) and lists `remote` ones in `acted`.
- **What a dialog is** (`pair/classify.ts`): the question watcher keeps the WHOLE dialog (every line,
  `askQuestion.ts` `dialog`, also in its fingerprint, and on the question as `dialog`, 16k at most) and
  whether it is an approval. Deny-class is read over all of it; allow-class is a permission prompt read
  with certainty (see "Security", 3) whose every command is a read, test, build, linter or formatter, or
  an edit/read of a file in the project; the transcript's open tool call decides when exactly one
  matches. `[y]` = a one-time yes on an allow-class prompt; `[n]` = a permission prompt's decline (on
  another machine's line only an allow-class one's); `[g]` = open, always.
- **Control interface** (`pair/control.ts`, P4): the local-only `pair { verb, … }` → `pair_result`, verbs as
  in the table plus `talk` (refused, below) and `lessons` ("Learning" below); the sensor keeps
  `status | list | journal | read`. Writes need `HARNESSD_PAIR_TOKEN` (`pair/token.ts`: 32 random bytes,
  rotated at every launch of the pair harness, kept 0600 in `ADAPTER_DATA_DIR/pair/token`, passed to the
  harness as `HARNESSD_PAIR_TOKEN_FILE` and to its MCP server as `--token-file`), else `TOKEN_REQUIRED`. It
  keeps a same-user shell or another harness's agent out, not a determined local process (it can read the
  file); the floor holds regardless. Then the dial: `watch` → `AUTONOMY_WATCH`; `suggest` → `{ proposed, id }`
  and an `ask` line with the harness and the exact `detail`; `act-on-key` / `act-within-rules` → runs at once
  on a harness the pair started (`pair/started.json`, the owner's floor still deciding), else its own
  proposal. Another machine: an answer only (`REMOTE_ANSWERS_ONLY`). Proposals stay in `daemon_state.asks` for
  ten minutes, at most five (`TOO_MANY_PROPOSALS`); a key runs one as `key`. Read tools answer with secrets
  redacted. `talk` is refused here (`UI_ONLY`): the person talks from a window. `harness pair <verb> [--json]`
  (pair/client.ts; a pairing code is never a verb) and `harness pair mcp`, a stdio MCP server named `harnessd`
  (`pair/mcp.ts`: JSON-RPC 2.0 lines, `initialize`, `tools/list`, `tools/call`, `ping`; no SDK dependency)
  speak it as tool clients.
- **The pair harness** (`pair/pairHarness.ts`, P4): the built-in `autonomous/pair`, generated on the machine
  (`dsh/builtins.ts` `ensureBuiltinPair`, source `builtin:pair`, hidden from `dsh_list` and the
  Orchestrator's catalog). Claude Code, else Codex; mode `ask` pinned (`DSH_PERMISSION_MODE`); harnessd
  injected like gridWebMcp (`--mcp-config` with only the read tools in `--allowedTools`; Codex
  `-c mcp_servers.harnessd.*`); instructions carry the paired daemon's lore, first words, family, line
  templates, the tools, the dial's answers and the floor. Started by `daemon_talk` (new token),
  resumed if paused (new token), words forwarded if live; paused through the guarded stop after 10 minutes
  without a turn or a talk. Switching individuals, renaming, and package updates keep the same agent,
  model choice, terminal, and conversation. A verified `UserPromptSubmit` hook supplies the current
  character's context to Claude/Codex without sending an artificial turn. On upgrade the selected
  individual's chat is adopted; other per-individual chat pointers and transcripts remain archived.
  Collection membership keeps account/guest conversations separate. Its turns carry `subagent`
  (no notification; silent on the dial), are not zoo turns, and the notification sensor never watches it.
- **Autonomy and rules** (P5): `zoo.autonomy { level }` (backend `lib/zoo.ts`; an unknown level is dropped;
  default `watch`), a request the gate lets through (`pair/gate.ts`, "Security" 4). `pair.jsonc` at
  `$XDG_CONFIG_HOME/harness/pair.jsonc` (else `~/.config/…`), JSON with comments, re-read when it changes
  (and every 30 s): legacy `model` (accepted for compatibility; intelligence follows the DSH), `learn` (`borrow`, `export`, `agentsMd`:
  [LEARNING.md](LEARNING.md)) and `rules: [{ name?, harness? (glob), engine?, project? (folder, `~`),
  question (regex over the question text), choice }]` — all of it applied once the person confirmed that
  exact text. Under `act-within-rules` the first matching rule answers a question as it opens on the
  owning machine, through the owner (`by: rule`, the rule's name in the journal). A rule answers only an
  allow-class permission prompt (its one-time yes or its decline): never deny-class, never a plan or an
  agent's question, never a persistent option. A malformed file is no rules at all. Not built:
  `start_project`.
- **Consent** (`zoo.consent { watching }`, `consent { watching, at }`): until it is true, `pairingFrom`
  pairs nothing (no sensor, no journal, no learner) and asks for `watch`; every yes sets the dial to
  `watch`, so a level held before a no never comes back with the yes that follows (and the gate's
  confirmation of it is void under the new `consent.at`). A guest window says it in `daemon_presence { consent }`. What the daemon reads and writes, for
  the consent screen: [README.md](README.md), "What your daemon sees".
- **Voice** (`pair/voice.ts`): roster lines are slot templates (`{who}`, `{q}`, `{recap}`, `{n}`,
  `{summary}`), filled verbatim; the daemon's words keep their case, digits and spacing; a template with an
  unfillable slot falls back to a plain fact line, and one that leaves out a fact the mood must carry gets
  it appended. The cli's roster copy also carries lore, first words and family for the pair harness.

## Learning (L1, L2) as built

Notice, propose, teach, revert (L1); borrow, check, export (L2); person-only approval. The full design is
[LEARNING.md](LEARNING.md). Everything is in `pair/learn/`, runs in every harnessd for its own harnesses,
and — except usage tracking and the `lessons` verbs — only while pairing is on.

- **Notice** (`signals.ts`, no model): from the same session events the sensor reads — never replays,
  sub-agents, terminals or archived pair chats; the active collection DSH's real work is included —
  three signals: the person's next prompt after a turn
  corrects the agent (`no, …`, `don't …`, `stop, …`, `that's wrong`, `instead …`, `not like that`,
  `revert …`; a prompt the daemon sent never counts); the same failing test or command on two engines or
  harnesses in one project within 7 days; the same 3–5 command steps in three turns of one project. Each
  carries provenance (engine, machine, agent, session, turn, the project hashed) and redacted evidence;
  `ADAPTER_DATA_DIR/pair/learn/signals.json` keeps the week (redacted). Default: nothing.
- **Distill** (`distill.ts`): queued, three at a time while nothing works (or after an hour), into at most
  one lesson each — a skill (≤ 30-line body) or a project note (≤ 5 lines). The collection's durable
  queue waits until its DSH model is ready. One bounded review uses that same engine/model/effort;
  there is no fallback to the voice router or another agent. Its expected answer is `{"lesson": null}`,
  its prompt redacted whole. Failures and rate limits keep evidence for a later review. Every lesson
  passes `guard.ts` (refused for a pipe to a
  shell, a credential, a safety switched off, exfiltration or injected instructions; emails and home paths
  redacted), and the rendered file is guarded again before it is kept.
- **Store** (`store.ts`): `HARNESS_LESSONS_DIR`, default `~/.harness/lessons/`, outside any repo:
  `pending/<id>`, `skills/<name>`, `notes/<id>`, `archive/<name>`, each an Agent Skills SKILL.md (or
  NOTE.md) with `metadata.harness { learnedBy, from, approved, evidence, provenance? }`. One commit per
  approval, `git revert` per revert, and `stale:` (empty), `archive:`, `restore:` commits from the curator;
  no global git config, author `Harness`; without git a plain journal, and it says so. Everything written
  is redacted.
- **Conversation review** (`conversationReview.ts`): an explicit 1–24 hour lookback over
  up to 300 dated local indexed turns, excluding tools and reasoning. Bounded project
  batches share the collection DSH's selected model and the distiller's rate limit.
  Progress and reviewed hashes survive restarts; incomplete coverage and waiting states
  are visible. Every cited candidate stays pending in the Memories inbox. Its verified
  window receives a one-use, expiring capability bound to the lesson text; approval still
  requires `daemon_shown`, the arming delay and the person-only key verdict.
- **Propose** (`propose.ts`, `PairLearner`): `daemon_say { mood: 'ask', actions: [y teach, n skip, s show] }`,
  e.g. `[y/n/s] teach your agents "run-migrations-safely"? you corrected codex.` At most one an hour,
  never while a `need` shows, never about the focused pane (`PairBrain.isFocused`), never at `watch`,
  only while you are here; in `daemon_state.asks` for ten minutes. The line's id is `lesson:<id>:<nonce>`,
  and it carries the lesson's whole text as `detail` (what `y` would teach, shown before `daemon_shown`).
  The brain routes `lesson:` ids through `joinProposals`; `s` answers with a `daemon_brief` whose one item
  is `kind: 'lesson'` with the text. `DaemonAction.key` gains `s`. An approval journals `learned { daemon }`
  (`PairSensor.learned`) and, signed in, sends `zoo.lesson { lessonId, daemonId }` (`lib/zooLessons.ts`):
  `rules.lessonXp` (25) bond for that daemon, once per lesson.
- **Teach** (`publish.ts`): skills through the Store runtime path — `prepareHarnessLaunch(…, lessons)` copies
  the session's skills, read-only, into `<runtime>/lessons` (never a link to the lessons folder) and indexes
  one line per skill in CONTEXT.md (a project's skills only in its sessions; never fails a launch). Notes
  into the project's untracked `.harness/lessons.md` (`.git/info/exclude`), which CONTEXT.md points at; into
  a marked `<!-- harness:lessons -->` block of AGENTS.md or CLAUDE.md only in a project opted in with
  `pair.jsonc` `learn.agentsMd`. Never an engine-private folder, except export.
- **Borrow** (`borrow.ts`, opt-in `learn.borrow`): read-only candidates from Hermes' agent-created skills,
  Claude Code auto memory for the projects harnesses run in, and Codex memories; guarded, de-duplicated by
  source and by text, three a pass every six hours when idle, five waiting at most, proposed on the same
  line (`borrowed from hermes`).
- **Check** (`usage.ts`, `curate.ts`): a session reading a lesson's SKILL.md is its use (a turn in its
  project, for a note); `usage.json`; a daily curator, when idle, marks 30 days unused stale and archives a
  skill at 90, not counting week-long absences.
- **Export** (`export.ts`, opt-in `learn.export`): approved skills also written to `~/.agents/skills` and
  `~/.claude/skills`, marked `metadata.harness.managed: true`; only files Harness wrote (their hash in
  `export.json`) are ever updated or removed.
- **Revert and the verbs**: `harness pair lessons [list|show <id>|approve <id> [--create]|skip <id>|revert
  <id>|restore <id>|export [--dry-run]]`, the control interface's `lessons` verb (works with pairing off).
  `revert` is `git revert` of the lesson's commit plus unpublishing (the note taken out; the skill out of
  running sessions' copies and exports).
- **Person-only** (`approval.ts`): approve, restore and export need a daemon-issued one-time nonce — the key
  line's id (sent only to windows and `hn`; its key counts only as "Security" 1 says: over the Unix socket,
  from the window that acknowledged the line 400 ms before, and never a tool's or a process the daemon can see
  inside a harness pane — `PairBrain.onKey` with `lessonKey`), or a `challenge` the daemon answers only to a
  caller it verified over loopback TCP (its pid by `lsof` or `/proc`, its ancestry outside every harness pane
  and the daemon), bound to that process, then `[y/N]` at the terminal. The pair token (`PERSON_ONLY`), a bare
  `confirmed` (`NONCE_REQUIRED`), an unverifiable caller (`UNVERIFIED`) and one inside a harness
  (`INSIDE_HARNESS`) are refused. The goal is agents, not same-user malware (LEARNING.md, "Security").
- **Limits**: plain coding sessions get skills only through export and notes only in opted-in projects;
  signals and lessons are per machine.

## Risks

- A late answer landing on the next dialog: fixed (the answer re-checks the dialog's id as it types).
- The token, the socket and `confirmed.json` are same-user files: they keep other users and casual callers
  out, not a determined local process — which can type into tmux anyway ("Security").
- A Claude Bash prompt gets a `[y]` only when the transcript's tool call matches it (the painted block is
  ambiguous); a transcript that lags the pane costs the key, never approves more.
- Windows has no Unix socket: the pair's keys, talk and confirmations are not taken there.
- Rules and a level above `suggest` need a window on THAT machine to be confirmed: a headless machine
  stays at `suggest` and runs no rules.
- A model's recommendation is only ever a label on an allow-class prompt; the allow-list is the
  boundary, and it leans narrow.
- Frames leaking unencrypted through `send()`: `daemon_*` only via `sendLocal`, `pair_*` only sealed.
- A machine that is not linked stays invisible; the daemon says so once.
- Older daemons cannot report questions.
- Reading panes with no window attached costs something: only open turns, only while pairing is on.
- Two computers open means duplicate model spend.
- No engine CLI for the one-shot: lines stay template-only.
- A lesson distilled or borrowed from untrusted text: guarded (refusals, redaction, injected instructions
  struck out, the rendered file guarded again), only ever taught on the person's yes — a nonce no agent is
  sent — and one `git revert` away.
