# Dial voice to Codex and other engines in Terminal.app, iTerm2 and Ghostty (2026-11-25)

Approved approach: B (PM, 2026-11-25). Status: approved by the PM (2026-11-25), revised after the builder check.

## Goal

When a person speaks at the dial, the words reach the selected agent in Terminal.app, iTerm2 or Ghostty: Codex, and
the other engines the dial lists there. The one rule above all others: **words never land in the wrong pane, or in a
pane whose agent is not the selected one.** If the target cannot be proven, nothing is sent and the dial shows its
usual outcome for words that did not get through (`<name> did not answer.`). No new copy.

## What happens today

`ObservedSource.send` (`cli/src/cable/hosts/observed.ts`) tries three routes in order:

1. **Codex's queue**: `codex queue --thread <id> --message=<text>` under the daemon's `CODEX_HOME`. It is used only
   when the session's rollout is in `<env.CODEX_HOME>/sessions`. That is `~/.codex` by default, so Codex on `~/.codex`
   already takes voice in every terminal, on every OS.
2. **Claude Code's mod.**
3. **An adapter that types**: Orca, herdr, cmux, kitty, WezTerm, Zellij, or VS Code's terminals.

The `tabs` adapter (`tabs.ts`) only selects tabs. Three gaps follow:

- A Codex whose home is a home Harness adopted or a linked profile gets no voice.
- The other engines get no voice in these three terminals.
- Neither does Claude Code without its mod.

## Safe paths, by terminal and OS

| Engine | macOS Terminal.app | macOS iTerm2 | macOS Ghostty with `tty` | Linux Ghostty | Windows |
|---|---|---|---|---|---|
| Codex on a trusted home (part A) | ✅ queue | ✅ queue | ✅ queue | ✅ queue | — (these apps do not run there; the queue in any other terminal gains the same homes) |
| Codex on another home; another engine whose turn end Harness hears; Claude Code without its mod (part B) | ⛔ | ⛔ (Broadcast Input) | ✅ `input text` + `send key` | ⛔ | — |

Part B types only when the agent is known to be at its prompt (`idleKnown`, `observed.ts:524-527`). That means:
- Claude Code and Codex, always;
- any engine once a hook said its turn ended (done or error);
- cursor-agent after a heard session-start.

An engine whose hooks never report the end of a turn always reads busy, and stays so.

Why each cell is what it is:

- **Queue:** this is the engine's own channel. No terminal is typed into, and an approval is never answered.
- **Terminal.app ⛔:** its only per-tab write is `do script … in tab`. It always appends a newline in the same write,
  so the words cannot be kept apart from their Enter. The dictionary also defines it as running a shell command.
- **iTerm2 ⛔ (final review, PM 2026-11-25):** its AppleScript `write` (`Itrmsntx`) goes through PTYSession
  `writeTask:` with `canBroadcast:YES`: with Broadcast Input on, the words and their Enter reach every pane of the
  broadcast group, where a shell would run them. Its dictionary has no property that says broadcast is on, so Harness
  Device cannot detect it. iTerm2 is never written to; its tabs are still followed and selected. (Before the review:
  `write` to one session found by `tty`, with `newline` false. The Enter is a second
  `write` of a carriage return.)
- **Ghostty on macOS, a build whose terminal has `tty` ✅** (v1.3.0 and v1.3.1 lack `tty`; only builds after them
  have it, as the tab follow already needs): `input text "<t>" to <terminal>` (paste-style), then `send key "enter" to <terminal>`.
  The terminal is found by `tty`, as the select does today.
- **Ghostty on Linux ⛔:** no AppleScript, and no documented per-terminal write.
- **Windows:** none of the three apps exists there.

Never used: synthetic keystrokes, System Events, or `do script`.

## Part A: Codex's queue under every home Harness trusts

- **Trusted homes.** All three lists are Harness's own records:
  - the daemon's `env.CODEX_HOME`;
  - the homes it adopted (`codexHomeRoots`, `lib/engineHomes.ts`);
  - the Codex profiles the person linked (`codex-profiles.json`, `lib/codexProfiles.ts`).
