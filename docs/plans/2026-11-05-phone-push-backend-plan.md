# Phone push notifications: backend plan (phase 1)

- **For:** the backend team (and whoever owns the CLI part in section 6.2).
- **Date:** 2026-11-05.
- **Phone side:** built in the same pull request as this plan (`feat/mobile-push-notifications`). The contract it was
  built to is `docs/design/2026-11-05-phone-push.md`. This plan is how to build the backend half of it in this repo.
- **Secrets:** the two APNs `.p8` files and the FCM credentials are **not** in this file. They are handed over
  separately, on a secure channel. Section 1 says where each one goes.

## 0. Scope

What the phone already does:

- Signed in, with notices allowed by the OS, it sends its push address to `PUT /api/push-tokens`. It sends it again
  when the token, its APNs gateway or the account changes, and otherwise once every 7 days. A failed call is retried
  after 1 hour or at the next launch, and is never shown to the person.
- On sign-out, or when notices are turned off, it calls `DELETE /api/push-tokens`. It also stops the OS delivering to
  that token.
- A push that lands while Harness is in front is not shown. A tapped push opens the Swarm conversation (at the message,
  thread or decision) or the agent it names.

What the backend builds:

| # | Part | Section |
| --- | --- | --- |
| 1 | Secrets and config | 1 |
| 2 | `PushToken` collection | 2 |
| 3 | `PUT` / `DELETE /api/push-tokens` | 3 |
| 4 | APNs and FCM senders | 4 |
| 5 | Payload and copy per kind | 5 |
| 6 | Triggers: Swarm needs, agent question / finished turn | 6 |
| 7 | Cleanup of dead tokens | 7 |
| 8 | Logs and metrics | 8 |
| 9 | Tests | 9 |

Not in phase 1: payload encrypted to the device key (phase 2, needs a Notification Service Extension), badge counts
sent by the server (the app sets its own), clearing a notice from the server once the need is resolved.

## 1. Secrets and config

Proposed names, read in `backend/src/config/env.ts` like the other optional keys. Rename freely, but keep them all
optional, so that an unset value turns the sender off (fail closed) without breaking boot.

| Env | Value | Secret? |
| --- | --- | --- |
| `APNS_TEAM_ID` | `54DJVWMJCC` | no |
| `APNS_TOPIC` | `ai.autonomous.harness.ios` (the iOS bundle id) | no |
| `APNS_SANDBOX_KEY_ID` | the sandbox key's id, handed over with its `.p8` | no |
| `APNS_SANDBOX_KEY` | base64 of the sandbox key's `.p8` | **yes** |
| `APNS_PRODUCTION_KEY_ID` | the production key's id, handed over with its `.p8` | no |
| `APNS_PRODUCTION_KEY` | base64 of the production key's `.p8` | **yes** |
| `FCM_PROJECT_ID` | `autonomous-harness` | no |
| `FCM_CREDENTIALS` | base64 of a service account JSON key. Empty: application default credentials (Workload Identity), the same rule as `SUPER_TAB_ATTACHMENTS_CREDENTIALS` | **yes** |

- Each APNs key is limited to **one** gateway: the sandbox key works only on `api.sandbox.push.apple.com`, the
  production key only on `api.push.apple.com`. Pick the key from the token's `environment`.
- The FCM identity (service account or Workload Identity) needs the role `roles/firebasecloudmessaging.admin` on the
  Firebase project `autonomous-harness`.
- Apple lets a `.p8` be downloaded only once. Keep the originals in the team's secret manager, not only in the cluster.
- Never write a key, a token or a push body to logs, errors, metrics, Sentry or a PR.
- Kill switch: with a gateway's key unset, nothing is sent to that gateway, and the routes keep storing tokens (so
  phones do not fall into retries).

## 2. Data: `PushToken`

One row per token. In `backend/prisma/schema.prisma`, in the style of the other models:

