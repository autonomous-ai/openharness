# The signed-in check no longer holds up the first window — plan (task #3561)

**Goal:** Desktop opens its window without waiting for `harness auth status`. The check is the second slowest launch
step (245 ms median, 303 ms slowest on a release build, speed plan C for Huy); it is a Node process start, about 200 ms
on an M2 Ultra even when it has nothing to refresh. A signed-out person still lands on the sign-in page.

**Architecture:** "What's already stored" is the kept profile (`ProfileCache`, task #2169): it is written only after the
CLI proved the account by its machine id and the server named it, and every sign-out the app sees clears it. When it is
there, and the CLI's own sign-in file is on disk (looked at, never read), the launch opens as that account at once and
the check finishes in the background. The check then either proves the same machine id (nothing changes), says signed
out (the window goes to the sign-in page through the existing runtime sign-out path, `_signedOutAtRuntime`, as when a
sign-out elsewhere is noticed), or names another account or cannot answer (the launch starts again from the CLI's
answer, as a launch with nothing kept does today). With nothing kept, or no sign-in file, the launch waits for the
check exactly as before.

**Tech Stack:** Flutter 3.47 / Dart 3.13, `flutter_test` with a memory store and a fake sign-in.

**Spec:** River's brief on task #3561: show the window from what's already stored and finish the check in the
background, or make it cheaper; a signed-out person still lands on sign-in; before/after speed marks; tests that
signed-in and signed-out launches both land on the right screen. Two security reviews (sign-in state).

This plan is written and carried out by its Engineer, test first; there is no execution handoff.

## Design

- Growth: nothing new is stored; the kept profile is the one record it already was, cleared as before.
- Concurrency: one isolate. The background check runs under the launch's auth revision; a sign-out or sign-in meanwhile
  invalidates it, as every other auth work.
- Read cost: one key read of the kept profile (already read today, after the check) and one `stat` of
  `~/.harness/auth/session.json`. No token is read.
- Scale: N/A because it is one launch of one app.
- Compatibility: no CLI, API or file format change. An older CLI answers `auth status` as before.
- Migration + rollback: none; reverting puts the check back in front of the window.
- Audience: the server still enforces every request; the daemon, not the app, holds the session. The early window shows
  only this computer's saved desk and the kept profile of the account the computer was last proven signed in as.
- Identity: the account is the CLI's sign-in, proven by its machine id; never the machine owner's login.
- Failure: a check that says signed out shows the sign-in page with "You were signed out on this computer"; one that
  cannot run ends on the login screen, as today.
- Platforms: macOS, Windows and Linux share this Dart path; a viewer (web, phone) has no CLI and is unchanged.

## Global Constraints

- A signed-out computer never opens as signed in when the app knows it: no kept profile (every in-app sign-out and
  every signed-out launch clears it) or no CLI sign-in file (`harness logout` deletes it) waits for the check as before.
- The one case the early window can be wrong is a sign-in ended while the app was closed that left the file on disk
  (a server revoke or refused refresh, marked inside the file). The window then shows the saved desk for as long as
  the check takes (about 200 ms) and goes to the sign-in page, as a running app does when the same thing happens to it.
- Desktop tests use a memory store and a fake sign-in; nothing runs the real CLI.
- No switch: the optimisation ships on.

## Review Focus

- Every disagreement between the check and the kept profile ends where today's launch would have ended.
- No profile is kept, and no picture cache claimed, before the check proves the machine id.

## Tasks

### 1. The kept record can be read without a machine id (`desktop/lib/state/profile_cache.dart`)

Files: `desktop/lib/state/profile_cache.dart`, `desktop/test/profile_cache_test.dart`.
Interfaces: `Future<({String machineId, CurrentUserProfile profile})?> ProfileCache.readKept()`.

- [ ] Failing test: `readKept` returns the record with its machine id; malformed records read as none.
- [ ] Code that passes it; `read(machineId)` uses it.

### 2. A launch with a kept sign-in opens before the check (`desktop/lib/state/app_state.dart`)

Files: `desktop/lib/state/app_state.dart`, `desktop/test/kept_sign_in_launch_test.dart`.
Interfaces: `bool Function() AppNotifier.cliSessionOnDisk` (`@visibleForTesting`, false under test).

- [ ] Failing tests (memory store, fake sign-in whose check is held):
  - signed in with a kept profile: the window (`authenticated`, workspace, not the sign-in page) opens while the check
    is still running, then the check proves it and nothing changes; the `window` speed mark comes before
    `signed-in check`;
  - signed out (nothing kept): the launch waits for the check and lands on the sign-in page;
  - kept profile but no CLI sign-in file: waits, as before;
  - kept profile, check says signed out: ends on the sign-in page, nobody shown, the kept profile gone;
  - kept profile, check names another machine: ends signed in with nobody shown until the server answers, the old
    record gone;
  - kept profile, CLI cannot answer: ends on the login screen, as today;
  - no profile is kept before the check proves the machine id.
- [ ] Code that passes them.

### 3. Before/after numbers

- [ ] Speed marks of a launch with a check held for the measured 245 ms, before and after, in the PR; the release-build
      launch on a Mac where the app can run is the Tester's.
