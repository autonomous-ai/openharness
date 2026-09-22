---
name: fleet-operations
description: Run a fleet of long-lived coding-agent sessions — list them, pause idle ones without losing their conversations, resume them where they left off, and tune the policy that decides. Use when someone has many Harness harnesses, wants to know which are actually running, wants memory back from idle agents, asks what to clean up, or asks whether a pause threshold is any good.
---

# Fleet operations

A fleet of long-lived agent sessions goes wrong in one specific way: nothing ever ends. Sessions are
never killed — that is the point of them — so they accumulate until the list is useless and the machine
is full. This skill is how to fix that without breaking the promise that made people keep them.

## The one idea

**Separate the conversation from the process.** A conversation lives in a transcript and can be resumed;
a process holds memory and can be stopped. Pausing stops the process and keeps everything else. Once
pausing is free and resuming is reliable, an idle harness costs nothing, and "should I kill this?" stops
being a question anybody has to answer.

Everything else follows from that:

- **A ceiling, not a cleanup.** `runningCeiling` caps how many engines are running at once; the least
  recently active get paused when a new one passes the cap. This is the rule that bounds the steady state
  no matter how many harnesses get created — the one worth defending in an argument.
- **Idle thresholds, not idle shaming.** `pauseAfterIdle` (default 1d — survives an overnight break) and
  `hideAfterIdle` (default 14d, a list rule) are both reversible, so they can be aggressive.
- **A grace window, not a delete.** Retired rows are forgotten from the hps after
  `forgetAfterRetired` (30d), and forgetting is bookkeeping: transcripts belong to the engines.
- **Pins beat rules.** A pinned harness is never paused by policy, whatever the numbers say.

## Reading the fleet

Always start from data: `"$HPS_CLI" ls --json`. The fields that matter and their traps are in
[references/signals.md](references/signals.md) — read it before you explain an `idle` number to anyone,
because the three obvious sources for it are all wrong and one of them is wrong by days.

A good first report is four numbers and one sentence: how many harnesses, how many running, how much memory
held, how many idle past the pause threshold — then what you propose. Not a table of eighty rows.

## Acting

| Situation | Do this |
|---|---|
| One or two named harnesses | act, then show the receipt line |
| More than two | dry run → show the plan with a reason per row → ask → `--apply` |
| "Pause everything but X" | add X's id to `pins` in `~/.config/harness/policy.jsonc`, then `hps pause --policy --apply` |
| A guard refused | name the guard, leave it, offer `--force` as their choice, never yours |
| They want a threshold judged | set it in `~/.config/harness/policy.jsonc`, run `hps pause --policy`, report what it would do to *their* fleet |
| They want it gone for good | Harness Monitor does not delete. Point at the app's Stop Harness, which asks first |

Receipts are not decoration. Every action is appended to `.harness/monitor-log.jsonl` with its reason, and
"why is this paused?" must always have an answer that is not a guess.

## Tuning the policy

The rules live in `~/.config/harness/policy.jsonc` as data, so they can be simulated before they are believed —
[references/policy.md](references/policy.md) has each rule, its default, the argument for that default,
and what makes it wrong for someone. Two habits:

1. **Never change a threshold without simulating it.** Edit `pauseAfterIdle` in `~/.config/harness/policy.jsonc`, then
   `hps pause --policy` reads back exactly which harnesses would move, and why, without moving any.
2. **Change one rule at a time.** Two thresholds moving at once makes the result unattributable, and the
   person is trying to build an intuition, not just a config.

## The boundary, and why it holds

Harness Monitor can pause and resume. It cannot delete an agent, kill a tmux session or
touch a transcript. That is what makes it safe to point at eighty live sessions and act on all of them in
one command — the worst outcome of a wrong decision is a few seconds of cold start. Do not work around
it, and do not build a workaround for someone who asks: the app already has the irreversible verbs,
behind their own confirmation, which is where they belong.