- **Orca's Codex homes stay out.** Orca's own route already types into its terminals.
- **The linked-profiles reader is new and read-only.** It never changes the file's mode, unlike `readLinkedPaths`,
  which hardens it. A file another account could write reads as no profiles. Its answer is kept for 30 s (as
  `BINARY_LOOK_MS`), because `can()` is asked on every 1 s tick.
- **Queue-able:** the rollout is `within(<home>/sessions, transcriptPath)` for one of these homes. Both the home as
  listed and its real path are tried, since linked paths are stored by their real path. When two homes hold the
  rollout, the deepest wins.
- **The home it runs under:** `codex queue` runs with `CODEX_HOME` = **that trusted home**.
- **Never from a hook:** the home is never taken from a hook's path or from `rolloutHome()`. A hook's path only picks
  among the trusted homes, and a path under none of them is not queue-able. `codex queue` loads the home's
  `config.toml`.
- **Code changes:**
  - `CodexQueue.send(threadId, text, isApp, home)`.
  - The ChatGPT wake (`appWake.ts:178`) passes `env.CODEX_HOME`, as today. `CodexAppSource`'s `inAppHome` is
    unchanged.
  - `ObservedActions.codexHome` becomes `codexHomes(): readonly string[]`.

## Part B: iTerm2 and Ghostty write through Harness Device

Harness Device already runs fixed AppleScript handlers for the three apps on its own script thread. A tty, and now a
text, reach a handler only as parameters, never as script text.

### The proof the pane carries

- **Pinned to the process.** A tabs pane of an agent that is not nested carries `proof: { pid, start }`.
  - `pid` is the process whose tty was read: `callerPid`, as `learnTty` reads it today.
  - `start` comes from the same `ps` call that reads the tty: `ps -o tty=,lstart= -p <pid>`, run with `psEnv()`
    (`LC_TIME=C`) and parsed by the one shared parser as `ps:<ms>`.
  - A pane without a proof never types.
- **Checked by the source.** `there()` and `atPrompt` compare the proof as well as the pane's id: a new process on the
  same tty is another pane.
- **Not nested.** A nested agent's tabs pane (`place.outer`) never carries a proof. tmux, herdr and Zellij keep their
  own routes.

### The checks, before the words and again before the Enter

The words are typed only when every check below holds. Any failure sends nothing more and logs one fixed reason word:
no text, no tty, no pid, no id.

| # | Check | Reason |
|---|---|---|
| 1 | The tabs stream is open, and it is **the same stream object** that took the words. A watch replaced in between is a failure. | `no-stream` |
| 2 | The pane has a proof, and the app is iTerm2 or Ghostty. Terminal.app always fails. | `nested` / `terminal-app` |
| 3 | No other live observed agent's pane has the same tty. Example: a `codex exec` started from Claude's shell tool, on the same tty. | `shared` |
| 4 | `ps -o tty=,pgid=,tpgid=,lstart= -p <pid>` (with `psEnv()`): the tty matches the pane, the start matches the proof, `tpgid > 0`, and `pgid == tpgid`. The agent is in the foreground: a Ctrl-Z, or a shell left in front, fails. | `process` / `background` |
| 5 | `lsof -a -d 0 -t <tty>` (2 s bound): every process whose **stdin** is the tty is the agent or one of its ancestors (shell, login, wrapper), by the look's process table. A Claude Code editor (Ctrl-G), a pager, or a `!` command reading the terminal fails. Stdio MCP servers have a pipe on stdin, so they pass. | `foreground-child` |
| 6 | The agent is idle at its prompt, by today's rules, asked through `atPrompt`. | the existing `waiting` / `busy` |
| 7 | Harness Device's script finds **exactly one** session (iTerm2) or terminal (Ghostty) whose `tty` is the pane's, searching **every** window, visible or not, and writes only there. | `no-session` |

Check 7 together with the proof is also the "this app made this pty" proof:
- The proof's tty is the agent's own process's tty.
- Check 7 holds only when that app's own object owns that tty.
- A pty made by tmux, an editor or another terminal is held by no session of the app.

### Sequence

This reuses VS Code's two-step pattern (`vscodeTerminals.ts` `type`):
- the same `CONTROL` → space and `LONE_SURROGATE` → U+FFFD clean;
- the same `INJECT_PASTE_DELAY_*` settle, since Codex's paste-burst detector turns an Enter within 120 ms of a burst
  into a newline;
