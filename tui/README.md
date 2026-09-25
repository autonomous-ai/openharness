# harness tui

All of Harness in a terminal — every harness on every machine, in tabs and panes, from any
terminal you can type into: a laptop, a server over SSH, a tablet's SSH app.

```bash
harness tui
```

It is a **client of the same daemon the desktop app uses**. Nothing runs inside it: the agents
live in the daemon's tmux on their own machines, and each pane is a live stream of one of them.
Close it, lose the connection, reopen it anywhere — everything is where you left it, because
your tabs are the account's **desk**, the same tabs the desktop and the phone show.

On a fresh server `harness tui` signs in (over SSH the login prints a URL and takes the pasted
callback), starts the daemon, then opens.

## Keys

`⌥` is Option/Alt. In terminals that speak the kitty keyboard protocol (kitty, Ghostty, WezTerm,
foot, recent iTerm2) `⌘` works wherever `⌥` is shown. `^Space` followed by the key without `⌥`
works in every terminal, including ones where `⌥` types accented letters.

| Keys | |
|---|---|
| `⌥P` | the launcher: every harness on every machine |
| `⌥⇧P` / `>` | commands |
| `⌥O` / `#` | projects, then one of their harnesses |
| `⌥I` / `:` | models — switch the focused harness's model and effort; start, stop or get local models |
| `⌥M` / `@` | machines (with each one's round trip), then one of their harnesses (`^L` links one) |
| `⌥S` / `*` | the Harness Store |
| `?` | what the launcher can do |
| `⌥⇧I` | agents needing input — `⌥1…9` answers without opening the pane |
| `⌥A` | jump to the next harness waiting on you (oldest question first) |
| `` ⌥` `` | back to the tab you were on |
| `⌥N` / `⌥⇧T` | new harness / new terminal |
| `⌥T` `⌥1…9` `⌥{` `⌥}` `⌥⇧R` `⌥⇧W` | new, go to, previous/next, rename, close tab |
| `⌥\` `⌥-` `⌥h/j/k/l` `⌥H/J/K/L` `⌥Z` `⌥W` `⌥L` `⌥=` | split right/down, focus, grow, zoom, close, layout, equalize |
| `⌥⇧F` | find in the pane's history |
| `⌥V` (or `^Space [`) | copy mode — `hjkl` `w` `b` `0` `$` `g` `G`, `v`/`V` select, `y` copy, `/` find, `q` leave |
| `⌥B` | send a task — Harness picks the harness |
| `⌥Q` | quit (harnesses keep running) |

Inside the launcher: type to filter (fzf matching), `↑/↓` or `^P/^N`, `enter` open, `^T` new tab,
`^V`/`^S` split right/down, `^R` replace this pane, `tab` cycle all / needs input / running /
paused, `^X` pause or resume, `esc` back out of a machine or project, then close.

**macOS terminals send ⌥ as a symbol by default** (⌥P types π). Either press `^Space` then the
key, or make ⌥ a Meta key once: iTerm2 → Profiles → Keys → Left Option key: *Esc+*; Terminal.app →
Settings → Profiles → Keyboard → *Use Option as Meta key*; Ghostty → `macos-option-as-alt = true`;
kitty → `macos_option_as_alt yes`; WezTerm → `send_composed_key_when_left_alt_is_pressed = false`.

`⌥⏎`, `⌥←/→`, `⌥B`, `⌥F`, `⌥D` and the other chords a shell's line editor relies on are left to
the pane. `⇧⏎` reaches the pane as a newline, the way the desktop sends it.

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

`~/.config/harness/tui.toml` (or `$XDG_CONFIG_HOME/harness/tui.toml`):

```toml
prefix = "ctrl+a"          # instead of ctrl+space
desk = "sync"              # sync | read | off
predict = "auto"           # auto | always | off
notify = true              # OS notifications through the terminal

[keys]
"alt+h" = "none"           # give ⌥h back to the pane (vim, readline…)
"alt+x" = "close-pane"
"super+k" = "palette"
```

`harness tui --keys` lists every command a key can run, and reports problems in the file.

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
