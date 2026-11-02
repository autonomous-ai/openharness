# Team Account on Windows: Security Pass Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax. Written by the writing-plans skill, as the project's
> instructions ask.

**Goal:** Do for Windows what task #2009 did for macOS: say, with evidence, whether an agent in the Harness Team account
can reach the owner's files, credential or data, across the OS user, the closed profile, the shared folders, local ports
and pipes, the relay and purge. Pin what holds with tests that run on a Mac, fix what is small and clear, and ask the PM
for a fix for each other hole.

**Architecture:** One rated report in `docs/security/`. One spec pins the Windows boundaries that can be checked without
Windows: the ACLs the setup script writes, decoded from its SDDL, and the TCP credential path as it is today. One fix,
test first: purge's check of a Codex Product Manager's home, which looked for `/` and so never matched a Windows path.

**Tech Stack:** TypeScript, Vitest.

**Spec:** Task #2022's brief (conversation `a9607b4bd17934653c9df04e`), and the macOS audit
`docs/security/2026-11-02-team-account-boundary.md`.

## Global Constraints

- Read-only on real machines: no real account, permission or file of another session is changed; fixtures in this
  task's own folders only. No Windows machine is used: what needs one is said as not verified.
- Never run a test that signs this Mac out of the real CLI. Stop only processes this task started, by id.
- Never print or post a secret.
- Two independent security reviews before merge (Quinn 2 and Luna): the fix touches code that deletes data.

## Review Focus

- A purge path check that matches too much: a Codex home one level under the PM homes folder would make purge delete
  every PM's home; a sibling folder whose name starts with `.harness-pm-homes` must not match.
- A check that holds on POSIX and not on Windows: every new path test runs with `path.win32` as well as the platform's.
- An SDDL test that reads the wrong ACE: masks are decoded by bit, and the folder's own ACE is told apart from the
  inherit-only one.
- A test that pins an open hole as if it held: the open ones are named "still open" and turn red when fixed.
- A finding rated from code alone said as seen: each one says whether it was read in code, tested here, or seen.

---

### Task 1: Read every Windows path in scope

**Files:** none changed.

- [x] **Step 1:** Read setup, the task, removal and the team side (`cli/src/team/windowsScript.ts`, `windowsTeam.ts`,
  `windowsLayout.ts`, and their callers in `command.ts`, `deps.ts`, `privacy.ts`, `relay.ts`, `admin.ts`).
- [x] **Step 2:** Read the Windows local transports: `hook/notify.mjs` `hookRoute`, `lib/localCredential.ts`,
  `lib/peerAccount.ts`, `hookServer.ts`, `lib/windows/pipeAuth.ts`.
- [x] **Step 3:** Read purge for Windows paths: `superTabs/inCore/teamPurge.ts`, `superTabs/teamDaemon.ts` `pmEngineHome`.

### Task 2: Purge deletes a Codex Product Manager's home on Windows

**Files:**
- Modify: `cli/src/superTabs/inCore/teamPurge.ts` (the check before `rm(dirname(target.codexHome))`)
- Test: `cli/src/superTabs/inCore/teamPurge.spec.ts`

**Interfaces:**
- Produces: `isPmCodexHome(home: string, codexHome: string, paths?: Pick<PlatformPath, 'join' | 'relative' | 'isAbsolute' | 'sep'>): boolean`,
  true only for `<home>\.harness-pm-homes\<id>\codex` by `paths`' own rules (the platform's by default).

- [x] **Step 1: Write the failing tests:** with `win32`, the home `pmEngineHome` makes on Windows is one; with the
  platform's path, the same; a home one level under the PM homes folder, a sibling folder's, `..` and another home are not.
  And the purge of a session whose Codex home is one level under the PM homes folder leaves the other PMs' homes.
- [x] **Step 2: Run them:** `npx vitest run src/superTabs/inCore/teamPurge.spec.ts`. Expected: FAIL.
- [x] **Step 3: Implement** `isPmCodexHome` by `relative` from the PM homes folder: two parts, the second `codex`.
  Use it in `createConfidentialPurge`.
- [x] **Step 4: Run them again.** Expected: PASS. Red evidence: put the old `startsWith(\`${homes}/\`)` back in the
  helper and run; the Windows assertion fails.

### Task 3: Windows boundary spec

**Files:**
- Create: `cli/src/team/windowsBoundary.spec.ts`

- [x] **Step 1: Write the spec:** decode the SDDL the setup script writes for the handover, status, relay, stage and
  shared folders, and check by bit what each account may do; pin the TCP credential on Windows as it is (still open).
- [x] **Step 2: Run it:** `npx vitest run src/team/windowsBoundary.spec.ts`. Expected: PASS.
- [x] **Step 3: Red evidence:** give the team account add-file on the handover folder, or Users read on it, in
  `windowsScript.ts`; the spec fails on that line. Put it back.

### Task 4: Findings, fix requests, pull request

**Files:**
- Create: `docs/security/2026-11-02-team-account-windows.md`

- [x] **Step 1:** Write each finding: rating, evidence by file and line, how it was found, what fixes it; then what holds.
- [x] **Step 2:** Run the Team and purge specs and the typecheck.
- [ ] **Step 3:** Open the pull request with its "Requested by" line, the checklist and red/green evidence.
- [ ] **Step 4:** Send one fix request per open hole to the PM; add two review steps (Quinn 2, Luna) and message them.
