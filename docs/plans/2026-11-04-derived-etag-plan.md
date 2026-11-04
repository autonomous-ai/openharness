# Polls send the Swarm summary only when it changed: implementation plan

This plan follows the project's way of working (writing-plans header, then test-driven tasks, implemented by the
Engineer in this session; one review step on the pull request).

**Goal:** A Swarm change read leaves out the machine and agent summary (`derived`) when it is the same as the one the
reader already holds, so an unchanged poll costs a few hundred bytes at any Swarm size instead of 12 KB (36 machines)
to 92 KB (360).

**Architecture:** The backend hashes each reader's `derived` (without the reader's marks, which already go out as
changes only) into a short `derivedEtag`, sent on every first load and change read. A client that holds one sends it
back as `derivedEtag=` on its next change read; when it still matches, the reply's `derived` holds only the marks and
says `derivedUnchanged: true`, and the client keeps the summary it holds. A client that sends nothing (every released
one) gets the whole summary as today. This is the host feed's `held` etag (read/hostEtag.ts) applied to the app
windows' reads.

**Tech Stack:** Backend TypeScript (Fastify, zod, Prisma/MongoDB), vitest; Desktop/web and phone Flutter (Dart).

**Spec:** Task #2906 (Swarm conversation d49673c3ec733ee886f9bca8); measurement by Wren13 for #2637, PR #2909
(`backend/integration/bench/machineCapCost.ts`); read API design docs/design/2026-10-26-swarm-state-parts.md, section 4.

## Global Constraints

- Released clients keep working: a change read without `derivedEtag` answers exactly as today, plus the new top-level
  `derivedEtag` field (unknown top-level fields are ignored by released Desktop, phone and CLI).
- Unchanged polls carry no summary: only the reader's moved marks (`readMarks`, `unreadMarks`, `threadMarks`,
  `chatSettings`) stay in `derived`.
- Red-first tests; bytes per poll before/after at 36 and 360 machines in the pull request; one review step.
- Swarm code stays out of cli/src/core. Desktop and phone `parts.dart` stay identical copies (mobile
  test/swarm/desktop_parity_test.dart).
- Desktop tests use a memory store and a fake sign-in; nothing signs the Mac out of the real CLI.

## Design

- Growth: nothing is stored. The etag lives in each client's held parts (and Desktop's saved view) and is replaced by
  every read.
- Concurrency: none added. The etag is computed from the reply the read already builds, inside the same read.
- Read cost: no new database read. One SHA-256 over the reply's own summary JSON per read (under 1 ms at 360
  machines); an unchanged poll sends the marks only.