```prisma
/// Where to push to one phone (docs/design/2026-11-05-phone-push.md). One row per token; the last
/// account that registered a token owns it.
model PushToken {
  id        String   @id @default(auto()) @map("_id") @db.ObjectId
  token     String   @unique
  userId    String   // req.user.sub
  platform  String   // "ios" | "android"
  gateway   String?  // iOS only: "sandbox" | "production" (the request's `environment`)
  device    String?  // the phone's device key, base64, as sent to GET /api/device-keys `self`
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([device])
  @@index([updatedAt])
  @@map("push_tokens")
}
```

- The column is called `gateway` rather than `environment` so it is never confused with the backend's own
  staging/production environment. The API field stays `environment`.
- New collection: no migration. Rollback drops the routes and the collection.

## 3. Routes: `backend/src/routes/pushTokens.ts`

Follow `routes/deviceKeys.ts`: zod body with `validateBody`, `sendSuccess` / `sendError`, a `createRateLimiter`, and an
export in `routes/index.ts`. Both routes use the caller's own sign-in (`Authorization: Bearer`). The account is always
`req.user.sub`, never a body field.

### `PUT /api/push-tokens`

```json
{ "token": "…", "platform": "ios", "environment": "production", "device": "…" }
```

Validation (strict object):

| Field | Rule |
| --- | --- |
| `token` | string, 1 to 4096 chars |
| `platform` | `"ios"` or `"android"` |
| `environment` | required when `platform` is `ios`: `"sandbox"` or `"production"`. Absent on Android; ignore it if sent |
| `device` | optional string, at most 512 chars |

Behaviour:

1. Upsert by `token`: set `userId` to the caller, `platform`, `gateway`, `device`, and refresh `updatedAt`. A token
   stored for another account **moves** to the caller: the last sign-in on a phone owns it.
2. Keep at most 20 rows per account: after the upsert, delete that account's oldest rows beyond 20.
3. Answer `{ "success": true, "data": {} }`. The phone treats any other answer as "not stored" and retries later.

### `DELETE /api/push-tokens`

```json
{ "token": "…" }
```

- `deleteMany({ token, userId: caller })`. Idempotent: an unknown token, or one owned by someone else, also answers
  success, and deletes nothing of another account's.
- The token is in the body, not in the path, so it never reaches access logs.

### Both

- Rate limit: about 20 calls per account per minute (`createRateLimiter('push-tokens', 60_000, 20)`). A phone sends
  about one call a week.
- Team sessions: do **not** add these routes to `TEAM_ROUTES` (`lib/teamSession.ts`). A team sign-in is a daemon, not a
  phone, and is refused by default.
- Never log the token. If a log needs to tell tokens apart, log the first 8 hex characters of its SHA-256.

## 4. Senders: `backend/src/lib/push/`

Proposed files: `apns.ts`, `fcm.ts`, and `send.ts`. `send.ts` reads the recipient's rows, picks the sender per row,
handles the answer and deletes dead tokens.

- The senders are a library, run in whichever process the trigger fires in (section 6): the API processes (PM2
  cluster, through `afterCommit`) or the worker. Each process keeps its own HTTP/2 session per APNs gateway, which
  Apple allows.
- Fire and forget after the commit: a send never blocks or fails the Swarm write. It has one retry inside the sender
  and no queue. A push lost to a crash is acceptable in phase 1: the app shows every need when it opens.
- Dedupe Swarm needs across processes with a Redis key per recipient and need:
  `SET push:sent:<userId>:<need key> 1 NX EX 86400`. Send only if the `SET` succeeded. Do not dedupe agent pushes this
  way: their notice id is per agent, so a second question from the same agent must still go. The rate limit in 6.2
  bounds them, and the shared notice id makes the newer one replace the older on the phone.

### 4.1 APNs (iOS)

- HTTP/2 with `node:http2`, no new dependency. One session per host, kept open and reused. Reconnect on `GOAWAY` or
  on error.
  - `sandbox` goes to `https://api.sandbox.push.apple.com`.
  - `production` goes to `https://api.push.apple.com`.
