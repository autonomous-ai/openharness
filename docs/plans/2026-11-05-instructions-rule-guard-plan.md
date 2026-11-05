# An instructions save can't silently drop a person's rule (task #3151) — plan

> Written by writing-plans and implemented by its Engineer test first (test-driven-development), as the project's
> instructions describe. No Execution Handoff.

**Goal:** A project's PM can no longer drop a person's rule, or the "(person, date)" that says who gave it, on its own
judgment. The server refuses such an `instructions.save` and lists each dropped rule and its person. The save goes through
when that person makes it, or when it names that person's own approval message for each drop. The person is then told in
one private line.

**Architecture:** Pure check in `instructionsDiff.ts` (`attributedRules`, `droppedRules`) over the items the chat-line
diff already parses. `commands.ts` `instructions.save` runs it against the base revision the store already reads, and
judges approvals from `context.approvals`, which the store loads by id. Notices reuse `person.tell`'s path (the person's
one Buddy chat and their older project Buddy chat). `pmSchedule.ts` text changes.

**Tech Stack:** TypeScript, zod, vitest, the backend's command reducer (`applyCommand`) and Prisma store.

**Spec:** task #3151 (Ken, 11-05, from lamp): revision 70 → 71 dropped Leo's "promote back within the hour" rule and the
"(0xken15, 4 Nov)" attribution of a rule it kept, with no check.

## Global Constraints

- No new settings. No new stored data: the check reads the two texts the save already holds.
- Attributions parsed robustly: names and usernames, `2026-11-04`, `11-04`, `4 Nov`, `Nov 4`, several people
  (`Ken and Dee`, `Ken, Dee`, `Ken, 11-02; Dee, 11-03`), a note after the date (`Ken, 2026-11-04: ...`), honorifics
  (`anh Dee`).
- A rule reworded with the same person and the same meaning passes. Can't tell → refuse and list it.
- Swarm code stays out of `cli/src/core`. Temp files only in `mktemp -d` folders.

## Design

- growth: N/A because nothing is stored; the check runs on the two texts of one save.
- concurrency: N/A because it runs inside the save's existing transaction and revision check.
- read cost: one indexed read of the named approval messages (by id, at most 20), only when a save names them.
- scale: 64 KB documents (~1,000 items): segments × items word-set compare, well under a millisecond per save at today's
  size, under 50 ms at 10x. Warns first: save latency on the instructions route.
- compatibility: `approvals` is optional; an older CLI's save without it is checked the same way and refused with the list,
  which its PM reads as text. `rule.set` only appends, so it can't drop a rule.
- migration + rollback: none; reverting the code removes the check.
- audience: the server enforces it; the person's identity comes from the sender or the stored message's author, never the
  caller's word.
- identity: approval is the stored message's author (a person, own words, no source), never `askedBy`.
- failure: a refusal names every dropped rule and its person; never a silent pass.
- platforms: server only.

## Review Focus

- False negatives: can a real drop or meaning change pass as a "reword" (negation, numbers)?
- False positives on ordinary tidies (merge of two rules, reflowed lines, renumbered steps, moved sections).
- Approval: only that person's own message counts; a Buddy's line, an agent's, `askedBy` or another person's don't.

## Task 1: Parse attributed rules and find the dropped ones

**Files:** `backend/src/superTabs/instructionsDiff.ts`, `backend/src/superTabs/instructionsDiff.test.ts`

**Interfaces:**
```ts
export interface AttributedRule { text: string; people: string[]; attribution: string }
export interface DroppedRule extends AttributedRule { why: 'removed' | 'unattributed' | 'changed' }
export function attributedRules(text: string): AttributedRule[]
export function droppedRules(before: string, after: string): DroppedRule[]
```

- [ ] Failing tests: parse `(Ken, 2026-11-02)`, `(0xken15, 4 Nov)`, `(Scholes, 11-04)`, `(anh Dee, 2026-11-04)`,
  `(Ken, 2026-11-04: note)`, `(Ken and Dee, 11-03)`, two clauses with `;`, a heading's attribution; ignore
  `(design, Identity)`, `(measured 2026-11-02 on the Mac Studio)`, `(Ken)`.
- [ ] Failing tests: removed rule → `removed`; same text without its attribution → `unattributed`; merge of two rules with
  both attributions → none; reflow/renumber/move → none; light reword with same person → none; a negation or number
  change → `changed`.
- [ ] Implement: segments of each item end at an attribution; content-word coverage (≥ 0.75) plus equal polarity words
  and numbers decide a reword.

## Task 2: Refuse the save, accept approvals, tell the person

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/store.ts`, `backend/src/superTabs/instructions.test.ts`

**Interfaces:** `instructions.save` gains `approvals?: string[]` (message ids, at most 20). `CommandContext.approvals?:
{ id; author: Author; source: boolean }[]`. Refusal `INSTRUCTIONS_RULES_DROPPED` (409) with `details.dropped:
[{ rule, people, why }]`.

- [ ] Failing tests (the task's checks): a drop is refused listing it; an attribution-only drop is refused; a merge keeping
  both attributions is accepted; a drop approved by the rule's person goes through and that person gets one private
  line; the person saving it themselves needs no approval; `askedBy`, another person's or an agent's message don't
  approve.
- [ ] Implement in `commands.ts`; the store loads the approval messages and the approvers' Buddy chats.

## Task 3: The PM's built-in text

**Files:** `backend/src/superTabs/pmSchedule.ts`, its test.

- [ ] Failing test: the tidy and teaching text say never to drop or weaken a person's rule on the PM's own judgment, even
  one it thinks can't be done; ask that person and keep the rule until they answer; name their approval message.
- [ ] Change the text.
