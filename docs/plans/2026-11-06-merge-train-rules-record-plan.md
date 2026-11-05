# Merge train reads the project rules record Implementation Plan

> **For agentic workers:** implemented the project's way (project instructions, Engineer): task by task, each failing test
> committed before the code that passes it; one review and one security review on the pull request.

**Goal:** The merge train (#3402) decides which reviews a change needs, and whether it runs at all, from the project's rules
record (#3393, on main), not from its own copy, so one rules edit changes both the review steps and what the train waits for.

**Architecture:** The train's review gate calls `requiredReads(rules, files)` and `testsFor(rules, files)` from
`backend/src/superTabs/policy.ts`, and reads the record per project with `currentRules(db, tabId, projectId)`
(`policyStore.ts`; the seed at revision 0 when nothing is saved). Its switch and interval come from `rules.mergeTrain`.
The train's local table, matcher and constants (as Train described them: `mergeTrain/config.ts` and a constant list of
security paths needing two reads) are deleted. A changed-file list the train cannot read stays `null`, which the helpers
treat as the most reads any row asks: fail closed.

**Tech Stack:** TypeScript, Vitest, Prisma on MongoDB (backend).

**Spec:** Task #3475's brief (River, anh Dee's Swarm redesign, 11-06). Interfaces: `policy.ts` and `policyStore.ts` on main;
the train as merged from #3226 (read on main once it lands; its branch is Team-written and is not checked out before).

## Global Constraints

- PR body first line: "Requested by Dee through Harness."
- Owns the merge train (`backend/src/superTabs/mergeTrain/`, where it landed, and `backend/src/github/train.ts`) and its wiring in `backend/src/worker.ts`; `policy.ts` is used, not changed.
- Built from main only after #3226 merges; started blocked until then.
- No path may let the train merge with fewer reads than the rules require: an unreadable rules record or file list fails
  closed (holds the batch), never falls back to fewer reads.

## Review Focus

- Rules record unreadable (database error): the train holds; it does not use the seed's numbers in place of a saved record.
- Changed files unknown (GitHub read fails, or a file list cut off): most reads of any row, as `requiredReads(rules, null)`.
- The train and the review steps disagree on a file (the old local matcher's rules differed, e.g. the folder boundary,
  #3237): both now call one matcher, and a test pins them to the same answer on the same files.
- A rules save between planning a batch and merging it: the train re-reads the record at merge time, or pins the revision
  it planned with and refuses if it moved (decided after reading the train's code).
- Merge train switched off in the rules record: no batch starts; one in flight finishes or stops as the train defines.

---

### Task 1: The train reads the record
**Files:** `backend/src/superTabs/mergeTrain/` (plan.ts, config.ts, train.ts, run.ts and their tests), `backend/src/worker.ts` (the reader).
- [ ] Failing tests: a saved record with a new two-read area makes the train wait for two reads on a file there; with no
  record the seed applies; an unreadable record holds the batch; `mergeTrain.enabled` false starts nothing.
- [ ] Code: call `currentRules`/`requiredReads`/`testsFor`; delete the local table, matcher and constants.

### Task 2: The train and the review steps agree
**Files:** `backend/src/superTabs/mergeTrain/rulesRecord.test.ts`.
- [ ] Failing test: for the seed and for a saved record, over a fixed set of changed-file lists (security paths, tests-only,
  Desktop, unknown), the train's required reads equal what the review steps plan (`requiredReads`, or `reviewPlan` if
  #3227 is on main by then).
- [ ] Code: any remaining divergence removed.