- Provider token (JWT, ES256), signed with `node:crypto` (`sign` with `dsaEncoding: 'ieee-p1363'`):
  - header `{ "alg": "ES256", "kid": <key id of that gateway> }`;
  - claims `{ "iss": APNS_TEAM_ID, "iat": <now, seconds> }`;
  - make a new one about every 40 minutes. Apple refuses one older than 60 minutes, and returns
    `TooManyProviderTokenUpdates` if it changes more often than every 20.
- Request `POST /3/device/<token>` with headers:
  - `authorization: bearer <jwt>`
  - `apns-topic: ai.autonomous.harness.ios`
  - `apns-push-type: alert`
  - `apns-priority: 10`
  - `apns-expiration: <now + 86400>`
  - `apns-collapse-id: <notice id, decimal>` (section 5.3)
- Body: section 5. At most 4 KB.
- Answers:

| Status / reason | Do |
| --- | --- |
| 200 | sent |
| 410 `Unregistered` | delete the row |
| 400 `BadDeviceToken` | delete the row; log the row's `gateway` (usually a sandbox token sent to production, or the reverse) |
| 400 `DeviceTokenNotForTopic` | delete the row |
| 403 `ExpiredProviderToken` | make a new JWT and retry once |
| 403 `InvalidProviderToken` | config error: log it loudly, stop sending to that gateway until the config changes |
| 429, 500, 503 | retry once with backoff, then drop and log |

### 4.2 FCM (Android)

- `POST https://fcm.googleapis.com/v1/projects/autonomous-harness/messages:send`.
- OAuth2 access token with scope `https://www.googleapis.com/auth/firebase.messaging`, from `google-auth-library`.
  It is already in `package-lock.json` (9.15.1, through `@google-cloud/storage`); declare it in `package.json` as a
  direct dependency. Cache the access token until shortly before it expires.
- **Data-only** message: no `notification` block. The phone draws the notice itself, on the channel for that kind
  (`PushService.kt`), so one switch in Android Settings silences both the push and the app's own notice.
- `android.priority: "HIGH"` and `android.ttl: "86400s"`. Every high-priority message must end in a notice, or Android
  lowers the app's priority. The phone drops one only when it is signed out or in front.
- Every value in `data` is a string. Do not use reserved keys (`from`, `notification`, `message_type`, anything
  starting with `google.` or `gcm.`).
- Answers:

| Status / error | Do |
| --- | --- |
| 200 | sent |
| 404 `UNREGISTERED` | delete the row |
| 400 `INVALID_ARGUMENT` about the token | delete the row |
| 403 `SENDER_ID_MISMATCH` | delete the row |
| 401 | refresh the access token and retry once; if it fails again, a config error, log it loudly |
| 429 `QUOTA_EXCEEDED`, 500, 503 `UNAVAILABLE` | retry once with backoff (honour `Retry-After`), then drop and log |

## 5. What a push carries

### 5.1 Keys, by kind

Every value is a string.

| `kind` | Keys | Opens |
| --- | --- | --- |
| `swarm` | `swarm`, `conversation`, then either `message` (plus `thread` when the message is only in a thread) or `decision`; `key` | the conversation, at the message or the decision |
| `agent_question`, `agent_done` | `machine`, `agent` | that agent |

- `key` is the need's key, the same as the phone's `SwarmNeed.key` (`mobile/lib/swarm/swarm_inbox.dart`):
  `decision:<id>`, `mention:<id>`, or `work:<swarm>:<conversation>:<assignment>:<status>`.
- Ids are the ones the phone already reads from the backend (section 6 says which row each comes from).
- Any key the phone does not know is ignored. A push with missing ids still shows; tapping it just opens the app.

### 5.2 Copy

Phase 1 says who and where, never what was asked or said: a notice can be read on a locked phone. Use exactly the
app's own copy (`swarmNotice` in `mobile/lib/swarm/swarm_notices.dart`), so a push and the app's notice read the same.
The subtitle is the project's name.

