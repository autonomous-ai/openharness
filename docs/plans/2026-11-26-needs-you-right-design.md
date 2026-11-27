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
| State: a permission ask, a question tool, a failed turn, a usage limit | code, for sure | rings in All and Needs you; not yet an outside Claude Code session's question form or plan approval (Part 6) |
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
variants of Parts 4 and 5: about $180. The cap is $250 (the maintainer, 2026-11-26), raised to $270 for Part 5 (the maintainer, 2026-11-27). Over it, the pass stops and
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
- **The dial's own rule, stated.** The firmware rings nothing for the agent on its face while its display is awake
  (`ui_habitat.c` `on_face`: a question, a turn end and a failed turn alike), and the display stays awake for 5 minutes
  after a touch, a voice press or a ring; following an agent does not wake it. With the display asleep everything
  rings. So an ask the devices mean to ring can stay silent in the minutes after the person last touched the dial, or
  after another agent's ring. Two places decide today; the firmware's owners are taking the face rule out (Open
  points, 3), and from their release the devices alone decide.

**Where it applies.**

1. **A notice.** `Notices.notify` (`cable/notices.ts`) takes `present` as a dependency. A notice from a present
   agent is a quiet card: held, never asked. That is the path a card restored after a restart already takes
   (`deps.hold`, then a drawer redraw): a row in the dial's drawer that opens to its line, with no beep and no wake.
   - The command still prints `shown`. The agent needs no word of it.
   - A quiet card ends as a live one does: its agent's next turn starts, or its agent leaves. It needs a flag of its
     own, apart from `restored`, since `working()` ends a restored card and must not end this one.
   - It stays quiet. If the person then leaves without answering, nothing rings later; the counts below say whether
     that costs answers. Part 2b adds one later look, when the turn ends.
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

## Part 2b. A quiet card is looked at again when its turn ends

Status: decided (the PM, 2026-11-26; the maintainer left it to the PM). A small change in the devices, built on
Part 2's code and released before Part 3 or with it.

Today a card held quiet stays quiet, and its turn ends silent under `rule:notice`, as a turn whose notice rang does.
So an ask made early in a long turn, with the person there, makes no sound at all once the person has gone: in All a
long turn ends unheard, and in Needs you an agent can wait unseen.

The change: when a turn ends (`dispatch`'s `done` card, read before that turn's start time is dropped), a pending
quiet card whose agent is not `present` now is asked: it loses `quiet`, goes to every dial as a question, and rings
once. A person still there keeps it quiet. A failed turn rings as a failed turn does and leaves the card as it is.

- **One ring a turn holds.** The card rings at the turn's end, and the summary that follows stays silent under
  `rule:notice`.
- **Limits.** It takes one of the hour's twenty then (`NOTICE_HOUR_MAX`); with none left it stays quiet. Its agent's
  own limits were taken when it was shown.
- **Counts.** From then it is a ring: it opens the wait a rung notice opens (none for `--proceeding`), so
  `dial_wait_*` and `dial_value_ring_*` count it. One name joins, `dial_notice_present_roused`, a quiet notice asked
  at its turn's end, with a row in `usage:daily`. Backend first, as in Part 2.
- **Unchanged:** a dial that attaches later and a restart hold the card, as today.
- **Tests (red first):** `cable/notices.spec.ts` (a quiet card is asked once; a rung or a restored card is left; with
  no hour left it stays quiet); `services/devices.spec.ts` (a turn end with the person gone asks the card and the
  summary stays silent under `rule:notice`; with the person still there it stays held; a failed turn rings and leaves
  it; a Harness agent past 120 s; the count and the wait); `cable/dialUsage.spec.ts`, the contract's two copies and the
  backend's review test.

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
prints. The first of these matters more than it did: an outside Claude Code session's question form does not reach
the dial today (Part 6), so an ask in such a form rings nothing, and the notice is the one path that does.

Limits on the text:

- The file stays under 4096 bytes (`MAX_SKILL_BYTES`: Harness knows its own file by its size and marker line). The
  name stays `dial`, the marker line stays as it is, and no new front-matter field is added.
- The description is one JSON-quoted line of at most 600 characters, with the moment and the command in its first
  300: Claude Code caps a listing entry at 1,536 characters and drops the descriptions of the least-used skills first
  when its listing passes 1% of the context window; Codex shortens descriptions first when its listing passes 2%.
