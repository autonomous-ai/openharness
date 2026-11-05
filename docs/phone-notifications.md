# Phone notifications

Every notification the Harness phone app (iOS and Android) can show in the system's notification centre, as of
2026-11-05 (task #3248). **Push** comes from the server through Apple (APNs) or Google (FCM) and reaches a phone
whose app is closed or in the background. **Local** is posted by the app itself, from what it reads while it runs.

A notice never says what was written: it can be read on a locked phone. It says who, and in which project.

## The table

| Type | When it is received | Event | Title | Example | Test evidence |
|---|---|---|---|---|---|
| Push | App closed or in the background. With Harness in front the push is not drawn (iOS `willPresent`, Android FCM in front): the app's own Local notice decides. | A reply in a thread you are in: you started it, wrote the message it quotes, were tagged in it, or replied in it. From a person, an agent, or a Swarm line in a thread (those tell only the starter and the quoted author). Never your own reply, a muted chat, an unfollowed thread, or a reply that tags you (the tag push tells you instead). | `<name> replied in a thread`, subtitle the project, body `Open Harness to read it.` | **River replied in a thread** · openharness · Open Harness to read it. Tap: the thread, at the reply. | `backend/src/push/notices.test.ts` "words a reply as the phone does…"; `backend/integration/superTabActivity.test.ts` "Phone push: …"; `backend/src/push/apns.test.ts`, `fcm.test.ts`; `mobile/test/notify/local_system_notices_test.dart` group "pushes" ("a tapped reply push opens the thread at the reply") |
| Push | As above. | You are tagged, by a person or by an agent of the project, in a chat you can read, including a muted one; also the server's "no reviewer can start" notice, which tags the people who can fix it when no coordinator is in that chat. Never your own tag. A tag held for a quiet chat (no agent working there yet) is not pushed, then or later. | `<name> tagged you`, subtitle the project, body `Open Harness to read it.` | **Tony tagged you** · openharness · Open Harness to read it. Tap: the message, in its thread when it is only there. | `notices.test.ts` "words a tag as the phone does…", "pushes no tag held back for a quiet chat"; `superTabActivity.test.ts` "tells a person who muted the chat of a tag alone, never of a reply"; `mobile/test/app_state_push_test.dart` "a tapped push opens the chat its link names" |
| Local | Harness in front with no Swarm screen open: the Swarm read every 15 s. | A thread reply's Activity row (the same rows as the reply push). | `<name> replied in a thread` (`Someone` with no name), project, `Open Harness to read it.` | **Oak replied in a thread** · openharness | `mobile/test/swarm/swarm_notices_test.dart` group "a reply in a thread the person is in"; `swarm_activity_feed_test.dart`; `test/phone/phone_shell_swarm_notice_test.dart` |
| Local | As above. | A tag waiting for you (the same tags as the tag push). | `<name> tagged you`, project, `Open Harness to read it.` | **River tagged you** · openharness | `swarm_notices_test.dart` "a tag in a thread opens that thread at the tag"; `swarm_notice_repeat_test.dart` "read again and again, each ask is told once" |
| Local | As above. | A decision an agent asked of you (`decision.ask`, or `needs_human` with an ask). | `<asker> asks you`, project, `Open Harness to answer.` | **River asks you** · openharness · Open Harness to answer. Tap: Activity, at the card. | `swarm_notices_test.dart` "a decision says who asks…"; `phone_shell_swarm_notice_test.dart` |
| Local | As above. | A task waiting on you is `blocked`: you are its chat's partner, or else the project's owner. | `<agent> is stuck`, project, `Open Harness to see why.` | **Magnolia2 is stuck** · openharness | `swarm_notices_test.dart` |
| Local | As above. | A task waiting on you (as above) needs a person (`needs_human`). | `<agent> needs you`, project, `Open Harness to answer.` | **Oak needs you** · openharness | `swarm_notices_test.dart` |
| Local | As above. | A new message in a chat you set to **All new messages**. One notice per chat; a newer message replaces it. | `New messages`, project, `Open Harness to read them.` | **New messages** · openharness | `mobile/test/swarm/swarm_chat_notices_test.dart` "All new messages: each new message in the chat is told, one notice…" |
| Local | Harness in front, or seconds after it goes to the background (the machine's socket). Not while you look at that agent. | An agent on your machine finished a turn the daemon ranks worth telling (not `silent` or `list`). One notice per agent; a newer turn replaces it. | The agent's name, subtitle the machine, body the reply's last paragraph (180 characters at most). | **Fix login** · MacBook · Fixed it. Tap: the agent's chat (or terminal with Swarm off). | `mobile/test/notify/local_system_notices_test.dart` "a finished turn: the agent, its machine, its news, on the done channel"; `agent_announcer_test.dart`; `done_notice_test.dart` |
| Local | As above; in front, only after 15 s still unanswered. | An agent on your machine asks a question (approval, choice). A repeat within 5 minutes is quiet: no sound, no banner. | The agent's name, the machine, the question. | **Fix login** · MacBook · Approve Bash command: rm -rf dist | `local_system_notices_test.dart` "a question rides a channel of its own…", "a quiet notice…"; `question_notice_test.dart`; `question_spam_incident_test.dart` |
| Local | When the phone next reads the account's devices (sign-in, or a device-keys change on a machine socket). | A new device joined or signed in to your account. Once per device. | `New device on your account` | **New device on your account** · Pixel 9 signed in to your account and can reach your machines. Not yours? Remove it in Settings ▸ Your devices. | `local_system_notices_test.dart` "a new device on the account…"; `test/phone/phone_shell_device_notice_test.dart` |
| Local | As above. | A device left your account: it signed out, another device removed it, or a new device you have not looked at removed it. | `Device signed out`, `Device removed` or `Removed by a new device` | **Device removed** · iPad was removed from your account by MacBook. | `test/state/device_removal_notice_test.dart`; `phone_shell_device_notice_test.dart` |

Not in the notification centre, so not in the table: the app icon's badge (the Swarm's waiting count, iOS), the unread dot
and buzz on an agent, the new-device and removed-device bands, and snackbars.

## Where each one comes from

- Push: `backend/src/push/notices.ts` words both kinds from the rows a write made (`superTabs/activity.ts`
  `writeReplyActivity`, `superTabs/mentions.ts` `writeMentions`); `push/send.ts` sends them after the write commits, to
  every phone the person registered (`push/devices.ts`); `push/apns.ts` and `push/fcm.ts` talk to Apple and Google. Keys:
  `reply:<swarm>:<row>` and `mention:<row>`, the same as the app's Local notice for the same reply or tag. The payload's
  `link` is `swarm:<swarm>/<chat>/message/<message>[/thread/<root>]`.
- Local: `mobile/lib/notify/system_notices.dart` posts all of them. Swarm ones come from `lib/swarm/swarm_notices.dart`
  (Android channel and iOS thread `swarm-needs-you`), agent ones from `lib/notify/agent_announcer.dart` (`agent-done`,
  `agent-question`), device ones from `lib/state/app_state.dart` (`account-device`).

## What the inventory found

1. Opening the app after a push can show the same reply or tag a second time, as a Local notice. #3150 (Sequoia2) fixes
   it: the app marks the keys of pushes still in the notification centre as told.
2. A push and the app's Local notice for the same thing are two entries in the notification centre: the push carries no
   `apns-collapse-id`, so nothing the app posts replaces it (the design, `docs/design/2026-11-05-phone-push.md`, planned one).
3. Every reply in a thread is its own push with sound: a busy thread buzzes the phone once per reply.
4. Android: the `swarm-needs-you` channel is made only when the app posts its first Swarm notice, so a push that arrives
   before that is drawn on FCM's default channel.
5. A tag held for a quiet chat is never pushed, even once the hold ends: with the app closed you never hear of it.
6. A decision asked of you is Local only: with the app closed you never hear of it.
7. A chat set to All new messages buzzes on every new message (up to every 15 s); an agent's finished-turn notice buzzes on
   every turn.

## Proposed rule (waiting for Tony's yes)

Nothing below is built until Tony agrees.

**Push, with sound: something needs you.**
- You are tagged (by a person or an agent).
- A decision is asked of you. New: today only the open app shows it.
- A reply, by a person or an agent, in a thread you started or were tagged in, or to your own message.

**Silent: in the app's Activity and badge, no push.**
- A reply in a thread you only replied in.
- A Swarm status line in a thread (Working, Ready for review, Done).
- Reactions, and messages outside threads.

**Local only, as today:** agent finished, agent question, new or removed device, a task stuck or needing a person, and New messages for a chat set to All new messages.

**How repeats collapse.**
- One notification per thread: a newer reply replaces the earlier one. It sounds only if you had no unread reply in that
  thread; otherwise the replacement is silent. Once you read the thread, the next reply sounds again.
- A push and the app's own notice for the same thing share one slot, so the app replaces the push instead of adding a second.
- Opening the app never pops up again what a push already showed (#3150).
- New messages and Agent finished sound once until you look; later ones replace them silently.
- With Harness in front, no push is drawn (as today).