| Need | Title | Body |
| --- | --- | --- |
| Decision asked of the person | `<asker name> asks you` | `Open Harness to answer.` |
| Mention of the person | `<lead name> tagged you` | `Open Harness to read it.` |
| Work waiting on the person, status `blocked` | `<agent name> is stuck` | `Open Harness to see why.` |
| Work waiting on the person, other status | `<agent name> needs you` | `Open Harness to answer.` |
| Agent asks a question (`agent_question`) | `<agent name>`; subtitle: machine name | `Needs you. Open Harness to answer.` (**proposal, PM to confirm**) |
| Agent finished a turn (`agent_done`) | `<agent name>`; subtitle: machine name | `Finished. Open Harness to read it.` (**proposal, PM to confirm**) |

Send no `badge`.

### 5.3 Notice id (shared with the app's own notices)

A push and the local notice the running app posts for the same news carry the same id, so one replaces the other
instead of two stacking. FNV-1a over the text's UTF-16 code units, kept to 31 bits:

```ts
export function noticeId(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) & 0x7fffffff
  }
  return hash
}
```

- Text: `swarm\n` + `key` for a Swarm need; `<machine id>\n<agent id>` for an agent.
- iOS: send it as `apns-collapse-id`, in decimal. Android: the phone computes it from the data, so send nothing.
- Pin these vectors in a unit test (the phone pins the same ones):

| Text | Id |
| --- | --- |
| `swarm\nmention:m1` | 1161357565 |
| `swarm\ndecision:d1` | 15921470 |
| `swarm\nwork:s1:c1:a1:needs_human` | 701122187 |
| `machine-1\nagent-7` | 1081005959 |

### 5.4 Examples

iOS (APNs body):

```json
{
  "aps": {
    "alert": { "title": "Ann asks you", "subtitle": "Website", "body": "Open Harness to answer." },
    "sound": "default",
    "thread-id": "swarm-needs-you"
  },
  "kind": "swarm", "swarm": "…", "conversation": "…", "decision": "…", "key": "decision:…"
}
```

`thread-id` is `swarm-needs-you`, `agent-question` or `agent-done`: the app's own threads.

Android (FCM HTTP v1 body):

```json
{ "message": {
  "token": "…",
  "data": { "kind": "swarm", "title": "Ann asks you", "subtitle": "Website",
            "body": "Open Harness to answer.", "swarm": "…", "conversation": "…",
            "decision": "…", "key": "decision:…" },
  "android": { "priority": "HIGH", "ttl": "86400s" } } }
```

On Android `title` must not be empty, or the phone drops the push.

## 6. Triggers

Paths are relative to `backend/` unless they start with `cli/` or `mobile/`. Line numbers are from
`feat/mobile-ios-android` @ `1da94962a` and will drift.

### 6.1 Swarm needs

In the backend, a Swarm is a `SuperTab`.

| Push key | Phone (`system_notices.dart` `openPushed`) | Backend |
| --- | --- | --- |
| `swarm` | Swarm id | `SuperTab.id` (`tabId`); **not** `workspaceId` |
| `conversation` | conversation id | `conversationId`: a `Conversation` inside the SuperTab state (`superTabs/model.ts`), with no collection of its own |
| `message` | message id | `SuperTabMessage.id` |
| `thread` | thread root, when the message is only in a thread | `SuperTabMessage.thread` (= `SuperTabThread.id`) |
| `decision` | decision id | `SuperTabDecision.id` |
| assignment in a `work:` key | | `conversation.assignment.id` |

**The hook.** Add one hook to `SuperTabStoreHooks` (`superTabs/store.ts:338`), for example
`needsRaised?: (tabId: string, needs: PushNeed[]) => void`. Call it through `afterCommit(tx, …)` (`store.ts:271`),
the way `swarmChanged` is. Like the other hooks, it runs after the commit and must not throw. Wire it where the store
is built in both processes: `routes/superTabs.ts:251-271` and `worker.ts:134`.

**Where each need is written:**

