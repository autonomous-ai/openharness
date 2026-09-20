---
name: roundtable
description: Run a decision through a panel of coding agents from different vendors — writing the motion, seating the room, the sealed-openings protocol, tagging the claim map, pressing a split, and writing a decision that picks and keeps its dissent. Read before opening a room.
---

# roundtable

A room here is a **decision being made**, not a debate being staged. Four agents from four vendors
research the question independently, argue about what they found, and the person watching walks away
able to act. This skill is the craft of running that room. Read it once, then open one.

## 1. The motion

A motion is not the user's question repeated. It is the question made decidable. Three parts, and
all three go in `motion.md`:

- **The decision, in one line.** A real fork. "Should the Windows port be native, or WSL2?" is a
  motion. "Thoughts on Windows?" is a topic, and a topic produces four essays nobody reads.
- **The constraints that make it hard.** Who is doing the work, what already exists, what it costs
  to be wrong. This is where a room gets its teeth — without it every seat answers the generic
  version of the question and they all agree.
- **What would settle it.** Name the evidence that would end the argument. It tells the seats what
  to go and look for, and it tells you afterwards whether the room actually did the work.

If the user's first message has only part of this, write the rest yourself and let them correct it.
A motion on the page beats an interview.

**Point the room at evidence.** `--evidence <path>` gives every seat read access to the real thing —
the repository, the folder, the data. It is the difference between four models arguing about your
decision and four models arguing about decisions like yours. Use it whenever the subject is
something on disk.

**Scope the evidence tightly.** Hand a seat a whole monorepo and some engines will read it until the
timeout and answer nothing at all, while others skim four files and answer well — and you will have
learnt about their search strategies instead of about your decision. Name the folder the question
turns on. The seats are told to time-box their reading to roughly 70% of `--timeout`, but that only
works if the pile is finite.

## 2. Seating the room

| Preset | Seats | When |
|---|---|---|
| **Panel** (default) | 3–4 vendors, no stances | "what do they actually think" — nearly always the right room |
| **Red team** | one proposal in the motion, every seat told to break it | a decision you have already made and want attacked |
| **Trial** | two seats with opposed stances, one seat as judge | a binary call that costs real work either way |

Rules that matter more than the preset:

- **Two vendors minimum.** Three or four is the good room. Four seats of the same engine is a
  mirror with extra steps — if only one vendor is installed, say so plainly and run it anyway, but
  do not pretend it is a panel.
- **Stance ≠ engine.** They are separate axes. Keep them separate so that when the room splits you
  can tell whether the split came from a different model or from a role you assigned. If you assign
  stances, put that in the chat: an assigned position is not a belief.
- **Absent is fine.** A vendor that is not installed or not logged in shows as an empty cell with
  the reason. Never quietly drop it from the seating — the missing vendor is information.

## 3. The rounds

`room run opening` → `room run cross` → `room run converge`. All seats run **at once**, so a round
costs the slowest seat, not the sum. What each round asks for is already in the prompts; what you
control is when to stop.

**Openings are sealed.** Seats run outside the workspace and cannot read each other's files. This is
the load-bearing rule: in any shared-context loop these agents converge on whoever spoke first,
politely and fast, and four voices agreeing teaches nothing. If someone asks you to "let them
discuss it", explain what that costs and offer another round instead.

**Stop after cross-examination.** Report the split and ask the chair what to press. A room that runs
start to finish without the user is a report, and they could have got a report from one agent.

**Pressing a point** is a new round on a narrowed motion, not a private chat with one seat: amend
`motion.md` with what the chair wants settled, then run `cross` again. The pane keeps both passes.

## 4. The claim map

This is the artifact most people actually read, and it is yours. After the openings, write
`claims.json`: five to eight claims the room turns on, each in the seats' own words, each with a
vote per seat (`agree` / `disagree` / `silent`).

- **Extract, don't invent.** A claim must be traceable to a line someone wrote.
- **`silent` is a verdict.** A seat that never engaged did not agree. Marking silence as agreement is
  the fastest way to fake consensus.
- **Sharp beats fair.** "WSL2 users lose native file-watching performance" is a claim. "There are
  tradeoffs around performance" is not, and it will be `agree` from everyone, which tells the chair
  nothing.

Rows where everyone agrees are settled — the chair can stop thinking about them. Rows that split are
the decision. That contrast is the whole point of the table, so keep the claims at a grain where
both kinds appear.

## 5. The decision

`decision.md` has four parts and no more:

1. **The call.** One line. Pick. "Both have merit" is not a call.
2. **Why, in the room's terms.** Quote the seats. If you are relying on a claim only one seat made,
   say which seat and that it stood alone.
3. **What it costs if this is wrong**, and the earliest signal you would see.
4. **The dissent, by name.** "`codex` still holds that the daemon is only incidentally tmux-shaped,
   and would be right if `probeDsh` is the only place that scans panes." Never delete the losing
   argument; a decision you can reopen in six months is worth more than one that reads clean.

Then `room decide`. The verdict goes `ready` only when a decision exists and every seat answered
every round — a room that entertained and decided nothing is not done.

## 6. What a good room looks like from the chat

Four lines to open. Silence while a round runs. Then the split, quoted, with the pane pointed at.
Never retell the transcript — it is on screen beside you, and retelling it turns a room back into
the single-agent answer the user was trying to get away from.