- the same `sending` lock per target.

The guard and the settle are moved into one shared helper that both adapters use.

1. Checks 1 to 6 hold.
2. The devices process writes `{"write":{"id","app","tty","text"}}` on that stream. `id` is 16 hex from
   `crypto.randomBytes(8)`. A line over 64 KiB is refused before it is sent.
3. It waits for `{"wrote":{"id","ok"}}`, up to `TYPE_ANSWER_MS` (3 s).
4. It waits the settle, then runs checks 1 to 6 again.
5. It writes `{"enter":{"id","app","tty"}}`, with a new id. Harness Device finds the session again by check 7, then
   sends a carriage return (iTerm2) or `send key "enter"` (Ghostty).
6. Only a `wrote ok` for the Enter makes the send `true`.

Failure cases:
- **Text answered no, or not answered:** no Enter, and "did not answer".
- **A recheck fails:** no Enter. The words sit unsubmitted in the agent's input box, which is harmless, and the dial
  says "did not answer".
- **A stream line still draining** (`write` returns false): it waits on that stream's writable, up to
  `TYPE_ANSWER_MS`, then fails.

### Late writes

Harness Device runs one script thread, and a consent prompt can hold it for minutes. So:

- **Harness Device** stamps each `write` or `enter` with the time it arrived. If the script thread reaches it more than
  500 ms later, it drops it unrun and answers `ok:false`.
- **Harness Device** writes only to an app whose select or poll answered without an error earlier in this run, so its
  consent is known. Otherwise it answers `ok:false`. An app in `off` (denied, no tty, no scripting) always answers
  `ok:false`.
- **Harness Device** keeps writes and Enters in their own ordered queue on the script thread. The latest-select-wins
  slot is not used for them.
- **The devices process** keeps a tty's `sending` lock until that write's answer arrives or its stream ends, not only
  until the timeout. A late write can then never meet another send's Enter.

### How a refusal travels and is counted

- `TypeResult` gains `{ notSent: TabsReason }`, where `TabsReason` is the fixed reason words above plus `no-answer`.
- `ObservedSource.send` counts it as `refused (tabs · <reason>)` and answers `<name> did not answer.`. That is one
  log line per send.
- A sent one counts `tabs`.
- `canType` (synchronous, asked each look) is: the stream is open, the pane has a proof, and the app is not
  Terminal.app. The rest is asked at the send.

## What travels where (Design: data)

- **Stored:** nothing.
- **Exposed:** the spoken text moves on this computer only:
  - from the devices process over the existing tabs stream (the devices listener's socket or pipe, this user's own);
  - to the `harness device watch` child's stdout pipe;
  - to Harness Device's memory;
  - to the terminal's own AppleScript.
- **How long:** it is held for one write.
- **Never logged:**
  - by the devices process, the watch or Harness Device;
  - in any error, or any measure;
  - on the watch's stderr, which Harness Device logs line by line (`cli.rs:378-381`): `printError` never carries a
    write line, its text or its tty.
- **Bounds:**
  - `write` and `enter` lines are at most 64 KiB everywhere: the devices process checks before sending, and the watch
    and Harness Device (`cli.rs` `LINE_MAX`, 64 KiB) check again. The watch reads stream lines up to 64 KiB, and
    checks a select line's own limit after parsing.
  - A `wrote` tell is under 64 bytes, rate-limited like the other tells.
- **Checks on a write:**
  - The watch passes on a `write` or `enter` line only on macOS, and only when its app is iTerm2 or Ghostty, its tty
    passes `TAB_TTY`, its id is 16 hex, and its text is non-empty, at most `MAX_TEXT`, with no control characters.
  - Harness Device checks the same again. Anything else is dropped with no answer.
- **Who can forge what:** any process of this user can post a `wrote`, but it must name the pending random id, and a
  forged `ok` can at most claim "sent" for words the proof already allowed.
- **Rules file:** `device-app/AGENTS.md` gains the rule for spoken text and terminal writes, beside its fixed-scripts
  and privacy rules.

## Measures

- `[device] voice · tabs` for a sent one, and `[device] voice · refused (tabs · <reason>)` for a refused one.
- Harness Device: one fixed line per dropped late write, with no tty.

