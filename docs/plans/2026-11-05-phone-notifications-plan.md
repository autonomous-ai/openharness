# Phone notifications: tested end to end, listed in one table, no spam (task #3248) Plan

> Worked by the Engineer, test first (superpowers test-driven-development): each task's failing test is committed and
> seen red before the code that passes it. Characterization tests of what already ships are committed green, and a
> red one is a finding fixed in the task after it.

**Goal:** Every notification the phone can show is listed in `docs/phone-notifications.md`; each server push type has
integration tests (who gets it, its payload, the link it carries, never the author, never drawn while the app is in
front); a push reaches a closed app and its tap opens the right chat, shown end to end on a simulator and on Tony's
iPhone 14; and the push rule Tony approves is built with tests.

**Architecture:** Server: `superTabs/store.ts` writes reply rows (`activity.ts writeReplyActivity`) and tag rows
(`mentions.ts writeMentions`) in a command's transaction; `push/notices.ts` words a `PhoneNotice` for each;
`push/send.ts` sends them after commit to every registered phone (`push/devices.ts`) through `push/apns.ts` or
`push/fcm.ts`. Phone: `lib/notify/system_notices.dart` posts every Local notice and opens a tapped push's `link`
(`lib/notify/push_channel.dart`, native `AppDelegate.swift` / `MainActivity.kt`). #3150 (Sequoia2) adds the "a push
already shown is not posted again" half; this task builds on it.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, vitest with a loopback replica set (`npm run test:super-tabs`
in CI); Flutter 3.47, `flutter test`; an XCUITest runner for the springboard taps; `xcrun simctl push` for a
simulator push; the production backend's APNs sandbox key for the iPhone (a development build's token).

**Spec:** task #3248 brief; `docs/design/2026-11-05-phone-push.md`; `docs/phone-notifications.md`.

## Global Constraints

- Owned paths only: `docs/phone-notifications.md`, `mobile/`, `backend/src/push/`, `backend/integration/` (and this plan).
- Push keys and signing secrets never in chat, logs or the repository; the iPhone run uses the production backend's own
  keys, nothing local.
- One installer on Tony's iPhone at a time: say in the task when an install starts and ends; ask first that it is free.
  `flutter drive` always with `-d` and `--keep-app-running`; never a debug drive on the phone (it cannot attach from here).
- Nothing in this task changes which events push until Tony approves the rule (Task 5). Two security reviews if it does.
- Never a test that signs the Mac out of the real CLI. Stop only processes started here, by id. Temp files in `mktemp -d`.

## Design

- growth: no new collection in Tasks 1 to 4. Task 5 adds none either: the "sound once per unread thread" check reads the
  person's existing Activity rows (TTL `ACTIVITY_EXPIRY_MS`).
- concurrency: unchanged; notices are made inside the write's transaction and sent after it commits.
- read cost: Task 5 adds at most one indexed read of unread reply rows per reply write that tells someone.
- scale: a 100-person thread is 100 notices sent 8 at a time (`AT_ONCE`); collapsing per thread lowers what a phone shows,
  not what the server sends. The metric that warns first: `phone_push` counts by outcome.
- compatibility: an old app ignores fields it does not read (`apns-collapse-id` is a header; `key`/`link` unchanged).
- migration + rollback: none; reverting restores today's pushes.
- audience: the server decides who is told (rows written for people who can read the chat); the phone never widens it.
- identity: each phone token belongs to the person who registered it last; nothing uses the machine owner's login.
- failure: a push that cannot be made or sent is logged and counted, never the write's failure (as today).
- platforms: iOS and Android phone app, backend.

## Review Focus

- The integration tests assert the real audience (`writeReplyActivity`, `writeMentions`) and the real request body Apple
  receives, not a copy of the code under test.
- The e2e: the push reaches an app that is not running, and the tap opens the chat its `link` names.
- Task 5 (after Tony's yes): who stops being told, and that nobody new is told who could not read the chat.

## Task 1: Server integration tests for each push type

**Files:** `backend/integration/superTabActivity.test.ts`

**Interfaces:** none new.

- [ ] Reply push: the thread's starter, the quoted message's author, a person tagged earlier in the thread and a person
      who replied are told; the author never; a muted chat, an unfollowed thread and a person who cannot read the chat
      never; a reply that tags someone tells them by the tag alone; an agent's reply is worded with the agent's name;
      a Swarm line in a thread tells only the starter and the quoted author; a top-level message and a reaction tell
      nobody. Each notice: key `reply:<swarm>:<row>`, title, the project as subtitle, `Open Harness to read it.`, and
      the link to the reply in its thread.
- [ ] Tag push: a tag in the chat links the message; a tag in a reply only in its thread links that thread; a reply
      also sent to the chat links the message in the chat; one's own tag is dropped; an agent's tag is worded with its
      name; a tag held for a quiet chat is not pushed; key `mention:<row>`.
- [ ] Run: `npx vitest run --config vitest.super-tabs.config.ts integration/superTabActivity.test.ts`.

## Task 2: The whole server path, write to Apple's request

**Files:** `backend/integration/superTabActivity.test.ts`

**Interfaces:** none new; `sendPhoneNotices` with `apnsSender` and `fcmSender` over a recording transport.

- [ ] A registered iPhone and Android phone of the starter; a reply's write ends in one APNs request and one FCM
      message: the alert's title, subtitle and body, `thread-id` and `category` `swarm-needs-you`, `key` and `link`; the
      author's own phone gets nothing; nothing written in the chat is in either request.

## Task 3: Fixes the tests and the inventory found that change no rule

**Files:** `mobile/lib/notify/system_notices.dart` (and its test), `mobile/android/...` only if needed.

- [ ] Android: the `swarm-needs-you` channel exists before a push can arrive (made when notices start), so a push is
      never drawn on FCM's default channel. Failing test first: the channel is created at start, before any Swarm notice.
- [ ] Any red test of Tasks 1, 2 or 4: its failing test, then its fix.

## Task 4: Phone end to end: a push to a closed app, and its tap

**Files:** `mobile/integration_test/push_e2e_app.dart` (the real `PhoneShell` with a scripted Swarm, real
`LocalSystemNotices` and `PushChannel`), `mobile/integration_test/push_e2e/` (XCUITest runner, `simctl push` payload,
the script that runs it and keeps its screenshots).

- [ ] Simulator: the app is not running; `xcrun simctl push` delivers a reply push whose `link` names a thread of the
      scripted Swarm; the runner taps the notification on the springboard; the app starts and shows that thread.
      Also: with the app in front, the same push is not drawn.
- [ ] Tony's iPhone 14 (after asking that it is free): a development build, signed in to Tony's account; the app closed;
      a real reply in a thread Tony started reaches the phone through the production backend's APNs sandbox key; the
      tap opens that thread. Evidence in the PR: the run's log and a description of the screenshots (they stay in the
      task chat: no photos of a real phone in this public repository).

## Task 5: The push rule Tony approves (only after his yes)

**Files:** `backend/src/push/notices.ts`, `backend/src/push/apns.ts`, `backend/src/push/fcm.ts`,
`backend/src/push/sender.ts`, their tests, `backend/integration/superTabActivity.test.ts`, `mobile/lib/notify/`,
`mobile/lib/swarm/swarm_notices.dart`, `docs/phone-notifications.md`.

- [ ] Each change of who is told or how repeats collapse, as Tony approved it: a failing test first, then the code.
- [ ] The table updated to the new rule; two security reviews requested (it changes who receives a push).
