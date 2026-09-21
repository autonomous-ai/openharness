# The signals, and which ones lie

Every column in `hps` comes from somewhere, and three of the obvious sources are wrong in ways that
would pause a working agent or keep a dead one running. This is the reference for explaining a number.

## idle — time since the last turn

**Source:** the tail of the engine's own transcript, newest line first, stopping at the first line that is
a real turn (Claude Code's `user` / `assistant`, a Codex rollout's `message`). Falls back to the daemon's
`lastHookAt` when a transcript has no turn in its tail, and to the registration time when there is none.

**What it is not, and why:**

| Tempting source | Why it lies |
|---|---|
| the registry's `updatedAt` | the daemon reconciles every five seconds; every row reads "now" |
| the transcript's mtime | a *running* engine appends bookkeeping — task notifications, away summaries, queue operations — to conversations nobody has touched in days. Measured on one real machine: 34 of 85 harnesses looked an hour old when only 5 were |
| the pane's tmux activity | a spinner redraw is activity, and an engine that exited hours ago leaves its last frame on screen forever |

Output is not a turn. If someone points at recent output on a row that reads `3d`, that is the whole
explanation, and the row is right.

## mem — what pausing would hand back

The engine's whole process subtree, resident. Say "held", not "used": resident sets share pages, so a sum
across rows is an upper bound, not an exact figure. It is still the right number for the decision, because
the decision is comparative.

## state — running, paused, shell, gone

Decided in one place (`lib/inventory.mjs`) from two facts: is the pane still in tmux, and is an engine
process running under it. `paused` is the daemon's own "dormant but still viewable agent" — a state
Harness already has, not one Harness Monitor invented.

## working — do not pause this

CPU on the engine subtree above 5%, or a turn in the last 90 seconds, or output drawn in the last 60. All
proxies, and all used only to *refuse* an action, never to claim in the interface that an agent is busy.

## waiting on you — a dialog, and labelled as a guess

Read from the pane's last screen, and it means a **dialog**: a cursor on one option of a menu, "Enter to
confirm · Esc to cancel", a y/n, a permission prompt, a folder-trust question. Two things are deliberately
*not* counted: a last line ending in "?" (an agent that asks a question in prose has finished its turn) and a
line starting "1." (an agent's answer is full of numbered lists). Both once made the count read 11 on a fleet
with one open dialog. The app's own **Agents needing input** (⇧⌘I) is the authority.

## Where each fact comes from

| Fact | Source |
|---|---|
| who the agents are, their panes, engines, models, projects, branches | the daemon, over `ws://127.0.0.1:18473/api/local-ws` (`agents_list`) |
| transcript paths, hook timestamps | `~/.harness/cli/data/registry.json`, read only |
| pane alive / dead / attached, last output | one `tmux list-panes -a` |
| memory, CPU, process count | one `ps` snapshot, walked per pane |
| the policy and pins | `~/.config/harness/policy.jsonc` |
| resume tickets, the log | `~/.harness/monitor/` |

Other machines answer `agents_list` through the same bridge, so they appear in the list. Pane facts and
memory are local to this computer; pause and resume on another machine go through that machine's own
daemon, and only when it can save a harness for resuming — otherwise the row says to update Harness there.
