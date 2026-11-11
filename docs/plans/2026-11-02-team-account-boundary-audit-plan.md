# Team Account Boundary Audit Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax. Written by the writing-plans skill, as the project's
> instructions ask. The audit's reading came first and the spec was drafted before the rule reached this task (revision 9,
> 2026-11-02): this plan records what was done and what is left.

**Goal:** Say, with evidence, whether an agent in a Harness Team account can read, list or change the files of the machine's
main account; pin what holds with tests; ask the PM for a fix for each hole.

**Architecture:** No product code changes. One spec asks the kernel about the mode the real setup script gives the owner's
home, in a fixture folder. One document rates the findings. Holes become fix requests, not changes in this pull request.

**Tech Stack:** TypeScript, Vitest, POSIX shell tools.

**Spec:** Task #2009's brief (conversation `6b8bce9ecfc60ed067d388b1`).

## Global Constraints

- Do not change real accounts or permissions on any shared Mac; temp users or fixtures in this task's own folders only.
- Never run a test that signs this Mac out of the real CLI. Stop only processes this task started, by id.
- Never print or post a secret: names of variables only, values redacted, including in evidence.
- Two independent security reviews before merge.

## Review Focus

- A refusal that comes from a missing path, not from the kernel: the attempts must fail with a permission error.
- A test that would pass with the home open: a control must show the same attempts succeed before setup closes it.
- A required check skipped without saying: CI's Linux must have a real second account, and fails if it has none.
- A write that is refused yet changes something: the home is compared before and after.
- The spec reaching real state: fixtures only; the hook runs with a made-up credential and an empty tmux folder.

---

### Task 1: Read every path in scope

**Files:** none changed.

- [x] **Step 1:** Read account setup and removal, modes, the daemon, the Swarm service and purge (`cli/src/team/*`,
  `cli/src/superTabs/teamDaemon.ts`, `cli/src/superTabs/inCore/teamPurge.ts`).
- [x] **Step 2:** Read the limits of a Team sign-in on the server (`backend/src/lib/teamSession.ts`, `superTabs/store.ts`
  `teamCommand`, `superTabs/terminal.ts`).
- [x] **Step 3:** Read every loopback server and credential path (`cli/src/hookServer.ts`, `localWsServer.ts`,
  `lib/subscriptionRelay.ts`, `lib/connectors/bridge.ts`, `lib/swarmApiShares.ts`, `hook/notify.mjs`).
- [x] **Step 4:** Look at this Mac's real modes, listeners and process table, read-only, with values redacted.

### Task 2: Boundary tests

**Files:**
- Create: `cli/src/team/boundary.spec.ts`

**Interfaces:**
- Consumes: `buildSetupScript`, `buildLinuxSetupScript`, `runPrivacyCheck`, `realPrivacyDeps`, `SENTINEL_NAME`.
- Produces: nothing other code uses.

- [x] **Step 1: Write the spec:** every attempt refused by the kernel at the mode step 3 of each real script gives; a control
  with the home open; the same as `nobody` where `sudo -n` allows; the privacy check on the real file system; H1 pinned as it is today, so closing it turns the test red.
- [x] **Step 2: Run it:** `npx vitest run src/team/boundary.spec.ts`. Expected: PASS.
- [x] **Step 3: Red evidence:** take step 3's `chmod 700 "$OWNER_HOME"` out of `script.ts`, and run it again. Expected: FAIL
  on the step's line. Put it back. Then set it to `chmod 755`. Expected: FAIL on "was not refused".
- [x] **Step 4: Run the Team specs and the local server's spec:** `npx vitest run src/team src/hookServer.spec.ts`.

### Task 3: Findings and fix requests

**Files:**
- Create: `docs/security/2026-11-02-team-account-boundary.md`

- [x] **Step 1:** Write each finding: area, rating, evidence by file and line, what fixes it; what holds, each with its evidence.
- [ ] **Step 2:** Post the rated list to Scholes in the task, and one fix request per real hole to the PM.
- [ ] **Step 3:** Commit, open the pull request starting with its "Requested by" line, with the checklist and red/green evidence.
- [ ] **Step 4:** Add two review steps and name free Opus Reviewers that have not worked on this task.
