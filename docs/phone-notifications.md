# Phone notifications

Every notification the Harness phone app (iOS and Android) can show in the system's notification centre, as of
2026-11-09 (`main` `d18648f46`; tasks #3607, #3029, #3915, #4525, #4547; the reply, mute and requester rules of 2026-11-09). **Push** comes from the server through Apple
(APNs) or Google (FCM) and reaches a phone whose app is closed or in the background. **Local** is posted by the app
itself, from what it reads while it runs.

A notice never says what was written: it can be read on a locked phone. It says who, and in which project.

## The rule

Tony's rule (2026-11-06, task #3607), on top of the one he approved on 2026-11-05 ("Yes, as proposed"). A phone
rings only when a person must act, or when a person speaks to you. Push and Local follow it together.

**Rings** (sound, banner):
- an agent that may ask you asks you to decide or approve, and the work waits on you: `decision.ask`, `needs_human` with
  an ask, a question on a proposal card, a command approval on an agent's machine. Since 2026-11-05 (anh Dee) people
  talk only to the PM, so the agents that may ask you are the project's PM and your own Buddy (below);
- a sign-in from a device you do not know (Local, below; the server does not push it yet);
- a **person** tags you, in a chat you have not muted (anh Dee, 2026-11-09);
- a **person** replies in a thread you started, the first time: a thread rings its starter once, never again, read or
  not (Tony, 2026-11-09). An agent's reply and a Swarm status line before it do not count.

**Badge and Activity only** (no sound, no banner, nothing in the notification centre):
- an agent finishing a turn, or a whole task;
- an agent replying in your thread (unless it is a decision ask);
- every later reply in a thread you started, and every reply to your message in someone else's thread, in a thread you
  were tagged in, or in one you only replied in (2026-11-09);
- a tag in a chat you muted (anh Dee, 2026-11-09): it is in your tags, Activity and the badge;
- a task's "stuck" or "needs you" for a task you did not ask for (anh Dee, 2026-11-09): it is in Needs you and the badge
  of the project's owner, or the chat's partner, as before;
- an agent tagging you without a decision or approval. This includes the server's "no reviewer can start" notice and
  its "stuck" line (#3915): both are written as an agent (the one that asked for the review, the PM), so they are an
  agent's tags.
- An agent's words never change this: a plain reply or tag from an agent that asks for your approval is still badge and
  Activity only. Only a real ask rings: `decision.ask`, `needs_human` with an ask, a proposal card's question, or a
  command approval on the agent's machine.

**One task, one notification.** A task's "stuck", "needs you" and decision question share one notification slot
(`task:<swarm>:<task chat>`): the later replaces the earlier, and it sounds once. Thread replies keep their own slot.

**By the kind of event, never by its words**: who wrote it (person or agent) and what it is (a reply, a tag, a decision, a
finished turn). An agent's message that says "please approve" is still an agent's tag.

**Per chat** the default is **Mentions only** (`DEFAULT_NOTIFY`; the app reads it as the same when the server says
nothing). A chat tells every new message only when its person sets **All new messages**.

Repeats collapse: a task is one notification, and a thread rings once.

## Who may ask you

A decision reaches you, and so your Push and Local "asks you", only from an agent allowed to ask you directly. The server
decides it (`superTabs/commands.ts` `decision.ask`, `work.status`, `proposal.ask`; `crewNeeds.ts` `routesToPm`):

| Asker | Asks you? |
|---|---|
| The project's PM: `decision.ask`, `work.status` `needs_human` with an ask, or a question on a proposal card (`proposal.ask`, the PM only) | Yes |
| Your own Buddy: `decision.ask` (it asks only its owner, `checkBuddyAsker`) | Yes |
| Any agent of a switched project, through your default Buddy (`asksDirectly`, task #3826) | Yes |
| Any other agent | No: its ask becomes the PM's crew need, with no decision and no notification for you |

Nothing is pushed for a repeat of a question still open, nor for an ask past 20 open decisions from the same asker
(`MAX_OPEN_DECISIONS`).

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
| 1 | Push | `reply`: the Activity row `writeReplyActivity` marked `rings`, key `reply:<swarm>:<row>` | A **person** posting a reply in a thread. The server pushes once the write commits (`superTabs/store.ts` `tellPhones`). | App closed or in the background. With Harness in front the push is not drawn (iOS `willPresent`, Android FCM in front): the app's own Local notice decides. | **The first reply by a person in a thread you started, once, never again** (Tony, 2026-11-09): a later reply there, by anyone, read or not, is Activity and the badge only. The server marks that one row `rings` when it writes the rows; the command holds the chat's sequence, so two replies at once cannot both be the first. **Never an agent's reply** (#3607) or a Swarm status line (Working, Ready for review, Done): they ring nobody and do not use up the ring. Never your own reply, a reply to your message in someone else's thread, a thread you were tagged in or only replied in, a muted chat, an unfollowed thread, a chat you can no longer read, or a reply that tags you (the tag push tells you instead): the first reply you are told of after unmuting or following again rings, if none rang before. A tag is its own push (event 2): it neither uses up this ring nor is stopped by it, so a thread can ring you once for a reply and once per tag (Tony, 2026-11-09). Always with sound, in the thread's slot. | `<name> replied in a thread`, subtitle the project, body `Open Harness to read it.` | Tony started a thread "Login fails on Android" and closed the app. Oak, the task's agent, answers first: nothing rings. Ann replies "Reproduced on a Pixel 9". Tony's phone rings: **Ann replied in a thread** · openharness · Open Harness to read it. Ann adds a second reply, then Tony reads the thread, then Mia replies: none of them rings; they are in Activity and the badge. Tap: the thread, at Ann's reply. | `backend/integration/superTabActivity.test.ts` "Phone push: a thread rings its starter once, for the first person's reply, never again" (6 tests, with the read's plan), "Phone push: who each push type reaches, and what it carries", "Phone push end to end on the server…"; `backend/src/push/notices.test.ts` "pushes the reply rows that ring alone…", "an agent's reply rings nobody"; `fcm.test.ts` "tags the notification with its slot…" |
| 2 | Push | `mention`: a tag row `writeMentions` wrote, key `mention:<row>` | A **person** posting a message that tags you (`@username`). | As above. | You are tagged **by a person** in a chat you can read and have not muted. A tag in a chat you muted rings nothing (anh Dee, 2026-11-09): it is in your tags, Activity and the badge. `push/send.ts` drops it as it sends (`push/muted.ts`: one read of the tags' chat settings by id, after the write commits); a read that fails sends it, and logs it. An agent's tag does not ring (#3607), nor do the server's "no reviewer can start" notice and "stuck" line, which are written as an agent: they are in Activity and the badge. Never your own tag. A tag held for a quiet chat (no agent working there yet; held 20 minutes, `NO_WORKER_GRACE_MS`) is not pushed, then or later. Always with sound. | `<name> tagged you`, subtitle the project, body `Open Harness to read it.` | Ann writes "@tony can you review the push PR?" in openharness's chat. Tony's phone: **Ann tagged you** · openharness · Open Harness to read it. River writing "@tony please approve" is an agent's tag: badge and Activity only. Tap: the message, in its thread when it is only there. | `notices.test.ts` "words a tag as the phone does…", "pushes no tag held back for a quiet chat", "an agent's tag rings nobody, a person's tag rings", "the server's "no reviewer can start" tag is an agent's tag…"; `muted.test.ts`; `superTabActivity.test.ts` "a tag links the message in the chat…", "rings nobody but the starter…" (a tag in the thread still rings), "a tag in a chat its person muted reaches none of their phones…", "weighs a write's tags against their chats' mutes in one read by id…" (with its plan); `mobile/test/app_state_push_test.dart` "a tapped push opens the chat its link names" |
| 3 | Push | `decision`: a decision `writeDecisions` wrote new in this write (from `decision.ask`, `work.status` `needs_human` with an ask, `proposal.ask`), key `decision:<id>` | An agent that may ask you ([Who may ask you](#who-may-ask-you)): the project's PM, your Buddy, or an agent of a switched project through your Buddy. | As above. | A decision asked of you, the first time it is asked. One ask of several questions sounds once; the rest are quiet. **All of a task's decisions share one slot** (`task:<swarm>:<task chat>`, #3607), the same slot as the task's Local "stuck" and "needs you". | `<asker> asks you`, subtitle the project, body `Open Harness to answer.` | River asks Tony "Ship 1.4 to TestFlight today, or wait for QA?". Tony's phone: **River asks you** · openharness · Open Harness to answer. Tap: Activity, at the card. Tony's Buddy asking "Send this to the openharness PM?": **Juniper asks you**. Oak asking Tony directly: River gets it as a crew need, and Tony nothing. | `notices.test.ts` "pushes a decision asked of a person as the app words it…"; `superTabActivity.test.ts` "a decision asked of a person reaches their phone once…", "one ask of several questions sounds once"; `asksThroughBuddy.test.ts` "opens the person’s decisions for a decision.ask…"; `buddies.test.ts` "keeps another agent's line the PM's crew need…" |
| 4 | Local | `reply`: the unread Activity row the server marked `rings` (`SwarmActivityFeed.onReply` → `SwarmAnnouncer.announceReply`) | A **person** replying in a thread; the app finds it on its Swarm read. | Harness in front with no Swarm screen open: the Swarm read every 15 s. | The same reply as the push, and only it: the Activity read carries `rings`, so the app follows the push's rule (2026-11-09). Every other reply, an agent's included, posts nothing. Shares the push's notification for that thread: it replaces the push rather than adding a second, and posts nothing for a reply a push told already. Taken down, with the push in it, once that reply is read. An older backend that does not send `rings` gets no Local reply notice. | `<name> replied in a thread` (`Someone` with no name), project, `Open Harness to read it.` | Tony has Harness open on a terminal. Ann gives the first reply in his "Login fails on Android" thread. Within 15 s: **Ann replied in a thread** · openharness. Ann's next reply: nothing. | `mobile/test/swarm/swarm_notices_test.dart` "rings once per thread, as the server's push does…", "is not posted for a thread a push shows…", "a push in the notification centre comes down once its reply is read in the app", "an older backend that marks no row posts no reply notice"; `swarm_activity_feed_test.dart` "a reply the server did not ring for posts nothing…"; `test/phone/phone_shell_swarm_notice_test.dart` |
| 5 | Local | `SwarmMentionNeed`: a tag waiting for you in the Swarm read | A **person** tagging you. | As above. | A tag by a person waiting for you (the same tags as the tag push), in the push's notification. Nothing for a tag in a chat you muted: the app reads your setting for the chat (`notifyOf`), as the push does (2026-11-09). A tag by an agent is the badge only: the mention list says who tagged (`leadKind`), and the app posts nothing for an agent. | `<name> tagged you`, project, `Open Harness to read it.` | Tony is in Harness on another screen. Ann tags him: **Ann tagged you** · openharness. | `swarm_notices_test.dart` "a tag in a thread opens that thread at the tag", group "who rings (task #3607)", group "who is told, so a person in many projects is not spammed"; `swarm_session_test.dart` group "a tag in a chat the person muted"; `swarm_chat_notices_test.dart` "Mentions only and Muted tell of no new message; a tag is told in Mentions only, never in a chat the person muted…"; `swarm_notice_repeat_test.dart` "read again and again, each ask is told once" |
| 6 | Local | `SwarmDecisionNeed`: a decision waiting for you in the Swarm read | An agent that may ask you, as for the decision push. Your Buddy's questions are in your Decisions too (#4525). | As above. | A decision asked of you, in the push's notification: the task's slot, shared with "stuck" and "needs you" below. | `<asker> asks you`, project, `Open Harness to answer.` | River asks Tony while the app is open: **River asks you** · openharness · Open Harness to answer. Tap: Activity, at the card. | `swarm_notices_test.dart` "a decision says who asks…", group "one task, one notification (task #3607)"; `phone_shell_swarm_notice_test.dart` |
| 7 | Local | `SwarmWorkNeed`, status `blocked` (`waiting_work.dart` `swarmWaitingWork`) | The task's agent, setting its work to `blocked`. | As above. | A task waiting on you is `blocked`: you are its chat's partner, or else the project's owner, as before; it is in your Needs you and badge. The notice is posted only when you also asked for the task (its requester, anh Dee, 2026-11-09): a task someone else asked for, or nobody, is Needs you and the badge only. A requester who is not the owner or partner is not told. Shares the task's one slot: it replaces the task's earlier notice quietly. | `<agent> is stuck`, project, `Open Harness to see why.` | Magnolia2's task "Fix the CI cache" in Tony's project, which Tony asked for, stops on "npm registry answers 503" and it sets `blocked`. Tony: **Magnolia2 is stuck** · openharness · Open Harness to see why. A task Ann asked for in Tony's project: Tony sees it in Needs you, with no notice. | `swarm_notices_test.dart` group "who is told, so a person in many projects is not spammed"; `waiting_work_test.dart` group "the task's requester"; `swarm_notice_repeat_test.dart` |
| 8 | Local | `SwarmWorkNeed`, status `needs_human` | The task's agent, setting its work to `needs_human`. | As above. | A task waiting on you (as above) needs a person (`needs_human`). The notice only when you also asked for it, as above. Shares the task's one slot, as above. Its question, when the agent may ask you, is the decision above. | `<agent> needs you`, project, `Open Harness to answer.` | Oak's task "Ship to the App Store" in Tony's project, which Tony asked for, needs the App Store API key, and it sets `needs_human`. Tony: **Oak needs you** · openharness · Open Harness to answer. Had Ann asked for it: Needs you and the badge only, for Tony. | `swarm_notices_test.dart`; `waiting_work_test.dart` |
| 9 | Local | `SwarmWorkNeed` at a prompt: the read's `promptsWaiting` (`promptWaits.ts`) | The task's agent, stopping at a permission prompt in its terminal (its machine reports `prompt`). | As above. | An agent of a task of yours waits at a prompt: the server lists it for the task's requester, or the device machine's owner (task #3029). Its own notification (its need's key), not the task's slot. | `<agent> is waiting at a prompt`, project, `Open Harness to answer it.` | Nova, working Tony's task, stops at Claude Code's "Allow Bash: npm publish?". Tony: **Nova is waiting at a prompt** · openharness · Open Harness to answer it. | `swarm_notices_test.dart` "an agent at a prompt in the reader's task is a notice of its own…"; `backend/src/superTabs/promptWaits.test.ts` |
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
and buzz on an agent, the new-device and removed-device bands, and snackbars. The PM's routing proposals (the routine's
reflection decisions) are listed in Activity and are not pushed.

## Where each one comes from

- Push: `backend/src/push/notices.ts` words the three kinds from the rows a write made (`superTabs/activity.ts`
  `writeReplyActivity`, which marks the one reply row that rings, `rings`; `superTabs/mentions.ts` `writeMentions`, for a
  person's messages and the "stuck" line; the decisions `superTabs/store.ts` writes for `decision.ask`, `needs_human` and
  `proposal.ask`). Whether a thread rang its starter already is one indexed read in the reply's own transaction (the
  Activity thread index, the starter's rows of that thread), made only for a person's reply that tells its starter.
  `push/send.ts` sends them after the write commits, to every phone the person registered (`push/devices.ts`);
  `push/apns.ts` and `push/fcm.ts` talk to Apple and Google.
- Keys and slots. Each notice has a **key** (`reply:<swarm>:<row>`, `mention:<row>`, `decision:<id>`), the same as the
  app's Local notice for the same thing, and a **slot**, the notification it shows in: `thread:<swarm>:<chat>:<root>` for a
  reply, `task:<swarm>:<task chat>` for a decision (and the app's "stuck" and "needs you" for that task), the key for a tag. APNs: `apns-collapse-id` is the slot's id (`swarmNoticeId`, FNV-1a, the same as
  the app's `swarmNoticeIdFor`), so the app's notice under that id replaces the push. FCM: the notification's tag is the
  slot, and the app posts under that tag with id 0, as FCM draws it. The payload's `link` is
  `swarm:<swarm>/<chat>/message/<message>[/thread/<root>]` or `swarm:<swarm>/<chat>/decision/<id>`.
- Local: `mobile/lib/notify/system_notices.dart` posts all of them. Swarm ones come from `lib/swarm/swarm_notices.dart`
  (Android channel and iOS thread `swarm-needs-you`), from the Swarm read every 15 s: the person's decisions and tags,
  their waiting work (`lib/swarm/waiting_work.dart`: partner or owner, a notice only for a task they asked for; and the server's `promptsWaiting`) and the chats
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
