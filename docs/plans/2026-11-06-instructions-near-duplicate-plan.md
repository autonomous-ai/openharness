# Instructions save refuses a reworded repeat — Plan (task #3568)

**Goal:** Saving a project's instructions refuses an added line that says what an existing line already says, reworded or
not, quoting the existing line; a person may force the save by giving a reason.

**Architecture:** #3283 already refuses a line with the same content words in the same order (`repeatedRules`,
`refuseRepeats`). This adds a second match to `repeatedRules` (same content words in any order, up to a set similarity, with
no changed negation, limit or number), and an optional `repeatReason` on `instructions.save`, honoured only from a person.
No stored data, no new state.

**Tech Stack:** TypeScript, vitest (backend `src/superTabs/`).

**Spec:** the task brief (#3568). Way of working: this plan's tests first, then the code; no subagent-driven development.

## Global Constraints
- Backend only; nothing in `cli/src/core`.
- A line changed in substance (negation, limit such as "unless"/"only", a number) is never a repeat; the #3283 tests keep passing.
- Only a person forces a save; a coordinator's `repeatReason` is ignored and the refusal stands, saying a member decides.
- The reason is kept in the revision's summary, so the History shows the repeat was meant.

## Review Focus
- False positives of the similarity (a long line with one word swapped) and that the guard words stop them where meaning differs.
- That an agent cannot force a save.

## Task 1: Reworded repeats (`instructionsDiff.ts`)
**Files:** `backend/src/superTabs/instructionsDiff.ts`, `instructionsDiff.test.ts`
**Interfaces:** `repeatedRules(before, after)` unchanged; finds also a near-duplicate (word set Jaccard ≥ 0.85, ≥ 6 words, no
guard word in the words that differ).
- [ ] Failing tests: reordered/reworded line is found, a changed guard word/number is not, a different rule is not.
- [ ] Code: similarity fallback after the exact lookup.

## Task 2: Person's forced save (`commands.ts`, `ruleGuard.ts`)
**Files:** `backend/src/superTabs/commands.ts`, `ruleGuard.ts`, `instructions.test.ts`
**Interfaces:** `instructions.save.repeatReason?: string (1-150)`; `refuseRepeats(before, after, forced?)`.
- [ ] Failing tests: reworded repeat refused with the line quoted; new rule passes; a person's save with a reason passes and the
      summary keeps it; a coordinator's save with a reason is still refused.
- [ ] Code.