| Need | Written by | Called from | Recipient |
| --- | --- | --- | --- |
| Mention | `writeMentions()`, `superTabs/mentions.ts:161` (`createMany` at :167) | `store.ts:1983` (`executeOnce`); `store.ts:4397` (`archiveFinished`, worker) | the row's `personId` |
| Decision | `writeDecisions()`, `superTabs/decisions.ts:224` (`createMany` at :236). Push only for `fresh` drafts (:230): an exact repeat returns the existing id | `store.ts:2014` (`executeOnce`: `decision.ask`, and a `work.status` that asks, `commands.ts:3545-3556`); `store.ts:4251` (`postReflection`, worker) | the row's `personId` (`project.ownerId` for `postReflection`) |
| Work waiting on a person (`needs_human`, `blocked`) | the `work.status` command, `superTabs/commands.ts:3536-3599` (status at :3563, `askedOf` at :3567). A change of Swarm state, not a row: compare `original` with `effects.state`, as `workEnded` does (`store.ts:2020`) | `executeOnce` | the same person the phone uses (`mobile/lib/swarm/waiting_work.dart:45-63`): the conversation's partner, else `project.ownerId`. The backend never sets a partner, so today it is the project owner |

**Copy names** (asker, lead, agent, project) come from Swarm state, the same way the list views build them
(`decisions.ts:393-398`, `mentions.ts:350-352`). Reuse those helpers rather than a second copy.

**Rules:**

- A mention row with `holdUntil` (`mentions.ts:165`) is not listed until then (`listed()`, `mentions.ts:256`). Do not
  push it at write time. Push it when it becomes listed: a worker sweep every minute, in the `startX` pattern of
  `superTabs/deliveryRepush.ts`, over mentions whose `holdUntil` passed and that have no `push:sent` key.
- A `work.status` that asks a person writes a decision **and** puts the work in `needs_human`. Send only the decision
  push to that person.
- Never push a need to the person who caused it.
- The per-chat setting `SuperTabChatSetting.notify` (`all` / `mentions` / `muted`) does **not** apply. The app's own
  need notices ignore it too: it only decides the "New messages" notices (`mobile/lib/swarm/swarm_notices.dart:371`).
- No push for new chat messages or thread replies in phase 1.

### 6.2 Agent asks a question / finishes a turn (needs a CLI change)

The backend has no signal for these today:

- The CLI sends `commander_question` (`cli/src/core/questions.ts:98-121`), `turn_ended` and `turn_summary` over the
  relay. Their payloads are sealed end to end (`cli/src/lib/e2ee/core.ts:339-343`).
- `lib/adapterWs.ts:554-585` reads only the plain `type`, the top-level `agentId` and `replay`.
- Whether a finished turn is worth telling (alert, list or silent, `cli/src/lib/notifyTier.ts`) is inside the sealed
  payload.

So the daemon must ask the backend for the push. Proposal:

- **CLI:** when an agent asks a question, or finishes a turn whose tier is `alert`, and no Harness app is connected
  (`hasRemoteApp()`, `cli/src/backendSocket.ts:391`), send one plain frame on the machine socket:
  `{ "type": "push_request", "kind": "agent_question" | "agent_done", "agentId": "…" }`. It carries no content: what
  was asked stays sealed.
- **Backend** (`lib/adapterWs.ts`):
  - The machine id and account come from the socket, never from the frame.
  - The agent's name comes from `MachineAgent` (`schema.prisma:442`); the machine's name from `Machine`.
  - Send to that account's tokens with the copy in section 5.2. The notice id is `<machine id>\n<agent id>`.
  - Refuse the frame from a team session (`lib/teamSession.ts`).
  - Rate limit: about 30 frames per machine per minute.
- If this part is late, ship 6.1 first. The phone needs nothing more for 6.2.

## 7. Cleanup (what deletes a row)

- `DELETE /api/push-tokens` on sign-out, or when notices are turned off on the phone.
- A register of the same token by another account (the row moves).
- The provider says the token is dead (section 4).
- The device whose key the row carries is removed from the account. Hook where a removal entry is appended to the
  device key log (`lib/deviceKeyLog.ts`): delete `PushToken` rows with that `device`.
- No renewal for 60 days: a daily sweep in the worker, beside the other sweeps. The phone renews every 7 days.
- More than 20 rows for one account: the oldest go first (section 3).

## 8. Logs and metrics

