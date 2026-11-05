# Project rules record Implementation Plan

> **For agentic workers:** this plan is implemented the project's way (project instructions, Engineer): task by task, test
> first, each failing test committed before the code that passes it. No per-task review: the pull request's review step is the
> one independent review.

**Goal:** A project's numbers (release window, release pace, review table, merge train switch, caps, paths, crew, lanes) live
in one schema-checked, versioned record that people (or the project's PM, quoting the person's chat message) change without a
release; every change keeps who, when, the diff and the asking message; Desktop shows it read-only in Project settings.

**Architecture:** A new backend module `superTabs/policy.ts` owns the record's schema, its seed (today's numbers) and its diff.
Each saved revision is one row of a new collection `SuperTabProjectRules` (the document-versioning pattern in one collection:
the newest row is the record, older rows are its history, at most 50 kept). A new command `rules.set` validates, checks the
base revision and who may write, and hands the store one row to create; its `_id` is `stableId(tab, project, revision)`, so two
writers of the same revision collide on the key and one retries into `RULES_STALE`. A new read `GET
/api/super-tabs/:tabId/projects/:projectId/rules` returns the record and its history. Nothing of it enters the state, the
instructions read or any prompt.

**Tech Stack:** TypeScript, zod, Prisma on MongoDB, Fastify (backend); Flutter/Dart (Desktop).

**Spec:** Task #3393's brief (conversation 51b20f862c3b47eb530b1e44); anh Dee's Swarm redesign approval, 2026-11-05.

## Global Constraints

- PR body first line: "Requested by Dee through Harness."
- Owns `backend/src/superTabs/` and `desktop/lib/super_tabs/`; outside them only what wiring needs: `backend/prisma/schema.prisma`
  (the collection), `backend/src/routes/superTabs.ts` (the read route), `backend/src/lib/teamSession.ts` (a Team-account PM
  reads the base revision), each with its test.
- Who may edit: a person who may write the project; the project's own PM only with `askedIn` quoting a person's own chat
  message (not a notice) in a conversation of this project, from the last 24 h (`RULE_MESSAGE_MS`), by a member who still
  reads the project. No other agent, no Buddy, no viewer.
- New refusals get new names: `RULES_EDITOR_REQUIRED`, `RULES_ASKED_IN_REQUIRED`, `RULES_STALE`, `RULES_UNAVAILABLE`. None
  of `removedRefusals.test.ts`'s codes is used; that test stays green. Each refusal's message names the next step.