- Scale: at 10x (360 machines) an unchanged poll stays at the size of the parts that changed. The first metric to warn
  is the reply size of a poll after a summary change, which still carries the whole summary (bench row "every machine
  reading").
- Compatibility: old client and new backend: no etag sent, whole summary, as today. New client and old backend: no etag
  received, none sent. New client after a backend rollback: its held etag is refused by the old backend's strict query
  (VALIDATION_ERROR); the client then drops what it holds and reads in full once, getting no etag.
- Migration and rollback: none stored, so nothing to migrate. Rollback costs each open window one first load.
- Audience: the etag hashes the summary of the reader it was built for, after the server's visibility filtering, and
  is only compared with that reader's own echo. It reveals nothing beyond the summary the reader already received.
- Identity: the read's actor, as today; no machine owner's login.
- Failure: an etag mismatch or a malformed etag sends the whole summary. A reply saying "unchanged" for an etag the
  client does not hold is a format error, which the client answers with a first load.
- Platforms: backend; Desktop (macOS, Windows, Linux) and web share `desktop/lib/super_tabs`; phone (`mobile/lib/swarm`).
  The CLI keeps reading as a released client (whole summary).

## Review Focus

1. A summary change of any kind, from any agent's `downSince` to an avatar link, after an unchanged poll: the next
   poll must send the whole summary. Integration test "a summary change after an unchanged poll sends it whole".
2. Marks moved in an otherwise unchanged poll: they still arrive. Integration test "an unchanged poll still sends the
   reader's moved marks".
3. Two readers of one Swarm see different summaries: one reader's etag never matches for another. Integration test
   "an etag is the reader's own".
4. A backend rolled back under a client holding an etag: the client reads in full, without the etag. Desktop and phone
   tests "a refused etag reads in full once, then polls without it".
5. A saved view restored on start: its held etag comes back with its summary (Desktop toJson/fromJson). Dart test
   "a saved store keeps its etag".

---

### Task 1: The backend stamps the summary and leaves it out when the reader holds it

**Files:**
- Create: `backend/src/superTabs/read/derivedEtag.ts`, `backend/src/superTabs/read/derivedEtag.test.ts`
- Modify: `backend/src/superTabs/read/hostEtag.ts` (export its sorted JSON), `backend/src/superTabs/read/contract.ts`,
  `backend/src/superTabs/read/service.ts` (`firstLoad`, `changes`), `backend/src/routes/superTabs.ts` (`changesQuery`)
- Test: `backend/src/superTabs/read/derivedEtag.test.ts`, `backend/src/routes/superTabs.test.ts`,
  `backend/integration/superTabRead.test.ts`

**Interfaces:**
- Produces: `derivedEtag(derived: Derived): string` (22 base64url characters; marks fields ignored);
  `MARK_FIELDS = ['readMarks', 'unreadMarks', 'threadMarks', 'chatSettings'] as const`;
  `SwarmReads.changes(user, tabId, cursor, asAgentId?, options: { lightMachines?: boolean; derivedEtag?: string })`;
  contract: `FirstLoad.derivedEtag: string`, `ChangesDelta.derivedEtag: string`, `ChangesDelta.derivedUnchanged?: true`,
  `ChangesDelta.derived: Derived | ReaderMarks` where `ReaderMarks = Pick<Derived, MarkField>`;
  route query `derivedEtag` (`/^[A-Za-z0-9_-]{1,64}$/`).

- [ ] **Step 1: Failing tests.** `derivedEtag.test.ts`: equal for the same summary built in another key order; equal
  whatever the marks; different when any value of `agents`, `machines`, `avatars` or a digest differs.
  Route test: `?cursor=abc&derivedEtag=e1` passes `{ derivedEtag: 'e1' }`; `?cursor=abc` still passes `{}`;
  `derivedEtag=bad!` is refused with 400. Integration (`changes since a cursor`): a first load's `derivedEtag` equals the
  next change read's; echoed, the reply has `derivedUnchanged: true` and `derived` without `agents`/`machines`; no echo
  or another etag sends the whole summary; a summary change after an unchanged poll sends it whole with a new etag; an
  unchanged poll still sends moved read marks; an etag is the reader's own.
- [ ] **Step 2: Run them, watch them fail.** `npx vitest run src/superTabs/read/derivedEtag.test.ts src/routes/superTabs.test.ts`
  and `npx vitest run --config vitest.super-tabs.config.ts integration/superTabRead.test.ts -t "etag"`.
- [ ] **Step 3: Implement** the interfaces above. `changes` builds `derived` as today, computes the etag, and replaces
  `derived` with its marks alone when `options.derivedEtag` equals it.
- [ ] **Step 4: Run the same tests, watch them pass;** `npx tsc --noEmit`.
- [ ] **Step 5: Commit** the tests first, then the code.

### Task 2: Desktop/web and phone send the etag back and keep the summary they hold

**Files:**
- Modify: `desktop/lib/super_tabs/parts.dart` and its copy `mobile/lib/swarm/parts.dart`;
  `desktop/lib/super_tabs/controller.dart` (`_readParts`); `mobile/lib/swarm/swarm_reader.dart` (`_readParts`);
  `desktop/test/support/super_tab_fixture.dart` (the fake backend answers etags as the backend does)
- Test: `desktop/test/super_tab_parts_reading_test.dart`, `mobile/test/swarm/swarm_reader_test.dart`

**Interfaces:**
- Consumes: Task 1's `derivedEtag`, `derivedUnchanged` and `derivedEtag=` query.
- Produces: `SuperTabParts.derivedEtag` (`String?`), `SuperTabParts.changesQuery` (`String`: `cursor=…` plus
  `&derivedEtag=…` when one is held), kept by `toJson`/`fromJson`.

- [ ] **Step 1: Failing tests.** Desktop: "an unchanged poll sends the etag and keeps the summary" (second change read's
  path has `derivedEtag`, the fake answers without `agents`, `snapshot` still has its agents and a moved mark arrives);
  "a summary change replaces it"; "a refused etag reads in full once, then polls without it"; "a saved store keeps its
  etag". Phone: the same first and third.
- [ ] **Step 2: Run them, watch them fail.** `flutter test test/super_tab_parts_reading_test.dart` (desktop),
  `flutter test test/swarm/swarm_reader_test.dart test/swarm/desktop_parity_test.dart` (mobile).
- [ ] **Step 3: Implement.** `apply` keeps `_derived` when `derivedUnchanged` is true and the reply's etag is the one
  held (else a FormatException: half merged, first load); the readers poll with `changesQuery` and treat a
  VALIDATION_ERROR on a read that sent an etag as they treat FORBIDDEN (first load).
- [ ] **Step 4: Run the same tests, watch them pass;** `flutter analyze` on the changed files.
- [ ] **Step 5: Commit** the tests first, then the code.

### Task 3: Bytes per poll at 36 and 360 machines, before and after

**Files:**
- Create: `backend/integration/bench/derivedEtagCost.ts` (Wren13's machineCapCost.ts harness, with an etag window
  beside the old one)

- [ ] **Step 1:** Run the bench at 36 and 360 machines on main's behaviour (old windows) and with the etag window; the
  table goes in the pull request: reply KB per poll after nothing, after every machine's reading, after one post.
- [ ] **Step 2: Commit.**
