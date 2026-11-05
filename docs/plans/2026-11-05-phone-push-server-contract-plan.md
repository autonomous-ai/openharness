# Phone push on the merged server contract Implementation Plan

> Written by the writing-plans skill, implemented in this session test first (the project's Engineer workflow): each
> task's failing test is committed and watched failing before the code that passes it. Steps use checkbox (`- [ ]`)
> syntax.

**Goal:** The phone side of push (PR #3103) talks to the server part that merged in #3071 (backend v1.4.9): its routes,
its request bodies and the pushes it sends, so a signed-in phone is registered and a tapped push opens the chat it names.

**Architecture:** Only the phone changes. `ApiClient` calls `POST /api/push-devices` and `POST /api/push-devices/drop`
with `{platform, token}`; `PushTokens` keeps the platform it registered so it can drop that row; a tapped push is read by
its `link`, the app's own `swarm:` payload, through `decodeSwarmPayload`. Android stops drawing data-only pushes the
server never sends and takes the tap of the notification FCM draws itself; iOS stops working out an APNs gateway the
server never reads.

**Tech Stack:** Flutter 3.47.2 (Dart), Kotlin (firebase-messaging 26.0.1), Swift.

**Spec:** the merged server: `backend/src/routes/pushDevices.ts`, `backend/src/push/notices.ts`, `push/apns.ts`,
`push/fcm.ts`. Tony's `docs/design/2026-11-05-phone-push.md` and `docs/plans/2026-11-05-phone-push-backend-plan.md`
describe the contract as first proposed; where they differ, the merged server wins (gaps listed in the backend plan).

## Global Constraints

- Register body is exactly `{ "platform": "ios" | "android", "token": "<1..4096 of [A-Za-z0-9:_-]>" }`: the server's zod
  object is `.strict()`, so any other key (`environment`, `device`) answers 400.
- Drop body is the same object, sent to `POST /api/push-devices/drop`; the token never goes in a path or a log.
- A push carries two strings beside the platform's own fields: `key` and `link`. `link` is
  `swarm:<tab>/<conversation>/message/<message>[/thread/<root>]`, each part URI-encoded.
- The server forgets a phone not seen for 90 days; the phone renews every 7.
- Device tokens are credentials: never logged, never in chat; tests use fakes only.
- Format only changed files.

## Review Focus

1. A record on disk from before this change (no `platform`) — expected: read as never told, registered again.
2. A tapped push whose `link` is an agent or device payload, or not a `swarm:` link — expected: opens nothing.
3. A push with the old keys (`kind`, `swarm`, `conversation`) and no `link` — expected: opens nothing.
4. An Android tap on a notification another app forged into the launcher intent — expected: at most opens a chat, as a
   message link already can; never anything else.
5. A sign-out while a register is in flight — expected: nothing registered after it (Tony's epoch test stays).

---

### Task 1: The API calls the merged routes

**Files:**
- Modify: `mobile/lib/notify/push_tokens.dart` (`PushTokenApi`), `mobile/lib/notify/push_channel.dart` (`PushAddress`),
  `mobile/lib/api/api_client.dart`
- Test: `mobile/test/api/api_client_test.dart`, `mobile/test/viewer_app_fixture.dart`

**Interfaces:**
- Produces: `typedef PushAddress = ({String token, String platform})`;
  `PushTokenApi.registerPushToken(PushAddress address)`; `PushTokenApi.forgetPushToken(PushAddress address)`.

- [ ] **Step 1: Write the failing tests** — `registers on the merged route with exactly platform and token`: one request,
  `POST /api/push-devices`, bearer of the sign-in, body `{'platform': 'ios', 'token': 'apns-1'}`. `drops with the same
  body, never the token in the path`: `POST /api/push-devices/drop`, body `{'platform': 'android', 'token': 'fcm-1'}`.
  The 404 test keeps its status assertion.
- [ ] **Step 2: Run** `flutter test test/api/api_client_test.dart` — expected FAIL (PUT to `/api/push-tokens`).
- [ ] **Step 3: Commit the red test.**
- [ ] **Step 4: Implement** the two calls with `_dio.post`; drop `environment` from `PushAddress` and `device`.
- [ ] **Step 5: Run** the same file — PASS. Commit.

### Task 2: Token registration follows the address and drops what it registered

**Files:**
- Modify: `mobile/lib/notify/push_tokens.dart`, `mobile/lib/notify/push_channel.dart` (`pushAddressFrom`),
  `mobile/lib/state/app_state.dart` (`_initPush`)
- Test: `mobile/test/notify/push_tokens_test.dart`, `mobile/test/notify/push_channel_test.dart`,
  `mobile/test/app_state_push_test.dart`

**Interfaces:**
- Consumes: Task 1's `PushAddress` and `PushTokenApi`.
- Produces: `PushTokens({channel, storage, allowed, now})` (no `device`).

- [ ] **Step 1: Write the failing tests** — `push_tokens_test`: `registers the address, and again when the token or the
  account changes` (registered `[(ios, apns-1), (ios, apns-2), (ios, apns-2)]`); `notices off drops the row it
  registered` (`forgotten == [(token: 'apns-1', platform: 'ios')]`); `a record from before the platform was kept counts
  as never told` (record `{account, token, at}` → registered once, record now holds `platform`). `app_state_push_test`:
  `the token reaches the merged route after sign-in and again on change; logout drops it` asserting
  `FakeApi.pushRegistered`/`pushForgotten` as `PushAddress` lists.
- [ ] **Step 2: Run** the three files — expected FAIL (compile: `device`, `environment`).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**: record `{account, platform, token, at}`; `_read` returns null without `platform`; `_take`
  sends the record's address; renew comment says 90 days; `pushAddressFrom` takes token and platform only.
- [ ] **Step 5: Run** — PASS. Commit.

### Task 3: A tapped push opens the chat its link names, and nothing else

**Files:**
- Modify: `mobile/lib/notify/system_notices.dart` (`openPushed`; remove `pushSwarmTarget`, `_pushId`)
- Test: `mobile/test/notify/local_system_notices_test.dart` (group `pushes`), `mobile/test/app_state_push_test.dart`

**Interfaces:**
- Produces: `void openPushed(Map<String, String> data, SystemNotices notices)`, reading only `data['link']`.

- [ ] **Step 1: Write the failing tests** — `a reply push opens the thread at the reply`:
  `{'key': 'reply:s1:r1', 'link': 'swarm:s1/c1/message/m1/thread/t1'}` → `openedSwarm` `(s1, c1, m1, null, t1)`;
  `a tag push opens the chat at the message`: link `swarm:s%2F1/c1/message/m1` → swarmId `s/1`;
  `a push opens nothing else`: links `machine-1\nagent-7`, `device:k`, `swarm:s1`, `https://x`, missing link, and the
  old `{'kind': 'agent_question', 'machine', 'agent'}` and `{'kind': 'swarm', 'swarm', 'conversation'}` leave both
  `openedSwarm` and `opened` null. `app_state_push_test`: `a tapped push opens the chat its link names`.
- [ ] **Step 2: Run** — expected FAIL (no `link` read).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** `openPushed` via `decodeSwarmPayload(data['link'])`.
- [ ] **Step 5: Run** — PASS. Commit.

### Task 4: Native sides match what the server sends

**Files:**
- Modify: `mobile/android/.../MainActivity.kt`, `mobile/android/.../PushService.kt`,
  `mobile/android/app/src/main/AndroidManifest.xml`, `mobile/ios/Runner/AppDelegate.swift`

- [ ] **Step 1:** Android: FCM draws the server's notification message itself while the app is away; its tap starts the
  launcher activity with the data (`key`, `link`) and FCM's `google.message_id` as extras. `receivePush` takes such an
  intent's `key` and `link` once. `PushService` keeps `onNewToken` only (in front, the app's own notices decide).
- [ ] **Step 2:** iOS: `address` answers `{token, platform}`; the provisioning-profile gateway goes.
- [ ] **Step 3:** Type-check where the toolchain exists (`swiftc -typecheck`, `kotlinc`); no device or simulator install.
  Commit.

### Task 5: Gaps between the backend plan and the merged server

**Files:** Modify: `docs/plans/2026-11-05-phone-push-backend-plan.md` (a "Merged server, 11-05" section at the top),
`docs/design/2026-11-05-phone-push.md` (a pointer to it).

- [ ] **Step 1:** One line per gap: route, payload field, platform, trigger. Small phone-side ones are fixed in Tasks 1-4;
  server ones go to the PM as proposals. Commit.
