# The dial's scroll moves Claude Code's fullscreen view in a VS Code terminal (PM for Diego, 2026-11-18)

Status: spec. Follow-up to #4427 (`docs/plans/2026-11-17-dial-vscode-extension-design.md`, "Known gaps"). It builds on
`feat/dial-herdr-scroll` once that merges: that branch rewrites the dial's scroll routing (`routeScroll`, a held
stroke while an app is asked, `HostAdapter.scroll`), and this work adds a third answer to it. Nothing here touches the
daemon core: the devices process and Harness's VS Code extension only.

## Why

On Diego's Mac (2026-11-18, devices log `10:37:54 … 201 scroll lines, 0 dropped`), the dial's scroll reached the
extension, which ran VS Code's `workbench.action.terminal.scrollUp`/`scrollDown`, and Claude Code 2.1.327 did not move.
Diego's `~/.claude/settings.json` sets `"tui": "fullscreen"`. Claude Code describes this setting as "the flicker-free
alt-screen renderer with virtualized scrollback", the same as `CLAUDE_CODE_NO_FLICKER=1`. It draws on the alternate
screen with mouse tracking on, so the terminal keeps no scrollback for VS Code to move. Herdr's scroll has the same gap.

What does move it (checked 2026-11-18 on 2.1.327 in a private tmux, with a throwaway HOME and config):

| | fullscreen | default renderer |
|---|---|---|
| Pane | alternate screen, SGR mouse on, host history 0 | main screen, history kept |
| The host's scroll (what #4427 sends) | nothing moves | scrolls |
| PageUp `ESC[5~` / PageDown `ESC[6~` | scrolls the transcript, about half a view | ignored |
| Text already typed in the prompt | unchanged | unchanged |

**What PageUp and PageDown can do in Claude Code 2.1.327.** Its input parser reads `ESC[5~`/`ESC[6~` as those keys,
never as text. Its keymap binds them in five contexts only:
- **Scroll:** `scroll:pageUp`/`pageDown`, the transcript.
- **DiffDialog:** `scroll:pageUp`/`pageDown`.
- **Pane and AbovePrompt:** `pane:pageUp`/`pageDown`.
- **Settings:** `select:pageUp`/`pageDown`, moving a list's highlight.

No context binds them to confirm, answer, submit or type. A key that lands in a permission prompt or a question does
nothing.

## Decided (PM, 2026-11-18)

1. The extension sends PageUp/PageDown with `terminal.sendText(seq, false)`, and only these two sequences.
2. **Only when that terminal's foreground program is Claude Code and the agent is not asking (`needs-you`).** Bytes
   written to a terminal whose foreground is a shell or another program would be typed there.
3. A red test first. A check on a throwaway terminal with a fake alt-screen app: never a real `claude`, which writes
   its trust record into the person's `~/.claude.json`.
