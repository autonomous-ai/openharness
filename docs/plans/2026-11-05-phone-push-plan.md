# Phone Push Implementation Plan

Task #2905, requested by anh Dee (#2745). Written by the task's Engineer by the writing-plans skill, implemented by the same
Engineer task by task, test first; the review step on the pull request is the one independent review.

**Goal:** A thread reply to someone in the thread, and a tag, reach that person's phone as a system notification while the
app is closed, and a tap opens the thread at the reply.

**Architecture:** The server already decides who hears a reply (`writeReplyActivity`, #2954) and a tag (`writeMentions`) in
the reply's own transaction. After that transaction commits, a new `push/` module turns those rows into phone notices and
sends each to the person's registered phones: APNs (HTTP/2, a JWT signed with the team's .p8 key) for iOS, FCM HTTP v1 (an
OAuth token from the service account) for Android. The phone registers its push token when signed in and drops it when
signing out, through two routes beside the device keys. The phone's native code (iOS AppDelegate, Android MainActivity) gets
the token and hands a tapped notification's link to Dart, which opens it as it opens a local Swarm notice today.

**Tech Stack:** TypeScript (Fastify, Prisma on MongoDB, node:http2 and node:crypto, no new npm dependency); Flutter (Dart),
Swift, Kotlin with `com.google.firebase:firebase-messaging` on Android only.

**Spec:** the task's brief (task #2905), and #2954's design `docs/plans/2026-11-04-thread-reply-notifications-design.md`
for who is told.

## Global Constraints

- Push for the same events #2954 notifies about: a reply to someone in the thread (its Activity row) and a tag (its mention
  row). Muted chats and Unfollow stay as #2954 has them: they decide the rows, and push follows the rows.
- The open-thread rule stays on the phone: a push that arrives while the app is in front shows nothing; the app's own
  notices (`SwarmAnnouncer`, with its `quiet` check) decide there.
- A notice says who and where, never what was written: the same title, subtitle and body as the phone's local notices
  (`swarm_notices.dart`: "X replied in a thread" / "X tagged you", the project, "Open Harness to read it."). Message text
  never goes to Apple or Google.
- Push keys live only in the server's environment (the secret store): `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`,
  `APNS_TOPIC` (default `ai.autonomous.harness.ios`), `FCM_SERVICE_ACCOUNT` (base64 of the JSON key). One APNs value
  without the others, or a key that cannot be read, stops the server at start with a message that never shows the key.
  None set: push is off and each skipped push is counted and logged, never silent.
- A token is the person's who registered it last; a sign-out drops it; a token Apple or Google call dead is deleted. A team
  session registers no token.
- Tokens never reach logs, metrics or errors. Metrics carry platform and outcome only.
- No new npm dependency. On the phone, Firebase only on Android, configured at build time; a build without its values
  has Android push off and says so in the app log.
- Swarm code stays out of `cli/src/core`. Two security reviews (tokens).

## Design

- growth: `PushDevice` rows. Deleted on sign-out, on a dead-token answer, at most 10 per person (the oldest go when an 11th
  registers), and by a TTL index 90 days after `seenAt`; the phone registers again at every signed-in launch.
- concurrency: one row per token (`_id` = SHA-256 of platform and token); register is an upsert by id, so two at once end
  with one row, the last owner's.
- read cost: one indexed read of the told people's devices per command that tells anyone (`userId $in`, at most 105
  people: 100 reply fan-out and 5 tags); nothing when nobody is told. No polling.
- scale: 10x people in a thread is still capped by `REPLY_FANOUT`; sends run 8 at a time with a 10-second timeout. What
  warns first: `phone_pushes_total{outcome="failed"}` and the send time in the `phone push` log line.
- compatibility: new routes and a new collection; an older phone never registers and keeps its open-app notices. A phone
  with this change against an older server gets 404 on register, logged and ignored.
- migration + rollback: none to run. The TTL index is made before the push (`releaseSchema`); rolling back stops sends,
  and the rows expire in 90 days or can be dropped with the collection.
