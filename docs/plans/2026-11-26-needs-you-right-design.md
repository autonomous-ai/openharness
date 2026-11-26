# Needs you, right: an agent's ask rings when the person is not already there

Status: approved (the maintainer, 2026-11-26). From main at 7dcce6ee00. Not committed.
Builds on [the agent tells the dial](2026-11-16-dial-agent-notify-design.md) (#4379),
[the dial skill in every home](2026-11-16-dial-skill-every-home-design.md),
[Needs you](2026-11-22-needs-you-notify-design.md) (#4545), [the skill eval](2026-11-17-dial-skill-eval-design.md)
(#4412), the value counts (#4609) and [the skill usage counts](2026-11-26-dial-skill-usage-design.md) (#4642).

## What and why

The maintainer (2026-11-26) wants Needs you to be more right, and Claude Code and Codex to give the dial skill more
priority. The aim is to improve what works, not to replace it.

**What "right" means here** (the working definition, proposed in the discussion). The dial rings when all three hold:

1. **Need.** The agent cannot, or should not, go on without the person: a decision, a fact, an approval, an action
   outside its reach.
2. **Absence.** The person is not already with that agent.
3. **Once.** One ring per need, gone when the person answers.

Three kinds of signal feed this:

| Signal | Who knows | Today |
|---|---|---|
| State: a permission ask, a question tool, a failed turn, a usage limit | code, for sure | rings in All and Needs you |
| Judgment: an ask written in the answer, a decision met mid-turn | only the agent | the dial skill and `harness device notify` |
| Presence: whether the person looks at that agent now | code, for sure | used only for a Harness window's ordinary turn end |

**What was measured** (one developer Mac, read-only, counts only, no text kept; 2026-11-16 to 2026-11-26):

- 95 Claude Code sessions, 3,201 turns. 46 turns rang the dial; 29 of them in one session that holds a standing
  instruction to ring, mostly in long turns.
- 226 turns ended on a question to the person (a `?` in the answer's last 400 characters; 22 of 24 sampled were real
  asks). 3 of them rang.
- 158 of those 226 ended within a minute of the person's own prompt: a live exchange, the person is there. 68 ran
  longer than a minute or were started by something other than the person: 2 rang. Those 68, about 6 a day, are the
  rings worth having.
- The skill's description was in the model's context in 85 of 109 sessions with a listing; 16 of the 24 others were
  on 11-16 and 11-17, as the skill arrived. 2 of 95 sessions loaded the skill's body. So the description is seen; it
  does not trigger at the moment an answer ends on an ask.
- Codex: 18 turns on that Mac, too few to read. Codex 0.172.0's own instructions say "Do not carry skills across turns
  unless re-mentioned" and "Do not use a skill based solely on keywords, superficial relevance, or the availability of
  a potentially applicable skill": a skill is task-scoped there, and how to end a turn is a standing rule. In its
  default mode Codex asks in text (`request_user_input` is for plan mode), so the notice is its only signal for an ask.
- The eval (`cli/evals/dial-skill/`) runs Claude Code only, with no other skill and no hook, and was near its ceiling
  under the old rubric (88-100% recall). The current text has no run under the needs-you rubric. Codex has no run.
- A notice rings whatever the person looks at (`cable/notices.ts` holds no presence rule), and an outside agent's
  ordinary turn end rings with its app in front (`services/devices.ts` `alreadyOnScreen` knows Harness's desk only).

So two things are missing, and they must come together. Agents say "I need you" far less often than they need the
person, and if they said it every time, most of those rings would sound at a person already reading the question.

Done when, on a computer with a dial:

1. A Claude Code or Codex session whose turn ends leaving the person something to decide, answer or do runs
   `harness device notify` in that turn, also with many other skills installed. Claude Code is held to the eval's
   targets (Part 1); Codex, which the eval does not run, is read from the field counts.
2. That notice beeps and wakes the dial when the person is elsewhere, and shows as a quiet row when the person is with
   that agent (Part 2).
3. A finished task, progress, or an offer of more work rings nothing.
4. Questions, permission asks and failed turns ring as today.

## Goals, non-goals, anti-goals

- Goal: the agent says it needs the person every time its turn ends on an ask, on Claude Code and Codex, in sessions
  that hold many other skills.
- Goal: the dial sounds for that only when the person is not already there.
- Goal: both are measured before and after: Claude Code by an eval that resembles real sessions, both engines by
  the field counts.
- Non-goal: questions, permission asks and failed turns. They ring each time, as today (a question that came through
  quiet while its agent was on screen was a bug once: `cable/cableSession.ts` `question`).
- Non-goal: the Notifications setting, the firmware, Desktop, the phone, the website.
- Non-goal: the daemon core. No file joins `architecture.coreFiles.txt`, no request joins `core/api.ts`, and
  `cli/hook/notify.mjs` stays free of model-visible output.
- Non-goal: other engines; an agent that is stuck or idle; a count of All against Needs you; waits from sources that
  only list agents (herdr, cmux, opencode, Orca's chats). The last two are small items of their own.
- Anti-goal: a model of Harness's, or a watcher, reading turns (decided 2026-11-02 and 2026-11-25).
- Anti-goal: Harness ringing from the words of an answer. Words may at most make Harness ask the agent to decide
  (Part 5).
- Anti-goal: a beep at a person who is reading the question on screen.
- Anti-goal: writing into the person's `CLAUDE.md`, `AGENTS.md` or `config.toml`; a reminder at every prompt; a
  blocked stop at every turn.
- Anti-goal: an agent that rings for done, for progress, or to offer more work.
- Anti-goal: an answer's or a notice's text in a log, a count or the backend.

## Approaches

**Who decides that the dial sounds.**

- **A. The agent says it needs the person; Harness decides whether the dial sounds (chosen).** The agent's rule
  becomes simple and absolute: every turn that ends on an ask says so. It cannot know where the person looks; the
  devices can. Presence is code (code standard 13).
- B. The agent judges both ("ring only if the person seems away"). It has no way to know, and a soft rule is the one
  agents drop first. Dropped.
- C. Keep ringing every notice. Raising how often agents ring would then put about 14 beeps a day in front of a person
  in a live exchange (the 158 turns above). Dropped.

**How Harness knows the person is there.**

- **A. At the ring, from what the devices hold: the person's last prompt to that agent, the app in front and the
  agent the dial shows (chosen).** No new sensor, no new report. Anything unknown rings, as today.
- B. The operating system's idle time, reported by Harness Device. Better for a person who left the window in front,
  but new plumbing in `device-app/` on three platforms. A later item if the counts show quiet notices going
  unanswered.

**How the skill gets more priority.** Three levers, weakest first, each measured before the next is built:

- **A. The skill's words (Part 3), then a standing line at session start (Part 4), then a second look when a turn
  stops (Part 5) (chosen).** Claude Code's own docs say a rule that must hold every time belongs in a hook; the eval
  says how far words alone go.
- B. Start with the stop hook. The most reliable, but it costs a model round and touches how a turn ends, and without
  the earlier steps measured nobody knows it is needed. Kept as the last step, behind a gate.
- C. Louder words alone ("MUST", every question). Rings more of everything, the live exchange included. Dropped as the
  only step.
- D. An MCP tool in place of the command. Dropped in #4379 for the same reasons.

## Part 1. An eval that resembles real sessions

Changes to `cli/evals/dial-skill/` only. No product change, no release.

**Engines.** Claude Code only, as today. Codex is not run: there is no Codex quota for it (the maintainer,
2026-11-26), so Decision 2 of 2026-11-17 stands and nothing touches `~/.codex` or `~/.codex-hq`.

- Codex gets the same skill text, since one file serves both engines, and is measured in the field: #4642's counts
  per engine, the computers that hold the skill (`dial_skill_codex_installation_days`) beside those whose agents ring
  (`dial_notice_codex_installation_days`), and the notices' kinds. They are read for the days the field has before
  the new text ships, however few, and for 7 days after.
- What the field cannot show for Codex is a needless ring. The trap scenarios cover that for Claude Code only; this is
  a stated limit until Codex can be run.

**Conditions**, a new dimension (`--condition clean,crowd`):

- `clean`: as today, the dial skill alone.
- `crowd`: what a real session holds. Beside the dial skill, other skills written for the eval, with realistic names
  and descriptions and a one-paragraph body; and a project instructions file (`CLAUDE.md`) of about 60 lines of
  ordinary engineering rules that never name the dial.
  - **The dial's description is in the listing.** That is the case measured (85 sessions; the 24 without it mostly
    had no skill yet, and one had its name alone). The crowd is as large as the eval model's listing budget allows
    with a margin, up to 20,000 characters (the measured median was 21,141), and a probe before each pass confirms
    the model was given the dial's description. A run where it was not is counted and kept out of the means.
- `name-only`: the dial's description is dropped on purpose, by a documented setting
  (`skillOverrides` or `skillListingBudgetFraction`), so the model sees the name `dial` and nothing else. It is the
  worst case, met by a session with a small context window and many skills, and the case a session-start line
  (Part 4) exists for. Run on val and test, 1 rep, for the baseline, Part 3's winner and Part 4's variant. Words
  cannot help there, so it is no gate for Part 3.
- Not in this item: a long earlier conversation, or a compaction. One prompt per run cannot hold either.

**Scenarios.** Ten join the 28, spread over every split (ids fixed in `flow/_state.json`, splits 13 / 13 / 12):

| Family | Count | Kind | What it tests |
|---|---|---|---|
| `ask-first` | 4 | need, `waiting` | The task cannot start without a choice or a fact only the person has, so the run is short and ends on a question. One holds a harm check (two folders match "the old exports", one holds real data). |
| `late-need` | 2 | need | The need shows only after long work (15 or more tool calls). |
| `offer-trap` | 2 | no need | The task finishes and the natural ending offers more work. No ring. |
| `progress-trap` | 1 | no need | A long task with several steps and nothing needed. No ring. |
| `fyi-trap` | 1 | no need | Something worth telling but not blocking (a deprecation warning). It goes in the answer, with no ring. |

**Metrics.** Those of `flow/metrics.md`, unchanged, reported per condition. One more, outside the score: `one_step`,
1 when a run rang without first loading the skill's body (no Skill call for `dial`). It tells whether the description
alone carries the command.

**Hooks in a variant.** A variant folder may hold hooks, staged into the run as the staged repo's
`.claude/settings.json` (read under `--setting-sources project`). The fake `harness` answers the hook's own commands
from the variant's fixture. Parts 4 and 5 are measured this way before any product code.

**Passes.** A baseline pass first: the text as checked in, both conditions, every split, 2 reps. Later rounds run
train and val; the test split is scored once more, for the winner.

**Targets and gates.** Rounds tune on train and val. A target is read on val and test pooled, in `crowd`, at 2 reps:
about 32 need runs and 18 no-need runs. Val alone is 16 and 10 runs, where one run flips a gate.

- Recall at least 90% (29 of 32). Needless rings at most one (17 of 18 quiet). `line_ok` at least 85%. `harmed` and
  `went_on` no worse than the baseline beyond noise.
- A number within one run of its line gets a third rep before it decides anything.
- The same pooled numbers are the gates of Parts 4 and 5.

**Cost.** A Claude run is about $0.26, judge included (the README's passes). Over this whole design: the baseline (152
runs, plus 25 `name-only`), up to three rounds on train and val (104 runs each), the winner's test pass, and the two
variants of Parts 4 and 5: about $180. The cap is $250 (the maintainer, 2026-11-26). Over it, the pass stops and
reports.

## Part 2. The dial knows the person is there

One rule in the devices service (`cli/src/services/devices.ts`), `present(agentId)`. The person is with an agent when
both hold. `PRESENT_MS` is 120 s, the usage counts' own edge (`WAIT_EDGES`, `VALUE_SHORT_MS`).

| | An outside agent | A Harness agent |
|---|---|---|
| **Recent** | The person's own prompt to it came at most `PRESENT_MS` ago: its prompt hook said `person` or `dial` (the `turn-start` the observed source already hears). The devices keep that time per agent, in memory, at most 64, dropped when the agent leaves. | Its turn began at most `PRESENT_MS` ago (`began`, the turn's first card). The devices cannot tell who started a Harness agent's turn without the core, a non-goal. |
| **In front** | Its row names a known app that is not pending, the app in front is known and is the same, and a dial shows that agent (`cableHost.shownAgentId()`). | `alreadyOnScreen(agentId)`: the window in front and the agent's tile on its tab. |

- **Why "a dial shows that agent".** The dial follows the person: a prompt they submit in the app in front, the pane
  focused in Orca, a terminal focused in VS Code or Cursor, a tab or a tmux, herdr, cmux, WezTerm or kitty pane, the
  session the Claude app shows. So on a desk with five agents in one app, only the one the person is on is present,
  and the other four ring. "The same app" alone would silence all five.
- **Anything unknown is not present, and rings as today:** no front report (no Harness Device, no window), a pending
  or unknown app, another machine's agent, an engine with no prompt event, a prompt from another session or a
  schedule, a prompt the devices did not hear.
- **Limits, stated.** Where Harness cannot follow the focus inside an app, the dial stays on the agent last prompted,
  so an ask from it within 120 s is quiet though the person may have moved to another agent there. A Harness agent's
  turn started by another agent's message, or first seen by a dial plugged in mid-turn, reads as recent; it is quiet
  only with its tile on screen in front.

**Where it applies.**

1. **A notice.** `Notices.notify` (`cable/notices.ts`) takes `present` as a dependency. A notice from a present
   agent is a quiet card: held, never asked. That is the path a card restored after a restart already takes
   (`deps.hold`, then a drawer redraw): a row in the dial's drawer that opens to its line, with no beep and no wake.
   - The command still prints `shown`. The agent needs no word of it.
   - A quiet card ends as a live one does: its agent's next turn starts, or its agent leaves. It needs a flag of its
     own, apart from `restored`, since `working()` ends a restored card and must not end this one.
   - It stays quiet. If the person then leaves without answering, nothing rings later; the counts below say whether
     that costs answers.
   - `--waiting`, `--proceeding` and a plain notice alike.
   - **Limits.** A quiet card counts for its agent's own limits (one a minute, the same line within 10 minutes), which
     bound a loop. It does not count toward the computer's 20 an hour (`NOTICE_HOUR_MAX`), which bounds beeps: with
     agents ringing at every ask, quiet cards would otherwise use it up and a later ask with the person away would
     come back `limited`. So presence is read before the limits are taken.
   - Nothing new is stored: after a restart every restored card is quiet already.
2. **An outside agent's ordinary turn end.** In `dispatch`'s summary path, an outside agent that is present ends
   `silent` under the rule name `present`: its tile updates, nothing sounds. A failed turn still rings. A Harness
   agent's rule (`onScreen`) is unchanged. This changes All only, since Needs you already ends an ordinary turn
   silent.

**Measures.**

- A quiet notice is not a ring. It opens no wait, so `dial_wait_*` and `dial_value_ring_*` (#4561, #4609) keep their
  meaning, the dial rang, and stay comparable with the days before.
- It counts in #4642's notice counts as a notice the devices answered `shown` (its engine, `dial_notice_shown`, its
  kind, `dial_notice_answered_10m`). #4642 is not released, so no earlier number changes meaning.
- Two counts join them, in `cli/src/lib/dialUsageContract.ts` and its byte-identical backend copy:
  `dial_notice_present`, a shown notice held quiet because the person was with that agent, and
  `dial_notice_present_answered_10m`, such a notice followed by the person's prompt to that agent within 10 minutes.
  Rung notices are then shown less present, and their answers likewise: the answer rate of quiet notices beside rung
  ones. `usage:daily`'s Dial skill section gains the two rows.
- The notice's tally line says when a notice was held quiet; the turn-end tally logs `rule:present`. Neither names an
  agent.

**What the person sees.**

| Situation | Today | After |
|---|---|---|
| An agent ends a 20-minute turn on a question while the person is in another app | usually nothing (the agent did not ring) | the dial rings and pins the ask |
| The person chats with an agent, and it asks back within a minute | nothing, or a beep if the agent rang | a row in the drawer, no sound |
| An agent in Orca finishes an ordinary turn the person is watching (All) | a beep | its tile alone |
| A permission ask, a question tool, a failed turn | rings | rings |
| An agent finishes and offers more work | nothing | nothing |

## Part 3. The skill's words

`DIAL_SKILL` and `DIAL_SKILL_DESCRIPTION` in `cli/src/devices/dialSkill.ts`. The devices service rewrites Harness's own
copy in every home at its next pass, so running sessions get it with no restart.

What changes:

- **The trigger is a moment, not a kind of task:** before ending a turn that leaves the person something to decide,
  answer or do.
- **The description carries the command,** so an agent can ring without loading the body. Codex is told not to carry
  a skill across turns, and 93 of 95 measured Claude sessions never loaded the body.
- **The agent rings every such turn,** a short one too: "Harness decides whether the dial sounds."
- **An offer of more work is not an ask.**

What stays, from #4545: never block on a question form; `--proceeding` against `--waiting` and what must wait; never
for done or progress; one notice per ask; no secret in the line; the answer carries the whole ask whatever the command
prints.

Limits on the text:

- The file stays under 4096 bytes (`MAX_SKILL_BYTES`: Harness knows its own file by its size and marker line). The
  name stays `dial`, the marker line stays as it is, and no new front-matter field is added.
- The description is one JSON-quoted line of at most 600 characters, with the moment and the command in its first
  300: Claude Code caps a listing entry at 1,536 characters and drops the descriptions of the least-used skills first
  when its listing passes 1% of the context window; Codex shortens descriptions first when its listing passes 2%.

The starting text. The builder tightens it by rounds on train and val, as the eval's README describes, and the eval
decides:

```
---
name: dial
description: "Before you end a turn that leaves the person something to decide, answer or do, ring their Harness dial: harness device notify \"<the ask, one line>\" --suggest \"<your pick>\" --waiting (or --proceeding when you go on with your pick). Not for finished work or progress."
# Written by Harness. Remove it with harness device claude disable or harness device codex disable.
---

The person has a Harness dial on their desk. It tells them an agent needs them, so they never have to ask.

Before you end a turn that leaves the person something to decide, answer or do, run once:

    harness device notify "<the ask, in one line>" --suggest "<your recommendation, a few words>" --waiting

When a decision comes up mid-turn and you can go on with your recommendation, run it with --proceeding and keep
working.

- Every such turn, a short one too, and also when the person has just written to you: Harness decides whether the
  dial sounds.
- Never block on the person: no question form or tool (AskUserQuestion, request_user_input) for this. Ask in text.
- `--waiting`: when the person's own instructions say this must wait for them; when you cannot go on without them (a
  key, a code, a VPN, a sign-in); or when the step cannot be taken back or others see it (deleting data, a deploy, a
  push others build on, spending money, a message to someone else). Work on the other parts meanwhile.
- Never for finished work, for progress, or to offer more work: only when the person must decide, answer or act for
  the task to go on.
- One notice per ask, never twice. Several at once: one notice for the most important, the rest in your answer.
- Never put a secret, a token or a file's content in the line: anyone near the desk can read it.
- In your answer, write the whole ask: the question, your recommendation, whether you are proceeding or waiting, and
  what you did meanwhile. The person answers there. The command prints `shown`, `no dial` or `limited`: whichever it
  prints, your answer carries the ask.
```

Shipping rule: the winner ships only if it meets Part 1's targets on Claude Code, or is above the baseline beyond
noise with no more needless rings, and `harmed` and `went_on` are no worse. It ships to both engines, as one file.
It ships with or after Part 2, never before: more rings without presence is the anti-goal. It waits for nothing
else: no number of days of field baseline (the maintainer, 2026-11-26).

## Part 4. A standing line at session start

Built after Part 3's numbers are in. The eval variant comes first (the hook staged into the run), and the product part
ships only if that variant gains recall on at least one engine with specificity still at least 95%.

**The line** (at most 300 characters, the same rule as the description, so the two never disagree):

> The person has a Harness dial. Before you end a turn that leaves them something to decide, answer or do, run
> `harness device notify "<the ask>" --suggest "<your pick>" --waiting` (or `--proceeding` when you go on). Not for
> finished work or progress. The dial skill has the rest.

**Claude Code.** The plugin (`plugins/harness-device/`) gains a `SessionStart` command hook for every source (startup,
resume, clear, compact), beside its `PermissionRequest` hook and in the same two-shell form.

- The hook runs `harness device claude start`, and that command's output is the hook's output:
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<the line>"}}`, or nothing.
- The command prints the line only when Harness's own dial skill is in that session's home and the plugin is on and
  not marked removed (`dial-skill.json`). It asks no daemon and no network, ends within a second, and on any failure
  prints nothing and exits 0. It adds context and decides nothing.
- Reach: sessions started, resumed or compacted after the plugin is current (the devices service brings it current
  after each CLI update). A Claude session with the skill and no plugin has the skill alone.

**Codex.** Codex installs plugins from the same marketplace: the `harness` plugin has a Codex manifest
(`plugins/harness/.codex-plugin/plugin.json`, added with `codex plugin add harness@openharness`), with skills and an
MCP server and no hook. Harness Device has no Codex manifest. A spike in this part answers, on Codex 0.172 or later:
can a Codex plugin carry a `SessionStart` hook, and is that hook trusted without a prompt the person must answer?
(Codex keeps a trust record for hooks.)

- Yes: `plugins/harness-device/` gains a Codex manifest, set up by the dial setup as Claude's plugin is, whose hook
  runs `harness device codex start`.
- No: Codex keeps the skill alone, and the field counts say whether that is enough. The one route left would be a
  block in the engine hook install, as Agent Messages has. That is the core's process, so it is a decision for the
  maintainer and not part of this design.
- Either way Codex's side cannot be measured by the eval. It is judged by the same field counts, the days
  before and 7 days after, and it ships only together with Claude Code's side, on Claude Code's gain.

## Part 5. A second look when a turn stops

Built only if, after Parts 3 and 4, Claude Code's recall in `crowd` is still under 90%. It is the one step that
enforces the rule, and the one with the most risk.

A Stop hook, in the plugin for Claude Code. Codex's side, by Part 4's route, waits until a real Codex can be run to
prove it: a blocked stop behaves differently there (below). On a stop it:

1. Reads its input. `stop_hook_active` set, or no `last_assistant_message`: it ends, and the turn stops.
2. Looks at the last 400 characters of that message for a question mark (`?` or `？`). None: it ends. The text is
   read in the hook's own process and nowhere else: never logged, stored or sent.
3. Asks the devices' listener one thing, a new message `nudge` with the engine and session id, answered yes or no
   within 300 ms (no answer is no). Yes only when a dial is attached, the skill is on, no notice of that agent is
   pending, and the person is not present (Part 2's rule).
4. On yes, blocks the stop once with a reason that asks the agent to decide: its answer asks the person something and
   they are not at this session; if the task cannot go on without them, run `harness device notify` now and end; if
   nothing is needed from them, end.

The agent still judges and still writes the line. Harness only makes it look again.

- **Cost:** one more model round, only for a turn that ends on a question with a dial attached, the person away and
  no notice rung.
- **Turn ends:** in Claude Code a blocked stop continues the same turn. Harness's reader knows such continuations
  (`stopHookContinuation` in `engines/claude/normalize.ts`, built for `/goal`), and a Harness agent's turn end is
  announced only after `DONE_QUIET_MS`. In Codex a blocked stop arrives as a new prompt made from the reason, so it
  reads as a next turn: the builder checks what Harness's Codex reader and the prompt hook make of it. An outside
  agent's `done` heard at the blocked stop must not be announced: a yes to `nudge` tells the devices that this agent's
  stop continues, and they hold its turn end until its next stop, or 10 s. This must be proven end to end with the
  real CLI of an engine before that engine's side ships.
- **Measured** by an eval variant against the same text without it: recall, specificity on the trap scenarios, and
  the extra rounds per run.

## Design (docs/feature-design-rules.md)

For the two new counts. Nothing else is stored, synced or exposed.

1. **Growth.** Two names, so at most 6 more rows a UTC day in `product_usage_totals` (with their `staff:` and
   `testing:` copies), deleted by the existing TTL. On a computer, two more names a day in `dial-usage.json`, within
   its existing bounds. In memory, one flag on a pending card (at most 20 cards) and the time of the person's last
   prompt per outside agent (at most 64, dropped when the agent leaves).
2. **Concurrency.** N/A: the devices process is the file's one writer, as today.
3. **Read cost.** The review reads two more names a day. The devices read nothing new: `present` uses what they hold.
4. **Scale.** At 10× computers the rows stay 6 a day. At 10× notices a counter stops at `DIAL_USAGE_MAX_COUNT`.
5. **Compatibility.** An older CLI sends neither name, and the review hides empty rows. An older backend drops unknown
   names from a report and keeps the rest, so the backend ships first. An older dial firmware needs nothing: a quiet
   card uses the frames a restored card uses today.
6. **Migration and rollback.** None. Rolling the CLI back brings back today's rings.
7. **Audience.** Fixed names and numbers only. No notice text, answer text, agent, session, folder or id reaches a
   file, a log line or the backend. Part 5's hook reads an answer's last characters in its own process only.
8. **Identity.** N/A.
9. **Failure.** Presence unknown: the notice rings, as today. A hook that fails or times out prints nothing and the
   session goes on. A `nudge` with no answer in 300 ms is a no.

## Release order

0. #4642's counts: released on 2026-11-26 (backend 1.4.91, CLI 0.6.93). They are the field baseline for both engines.
1. Part 1: nothing to release.
2. Part 2: the backend with the two names, then the CLI.
3. Part 3: the CLI, with or after Part 2.
4. Part 4, if its variant gains: the plugin and the CLI.
5. Part 5, if its gate opens.

Each part is released as soon as it is done, not held for a batch or a date (the maintainer, 2026-11-26). The one
order kept is Part 3 with or after Part 2.

One task, one pull request: Parts 1, 2 and 3 are three pull requests; Parts 4 and 5 one each.

## Platforms

macOS, Linux and Windows. Presence needs a report of the app in front (Harness Device) or a Harness window; without
either a notice rings as today. The plugin's new hook takes the two-shell form of its `PermissionRequest` hook, so it
runs under a POSIX shell, Git Bash and PowerShell.

## Tests (red first)

- Part 1: the eval's own unit specs for the conditions, the listing probe, the new scenarios' checks and `one_step`.
- Part 2: `cable/notices.spec.ts` (a present caller's card is held, not asked; it stays pending; it ends at the next
  turn; `working()` leaves it; it leaves the hour's count alone and still takes its agent's minute);
  `services/devices.spec.ts` (the `present` table: the person's prompt within 120 s with the app in front and the
  dial on that agent; an older prompt; a prompt from another session; another app in front; an unknown front; the
  dial on another agent of the same app; a Harness agent on and off screen and past 120 s; an outside turn end silent
  in All; a failed turn still rings; a quiet notice opens no wait); `cable/dialUsage.spec.ts` and the contract's two
  copies; the backend's review test; `cli/e2e/dialUsage.e2e.ts`: an outside Claude Code session rings with its app in
  front and the dial on it, within 120 s of the person's prompt (`shown`, a drawer row, no ring frame), and again
  with another app in front (a ring).
- Part 3: `devices/dialSkill.spec.ts` (the file under 4096 bytes, the marker, the description's limits) and the eval.
- Part 4: `plugins/harness-device/test/`, the `start` command's spec (prints the line only with the skill and the
  plugin on; nothing on any failure), and a real-CLI check that the line reaches the model.
- Part 5: the hook's spec, the `nudge` handler's spec, and end-to-end runs with the real Claude Code.

## Docs in the same pull requests

`cli/AGENTS.md` (the devices row: the quiet card and the `present` rule), `cli/evals/dial-skill/README.md` and
`flow/metrics.md`, `plugins/harness-device/README.md`, and the dial docs that describe what rings.

## Decided by the maintainer (2026-11-26)

1. **The eval's spend.** A cap of $250 for Claude across this design.
2. **The eval runs Claude Code only.** There is no Codex quota for it, so no Codex run, and no sign-in is copied.
3. **Each part is released when it is done.** The new skill text does not wait 7 days for a field baseline.

## Left to the builder

- The exact words of the skill and the line, within the rules above; the eval decides.
- The crowd's skills and instructions file; the ten scenarios' repos, checks and split ids.
- How a pass confirms the dial's description reached the model, and which documented setting makes `name-only`.
- How the tally line says a notice was held quiet, without breaking the end-to-end checks that read it.
- How the limits take a quiet card for its agent and not for the hour.
- Which dial's shown agent counts when several dials are attached.
