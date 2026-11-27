# Dial notice cards: the agent closes its own, up to 5 waiting a session

Status: approved by the maintainer (2026-11-27), approach A. Follows "Needs you, right"
([design](2026-11-26-needs-you-right-design.md)); built after its Part 5, which reads the same cards.

## Why

On 2026-11-27 an agent rang the dial for a decision (the dial log shows the question and its beep). A minute later
another agent's message reached that session, its next turn started, and the devices closed the card as answered
(`services/devices.ts`: every `turn-start` of an outside agent ends its notice). The maintainer looked at the dial, saw
nothing and never answered. The same close counted the card as "answered in 10 minutes".

Harness cannot tell from a turn's start whether the person answered. The agent can: it reads the answer. So the agent
closes its cards, and Harness stops guessing (the maintainer: "Harness không tự đóng thẻ, dial skill handle đóng thẻ và
do agent tự phán đoán").

## Goals

- A card stays on the dial until its agent says the person answered, the agent is gone, or it is 24 hours old.
- An agent can have up to 5 waiting asks open at once; none hides another.
- The agent sees its own open cards and closes the right one.

Non-goals: several rows of one agent at once on the dial (approach B: firmware and protocol, the device's owners);
a dismiss gesture on the dial (firmware); an agent closing another agent's cards.

Anti-goals: a card that vanishes before the person saw it; a ring for a card the person already answered.

## The rules

1. **Waiting cards** (`--waiting`): at most 5 an agent, oldest first. A 6th drops the oldest.
2. **Other cards** (`--proceeding`, plain): one an agent, the newest, as today.
3. **The dial shows one card an agent**, as today: the oldest waiting card, else the other card. Its line ends with
   its place when there are more, for example `(1/3)`. The protocol and the firmware do not change: one question an
   agent (`cable/notices.ts` `held`).
4. **Rings.** A card rings when it reaches the dial, under today's rules: Part 2's present rule holds it quiet, Part
   2b rouses a quiet one once, the hour's 20 apply. A waiting card that comes up because the one before it closed does
   not ring: the person was already rung for that agent. It shows on the dial and in the drawer.
5. **Who closes a card.**
   - The agent: `harness device notify --done <id>` or `--done all` (below).
   - Harness, only where the agent cannot: the agent is gone (its session ended or no list holds it: `notices.look`,
     `agent_deleted`, `session-end`), the card is 24 hours old (now for a live card too, not only at restore), and the
     person's tap on the card of an agent no list holds (`tappedUnlisted`, as today). A Harness agent's cards when the
     dial detaches, as today (`detached`).
   - **Removed for waiting cards:** a card ending because its agent's next turn started (`services/devices.ts` the
     observed `turn-start`, the Harness `turn_started` frame and a listed agent going busy; `notices.working` for a
     restored card).
   - **Other cards** (`--proceeding`, plain): closed by the person's own next prompt to that agent (typed, or spoken
     through the dial), never a relayed one, as before; and by a newer card of the agent that replaces it (the PM,
     2026-11-27, after the final review: "not need-you cases stay as before, latest notice"). Known limit: a Harness
     agent's `turn_started` cannot tell the person's prompt from a relayed one, so its other card goes only when
     replaced, at `--done`, or at 24 hours.
   - Nothing else closes a card.
6. **Across agents:** the pending total stays at 20 (`NOTICES_PENDING_MAX`), the oldest dropped first.
7. **The place** is `(1/m)`: the card shown is always the agent's first open card, `m` all its open cards, waiting and
   other; no place when `m` is 1 (the PM, 2026-11-27).
8. **Turn ends while any card is open** stay silent, as a pending card's do today (`rule:notice`), so a recap never
   takes the card's drawer row and the turn that rang does not ring again at its end; a failed turn still rings. With
   waiting cards outliving turns, that can last until the agent closes its card or 24 hours (the PM, 2026-11-27).
   Other cards close at the person's own prompt (rule 5), so for them it is as before; a Harness agent's other card
   can keep its turn ends silent until it is replaced, closed or 24 hours old (the known limit in rule 5).
9. **Harness Pro** drops an agent's question whenever that agent leaves the asking state, in its firmware
   (`pod_model.c` `set_state`): at a turn start, a turn end (`turn.done`, `turn.error`) and a live `summary`. The
   devices give the card shown back to a Pro after each of those frames of its agent, held, never asked: no ring. The
   round dial, which keeps the card, gets nothing again: a question frame there rings (the PM, 2026-11-27; the turn
   end and summary added after the final review, the same cause).

## The agent's commands