- audience: rows are written only for people who may read the chat (#2954); push goes only to the tokens of those people.
- identity: tokens are per signed-in person (`req.user.sub`); team sessions are refused.
- failure: a send that fails is logged with platform and APNs/FCM reason and counted; push never blocks or fails the
  reply's write (it runs after the commit, its errors caught).
- platforms: backend; iOS and Android phone app.

## Review Focus

1. The same phone signed in as another person: the token must move to the new person, so the first stops getting the
   second's notices. Test: register as A then B, push for A sends nothing (Task 1).
2. Sign-out on a phone with no network: the drop fails and the token stays on the server. The phone does not retry it; the
   app is signed out, so a push it gets opens the welcome screen and shows no content beyond the notice. The next person
   signing in on that phone takes the token over (1), and Apple or Google calling it dead deletes it. Tested by (1).
3. A development build (Xcode) has a sandbox token: production APNs answers `BadDeviceToken`, and the server retries once
   on the sandbox host and remembers it. Test in Task 3. Apple's keys are per environment (Ken, 11-05): the production key
   (`APNS_KEY_ID`, `APNS_PRIVATE_KEY`) signs for the production host alone, an optional sandbox key (`APNS_SANDBOX_KEY_ID`,
   `APNS_SANDBOX_PRIVATE_KEY`) for the sandbox host alone; with no sandbox key nothing goes to the sandbox host, the push
   is skipped (`unconfigured`, logged without the token) and the token kept.
4. A push while the app is in front must not show twice (push and local notice): iOS presents nothing for a remote Swarm
   push in the foreground, FCM does not draw a notification message in the foreground. And a push already in the tray is
   not posted again by the app when it comes back: the app marks the keys of delivered pushes told (Task 7 test).
5. A tag held back for 20 minutes (no worker yet, `holdMentions`) does not push at the time it is written. Test in Task 4.

---

### Task 1: Push devices, stored

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `PushDevice`, `@@map("push_devices")`)
- Create: `backend/src/push/devices.ts`
- Modify: `backend/src/lib/db/schemaRelease.ts` (`ensurePushDeviceExpiry` before `ensureSchema`)
- Modify: `backend/integration/schemaRelease.test.ts` (the new expiry index in its list)
- Test: `backend/integration/pushDevices.test.ts` (a real replica set, with the plan check; listed in `vitest.super-tabs.config.ts`)

**Interfaces:**
- Produces: `type PushPlatform = 'ios' | 'android'`; `interface PushDevice { id: string; userId: string; platform: PushPlatform; token: string; sandbox: boolean }`;
  `registerPushDevice(db, userId: string, device: { platform: PushPlatform; token: string }, now: number): Promise<void>`;
  `dropPushDevice(db, userId: string, device: { platform; token }): Promise<boolean>`;
  `devicesOf(db, userIds: string[]): Promise<PushDevice[]>`; `forgetPushDevice(db, id: string): Promise<void>`;
  `markSandbox(db, id: string): Promise<void>`; `ensurePushDeviceExpiry(db)`; `PUSH_DEVICES_PER_PERSON = 10`;
  `PUSH_DEVICE_EXPIRY_MS = 90 days`.

- [ ] Step 1: tests: register then `devicesOf([A])` returns it; register as A then B: `devicesOf([A])` is empty and B has it;
  the 11th register keeps the 10 newest; `dropPushDevice` by another person returns false and keeps the row; by the owner
  deletes it; `devicesOf([])` reads nothing.
