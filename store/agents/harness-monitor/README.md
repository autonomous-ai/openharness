# Harness Monitor, as a Harness agent

**htop for your agents.** Every harness on this machine — and every machine linked to it — in one dense
list: running, paused, idle since Tuesday, what each is holding. A policy you can drag until the numbers
look right. And one keystroke to pause an idle harness or resume it with its conversation intact.

It exists because of a specific way a fleet of long-lived sessions goes wrong. In Harness nobody kills a
session: you close the pane, the agent keeps running, and you resume whenever. That is the best thing
about it, and it is why there are eighty of them, most untouched for days, holding tens of gigabytes. The
fix is not to start killing them. It is to make idleness free.

## Paused is not stopped

| state | what it is |
|---|---|
| **running** | the engine process is running — an ordinary Harness agent |
| **paused** | engine gone, conversation saved. Resume brings it back in a new pane |
| **terminal** | a shell somebody opened. Nothing to pause |
| **gone** | no pane left; the daemon dropped it. History only |

Pausing a harness on this machine handed back 257 MB and kept everything else: same pane, same
scrollback, same agent id, and `claude --resume` put the conversation back thirteen seconds later.

## Install and open

Choose **Harness Monitor** in the Harness Store, or install this checkout:

```sh
harness dsh install "$PWD/store/agents/harness-monitor" --link
harness dsh doctor autonomous/harness-monitor
```

Open Harness Monitor in a new folder and ask: *"Show me the fleet, then pause everything nobody has touched since
Tuesday."* It installs nothing — no service, no database, no daemon of its own. Everything it knows comes
from the daemon Harness already runs, the tmux server it already uses, and one `ps`.

## From a terminal

`hps` is the agent's toolchain and yours. Every command takes `--json`.

```
hps                          the list, freshest first (like `docker ps`)
hps [--all] [--idle 4h] [--project X] [--state paused] [--sort mem] [--watch] [--machines]
hps show <ref>               one harness in full, with the last lines on its pane
hps pause <ref…>             the engine exits; pane, scrollback and conversation stay
hps resume <ref…>            the engine comes back where it left off
hps pause --policy [--apply] what the rules would do, and why. Dry run unless --apply
hps resume --paused          everything paused, back in one line
hps attach <ref>             hand this terminal to that pane
```

`<ref>` is a row number from the last `ls`, a `%pane`, an agent-id prefix, or part of a name — the same
grammar the shell gives you for jobs.

```
 #    IDLE  ENGINE   MODEL              MEM  PROJECT              BRANCH         TITLE
 1 ◐  now   claude   opus-5           517MB  widgets              main           Fix the reconciler
 2 ●  41m   codex    gpt-6-astra      194MB  widgets              main           Plan the migration
 3 ○  3d    claude   —                    —  old-spike            spike          Try the other approach

85 harnesses · 21 running · 63 paused · 25.2 GB held · 61 projects
policy: pause after 1d · hide after 14d · ceiling 100 running
```

## The pane

Built to feel like Activity Monitor with htop's density. It opens populated, updates live, and holds rows
still while the pointer is over them, so a refresh never moves what you're about to click.

- **Toolbar.** Scopes — **All · Running · Paused · Waiting** — with counts; **This machine / All machines**
  (this machine by default, since that is where Pause and Resume work); search; and **Pause**, **Resume**
  and **Inspect**, which act on the selection. Pause is offered only where it would actually happen: a
  harness that is waiting on you, mid-turn, open in a window or pinned says why instead.
- **Meters.** Running against the ceiling, what the engines hold against the machine's memory, and what the
  policy would do now — *"pause after 1d · 7 due, 1.9 GB"* — with **Review**: a dialog listing each one
  with its reason and memory, all ticked, and one button, *Pause 7*.
- **Table.** Status, name, project, engine, model, memory, CPU, idle (since the last real turn) and age;
  sortable; machine appears when there is more than one. Double-click or ⏎ opens the **inspector**: every
  fact, what the policy thinks and why, how it would come back, and the last lines on its pane.
- **Timeline.** One lane per project on a log time axis, *now* at the right. The two lines are the policy
  — **drag one** to see what it would pause, then save it into `policy.jsonc` with comments intact.

Keys: `j`/`k` or arrows to move, `space` to select more, `⏎` to inspect, `p` pause, `r` resume, `/` search,
`1`/`2` for the two views. Deep links open it on one harness: `?inspect=<agent id>`, `?scope=paused`,
`?view=lanes`, `?review=1`.

## The rules

One file per machine, next to your keybindings: **`~/.config/harness/policy.jsonc`** (`$XDG_CONFIG_HOME`
respected). It's written the first time Harness Monitor runs, it's commented, and it's read on every refresh
— save it and the pane redraws within seconds. The two lines in the pane edit the same file in place, keeping
your comments.

