# Dial on Linux, follow-ups of #4501: words in the agent's own Orca and herdr pane, herdr inside a terminal, GNOME's tap

## Intent

#4501 (merged 2026-11-19) brought the dial to Linux and left three follow-ups that make it wrong or unreachable for
people who use Orca, herdr and GNOME there. macOS's behaviour and UX are the reference (Ken via harness-pm); every
difference Linux forces is named below with its reason. One pull request.

1. **Words land in the wrong pane.** Orca's and herdr's adapters type the dial's answer and voice into the pane their
   hint names (`ORCA_TERMINAL_HANDLE`, `HERDR_PANE_ID`). A program started from that pane inherits the hint: VS Code
   from `code .`, a WezTerm or kitty window, a nested terminal. An agent there then gets its words typed at the prompt
   of the Orca terminal or herdr pane it was started from, another agent's or a shell's. #4501 fixed the same cause for
   WezTerm, kitty and Zellij (the own-pane check); Orca and herdr were left out because Orca's Linux process name was not
   recorded.
2. **herdr inside a Linux terminal is unreachable.** On macOS (#4500) an agent in herdr inside a Terminal, iTerm2 or
   Ghostty tab is on that app's page, and a swipe or a tap reaches it. On Linux the client lookup
   (`herdrOuter.ts`) answers nothing (`platform !== 'darwin'`), so the agent sits on the "Other" page and a tap focuses its
   herdr pane with no window coming forward.
3. **GNOME's tap check asks about another app than its raise.** On GNOME the tap check (`open.ts` `can`) asks the raise
   about the app the target's bundle names, while the raise uses the agent's own app (`observed.ts` `windowOf`). An
   agent whose app was learnt from its parents (the Claude app on Linux, a VS Code terminal) gets no tap there.

## Root causes (read from the code, 2026-11-21)

1. `orca.ts` `createOrcaAdapter.paneOf` gives a pane to any valid `ORCA_TERMINAL_HANDLE` unless the host is a
   multiplexer; `herdr.ts` `paneOf` to any valid `HERDR_PANE_ID`. `observed.ts` `learnPtyOwner` reads the pty's maker
   only for `PTY_HINTS` (WezTerm, kitty, Zellij), and `scannedApp.ts` `PTY_HOSTS` names neither Orca's nor herdr's
   process. On this Mac an Orca terminal's chain is `claude` → `zsh` → `/usr/bin/login` (all on `ttys020`) →
   `…/daemon-host/macos/terminal-host-<hash>/app.noindex/Orca Agents.app/Contents/MacOS/Orca Agents` (no tty, ppid 1):
   the maker is `Orca Agents`. Linux's is not recorded yet (Orca's Linux daemon is its own executable host,
   `src/main/daemon/executable-host/linux/` in stablyai/orca).
   - The same cause in herdr's client lookup: `herdrOuter.ts` takes "the nearest `herdr` in the caller's parents" as the
     server. A terminal started from a herdr pane (a WezTerm, an xterm) has that server among its parents too, so its
     agents would be placed on the herdr client's app. On Linux every program started from a pane is its child.
