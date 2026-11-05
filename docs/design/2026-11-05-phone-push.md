# Phone push notifications: the phone's side, and the contract the backend builds to

Status: the server part merged first (#3071) with its own routes and payload, and the phone now
follows it. Where this contract and the merged server differ, the server wins: the gaps are listed
in [docs/plans/2026-11-05-phone-push-backend-plan.md](../plans/2026-11-05-phone-push-backend-plan.md#merged-server-11-05-what-differs-from-this-plan).

Phase 1 only: the push carries ids and the same short copy the app's own notices use, never what was
asked or said. Phase 2 (a payload sealed to the phone's device key, opened by a Notification Service
Extension) is not part of this.

## What the phone does

- While someone is signed in and the OS allows notices, the phone tells the backend its push address:
  the APNs device token on iOS, the FCM registration token on Android.
  (`mobile/lib/notify/push_tokens.dart`, `push_channel.dart`)
- It tells again when the token, its APNs gateway or the account changes, and otherwise every 7 days.
  It is told once the account is known, when notices are allowed, when the OS hands over a new token,
  and when the app comes back to the front. It is never told while signed out.
- Notices turned off in the phone's Settings: the phone asks the backend to forget the token.
- Sign-out: the phone asks the backend to forget the token. It also stops the OS delivering to it
  (iOS `unregisterForRemoteNotifications`, Android `deleteToken`), so a backend that missed the
  request still reaches nothing. On Android nothing is drawn after a sign-out in any case.
- A push that lands while Harness is in front is not shown: the app is up and posts its own notices,
  which know what the person is looking at.
- A tapped push opens what the same local notice opens: the Swarm conversation (at the message and
  thread, or the decision), or the agent.

## API (backend)

Both are signed with the phone's own sign-in (`Authorization: Bearer`). The account is always the
caller's, never a field of the body.

### `PUT /api/push-tokens`

```json
{ "token": "…", "platform": "ios", "environment": "production", "device": "…" }
```

| Field | |
| --- | --- |
| `token` | APNs device token (hex) or FCM registration token. |
| `platform` | `ios` or `android`. |
| `environment` | iOS only: `sandbox` (a build Xcode signed for development, or the simulator) or `production` (TestFlight, App Store). Absent on Android. |
| `device` | Optional. This phone's device key, base64, the same value the phone sends as `self` to `GET /api/device-keys`. Removing that device from the account removes its token. |

- Upsert by `token`. A token already stored for another account moves to the caller: the last
  sign-in on a phone owns it. Refresh `updatedAt`.
- Answers `{ "success": true, "data": {} }`. Any other answer counts as not stored: the phone tries
  again after an hour, or at the next launch.

### `DELETE /api/push-tokens`

```json
{ "token": "…" }
```

Removes the token if it belongs to the caller. Idempotent: an unknown token also answers success.
The token is in the body, not the path, so it stays out of access logs.

## What a push carries

Every value is a string, beside the platform's own fields:

| `kind` | Keys | Opens |
| --- | --- | --- |
| `swarm` | `swarm`, `conversation`, and `message` (with `thread` when the message is only in a thread) or `decision`; `key` | the conversation, at the message or the decision |
| `agent_question`, `agent_done` | `machine`, `agent` | that agent |

`key` is the need's key, as `SwarmNeed.key` makes it (`mobile/lib/swarm/swarm_inbox.dart`):
`decision:<id>`, `mention:<id>`, or `work:<swarm>:<conversation>:<assignment>:<status>`.

The copy is the app's own notices' (`swarmNotice` in `mobile/lib/swarm/swarm_notices.dart`). For
example, title `Ann asks you`, subtitle the project's name, body `Open Harness to answer.` Who asks
and where, never what. Send no `badge`: the app sets the count itself.

### iOS (APNs)

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

- Headers: `apns-push-type: alert`, `apns-topic: ai.autonomous.harness.ios`, `apns-priority: 10`, and
  `apns-collapse-id` set to the notice id (below).
- `thread-id`: `swarm-needs-you`, `agent-question` or `agent-done`, the app's own threads.
- A token goes to its own gateway: `sandbox` to `api.sandbox.push.apple.com`, `production` to
  `api.push.apple.com`. The team has one APNs key per gateway, each limited to its own, so the
  sender signs a token's push with the key of that token's `environment`. Both keys are the
  backend's secrets, never in this repository.

### Android (FCM HTTP v1)

`POST https://fcm.googleapis.com/v1/projects/autonomous-harness/messages:send`. The message is
**data-only**, with no `notification` block. `PushService.kt` draws it on the app's own channel for
that kind, so one switch in Settings silences both.

```json
{ "message": {
  "token": "…",
  "data": { "kind": "swarm", "title": "Ann asks you", "subtitle": "Website",
            "body": "Open Harness to answer.", "swarm": "…", "conversation": "…",
            "decision": "…", "key": "decision:…" },
  "android": { "priority": "HIGH", "ttl": "86400s" } } }
```

Every high-priority message must end in a notice, or Android lowers the app's priority. The phone
drops one only when it is signed out or in front.

The phone registers FCM *registration tokens* (`getToken`). firebase-messaging deprecated them in
25.1.0 for Installation-ID registration (`register()`), but HTTP v1 still documents sending to tokens
only. Moving to Installation IDs is a new field, added beside `token`, not a change to it.

### The notice id, shared with the app's own notices

A push and the local notice the running app posts for the same news carry the same id, so one
replaces the other instead of two stacking. The id is FNV-1a over the text's UTF-16 code units, kept
to 31 bits:

```
hash = 0x811c9dc5
for each UTF-16 code unit u: hash = ((hash XOR u) * 0x01000193) AND 0x7fffffff
```

- Text: `swarm\n` + `key` for a Swarm need; `<machine>\n<agent>` for an agent.
- iOS: `apns-collapse-id` is the id in decimal. Android: the phone computes it from the data.

Test vectors, pinned in `mobile/test/notify/local_system_notices_test.dart`:

| Text | Id |
| --- | --- |
| `swarm\nmention:m1` | 1161357565 |
| `swarm\ndecision:d1` | 15921470 |
| `swarm\nwork:s1:c1:a1:needs_human` | 701122187 |
| `machine-1\nagent-7` | 1081005959 |

## Design

- **Growth.** One row per token. Rows are deleted by:
  - `DELETE` on sign-out or when notices are turned off;
  - a register by another account, which moves the row;
  - the provider saying the token is gone (APNs 410 `Unregistered`, FCM `UNREGISTERED`);
  - removal of the device whose key it carries;
  - 60 days without a renewal (the phone renews every 7).

  Limit: 20 tokens per account, the oldest dropped first.
- **Concurrency.** A unique index on `token`. A register is one atomic upsert and a delete one
  delete; nothing locks more than the row.
- **Read cost.** Sending reads one account's tokens by an index on the account. A phone writes at
  most once per 7 days unless its token, gateway or account changes.
- **Scale.** At 10x the phones, the rows stay small and the reads indexed. The first warning is the
  rate of failed sends per provider; log it with the provider's reason.
- **Compatibility.**
  - A phone from before this: no rows, no pushes; nothing else changes.
  - This phone against a backend from before this: 404, logged under `push`. The phone retries after
    an hour or at the next launch and shows nothing to the person.
  - The backend ships first.
- **Migration and rollback.** A new collection, no migration. Rollback removes the routes and the
  collection; the phone treats the missing route as above.
- **Audience.** The server binds each token to the caller's account, and `DELETE` removes only the
  caller's own rows. A push names ids only. Opening one shows only what the account may read, since
  Swarm reads check access as before.
- **Identity.** The signed-in person's account, from their own sign-in, never a machine owner's.
- **Failure.** The phone logs each failed register or delete under `push`, with the HTTP status,
  never the token. The backend logs each provider refusal with its reason.
- **Platforms.**
  - iOS 15+: the `aps-environment` entitlement, with an App Store export signed as `production`.
  - Android 7+ (API 24): `firebase-messaging` with its values in `res/values/firebase.xml`, with no
    google-services plugin.

## Not in this change

- **Backend:**
  - token store and routes;
  - the APNs and FCM senders and their keys;
  - the triggers (Swarm needs; agent questions and finished turns asked for by the CLI when no app is
    connected).
- **CLI:** asking the backend to push an agent's question or finished turn.
- **Measures:** the push measures need names in the backend's product-usage vocabulary first.
- **Phase 2:** the sealed payload and the Notification Service Extension.
