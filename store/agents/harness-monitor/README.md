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
| **paused** | pane, scrollback and conversation intact, engine gone. Waking resumes the conversation |
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

Two views over the same fleet, one selection between them.

**Lanes** is the picture: one lane per project, oldest work on the left, *now* hard against the right edge,
on a log scale so the useful hours are visible instead of squeezed. Running chips glow, working chips
breathe, paused chips are outlined, a chip waiting on you rings amber. Two vertical lines are the policy —
**drag one** and the count updates as you move it: *would pause 58, handing back 13.7 GB*.
Save it and it is written to `~/.config/harness/policy.jsonc`, comments intact. A threshold you cannot see the effect of is a threshold nobody
should run.

**Table** is htop: fixed columns, tabular numerals, a memory bar behind the number, sortable headers,
`j`/`k` to move, `space` to select, `p` to pause, `r` to resume, `i` to pin, `/` to
filter. The footer shows what is selected and what the policy would do.

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
- **Pausing** arms `remain-on-exit` on the pane, then SIGTERMs the engine and waits. No SIGKILL unless you
  ask. The pane survives either as a dead pane holding its scrollback or as the fallback shell Harness's
  own launch wrapper hands it.
- **Waking** types that engine's resume command into the pane — `claude --resume <id>`, `codex resume
  <id>` — and the daemon's adoption loop rebinds the row. It deliberately does **not** use the daemon's
  `agent_restart`: when an engine exits, the daemon rewrites the row as a *terminal*, so restarting it
  gives you a fresh shell, which is exactly what happened the first time this was tried.
- **The ticket.** That same rewrite clears the row's `sessionId`, `transcriptPath` and `title` — measured,
  not assumed. So `pause` writes what it needs to come back (engine, session id, pane, title) into
  `~/.harness/monitor/paused.json` before it reports success. That file is the only record a paused harness has, which is why
  it is worth keeping; if you lose it, a paused harness is still resumable by hand with
  `claude --resume <id>` from its own transcript.
- **Other machines** are listed through the same bridge and marked as remote. Pane facts, memory and every
  action are local to this computer — a fleet manager that guesses about a machine it cannot see is not one.

## Develop and verify

```sh
npm test --prefix store/agents/harness-monitor      # 109 tests, no network, no daemon, no tmux required
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
