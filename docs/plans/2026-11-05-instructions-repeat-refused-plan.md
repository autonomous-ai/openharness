# An instructions save refuses a rule that's already there (task #3283) — plan

> Written by writing-plans and implemented by its Engineer test first (test-driven-development), as the project's
> instructions describe. No Execution Handoff.

**Goal:** A PM that saves a line repeating one the document already has is told so, with the existing line quoted, instead
of the repeat being added as if new (lamp, 11-05: Faye was assigned a check against a rule already in its instructions and
saved the same rule again, which hid that it had skipped it).

**Architecture:** A pure check `repeatedRules(before, after)` in `instructionsDiff.ts` over the items and segments that file
already parses (case, punctuation, list markers, wrapping, attributions and stop words already normalised into a segment's
content-word sequence). `ruleGuard.ts` wraps it as `refuseRepeats`, which fails with `INSTRUCTIONS_RULE_REPEATED` (409)
naming each repeat and the existing line. `commands.ts` `instructions.save` calls it beside `allowedDrops`.

**Tech Stack:** TypeScript, vitest, the backend's command reducer (`applyCommand`).

**Spec:** task #3283 (River, from Leo and Guide2's #3069 proposal).

## Global Constraints

- Conservative: a line is a repeat only when its content-word sequence equals an existing line's, in order. Any changed,
  added or removed content word, negation or number is a change of substance and saves.
- Only lines the save adds or rewrites are checked (an item word-for-word in the old text is never new). The existing line
  must be one the save keeps. Headings and lines under 4 content words are never repeats.
- A repeat counts within a section, or between two attributed rules anywhere (a rule is one rule, whoever repeats it).
- Server only. No new stored data, no new settings. Swarm code stays out of `cli/src/core`. Temp files only in `mktemp -d`.

## Design

- growth: none; no stored data.
- concurrency: N/A; runs inside the save's existing revision check, on the two texts it already holds.
- read cost: none added; segments of two documents, once per save.
- scale: a 64 KB document is ~1,000 items; one pass builds a map from sequence to items, linear in the document.
- compatibility: an older client's save is refused with the same text its PM reads; `rule.set` only appends one new rule and
  is not checked here.
- migration + rollback: none; reverting the code removes the check.
- audience: the server enforces it for every writer, person or agent.
- identity: N/A. failure: the refusal names every repeat and its existing line, and how to change it if a change was meant.
- platforms: server only.

## Review Focus

- False positives: a rule changed in substance (negation, number, one content word) or a legitimate same-words line in
  another section must save.
- False negatives: the incident's shape (same rule, new attribution/case/punctuation) must be refused.

## Task 1: `repeatedRules` in instructionsDiff.ts

**Files:** `backend/src/superTabs/instructionsDiff.ts`, `backend/src/superTabs/instructionsDiff.test.ts`

**Interfaces:**
```ts
export interface RepeatedRule { added: string; existing: string }
export function repeatedRules(before: string, after: string): RepeatedRule[]
```

- [ ] Write failing tests: exact repeat, case/punctuation/attribution repeat, rewrapped and renumbered repeat; changed
  negation or number is not a repeat; an unchanged document and a moved item are not; a line the save removes is not "kept".
- [ ] Run them, see them fail. Commit the tests.
- [ ] Implement; run them, see them pass. Commit.

## Task 2: Refuse it on `instructions.save`

**Files:** `backend/src/superTabs/ruleGuard.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/instructions.test.ts`

**Interfaces:** `refuseRepeats(before: string, after: string): void` fails `INSTRUCTIONS_RULE_REPEATED`, 409, details
`{ repeated: { added, existing }[] }`.

- [ ] Write failing tests through `applyCommand`: a repeat is refused with the existing line quoted and nothing saved; a
  changed rule saves; a save of the same rule only reworded in place (not a second copy) saves.
- [ ] Run, see them fail. Commit the tests.
- [ ] Implement and wire in `commands.ts`; run, see them pass. Commit.