## Order of routes after the change

1. The queue, for a queue-able Codex.
2. The mod, for Claude Code.
3. The first pane whose adapter types. For a plain iTerm2 or Ghostty tab, that is now `tabs`.

A Codex queue that definitely failed falls through to `tabs`, as it does to Orca today. A queue timeout still sends
nothing more.

## Components and files (expected)

- **`cli/src/cable/hosts/`:**
  - `observed.ts`: trusted homes, the queue's home, the proof, `there()`, the `notSent` count;
  - `codexQueue.ts`;
  - `tabs.ts`: `type`, `canType`, the checks;
  - `vscodeTerminals.ts`: the shared two-step helper moves out of it;
  - `adapter.ts`: `Pane.proof`;
  - `types.ts`: `TypeResult`;
  - `appWake.ts`: the home argument.
- **`cli/src/lib/`:** `codexProfiles.ts` (the read-only linked reader) and the shared `lstart` parser.
- **`cli/src/services/`:** `devicesListener.ts` (`tabsStream` `write` / `enter` / writable wait, the `wrote` handler)
  and `devices.ts` (wiring, the `ps` / `lsof` probes as deps).
- **`cli/src/devices/client.ts`** (the watch).
- **`device-app/src-tauri/src/`:**
  - `tabs.rs`: parsing, the queue, the consent rule, the `TabScripts` write and Enter;
  - `tabs_macos.rs`: the iTerm2 and Ghostty handlers by code, Ghostty's codes taken from `Ghostty.sdef` at the v1.3.0
    tag;
  - `watch.rs` / `runner.rs`: answers on the child's stdin;
  - `cli.rs`.
- **`device-app/AGENTS.md`.**
- **Eval:** the fake tabs stream and the world's probe deps (see Open question 1).

No core file changes (`cli/src/core/`).

## Tests

Red first, at the layer where the behavior lives, all with fakes. No real Codex, Claude, iTerm2, Ghostty or Terminal
is run or scripted.

- **`codexQueue.spec.ts`:** `CODEX_HOME` is the home passed per send.
- **`observed.spec.ts`:**
  - a rollout under an adopted home, and under a linked profile (both spellings), queues with that home;
  - a hook-only home is not queue-able;
  - the deepest home wins;
  - a proof change on the same tty fails `there()`;
  - `notSent` is counted once.
- **`tabs.spec.ts`:**
  - each check failing sends no line and counts its reason;
  - the full path (write → ok → settle → recheck → enter → ok → `true`);
  - no answer means no Enter;
  - a late answer keeps the lock;
  - a replaced stream between write and Enter means no Enter;
  - a draining stream waits, then fails;
  - Terminal.app is refused;
  - control characters and lone surrogates are cleaned;
  - a stale or forged id is dropped.
- **`vscodeTerminals.spec.ts`:** unchanged behavior through the shared helper.
- **Locale:** `ps` under `LC_ALL=de_DE.UTF-8` still parses the start, because `psEnv` sets `LC_TIME=C`.
- **`devicesListener.spec.ts`:** the `wrote` bounds, rate and malformed lines.
- **`client.spec.ts` (watch):** the checks on write lines, the 64 KiB line, `wrote` told back, the refusal off macOS,
  and nothing on stderr.
- **`device-app` Rust:**
  - parsing and refusals;
  - the exactly-one rule over a fake `TabScripts`;
  - the 500 ms late-drop;
  - the consent rule;
  - writes kept in order beside selects.
- **Devices test with fakes:** a fake watch end to end through the listener, and a wrong-session probe: words for A
  never produce a line naming B's tty.
