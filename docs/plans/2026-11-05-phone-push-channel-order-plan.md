# Android push channel ordering implementation plan

> Implement task by task in this Engineer session, test first, with one independent PR review.

**Goal:** Register for Android pushes only after both Swarm notification channels have been prepared.

**Architecture:** Reuse the loud and quiet channel definitions merged through #3154. Share one preparation future between eager app startup and notification initialization; permission checks already gate push registration.

**Tech Stack:** Dart, Flutter, flutter_local_notifications; existing fake plugin tests.

**Spec:** Task #3326; `docs/phone-notifications.md`; `docs/design/2026-11-05-phone-push.md`.

## Global Constraints

- Continue Tony's existing PR #3179; preserve the merged push rule and existing notification identifiers.
- No backend changes, native builds, device installations, or real sign-ins.
- Targeted local tests; automatic PR CI supplies the complete mobile suite.
- The Integrator merges after independent review and testing.

## Review Focus

- Registration races the still-running preparation of the quiet channel.
- Permission requests and checks overlap eager startup, creating channels repeatedly.
- The loud channel metadata diverges from local notices or the backend channel IDs.
- A platform channel error prevents otherwise working local notices or permission checks.
- iOS accidentally invokes Android channel setup.

## Design

- Growth: two existing OS channels, no new persisted data or identifiers.
- Concurrency: one shared future per LocalSystemNotices instance.
- Read cost: no extra network or storage reads; channel preparation once per instance.
- Scale: constant work at 10x; preparation failures are logged.
- Compatibility: existing channel IDs and the person's OS settings are preserved.
- Migration and rollback: no migration; reverting removes the ordering guarantee.
- Audience and identity: N/A; no change to registration authorization or account selection.
- Failure: preserve best-effort logged failures and working local notifications.
- Platforms: Android channels; iOS remains a no-op.

## Task 1: Reconcile the upstream channels and await them

**Files:** `mobile/lib/notify/system_notices.dart`, `mobile/test/notify/local_system_notices_test.dart`, `docs/design/2026-11-05-phone-push.md`.

**Interfaces:** Consume existing `Future<void> preparePush()`, `enabled()` and `requestPermission()`. Preserve those signatures and the existing `swarm-needs-you` / `swarm-quiet` channels.

- [ ] Merge current main, retaining #3154's channel implementation as the baseline rather than the superseded single-channel helper.
- [ ] Commit tests for delayed quiet-channel creation: concurrent startup and permission checks cannot finish before it; both channels are created once. Check loud metadata against the posted notice, quiet sound/vibration off, iOS no-op, and logged failure recovery.
- [ ] Run `flutter test --no-pub test/notify/local_system_notices_test.dart`; record the expected ordering/duplicate-preparation failures.
- [ ] Share the preparation future and await it during notification initialization. Update the design's channel description.
- [ ] Run the notification tests plus push-token and announcement consumer tests; record red/green evidence in the PR comment.
- [ ] Commit, push, mark ready, and hand the stable head to independent review/test while automatic CI runs.
