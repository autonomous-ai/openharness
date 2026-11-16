# Phone notifications

Every notification the Harness phone app (iOS and Android) can show in the system's notification centre, as of
2026-11-14 (tasks #3607 and #3029). Each one is **Local**: the app posts it itself, from what it reads while it runs.
The server's push plumbing stays (`backend/src/push/`: the phones a person registered, Apple's APNs and Google's FCM),
and no event pushes today.

A notice never says what a person wrote: it can be read on a locked phone. It says who, and on which machine.

## The rule

Tony's rule (2026-11-06, task #3607): a phone rings only when a person must act.

**Rings** (sound, banner):
- an agent asks you to approve a command on its machine, and the work waits on you;
- a sign-in from a device you do not know (the server does not push it).

**Badge only** (no sound, no banner, nothing in the notification centre):
- an agent finishing a turn.

An agent's words never change this: only a real ask rings, a command approval on the agent's machine.

## The table

There are four events, and nothing else posts to the notification centre: the app posts from
`lib/notify/system_notices.dart` alone (the iOS and Android code only reads and takes down what is shown).

- **Event** is what the code calls it.
- **Triggered by** is who does the thing that makes it.
- **Real example** is one case from start to end. Tony is the phone's person, and "Fix login" is a Claude Code harness
  on his MacBook.

| # | Type | Event | Triggered by | When it is received | Conditions | Title | Real example | Test evidence |
|---|---|---|---|---|---|---|---|---|---|
| 1 | None | daemon `turn_ended`, then `turn_summary` with its `tier` (`AgentAnnouncer.turnEndedAwaitingTier`, `tierDecided`) | An agent on your machine finishing a turn; the daemon tells the app over the machine socket. | Harness in front, or seconds after it goes to the background (the machine's socket). | **Badge only** (#3607): the agent is marked unread, with no sound, no banner and no notification, whatever tier the daemon gave. Nothing at all for the agent you are looking at, for a `silent` turn, or for a turn that said nothing. | None. | "Fix login" finishes its turn: no notification, only the unread dot on "Fix login". | `mobile/test/notify/finished_turn_badge_only_test.dart`; `done_notice_test.dart`; `agent_announcer_test.dart`; `announcer_lifecycle_test.dart`; `local_system_notices_test.dart` |
| 2 | Local | daemon `commander_question` (`cli/src/core/questions.ts`, over the relay) → `AgentAnnouncer.questionAsked` | An agent on your machine stopping to ask: a permission dialog or `AskUserQuestion` the daemon spots in its pane. | As above; in front, only after 15 s still unanswered. | An agent on your machine asks a question. Away, it tells at once; in front, after 15 s unanswered, and not while you watch that agent. A question answered anywhere (`commander_question_close`) is taken down. A repeat within 5 minutes is quiet: no sound, no banner (#3126). | The agent's name, the machine, the question. | "Fix login" asks to run `rm -rf dist`, with Tony's phone in his pocket: **Fix login** · MacBook · Approve Bash command: rm -rf dist. | `local_system_notices_test.dart` "a question rides a channel of its own…", "a quiet notice…"; `question_notice_test.dart`; `question_spam_incident_test.dart` |
| 3 | Local | the device-key log's `onAnnounce` (`app_state.dart`) | A device signing in to your account, or a computer joining it. | When the phone next reads the account's devices (sign-in, or a device-keys change on a machine socket). | A new device joined or signed in to your account. Once per device. Not for the computer the phone's own setup is waiting for. | `New device on your account` | Tony signs in on a new Pixel 9. His iPhone: **New device on your account** · Pixel 9 signed in to your account and can reach your machines. Not yours? Remove it in Settings ▸ Your devices. A computer reads "MacBook joined your account…". | `local_system_notices_test.dart` "a new device on the account…"; `test/phone/phone_shell_device_notice_test.dart` |
| 4 | Local | `announceDeviceRemoval` (`app_state.dart`, `viewer/device_history.dart`) | A device signing out, or another device removing it (not this phone). | As above. | A device left your account: it signed out, another device removed it, or a new device you have not looked at removed it. Once per device. | `Device signed out`, `Device removed` or `Removed by a new device` | Tony removes his old iPad from his MacBook. His iPhone: **Device removed** · iPad was removed from your account by MacBook. The iPad signing out itself: **Device signed out** · iPad signed out of your account. Removed by a device nobody confirmed yet: **Removed by a new device**. | `test/state/device_removal_notice_test.dart`; `phone_shell_device_notice_test.dart` |

Not in the notification centre, so not in the table: the unread dot and buzz on an agent, the new-device and
removed-device bands, and snackbars.

## Where each one comes from

- Local: `mobile/lib/notify/system_notices.dart` posts all of them. Agent ones come from
  `lib/notify/agent_announcer.dart` (`agent-question`; a finished turn is a mark only), device ones from
  `lib/state/app_state.dart` (`account-device`).
- Push: `backend/src/push/send.ts` sends to every phone the person registered (`push/devices.ts`); `push/apns.ts` and
  `push/fcm.ts` talk to Apple and Google. No event uses it today.

## What the inventory found, and what was done

1. (#3607) An agent finishing a turn rang the phone as loudly as a person did. Fixed: it is a badge only, classified by
   what happened, never by the agent's words.
2. (#3607) Not changed, proposed: the server does not push "a sign-in from a device you do not know" (the app reads it
   when it next opens). A push needs the device-sign-in write path and two security reviews, so it is a separate task.