- **`npm run test:core`:** run, since `services/` changes (100% coverage).
- **cli/AGENTS.md e2e:** the user-facing flow, against a fake Harness Device watch.
- **Eval:** both tiers rerun (`caffeinate -i`, `TMPDIR=/tmp`, on the PM's turn). Gate: no app drops, wrong-session
  sends stay 0. `baseline.json` is regenerated if it changes.

## Check held for Diego (before merge; steps in the PR)

1. iTerm2: Codex, idle, in a plain tab. Speak at the dial. The words appear and **Enter submits them** as one turn.
2. The same in Ghostty ≥ 1.3. Also note whether `input text` brings Ghostty forward.
3. Claude Code without the mod in iTerm2: the same.
4. iTerm2 with Broadcast Input on, over two panes: the words reach the one session only. If not, iTerm2 becomes ⛔.
5. Negatives:
   - Codex in tmux inside iTerm2: not typed by `tabs`;
   - Codex with `!sleep 30` running: refused;
   - Claude Code with its Ctrl-G editor open: refused;
   - Terminal.app with cursor-agent: "did not answer";
   - the agent quit, leaving a shell in its tab: nothing typed.

## Decisions (PM, 2026-11-25)

1. **Eval harness:** two harness-only edits are allowed, with no scenario and no check changed, and the PR says so:
   the fake tabs stream ignores lines that are not selects, and the world answers the new `ps` / `lsof` probes "not
   readable", so `tabs` never types in the eval. Base: origin/main.
2. **Engines:** an engine whose hooks never report the end of a turn always reads busy and is never typed into.

## Changes after the final review (PM, 2026-11-25)

These override the sections above where they differ.

1. **iTerm2 ⛔ for writes**, for the Broadcast Input reason in the table's notes. Part B types only into Ghostty, a build
   whose terminal has `tty`. Every hop refuses iTerm2: the devices (`tabsLines` typing apps), the watch and Harness
   Device (`typing_of`), and Harness Device has no iTerm2 write handlers.
2. **Handshake.** Harness Device starts its watch as `harness hardware watch --json --writes`. Only such a watch opens
   the tabs stream with `"writes":true`, and the devices type only on a stream that said it. An older Harness Device
   (0.1.x), which drops write lines, therefore gets no voice offered on tab agents, instead of a 3 s "did not answer".
3. **Words left behind.** When the recheck before the Enter fails, or an answer comes late, the words stay unsubmitted
   in the agent's input box, and the next send that works submits them together with its own words. Accepted: nothing
   is typed to clear them (no Ctrl-U, no backspaces), since that would type more into a pane that just failed a check.
   Diego's check covers it.
4. **Limits of check 5.** `lsof -d 0` without root does not see another user's processes (a `sudo` prompt, `sudo vim`),
   nor programs that read `/dev/tty` on another descriptor (`less` behind a pipe, pinentry, an ssh password prompt).
   The main guards stay the agent's idle state from its hooks and `pgid == tpgid`; check 5 is defense in depth.
5. **Trusted homes, cost.** `own()` is held for about 1 s, and each home's `sessions` folder and depth are worked out
   once per hold, deepest first. Real paths are looked up only for `own()` homes; linked homes are taken as stored (a
   link stores the real path), so a dead network volume cannot block the devices process.
6. **Orca's Codex homes** are not filtered: a home the person linked or adopted is trusted, whoever else uses it. The
   target is still right; such a session takes the queue instead of Orca's typing.
7. **Other review fixes:** only an answered Apple Event counts as consent; a stopped or replaced watch's typings never
   run; failed and refused typings log a fixed line naming only the app and write/enter; `ps` is read last before the
   words; a tty still being read, or whose read failed, counts as possibly shared (refused); linked entries must be
   absolute, at most 4096 characters, with no control characters; the stdin-holder table is read with `/bin/ps` under
   `psEnv`; a lone surrogate is refused at every hop.

### Check held for Diego, as it stands now

1. Ghostty (a build with `tty`): Codex, idle, in a plain tab. Speak at the dial: the words appear and **Enter submits
   them** as one turn. Note whether `input text` brings Ghostty forward.
2. The same with Claude Code without the mod in Ghostty.
3. iTerm2: Codex on a trusted home still gets voice (queue); cursor-agent in an iTerm2 tab gets "did not answer" and
   nothing is typed.
4. Negatives in Ghostty: Codex in tmux (not typed by `tabs`); Codex with `!sleep 30` running; Claude Code with its
   Ctrl-G editor open; the agent quit, leaving a shell (nothing typed).
5. Words left behind: make the Enter recheck fail (start a turn right after speaking) and confirm the next spoken words
   submit together with the leftover ones, as accepted above.

## Not done

Terminal.app typing; Linux Ghostty typing; new copy; answering approvals; Codex homes outside Harness's own lists;
Orca's Codex homes in the queue.
