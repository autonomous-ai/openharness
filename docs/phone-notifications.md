# Phone notifications

Every notification the Harness phone app (iOS and Android) can show in the system's notification centre, as of
2026-11-09 (`main` `d18648f46`; tasks #3607, #3029, #3915, #4525, #4547; the reply, mute and requester rules of 2026-11-09). **Push** comes from the server through Apple
(APNs) or Google (FCM) and reaches a phone whose app is closed or in the background. **Local** is posted by the app
itself, from what it reads while it runs.

A notice never says what was written: it can be read on a locked phone. It says who, and in which project.

## The rule

Tony's rule (2026-11-06, task #3607), on top of the one he approved on 2026-11-05 ("Yes, as proposed"). A phone
rings only when a person must act, when a person speaks to you, or when your own agent writes to you in its 1:1 chat
(Swarm v4, 2026-11-10). Push and Local follow it together.

**Rings** (sound, banner):
- an agent asks you to approve a command on its machine, and the work waits on you. Swarm v4 has no decisions (anh Dee,
  2026-11-10): an agent reaches its person in their 1:1 chat, so no decision is pushed any more;
- a sign-in from a device you do not know (Local, below; the server does not push it yet);
- your agent writes to you in its 1:1 chat with you, unless you muted that chat (Swarm v4, anh Dee, 2026-11-10: an agent
  reaches its person there);
- Swarm v4 keeps no tag list and no Activity (anh Dee, 2026-11-10): the server no longer pushes a tag or a thread reply.

**Badge only** (no sound, no banner, nothing in the notification centre):
- an agent finishing a turn, or a whole task;
- a task's "stuck" or "needs you" for a task you did not ask for (anh Dee, 2026-11-09): it is in Needs you and the badge
  of the project's owner, or the chat's partner, as before;
- An agent's words never change this: only a real ask rings, a command approval on the agent's machine, and its own words
  in its 1:1 chat with you.

**One task, one notification.** A task's "stuck" and "needs you" share one notification slot
(`task:<swarm>:<task chat>`): the later replaces the earlier, and it sounds once. Thread replies keep their own slot.

**By the kind of event, never by its words**: who wrote it (person or agent) and what it is (a reply, a tag, a
finished turn). An agent's message that says "please approve" is still an agent's tag.

**Per chat** the default is **Mentions only** (`DEFAULT_NOTIFY`; the app reads it as the same when the server says
nothing). A chat tells every new message only when its person sets **All new messages**.

Repeats collapse: a task is one notification, and a thread rings once.

## The table

There are 14 events, and nothing else posts to the notification centre: the server pushes from `push/notices.ts` alone,
and the app posts from `lib/notify/system_notices.dart` alone (the iOS and Android code only reads and takes down what is
shown).

- **Event** is what the code calls it.
- **Triggered by** is who does the thing that makes it. The server (Push) or the app (Local) decides who receives it.
- **Real example** is one case from start to end. River is the project's PM, Ann and Tony are people in the Swarm, Oak,
  Magnolia2 and Nova are agents working tasks, Juniper is Tony's Buddy, and the project is openharness.

| # | Type | Event | Triggered by | When it is received | Conditions | Title | Real example | Test evidence |
|---|---|---|---|---|---|---|---|---|---|
| 15 | Push | `chat`: an agent's own words in its 1:1 chat with you, key and slot `chat:<swarm>:<chat>` (`push/notices.ts` `chatNotices`) | The agent of that chat (Swarm v4: every agent has one 1:1 chat with its person). | As above. | Its words only: not a row the server writes in its name, nor one only agents read. One notice per write, for its newest words; it sounds once until you read the chat, then later ones are quiet (`push/unread.ts`). Not in a chat you muted (`push/muted.ts`); "Mentions only" still rings, as an agent's chat is where it reaches you. The app's own "New messages" notice of the chat shares the key, so the two are one notification. | `<agent> wrote to you`, no subtitle, `Open Harness to read it.` | Oak, Tony's agent, writes "The build is green." in its chat with Tony: **Oak wrote to you** · Open Harness to read it. Tap: the chat, at Oak's message. | `notices.test.ts` "an agent's words in its 1:1 chat"; `superTabChatPush.test.ts` |
| 7 | Local | `SwarmWorkNeed`, status `blocked` (`waiting_work.dart` `swarmWaitingWork`) | The task's agent, setting its work to `blocked`. | As above. | A task waiting on you is `blocked`: you are its chat's partner, or else the project's owner, as before; it is in your Needs you and badge. The notice is posted only when you also asked for the task (its requester, anh Dee, 2026-11-09): a task someone else asked for, or nobody, is Needs you and the badge only. A requester who is not the owner or partner is not told. Shares the task's one slot: it replaces the task's earlier notice quietly. | `<agent> is stuck`, project, `Open Harness to see why.` | Magnolia2's task "Fix the CI cache" in Tony's project, which Tony asked for, stops on "npm registry answers 503" and it sets `blocked`. Tony: **Magnolia2 is stuck** · openharness · Open Harness to see why. A task Ann asked for in Tony's project: Tony sees it in Needs you, with no notice. | `swarm_notices_test.dart` group "who is told, so a person in many projects is not spammed"; `waiting_work_test.dart` group "the task's requester"; `swarm_notice_repeat_test.dart` |
| 8 | Local | `SwarmWorkNeed`, status `needs_human` | The task's agent, setting its work to `needs_human`. | As above. | A task waiting on you (as above) needs a person (`needs_human`). The notice only when you also asked for it, as above. Shares the task's one slot, as above. | `<agent> needs you`, project, `Open Harness to answer.` | Oak's task "Ship to the App Store" in Tony's project, which Tony asked for, needs the App Store API key, and it sets `needs_human`. Tony: **Oak needs you** · openharness · Open Harness to answer. Had Ann asked for it: Needs you and the badge only, for Tony. | `swarm_notices_test.dart`; `waiting_work_test.dart` |
| 10 | Local | `SwarmChatNotices.read` → `announceChat` | **Anyone**, a person or an agent, posting a new message in the chat's main stream. | As above. | A new message in a chat you set to **All new messages**, past what you have read. One notice per chat; it sounds once until you read the chat, and a newer message replaces it quietly. The first read of a chat is not news. | `New messages`, project, `Open Harness to read them.` | Tony set the design chat to All new messages. Oak posts "Mockups are up": **New messages** · openharness · Open Harness to read them. Ann posts next before Tony reads: the same notice, silently. | `mobile/test/swarm/swarm_chat_notices_test.dart` "All new messages: each new message in the chat is told, one notice…", "read, the chat's next message sounds again" |
| 11 | None | daemon `turn_ended`, then `turn_summary` with its `tier` (`AgentAnnouncer.turnEndedAwaitingTier`, `tierDecided`) | An agent on your machine finishing a turn; the daemon tells the app over the machine socket. | Harness in front, or seconds after it goes to the background (the machine's socket). | **Badge only** (#3607): the agent is marked unread, with no sound, no banner and no notification, whatever tier the daemon gave. Nothing at all for the agent you are looking at, for a `silent` turn, for a turn that said nothing, or for a Team account's agent. | None. | Claude Code "Fix login" on Tony's MacBook finishes its turn: no notification, only the unread dot on "Fix login". | `mobile/test/notify/finished_turn_badge_only_test.dart`; `done_notice_test.dart`; `agent_announcer_test.dart`; `announcer_lifecycle_test.dart`; `local_system_notices_test.dart` |
| 12 | Local | daemon `commander_question` (`cli/src/core/questions.ts`, over the relay) → `AgentAnnouncer.questionAsked` | An agent on your machine stopping to ask: a permission dialog or `AskUserQuestion` the daemon spots in its pane. | As above; in front, only after 15 s still unanswered. | An agent on your machine asks a question. Away, it tells at once; in front, after 15 s unanswered, and not while you watch that agent. A question answered anywhere (`commander_question_close`) is taken down. A repeat within 5 minutes is quiet: no sound, no banner. Nothing for a Team account's agent. | The agent's name, the machine, the question. | Claude Code "Fix login" on Tony's MacBook asks to run `rm -rf dist`, with Tony's phone in his pocket: **Fix login** · MacBook · Approve Bash command: rm -rf dist. | `local_system_notices_test.dart` "a question rides a channel of its own…", "a quiet notice…"; `question_notice_test.dart`; `question_spam_incident_test.dart` |
| 13 | Local | the device-key log's `onAnnounce` (`app_state.dart`) | A device signing in to your account, or a computer joining it. | When the phone next reads the account's devices (sign-in, or a device-keys change on a machine socket). | A new device joined or signed in to your account. Once per device. Not for the computer the phone's own setup is waiting for. | `New device on your account` | Tony signs in on a new Pixel 9. His iPhone: **New device on your account** · Pixel 9 signed in to your account and can reach your machines. Not yours? Remove it in Settings ▸ Your devices. A computer reads "MacBook joined your account…". | `local_system_notices_test.dart` "a new device on the account…"; `test/phone/phone_shell_device_notice_test.dart` |
| 14 | Local | `announceDeviceRemoval` (`app_state.dart`, `viewer/device_history.dart`) | A device signing out, or another device removing it (not this phone). | As above. | A device left your account: it signed out, another device removed it, or a new device you have not looked at removed it. Once per device. | `Device signed out`, `Device removed` or `Removed by a new device` | Tony removes his old iPad from his MacBook. His iPhone: **Device removed** · iPad was removed from your account by MacBook. The iPad signing out itself: **Device signed out** · iPad signed out of your account. Removed by a device nobody confirmed yet: **Removed by a new device**. | `test/state/device_removal_notice_test.dart`; `phone_shell_device_notice_test.dart` |

**Silent, never pushed** (in the app's Activity and badge only): an agent's reply or tag (including the server's "stuck"
line, which the PM writes and which tags the task's people, #3915), an agent finishing a turn or a task, every reply in
a thread but the first person's one to its starter, a tag in a chat its person muted, a Swarm status line in a thread, reactions, and messages outside
threads that tag nobody. An ask from an agent that may not ask you reaches the PM as a crew need and tells you nothing.
Evidence: `superTabActivity.test.ts` "rings nobody but the starter…", "an agent's reply or a Swarm line before it rings
nobody and takes nothing…", "tells the starter and every person who replied, but never the reply's author" (the Activity
rows), "pushes nothing for a message outside threads that tags nobody, or for a reaction".

Not in the notification centre, so not in the table: the app icon's badge (the Swarm's waiting count, iOS), the unread dot
and buzz on an agent, the new-device and removed-device bands, and snackbars.

## Where each one comes from

- Push: `backend/src/push/notices.ts` `chatNotices` words an agent's posts in its 1:1 chat from the rows a write made.
  `push/send.ts` sends them, less muted chats (`push/muted.ts`) and quiet while unread (`push/unread.ts`), after the write commits, to every phone the person registered (`push/devices.ts`);
  `push/apns.ts` and `push/fcm.ts` talk to Apple and Google.
- Keys and slots. Each notice has a **key** (`chat:<swarm>:<chat>`), the same as the app's Local notice for the same chat, and
  a **slot**, the notification it shows in: the key, as the app's own chat notice. The app's "stuck" and "needs you" of a
  task share `task:<swarm>:<task chat>`. APNs: `apns-collapse-id` is the slot's id (`swarmNoticeId`, FNV-1a, the same as
  the app's `swarmNoticeIdFor`), so the app's notice under that id replaces the push. FCM: the notification's tag is the
  slot, and the app posts under that tag with id 0, as FCM draws it. The payload's `link` is
  `swarm:<swarm>/<chat>/message/<message>[/thread/<root>]`.
- Local: `mobile/lib/notify/system_notices.dart` posts all of them. Swarm ones come from `lib/swarm/swarm_notices.dart`
  (Android channel and iOS thread `swarm-needs-you`), from the Swarm read every 15 s: their waiting work (`lib/swarm/waiting_work.dart`: partner or owner, a notice only for a task they asked for) and the chats
  set to All new messages. Agent ones come from `lib/notify/agent_announcer.dart` (`agent-question`; a finished turn is a
  mark only), device ones from `lib/state/app_state.dart` (`account-device`). On Android the app makes the
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
10. (2026-11-09, read against `main` `8ebf37fc3`) No code changed. The table now numbers the 14 events, names each as the
    code does, says who triggers it with a real example, and lists the Local "waiting at a prompt" notice (#3029), which
    it was missing. A decision reaches you only from an agent
    that may ask you (the PM, your Buddy, a switched project's agent through your Buddy): another agent's ask is the PM's
    crew need. The PM's "stuck" line (#3915) tags the task's people as an agent, so it is badge and Activity only. Neither
    a prompt nor a "stuck" or "needs you" status is pushed: they are Local only, while the app runs.
11. (2026-11-09) Found: the Local reply notice (event 4) also told a thread you only replied in, which the push (event 1)
    did not: the Activity rows the app reads did not say why they told you. Fixed by 12.
12. (2026-11-09, Tony) A thread rings its starter once, for the first person's reply, and never again, read or not. A
    reply to your message in someone else's thread, and a reply in a thread you were tagged in, no longer ring. The server
    decides it when it writes the rows and marks that one Activity row `rings`; the push sends that row alone, and the
    Activity read carries `rings` so the app's Local notice follows the same rule. The quiet repeat of a thread
    (`push/repeats.ts`, #3248) is gone: it also counted an agent's unread reply, so a person's first reply after an agent's
    went out silently. Threads with replies before this change may ring once more for the next person's reply.
13. (2026-11-09, anh Dee) Someone in many projects was told too much. A tag in a chat you muted no longer rings, Push
    or Local: the server reads the tags' chat settings as it sends (`push/muted.ts`), and the app reads the same setting.
    The tag stays in your tags, Activity and the badge. A task's "stuck" and "needs you" (events 7 and 8) post a notice
    only when the person they wait on (the owner, as no backend sets a partner) also asked for the task. Needs you and the
    badge are unchanged: they still list every such task for its owner, and a requester who is not the owner is not told.
14. (2026-11-10, anh Dee) Swarm v4 has no decisions: an agent reaches its person in their 1:1 chat. The decision push (was
    event 3), the Local decision notice (event 6) and the Local "waiting at a prompt" notice (event 9, from the read's
    `promptsWaiting`) are gone; an older app reads no decisions and no prompt waits from the server.
15. (2026-11-10, anh Dee) Swarm v4: an agent reaches its person in their 1:1 chat. What the agent writes there now pushes to
    that person (event 15), unless they muted the chat, sounding once until they read it. Not yet: the app takes down only
    the chat notices it posted itself, so a pushed one stays in the notification centre after the chat is read (a phone change). This replaces, for v4, the tag and decision pushes v3 agents rang
    their person with.
16. (2026-11-10, anh Dee) Swarm v4 keeps no tag list, Activity, reminders or followed threads. The server no longer pushes a
    tag or a thread reply (events 1 and 2), and an older app reads no tags or Activity to post its own (events 4 and 5).
    Push keeps the agent's 1:1 chat (event 15).
