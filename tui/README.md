# tim — tmux improved

All of Harness in a terminal — every harness on every machine, in tabs and panes, from any
terminal you can type into: a laptop, a server over SSH, a tablet's SSH app.

```bash
tim           # or hn, or harness tui
```

vim is vi improved: every vi key works, and more. tim is that for tmux — every tmux key and
`~/.tmux.conf` line works, with every harness on every machine behind them. What tmux users have
asked for over the years, and what tim does about it: [docs/tmux-improved.md](docs/tmux-improved.md).

![Three harnesses on two machines, side by side](docs/panes.png)

![C-b s: every harness on every machine, the one waiting on you nearest the prompt](docs/launcher.png)

<sub>Screens from the demo fleet in `tests/mock-daemon.mjs` (`MOCK_DEMO=1`).</sub>

It is a **client of the same daemon the desktop app uses**. Nothing runs inside it: the agents
live in the daemon's tmux on their own machines, and each pane is a live stream of one of them.
Close it, lose the connection, reopen it anywhere — everything is where you left it, because
your tabs are the account's **desk**, the same tabs the desktop and the phone show.

On a fresh server `hn` signs in (over SSH the login prints a URL and takes the pasted
callback), starts the daemon, then opens.

## Keys

tmux's. The prefix is `C-b`; every default tmux binding does what it does in tmux, with a window
being a tab and a pane being a harness. If you have a `~/.tmux.conf`, it is read: your prefix,
your binds (vim-tmux-navigator's `C-h/j/k/l` included), `base-index`, `mouse`,
`status-position` and your colours come with you.

| tmux keys | |
|---|---|
| `C-b s` | every harness on every machine — an fzf list with a live preview |
| `C-b c` / `C-b C` / `C-b T` | new window / new harness / new terminal |
| `C-b %` `C-b "` | split right / below, picking the harness to put there |
| `C-b o` `C-b ;` `C-b ←↑→↓` `C-b q` | next pane, last pane, pane in a direction, pane numbers |
| `C-b z` `C-b space` `C-b M-1…5` `C-b { }` `C-b C-o` | zoom, next layout, a layout, swap, rotate |
| `C-b C-←↑→↓` `C-b M-←↑→↓` | resize (repeatable, like tmux's `-r`) |
| `C-b n` `C-b p` `C-b l` `C-b 0…9` `C-b w` `C-b ,` `C-b &` | windows |
| `C-b x` | close the pane (the harness keeps running) |
| `C-b [` `C-b /` `C-b ]` | copy mode (vi keys), search back, paste |
| `C-b :` | the command prompt — tmux commands, `Tab` completes |
| `C-b ?` | every key, fzf-searchable — or just pause after `C-b` and they show |
| `C-b d` | detach — everything keeps running |

Harness's own, on the letters tmux leaves free:

| | |
|---|---|
| `C-b a` / `C-b A` | next harness waiting on you / all of them (`M-1…9` answers from the list) |
| `C-b I` `C-b M` `C-b S` | models, machines, the Harness Store |
| `C-b g` `C-b B` | send a task (Harness picks the harness) / broadcast to the window |
| `C-b R` `C-b P` `C-b K` | restart, pause, clone the harness |

In every list, fzf's keys: `C-j/C-k` `C-n/C-p` move, `Tab` marks, `C-/` toggles the preview,
`S-↑/↓` scrolls it, `C-a C-e C-w C-u` edit the query, `enter` opens, `C-t` in a new window,
`C-v` beside, `C-x` below, `esc` leaves. fzf's search syntax works (`'exact ^prefix suffix$ !not a | b`),
and its colours follow `FZF_DEFAULT_OPTS` (`--color=light`, `16`, `bw`).

Colours are the terminal's 16, as tmux's are, so tim reads on dark, light and Solarized themes.

## Mouse and clipboard

Click a pane to focus it, a tab to switch, a launcher row to open it; drag a split's border or a
pane's header to resize; double-click a tab to rename it, middle-click to close it. Drag over
text to copy it (double-click a word, triple-click a line; hold `⇧` over programs that use the
mouse). Copying uses OSC 52, so it lands on the clipboard of the computer you are sitting at,
over SSH too.

## Two windows, one harness

A terminal has one keyboard. Opening a harness another window is driving shows it read-only
("watching"); the first key you type takes it over, and the other window starts watching.

## Speed

Each pane's header shows its measured keystroke → echo latency. On this machine that is about a
millisecond. On another machine it is the network: when a pane measures slow (≥20ms), typed
characters are echoed locally — underlined until the far side confirms them, the way mosh does.
`HARNESS_TUI_PREDICT=off` turns that off, `=always` forces it on.

## Your keys

`~/.tmux.conf` first (`HARNESS_TUI_TMUX_CONF=off` ignores it, `=path` reads another file); then
`~/.config/harness/tui.toml` for anything specific to Harness:

```toml
prefix = "C-a"
desk = "sync"              # sync | read | off
predict = "auto"           # auto | always | off
notify = true              # OS notifications through the terminal

[keys]                     # the root table: no prefix
"M-h" = "select-pane -L"
"M-x" = "none"
```

`tim --keys` lists every binding, tmux-style, and reports problems in either file.

## Environment

| Variable | |
|---|---|
| `HARNESS_TUI_DESK=read` | show the desk's tabs, never change them |
| `HARNESS_TUI_DESK=off` | keep tabs to this window |
| `HARNESS_TUI_PREDICT` | `off` / `always` (see Speed) |
| `HARNESS_TUI_BIN` | the binary `harness tui` runs |
| `PORT` | the daemon's port (default 18473) |

## Building

```bash
cd tui && cargo build --release        # target/release/harness-tui
cargo test
```

`harness tui` finds a dev build in `tui/target/` on its own. Releases are built by
`.github/workflows/release-tui.yml` — static binaries for macOS (arm64, x64) and Linux (x64,
arm64, musl) with a checksummed manifest that `harness tui --install` verifies.

## Layout of the code

| File | |
|---|---|
| `daemon.rs` | the loopback WebSocket per machine, requests, pushed frames |
| `proto.rs` | `HTRL` terminal frames (mirrors `cli/src/lib/terminalBinary.ts`) |
| `pane.rs` | one tile: `alacritty_terminal` grid, key/mouse encoding, selection, find, local echo |
| `app.rs` | all state: machines, streams, tabs, desk sync |
| `fleet.rs` | machines and harnesses, kept live from the daemon's frames |
| `input.rs` | keys, mouse, the launcher's modes and actions |
| `modal.rs` / `picker.rs` | the launcher's rows and its fzf matching (nucleo) |
| `ui.rs` | drawing |
| `layout.rs` | the split tree |