- Each failed send: provider, status, reason, kind, `userId`, the row's `gateway`. Never the token or the body.
- `prom-client` counters: `push_sent_total{provider,kind}` and `push_failed_total{provider,reason}`. The first warning
  at 10x phones is the failure rate per provider.
- Product-usage measures, optional in phase 1. Counts the backend writes itself go through `RelayUsageMetric`
  (`lib/productUsage.ts:185-189`) and `recordRelayUsage(userId, now, metric)` (:254), as `relay_mobile_opens` does
  (`dailyTracking.ts:123`). For example, add `push_sent_ios` and `push_sent_android` there, in snake_case. A count the
  phone reports (a push opened) would be a new name in `PRODUCT_USAGE_METRICS` (`types/productUsage.ts:218-259`) and its
  CLI copy (`cli/src/lib/productUsageContract.ts`); a test keeps the two equal. That is a later change on both sides.

## 9. Tests

Unit tests (vitest, with the in-memory Mongo the other route tests use):

- Routes:
  - `PUT` stores the row with `userId` from the sign-in; the same token from another account moves.
  - 21st token drops the oldest.
  - Validation: bad `platform`, iOS without `environment`, token too long.
  - `DELETE` removes only the caller's row and answers success for an unknown token.
  - A team session is refused.
  - Rate limit.
- `noticeId` vectors (section 5.3).
- APNs: the JWT verifies with the key's public half; headers and body; each answer row in 4.1 (mock the HTTP/2
  session).
- FCM: body is data-only with string values; each answer row in 4.2 (mock `fetch` and the auth client).
- Triggers:
  - A need for person B sends to B's tokens only, never to the person who caused it.
  - The same need `key` twice sends once; two questions from one agent send twice.
  - A repeated decision draft (not `fresh`) sends nothing.
  - A `work.status` that asks a person sends one push (the decision), not two.
  - A held mention sends nothing at write time and one push once its `holdUntil` passes.
  - A muted chat still sends its needs.
  - `push_request` from a team session is refused.

End to end (by hand, once BE is on staging):

1. iOS sandbox: install the phone branch with `flutter run --profile` on an iPhone, sign in, allow notices. Check a row
   with `gateway: "sandbox"`. Trigger a need for that account; the push arrives; tap opens the right screen.
2. Android: same on a real phone, any build.
3. iOS production: a TestFlight build of the phone branch; check `gateway: "production"`.
4. Sign out: the row is gone and no push arrives.
5. App in front: no system notice from the push (the app shows its own).

Before triggers exist, a token can be tested with Apple's Push Notifications Console
(https://icloud.developer.apple.com/dashboard/notifications, environment *Development* for sandbox), using the token
read from the `push_tokens` row.

## 10. Rollout

1. Ship the model and routes first. Phones that are already out call nothing; the phone branch tolerates a 404.
2. Set the secrets; senders stay off for a gateway whose key is unset.
3. Turn on triggers on staging and run section 9 end to end.
4. Mobile merges and releases (TestFlight, Play internal), then production.

## 11. Done when

- [ ] `PUT` / `DELETE /api/push-tokens` live, with the tests in section 9.
- [ ] A sandbox iPhone build, a TestFlight build and an Android phone each receive a push for a real Swarm need, and
      tapping it opens the right conversation.
- [ ] An agent question and a finished turn reach the phone while no Harness app is open (section 6.2).
- [ ] Dead tokens are deleted on 410 / `UNREGISTERED`; the 60-day sweep runs.
- [ ] No key, token or push body in any log.

## 12. Open questions

1. Agent copy for `agent_question` / `agent_done` (section 5.2): PM to confirm.
2. Should a Swarm push be skipped while the person has Desktop open? Phase 1 proposal: send anyway; the phone hides
   it only if Harness is in front on the phone. (The backend has no live "phone connected" check: `?client=mobile` in
   `lib/webWs.ts` only writes daily presence rows.)
3. Clearing a delivered push once the need is resolved elsewhere: later phase.
4. Whether `hasRemoteApp()` is the right "nobody is looking" test for 6.2 (it is true while Desktop is connected, so
   the phone would stay silent then).