2. `herdrOuter.ts` returns `undefined` off macOS, runs `/usr/sbin/lsof` and reads macOS's unix-socket peer addresses
   (`->0x…`); Linux's lsof prints no unix peer without `+E` and is not installed by default on several distributions.
   Its tty form is macOS's (`TAB_TTY`, `/dev/ttys…`), so a Linux client's `/dev/pts/<n>` names no tab. The tab is
   selected on macOS by the tabs adapter (Harness Device's AppleScript, Terminal/iTerm2/Ghostty only); nothing selects
   a WezTerm or kitty tab holding a multiplexer's client, on either OS.
3. `open.ts` `can`: `raise.ready({ agent: true, app: appOf(target.bundle) })`; `raiseWindow`: `raise({ pid, app:
   windowOf(agentId).app })`. GNOME raises by class only (`byProcess` is false), so the check needs the app's class and
   reads it from the bundle, which on Linux is only the host's (`APP_BUNDLES[host]`, none for `terminal`).

## Decided

- PM (harness-pm, 2026-11-21): items 1-3 as proposed; fixing the wrong-pane cause on macOS too is fine (same cause).
- PM: a terminal with no page of its own on the dial (GNOME Terminal, Ptyxis, Konsole, Alacritty, xterm, …) keeps an
  agent in herdr there where macOS puts it today for a terminal it does not list: the **"Other" page** (app id `terminal`; herdr's panes say `TERM_PROGRAM=herdr`, which names no app, and no listed app is among the parents), as an agent run directly in that terminal; macOS's behaviour is not
  changed for this. A swipe and a tap still reach the agent through `herdr agent focus`. On Linux, where the desktop
  takes a process (X11, sway, KDE, Hyprland), a tap also raises the window holding herdr's client, by that client's pid.
- PM: spec goes straight to the plan.
- PM, after the builder check (2026-11-21):
  1. Strict: a pty maker that is not one of Orca's recorded names leaves the Orca pane held. Every current Orca mode is
     recorded (macOS daemon host, Linux .deb, AppImage, an in-process fallback if Orca's source has one), and
     `[device] orca · held` is logged, so a renamed terminal host shows at once. Orca versions from before its terminal
     host are not covered (named).
  2. herdr inside the person's tmux or Zellij is placed only through the variables herdr's server inherited when it
     started (`TMUX_PANE`, Zellij's session); a client that attached later from elsewhere is not placed (its
     environment cannot be read): a named limit. One mechanism for both, so on macOS herdr inside tmux inside Terminal,
     iTerm2 or Ghostty moves from the "Other" page to that app's page, as #4500's rule says (herdr in a terminal app → that
     app's page); said in the PR.
  3. WezTerm and kitty tab selection is one code path on both OSes: on macOS too.
  4. The builder's call below (a held pane ranks after the agent's other panes for a tap) stands.
- PM, on the plan's questions (2026-11-21):
  1. If herdr's own listing names an agent whose pty herdr did not make (one that only inherited `HERDR_PANE_ID`) and
     gives no session id, herdr's row folds into the hooked agent whose herdr pane there is held and whose engine
     matches, so it takes no words into that pane. Trade-off, named in the PR: a real other agent in that pane (rare) is
     hidden behind it.
  2. A herdr pane held only because its maker has not been read yet still folds with herdr's row for that pane (no
     words either way), so the list does not show two rows for the first moments after a hook.
  3. The existing Orca e2e files that need the new Orca terminal-host stand-in are run by PR CI from now on: where a
     PR CI suite runs them (`linux-e2e`), `scripts/ci-plan.py` selects them when the stand-in or the code they cover
     changes, with its test; any that no PR CI suite can run are run locally (this Mac and `devcrew-dlf`) under the
     machine gate, one at a time; no `cli-e2e.yml` dispatch.
- Out of scope, named in the PR, not done: two WezTerm GUI processes sharing pane ids (`wezterm cli` without
  `--unix-socket` may pick the wrong one, pre-existing); Hyprland beyond contract tests (no GPU on runners or
  containers).

## Goals

1. An agent in a terminal, editor or multiplexer started from an Orca terminal or a herdr pane never gets the dial's
   words typed into that Orca terminal or herdr pane; an agent whose pty Orca or herdr made still gets them, as today.
   A test shows the voice reaching the right pane.
2. On Linux, an agent in a pane of the person's default herdr session, with herdr's client in a WezTerm, kitty or
   Ghostty window, is on that app's page as one row; herdr's client inside the person's Zellij or tmux places it on the
   app holding that multiplexer's client.
3. On that page a swipe or a rest while the app is in front selects the tab holding herdr's client where the terminal
   has a tab API (WezTerm, kitty), then focuses the agent's herdr pane; a tap does the same and brings the client's
   window forward through the raise. Where a terminal has no tab API, the PR and the docs say so.
4. On GNOME the tap check and the raise ask about the same app, the agent's own.

## Non-goals

- A page of its own for GNOME Terminal, Ptyxis, Konsole or any terminal the dial does not list (decided: the "Other" page, as today).
- Selecting a tab in GNOME Terminal, Ptyxis, Konsole, Ghostty (Linux), Alacritty, foot or xterm: none offers a tab API
  the dial can call without new permission (GNOME Terminal's and Ptyxis' D-Bus interfaces select no tab; Ghostty's Linux
  build has no list/focus; Konsole's D-Bus `setCurrentSession` is not used here, a later decision).
- Windows: no `ps`/tty names there (ConPTY), so the own-pane check does not run there and Orca and herdr keep typing by
  their hint as today; the hint-inheritance case stays a known limit on Windows.
- Named herdr sessions (`herdr --session <name>`): the hook sends no `HERDR_PANE_ID` there (unchanged).
- Anything in `cli/src/core`, `cli/hook`, or `architecture.coreFiles.txt`.

## Anti-goals

- Reading another process's environment or argv, by any means (`/proc/<pid>/environ`, `ps e`, `kitten @ ls`'s `env`
  and `cmdline`): `cli/AGENTS.md` rule 4. Process names are matched against fixed tables and dropped.
- Losing Orca's or herdr's words where they work today: an agent whose terminal Orca or herdr made must still take
  words on macOS and Linux, and on Windows nothing changes.
- A tap that raises a window the agent is not in, or a swipe that moves a tab or pane the person did not ask for.

## Constraints

- Devices process only (`cli/src/cable/hosts/`, `cli/src/services/devices.ts`); `observed.ts` and `open.ts` hold no
  rule about an app (`cli/src/services/AGENTS.md`).
- Every command with no shell, every value from a hook or a tool checked against its form, the existing run timeout,
  bounded output; lookups at most once per pane and caller every 5 s, one in flight (as `herdrOuter`, `tmux`, `zellij`).
- Process names come from recordings (`cli/src/testing/recorded*.ts`), never guessed. Orca's Linux pty maker is
  recorded from Orca's own Linux build (1.4.267 or newer) in a disposable Ubuntu 24.04 container.
- Linux e2e runs on GitHub's Linux runners through PR CI's `dial-hosts` (files `cli/e2e/dialHost*.e2e.ts`) and
  `linux-e2e` jobs, selected by path (#4526); recordings and local Linux runs in this work's own Podman machine
  (`devcrew-dlf`, asked of harness-pm before it starts, stopped and removed at the end).

## Approaches

**Item 1, whose pane is it.**
- **A. The pty's maker (chosen).** #4501's own-pane check, extended: Orca's and herdr's hints join `PTY_HINTS`, their
  makers join `PTY_HOSTS`, and their panes take words only when that maker made the agent's pty. One rule for every
  host the dial types into; a read already paid for WezTerm, kitty and Zellij; works on macOS and Linux.
- B. Ask Orca or herdr which terminal holds the pid. Neither CLI answers it (Orca's `terminal list` names no pid;
  herdr's API lists no clients), and it would be one rule per app.
- C. Have the hook send more (its own pty's maker). The hook stays small and fast (`cli/hook`, out of scope), and the
  devices already read the chain.

**Item 2, herdr's clients on Linux.**
- **A. The kernel's socket table, through iproute2's `ss` (chosen).** iproute2 is on every systemd distribution; `ss -x`
  pairs each unix socket's inode with its peer's, and the server's accepted sockets carry the `herdr-client.sock` path,
  so the clients are herdr's processes holding a peer of those. The exact read (`ss -xp`, or `ss -x` plus the
  descriptors of herdr's own pids) is the plan's, from a recording, held to herdr's own processes and bounded.
- B. `lsof +E -U`: lsof is not installed by default on Debian, Arch and others, and prints no unix peer without `+E`.
- C. No sockets: every `herdr` process on a tty a herdr server did not make counts as a client. Two servers (a named
  session beside the default one) mix their clients: a guess.

**Item 2, the tab.**
- **A. Each terminal's own adapter, from the outer place (chosen):** WezTerm by `wezterm cli list --format json` (the
  pane whose `tty_name` is the client's tty) then `activate-pane`; kitty by `kitten @ focus-window --match pid:<the
  client's window process>` on the kitty socket the agent's hints name. Platform-neutral code, as both adapters are.
- B. Harness Device's tabs stream (macOS's path): AppleScript; no Linux side, and it would need the Device app.

**Item 3.** One app for both, the agent's own (what the raise already uses): the alternative, the bundle's app for
both, is wrong for every agent whose app was learnt from its parents.

## Design

### 1. The agent's own Orca and herdr pane (macOS and Linux)

- `scannedApp.ts` `PTY_HOSTS` gains herdr's server and client (`herdr`, the name `ps` gives on both OSes; `--no-session`
  runs the panes under the client) and Orca's terminal host: `Orca Agents` on macOS (recorded on this Mac above), and
  Linux's recorded name(s), from the .deb and the AppImage, plus an in-process fallback's if Orca's source has one. Only
  names a recording shows; a mode that cannot be recorded is named in the PR as not covered.
- `observed.ts` `PTY_HINTS` gains `HERDR_PANE_ID` and `ORCA_TERMINAL_HANDLE`, so their callers' makers are read once per
  caller as WezTerm's are.
- `orca.ts` `paneOf`: the pane is the agent's own when `place.ptyOwner === 'orca'`, else `held:` (as WezTerm's): a held
  Orca pane takes a tap alone (the terminal switch), no rest and no words. On Windows (`deps.platform === 'win32'`, no
  `ptyOwner` read there) the pane stays own, as today.
- `herdr.ts` `paneOf`: own when `place.ptyOwner === 'herdr'`, else held, on the same terms; Windows as today. Whatever
  folds with a held herdr pane, the dial's words never go into that pane, by the hooked agent's route or by the herdr
  source's (`herdrSource.ts` words come through the adapter's `prompt`). Whether herdr's own listing names an agent
  whose process runs on a pty herdr did not make (a terminal started in its pane) is recorded; if it does with no
  session id, its row folds into the hooked agent whose herdr pane there is held and whose engine matches (decided
  above), and a row of another engine stays its own. A pane held only because its maker is not read yet folds with
  herdr's row as an own pane does.
- A held pane comes after the agent's other panes for a tap (builder's call, from the anti-goal): `observed.ts`
  `target()` takes the pane of the host that made the agent's pty first, as today, then the first tappable pane that is
  not held, and only then a held one. So VS Code started from an Orca terminal or a herdr pane is tapped in VS Code (its
  extension's terminal, or its app), and the Orca terminal or herdr pane is not switched. A pane says it is held through
  a generic field (`Pane.held`), set by WezTerm, kitty, Zellij, Orca and herdr; `observed.ts` names no app.
- Until the maker is read (a few `ps` runs, off the hook path), an Orca or herdr pane is held: the words wait for the
  read as WezTerm's do. A read that failed is retried as today (`TTY_RETRY_MS`).
- A held decision for Orca or herdr is logged once per caller process with the host's id alone
  (`[device] <orca|herdr> · held`): an Orca release that renames its terminal host shows in the log, not as silent loss.
- `herdrOuter.ts`: the server is the process that made the caller's pty, when it is herdr, not the nearest herdr among
  its parents: a terminal started from a herdr pane gets no herdr client's place. One read serves both, as `zellij.ts`'s
  lookup reads `readPtyOwner` (it needs the maker's pid as well as its host).

### 2. herdr inside a terminal on Linux

**The lookup (`herdrOuter.ts`), on Linux too.** The same five steps and bounds as macOS (one table read; the clients
connected to the server's `herdr-client.sock`; their ttys; their apps; the one used last by its tty's access time),
with Linux's own reads:
- clients: from `ss` (Approach A), only for the server and at most 16 other herdr pids; a `herdr agent …` command,
  connected only to `herdr.sock`, is no client;
- ttys: `ps -o pid=,tty= -p …`; Linux's form is `/dev/pts/<n>`, held to its own pattern;
- apps: `scannedApps` (Linux names: `wezterm-gui`, `kitty`, `ghostty`, … as the table lists).
- Logs as today: `[device] herdr client · found|none|not read · <step>`.

**A client inside the person's tmux or Zellij.** A client whose own pty a multiplexer made has no app among its
parents (they end at the detached server). The lookup then asks the multiplexer lookups (`createTmuxOuter`,
`createZellijOuter`) for the client's pid with the agent's hints, and answers theirs: the agent is on the page of the
app holding tmux's or Zellij's client. Those lookups read the agent's hints, which are what herdr's server inherited
when it started: a client that attached later from another tmux pane or Zellij session is not placed (decided, named in
the PR). This is the same mechanism on macOS, where it also places herdr inside the person's tmux on the terminal app's
page (today it sits on the "Other" page), as #4500's rule says; said in the PR. Zellij names no pane's process or tty
(`RECORDED_ZELLIJ.listPanes`), so the Zellij pane holding herdr's client is not selected: a tap brings the app holding
Zellij's client forward and focuses the herdr pane.

**A client in a terminal with no page (decided).** No listed app among the client's parents and no multiplexer: the
agent stays on the "Other" page. On Linux the answer still carries the client's pid, so a tap's raise brings forward the
window of that client or its nearest parent that owns one (`linuxRaise.ts`, by process: X11, sway, KDE, Hyprland). GNOME
raises by class, and herdr has none: no raise there. On macOS nothing changes (the raise is `open -b`). `firstOuter`
keeps that pid when no later lookup names an app; `observed.ts` keeps it for `windowOf` only, never for the page or a tab.

**The tab (WezTerm, kitty), on macOS and Linux.** With an outer place naming WezTerm or kitty (herdr's or tmux's client
there), that adapter gives the agent a tab pane that comes after its app (`tap: 'after'`, as the tabs adapter's), shown
by a rest while that app is in front and raised once a tap brought the app:
- WezTerm: `wezterm cli --no-auto-start list --format json`, only `pane_id` and `tty_name` read; the pane whose tty is
  the client's is activated (`activate-pane --pane-id`). One list per verb, bounded output.
- kitty: the client's window process is the one in the client's chain whose parent is the kitty that made its pty; the
  window is focused by `kitten @ --to <socket> focus-window --match pid:<pid>` on the socket the agent's hints name
  (`KITTY_LISTEN_ON`, checked as `kitty.ts` checks it). No `ls`: its output holds the windows' environment. No socket
  hint, or no window matches: no tab, the tap still raises the window.
- The order a rest shows them is the tabs adapter's: the tab first, then the herdr pane (`observed.ts` `shown`).
- tmux's lookup gives a Linux tty in its own form too, so tmux inside WezTerm or kitty gets the same tab (same cause).

**Where a terminal has no tab API** (copy for the PR, `docs/cli.md` devices row and the Linux design's table):
GNOME Terminal, Ptyxis, Konsole, Ghostty on Linux, Alacritty, foot, xterm: the agent's page is the client's app's when the
dial lists it (Ghostty), else herdr's; a swipe and a tap focus the herdr pane; a tap raises the client's window where the
desktop takes a process; the tab holding the client is not selected.

### 3. GNOME's tap check

`open.ts`: the check asks the raise about the agent's own window app, the same one `raiseWindow` uses
(`windowOf(agentId).app`), for every desktop; the bundle no longer stands in for it there. An agent the raise can bring
forward is tappable, and one it cannot is not. The plan picks how the app reaches `can` (the target carries it, or `can`
takes the agent's id). GNOME still raises by class: with two windows of one app, the extension picks one (named, as in
#4501).

### Cases

| Agent | Before | After |
|---|---|---|
| In an Orca terminal (macOS, Linux) | words, rest, tap through Orca | same, once the maker reads `orca` |
| In VS Code / WezTerm / kitty started from an Orca terminal | words typed into the Orca terminal | Orca pane held: no words there; that app's own pane takes them where it can |
| In an Orca terminal, Windows | words by handle | unchanged |
| In a herdr pane | words, tap through herdr | same, once the maker reads `herdr` |
| In a terminal started from a herdr pane | words typed into the herdr pane; macOS/Linux client lookup could place it on herdr's client's app | herdr pane held; no herdr client place |
| herdr client in WezTerm / kitty / Ghostty (Linux) | "Other", tap focuses herdr pane | that app's page; rest selects the WezTerm/kitty tab, then herdr focus; tap raises the window too |
| herdr client in WezTerm / kitty (macOS) | WezTerm's/kitty's page, no tab | same page; the tab is selected |
| herdr client in tmux or Zellij inside a listed app | "Other" | the app holding the multiplexer's client |
| herdr client in GNOME Terminal etc. (Linux) | "Other" | "Other"; tap also raises the client's window (not GNOME) |
| tmux client in WezTerm / kitty | that app's page, no tab | the tab is selected |
| GNOME, agent whose app was learnt from its parents | no tap | tap raises its app's window by class |

### What does not change

The core, the hook, the Orca and herdr sources' listing, Harness Device's tabs stream, macOS's Terminal/iTerm2/Ghostty
tab selection, the page of an agent in an unlisted macOS terminal, Windows.

### Measures

Off the hook path, once per caller (the maker) or once per pane and caller every 5 s (the lookups). Numbers before and
after in the PR: the maker read for an Orca caller on macOS (expected ~4 one-pid `ps` runs, ~10 ms) and Linux; herdr's
Linux client lookup (`ss` and `ps`) with 1 and 3 clients; one WezTerm `list` per rest. Logs carry step and outcome words
only, never a pid, tty, pane id, path or name.

### Data (docs/feature-design-rules.md)

Nothing new is stored, synced or exposed. In memory per devices process: the maker per caller (as today), the outer
place with the client's pid (as today, now also without an app), the lookups' 5 s answers. Read: process names, parents
and ttys, unix-socket inodes of herdr's own processes, WezTerm's pane ids and ttys. Never environment or argv. Nothing
leaves the computer.

### Platforms

- macOS: item 1 (Orca's and herdr's own pane, herdr's server by maker), herdr inside tmux/Zellij placed by their
  client, the WezTerm/kitty tab for an outer place; tested on this Mac.
- Linux: all three items; tested on GitHub's Linux runners (`dial-hosts`, `linux-e2e`) and in `devcrew-dlf`.
- Windows: no change (no maker read there); the unit tests run on PR CI.

## Verification (for the plan)

1. **Recordings** in `devcrew-dlf` (Ubuntu 24.04 arm64): Orca 1.4.267+ Linux build, a terminal opened, the process chain
   and ttys of a shell in it (Xvfb if the app needs a display; Orca's own `orca-server` build if the window cannot
   start, said so); herdr 0.9.5 server, two clients and a `herdr agent` command, their `ss` rows and ttys; WezTerm's
   `cli list --format json` from `wezterm-mux-server`; kitty's `focus-window --match pid:` against a recorded window.
2. **The voice reaches the right pane, Linux** (`dialHost*` e2e, dial-hosts job): a real daemon and dial stand-in; an
   agent in a pty made by a stand-in for Orca's terminal host (an executable named as recorded) gets its words through
   the fake `orca` CLI; an agent started from that pane in a WezTerm mux pane (inheriting `ORCA_TERMINAL_HANDLE`) gets
   them in the WezTerm pane (`wezterm cli get-text`) and the fake `orca` gets no `terminal send`. The same for herdr:
   an agent in a WezTerm pane started from a herdr pane gets its words in WezTerm, none in the herdr pane; one in the
   herdr pane gets them there (`deviceHerdr` keeps passing).
3. **herdr inside a terminal, Linux** (`dialHost*` e2e): herdr's client attached in a WezTerm mux pane: the agent is on
   WezTerm's page, one row; a rest with WezTerm in front activates the client's WezTerm pane (`cli list` reads it back)
   and moves herdr's focus; with another app in front nothing moves. herdr's client in an xterm on the X11 desk (no page):
   the agent stays on the "Other" page and a tap raises that xterm (`_NET_ACTIVE_WINDOW`). kitty under Xvfb: the client's
   window is focused. herdr's client in a Zellij pane: the page of the app holding Zellij's client, where the runner can
   hold one; else unit tests only, said so.
4. **macOS on this Mac:** `dialHerdrTerminal`, `dialTmuxTerminal`, `deviceHerdr`, `dialOrcaFocus`, `dialOrcaFullRing`,
   `dialStream` pass; the voice e2e of point 2 on macOS with a stand-in named `Orca Agents`.
5. **GNOME:** contract tests against `RECORDED_GNOME_SHELL` for the check and the raise asking the same class.
6. **Local gates:** `python3 scripts/local-checks.py --run` (cli-core and what it selects) on the final head, receipts in
   the PR before the push.
