# The dial with tmux and VS Code, app closed (wave 1 checks)

Wave 1 #4 (tmux) and the rest of wave 1 #1 (Claude Code in VS Code) of the device integration priority list
(2026-11-13): with the Harness desktop app closed, an agent in tmux or in VS Code is listed on the dial, takes the words
said at the dial in the right session, and a tap opens it. This pass checked both on an isolated daemon with a fake
dial; this spec fixes what failed.

Base: `main` with #4309, then #4311, #4326 and #4331 merged (they change `open.ts`, `observed.ts`, `harness.ts` and
`notify.mjs`, which this work changes too). No code before #4331 is on `main`.

## What the check found (2026-11-15)

Run on an isolated daemon (`IsolatedDaemon`, private tmux server, fake Claude Code), a fake dial with `appFilter: v1`, no
window. Voice was sent as `turn.send`, the frame a transcribed utterance becomes.

| Case | Listed | Words reach it | Tap opens it |
|---|---|---|---|
| Harness agent in a tmux pane (two agents) | yes, `host: harness`, caps `sva` | yes, only the addressed pane got them | **no**: no `f` cap; `agent.open` logs `cable: open …` and goes to a window bridge that is not there; the dial is answered nothing |
| Claude Code in a tmux session the person opened | **no**: the core turns its hooks away (`SessionStart ignored · no_matching_engine_process`), and the hook does not take the paneless path because `TMUX_PANE` is set; the dial lists `total: 0` | no | no |
| Claude Code in VS Code's terminal (`TERM_PROGRAM=vscode`, VS Code's bundle id) | yes, `host: vscode`, caps `sf` | yes once its mod polls: caps `svf`, the poll is answered `{"text": …}` | VS Code comes forward (`open -b`), not the terminal |
| Claude Code in the VS Code extension's tab (VS Code's bundle id, no `TERM_PROGRAM`) | yes, `host: vscode`, caps `sf` | as above, through the mod | VS Code comes forward, not the tab |

Also read in the code:
- On macOS, Harness Desktop quits when its last window closes (`applicationShouldTerminateAfterLastWindowClosed`).
  "No window" is "Desktop not running".
- A `harness://notification/<machine>/<agent>` link that launches Desktop only opens the app: a link that arrives
  before the workspace listens names no agent (`SystemNotifications.openLink`).
- The Claude Code extension (2.1.289) handles `vscode://anthropic.claude-code/open?session=<id>`
  (`claude-vscode.primaryEditor.open` → `createPanel`). When a tab in that window already holds the session, it reveals
  that tab. Otherwise it opens a new tab on the session.
- A tap that opens is a tap on the agent's notice today. A tap on the face is voice for an agent with voice and "See
  it in <app>" for one without (the face tap that opens is the parked dial-tap-focus work, wave 2). Nothing here changes
  the firmware.

## Decided

- **F1, F2 and F3 in one pull request, three tasks, each test first** (PM, 2026-11-15).
- **F1 is in scope:** an agent in the person's own tmux is wave 1 #4's main case (PM, 2026-11-15).
- The three checks on Diego's real dial and Macs (Verification) run in one session with Diego after the pull request
  is done (PM, 2026-11-15).
- No firmware change, no change to Desktop, and no change to the core (cli/AGENTS.md rule 7) but one comment line:
  `MAX_HINTS`'s comment in `core/observedHook.ts` says the hook caps its own list (PM, 2026-11-15).
