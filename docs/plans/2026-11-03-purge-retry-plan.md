# A Purge That Did Not Finish Is Retried Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** A confidential purge that didn't finish is retried with backoff and on the next start of the Team daemon, and a person can see that it's pending.

**Architecture:** The durable record already exists (`purgeRecord`, `team-purges.json`): it keeps each purge until its sweep finds nothing, and the account stays held while it has any. Nothing reads it to try again. `withPurgeRetries` wraps the purge: at start, and after any purge that leaves the record non-empty, it runs each pending purge on a backoff until none is left. It writes a count to the Team status file, which `harness team status` shows. Calls for the same agent share one run.

**Tech Stack:** TypeScript, Vitest.

**Spec:** Task #2264 (Ken), raised by Echo and Reed on #2675.

## Global Constraints

- The PR body starts with: `Requested by ken15@autonomous.ai through Harness.`
- Two security reviews: Reed and Echo.
- Never run tests that sign this Mac out of the real CLI. Tests use temporary homes.
- Swarm code stays out of `cli/src/core`: `core/main.ts` only calls what the Swarm part offers.
- The status file says a count, never an agent, session or path. No on/off switch.

## Review Focus

1. A retry goes only through the existing purge, with its reviewed delete and its limits. It adds no new way to delete anything, and only ever names ids from the record.
2. A session that came back to life stays safe: the reviewed purge refuses it, so it stays pending and nothing is scrubbed.
3. An unreadable record retries nothing and says so; the account stays held until a person clears it, as today.
4. A retry racing a host's own close of the same agent shares one run, so two never scrub at once.
5. The status file is readable by the owner, so it holds no names.

## Design

- **Growth:** none new: the record already exists. A purge leaves it when it finishes.
- **Concurrency:** one retry pass at a time, and one run per agent. The record is read and written in this one process.
- **Read cost:** the record is in memory. A pass does the purge's own disk work, at most every 30 minutes once backed off.
- **Scale:** N/A because a Team account has few confidential sessions; a pass runs them one after another.
- **Compatibility:** an older `harness team status` ignores the new field, and a newer one reads a file without it as nothing pending.
- **Migration and rollback:** none. Records written before this are picked up at the next start. Rolling back leaves an unused field.
- **Audience:** the status file holds only a count. The record stays private to the Team account.
- **Identity:** runs as the Team user, in its own daemon.
- **Failure:** a pass that fails keeps the record, logs by kind and tries later. A failed status write is logged and tried at the next pass.
- **Platforms:** same code on macOS, Linux and Windows; the status file already has its place on each.

---

### Task 1: Retries

**Files:**
- Modify: `cli/src/superTabs/inCore/teamPurge.ts`, `cli/src/superTabs/inCore/teamApps.ts`, `cli/src/superTabs/inCore.ts`, `cli/src/core/main.ts`
- Test: `cli/src/superTabs/inCore/teamPurge.spec.ts`

**Interfaces:**
- Produces: `withPurgeRetries(purge, { record, report, log }): ((agentId) => Promise<Record<string, unknown>>) & { stop(): void }`.

- [ ] **Step 1: Write the failing tests:** a failed purge is retried after a restart and clears, removing the engine home; backoff grows and stops once none is pending; one that keeps failing stays recorded and keeps trying; a live session isn't scrubbed; an unreadable record runs nothing and reports it; two calls for one agent share a run; the report holds only a count.
- [ ] **Step 2: Run them:** `npx vitest run --no-coverage src/superTabs/inCore/teamPurge.spec.ts` in `cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: A person can see it

**Files:**
- Modify: `cli/src/team/privacy.ts`, `cli/src/team/command.ts`
- Test: `cli/src/team/privacy.spec.ts`, `cli/src/team/command.spec.ts`

**Interfaces:**
- Produces: `TeamStatus.purges?: { pending: number; unreadable: boolean; at: number }`.

- [ ] **Step 1: Write the failing tests:** the status file keeps a valid `purges` and drops a malformed one; `harness team status` says pending, says unreadable, and says nothing when none is pending; its JSON carries it.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit, run `npm run test:core`, mark the pull request ready** and ask Reed and Echo.
