# Phone notifications

Every notification the Harness phone app (iOS and Android) can show in the system's notification centre, as of
2026-11-05 (task #3248). **Push** comes from the server through Apple (APNs) or Google (FCM) and reaches a phone
whose app is closed or in the background. **Local** is posted by the app itself, from what it reads while it runs.

A notice never says what was written: it can be read on a locked phone. It says who, and in which project.

The rule below is the one Tony approved on 2026-11-05 ("Yes, as proposed"): only what needs you pushes, and repeats
collapse.

## The table

| Type | When it is received | Event | Title | Example | Test evidence |
|---|---|---|---|---|---|
| Push | App closed or in the background. With Harness in front the push is not drawn (iOS `willPresent`, Android FCM in front): the app's own Local notice decides. | A reply, by a person or an agent, in a thread you started or were tagged in, or to your own message (it quotes it). Never your own reply, a Swarm status line in a thread (Working, Ready for review, Done), a thread you only replied in, a muted chat, an unfollowed thread, or a reply that tags you (the tag push tells you instead). **One notification per thread:** a newer reply replaces it. It sounds only when nothing in that thread was unread for you; otherwise it replaces quietly (iOS `passive`, no sound; Android channel `swarm-quiet`). | `<name> replied in a thread`, subtitle the project, body `Open Harness to read it.` | **River replied in a thread** · openharness · Open Harness to read it. Tap: the thread, at the newest reply. | `backend/src/push/notices.test.ts` "phoneNotices: the push rule Tony approved"; `backend/integration/superTabActivity.test.ts` "Phone push: who each push type reaches, and what it carries", "Phone push: a thread sounds once until it is read", "Phone push end to end on the server…"; `apns.test.ts` "APNs: one notification per slot, and quiet repeats"; `fcm.test.ts` "tags the notification with its slot…"; `send.test.ts` "sends each notice as its thread's repeats make it…" |
| Push | As above. | You are tagged, by a person or by an agent of the project, in a chat you can read, including a muted one; also the server's "no reviewer can start" notice, which tags the people who can fix it when no coordinator is in that chat. Never your own tag. A tag held for a quiet chat (no agent working there yet) is not pushed, then or later. Always with sound. | `<name> tagged you`, subtitle the project, body `Open Harness to read it.` | **Tony tagged you** · openharness · Open Harness to read it. Tap: the message, in its thread when it is only there. | `notices.test.ts` "words a tag as the phone does…", "pushes no tag held back for a quiet chat"; `superTabActivity.test.ts` "a tag links the message in the chat…", "keeps each person and each thread apart, and never quiets a tag"; `mobile/test/app_state_push_test.dart` "a tapped push opens the chat its link names" |
| Push | As above. **New in #3248.** | A decision an agent asks of you (`decision.ask`, or `needs_human` with an ask), the first time it is asked. One ask of several questions sounds once; the rest are quiet. | `<asker> asks you`, subtitle the project, body `Open Harness to answer.` | **River asks you** · openharness · Open Harness to answer. Tap: Activity, at the card. | `notices.test.ts` "pushes a decision asked of a person as the app words it…"; `superTabActivity.test.ts` "a decision asked of a person reaches their phone once…", "one ask of several questions sounds once" |
| Local | Harness in front with no Swarm screen open: the Swarm read every 15 s. | A reply in a thread, from the same Activity rows the reply push uses. Shares the push's notification for that thread: it replaces the push rather than adding a second, and posts nothing while a push still shows that thread. Quiet while the thread has an unread reply; taken down, with the push in it, once the thread is read. | `<name> replied in a thread` (`Someone` with no name), project, `Open Harness to read it.` | **Oak replied in a thread** · openharness | `mobile/test/swarm/swarm_notices_test.dart` "shares one notification per thread, the push's too…", "is not posted for a thread a push shows…", "a thread whose push was swiped away unread only replaces quietly…"; `swarm_activity_feed_test.dart`; `test/phone/phone_shell_swarm_notice_test.dart` |
| Local | As above. | A tag waiting for you (the same tags as the tag push), in the push's notification. | `<name> tagged you`, project, `Open Harness to read it.` | **River tagged you** · openharness | `swarm_notices_test.dart` "a tag in a thread opens that thread at the tag"; `swarm_notice_repeat_test.dart` "read again and again, each ask is told once" |
| Local | As above. | A decision asked of you, in the push's notification. | `<asker> asks you`, project, `Open Harness to answer.` | **River asks you** · openharness · Open Harness to answer. Tap: Activity, at the card. | `swarm_notices_test.dart` "a decision says who asks…"; `phone_shell_swarm_notice_test.dart` |
| Local | As above. | A task waiting on you is `blocked`: you are its chat's partner, or else the project's owner. | `<agent> is stuck`, project, `Open Harness to see why.` | **Magnolia2 is stuck** · openharness | `swarm_notices_test.dart` |
| Local | As above. | A task waiting on you (as above) needs a person (`needs_human`). | `<agent> needs you`, project, `Open Harness to answer.` | **Oak needs you** · openharness | `swarm_notices_test.dart` |
| Local | As above. | A new message in a chat you set to **All new messages**. One notice per chat; it sounds once until you read the chat, and a newer message replaces it quietly. | `New messages`, project, `Open Harness to read them.` | **New messages** · openharness | `mobile/test/swarm/swarm_chat_notices_test.dart` "All new messages: each new message in the chat is told, one notice…", "read, the chat's next message sounds again" |
| Local | Harness in front, or seconds after it goes to the background (the machine's socket). Not while you look at that agent. | An agent on your machine finished a turn the daemon ranks worth telling (not `silent` or `list`). One notice per agent; it sounds once until you go to the agent, and a newer turn replaces it quietly. | The agent's name, subtitle the machine, body the reply's last paragraph (180 characters at most). | **Fix login** · MacBook · Fixed it. Tap: the agent's chat (or terminal with Swarm off). | `mobile/test/notify/agent_announcer_test.dart` "a finished turn sounds once until the person goes to the agent…"; `local_system_notices_test.dart` "a finished turn: the agent, its machine, its news, on the done channel"; `announcer_lifecycle_test.dart`; `done_notice_test.dart` |
| Local | As above; in front, only after 15 s still unanswered. | An agent on your machine asks a question (approval, choice). A repeat within 5 minutes is quiet: no sound, no banner. | The agent's name, the machine, the question. | **Fix login** · MacBook · Approve Bash command: rm -rf dist | `local_system_notices_test.dart` "a question rides a channel of its own…", "a quiet notice…"; `question_notice_test.dart`; `question_spam_incident_test.dart` |
| Local | When the phone next reads the account's devices (sign-in, or a device-keys change on a machine socket). | A new device joined or signed in to your account. Once per device. | `New device on your account` | **New device on your account** · Pixel 9 signed in to your account and can reach your machines. Not yours? Remove it in Settings ▸ Your devices. | `local_system_notices_test.dart` "a new device on the account…"; `test/phone/phone_shell_device_notice_test.dart` |
| Local | As above. | A device left your account: it signed out, another device removed it, or a new device you have not looked at removed it. | `Device signed out`, `Device removed` or `Removed by a new device` | **Device removed** · iPad was removed from your account by MacBook. | `test/state/device_removal_notice_test.dart`; `phone_shell_device_notice_test.dart` |

**Silent, never pushed** (in the app's Activity and badge only): a reply in a thread you only replied in, a Swarm status
line in a thread, reactions, and messages outside threads that tag nobody. Evidence: `superTabActivity.test.ts` "a reply
reaches the thread's starter, the quoted message's author and people tagged earlier in it, never its author nor one who
only replied", "tells the starter and every person who replied, but never the reply's author" (the Activity rows), "pushes
nothing for a message outside threads that tags nobody, or for a reaction"; `notices.test.ts` "pushes no Swarm line in a
thread…".

Not in the notification centre, so not in the table: the app icon's badge (the Swarm's waiting count, iOS), the unread dot
and buzz on an agent, the new-device and removed-device bands, and snackbars. The PM's routing proposals (the routine's
reflection decisions) are listed in Activity and are not pushed.

## Where each one comes from

- Push: `backend/src/push/notices.ts` words the three kinds from the rows a write made (`superTabs/activity.ts`
  `writeReplyActivity`, which says why each person is told; `superTabs/mentions.ts` `writeMentions`; the decisions
  `superTabs/store.ts` writes for `decision.ask` and `needs_human`). `push/repeats.ts` makes a thread's reply quiet when
  the person has an earlier unread reply there (one indexed read per thread, on the Activity thread index; if it cannot
  read, the push goes with sound and a warning is logged). `push/send.ts` sends them after the write commits, to every
  phone the person registered (`push/devices.ts`); `push/apns.ts` and `push/fcm.ts` talk to Apple and Google.
- Keys and slots. Each notice has a **key** (`reply:<swarm>:<row>`, `mention:<row>`, `decision:<id>`), the same as the
  app's Local notice for the same thing, and a **slot**, the notification it shows in: `thread:<swarm>:<chat>:<root>` for a
  reply, the key for a tag or a decision. APNs: `apns-collapse-id` is the slot's id (`swarmNoticeId`, FNV-1a, the same as
  the app's `swarmNoticeIdFor`), so the app's notice under that id replaces the push. FCM: the notification's tag is the
  slot, and the app posts under that tag with id 0, as FCM draws it. The payload's `link` is
  `swarm:<swarm>/<chat>/message/<message>[/thread/<root>]` or `swarm:<swarm>/<chat>/decision/<id>`.
- Local: `mobile/lib/notify/system_notices.dart` posts all of them. Swarm ones come from `lib/swarm/swarm_notices.dart`
  (Android channel and iOS thread `swarm-needs-you`), agent ones from `lib/notify/agent_announcer.dart` (`agent-done`,
  `agent-question`), device ones from `lib/state/app_state.dart` (`account-device`). On Android the app makes the
  `swarm-needs-you` and `swarm-quiet` channels when push starts, before any push can arrive.
- Back in front, the app asks which pushes are still shown (`PushChannel.shown`: iOS gives each push's key and slot,
  Android its tag, the slot) and posts none of them again (#3150), nor anything for a thread a push still shows.

## What the inventory found, and what was done

1. Opening the app after a push could show the same reply or tag a second time. Fixed by #3150 (Sequoia2), extended here
   to slots.
2. A push and the app's Local notice for the same thing were two entries in the notification centre. Fixed: they share
   one slot (`apns-collapse-id`, the FCM tag).
3. Every reply in a thread was its own push with sound. Fixed: one notification per thread, sounding once until read;
   repliers-only and Swarm status lines no longer push.
4. Android: the `swarm-needs-you` channel was made only with the app's first Swarm notice, so an earlier push landed on
   FCM's default channel. Fixed: both push channels are made when push starts.
5. A tag held for a quiet chat is never pushed, even once the hold ends. Unchanged (not part of the approved rule).
6. A decision asked of you was Local only. Fixed: it pushes.
7. A chat set to All new messages, and an agent's finished turns, buzzed every time. Fixed: they sound once until seen.
