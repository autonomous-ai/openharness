# A phone picture test never deletes a picture file while its image is still loading Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** A picture test in `swarm_attachment_test.dart` no longer fails with `PathNotFoundException ... resolving an
image codec` because its temp files went while an image was still being read from them. Seen in batch #2952's second CI
attempt: "open full screen, the picture goes with its account: a Swarm leaving the account's list closes it at once,
and lets the picture go" (task #2883, River, 2026-11-04).

**Architecture:** `opened` waits until the viewer's picture is in the image cache (`containsKey`), which is true as soon
as its load is *pending*, so the test went on to `store.clear()` / `keepOnly()` (a real recursive delete) while
`FileImage._loadAsync` had not yet opened the file. Two parts:

1. `picturesLoaded(tester)` (mobile/test/swarm/picture_loads.dart) waits, in real time, until every picture on screen
   has finished loading (decoded, or failed): it asks the image cache whether each `Image`'s key is still pending.
2. `opened` and `closed` call it, so no test deletes or tears down the temp folder under a load. A fixture gate on the
   fake store's file reads (`PictureReads`) holds a load open, so the race is forced rather than waited for.

**Tech Stack:** Flutter 3.47.2, flutter_test, package:file; test code only.

**Spec:** task #2883's brief. No app code changes.

## Global Constraints

- Test code only (mobile/test). No change in mobile/lib.
- Red first: the new test is committed failing before the helper that fixes it.
- No fixed sleeps: the tests wait for the load, and a held load is released by the test.
- Temp folders only from `createTempSync` (already the case).

## Design

- growth: N/A because nothing is stored.
- concurrency: the point of the change; teardown and deletes follow the load, not the other way round.
- read cost: N/A.
- scale: N/A.
- compatibility: N/A because no wire or saved format changes.
- migration + rollback: N/A; revert the commits.
- audience: N/A.
- identity: N/A.
- failure: a load that never finishes fails the helper's bounded wait with a reason, not a hang.
- platforms: macOS (local) and Linux (CI), where the failure was seen.

## Review Focus

- `picturesLoaded` cannot return early on an image whose key is not yet tracked (no `Image` is built in that case).
- Held reads are off by default: every other test sees the plain store.

## Task 1: a held load is waited for before the folder goes

**Files:** mobile/test/swarm/swarm_attachment_fakes.dart, mobile/test/swarm/picture_loads.dart,
mobile/test/swarm/picture_loads_test.dart

**Interfaces:** `PictureReads` (`hold`, `asked`), `storeIn(..., reads:)`, `bool picturesLoading(WidgetTester)`,
`Future<void> picturesLoaded(WidgetTester)`.

- [ ] Test: with the viewer's read held, `picturesLoading` is true; released, `picturesLoaded` returns, and clearing the
      store then leaves no error.
- [ ] Run red (stub says nothing is loading), commit; implement; run green, commit.

## Task 2: the picture tests wait for their loads

**Files:** mobile/test/swarm/swarm_attachment_test.dart

- [ ] `opened` waits with `picturesLoaded` instead of `containsKey`; `closed` calls it before the chat goes.
- [ ] Forced: the same tests with every read held a moment pass; without Task 2 they fail with the CI error.

## Evidence

- The CI failure reproduced by slowing every read (old `opened`/`closed`), then green with the fix; the phone suite
  green.