```jsonc
{
  "runningCeiling": 100,           // most engines running at once — a backstop; past it, the least recently used pause
  "pauseAfterIdle": "1d",          // untouched this long (since the last real turn) and it pauses
  "hideAfterIdle": "14d",          // drops out of the default list; still there under --all
  "pauseWhenWorkspaceGone": true,  // its folder is gone, so nothing can happen there
  "protect": {
    "needsInput": true,            // it looks like it is waiting on you
    "working": true,               // mid-turn
    "attached": true,              // someone is looking at that pane
    "pinned": true                 // listed in "pins"
  },
  "pins": []                       // agent ids the rules never pause
}
```

Preview any change without moving anything: `hps pause --policy`. It prints one line per harness with the
reason, and the totals, and changes nothing until `--apply`.

**Why these numbers.** A day, because a day survives an overnight break — the first default was 4h, and on a
real fleet the only thing 4h caught that a day didn't was eight harnesses from the previous afternoon. The
ceiling is 100 because it's a backstop, not a working limit: the idle rule does the everyday work, and the
ceiling only matters on a machine that swaps — lower it there, dividing free memory by ~300 MB.

The resume tickets — which conversation each paused harness had — live in `~/.harness/monitor/paused.json`,
and every pause and resume is logged to `~/.harness/monitor/log.jsonl` with the rule that caused it.

## What it will not do

There is no verb here that deletes an agent, kills a tmux session or touches a transcript. Pause, resume,
and resume are both reversible, and that is what makes it safe to point at eighty live sessions
and act on all of them at once: the worst outcome of a wrong call is a few seconds of cold start. The
irreversible verbs already exist in the app, behind their own confirmation, which is where they belong.

Harness Monitor also refuses to pause what it could not resume: an engine with no known resume flag, or an agent
whose session the daemon has not bound yet, stays running.

## How it works

- **Reading.** `agents_list` over the daemon's loopback bridge (`ws://127.0.0.1:18473/api/local-ws`) for
  who the agents are and where their panes are; one `tmux list-panes -a` for pane liveness, attachment and
  last output; one `ps` walked per pane for memory and CPU; `~/.harness/cli/data/registry.json` (read
  only) for transcript paths and hook timestamps. With no daemon answering it falls back to the registry
  alone and says so in the header.
- **Idle** is time since the last *turn*, read from the tail of the engine's own transcript. Not the
  file's mtime and not the registry's `updatedAt` — both of those say "now" for conversations nobody has
  touched in days. [`skills/fleet-operations/references/signals.md`](skills/fleet-operations/references/signals.md)
  has the measurements.
- **Pausing** sends the engine SIGTERM — never Ctrl-C, which only cancels a turn — and waits for it to exit
  (SIGKILL only with `--force`). The daemon then saves the harness: conversation id, folder, profile and
  permissions, listed as `stopped` under the same id. Once it has, the empty shell the engine left behind is
  closed, so a pause never leaves a stray Terminal tile. Only Claude Code and Codex are paused, since those
  are what the daemon can bring back, and only once a conversation is bound.
- **Resuming** is the daemon's `agent_resume`, with a receipt so a double click or a lost reply can never
  start two engines. It relaunches the engine with its own resume command and the settings it was created
  with, in a new pane, under the same id. A resume the daemon started but hasn't confirmed is reported as
  exactly that, never as success.
- **Harnesses paused before the daemon could save them** (a daemon without `agent_resume`) come back the old
  way: their conversation id is kept in `~/.harness/monitor/paused.json`, and resume types
  `claude --resume <id>` into the pane they left. `agent_resume` is deliberately not used for those — it would
  find their leftover shell and report success.
- **Other machines** are listed through the same bridge. Pane facts and memory are local to this computer, so
  another machine's harness is paused and resumed by that machine's own daemon: Pause sends its Stop
  (`agent_delete`), which saves the conversation before it touches anything, and Resume sends `agent_resume`.
  That Stop deletes on a daemon older than `agent_resume`, so it is only sent to a machine that answered the
  probe; any other machine's rows stay read-only and say to update Harness there. The policy on this machine
  never pauses another machine's harness — each machine has its own `policy.jsonc`.

## Develop and verify

```sh
npm test --prefix store/agents/harness-monitor      # 133 tests, hermetic; three render the pane in headless Chrome
harness dsh check "$PWD/store/agents/harness-monitor"

# The pane against any workspace; the port is printed.
HARNESS_WORKSPACE=/path/to/workspace store/agents/harness-monitor/viewer.sh
```

The suite covers the rules, the scale the Lanes view draws with, the pane/process readers, the transcript
reader, every guard in front of pause and resume, the loopback server's refusals, and a drift guard that
compares the resume table against the daemon's own source when the two are checked out together.

One thing the tests cannot cover: the pane has been exercised through its server and its markup, not in a
browser. The round trip it describes — pause, then resume with the conversation intact — was verified against
a live Claude Code session end to end.

## Credit and stewardship

Built by Autonomous for Harness, MIT. It reads and drives the daemon, tmux server and engines Harness
already runs, and adds no service of its own. Issues with how the daemon records, stops or resumes an
agent belong in the Harness CLI; the rules, `hps` and the pane belong here.
