# Phone tests' temp folders go without racing what still writes into them Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** A phone test's teardown never fails with "Directory not empty" because something the test started is still
writing into the temp folder it deletes. Seen in batch #2952: `swarm_session_test.dart` "the app icon's count is what
the drawer counts after a read" failed at `swarm_fixture.dart:392` (`memoryHomeCache`'s `deleteSync`) while the
session's inbox was still keeping its Home in the background (task #2759, River, 2026-11-04).

**Architecture:** `SwarmHomeCache.write` runs unawaited from `SwarmHomeKeeper._write` (a temp file `home.bin.next`, then
a rename). The fixture's teardown deleted the folder at once, so a save landing during the recursive delete leaves a
file behind and the delete fails. Two parts:

1. `memoryHomeCache`'s teardown first waits for the saves its cache has under way (`homeSaved`, the cache's own
   one-at-a-time queue), then deletes. Under a fake clock that queue never moves again, so the wait is bounded and
   nothing is written after it.
2. The delete itself (`deleteTempFolder`, mobile/test/temp_folder.dart) tries again for a moment while the folder is
   still there, for writers no fixture can wait for: hosts built without a `homeCache` keep their Home and kept chats
   in the per-file test home (`flutter_test_config.dart`), whose `tearDownAll` gets the same delete.

**Tech Stack:** Flutter 3.47.2, flutter_test; test code only.

**Spec:** task #2759's brief. No app code changes.

## Global Constraints

- Test code only (mobile/test). No change in mobile/lib.
- Red first: each risk has a test committed failing before its fix.
- Temp folders only from `createTempSync` under the system temp folder.
- No fixed sleeps in tests: the tests wait for the save or the writer to finish.

## Design

- growth: N/A because nothing is stored.
- concurrency: the point of the change; the wait follows the cache's own queue, the retry covers writers outside it.
- read cost: N/A.
- scale: N/A.
- compatibility: N/A because no wire or saved format changes.
- migration + rollback: N/A; revert the commits.
- audience: N/A.
- identity: N/A.
- failure: a folder that still will not go after the retries fails the teardown with the last error, as before.
- platforms: macOS (local) and Linux (CI), where the failure was seen.

## Review Focus

- The bounded wait in `memoryHomeCache`'s teardown: real time, and harmless when a fake clock froze the save.
- The retry gives up and rethrows, so a folder that cannot be deleted for another reason is still seen.
- The other temp-folder teardowns in mobile/test were audited: every write into them is awaited by the test, except
  the shared test home and the picture tests' folder (swarm_attachment_test.dart: "a narrow message makes the box
  narrower" ends with its fetch released but not waited for), which take the retry. The rest keep a plain
  `deleteSync`.

## Task 1: the Home's folder goes only after the saves under way

**Files:** mobile/test/swarm/swarm_fixture.dart, mobile/test/swarm/swarm_fixture_test.dart, mobile/test/temp_folder.dart

**Interfaces:** `Future<void> removeHome(SwarmHomeCache cache)`, `memoryHomeCache()`'s teardown calls it.

- [ ] Test: a save parked at its key when `removeHome` starts; once both are done, no folder is left.
- [ ] Run red (the folder is back: the save landed after the delete), commit; implement; run green, commit.

## Task 2: a folder still being written into goes once the writing stops

**Files:** mobile/test/temp_folder.dart, mobile/test/temp_folder_test.dart, mobile/test/flutter_test_config.dart,
mobile/test/swarm/swarm_attachment_test.dart

**Interfaces:** `Future<void> deleteTempFolder(Directory folder)`.

- [ ] Test: another isolate writing files into a folder while `deleteTempFolder` runs; the delete does not fail and the
      folder is gone.
- [ ] Run red ("Directory not empty"), commit; implement; run green, commit.
- [ ] `flutter_test_config.dart`'s `tearDownAll` deletes the test home with it, and swarm_attachment_test.dart's
      `tearDown` its folder.

## Evidence

- Forced reproduction of the CI failure with the old fixture, then the session test file 20/20 and under parallel
  load with the fix; the phone suite green in CI.
