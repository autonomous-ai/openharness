# Dial voice in VS Code and Cursor terminals — design

Hill-climb #4 of the dial eval (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md), dimension D5. Baseline on
`main` after #4543: VS Code 73, Cursor 70.8.

## Problem

Voice from the dial reaches no agent in three cases, on every platform branch of the eval (a/darwin, a/linux, a/win32,
b/darwin). Each fails `voice.reached`, `voice.once` and `voice.exact` with a `voice.error` and no delivery:

- **V9 (VS Code):** a Codex in a VS Code terminal whose `CODEX_HOME` is not the daemon's (for example the person's own
  `~/.codex` while Harness reads another home).
- **U11 (Cursor):** cursor-agent in a Cursor terminal.
- **U10 (Cursor):** Cursor's own agent (the chat inside Cursor).

Hard rule: the words reach exactly that agent, or nothing. Never typed into a guessed window or terminal.

## How voice is delivered today (from the code)

`cable/hosts/observed.ts` `send` tries, in order:

1. Codex's queue (`codexQueue.ts`), only for a Codex whose rollout is under the daemon's own `CODEX_HOME`
   (`queueable`). `codex queue` loads the config of the home it runs with, so a hook's path never chooses that home.
2. The Claude Code mod's inbox (`modReady`), Claude Code only.
3. Typing into the first pane whose adapter has `type` and whose `canType` holds (Orca, kitty, WezTerm, Zellij, herdr,
   cmux), only at the agent's prompt: `needs-you` is refused as waiting, `working` or an unknown idle as busy.

The VS Code adapter (`cable/hosts/vscode.ts`) gives a terminal agent the pane `term:<pid>` and can show, raise and
scroll it through Harness's extension (`plugins/harness-device-vscode`) on the window's `vscode` stream
(`vscodeTerminals.ts`). It has no `type`: the extension writes only PageUp and PageDown. Cursor's own agent has only the
`cursor-folder` pane, which opens its folder's window.

So V9's Codex and U11's cursor-agent have no route: no queue (wrong home, wrong engine), no mod, no typer. The dial's
capability for them is `voice: false`, and `cableSession.ts` refuses before any audio: "This agent is in VS Code.
Talking to it from the device comes in an update."

## Approaches considered

