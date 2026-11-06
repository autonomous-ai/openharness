# Phone notifications

Every notification the Harness phone app (iOS and Android) can show in the system's notification centre, as of
2026-11-06 (tasks #3248 and #3607). **Push** comes from the server through Apple (APNs) or Google (FCM) and reaches a phone
whose app is closed or in the background. **Local** is posted by the app itself, from what it reads while it runs.

A notice never says what was written: it can be read on a locked phone. It says who, and in which project.

## The rule

Tony's rule (2026-11-06, task #3607), on top of the one he approved on 2026-11-05 (#3248, "Yes, as proposed"). A phone
rings only when a person must act, or when a person speaks to you. Push and Local follow it together.

**Rings** (sound, banner):
- an agent asks you to decide or approve and the work waits on you: `decision.ask`, `needs_human` with an ask, a command
  approval on an agent's machine;
- a sign-in from a device you do not know (Local, below; the server does not push it yet);
- a **person** tags you;
- a **person** replies to you, or in a thread you started or were tagged in.

**Badge and Activity only** (no sound, no banner, nothing in the notification centre):
- an agent finishing a turn, or a whole task;
- an agent replying in your thread (unless it is a decision ask);
- an agent tagging you without a decision or approval. This includes the server's "no reviewer can start" notice: it is
  written as the agent that asked for the review, so it is an agent's tag.

**One task, one notification.** A task's "stuck", "needs you" and decision question share one notification slot
(`task:<swarm>:<task chat>`): the later replaces the earlier, and it sounds once. Thread replies keep their own slot.

**By the kind of event, never by its words**: who wrote it (person or agent) and what it is (a reply, a tag, a decision, a
finished turn). An agent's message that says "please approve" is still an agent's tag. Only the real ask (`decision.ask`,
`needs_human` with an ask, an approval on the machine) rings.

**Per chat** the default is **Mentions only** (`DEFAULT_NOTIFY`; the app reads it as the same when the server says
nothing). A chat tells every new message only when its person sets **All new messages**.

Repeats collapse, as before: a thread, or a task, is one notification.

## The table

| Type | When it is received | Event | Title | Example | Test evidence |
|---|---|---|---|---|---|
| Push | App closed or in the background. With Harness in front the push is not drawn (iOS `willPresent`, Android FCM in front): the app's own Local notice decides. | A reply **by a person** in a thread you started or were tagged in, or to your own message (it quotes it). **Never an agent's reply** (#3607: it stays in Activity and the badge). Never your own reply, a Swarm status line in a thread (Working, Ready for review, Done), a thread you only replied in, a muted chat, an unfollowed thread, or a reply that tags you (the tag push tells you instead). **One notification per thread:** a newer reply replaces it. It sounds only when nothing in that thread was unread for you; otherwise it replaces quietly (iOS `passive`, no sound; Android channel `swarm-quiet`). | `<name> replied in a thread`, subtitle the project, body `Open Harness to read it.` | **River replied in a thread** · openharness · Open Harness to read it. Tap: the thread, at the newest reply. | `backend/src/push/notices.test.ts` "phoneNotices: the push rule Tony approved", "phoneNotices: who rings (task #3607…)"; `backend/integration/superTabActivity.test.ts` "Phone push: who each push type reaches, and what it carries", "Phone push: a thread sounds once until it is read", "Phone push end to end on the server…"; `apns.test.ts` "APNs: one notification per slot, and quiet repeats"; `fcm.test.ts` "tags the notification with its slot…"; `send.test.ts` "sends each notice as its thread's repeats make it…" |
| Push | As above. | You are tagged **by a person** in a chat you can read, including a muted one. An agent's tag does not ring (#3607), nor does the server's "no reviewer can start" notice, which is written as an agent and tags the people who can fix it: both are in Activity and the badge. Never your own tag. A tag held for a quiet chat (no agent working there yet) is not pushed, then or later. Always with sound. | `<name> tagged you`, subtitle the project, body `Open Harness to read it.` | **Tony tagged you** · openharness · Open Harness to read it. Tap: the message, in its thread when it is only there. | `notices.test.ts` "words a tag as the phone does…", "pushes no tag held back for a quiet chat", "an agent's tag rings nobody, a person's tag rings", "the server's "no reviewer can start" tag is an agent's tag…"; `superTabActivity.test.ts` "a tag links the message in the chat…", "keeps each person and each thread apart, and never quiets a tag"; `mobile/test/app_state_push_test.dart` "a tapped push opens the chat its link names" |
| Push | As above. **New in #3248.** | A decision an agent asks of you (`decision.ask`, or `needs_human` with an ask), the first time it is asked. One ask of several questions sounds once; the rest are quiet. **All of a task's decisions share one slot** (`task:<swarm>:<task chat>`, #3607), the same slot as the task's Local "stuck" and "needs you". | `<asker> asks you`, subtitle the project, body `Open Harness to answer.` | **River asks you** · openharness · Open Harness to answer. Tap: Activity, at the card. | `notices.test.ts` "pushes a decision asked of a person as the app words it…"; `superTabActivity.test.ts` "a decision asked of a person reaches their phone once…", "one ask of several questions sounds once" |
| Local | Harness in front with no Swarm screen open: the Swarm read every 15 s. | A reply **by a person** in a thread, from the same Activity rows the reply push uses (an agent's reply posts nothing, #3607). Shares the push's notification for that thread: it replaces the push rather than adding a second, and posts nothing while a push still shows that thread. Quiet while the thread has an unread reply; taken down, with the push in it, once the thread is read. | `<name> replied in a thread` (`Someone` with no name), project, `Open Harness to read it.` | **Oak replied in a thread** · openharness | `mobile/test/swarm/swarm_notices_test.dart` "shares one notification per thread, the push's too…", "is not posted for a thread a push shows…", "a thread whose push was swiped away unread only replaces quietly…"; `swarm_activity_feed_test.dart`; `test/phone/phone_shell_swarm_notice_test.dart` |
| Local | As above. | A tag by a person waiting for you (the same tags as the tag push), in the push's notification. A tag by an agent is the badge only: the mention list says who tagged (`leadKind`), and the app posts nothing for an agent. | `<name> tagged you`, project, `Open Harness to read it.` | **River tagged you** · openharness | `swarm_notices_test.dart` "a tag in a thread opens that thread at the tag", group "who rings (task #3607)"; `swarm_notice_repeat_test.dart` "read again and again, each ask is told once" |
| Local | As above. | A decision asked of you, in the push's notification: the task's slot, shared with "stuck" and "needs you" below. | `<asker> asks you`, project, `Open Harness to answer.` | **River asks you** · openharness · Open Harness to answer. Tap: Activity, at the card. | `swarm_notices_test.dart` "a decision says who asks…", group "one task, one notification (task #3607)"; `phone_shell_swarm_notice_test.dart` |
| Local | As above. | A task waiting on you is `blocked`: you are its chat's partner, or else the project's owner. Shares the task's one slot: it replaces the task's earlier notice quietly. | `<agent> is stuck`, project, `Open Harness to see why.` | **Magnolia2 is stuck** · openharness | `swarm_notices_test.dart` |
| Local | As above. | A task waiting on you (as above) needs a person (`needs_human`). Shares the task's one slot, as above. | `<agent> needs you`, project, `Open Harness to answer.` | **Oak needs you** · openharness | `swarm_notices_test.dart` |
| Local | As above. | A new message in a chat you set to **All new messages**. One notice per chat; it sounds once until you read the chat, and a newer message replaces it quietly. | `New messages`, project, `Open Harness to read them.` | **New messages** · openharness | `mobile/test/swarm/swarm_chat_notices_test.dart` "All new messages: each new message in the chat is told, one notice…", "read, the chat's next message sounds again" |
| None | Harness in front, or seconds after it goes to the background (the machine's socket). | An agent on your machine finished a turn. **Badge only** (#3607): the agent is marked unread, with no sound, no banner and no notification, whatever tier the daemon gave. Nothing at all for the agent you are looking at, for a `silent` turn, or for a turn that said nothing. | None. | The unread dot on the agent. | `mobile/test/notify/finished_turn_badge_only_test.dart`; `done_notice_test.dart`; `agent_announcer_test.dart`; `announcer_lifecycle_test.dart`; `local_system_notices_test.dart` |
| Local | As above; in front, only after 15 s still unanswered. | An agent on your machine asks a question (approval, choice). A repeat within 5 minutes is quiet: no sound, no banner. | The agent's name, the machine, the question. | **Fix login** · MacBook · Approve Bash command: rm -rf dist | `local_system_notices_test.dart` "a question rides a channel of its own…", "a quiet notice…"; `question_notice_test.dart`; `question_spam_incident_test.dart` |
| Local | When the phone next reads the account's devices (sign-in, or a device-keys change on a machine socket). | A new device joined or signed in to your account. Once per device. | `New device on your account` | **New device on your account** · Pixel 9 signed in to your account and can reach your machines. Not yours? Remove it in Settings ▸ Your devices. | `local_system_notices_test.dart` "a new device on the account…"; `test/phone/phone_shell_device_notice_test.dart` |
| Local | As above. | A device left your account: it signed out, another device removed it, or a new device you have not looked at removed it. | `Device signed out`, `Device removed` or `Removed by a new device` | **Device removed** · iPad was removed from your account by MacBook. | `test/state/device_removal_notice_test.dart`; `phone_shell_device_notice_test.dart` |

**Silent, never pushed** (in the app's Activity and badge only): an agent's reply or tag, an agent finishing a turn or a
task, a reply in a thread you only replied in, a Swarm status line in a thread, reactions, and messages outside threads
that tag nobody. Evidence: `superTabActivity.test.ts` "a reply
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
  reply, `task:<swarm>:<task chat>` for a decision (and the app's "stuck" and "needs you" for that task), the key for a tag. APNs: `apns-collapse-id` is the slot's id (`swarmNoticeId`, FNV-1a, the same as
  the app's `swarmNoticeIdFor`), so the app's notice under that id replaces the push. FCM: the notification's tag is the
  slot, and the app posts under that tag with id 0, as FCM draws it. The payload's `link` is
  `swarm:<swarm>/<chat>/message/<message>[/thread/<root>]` or `swarm:<swarm>/<chat>/decision/<id>`.
- Local: `mobile/lib/notify/system_notices.dart` posts all of them. Swarm ones come from `lib/swarm/swarm_notices.dart`
  (Android channel and iOS thread `swarm-needs-you`), agent ones from `lib/notify/agent_announcer.dart` (`agent-question`;
  a finished turn is a mark only), device ones from `lib/state/app_state.dart` (`account-device`). On Android the app makes the
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
8. (#3607) An agent's reply or tag, and an agent finishing a turn, rang the phone as loudly as a person did. Fixed: they are
   badge and Activity only, classified by who wrote them, never by their words. A task's "stuck", "needs you" and decision
   question were three notifications; they are one slot now.
9. (#3607) Not changed, proposed: the server does not push "a sign-in from a device you do not know" (the app reads it
   when it next opens). A push needs the device-sign-in write path and two security reviews, so it is a separate task.