- No `<` or `>` in the description: Claude Code 2.1.332 escapes them in its listing, so the model reads `&lt;` and
  `&gt;` (found by Part 3's first probe, 2026-11-26). Its placeholders take square brackets. The body is read whole, not
  through the listing, and keeps `<…>`.

The starting text. The builder tightens it by rounds on train and val, as the eval's README describes, and the eval
decides:

```
---
name: dial
description: "Before you end a turn that leaves the person something to decide, answer or do, ring their Harness dial: harness device notify \"[the ask, one line]\" --suggest \"[your pick]\" --waiting (or --proceeding when you go on with your pick). Not for finished work or progress."
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

**The baseline it starts from** (Part 1, 2026-11-26, 177 runs, commit 64fc59adaa of #4651; val and test pooled):

| Condition | Recall | Needless rings | `line_ok` | `one_step` |
|---|---|---|---|---|
| `crowd` | 21 of 32 | 0 of 18 | 20 of 21 | 0 of 21 |
| `clean` | 25 of 32 | 0 of 18 | 21 of 25 | 0 of 25 |
| `name-only` | 0 of 16 | 0 of 9 | | |

What the numbers say, and what the rounds aim at:

- **An ask the agent can go on with never rang held out:** 0 of 4 in both conditions (`two-decisions`,
  `retry-policy-rollout`), 2 of 4 on train. Today's description says "when the task stops", which an agent that goes on
  with its pick does not meet. The new trigger ("leaves the person something to decide") and `--proceeding` in the
  description are aimed at this.
- **The crowd costs about four waiting asks** (28 runs: 25 rang in `clean`, 21 in `crowd`; `destructive-migration` and
  `gh-signed-out` both runs). That is the dilution the new description must survive.
- **No needless ring anywhere** (0 of 36), so the text has room to ring more before the traps push back.
- **Every ring came after the agent loaded the skill's body** (`one_step` 0), and with no description nothing rang.
  So the description decides whether the agent rings at all.
- **Missed runs were longer:** 11.6 tool calls on average against 8.3 for runs that rang.

How the rounds run, within $100 of the design's $250 (the PM, 2026-11-26):

- **One field first:** `loaded`, on every run, 1 when the agent loaded the dial skill's body (a Skill call for `dial`
  or a read of its `SKILL.md`). With it a miss reads as "never looked" (the description) or "looked and did not ring"
  (the body). Each round keeps its runs' traces on the machine, git-ignored as today, so a miss can be read.
- **Rounds in `crowd` only**, train and val, 2 reps: 52 runs, about $14 a round. The winner then runs val and test in
  `crowd` and `clean` at 2 reps, and `name-only` at 1 rep, against the baseline's same rows.
- **`name-only` is no gate here:** words cannot reach a model that never sees them. It is Part 4's measure.

Shipping rule: the winner ships only if it meets Part 1's targets on Claude Code, or is above the baseline beyond
noise with no more needless rings, and `harmed` and `went_on` are no worse. It ships to both engines, as one file.
It ships with or after Part 2 and Part 2b, never before: more rings without presence is the anti-goal. It waits for
nothing else: no number of days of field baseline (the maintainer, 2026-11-26).

Shipped (2026-11-27): v1, the starting text above word for word, ships below the gate by the PM's decision. It missed
the 90% recall gate (`crowd` val and test 41 of 48, baseline 21 of 32), but in the cases whose traces were never read
`crowd` rang 33 of 33 against the baseline's 14 of 22, with 0 needless rings. `clean` added 2 of 18 needless rings,
both `minor-choice` right after the person's prompt, which Part 2's present rule turns quiet. Field watch for 7 days
after release; rollback is `cli/src/devices/dialSkill.ts` alone.

## Part 4. A standing line at session start

Status: going ahead (the maintainer, 2026-11-27: do it all, with the PM). Part 3's numbers are in and v1
ships (#4666), so the eval compares v1 with v1 and this line, after #4666 merges: `crowd`, `clean` and `name-only`,
where `name-only` (0 of 16 today) is the case this line is for. Its spend counts against the same $250 cap ($114.97
spent by Part 3). The eval variant comes first (the hook staged into the run), and the product part ships only if that
variant gains recall with specificity still at least 95%, read as (the PM, 2026-11-27): held-out recall, paired with
v1, up beyond noise in `crowd` or in `name-only`, and down beyond noise in no condition; specificity over the no-need
runs of all three conditions pooled (`crowd` at 3 reps, `clean` at 2, `name-only` at 1: 54 runs), at most 2 needless
rings. Harness's own headless runs (the `codex exec` one-shots of `lib/oneshot.ts`) never get the line.

**The line** (at most 300 characters, the same rule as the description, so the two never disagree):

> The person has a Harness dial. Before you end a turn that leaves them something to decide, answer or do, load the
> dial skill and follow it. Not for finished work or progress.

**Claude Code.** The plugin (`plugins/harness-device/`) gains a `SessionStart` command hook for every source (startup,
resume, clear, compact), beside its `PermissionRequest` hook and in the same two-shell form.

- The hook runs `harness device claude start`, and that command's output is the hook's output:
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<the line>"}}`, or nothing.
- The command prints the line only when Harness's own dial skill is in that session's home and the plugin is on and
  not marked removed (`dial-skill.json`). It asks no daemon and no network, ends within a second, and on any failure
  prints nothing and exits 0. It adds context and decides nothing.
- Reach: sessions started, resumed or compacted after the plugin is current (the devices service brings it current
  after each CLI update). A Claude session with the skill and no plugin has the skill alone.

**Codex.** Part 7 (#4660, released in CLI 0.6.95) gave Harness Device a Codex manifest (`hooks/codex.json`), set up
by the dial setup in each Codex home it serves and trusted without a prompt: Harness writes each hook's `hooks.state`
record only while the installed folder is the copy this CLI carries. Part 4 adds to it:

- `hooks/codex.json` gains a `SessionStart` hook, in the same two-shell form as its others, which runs
  `harness device codex start`: the same command as Claude Code's, made to take either engine, with the same rules
  (Harness's own dial skill in that Codex home, the plugin on, Codex not marked removed; no daemon, no network, within
  a second, nothing on any failure).
- Its trust comes from Part 7's write: the new hook changes the carried folder's fingerprint, so the setup's update
  after the CLI update writes a record for each hook, `SessionStart` among them (its matcher is hashed, as Part 7's
  `REVIEWED.matcherEvents` already lists).
- First task, before the command is built: one isolated Codex 0.172 run against the local stub, as Part 7's spike
  (its own `CODEX_HOME` and `HOME`, a dummy key, never the person's login), shows whether Codex puts a `SessionStart`
  hook's `additionalContext` into the model's request: the stub records the request, and the line must be in it. Not
  there: Codex keeps the skill alone, the hook is not added, and the field counts say whether that is enough.
- Codex's side cannot be measured by the eval (no Codex quota). It is judged by the same field counts, the days before
  and 7 days after, and it ships only together with Claude Code's side, on Claude Code's gain.

### Round 1: v3's line, not shipped

v3's line:

> The person has a Harness dial. Before you end a turn that leaves them something to decide, answer or do, run
> `harness device notify "[the ask]" --suggest "[your pick]" --waiting` (or `--proceeding` when you go on). Not for
> finished work or progress. The dial skill has the rest.

Held out, val and test pooled, v1 then v1 with v3's line (2026-11-27):

| condition | recall | needless rings |
| --- | --- | --- |
| `crowd` | 41 of 48 → 48 of 48, paired +0.15 [-0.01, 0.30], within noise | 0 of 27 → 5 of 27 |
| `clean` | 28 of 32 → 31 of 32 | 2 of 18 → 2 of 18 |
| `name-only` | 0 of 16 → 16 of 16, beyond noise | 0 of 9 → 2 of 9 |

9 needless rings of 54 against at most 2: not shipped. Recall is what a line at session start gives; the cost is rings
for choices that were the agent's to make. The line hands the agent the command, so it can ring without reading the
skill's body, and that body is what tells which asks need the person (v1 alone rang needlessly 0 of 27 times in
`crowd`). The flow had spent $156.23.

### Round 2: a line that sends the agent to the skill (v4)

Decided by the PM and the author (2026-11-27), before Part 5 is built: round 1 shows the line solves recall, and Part
5 is a fix for recall at the most risk. The line names the moment and sends the agent to the skill; the skill's body
decides and gives the command. Its starting text (at most 300 characters):

> The person has a Harness dial. Before you end a turn that leaves them something to decide, answer or do, load the
> dial skill and follow it. Not for finished work or progress.

- It is changed only from what the train and val traces show. A test scenario is read as counts alone: Part 3's
  round 2 read test traces and was discarded.
- The same eval and ship rule as round 1, paired with v1: held-out recall up beyond noise in `crowd` or `name-only`
  and down beyond noise in none; at most 2 needless rings in the 54 pooled no-need runs. The flow's cap is $220.
- One more round is all this design tries. If v4 fails, no line ships and Part 5's gate is read on v1.
- Shipped, v4's text replaces the line above; the command, the hooks and their trust are round 1's, unchanged. The
  agreement test then holds the line to the description's moment, as it carries no command.

**Measured (2026-11-27).** Held out, val and test pooled, v1 then v1 with v4's line, the starting text unchanged:

| condition | recall | needless rings |
| --- | --- | --- |
| `crowd` | 41 of 48 → 48 of 48, paired +0.15 [-0.01, 0.30], within noise | 0 of 27 → 1 of 27 |
| `clean` | 28 of 32 → 32 of 32, paired +0.13 [-0.03, 0.28], within noise | 2 of 18 → 0 of 18 |
| `name-only` | 0 of 16 → 16 of 16, paired +1.00 [1.00, 1.00], beyond noise | 0 of 9 → 0 of 9 |

1 needless ring of 54 (`crowd` `minor-choice`, after loading the skill), against at most 2; `name-only` alone 0 of 9.
Every ring came after the skill's body was loaded. v4 ships: its text is the line above, and the product carries it.
`line_ok` in `crowd` was 35 of 48, against v1's 36 of 41, not a gate. Part 5's gate, read on v4: held-out `crowd`
recall 48 of 48 (100%), not under 90%, so the eval alone does not open Part 5; a miss in use did (Part 5). The flow spent $197.01 of the $220 cap.

## Part 5. A second look when a turn stops

Status: opened (the PM and the author, 2026-11-27), by a miss in use. It is the one step that enforces the rule, and
the one with the most risk. Its gate was Claude Code's held-out `crowd` recall under 90% after Part 3 and Part 4's two
rounds; v4 reached 48 of 48, so the eval alone kept it shut. The gate is now either: the eval, or a miss in use. On
2026-11-27 a long-running Claude Code session, its dial skill and v1's words in place, ended a turn on a decision only
the maintainer could make and rang nothing; the turn's last lines asked it, and no notice was sent that turn or since
the session's previous one. That is the case this part catches: a turn that ends on a question with no notice. The
maintainer had said a skill the agent must be told to use is not doing its job. v4's line comes back only at a
session's start, resume, clear or compaction, so a session days long keeps its first copy far back in its context.
Its eval needs about $70 (Measured, below), past the $250 cap, which the maintainer raised to $270 for it
(2026-11-27).

A Stop hook, in the plugin for Claude Code. Codex's side goes in the same plugin's `hooks/codex.json`, proven with a
real Codex CLI against the local stub, as Part 7's spike was. On a stop it:

1. Reads its input. A headless run (`claude -p`; for Codex, `codex exec`, whose rollout's first line says `source`
   `exec`), a session in Harness's data folder, or the skill not on: it ends, and tells the devices nothing.
2. Looks at the last 400 characters of `last_assistant_message` for a question mark (`?` or `？`). The text is read in
   the hook's own process and nowhere else: never logged, stored or sent. `stop_hook_active` set, or no message: no
   question.
3. Tells the devices' listener at every such stop, with a new message `nudge`: the engine, the session id and one bit,
   `ask`, whether it found a question (the one bit the nudge already gave away). With `ask` false the devices only
   take the report (below) and the stop goes on. With `ask` true they answer yes or no within 300 ms (no answer is
   no). Yes only when a dial is attached, the skill is on, that agent rang no notice in
   this turn (a card left from an earlier turn does not count: it may be stale), and the person is not present (Part
   2's rule). A turn started by another session's message (a relayed prompt) is no prompt of the person's, for this
   and for the once rule.
4. On yes, blocks the stop once with a reason that asks the agent to decide: its answer asks the person something and
   they are not at this session; if the task cannot go on without them, run `harness device notify` now and end; if
   nothing is needed from them, end.

The agent still judges and still writes the line. Harness only makes it look again.

- **Cost:** one more model round, only for a turn that ends on a question with a dial attached, the person away and
  no notice rung.
- **Turn ends:** in Claude Code a blocked stop continues the same turn. Harness's reader knows such continuations
  (`stopHookContinuation` in `engines/claude/normalize.ts`, built for `/goal`), and a Harness agent's turn end is
  announced only after `DONE_QUIET_MS`. In Codex 0.172 a blocked stop also goes on in the same turn, with no new turn
  (Part 5's spike, 2026-11-27). An outside agent's `done` heard at the blocked stop must not be announced.
  - **Its report comes late:** the spike measured the `nudge` reaching the devices up to about 1.36 s after the
    native hook's turn-stop on macOS, against a grace of 1.5 s, and Windows' PowerShell is slower. So the devices
    remember each session whose Stop hook has reported (in memory, at most 64, never in a file), and hold that
    session's native turn-stop until its report arrives, or 6 s (the hook's 5 s timeout and 1 s): then the turn end is
    announced and the session is no longer remembered. A session's first stop, before any report, still rests on the
    grace: a limit, stated (the PM, 2026-11-27). The cost: a turn end of such a session is announced up to the hook's
    run time later, which on Windows can be a few seconds.
  - After a yes, the devices know that this agent's stop continues, and they hold its turn end until its next stop,
    or 10 s of silence after the session's last activity (a hook for it, or its transcript growing), at most 120 s
    from the yes; when the hold expires, the turn end is announced (the PM, 2026-11-27).
  - This must be proven end to end with the real CLI of an engine before that engine's side ships.
- **Measured** (the PM, 2026-11-27, the maintainer having left it to the PM). The eval was to show the case and then
  no harm; it could show only the second, so the hook ships on no harm and its gain is read in the field.
  - **(b) The case it is for, run and failed as a gate:** v1 with the hook against v1, `crowd` val and test at 3 reps:
    44 of 48 against 41 of 48, one-sided Fisher p = 0.262. The hook asked nothing in any run (0 of 48 need runs, 0 of
    27 no-need): v6's 4 misses were turns the agent went on with by itself, not ending on a question, and the 6 runs
    that ended on a question had all rung. Short `claude -p` runs do not reproduce the miss in use that opened this part
    (a session days long ending a turn on a question, `?` included, with no notice), which is the one the hook acts on.
    So (b) is reported, not a gate: a gate moved after its run, stated as such.
  - **(a) No harm, the gate:** v4 with the hook against v4, val and test in every condition. Recall down beyond noise
    in none; at most 2 needless rings in the 54 pooled no-need runs; `harmed` and `went_on` at most v4's in each
    condition, one run either way being noise. About $45, the flow at about $265 of the $270 cap. Over it, the pass
    stops and reports.
  - **The gain, in the field:** two counts, the backend first, so a CLI never sends a name the backend drops:
    `dial_nudge_<engine>` (a stop the devices said yes to) and `dial_nudge_<engine>_rang` (a notice of that agent
    rung in the continuation after a yes, before its next stop or the hold's end), for `claude` and `codex`. Fixed
    names and numbers, as #4642's.
  - **Kept or removed after 7 days of the field:** kept when the `_rang` counts are above 0 and at least a quarter of
    the yeses, both engines pooled; removed (the plugin's Stop hook alone, by a CLI release) when yeses come and almost none ring, as
    then the hook costs a model round for nothing. The trigger does not change before that read.

  **Measured (2026-11-27).** (a), held out, val and test pooled, v4 then v4 with the hook: recall `crowd` 48 of 48 →
  48 of 48, `clean` 32 of 32 → 32 of 32, `name-only` 16 of 16 → 16 of 16, paired +0.00 [0.00, 0.00] in each, no fall;
  needless rings 2 of 54 pooled no-need runs, against at most 2 (v4 1 of 54); `harmed` and `went_on` equal to v4's in
  every condition. The hook blocked 0 of 96 need runs and 3 of 54 no-need runs, each quiet after it; the cost per run
  stayed within $0.002-0.013 of v4's: 3 of 150 runs took one extra round. (a) passes and the hook ships on it (the PM, 2026-11-27). Part 5
  spent $64.67 ((b) $23.21, (a) $41.46): the flow at $261.68 of the $270 cap.

  **Not on Windows in this release** (the PM, 2026-11-27). The Stop hook runs at every turn end and the engine waits
  for it, so its time is added to every turn, not only to those that ask. Rule set before the measure: kept on
  Windows if the median added time is at most 1 s. Measured on a Windows 11 ARM64 VM, 136 stops, none past the hook's
  5 s: Claude Code under Git Bash +816 ms, under PowerShell about +1,490 ms, Codex +690 ms (its own hook already about
  1.1 s); about 1.2 s of it PowerShell's start and 0.5 s Node and the CLI loading, the pipe's proof about 40 ms. Which
  shell Claude Code uses is the computer's, not the plugin's, so one shell's number cannot be kept alone: the Stop
  entry is left out of `hooks/hooks.json` and `hooks/codex.json` as the CLI writes them on Windows, for both engines,
  and the Codex trust is written for that copy. It comes back with a faster start. The four `dial_nudge_*` counts
  then hold macOS and Linux alone.

## Part 6. An outside Claude Code session's question form and plan approval reach the dial

Status: decided (the PM, 2026-11-26; the maintainer left it to the PM). Built at once, ahead of Parts 4 and 5. The
CLI alone changes.

Today a waiting prompt of a Claude Code session outside a pane reaches the dial through the plugin's
`PermissionRequest` hook (`harness device claude asked`, `cli/src/deviceClaude/asked.ts`): its line becomes the
agent's wait (`cable/hosts/observed.ts` `asked`), and `showWaits` shows and rings it. That command leaves out
`AskUserQuestion` and `ExitPlanMode` (`PERSON_ONLY`), on the reading that the dial already shows the agent waiting.
At most its tile reads waiting: no card is asked, so nothing rings. Another team's trace (2026-11-26) found this on a
dial in Needs you. It is the surest sign that an agent waits on the person, and it is silent outside Harness's panes.

The change: `asked` tells these two as it tells any prompt, each with a line of its own.

- `AskUserQuestion`: the first question's text (`tool_input.questions[0].question`, else its header, else
  `A question`), as one line, cut as every summary is (200 bytes, control characters to spaces).
- `ExitPlanMode`: the fixed words `Plan ready to approve`. The plan's text is never sent.

The rest is the path a permission ask takes today: a wait card with that line and `In <app>`, rung once, counted as
an outside wait, closed when the agent goes on. Nothing is answered on the dial.

- **First task, with the real Claude Code** (2.1.332 or later) outside a pane: which hooks a question form and a plan
  approval fire (`PermissionRequest`, `PreToolUse`, `Notification` and its type), in the default and the auto
  permission modes, and on Windows, where the plugin's mod tells of a prompt before the hook
  (`HARNESS_DEVICE_MOD_ASKS`). The change is made where the prompt is first heard. The same task checks Codex's
  `request_user_input` outside a pane and reports; it is fixed here only if it is the same kind of skip.
- **What shows.** The question's first line shows on the dial as a permission ask's line does, and as a Harness
  agent's question already does.
- **Counts.** No new name and no backend change: the wait counts hold it.
- **Tests (red first):** `deviceClaude/asked.spec.ts` (each tool's line, its bounds, a form with no question);
  `services/devices.spec.ts` (the wait card and its ring for each); an end-to-end case with the fake engine; the
  real-CLI check recorded in the pull request.
- **Docs:** `plugins/harness-device/README.md` and the devices row of `cli/AGENTS.md` where it names the skip.

## Part 7. A Codex session's waits outside a pane reach the dial

Status: decided (the PM and the author, 2026-11-26; the maintainer left it to them; item 3 and the points marked
2026-11-27 by the PM, from the final review). Found by Part 6's probe, from the
code; its spike ran five isolated Codex 0.172.0 sessions against a local stub (2026-11-26). After Part 6. The CLI and
the Harness Device plugin change; the native hook and the core's process do not.

Harness's native hook (`cli/hook/notify.mjs`, which the core installs into each engine's home) runs on Codex's
`PermissionRequest` and `PreToolUse` (`request_user_input`), but outside a pane its `observedEvent` makes neither an
event, and Codex has no Harness Device plugin to tell an `asked` line as Claude Code's does. So a
Codex agent in a terminal, the ChatGPT app or Orca that waits on a permission ask or a question shows nothing on the
dial; only Harness's panes hear it (`/api/hook/wait`). That is about 8 to 14 computers a day with a hooked Codex on the
dial (`dial_hooked_codex_installation_days`, 2026-11-23 to 25).

- **It reverses one line for waits only.** "Outside a pane none of the new events posts anything" (the maintainer,
  2026-11-17, `docs/plans/2026-11-16-hook-driven-agent-status-plan.md`) kept the dial from sounding at every Codex
  turn. A wait is the person's to answer, so it now posts; every other Codex event outside a pane stays as it is.
- **The trap.** Codex's own automatic review fires `PermissionRequest` with no dialog for a command it approves itself
  (that plan's limit 4). In a pane Harness reads the screen to tell them apart; outside one there is none. A ring at
  every self-approved command is the anti-goal.

The change:

1. **Where the wait is heard: Harness Device's own hook, never the native one.** As Claude Code's is: the plugin's hook
   runs `harness device claude asked` (`cli/src/deviceClaude/asked.ts`), which posts an `asked` event to
   `/api/hook/observed`, which the core already takes for any engine (`core/observedHook.ts`). For Codex,
   `plugins/harness-device/` gains a Codex manifest whose hooks, on `PermissionRequest` and `PreToolUse`
   (`request_user_input`), run `harness device codex asked`: the same code made to take either engine, with
   `engine: 'codex'`. It prints nothing and decides nothing, as Claude Code's. In a Harness pane it is dropped as
   Claude Code's is: the observed source holds no such session (`cable/hosts/observed.ts` `asked`). The dial setup
   installs the plugin as it installs Claude Code's (`cable/dialSetup.ts`), held by the same switch
   (`harness device codex disable`).
   - **Trusted without a prompt** (the spike): Codex asks a person to review a hook before it first runs. After each
     install or update of the plugin, the dial setup writes the record Codex writes on "Trust": in the Codex home's
     `config.toml`, the plugin's hooks under `hooks.state`, each with its `trusted_hash` (the hash `hookReview.ts`
     computes for Harness's own hooks) and `trusted_content_hash` (the fingerprint of the installed folder). Turning
     Codex on for the dial is the consent, as for the skill. Codex 0.172.0 is the floor (`MIN_CODEX`).
   - **Only content this CLI carries is trusted** (the author, 2026-11-26). The record tells Codex to run what is in
     the installed folder without asking anyone, so it is written only when that folder's fingerprint equals the
     fingerprint of the plugin this CLI build carries. A folder that differs (a newer `main` fetched by Codex's own
     marketplace refresh, a file changed by hand) is never trusted by Harness: Codex asks the person to review it, as
     it would without Harness. So the CLI carries the plugin and installs it from a local marketplace folder it writes,
     as #4648 does for Claude Code; that copy changes only with the CLI, Codex's refresh of it changes nothing, and no
     git is needed.
   - **Kept trusted between CLI updates** (the PM, 2026-11-26): each dial setup pass checks every home it serves (a
     stat of the installed folder and of `config.toml`, the fingerprint computed only when one changed) and writes the
     record again when the folder matches the CLI's copy and the record does not; a folder that differs is left
     untrusted, logged `untrusted · differs` once.
   - **A home with the person's own `openharness` marketplace** (added from GitHub, as `plugins/harness/README.md`
     shows; the PM, 2026-11-26): its copy follows GitHub's `main`, never the CLI's, so it could never be trusted, and
     installing there would only bring the person a hook review they did not ask for. The setup installs nothing in
     that home and logs `skipped · own marketplace` once; its Codex waits stay off the dial, as today.
   - **That file has other writers:** the core's own hook review, Codex itself, and the person. The write edits only
     the plugin's own tables, the way `hookReview.ts` and `folderTrust.ts` edit the file (through a symlink,
     atomically, never a table defined twice), and a write that finds the file changed since it read it reads it
     again and starts over, at most 3 times, so it never drops another writer's change. It is crash-safe as
     `hookReview.ts`'s write is: a crash mid-write leaves the old file or the new one, never half of one (the PM,
     2026-11-27). Failed, it logs its kind alone; Codex then asks the person to review the hook, as it would without
     the record.
   - Its line (the spike, 2026-11-26): for `Bash`, the command's first line; for `apply_patch`, the first file path it
     names; for `request_user_input`, its first question's text, as Part 6's question form; for any other tool, the
     tool's name alone. Cut as Claude Code's summaries are (200 bytes, control characters to spaces). Nothing else of
     the tool's input leaves that process.
   - Not `notify.mjs`. It is not one of the core process's files, but every session of every engine runs it, the core
     installs it, and its rule is "the event and the tool's name only, never a tool's input or what is asked". The
     spike found the plugin can carry trusted hooks, so no fallback there is needed.
   - **Not in the background** (the PM, 2026-11-27, after release, from #4668's measurements). Codex 0.172 takes
     `"async": true` for `PermissionRequest` and `PreToolUse`: it starts the hook and does not wait for it. Both hooks
     stay without it, so Codex waits for the hook before it shows its dialog. In the background, the post reached the
     devices after the person had answered, and the dial rang an ask already answered. On Windows that happened in
     4 of 5 turns that ended right after the command: the ring came 0.43 to 0.55 s after the answer and the card
     closed 1.8 to 2.0 s later. Codex runs its Stop hook, about 0.4 s there, before it writes the turn's end, so a check
     of the record for that end could not stop the post. A ring after the answer breaks the rule that the dial never
     rings wrong; the wait it saved was about 0.45 s on Windows (928 to 454 ms) and 0.19 s on macOS (259 to 71 ms),
     with the model answering 2 s after Enter. Run in the foreground, the hook's post always lands before the dialog
     shows, so the answer always comes after it.
2. **Who reviews it, read where the ask is heard** (the PM, 2026-11-26, from Codex 0.172.0's source). A
   `PermissionRequest`'s input says nothing of whether a dialog follows; the hook runs before Codex's automatic review,
   which is a model session of its own with hooks off; and the next event of a command it approves is `PostToolUse`,
   only once the command has run, which the devices do not hear outside a pane. So no wait in the devices can tell
   the two apart. Instead the command reads the turn's own setting from the session's record, in its own process:
   - It reads the record (`transcript_path` in the hook's input) backwards from its end, at most
     `CODEX_REVIEWER_READ_BYTES` (16 MiB), for the `turn_context` line of the hook's `turn_id`, and takes two fields
     alone: `approvals_reviewer` and `collaboration_mode.mode`. Only a regular file under the session's Codex home is
     read; nothing of it is kept, logged or sent.
   - The spike's facts: that line is written before the turn's `PermissionRequest` and `PreToolUse` hooks run, and
     always holds `approvals_reviewer`. It lay 4 to 10 KB from the end in short turns and 3.16 MB after 40 commands with
     large output; reading 16 MiB backwards took 28 ms.
   - `PermissionRequest`: `user` posts at once; `auto_review`, anything else, or not found within the bound posts
     nothing. One for a tool of Codex's apps (`mcp__codex_apps__*`) posts nothing (the PM, 2026-11-27).
   - `PreToolUse` (`request_user_input`): it also fires in Default mode, where Codex refuses the tool and shows no
     form. So it posts only when `collaboration_mode.mode` is `plan`. A Default mode with
     `default_mode_request_user_input` on is missed, as today, rather than rung for nothing. An input with no first
     question's text posts nothing (the PM, 2026-11-27).
3. **Once per command in a session** (the PM, 2026-11-27, from Part 7's final review). When the person picks "Yes,
   and don't ask again for this command in this session" (for `apply_patch`, "don't ask again for these files"),
   Codex checks that choice only after the `PermissionRequest` hook has run. So the same command later in that session
   runs the hook again, its turn's reviewer still `user`, and no dialog follows. Neither the hook's input nor the
   record says the choice was made. So the devices take a Codex permission ask only the first time a session asks it:
   a Codex `asked` whose tool and line that session already asked is dropped, with no card and no ring. A question
   form (`request_user_input`) is never dropped, and nothing changes for Claude Code.
   - Kept in the devices' memory alone, beside the agent outside a pane (`cable/hosts/observed.ts`): at most 64 lines
     a session, the oldest going first, within that source's 50 sessions (the author's bound). A session's lines go
     when its agent leaves. Nothing of it is written to a file or sent.
   - What it costs: when the person picks plain "Yes" and Codex asks again for that very command in the same session,
     the second ask is missed. After the devices restart, a remembered command rings once more for nothing, at most
     once each.
4. Posted, it is the path a Claude Code permission ask takes today: a wait card with its line and `In <app>`, rung
   once, counted as an outside wait, closed when the agent goes on. The devices add only item 3 for Codex.

What it gives up, on purpose: with automatic review on, a command the review passes to the person rings nothing, as
today; so does a Default-mode question form where Codex's experimental setting turns it on. A ring at every command the review approves would be the anti-goal; a missed escalation is today's behavior.
So, by item 3, does a second ask for a command the person allowed with plain "Yes": a ring at every command the
person already allowed for the session would be the same anti-goal.
And if Codex renames the field or the line, every Codex ask outside a pane goes quiet again, as today: the command's
spec pins a record written by Codex 0.172, and the Codex release checks read it again.

First tasks, before anything is built:

Answered by the spike (2026-11-26), and used by Part 4 too:

- **A Codex plugin carries these hooks**, trusted without a prompt once its `hooks.state` record is written (1).
- **No field of the hook's input says whether a dialog follows** (Codex 0.172.0's source), hence the record's
  `turn_context` (2), whose timing and distance the spike measured.
- Its records, written by Codex with nothing of the person's, become the command's spec fixtures.

- **Counts.** No new name: the wait counts hold it.
- **Tests (red first):** the `asked` command's spec for Codex (both tools, their lines and bounds, a malformed input);
  the plugin's test (the Codex manifest and its hooks); the dial setup's spec (installed with a dial, held by the
  switch; the trust record written after each install and update, only the plugin's tables, a file changed meanwhile
  read again, another writer's change kept); the reviewer check (`user` posts; `auto_review` posts nothing; another
  turn's `turn_context` is not read as this one's; a line past the bound reads as not found; a missing, linked or
  non-regular file posts nothing; an `mcp__codex_apps__*` tool posts nothing); `request_user_input` (posts in plan
  mode, nothing in Default mode, nothing with no first question's text); the line for `Bash`, `apply_patch`,
  `request_user_input` and another tool; the trust write left whole when it stops mid-write;
  `services/devices.spec.ts` (a Codex `asked` waits and rings once, as Claude Code's; the same tool and line again in
  that session drops, in another session rings; a question form asked twice rings twice; the 65th line pushes out
  the first; a session's lines go with its agent); an end-to-end case with the fake Codex engine, its record holding
  each reviewer and mode.
- **Its time** (the PM, 2026-11-27). The hook runs at every Codex permission ask, so the pull request gives its
  time from start to exit, in a short turn and with the record's line at the 16 MiB bound. Measured at release
  (median of 5): macOS 238 to 269 ms, a Windows 11 ARM64 VM 1.49 to 1.54 s, all of it added to the wait for Codex's
  dialog, which stays (item 1, "Not in the background").
- **Docs:** `plugins/harness-device/README.md`, the devices row of `cli/AGENTS.md`, and the hook-driven status plan's
  limit 4, which this narrows.

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

### Part 5's counts (the PM, 2026-11-27)

Four names, `dial_nudge_claude`, `dial_nudge_codex`, `dial_nudge_claude_rang` and `dial_nudge_codex_rang`, in the
dial's usage counts as #4642's were added; nothing else of Part 5 is stored or synced.

1. **Growth.** At most 12 more rows a UTC day in `product_usage_totals` (with their `staff:` and `testing:` copies),
   deleted by the existing TTL; four more names a day in `dial-usage.json`, within its bounds. In memory, one mark on
   a held stop that a yes was counted, gone with the hold.
2. **Read cost and scale.** One counter step per yes and per notice in a held continuation; at 10× a counter stops at
   `DIAL_USAGE_MAX_COUNT`, and the rows stay 12 a day.
3. **Compatibility.** An older backend drops unknown names from a report and keeps the rest, so the backend ships
   first. An older CLI sends none, and the review hides empty rows.
4. **Audience and failure.** Fixed names and numbers only, no session, agent or text. A lost count changes no ring.

### Part 7's own data (from its plan, 2026-11-26)

Part 7 stores a record and writes another program's config file.

1. **Growth.** `dial-setup.json` gains `codexPlugin`: one CLI version per Codex home the setup installed into, at most
   64 homes; an entry leaves when its home folder is gone. A home's `config.toml` gains the plugin's two `hooks.state`
   tables, replaced in place at each install, update or changed fingerprint, never added twice; after `disable` they
   stay, inert (Codex ignores a record with no hook), and the next install replaces them. In the devices' memory, the
   lines each Codex session already asked (Part 7, item 3): at most 64 a session within the observed source's 50
   sessions, gone with the session's agent and at a restart.
2. **Concurrency.** `dial-setup.json` keeps one writer, the devices process (the command only reads `codexPlugin`).
   `config.toml` has other writers (Codex, the core's `engines/kit/hookReview.ts`, the person): only the plugin's own
   tables are edited, through a link to its target, atomically, comparing what was read with what is on disk just
   before the write and starting over when they differ, at most 3 attempts.
3. **Read cost.** A setup pass with every home current runs no `codex`; its check of each home is a stat of the
   installed folder and of `config.toml`, the fingerprint computed again only when one changed. The hook reads at most
   16 MiB of a session's record backwards, under 10 KB in a short turn.
4. **Scale.** At 10× homes the record stops at 64; installs run one home at a time, and a failed home waits an hour.
   The `[device] codex plugin` tally's `failed` count warns first.
5. **Compatibility.** An older CLI that rewrites `dial-setup.json` drops `codexPlugin`, and the next pass installs
   again. An older CLI under the installed plugin answers `device codex asked` with its usage and exit 1, which the
   hook drops: nothing rings, as today. A Codex older than 0.172.0 is set nothing up. Claude Code reads
   `.claude-plugin/` and `hooks/hooks.json`, unchanged.
6. **Migration and rollback.** None. A rollback leaves the plugin and its trust in place and silent; the person removes
   it with `codex plugin remove harness-device@openharness`.
7. **Audience.** Nothing leaves the computer: the post goes to this account's daemon, as Claude Code's does. Of the
   session's record, two fields are read and none is kept, logged or sent.
8. **Identity.** `codex plugin` runs as the computer's own account in its own Codex home. No Codex or ChatGPT sign-in
   is used.
9. **Failure.** Install, update, trust and remove failures are counted by step and kind and retried after an hour. A
   trust write that fails leaves Codex asking the person to review the hook. A record not read rings nothing.

## Release order

0. #4642's counts: released on 2026-11-26 (backend 1.4.91, CLI 0.6.93). They are the field baseline for both engines.
1. Part 1: nothing to release.
2. Part 2: the backend with the two names, then the CLI.
3. Part 2b: the backend with its one name, then the CLI, before Part 3 or with it.
4. Part 3: the CLI, with or after Part 2 and Part 2b.
5. Part 6: the CLI, as soon as it is done.
6. Part 7: the plugin and the CLI, after Part 6 and after #4648, whose local marketplace it shares (the PM,
   2026-11-26).
7. Part 4, if its variant gains: the plugin and the CLI, after #4666 (v1's words), the base its eval compares with.
8. Part 5, if its gate opens: the plugin and the CLI, after Part 4's eval.

Each part is released as soon as it is done, not held for a batch or a date (the maintainer, 2026-11-26). The orders
kept: Part 3 with or after Parts 2 and 2b, and Part 7 after Part 6 and #4648.

One task, one pull request: Parts 1, 2 and 3 are three pull requests; Parts 2b, 4, 5, 6 and 7 one each.

## Platforms

macOS, Linux and Windows. Presence needs a report of the app in front (Harness Device) or a Harness window; without
either a notice rings as today. The plugin's new hooks take the two-shell form of its `PermissionRequest` hook, so they
run under a POSIX shell, Git Bash and PowerShell. Part 5's Stop hook is the exception: macOS and Linux only in its
first release, as its time on Windows is added to every turn end (Part 5, "Not on Windows in this release").

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

1. **The eval's spend.** A cap of $250 for Claude across this design, raised to $270 for Part 5 (2026-11-27).
2. **The eval runs Claude Code only.** There is no Codex quota for it, so no Codex run, and no sign-in is copied.
3. **Each part is released when it is done.** The new skill text does not wait 7 days for a field baseline.

## Open points (found after Part 2's review, 2026-11-26)

The maintainer left the first two to the PM, who decided to build both (2026-11-26): Part 2b and Part 6. The third
is for the firmware's owners. The fourth was found later and decided by the PM and the author together, as the
maintainer asked (2026-11-26): Part 7. None changes Parts 1 to 3 as written.

1. **A quiet card, looked at again when its turn ends:** Part 2b.
2. **An outside Claude Code session's question form and plan approval:** Part 6.
3. **One place decides the ring: taken by the firmware's owners** (2026-11-26). The firmware drops its face rule
   (Part 2, "The dial's own rule") and rings as the frame the devices send says, its Sound setting the one thing it
   still weighs. Their pull request and its release are theirs to schedule. Once it ships, a question, a permission
   ask or a failed turn of the agent on the dial's face rings as anywhere else, which is this design's rule for them.
4. **A Codex session outside a pane: no wait reaches the dial:** Part 7.

## Left to the builder

- The exact words of the skill and the line, within the rules above; the eval decides.
- The crowd's skills and instructions file; the ten scenarios' repos, checks and split ids.
- How a pass confirms the dial's description reached the model, and which documented setting makes `name-only`.
- How the tally line says a notice was held quiet, without breaking the end-to-end checks that read it.
- How the limits take a quiet card for its agent and not for the hour.
- Which dial's shown agent counts when several dials are attached.
