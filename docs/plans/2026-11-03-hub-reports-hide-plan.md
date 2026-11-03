# Hub: three reports hide an item from everyone — Implementation Plan

> **For agentic workers:** this plan is carried out by the task's Engineer, task by task, test first, as the project's
> instructions (Engineer role) say. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A harness or comment that three readers reported is hidden from every reader, including rows of
`community_hidden` written before the fix (no `restoredAt` field at all).

**Architecture:** `fileReport` creates the hide row with `restoredAt: null` written out, and the two readers
(`hiddenFrom`, `isHiddenFrom`) filter on "not restored" as null **or** absent, the `machineAlive` pattern of
`lib/prisma.ts`, so old rows need no migration. The route unit tests' fake table stops supplying `restoredAt: null`,
so it shows Mongo's behavior; a new integration test runs the same flow on a real Mongo replica set.

**Tech Stack:** TypeScript, Prisma (MongoDB), Vitest, mongodb-memory-server (`planDatabase`).

**Spec:** Task #2299 brief (Super Tab conversation f90ee44a6662554cfaa30431), requested by diego@autonomous.ai.

## Global Constraints

- PR body first line: "Requested by diego@autonomous.ai through Harness."
- Before Ready: a test that fails without the fix for every risk named, red/green evidence in a PR comment, and the
  full Super Tab integration suite (`npm run test:super-tabs` in backend/).
- Never run a test that signs the Mac out of the real CLI. Stop only processes you started, by id. Temp files only in
  mktemp -d folders.
- Owns: backend/src/lib/communityReports.ts, backend/src/routes/community.test.ts, backend/integration. One line in
  backend/vitest.super-tabs.config.ts adds the new test file to the suite.

## Review Focus

- A restored row (`restoredAt` a date) must stay visible: the "absent" branch must not match it (`isSet: false` only).
- A reporter still stops seeing what they reported at once, before the third report.
- After a restore, three new reports hide it again (the upsert's update path), and older reports don't count.
- `hiddenFrom` scoped to one harness (`harnessId`) lists a hidden comment on that harness and not one on another.
- A hide row without `restoredAt` in a later report: `fileReport` treats it as hidden (returns early, no second Slack
  post) — it already does, since Prisma reads the absent field as null.

---

### Task 1: Hidden from everyone, on real Mongo

**Files:**
- Create: `backend/integration/communityReports.test.ts`
- Modify: `backend/vitest.super-tabs.config.ts` (add the file to `include`)
- Modify: `backend/src/lib/communityReports.ts:16-32` (readers), `:66` (create)
- Modify: `backend/src/routes/community.test.ts:21` (fake `isSet: false` matches only an absent field), `:85` (drop
  `defaults: { restoredAt: null }` from `communityHidden`)

**Interfaces:**
- Consumes: `planDatabase(prefix)` from `integration/plans.test-support.ts`; `fileReport`, `hiddenFrom`,
  `isHiddenFrom` from `src/lib/communityReports.ts` (signatures unchanged).
- Produces: nothing new for other code; a module-private `notRestored` where-input
  (`{ OR: [{ restoredAt: null }, { restoredAt: { isSet: false } }] }`).

- [ ] **Step 1: Write the failing integration test** — `src/lib/prisma.js` mocked to the `planDatabase` client (the
  `harnessSharesList.test.ts` pattern). Cases:
  - `three reports hide a harness from readers who did not report it`: r1, r2, r3 report harness `h1`;
    `isHiddenFrom(env, 'harness', 'h1')` and `(…, 'h1', 'stranger')` are `true`; `hiddenFrom(env, 'harness')` and
    `(…, 'stranger')` contain `h1`.
  - `three reports hide a comment from readers who did not report it`: the same for comment `c1` on `h1`, and
    `hiddenFrom(env, 'comment', undefined, 'h1')` contains `c1`.
  - `a hide row stored without restoredAt hides it too`: raw insert into `community_hidden` with no `restoredAt`;
    anonymous and stranger see it hidden in both readers.
  - `two reports hide it only from those who reported it`: anonymous and r3 not hidden; r1 hidden.
  - `a restored item is shown until three new reports`: restored row (date) is visible; three later reports hide it.
- [ ] **Step 2: Run it, watch it fail** — `npx vitest run --config vitest.super-tabs.config.ts integration/communityReports.test.ts`.
  Expected: the three "hide" cases FAIL (`expected false to be true`), the others pass.
- [ ] **Step 3: Make the route unit fake honest** — fake `isSet: false` matches only `undefined`; drop the
  `restoredAt` default. Run `npx vitest run src/routes/community.test.ts`: expect the report-hiding cases to FAIL as on Mongo.
- [ ] **Step 4: Commit the failing tests.**
- [ ] **Step 5: Fix `communityReports.ts`** — `notRestored` in both readers; `create: { ...key, harnessId, restoredAt: null }`.
- [ ] **Step 6: Run both test files, then `npm test` and `npm run test:super-tabs`.** Expected: all PASS.
- [ ] **Step 7: Commit the fix; post red/green evidence as a PR comment.**
