# The rules, their defaults, and the argument for each

`~/.config/harness/policy.jsonc`, one per machine. Change one at a time, and simulate before believing.

## `runningCeiling` — default 100

The most engines running at once on this machine. When more than that survive the idle rules, the least
recently active are paused until the count fits. Protected rows hold a slot but are never paused.

**Why it matters most:** every other rule is a reaction to time passing; this one is a bound. It makes the
steady state independent of how many harnesses get created, the way `ulimit` bounds a process. A person
who creates six harnesses a day and pauses none still ends the month under the ceiling.

**The default is 100, which makes it a backstop.** On a normal day the idle rule does all the work and the
ceiling never fires. **When it is wrong:** a laptop under memory pressure wants something like 12. Set it to
what the machine can hold without swapping — free memory divided by ~300 MB — not to what feels tidy.

## `pauseAfterIdle` — default `1d`

Idle this long and a running engine is paused. A day, because a day survives an overnight break: yesterday
afternoon's work is still warm in the morning. The first default was 4h; on a real fleet the only thing it
caught that a day does not was eight harnesses from the previous afternoon.

**When it is wrong:** an agent on a long autonomous run that produces no turns for hours would be paused
mid-thought if the `working` guard somehow missed it — pin those. Someone who works in short bursts across
a whole day may prefer `8h`; someone on a small machine, `1h`.

## `hideAfterIdle` — default `14d`

Idle this long and the row drops below the fold: out of the default list, one `--all` (or the pane's **show
all**) away, still resumable. Two weeks is past "I'll get back to it" for anything unpinned.

**This is a list rule, not a state.** An earlier version made it a `retire` verb with its own state, mark
and thirty-day grace window, and it earned none of that: hiding is what a sorted list does, and
`systemctl disable` — the analogy used to justify it — exists because a service would otherwise auto-start
at boot. Nothing auto-starts a harness.

**Never shorter than `pauseAfterIdle`.** A row cannot drop out of the list before it is even paused; the
policy refuses to load if it is.

## `pauseWhenWorkspaceGone` — default `true`

A harness whose working folder no longer exists has no work left in it. The cheapest correct rule in the
file, and the only one that fires on a fact rather than a duration.

## `protect` — the guards

`needsInput`, `working`, `attached`, `pinned` default to on, and each refuses an action with its own
reason. There is deliberately no `projects` list any more: it was a second mechanism for the same job as
`pin`, and that is how a config file gets fat.

## What the rules deliberately do not do

- **No git.** "Its branch already merged" is a good reason to pause and a bad thing to put in a rule that
  runs every four seconds against sixty repositories. The agent does that check on request, and names the
  branch in `--reason`.
- **No deleting.** There is no rule, and no flag, that removes an agent. See the skill's last section.
- **No remote actions.** Other machines are listed, never acted on: pane facts and signals are local, and
  a fleet manager that guesses at a machine it cannot see is not one.