- **A. Type through Harness's extension into that terminal (chosen for V9 and U11).** The devices already know the exact
  terminal (the window's stream and the shell pid the agent runs under). The extension's `Terminal.sendText` writes to
  that terminal alone. One path serves Codex in any home, cursor-agent, and Claude Code whose mod is not polling.
- **B. `codex queue` with the session's own `CODEX_HOME` (V9 only).** Rejected: the home would come from the hook's
  transcript path, outside data choosing which config `codex` loads and runs (observed.ts already refuses this).
- **C. Type keys into the editor's focused window (OS key events).** Rejected: a guessed window.

For U10 there is no safe route (below).

## Design

### 1. The extension types into one terminal (V9, U11)

**Wire.** Two new lines on the window's `vscode` stream, devices → extension:

```json
{"type":"<words>","pid":<shell pid>}
{"enter":<shell pid>}
```

- `<words>`: the dial's words with every control character replaced by a space (`orca.ts` `CONTROL`), so no newline
  submits part of them and no escape steers the screen, and lone surrogates made well-formed. 1 to `MAX_TEXT` (20,000)
  characters, and the whole line at most 64 KiB (`Buffer.byteLength`); a longer one is refused as too long.
- `pid`, `enter`: the shell of the agent's terminal, as the window reported it on `vscode-state`. The Enter line holds
  no string: it carries no words.

**Extension (`plugins/harness-device-vscode`).** It stays stateless; the devices own the timing and the guard.

- `WindowFacade` gains `type(pid, words): boolean` and `enter(pid): boolean`: the terminal whose shell has that pid gets
  `sendText(words, false)`, or `sendText('\r', false)`. False when no terminal has that shell. Keys, never a bracketed
  paste: on Windows a pseudo console turns a paste into key presses, and a bracket's ESC would reach the agent as a key.
- A words line holding a control character (`\p{Cc}`), which the devices never send, is out of form and skipped: a
  newline or CR in it would submit part of the words before their Enter line, an escape would steer the screen.
- The line limit (`LINE_BYTES`, 1,024 today) rises to 64 KiB for every line. (An older extension ends its stream on a
  line of 1,024 bytes or more and opens it again: the `types` flag below keeps such lines from it.)
- `vscode-state` gains `"types":true`, so the devices know this window's extension can type.
- The minute's count line gains `typed`, `entered` and `typeNotFound` (numbers only).

**Devices (`cable/hosts/vscodeTerminals.ts`, `vscode.ts`).**

- `VscodeTerminals` keeps each window's `types` from its latest state, before its reindex, and a change of it counts
  as a change of that window's terminals (in the string `tell()` compares), so the dial's row capabilities follow.
- It gains `type(agentPid, words): Promise<boolean>`, which does the whole send for one terminal:
  1. the terminal holding that agent now, in a window that types; else false;
  2. the guard, through the injected `deps.foreground` (devices.ts wires `processGroups ?? readForeground`), with the
     page keys' rule (vscodeTerminals.ts): the agent's group is its terminal's foreground group (`tpgid > 0`). A
     suspended (Ctrl+Z) or backgrounded agent leaves the shell in front, where the words would run as a command; an
     agent under `script`, `screen` or `sudo` with `use_pty` leads a pty of its own. On Windows (checked by the
     platform given, not `process.platform`) there is no `ps`, no group and no job control: instead the process table is
     read again (`deps.processes`) and the agent's pid must still have the start marker its chain was read with and a
     chain that reaches the shell, since a dead agent's pid may be a new shell's;
  3. the same terminal and the caller's check that the agent is still at its prompt, asked again once the guard has
     read (a turn or a prompt may have started during that read); then the words line; a stream that does not take it
     now (`write` false while an earlier line drains) answers false;
  4. the settle, on `deps.after`: `INJECT_PASTE_DELAY_BASE_MS + floor(length / 60)`, at most
     `INJECT_PASTE_DELAY_MAX_MS` (`lib/submitTiming.ts`, 400 and 1,500 ms), for every engine and platform: Codex's
     paste-burst detector turns an Enter within 120 ms of a key burst into a newline (`codex-rs` `paste_burst.rs`), and
     Claude Code needs time to take a long input before Enter submits it;
  5. the same terminal, the guard again, and the caller's check that the agent is still at its prompt; then the Enter
     line. Any of them failing sends no Enter and answers false: the words wait in that agent's own input, submitted
     nowhere.
  Per terminal, one send at a time: a second while one is under way answers false.
- The VS Code adapter (both editors) gains `canType(pane)` — a `term:<pid>` pane whose terminal a window holds now and
  whose window types — and `type(pane, text)`, which hands `VscodeTerminals.type` the agent's pid, the words and the
  prompt check. Not in front: it refuses with a fixed sentence (copy below). The panel's tab pane never types.

**Observed source.** Nothing new in `send`'s order: Codex's queue, then the mod, then the first pane that types. The
VS Code pane now types, so:

- V9's Codex: no queue (other home) → typed into its terminal, at its prompt only.
- U11's cursor-agent: typed into its terminal, at its prompt only (next point).
- A Claude Code in a VS Code or Cursor terminal whose mod is not polling also gets its words typed, at its prompt only.

**cursor-agent's idle.** `idleKnown` reads idle only for Claude Code and Codex, or for another engine after a hook said
its turn ended (`done`, `error`). Entries start `idle` however they were found (the open scan too), so the state alone
says nothing. Cursor's hooks that Harness installs (`engines/cursor/contract.ts`) are `sessionStart`,
`beforeSubmitPrompt` (turn start), `preToolUse`, `stop` and `sessionEnd`. An entry gains a flag set by a heard
`session-start` and cleared by a `turn-start`: a `cursor` session with that flag is at its prompt, and `idleKnown`
counts it, for the `cursor` engine alone. A turn under way stays busy: cursor-agent's approval prompt sends no hook,
and a typed Enter would answer it. Unverified here: that cursor-agent sends `sessionStart` when its screen opens rather
than at its first submit; either way the flag is cleared by the turn start that follows a submit.

**Copy (dial).** Short, as the product rules say:

- Not in front in its terminal: `Bring it to the front of its terminal.`

**Measures.** The existing `count(typer.adapter)` already logs `vscode` / `cursor` per send; a refusal logs
`refused (vscode)`. The extension's minute line adds `typed`, `entered` and `typeNotFound`. No words, pids or paths in
any line.

### 2. Cursor's own agent (U10): no safe route; the dial says so

Cursor documents no way to put words into one existing chat:

- its prompt deeplink (`cursor://anysphere.cursor-deeplink/prompt?text=…`) opens a new chat with the words, not that
  agent's;
- its composer commands are internal and act on whichever chat is focused, which is a guess.

Both break the hard rule. So Cursor's own agent keeps `voice: false`, and the dial says, instead of the generic
"Talking to it from the device comes in an update.":

`Voice can't reach Cursor's agent. Type in Cursor.`

The sentence comes from the adapters, which already tell Cursor's own agent apart (`vscode.ts` gives no pane to a
`cursor` engine with no `TERM_PROGRAM`; `cursor-folder` holds it), through a host method beside `capsOf`
(`voiceRefusal?(agentId)`): `observed.ts` and `cableSession.ts` name no app. Every other agent with no voice keeps
today's sentence. U10's checks stay red; it goes to the PM with the options in "Open questions".

