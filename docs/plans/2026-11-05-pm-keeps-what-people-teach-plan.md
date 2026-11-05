# PMs keep what people teach them: Implementation Plan

Way of working: the project's Engineer role (test first, by plan task; one review on the pull request). No execution handoff.

**Goal:** A person never has to teach a project's PM the same thing twice. The PM saves a correction or a lasting rule in
the same turn, naming who said it; the Swarm's 30-minute wake also asks it to catch what it missed from people's messages;
the instructions are tidied once a day so they get shorter, not longer; a PM never runs below high effort; repeats are
counted in the nightly reflection, so the measure is visible.

**Architecture:** All in the backend's built-in PM schedule (`pmSchedule.ts`, #2946). The built-in section every
coordinator reads gains the rules for what people teach it. The wake gains two jobs beside the open-task sweep: "people
wrote to you" (a person messaged the coordinator since its last wake: counted from message metadata, never by reading
words) and the daily tidy (a new local day and the instructions changed since the last tidy). The coordinator's start and
switch refuse an effort below high (`leadStart.ts`).

**Tech Stack:** TypeScript backend, vitest.

**Spec:** task #3022 as River amended it on 2026-11-05 after Ken's proposal: no separate 3-hour job; each 30-minute wake
reads only people's messages since the last wake; tidy once a day or past about 150 lines; effort high or above; nightly
reflection counts repeats.

## Global Constraints

- No keyword matching in the backend: "a person wrote to the coordinator" is a person-authored message (no `source`) in
  the project chat, threads included, or one naming the coordinator in another chat of the project.
- Nothing new is written while nothing is due: the head moves only when a wake is written (#2946 review).
- A wake held back because the last one is still unread records only its slot; the people and tidy jobs stay due.
- The built-in heading is unchanged (`## Built-in PM schedule (from the Swarm)`): saves refuse it, and old CLIs key on it.
- Effort floor: `minimal`, `low` and `medium` are refused on `lead.start` and `lead.switch`; a switch naming a model and
  no effort gets `high`. Codex PMs named with no model keep their engine's own model and effort (the host applies an
  effort only with a model).
- The daily tidy counts revisions after the first document (revision 1), so a new project is not woken to tidy a template.
- Built-in text is product copy: short and plain (docs/naming-system.md).

## Review Focus

1. A person's thread reply in the project chat wakes the PM; a person's message in a task chat that does not name the
   coordinator does not.
2. A held-back wake (the last one unread) does not consume the people or tidy job.
3. The daily tidy runs once per local day, only after the instructions changed.
4. `lead.switch` with no effort and a model gets `high`; with `medium` it is refused and changes nothing.

## Tasks

### Task 1: the built-in text (pmSchedule.ts PM_SCHEDULE_TEXT)

Files: `backend/src/superTabs/pmSchedule.ts`, `backend/src/superTabs/pmSchedule.test.ts`.

- [ ] Test: the section tells the PM to save a correction or lasting rule in the same turn, before answering, naming who
  said it, without asking; to tidy past 150 lines; to count repeats in the nightly reflection. Watch it fail.
- [ ] Write the text. Watch it pass.

### Task 1b: two more lines (River, 11-05, from a case on lamp)

- [ ] Test: the section says the PM never writes code itself, even when asked directly, and that the project's instructions
  outrank the repository's agent files (CLAUDE.md, AGENTS.md); on a conflict it follows the instructions and says so.
- [ ] Write the lines.

### Task 2: the coordinator hears people (parts/commit.ts numberMessages)

Files: `backend/src/superTabs/parts/commit.ts`, `parts/commit.test.ts`, `model.ts` (`heardAt` on the lead conversation),
`parts/light.ts` (field placed as unread).

- [ ] Test: a person's message in the project chat (main or thread), or naming the coordinator in a task chat, sets the
  project chat's `heardAt`; an agent's, a system row, or a person's message to another agent does not. Watch it fail.
- [ ] Implement. Watch it pass.

### Task 3: the wake's new jobs (pmSchedule.ts scheduleRequest, store.ts)

Files: `backend/src/superTabs/pmSchedule.ts`, `pmSchedule.test.ts`, `projects.ts` (`schedule` fields), `store.ts`
(records what the wake carried).

- [ ] Tests: wakes when a person wrote to the coordinator since the last wake and nothing else is due; not when nobody
  did; the daily tidy is due once a local day only after a new revision; each job's line is in the wake; a held-back wake
  keeps the people and tidy jobs due. Watch them fail.
- [ ] Implement `scheduleRequest` returning the jobs it carries, and record `heardAt` / `tidiedOn` / `tidiedRevision` only
  when the wake is written. Watch them pass.

### Task 4: the effort floor (leadStart.ts, commands.ts lead.start / lead.switch)

Files: `backend/src/superTabs/leadStart.ts`, `leadStart.test.ts`, `commands.ts`.

- [ ] Tests: `lead.start` and `lead.switch` with `medium` or `low` are refused with `EFFORT_TOO_LOW` and change nothing;
  `high`, `xhigh`, `max` pass; a switch naming a model with no effort asks for `high`. Watch them fail.
- [ ] Implement `leadEffort` in leadStart.ts and call it from both commands. Watch them pass.
