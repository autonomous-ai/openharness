# Desktop Opens To Your Last Screen At Once Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** Desktop opens to the last screen at once: independent startup steps run together, and the same account's profile and saved view show without waiting for the network.

**Architecture:** The sign-in check starts beside the tool probe, and the restores beside the daemon check. The app keeps the last profile with the machine id it was read under, and uses it only when `harness auth status` names that same machine. A machine row has exactly one owner, and a new sign-in writes a session with no machine id until its own is resolved, so a match proves the account without a network call. Saved views are already stored per account, so with the account proven the Swarm draws its saved view at once and the first read replaces it.

**Tech Stack:** Dart, Flutter 3.47.2, `flutter_test`.

**Spec:** Task #2169 (Dee).

## Global Constraints

- Never draw another account's profile or saved view.
- No on/off switch: the change ships on.
- Tests use a memory store and a fake sign-in, and never reach the real CLI.
- Swarm code stays out of `cli/src/core`. No CLI or backend change.
- The PR body starts with: `Requested by dee@autonomous.ai through Harness.`
- Two security reviews: Cleo and Reed.

## Review Focus

1. **Someone signs in as another account in a terminal while the app is closed.** `auth status` names another machine or none, so the old profile is not used and is removed, and the app waits for the server's answer as it does today.
2. **The server answers with a different account than the kept profile.** The answer wins, the account changes as it does at any sign-in, and the kept profile is replaced.
3. **The early sign-in check fails or the CLI is missing,** as on a first run. It is asked again after setup, and a failure there is reported as today. A check from before an install is never trusted.
4. **The person signs out or signs in while an early check is running.** A check from an older sign-in is dropped.
5. **A corrupt, partial or old kept profile:** ignored, with no crash, as if none were kept.

## What this narrows, on purpose

`confirmsSaved` also promised that "a conversation the reader lost since is never on screen". Drawing at once means a conversation the same account lost access to can show until the first read answers, and the read then removes it. The web has always worked this way. The task asks for this, and another account's view stays out as before.

## Design

- **Growth:** one small record per device, replaced at each profile read, deleted at sign-out and on any mismatch.
- **Concurrency:** the check and the probe share nothing. Each result is applied under the sign-in revision, so a late result can't touch a new sign-in.
- **Read cost:** one extra local key read at startup, and no extra network calls.
- **Scale:** N/A because it is one record per device.
- **Compatibility:** with no machine id from an older CLI, nothing is cached and the app waits for the server, as today.
- **Migration and rollback:** none. Rolling back leaves one unused key.
- **Audience:** the record is the signed-in person's own name, email and avatar address, in the same local store as their saved tabs. No token.
- **Identity:** the machine id from the CLI's session proves the account, never the machine's OS user.
- **Failure:** any failed read of the record means none is used. The server's answer always replaces it.
- **Platforms:** Desktop on macOS, Linux and Windows. A viewer (web, phone) has no CLI and keeps its current path.

---

### Task 1: Startup runs independent steps together

**Files:**
- Modify: `desktop/lib/state/app_state.dart`
- Test: `desktop/test/startup_order_test.dart`

**Interfaces:**
- Produces: `AppNotifier.startupTimings` (a stopwatch's marks, logged as `startup: …`).

- [ ] **Step 1: Commit the failing tests:** the sign-in check is asked while the tool probe is still held; a sign-in check that failed early is asked again after setup, and one from before an install is not used; the restores and the daemon check are both started while neither has finished; a check from an older sign-in is dropped.
- [ ] **Step 2: Watch them fail:** `flutter test test/startup_order_test.dart`.
- [ ] **Step 3: Implement** the early check and the joined restores, keeping `_ensurePool` after the restores.
- [ ] **Step 4: Run them, and commit.** Expected: PASS.

### Task 2: The kept profile

**Files:**
- Create: `desktop/lib/state/profile_cache.dart`
- Modify: `desktop/lib/state/app_state.dart`
- Test: `desktop/test/profile_cache_test.dart`

**Interfaces:**
- Produces: `ProfileCache(LocalKeyValueStore?)` with `read(String machineId) -> Future<CurrentUserProfile?>`, `write(String machineId, CurrentUserProfile)`, `clear()`.

- [ ] **Step 1: Commit the failing tests:** the same machine id shows the kept profile before the server answers; another machine id or none shows nobody and removes it; the server's answer replaces it, and a different account's answer changes the account; sign-out removes it; a corrupt record reads as none; a profile with no id is never kept.
- [ ] **Step 2: Watch them fail:** `flutter test test/profile_cache_test.dart`.
- [ ] **Step 3: Implement.** The kept profile is set after the sign-in check and before the daemon check.
- [ ] **Step 4: Run them, and commit.** Expected: PASS.

### Task 3: The saved view draws at once

**Files:**
- Modify: `desktop/lib/super_tabs/reading.dart`, `desktop/lib/super_tabs/controller.dart`
- Test: `desktop/test/super_tab_saved_view_test.dart`

**Interfaces:**
- Produces: `SuperTabReading.drawsSavedAtOnce`, true for Desktop.

- [ ] **Step 1: Commit the failing tests:** on Desktop's policy a saved view draws before the first read answers and the first read replaces it, removing a conversation the reader lost; a refused first read clears it; another account's saved view is never read, kept profile or not.
- [ ] **Step 2: Watch them fail:** `flutter test test/super_tab_saved_view_test.dart`.
- [ ] **Step 3: Implement,** without changing what `confirmsSaved` forgets.
- [ ] **Step 4: Run them, and commit.** Expected: PASS.

### Task 4: Timings and proof

- [ ] **Step 1: Measure** startup and first-open timings before and after, with the same held steps in a test, since this Mac can't build the macOS app. Post them in a PR comment.
- [ ] **Step 2: Run** the Desktop suite's boot, profile and Swarm tests, mark the PR ready, and ask Cleo and Reed.