4. Herdr fixed the same gap on its own branch with its own guard (hc's app kind and `blocked` state). One page is the
   same travel on both: `SCROLL_PAGE_LINES = 20` dial lines (Herdr measured a page at about 19 lines).
5. **Order:** this branch is built on #4425 (`feat/dial-herdr-scroll`) and merges after it. The plan is written
   against #4425's head.
6. **`ps` reads `pgid` and `tpgid` too.** PR A allowed only `ps -axo pid=,ppid=`. Decision 2 needs to know whether
   Claude Code is the terminal's foreground program. The parent chain cannot tell that: a shell's child stays its
   child after the job is stopped or put in the background. Only the process group against its tty's foreground group
   can. The devices still never read another process's environment or arguments: `ps -o pgid=,tpgid= -p <pid>`
   prints two numbers.
7. **Page keys only for a session known to draw fullscreen (PM, 2026-11-18).** VS Code's `sendText` scrolls the
   terminal to the bottom after each write (`terminalInstance.ts`, `scrollToBottom()`). Under Claude Code's default
   renderer a page key would therefore pull the view back down after each 20 lines up, which is worse than today. So
   the devices read **only the `tui` key** of Claude Code's settings files for the session, and send page keys only
   when it says `"fullscreen"`. Every other session scrolls line by line, as today.
   - **The files, highest precedence first:**
     - managed: `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS,
       `/etc/claude-code/managed-settings.json` on Linux;
     - project local: `<cwd>/.claude/settings.local.json`;
     - project: `<cwd>/.claude/settings.json`;
     - user: `settings.json` in the session's own Claude Code home, taken from the transcript path the devices already
       know (`<home>/projects/<slug>/<id>.jsonl`, so a session with its own `CLAUDE_CONFIG_DIR`, such as an Orca
       account home, is judged by its own file). With no transcript path known, the default home
       (`dirname(CLAUDE_PROJECTS_DIR)`). No environment is read (PM, 2026-11-18).
   - `<cwd>` is the session's own working folder.
   - Each file is read with a 256 KiB cap and parsed as JSON. Nothing but the `tui` value is kept, and it is never
     logged. A file missing, too large or unreadable counts as having no `tui`.
   - **Limit:** fullscreen turned on by the environment (`CLAUDE_CODE_NO_FLICKER=1`) is not seen, because the devices
     never read another process's environment. Such a session scrolls line by line, as today. The same holds for a
     fullscreen that Claude Code turned off by itself (tmux `-CC`, Windows over SSH): the settings say `fullscreen`, a
     page key reaches a main-screen view, and the view is pulled to the bottom.

## What a person sees

Claude Code in a VS Code terminal, VS Code in front, the dial showing that agent. A finger on the glass:

- **`"tui": "fullscreen"` in its settings:** the transcript moves a page, about half a view, for each 20 lines of the
  dial's travel.
- **Any other session** (the default renderer, or fullscreen from `CLAUDE_CODE_NO_FLICKER=1`): line by line, as today.

While the agent asks (as far as the devices know), or after Claude Code has exited and the shell is back in front, only
the host's line scroll runs, as today. Codex is unchanged: only the host's line scroll.

## How it works

```
dial ─▶ devices: stroke down ─▶ guard (claude? not needs-you? in the tty's foreground group?)
                                  ├─ page   ─▶ {"scroll":n,"pid":shell,"page":true}   ─▶ extension: host lines + a page key per 20 lines
                                  └─ lines  ─▶ {"scroll":n,"pid":shell}                ─▶ extension: host lines (as today)
```

### 1. The devices process: the guard

On `feat/dial-herdr-scroll`'s routing in `services/devices.ts`, a stroke can be held at `down` while an app is asked,
and the asked app's answer decides the route. This work:

- **Gives the answer a third outcome.** Today the answer is "this app's pane" or "Harness's windows". It becomes
  `page`, `lines` or `windows`. A refused guard is `lines`, the VS Code terminal's line scroll as today, never
  Harness's windows.
- **Holds a VS Code stroke only when it can pass.** That is: the shown agent's engine is `claude`, it is not
  `needs-you` at `down`, its pane is a VS Code terminal, and its settings say `"tui": "fullscreen"` (decision 7; read
  at `down`, together with the foreground read). Every other VS Code stroke is decided at once as `lines`,
  as now.
- **Reads the foreground through a new `vscodeTerminals.ts` dep, `foreground(agent, shell)`, beside `processes`:**
  - `agent` is the agent's pane pid, `termPid(observed.paneOf(id, 'vscode'))`: the engine (or its caller) that the
    terminal was matched by. Not `entry.pid`, which goes stale after a resume.
  - `shell` is the VS Code terminal's shell pid, the one its window reported, as `terminalOf(agent)` gives it at the
    read.
  - It runs one `ps -o pid=,pgid=,tpgid= -p <agent>,<shell>` through `execText` (`scannedApp.ts`). This adds columns
    to the `ps` reads PR A allowed (`ps -axo pid=,ppid=`), as the PM's decision 2 needs.
  - It passes when the agent's `pgid` equals the **shell's** `tpgid` and that is above 0: the agent's group is the
    VS Code terminal's foreground group (a wrapper script that starts the engine still passes). Never the agent's own
    `tpgid`: under `screen`, `script`, `asciinema` or sudo's `use_pty` the agent leads a pseudo-terminal of its own and
    is always in front there, while the VS Code terminal's foreground is that program. An exit, a terminal gone or a
    failed read is refused, reason `ps`.
- **Bounds the wait:** a stroke is held at most 500 ms of wall time. With no answer by then, its held travel goes out
  as `lines` and the stroke stays `lines`. A newer `down` drops an older answer, as Herdr's `stroke !== asked` does.
- **Checks the state again at each move** of a `page` stroke in `routeScroll`. A `needs-you` that the devices learn
  mid-stroke turns the rest of the stroke to `lines`.
- **Keeps `page` in the line accumulator** (`vscodeTerminals.ts` `window.scroll`): lines with and without `page` are
  never merged. A change flushes what waits first.

What `needs-you` covers, and what it does not:
- **Set by:** Claude Code's `Notification` hook (after about 6 s without typing) and the harness-device plugin's
  `PermissionRequest`, where the plugin is on.
- **Not set by:** an `AskUserQuestion` outside a pane, or a session the scan found with no hooks.
- **The guard is a courtesy, not the safety:** a page key that reaches a prompt the devices do not know of does nothing
  (above).

### 2. The extension: page keys

`plugins/harness-device-vscode/src/loop.ts`, `facade.ts`, `window.ts`, `vscodeApi.ts`.

- **Reading the line:** in `take()`, a scroll line's `page` is read only when it is `true`; any other value is no page.
- **The page remainder:** for a page line, the line's signed count is added to a remainder kept for its shell. The
  remainder resets on a line for another shell, on a line with no `page`, after 1 s with no page line, and when the
  stream ends.
- **The keys:** each time the remainder reaches ±20, one page key is pressed. It is `\x1b[5~` toward older lines
  (n < 0) or `\x1b[6~` toward newer lines.
- **When they go:** a line's keys are pressed as soon as the line arrives, while that shell's terminal is active and the
  loop runs, never behind a run of host scroll lines (which move nothing on the alternate screen), so no key can follow
  a later line with no `page`. Only the host scroll lines wait, merged as today: at most 100 lines a line, so at most 5
  keys a line.
- **The facade:** gains `pageKey(pid, up)`. It finds the terminal by its shell pid and calls `terminal.sendText(seq,
  false)` with one of the two fixed sequences. It cannot write any other text.
- **The types:** `ApiTerminal` gains `sendText(text: string, addNewLine?: boolean): void`. `WindowFacade`, the tests'
  fake window and `cli/e2e/harness/vscodeWindow.ts` gain `pageKey`.

Why the host's lines go too: they cost nothing on the alternate screen, and they keep a session whose fullscreen
Claude Code turned off by itself moving between the keys' pulls to the bottom.

## Measures (rule 8)

- **The devices' per-minute `vscode` line** (`vscodeTerminals.ts`) gains:
  - `page strokes`: strokes whose guard passed;
  - `guard refused`, by reason: `renderer`, `asking`, `background`, `ps`, `slow`.
- **The extension's per-minute line** gains `page keys`.
- **Never logged:** a pid, a name or a path.

## Failure

| What fails | Who notices | What the person sees | Recovery |
| --- | --- | --- | --- |
| Foreground read fails, or the process is gone | refused `ps`, counted | line scroll only | the next stroke reads again |
| No answer in 500 ms | refused `slow`, counted | line scroll only for that stroke | the next stroke asks again |
| Claude Code exits mid-stroke | the guard was read at `down` | at most that stroke's keys reach the shell; a zsh with no binding for PageUp may type a `~` per key | the next stroke's guard refuses |
| The agent asks mid-stroke | the per-move state check, when the devices know | the keys stop; a key that lands in the prompt does nothing | none needed |
| VS Code wraps `sendText` in bracketed paste | the gate (below) | keys would land in the prompt as text | the gate fails before merge |
| Fullscreen set by `CLAUDE_CODE_NO_FLICKER=1` only | refused `renderer`, counted | line scroll only: nothing moves on the alternate screen | set `"tui": "fullscreen"` in Claude Code's settings |
| A settings file unreadable or too large | treated as no `tui` | line scroll only | none needed |
| An older extension | ignores `page` | line scroll only | the CLI update brings it current |
| The terminal is not active | the run's active check | no key, no line | a tap or swipe shows it |

**The one place a key can reach the shell:** Claude Code exiting during a stroke. A stroke lasts a second or two, and
its foreground is read at the start. What can land is bounded:
- at most 5 keys per line, and only the two fixed sequences;
- a shell reads them as the PageUp/PageDown keys; with no binding for them, zsh may type a `~` each, which the person
  sees and deletes;
- nothing is ever run: neither sequence holds a newline.

## Design (docs/feature-design-rules.md)

1. **Growth:** nothing stored. In memory: one guard answer per stroke, one page remainder per window.
2. **Concurrency:** the devices' event loop owns the stroke. At most one foreground read per stroke; a newer `down`
   drops an older answer. The extension's one scroll run at a time is unchanged.
3. **Read cost:** one `ps -p` per stroke whose agent is Claude Code and not asking; none otherwise.
4. **Scale:** strokes are human-paced; at most a few per second.
5. **Compatibility:** a field neither side requires; both sides ignore it when missing or unknown.
6. **Migration and rollback:** none.
7. **Audience:** the field goes over the devices socket only; nothing leaves the computer.
8. **Identity:** the extension types two fixed key sequences into a terminal the person's own agent leads, on the
   person's own dial stroke; nothing else.
9. **Failure:** above.
10. **Platforms:**
    - **macOS and Linux:** as #4427. `ps -o pgid=,tpgid=` exists on both.
    - **Windows:** unchanged; no devices listener there.

## Verification

- **Unit (CI, vitest in `cli/`), each behavior's test committed failing before its code:**
  - **The guard:**
    - Claude Code in the foreground group, not asking: lines carry `page`.
    - Codex, or `needs-you` at `down`: decided at once as `lines`, no read.
    - The renderer: `tui` from the managed, project-local, project and user files in that precedence. `fullscreen`
      passes; `default`, a missing key, a file over 256 KiB, bad JSON or an unreadable file refuse `renderer`. No other
      key is read.
    - Another group in the foreground: `lines`.
    - `tpgid` 0, a failed read, or a gone process: `lines`, refused `ps`.
    - No answer in 500 ms: the held travel goes out as lines, refused `slow`.
    - A newer `down` drops the older answer.
    - `needs-you` learned mid-stroke: the rest is `lines`.
    - The accumulator never merges page and non-page lines.
  - **The extension:**
    - A page line of 45 lines sends 2 keys and keeps 5. The next page line for the same shell adds to the 5.
    - The remainder resets after 1 s with no page line, on another shell, and on a line with no `page`.
    - Toward newer lines it sends `\x1b[6~`.
    - An inactive terminal gets no key.
    - A `page` other than `true` is ignored.
    - At most 5 keys from one line.
    - `sendText` only ever gets the two sequences, always with `false`.
- **End to end (`cli/e2e`, isolated):** `dialVscode.e2e.ts` gains a case. The e2e pty is Python's `pty.fork`
  (`cli/e2e/harness/outsideAgent.ts`), where the fake engine leads its session, so the foreground case is the default.
  - **Foreground:** a scroll on the fake dial sends `page: true` lines to the extension's loop over the real devices
    socket.
  - **Background:** a new job-control step in the Python helper moves the fake engine to the background
    (`setpgid` + `tcsetpgrp`, on a signal). The lines then carry no `page`.
  - **Clean-up:** it sends SIGCONT, because a fake engine reading stdin in the background stops on SIGTTIN.
- **Local gate, real VS Code (`npm run test:vscode`, the throwaway VS Code of #4427):**
  - **The fake app:** a gate terminal runs a small Node script (`createTerminal({ shellPath, shellArgs })`, VS Code's
    binary with `ELECTRON_RUN_AS_NODE=1`). It enters the alternate screen, turns on SGR mouse and bracketed paste
    (`ESC[?2004h`), and writes each byte it receives to a file in the gate's root.
  - **The check:** the gate sends a page line through `streams.scroll` with the new `page` argument. The file must hold
    exactly one `\x1b[5~` per page, and no `ESC[200~`, so VS Code did not wrap the key as a paste.
  - **Never:** the gate never starts `claude`.
- **Local gates:** `npm run test:core` (devices). The local-checks receipt in the PR.
- **By a person, after merge:** Diego's Claude Code with `"tui": "fullscreen"`: the dial's scroll moves the transcript.

## Not in this work

- Fullscreen from `CLAUDE_CODE_NO_FLICKER=1` (the environment is never read).
- Codex in its alt-screen mode (`--no-alt-screen` exists; its keys are not checked).
- Mouse-wheel events (`ESC[<64;…M`), which would move line by line; the PM chose PageUp/PageDown.
- Herdr: its own branch and guard.
