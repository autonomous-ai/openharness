# The app

What the window does, pane by pane. The keys are in [keyboard.md](keyboard.md).

## Sessions

A harness is one session: one engine process, the agent, in one tmux pane on one machine. A tab
holds any number of panes, from any mix of machines; the app remembers tabs, pane placement, sizes,
pinned slots, focus and zoom across restarts, in `~/.harness/desktop-app-v2/state.json`.

**New Harness (⌘N)** asks for four things: the machine, the working folder, the engine, and,
under Advanced, two settings most people never touch. The folder picker is the native panel on this
computer and a remote directory list on any other machine, served over the daemon's `fs_list_dir`.
**Clone repository** clones a GitHub URL into a parent folder first. The engine row shows every engine
the machine has, probes availability live, and marks the ones the daemon would install on first
launch. Advanced holds the engine's permission-bypass flag (`--dangerously-skip-permissions`,
`--dangerously-bypass-approvals-and-sandbox`, `--force`, `--auto`, whichever the engine has) and,
for Codex, a profile: a `CODEX_HOME` folder to launch under instead of `~/.codex`, each with its own
hooks.

Creation carries a receipt. If the reply is lost, the button turns into **Check status** rather than
creating a second session.

Closing a pane is a view operation; the agent keeps running. **Stop Harness** ends the engine process
and asks first. **Restart Harness** relaunches it in the same pane with the same id, resuming the
conversation where the engine supports it.

**Open Harness (⌘O)** is the search: harnesses, tabs, projects, machines, history and commands, fuzzy
matched, with a session preview on the right built from cached recent turns. Type `>` for commands
only (also ⇧⌘P).

In the **Harness Store**, installed tools offer **Resume Harness** and **New Harness**.
Resume returns to the existing harness, including one on another machine. With one matching harness
it opens directly; with several, a dropdown shows each harness's name, machine and project. Recent
visits appear first. An open tab is focused; a closed tab is reopened around the same running agent.
New Harness always opens the creation dialog for separate work. This works the same way for coding
agents, creative tools and managers. Tools not yet installed offer **Get** first.

## Panes and layouts

Hover the right or bottom edge of a pane for a split control, or ⌘R and ⌘D to split right and down;
both open the same picker at that position. Drag a pane's header onto another pane to swap them.
Resize grips live in the gaps and appear on hover or keyboard focus; sizes are remembered per pane
count.

**Layout (⌘S)** opens a palette of drawn shapes rather than names: Split, Columns, Rows, Main
left/right/top/bottom, Grid, 2 to 5 columns, Middle + sides, Two over three, Auto. Press ⌘S again to
cycle, a digit to pick directly, Enter to apply. A pinned pane keeps its slot when other panes close
around it.

## Terminal

The renderer is a vendored, patched [xterm](desktop/third_party/xterm). Each pane has its own find bar
(⌘F). ⌘-click opens links; an image or video path in the output opens in a preview, downloaded from
the remote machine over the existing encrypted connection with progress and cancel (up to 512 MiB).
Paste or drop an image onto a pane to send it to the agent. On a remote machine a composer box under
the pane batches a message instead of paying a round trip per keystroke. Scrollback is restored from
the daemon's snapshots on attach, resize, zoom and reconnect. Font, size (⌘0, ⌘+, ⌘-), terminal
colours and six app palettes are in Settings.

## Attention, models, usage

When an agent asks a question the pane gets an amber ring, the titlebar bell lights, and ⇧⌘I lists
every agent waiting on you. Answers go back into the engine's own dialog; there is no side channel.

The **Models** menu shows each engine's subscription usage window, refreshed once a minute, for local
and remote machines alike. Settings ▸ Usage is a separate token ledger read from Claude's and Codex's
transcripts and OpenCode's database, off per provider until you switch it on.

## Machines

The app talks to the daemon on this computer over a loopback socket and never dials the relay itself.
Other machines are reached through that daemon: it links to them with a per-machine remote password,
terminates the encryption locally, and hands the app plaintext. Machines ▸ Link Machine… runs the
link flow; the CLI equivalent is under [The daemon and CLI](#the-daemon-and-cli).