- **Q1 = A** (PM, 2026-11-15): the devices process may switch a tmux client to the agent's pane. `services/AGENTS.md`
  says so in the same pull request:
  - a service never writes to Harness's tmux: no pane or session Harness made;
  - in the person's own tmux, the devices process may run only `switch-client` (or a select) to the pane a hook named
    and whose process it checked;
  - it never types, creates or closes anything there.

  Harness's panes and the person's can share one tmux server (the daemon's default), so the rule is held per pane and
  session, by the owner tag the hook reads.
- **Q2 = A** (PM, 2026-11-15): F3 lands in this pull request. The pull request keeps `hold` until check 3 of
  Verification passes on Diego's Mac; if it fails, F3's commits come out before the merge.

## F1. Claude Code in a person's own tmux is on the dial

**What changes for the person.** An agent started by hand in a tmux pane (Claude Code, Codex or any engine with
hooks) is listed on the dial with the app closed or open, as an agent in Ghostty is today, and its state moves as it
works. Claude Code with the harness-device plugin takes the words said at the dial through its mod. A tap on its notice
shows its pane in tmux and brings its terminal app forward. An agent in a tmux pane Harness made is unchanged.

**The hook** (`cli/hook/notify.mjs`):
- A session counts as outside a pane when it has no pane (today), or when its tmux pane is **the person's own**:
  `paneFacts` reads `taken: 'no'` and the pane has no daemon's tag (`describePane(...).owner` empty). This is the same rule
  that already turns the session away from registration ("a tmux session the person opened by hand is no agent",
  `e2e/hookclient.e2e.ts`).
- Unchanged:
  - a pane another daemon tagged (routed to that daemon, as today);
  - an `if-held` pane (a session an older build named);
  - a pane tmux could not describe: `describePane` gave undefined, so the session is treated as in a pane, as today.
- Such a session takes the path a paneless one takes: `observedBody` and `postObserved`, nothing registered, its
  `Notification` told. The pane is read with the same `tmux display-message` call `routeToPaneOwner` already makes,
  cached for the hook's run. One cost is new: a `Notification` in a pane used to return at once, and now asks tmux
  whose pane it is first (`tmux -V` and one `display-message`). The pull request gives that number, measured.
- A session in a tmux pane keeps no Orca handle (PM, 2026-11-15): a tmux started inside an Orca terminal passes
  `ORCA_TERMINAL_HANDLE` to its panes, and words typed through Orca would land in tmux's active pane. Its voice is the
  mod's (Claude Code) or `codex queue`'s (Codex, #4334) only.
- `HOST_HINTS` gains `TMUX_PANE`. The body sends at most `MAX_HINTS` (10) of the hints set, in the list's order, so it
  never sends more than the core's observed route takes (`core/observedHook.ts` refuses a body with more). The order puts
  the nearer hosts first.

**Naming** (`cable/hosts/hostDetect.ts`):
- `detectHost`: `TMUX_PANE` names host `tmux`, after herdr, Rex and Zellij and before kitty and WezTerm.
- `detectApp`: the bundle id still decides first, so tmux in Ghostty is on Ghostty's page. `TERM_PROGRAM=tmux` with no
  bundle id, or with a bundle id no table lists (tmux in Alacritty), names the app `tmux` (its own page, "tmux"),
  not Other (PM, 2026-11-15). `tmux` is the 16th app id, the firmware's `CABLE_MAX_APPS`: the next one needs a decision.
- The firmware's host table has no `tmux`, so "See it in" reads "See it in Terminal" for an agent without voice. That is
  accepted: no firmware change.

**The tap** (`cable/hosts/open.ts`):
- `paneOf` reads `TMUX_PANE` (`/^%[0-9]{1,9}$/`) as pane `{ app: 'tmux' }`, in the order `detectHost` reads hosts:
  herdr, then tmux, then WezTerm and Orca (PM, 2026-11-15, after the final review). A tmux server keeps the environment it
  started in, so in a tmux pane `WEZTERM_PANE` and `ORCA_TERMINAL_HANDLE` name the terminal the server began in, not
  where the agent is; the same reason its Orca handle is dropped for voice.
- Focus runs `tmux` with no shell, each value one argument, under `RUN_TIMEOUT_MS`:
  1. `tmux display-message -p -t <pane> '#{pane_pid}'`. The pane's process must be the agent's process or one of its
     parents (at most `WALK_PARENTS`, from the process table the open scan already reads). Otherwise this is not the
     agent's pane: a person's second tmux server (`-L`) can have a pane of the same id. Then nothing is switched, and one
     line is logged: `[device] open · tmux · not its pane`.
  2. `tmux switch-client -c <client> -t <pane>`, which makes that session, window and pane current in that client. The
     client is the one used last among those **not on a session Harness made** (PM, 2026-11-15): Harness's own
     terminals (Desktop, a phone, `hn`) are control-mode clients on the same server, and a bare `switch-client` would move
     the one used last, even one of those. With no such client, nothing is switched and only the app comes forward.
  3. Then, on macOS, the app's bundle comes forward (`open -b`), as for every pane.
- The tmux is the daemon's: the same binary and server as `lib/tmux.ts`. The hook's `TMUX` (the socket path) is not
  sent: it is longer than a hint takes, and it is a path someone could shape.
- Step 2 is allowed by Q1 (Decided): only this switch, only on the person's own pane, after step 1's check.
- After #4331: the agent's tty in tmux (or Zellij, herdr) is the multiplexer pane's, never a terminal tab's. An agent
  gets a terminal tab only while the tab app is its nearest host, so no tab select is sent for it; the tmux pane
  decides (final review, 2026-11-15).

**Voice.** As for any agent outside a pane (`ObservedSource.send`): Claude Code's through its mod, Codex's through
`codex queue` (#4334, which types nothing). Nothing is typed into a tmux pane the person owns: `tmux send-keys` for an
agent with neither is not in this work.

## F2. A tap opens a Harness agent with the app closed

**What changes for the person.** With Harness Desktop not running, a tap on a Harness agent's notice opens Desktop on
that agent's pane. With a window open nothing changes: the window opens it, as today.

**Design** (devices process only):
- `HarnessSource.capabilities` gives `focus: true` on macOS, so the dial's notice tap sends `agent.open` for it. It is
  the source used only with no window. Elsewhere it stays `false`.
- `CableHost.openAgent` for a Harness agent of this computer with no window:
  1. Runs `/usr/bin/open -b ai.autonomous.harness` (Harness Desktop's bundle id, `BUNDLE_APPS`).
  2. Keeps the open waiting: one at a time, the last tap wins.
  3. When a window bridge comes (`swarms` turns non-null in `services/devices.ts`), the waiting open goes to it through
     the existing `opened` path (`dial_open`), and the window opens the agent as it opens a tapped notice today.
- A waiting open ends after 30 s (`HARNESS_OPEN_WAIT_MS`: room for a cold start, the sign-in check and the first
  connect; not measured on Diego's Mac, which this work does not touch). It also ends on a second tap or when the agent
  leaves the list.
- `open -b` failing (Desktop not installed) answers the dial "Harness did not open it." (the existing
  `<host> did not open it.` line). The timeout logs `[device] open · harness · no window`.
- A question screen that comes up by itself (`reason` set) never launches Desktop, as for every other source.
- No Desktop change: the link's cold-start gap is not used. The window is told to open once it is there.

## F3. A tap opens the VS Code extension's tab

**What changes for the person.** A tap on the notice of a Claude Code session in the VS Code extension's tab shows that
tab in VS Code. A session in VS Code's terminal still only brings VS Code forward: choosing that terminal needs a VS
Code helper, which is wave 2.

**Design:**
- `HOST_HINTS` gains `CLAUDE_CODE_ENTRYPOINT`. The extension sets it to `claude-vscode`, read in the extension's code.
  It is not a secret: a fixed word naming how Claude Code was started. The hint cap above applies.
- `open.ts` `paneOf` reads pane `{ app: 'vscode', id: <session id> }` only when all three hold:
  - `CLAUDE_CODE_ENTRYPOINT === 'claude-vscode'`;
  - the hook's own `__CFBundleIdentifier` is VS Code's (`com.microsoft.VSCode`): never Cursor's, never inferred;
  - the session id is a UUID.

  `openTarget` takes the session id for this.
- Focus runs `/usr/bin/open vscode://anthropic.claude-code/open?session=<uuid>`, then VS Code comes forward as for any
  pane. The link exits 0 when macOS has handed it on. As with the Claude app's link, a link that does nothing still
  leaves VS Code in front.
- `detectApp` and `detectHost` are unchanged: the bundle id already names VS Code.
- A VS Code window that does not hold the tab may open a second tab on the session: check 3 of Verification decides
  whether F3 merges (Q2, Decided).

## Failure cases

| Case | What happens |
|---|---|
| tmux cannot describe the pane in the hook | The session is treated as in a pane, as today: not listed |
| The pane's process is not the agent's | No switch; the app comes forward; one log line |
| No client of the person's on that server (none attached, or only Harness's) | Nothing is switched; the app comes forward |
| A body with more than 10 hints set | The hook sends the first 10 in its order; the core takes it |
| Desktop not installed | "Harness did not open it." on the dial |
| Desktop starts but no window connects in 30 s | Desktop is in front, the agent is not opened; one log line |
| The VS Code link fails | VS Code comes forward; one log line naming the app only |

## Security and privacy

- Every value comes from a hook, so each is checked against its form before use: pane id, session UUID, entrypoint
  word. Each command runs with no shell, every value one argument (`open.ts`'s rule).
- No hint carries a secret. `TMUX` and VS Code's IPC paths are not read.
- Log lines name the app only, never a pane, a session or a path.
- The core's code is not changed (one comment line only): the observed route already takes these events.

## Measures

The existing `[device] open · <app> · fallback` log line, plus `· not its pane` and `· no window`: app names only, no
content or ids.

## Platforms

- macOS: all three.
- Linux:
  - F1: listing, voice and the tmux switch (no app forward);
  - F2: none (no `open -b`; the cap stays off);
  - F3: none.
- Windows: none (no dial host path for these yet).

## Tests (each red first)

- `hookNotify.spec.ts`: a person's own tmux pane posts to `/api/hook/observed` with `TMUX_PANE` and registers nothing;
  a Harness pane still registers; a pane another daemon tagged is unchanged; at most 10 hints are sent.
- `hostDetect.spec.ts`: `TMUX_PANE` names host `tmux`; tmux with Ghostty's bundle is on Ghostty's page;
  `TERM_PROGRAM=tmux` alone is the `tmux` app.
- `open.spec.ts`:
  - the tmux pane, its pid check and its fallback;
  - the VS Code link only with all three conditions;
  - Cursor's bundle with `claude-vscode` opens no link.
- `harness.spec.ts`, `cableHost.spec.ts`: no window, a tap launches Desktop and the open waits for the window; the
  timeout; `reason` set does nothing.
- End to end, extending `e2e/deviceWithoutApp.e2e.ts`:
  - Claude Code in a tmux session the test opened on the private tmux server is listed with `host: tmux`.
  - Its mod's poll takes words said at the dial.
  - `agent.open` switches the pane on a control-mode client the test attached (`tmux -C attach`), with no app forward
    in the test (no bundle id hint, so nothing on the developer's screen moves).

## Verification

- Isolated, on this Mac: the end-to-end tests above (`npm run test:e2e` for the changed files). Never Diego's daemon,
  dial or apps.
- With Diego, after the pull request (PM, 2026-11-15), on his dial and Mac:
  1. Claude Code in a VS Code extension tab, with harness-device on:
     - it is on VS Code's page (not Other, not Ghostty);
     - words said at the dial start a turn in that tab;
     - a notice tap shows that tab.
  2. Claude Code in VS Code's terminal:
     - the same checks;
     - when VS Code was started with `code .` from Ghostty, which page it is on.
  3. Two VS Code windows, the session's tab in the other one: the notice tap shows the existing tab rather than opening a
     second tab on the session (Q2).
  4. Ghostty + tmux, Claude Code in a pane, Desktop quit:
     - it is listed;
     - its voice works;
     - a notice tap shows its pane and Ghostty.
  5. A Harness agent's notice tap with Desktop quit opens Desktop on it.

## Out of scope

- Typing into a person's tmux pane for an agent without a mod (`tmux send-keys`).
- Choosing VS Code's integrated terminal (needs a VS Code helper), Cursor's extension tab (`cursor://`).
- The face tap that opens (dial-tap-focus, wave 2), any firmware change.
- F2 on Linux and Windows.

## Open questions

None. Q1 (the tmux switch) and Q2 (the VS Code link) are decided above.