## Eval

- Red first, from the failing scenarios: a unit test of the extension's `type` line, of `vscodeTerminals.ts`'s `type`,
  of the adapter's `canType`/`type` and foreground guard, of `observed.ts` sending V9's Codex and U11's cursor-agent to
  the VS Code pane, of `idleKnown` after a cursor `session-start`, and of U10's refusal copy. Then V9 and U11's
  `voice.*` checks turn green in tier A (every platform branch) and tier B (macOS).
- Tier A already records any words on an editor stream as `typed` to the session whose shell the line names
  (`tierA/steps/editor.ts`), so the gate sees the new path with no change there. Two tier A models must follow the
  product (see Open questions): the fake extension's `vscode-state` says `"types":true` as the real one will, and the
  world's `processGroups` answers that each terminal agent is its shell's foreground job, as the machine it models
  starts them (today it answers `undefined`, which the guard reads as "not in front").
- Tier B runs the real extension loop over a fake window (`cli/e2e/harness/vscodeWindow.ts`): its `type` prints
  `{"typed":…,"pid":…}` and `appEvalEditor.ts` records it as a `typed` delivery to the session whose shell it names, as
  the eval spec asks of a new path ("A fix that adds a delivery path records it, with its target, in both tiers").
- `baseline.json` is regenerated in the same pull request. Expected: VS Code D5 50 → 100, Cursor D5 33.3 → 66.7,
  wrong-session sends 0, no other app drops.
- The held-out scenarios are not read while fixing.

## Platforms

- macOS and Linux: typed only with the agent in front of its terminal (`ps`).
- Windows: typed when the agent is matched under the terminal's shell; no foreground read exists there. Settle as
  everywhere. Tier A covers a/win32; tier B does not run on Windows (the eval's documented gap).
- The extension's change runs in VS Code and Cursor alike.

## Not in scope

- A Claude Code panel session, which keeps the mod.
- An agent in tmux inside a VS Code terminal (V12): its chain never reaches the window's shell, so it has no terminal
  pane and nothing is typed.
- Any ack from the extension back to the devices: a line taken by a window that types is the delivery, as a show is.

## To confirm on a real editor (not run here)

- VS Code's and Cursor's `Terminal.sendText` never wrap text in a bracketed paste.
- cursor-agent sends `sessionStart` when its screen opens.

## Decisions (PM, 2026-11-22)

1. **Eval edits.** Allowed, kept to exactly these lines, each modelling what the real extension or process does, with
   no check, grade or scenario changed: `tierA/steps/editor.ts` (the fake extension's `vscode-state` says
   `"types":true`), `tierA/world.ts` (`processGroups` answers that a terminal agent is its shell's foreground job), and
   tier B's recording of the typed line (`cli/e2e/harness/vscodeWindow.ts`, `editorWindow.ts`, `appEvalEditor.ts`).
   Rebase onto feat/dial-eval-orca once it merges (it edits tier A too), and over feat/dial-eval-iterm2.
2. **U10.** (a): the clear refusal; U10 stays red. (d) goes in the final report as a request for Diego to raise with
   Cursor (an API to send words to one chat by id). Nobody is contacted from this work.
3. **cursor-agent's idle.** At its prompt from a heard `session-start` until a `turn-start`, as above.
4. **Copy.** `Bring it to the front of its terminal.` and `Voice can't reach Cursor's agent. Type in Cursor.`
5. **Real-editor checks.** The two under "To confirm on a real editor" go in the pull request as checks for Diego after
   the merge.
6. **Plan's follow-ups (PM, 2026-11-22).** Allowed beside 1: `tierA/steps/editor.spec.ts`'s expected state message gains
   `types: true`; tier B's red test goes in `cli/src/testing/dialAppEvalTierBEditor.spec.ts`; `enter` joins the fields
   whose pid `tierA/steps/editor.ts` names by session. `npm run test:vscode` is not run on this Mac (a downloaded VS Code
   still writes into the real app's Crashpad and Sentry folders, PM rule since 2026-11-19): it is waived for this pull
   request with that reason, gains a case for the words and Enter lines, and is listed for Diego or Ken to run on a VM
   after the merge. The pull request names the Windows gap: the settle is a fixed wait where `docs/windows-rules.md`
   asks to see the paste land, since the devices cannot read an editor terminal's screen.