- [ ] Step 2: run `npx vitest run --config vitest.super-tabs.config.ts integration/pushDevices.test.ts`: FAIL (module missing). Commit the test.
- [ ] Step 3: implement. `_id` = hex SHA-256 of `platform + '\n' + token`. `devicesOf` is an `aggregateRaw` `$match` on
  `userId $in` (rule 3: Prisma's `in` is `$expr`). The cap deletes beyond the 10 newest `seenAt` of that person.
- [ ] Step 4: run it: PASS. Integration plan test: `devicesOf` is an IXSCAN on `userId`. Commit.

### Task 2: Register and drop routes

**Files:**
- Create: `backend/src/routes/pushDevices.ts`; Modify: `backend/src/routes/control.ts` (register it)
- Test: `backend/src/routes/pushDevices.test.ts`

**Interfaces:**
- Consumes: Task 1. Produces: `POST /api/push-devices` `{platform, token}` → `{ok: true}`; `POST /api/push-devices/drop`
  `{platform, token}` → `{dropped: boolean}`.

- [ ] Step 1: tests: a signed-in person registers (row for `req.user.sub`); a team session gets 403 `TEAM_SESSION_LIMITED`;
  a token with characters outside `[A-Za-z0-9:_-]` or longer than 4096 gets 400; drop removes only the caller's; the 21st
  call in a minute gets 429.
- [ ] Step 2: FAIL; commit. Step 3: implement with `validateBody` (zod, strict) and `createRateLimiter('push-devices', 60_000, 20)`.
- [ ] Step 4: PASS; commit.

### Task 3: Senders (APNs and FCM)

**Files:**
- Create: `backend/src/push/sender.ts` (the shared types), `backend/src/push/apns.ts`, `backend/src/push/fcm.ts`, `backend/src/push/keys.ts`
- Modify: `backend/src/config/env.ts` (the five variables, read through `push/keys.ts`)
- Test: `backend/src/push/apns.test.ts`, `backend/src/push/fcm.test.ts`, `backend/src/push/keys.test.ts`

**Interfaces:**
- Produces: `interface PhoneNotice { personId: string; key: string; title: string; subtitle: string; body: string; link: string }`;
  `type SendOutcome = 'sent' | 'gone' | 'sandbox' | 'failed' | 'unconfigured'`; `interface SendResult { outcome: SendOutcome; reason?: string }`;
  `interface Sender { send(device: PushDevice, notice: PhoneNotice): Promise<SendResult> }`;
  `apnsSender(keys: ApnsKeys, options?: { transport?; now?; timeoutMs? }): Sender`; `fcmSender(account: FcmAccount, options?: { fetcher?; now?; timeoutMs? }): Sender`;
  `pushKeysFromEnv(env): { apns: ApnsKeys | null; fcm: FcmAccount | null }` (throws a message without the key on a bad one).

- [ ] Step 1: tests. APNs: the request has `:path /3/device/<token>`, `apns-topic`, `apns-push-type: alert`, priority 10,
  `authorization: bearer <JWT>` whose ES256 signature verifies with the key's public half and whose `iss`/`kid` are the team
  and key ids; the body is `{aps: {alert: {title, subtitle, body}, sound: 'default', 'thread-id', category: 'swarm-needs-you'}, key, link}`
  and holds no other text; 200 → `sent`; 410 or 400 `Unregistered` → `gone`; 400 `BadDeviceToken` on production → retried
  on the sandbox host, 200 there → `sandbox`; 500 → `failed`; a hung transport → `failed` after the timeout; the JWT is
  reused within 50 minutes. FCM: the token request is a JWT bearer grant signed RS256 by the service account; the message
  is `{message: {token, notification: {title, body}, android: {priority: 'high', notification: {channel_id: 'swarm-needs-you', tag: key}}, data: {key, link}}}`;
  404 or `UNREGISTERED` → `gone`; the access token is reused until near its expiry. Keys: none set → both null; APNs
  partly set → throws naming the missing variable; a malformed key → throws, and the message does not contain the key.
- [ ] Step 2: FAIL; commit. Step 3: implement with `node:http2` (one session per host, reconnect when closed) and
  `node:crypto` `sign`. 10-second timeout on every call. Step 4: PASS; commit.

### Task 4: What a command tells phones, and sending it after commit

**Files:**
- Create: `backend/src/push/notices.ts`, `backend/src/push/send.ts`
- Modify: `backend/src/superTabs/activity.ts` (`writeReplyActivity` returns the rows it wrote),
  `backend/src/superTabs/mentions.ts` (`writeMentions` returns its rows), `backend/src/superTabs/store.ts` (hook
  `phoneNotices` after commit), `backend/src/routes/superTabs.ts` and `backend/src/worker.ts` (wire it),
  `backend/src/lib/metrics.ts` (`phone_pushes_total{platform,outcome}`)
- Test: `backend/src/push/notices.test.ts`, `backend/src/push/send.test.ts`, `backend/integration/superTabActivity.test.ts` (the store's hook)

**Interfaces:**
- Consumes: Tasks 1 and 3; `actorName`, `threadOf`-like rule (a thread-only message links its thread).
- Produces: `phoneNotices(tabId: string, state: SuperTabState, written: { replies: ReplyRow[]; tags: TagRow[] }, messages: MessageDraft[]): PhoneNotice[]`;
  `sendPhoneNotices(db, senders: { ios: Sender | null; android: Sender | null }, notices: PhoneNotice[]): Promise<void>`;
  `phoneSendersFromEnv(env): PhoneSenders`;
  `SuperTabStoreHooks.phoneNotices?: (notices: PhoneNotice[]) => void`.

- [ ] Step 1: tests. `phoneNotices`: a reply row → title `Mia replied in a thread`, subtitle the conversation's project
  name, body `Open Harness to read it.`, key `reply:<tab>:<row id>`, link `swarm:<tab>/<conversation>/message/<message>/thread/<root>`;
  a tag → `Mia tagged you`, key `mention:<mention id>`, link to the message (with its thread when only in the thread); a
  held tag → nothing. `sendPhoneNotices`: one devices read for all people; each device sent once; `gone` deletes the row;
  `sandbox` marks it; no sender for a platform → counted `unconfigured` and logged. Store (`superTabActivity.test.ts`): a reply
  by B in A's thread calls the hook once with A's notice after commit, keyed by A's Activity row; a muted A gets no reply
  notice but gets a tag. A write that fails calls nothing because the hook runs through `afterCommit`.
- [ ] Step 2: FAIL; commit. Step 3: implement; the hook runs `sendPhoneNotices` unawaited with its errors caught and
  logged. Step 4: PASS, plus the existing `activity`, `mentions` and `replyAudience` tests; commit.

### Task 5: The phone registers and drops its token (Dart)

**Files:**
- Create: `mobile/lib/notify/push_registration.dart`
- Modify: `mobile/lib/api/api_client.dart` (`registerPushToken`, `dropPushToken`), `mobile/lib/state/app_state.dart`
  (register when signed in, drop in `_endSession` before the session goes, as the device log leaves)
- Test: `mobile/test/notify/push_registration_test.dart`

**Interfaces:**
- Produces: `class PushRegistration { PushRegistration({MethodChannel channel, required Future<bool> Function(String platform, String token) register, required Future<bool> Function(String platform, String token) drop, required void Function(SwarmNoticeTarget) open}); Future<void> signedIn(); Future<void> signedOut(); Future<Set<String>> deliveredKeys(); }`
  over the channel `harness/push`: Dart calls `token` (→ `{platform, token}` or null) and `delivered` (→ keys); native
  calls `token` (refreshed) and `opened` (`{link}`).

- [ ] Step 1: tests: `signedIn` sends the channel's token once; a refreshed token from native is sent again while signed
  in and not after `signedOut`; `signedOut` drops the token it registered and gives up after 5 seconds; a null token sends
  nothing; `opened` with a `swarm:` link calls `open` with the decoded target; a malformed link opens nothing.
- [ ] Step 2: FAIL; commit. Step 3: implement. Step 4: `flutter test test/notify/push_registration_test.dart`: PASS; commit.

### Task 6: Native: iOS (APNs) and Android (FCM)

**Files:**
- Modify: `mobile/ios/Runner/AppDelegate.swift` (`PushChannel`), `mobile/ios/Runner/Runner.entitlements` (`aps-environment`)
- Modify: `mobile/android/app/build.gradle.kts` (firebase-messaging; `FCM_*` build values to `BuildConfig`),
  `mobile/android/app/src/main/AndroidManifest.xml` (the service), `.../MainActivity.kt` (the channel, a tapped intent's link)
- Create: `mobile/android/app/src/main/kotlin/ai/autonomous/harness/android/PushService.kt`

- iOS: `registerForRemoteNotifications` on `token`; the token as hex; `willPresent` answers `[]` for a push carrying `link`;
  `didReceive` hands its `link` to Dart (held until Dart is listening, for a tap that launched the app); `delivered` lists
  the `key` of delivered pushes. Android: Firebase app from `BuildConfig` values (none: `token` answers null and logs why);
  `onNewToken` → Dart; a launch intent with a `link` extra → Dart; `delivered` lists active notifications' tags.
- [ ] Verify: `flutter build ios --no-codesign --debug` and `flutter build apk --debug` compile. PR CI builds neither and
  the Engineer's account has no Xcode or Android SDK, so this and the device behavior are the Tester's, on Tony's Mac
  with a Tony-approved build. Here: `swiftc -parse`, `plutil -lint` and the manifest's XML only.

### Task 7: No second notice for a push already shown

**Files:**
- Modify: `mobile/lib/swarm/swarm_notices.dart` (`SwarmTold.addAll(Iterable<String> keys)`),
  `mobile/lib/swarm/swarm_session.dart` (`SwarmHost.toldElsewhere`), `mobile/lib/phone/phone_shell.dart` (back in front:
  `pushDeliveredKeys()` first, then Swarm reads)
- Test: `mobile/test/swarm/swarm_notices_test.dart`

- [ ] Step 1: test: keys marked told elsewhere are not announced (a reply row and a tag with those keys post nothing);
  others still are. Step 2: FAIL; commit. Step 3: implement. Step 4: PASS; commit.
