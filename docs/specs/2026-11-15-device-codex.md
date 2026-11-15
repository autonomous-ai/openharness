# The dial talks to Codex outside Harness through `codex queue` (Diego, 2026-11-15)

Wave 1 #3 of the device integration roadmap, on top of wave 1a
([the dial shows and talks to agents outside Harness](2026-11-13-device-claude-orca.md)) and the dial follow chain
(#4311, #4326, #4331). Today the dial's voice reaches a Codex session outside Harness only when it runs in an Orca
terminal, and only while it is idle: Codex's approval overlay takes `y` or Enter and has no hook, so typing into a
working Codex could answer a prompt. This run gives every live Codex session the voice route Claude Code has through its
mod: words that never touch the terminal and wait for the turn to end.

## Decided (Diego and the PM, 2026-11-15)

- **Voice goes through `codex queue --thread <id> --message=<text>` first**, in every state: idle, working, or waiting
  on an approval prompt (Diego's earlier decision: "a busy agent still takes voice"). The spike shows it is safe in each
  (below).
- **Only the Codex home Harness itself reads** (`env.CODEX_HOME`, `~/.codex` by default). A session whose transcript is
  in another home keeps today's route: typed into its Orca terminal, only while idle. The home is never derived from a
  hook's path: `codex queue` loads the home's `config.toml`, and a path a hook sent must not choose what config the
  devices process runs.
- **Typing into Orca is the fallback**, only when the queue definitely failed (no `codex` binary, a non-zero exit) and
  only under today's rules (idle, at a known Orca handle).
- **"Sent" on the dial means queued.** Codex starts the turn when it is free: within 0.5 s with Codex's local daemon,
  within about 10 s with `--no-daemon`, after the running turn, or after the person approves the prompt in the app.
- **After the person cancels a turn, the dial's words wait for the person** (found in the real-Codex check, PM,
  2026-11-15). Codex 0.167 holds its queue after an interrupt: answering an approval with No (its only No is Esc,
  "tell Codex what to do differently") or pressing Esc in a working turn leaves the queued words waiting until the
  person's next typed turn ends; they run right after it. This is Codex's queue, and nothing here forces it on
  without typing into the terminal. In that case the dial's follow mark goes to the person's typed prompt, so the dial
  does not turn for it, and turns for its own words when they run; the dial is usually on that agent already. Kept as
  is, with no timer.
- **Opening a thread with `codex://threads/<id>` is not in this run.** The Codex app is not installed on the build Mac,
  so nothing here can show which bundle id its sessions report or that its threads reach the dial. It is its own item,
  after Diego checks it on a Mac with the Codex app (about 5 minutes).
- **Platforms:** macOS and Linux, where the observed agents run today. Windows later, with the rest of the observed
  agents.

## The spike (2026-11-15, `@openai/codex` 0.167.0)

A throwaway `CODEX_HOME` in a scratch folder, a local mock of the Responses API as its model provider (no account, no
secret), Codex's TUI in a private tmux server. Nothing touched the account's real threads, daemon or dial.

| Case | What happened |
|---|---|
| TUI idle, Codex's daemon (its default) | The queued message started a turn within 0.4 s |
| TUI idle, `--no-daemon` (how Harness runs its own Codex) | The TUI reads the queue about every 10 s: the turn started within 10 s |
| A turn running | The message waited and started as the turn ended |
| An approval prompt open | A queued "yes" did **not** answer it; the message started 0.2 s after the person approved in the TUI. Answered No (Esc), the message waited for the person's next turn (real-Codex check) |
| Esc in a working turn | The queued message waited for the person's next typed turn, then ran (real-Codex check) |
| A half-typed draft in the composer | The draft stayed; the voice message ran as its own turn (typing would have joined the draft) |
| Two lines; text starting with `--` | One message with its newline; the text must be joined to its flag (`--message=<text>`), or `--dash` is read as a flag |
| A thread not in that home; a malformed id | Exit 1 with a message, nothing queued |
| A thread with no TUI open | Queued; it runs when the thread is next resumed. `--resume` with no daemon only warns |
| Running time | 0.1 to 0.45 s. `codex queue` never starts Codex's daemon (a TUI started without `--no-daemon` does) |

## Goal

With Codex running outside Harness in any terminal on this computer, a person at the dial says the next prompt to it,
whether it is idle, working or waiting for an approval, and it runs as the next turn. Every approval is still answered
in its own app.

## Design

### Data flow

```
dial voice ──▶ devices: ObservedSource.send(agent, text)
   engine codex, live, transcript under env.CODEX_HOME/sessions
     └─ codexQueue.send(threadId, text)
          execFile(codex, ['queue', '--thread', id, `--message=${text}`])   no shell, cwd = homedir,
                                                                           CODEX_HOME = env.CODEX_HOME, 10 s
          ├─ exit 0 ─────────────▶ { ok: true }                          count 'codex'
          ├─ timeout ────────────▶ "<name> did not answer."               count 'codex-timeout' (no fallback: it may be queued)
          └─ exit ≠ 0, no start ──▶ fallback: today's Orca route (idle + handle only), else "<name> did not answer."
                                                                          count 'codex-failed'
   anything else: today's route, unchanged (mod for Claude Code, Orca typing for an idle agent)
```

### `cli/src/cable/hosts/codexQueue.ts` (new, in the devices process)

- `createCodexQueue(deps)` returns `{ can(): boolean; send(threadId, text): Promise<CodexQueueResult> }`, where a
  result is `queued`, `timeout`, `busy`, or `failed` with its reason (the exit code, or `no binary` when it could not
  start), so the one log line can name it.
- `deps`: `run(file, args, { cwd, env, timeoutMs })` (execFile, `killSignal: 'SIGKILL'`, a deadline that answers by itself,
  as `orca.ts` does), the binary, `home` (`env.CODEX_HOME`), `cwd` (`homedir()`).
- **The binary is the Codex Harness itself launches** (PM, 2026-11-15): `engineBin('codex')` (`lib/engineBin.ts`:
  `CODEX_PATH`, else `codex`), resolved with `resolveBinaryOnPath` on the daemon's `PATH`. No login-shell probe: where
  Harness can launch Codex, the queue finds it.
- `can()`: that binary resolves. A look holds 30 s: the dial's list asks it for each Codex row every second while a
  dial is connected, and a walk of `PATH` took 0.24 to 0.7 ms on this Mac (review, 2026-11-15).
- `send` checks before it runs anything: the thread id is a UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`),
  the text is 1 to `MAX_TEXT` (2,000) characters. The text is passed as is (newlines stay: they do not submit anything
  in a queue), joined to its flag.
- **One command at a time per thread:** a second send while one runs answers `busy` (the dial says "<name> has not taken
  your last words yet."), so two transcripts never race into the queue out of order.
- **What it logs:** nothing itself; the observed source's one line per send names the route and, for a failure, its
  reason: `[device] voice · codex-failed (exit N)`, `(no binary)`, or `(refused)` when the queue ran nothing because
  the words themselves failed its checks (an empty text, a NUL) (PM, 2026-11-15).
  Never the text, the thread id or a path: Codex's own error text names the thread and the home.

### `cli/src/cable/hosts/observed.ts`

- `ObservedActions` gains `codexQueue: Pick<CodexQueue, 'can' | 'send'>` and `codexHome: string`, and `count` gains
  `'codex' | 'codex-failed' | 'codex-timeout'`.
- **Queue-able:** `engine === 'codex'`, the session is live, its transcript path is within `<codexHome>/sessions`
  (`within`, as the scan uses), its session id is a UUID, and `codexQueue.can()`. A Codex hook's `session_id` is the
  thread id `codex queue` takes (the rollout's file name ends with it; Harness resumes Codex by the same id).
  A session with no transcript path yet is not queue-able.
- **`capabilities`:** `voice` is `live && (queue-able || handle || mod ready)`. A Codex session in a terminal Harness
  cannot type into (Ghostty, iTerm2, Terminal) now takes voice.
- **`send`, for a queue-able session:** queued before the state checks. A `needs-you` or `working` Codex is no longer
  refused. On `failed`, the code goes on to today's checks with today's sentences (PM, 2026-11-15): ended or no
  handle is "<name> did not answer.", `needs-you` is "<name> is waiting for your answer in <Host>.", working or idle
  not known is "<name> is busy. Say it when it is done.", and only an idle agent at its Orca handle is typed into.
- **The dial's own words do not turn the dial** (PM, 2026-11-15): as the pane-follow rule says for a turn the dial's
  words started, the turn a queued message starts is the dial's own. The mark is set before the command runs and kept
  only when the result is `queued`. Whether Codex runs its prompt hook for a queued message is checked by the
  real-Codex check (Verification).
- The session may end between the check and the queue: its message then waits in Codex's queue and runs when the
  thread is resumed. Codex's CLI has no way to take a queued message back; this is said here, not handled.

### `cli/src/services/devices.ts`

- Builds `createCodexQueue({ home: env.CODEX_HOME, ... })` beside the Orca actions and passes it into the observed
  source. Nothing in the core changes (cli/AGENTS.md rule 7): the devices process runs `codex` itself, as it runs `orca`.

### What changes for people

- Codex outside Harness takes voice in any terminal, not only in Orca, and while it works or waits on an approval.
- The refusals "<name> is busy. Say it when it is done." and "<name> is waiting for your answer in <Host>." no longer
  come for a queue-able Codex session. They stay for every other route.
- A Codex session with its own `CODEX_HOME` behaves as today.

### Failure cases

| Case | What the person sees | Log |
|---|---|---|
| No `codex` on `PATH` | Voice only where Orca can type, as today | `voice · orca` or the refusal |
| An old Codex with no `queue`, or a thread not in the home | Today's checks and sentences: typed into Orca when idle at a handle | `voice · codex-failed (exit N)` |
| `codex queue` hangs past 10 s | "<name> did not answer." (it may still have queued, so nothing is typed) | `voice · codex-timeout` |
| A second transcript while the first is queueing | "<name> has not taken your last words yet." | `voice · pending` |
| The session ended just before | Sent; it runs at the thread's next resume | `voice · codex` |

### Security

- No shell: `execFile` with fixed arguments; the thread id is checked as a UUID; the text is one argument joined to its
  flag.
- The home is Harness's own setting, never a hook's path; the cwd is the home directory, so no project's `.codex/`
  config is read.
- `codex queue` never answers an approval (spike), so the dial still approves nothing.
- No text, thread id or path in logs or errors.

### Data

Nothing new is stored, synced or exposed by Harness. Codex keeps the words in its own queue (`queue_1.sqlite` in the
home) until its TUI takes them, as it keeps anything typed into that thread; they stay only on this computer. The
devices process holds the text in memory for the length of one `codex queue` call.

### Measures

The `[device] voice · <route>` log line the devices process writes today, with three new routes: `codex`,
`codex-failed (exit N | no binary | refused)`, `codex-timeout`. Counts only.

## Tests

- `codexQueue.spec.ts`: the arguments (`--message=--dash…` joined, a multi-line text whole), `CODEX_HOME` and cwd, the
  UUID and length checks run nothing, the timeout answers `timeout` at its deadline, one at a time per thread, no
  binary is `can() === false`, a non-zero exit is `failed`, and the log holds no text or id.
- `observed.spec.ts`: a queue-able Codex session is sent through the queue when idle, working and `needs-you`; a Codex
  session outside the home, or with no binary, keeps today's route; `failed` falls back to Orca only when idle at a
  handle; `timeout` never types; `capabilities.voice` for a Codex session in Ghostty.
- `devices.spec.ts`: the queue is wired with `env.CODEX_HOME`.
- End to end (`cli/e2e/deviceCodex.e2e.ts`, CI): the real daemon, a fake dial, and a fake `codex` on the daemon's
  `PATH` that records its arguments and `CODEX_HOME`. A Codex session outside a pane (its hooks, a transcript under the
  test's Codex home) in a working state takes the dial's words, and the fake records one `queue` call with the thread
  and the words.

## Verification

Once on this Mac, by hand or by the tester, with nothing of Diego's: the real `codex` 0.167, a throwaway `HOME` and
`CODEX_HOME`, the mock Responses server from the spike as the model provider, Codex's TUI in a private tmux server,
the dev daemon under that `HOME` (its Codex hooks installed in that home, so the session reaches the dial through its
real hooks) and a fake dial. Voice to the idle, working and approval-waiting TUI each starts a turn with the dial's
words, and the approval is still open after the voice arrives. This also checks that the hook's session id is the
thread id `codex queue` takes.

## Not in this run

- `codex://threads/<id>` to open a thread in the Codex app (its own item, above).
- Answering a Codex approval from the dial (never, as for Claude Code).
- Codex sessions in a `CODEX_HOME` other than Harness's own.