Each names only the caller's own cards, found as `notify` finds its caller (engine, session, folder: `noticeCaller`).
Typed by hand outside an agent's session, they name nothing.

- `harness device notify --list`: one line a card, oldest first: its id (8 characters), its age, its kind and its
  line. `--json` for the same as an array. None: nothing printed, exit 0.
- `harness device notify --done <id>`: closes that card. `--done all`: closes every card of the caller. A card that is
  not there, or not the caller's: nothing happens, exit 0, so an agent that lost track after a compaction can run it
  safely. The next waiting card, if any, comes up on the dial without a ring (rule 4).
- `notify` prints the new card's id with its result (`shown <id>`), so the agent can close it without a list.

They go to the devices' own listener, as `notify` does; the core does not change.

## The dial skill

One bullet in the skill's body, after the ring rules, under the 4096-byte limit (the description does not change):

> When the person's answer to an ask you rang reaches you, close that card: `harness device notify --done <id>` (its
> id was printed when you rang; `--list` shows your open cards). A message from another agent or session is not their
> answer.

Its words are measured and hill-climbed before they ship (below); the bullet above is the starting text.

## Eval and hill-climb (the maintainer, 2026-11-27: "làm luôn eval và hillclimb")

The card logic (5 kept, the 6th dropping the oldest, `(n/m)`, `--list`, `--done`, 24 hours) is code with one right
answer: unit tests hold it. What the eval measures is the agent's judgment, which now alone closes a card.

- **Harness:** the dial-skill eval (`cli/evals/dial-skill/`), Claude Code only, with a second turn: turn 1 is a
  scenario where the agent rings; turn 2 resumes the same session (`claude -p --resume`) with one of the follow-ups
  below. The fake `harness` answers `notify` with `shown <id>`, keeps the cards and answers `--list` and `--done` as the
  product does, and records each call.
- **Follow-ups**, each scenario split train, val and test as today:
  1. the person's answer to the ask: close that card;
  2. another session's message on something else (a cross-session message, as on 2026-11-27): close nothing;
  3. the person's new request that leaves the ask open: close nothing;
  4. two asks rung, the person answers one: close that one alone, by its id;
  5. the person's answer to an ask that was never rung: no error, nothing wrongly closed.
- **Gates, held out (val and test pooled):** right close on (1) and (4) at least 90%; a wrong close (2, 3, the other
  card of 4, or a close in turn 1 before any answer) at most 1; the ring itself no worse than v4 in `crowd`: recall not
  down beyond noise and at most one more needless ring (the body changed, the description did not).
- **Hill-climb:** the body bullet only (the description stays v4's), at most 2 rounds in `crowd` on train and val,
  designed from train and val traces only; test is read once, as counts. If no text passes, the starting text ships
  only if it meets the wrong-close gate; otherwise the PM brings the numbers back before anything ships.
- **Cost and cap:** about $25 for the first held-out pass and about $15 a round. The design's cap goes from $270 to
  $320 for this (the maintainer approved about $30 for the eval and asked for the hill-climb too; the author's call is
  $50 in all). Over it, the pass stops and reports.
- Rows keep counts only, as the eval's other rows: no transcript text, path or name in a commit or pull request.

## Data

- `dial-notices.json` keeps several cards an agent (each with its id, kind, line and time); the 24-hour rule applies
  to live and restored cards alike. At most 20 cards, as today.
- Counts: no new name. `dial_notice_answered_10m`, and its quiet share `dial_notice_present_answered_10m`, count a card the agent closed within 10 minutes of showing it (an other card: also the person's own prompt within 10 minutes, as before), not a
  turn start. A card dropped by rule 1, by 24 hours or by its agent leaving counts as gone.
- Logs: fixed words only (`[device] notice · done`, `· dropped · sixth`, `· expired`), never a line, id or session.

## Tests (red first)

`cable/notices.spec.ts`: 5 waiting cards kept, the 6th drops the oldest; a proceeding card replaces only the other
card; the dial shows the oldest waiting card with `(n/m)`; closing it brings the next up without a ring; a turn start
(observed, Harness, relayed or not) closes nothing; 24 hours closes a live card; restore keeps several an agent.
`devices/notice.spec.ts` and the listener: `--list`, `--done <id>`, `--done all`, another agent's id, a missing id,
`shown <id>`. `services/devices.spec.ts`: the answered count follows `--done`, not the turn start. The skill's spec:
the bullet is in the body and the file stays under 4096 bytes.

## Release

CLI only, after the eval's verdict and after Part 5 merges (both touch how a card ends: Part 5's `rangThisTurn` stays as it is). Platforms: macOS,
Linux, Windows (the listener's pipe on Windows, as `notify`'s).