- The record is at most 16 KB of JSON; unknown keys are refused (strict schema); lists at most 50 entries.
- Seed (revision 0, never stored until a first save): release window 09:00–18:00 Asia/Ho_Chi_Minh; backend at most every
  120 minutes and never 09:00–10:00 (`backendPause`, Shipper #3405), Desktop/CLI/web after each visible batch; reviews: 1 read
  by default, 2 for sign-in, tokens, crypto, access, Buddy guard, device links, deletion, each with its path globs, test rows by
  where a change runs and the paths that need no test (the review steps' table, #3401 reviewTable.ts); merge train off, every
  10 minutes (opt-in per project, River via #3402); caps, paths, crew and lanes empty. The record is at most 16 KB.
- For server workers: `currentRules(tx, tabId, projectId)` (policyStore.ts), `requiredReads(rules, files)`,
  `testsFor(rules, files)`, `globMatch` (policy.ts); unreadable files (null) fail closed.
- Desktop tests use a memory store and a fake sign-in; never the real CLI sign-in.

## Design

- Growth: a save that writes revision N deletes revisions ≤ N − 50 of its project; `project.delete` deletes the project's
  rows; Swarm purge lists the collection (`purge.ts`).
- Concurrency: per project and revision: the new row's `_id` is unique, so of two saves on one base one retries (retry.ts
  takes a taken key) and is refused `RULES_STALE` with the current record to merge. The PM check touches the project's Lead
  conversation part, as `instructions.save` does.
- Read cost: one indexed read `(tabId, projectId, revision desc)`, at most 50 rows of ≤ 8 KB plus diff.
- Scale: 10x projects is 10x rows of one small collection; the first warning is the read route's latency.
- Compatibility: older clients never send `rules.set` and never read `/rules`; an older backend answers Desktop's read with a
  404 without the backend's code, which Desktop shows as "not available on this server".
- Migration + rollback: none; a project with no row reads the seed. Rolling back leaves rows unread.
- Audience: the server checks it: readers of the project read the record; a Buddy reads nothing (the history names who
  asked); writes as above.
- Identity: `writtenBy` is the person's or the PM's id, `askedBy` the person whose words it carries; never the machine owner.
- Failure: a refused save says why and what to do; a missing route or read failure is shown in the dialog.
- Platforms: Desktop's view is plain Flutter widgets, the same on macOS, Windows, Linux and web (route allowed in
  `backend_transport.dart`).

## Review Focus

- A PM quoting an agent's message, a notice, another project's chat, a day-old message, or a person who lost the project:
  refused `RULES_ASKED_IN_REQUIRED` (Task 2 test).
- Two saves on the same base revision: the second refused with the current record (Task 2 command test; Task 3 store key).
- A record with an unknown key, a window that ends before it starts, an unknown time zone, a negative pace, a list over 50:
  refused at parse, nothing stored (Task 1 test).
- Saving the same record again: no new revision (Task 2 test).
- A Buddy reading or writing the rules: refused (Task 2 and Task 3 tests).

---

### Task 1: The record, its seed and its diff

**Files:**
- Create: `backend/src/superTabs/policy.ts`
- Test: `backend/src/superTabs/policy.test.ts`

**Interfaces:**
- Produces: `projectRulesSchema` (zod, strict), `type ProjectRules`, `SEED_RULES: ProjectRules`, `MAX_RULES_BYTES = 8192`,
  `MAX_RULES_REVISIONS = 50`, `rulesDiff(before: ProjectRules, after: ProjectRules): RulesChange[]` where
  `RulesChange = { path: string; before: unknown; after: unknown }` (leaf paths for objects, whole value for lists),
  `rulesEqual(a, b): boolean`.

- [ ] Step 1: failing tests: the seed parses and holds the numbers above; bad values are refused (unknown key, `25:00`,
  end ≤ start, zone `Mars/Base`, pace 0, reads 0, 51 caps, over 8 KB); `rulesDiff` lists `releaseWindow.start` and `reviews.rows`
  changes and nothing for an equal record.
- [ ] Step 2: run `npm test -- src/superTabs/policy.test.ts`: fails (module missing). Commit.
- [ ] Step 3: implement `policy.ts`.
- [ ] Step 4: run it: passes. Commit.

### Task 2: `rules.set`

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (schema, context, case), `backend/src/superTabs/model.ts` (`CommandEffects.projectRules`),
  `backend/src/superTabs/parts/touches.ts`
- Test: `backend/src/superTabs/policy.test.ts`

**Interfaces:**
- Command: `{ type: 'rules.set', projectId, baseRevision: int ≥ 0, rules: ProjectRules, summary: summarySchema, askedIn? }`.
- Context: `projectRules?: { revision: number; rules: ProjectRules } | null` (null: none saved, the seed at revision 0);
  `askedIn` loaded as for `rule.set`.
- Effect: `projectRules: RulesWrite = { projectId, revision, rules, diff, summary, writtenBy: { kind, id }, askedBy, askedIn | null, at }`.
- Result: `{ projectId, revision }`, or `{ projectId, revision, unchanged: true }`.

- [ ] Step 1: failing tests: a person saves revision 1 from the seed with who/when/diff/summary; a stale base is refused
  `RULES_STALE` with the current record; the same record saves nothing; the PM saves only with a person's own message of this
  project from the last day (each wrong `askedIn` refused `RULES_ASKED_IN_REQUIRED`) and records `askedBy` and `askedIn`;
  another agent and a Buddy are refused; a viewer is refused.
- [ ] Step 2: run: fails. Commit.
- [ ] Step 3: implement.
- [ ] Step 4: run with `src/superTabs/removedRefusals.test.ts` and `parts` tests: pass. Commit.

### Task 3: Store, collection and read API

**Files:**
- Modify: `backend/prisma/schema.prisma` (`SuperTabProjectRules`), `backend/src/superTabs/store.ts` (context load, write,
  delete with the project, `projectRules` read), `backend/src/superTabs/purge.ts`, `backend/src/routes/superTabs.ts`,
  `backend/src/lib/teamSession.ts`
- Create: `backend/src/superTabs/policyStore.ts`
- Test: `backend/src/superTabs/policyStore.test.ts`, `backend/src/lib/teamSession.test.ts`

**Interfaces:**
- `readRules(tx, tabId, projectId): Promise<{ revision; rules } | null>`, `writeRules(tx, tabId, write: RulesWrite)` (create, then
  delete ≤ revision − 50), `deleteRules(tx, tabId, projectId)`.
- `store.projectRules(user, tabId, projectId, asAgentId?)` → `{ projectId, revision, rules, seeded, history: [{ revision, summary,
  diff, writtenBy, askedBy, askedIn, at }] }` newest first.
- `GET /api/super-tabs/:tabId/projects/:projectId/rules` (team session: agent scope).

- [ ] Step 1: failing tests: write/read keeps 50 newest; a second create of one revision throws a taken key; the team session
  route reaches `projectRules`.
- [ ] Step 2: run: fails. Commit.
- [ ] Step 3: implement; `npx prisma generate`.
- [ ] Step 4: run: passes; `npm test` (backend unit suite) passes. Commit.

### Task 4: Desktop read-only view

**Files:**
- Create: `desktop/lib/super_tabs/project_rules.dart` (model + dialog)
- Modify: `desktop/lib/super_tabs/view.dart` (Project settings row "Project rules"), `desktop/lib/super_tabs/backend_transport.dart`
- Test: `desktop/test/super_tabs/project_rules_test.dart`, `desktop/test/super_tab_backend_transport_test.dart`

**Interfaces:**
- `SuperTabProjectRules.fromJson`, `superTabRulesPath(tabId, projectId)`, `showSuperTabProjectRules(context, c, projectId)`.

- [ ] Step 1: failing tests: the model reads the seed answer; the dialog shows release window, pace, review table, merge train
  and the history line (who, when, summary, changed fields) in light and dark; a 404 without a code shows "not available";
  the web transport allows `/rules`.
- [ ] Step 2: run: fails. Commit.
- [ ] Step 3: implement.
- [ ] Step 4: run the new tests, `check-ui-style` and `laid_out_list_test`: pass. Commit.
