# Device notifications: fewer, and each one worth it

Date: 2026-10-19. Status: the direction was approved in brainstorming (a hybrid of rules and Jev). This spec is waiting for review.

## Problem

The owner says notifications on the round dial and on the Pro are "too many". What was measured on one machine:

**One finished turn on an agent you are not watching triggers all of this:**
- Desktop: banner, sound and system notification.
- Round: beep, screen wake, celebration pose, drawer row and bell count.
- Pro: beep, wake, toast and Inbox entry.

**Volume:**
- About 2/3 of the live round-dial summaries (101/150) were for the agent the person was looking at on the desktop. The round dial still beeps for these, even when the daemon marks them `quiet` (`cable_client.c:1322`).
- There is no time-based limit. The busiest day logged 51 beeps, 10 of them in one hour. The desktop logged 29 "done" notifications today, 11 of them in one hour.

**What the person cares about:**
- Every finished turn is treated as equal news: a 5-second fix and a 40-minute build that passed 640 tests get the same treatment.
- The person mostly wants to know two things: that an agent needs them (a question or a failure), and that substantial work is done.

## Goal

A device notifies only when it is worth it, under one policy decided once in the daemon for both devices:
- An **alert** interrupts: sound, wake and toast.
- A **list** entry waits quietly in Notices or the drawer.
- Everything else changes only the pet's state.

## Decision: rules first, Jev for the grey zone

Every live `summary`, question and failure gets one **tier**:

| Event | Decided by | Tier |
|---|---|---|
| The agent asks a question | rule | `alert` |
| The turn failed (`turn.error`, or a summary of a failed turn) | rule | `alert` |
| A sub-agent's turn, a replayed or restored turn, or an empty result | rule | `silent` (as today) |
| The agent is on screen (`alreadyOnScreen()` on the desktop, or open on the device itself) | rule | `silent` |
| **A finished turn on an agent not on screen** | **Jev** | `alert` / `list` / `silent` |
| Jev unavailable, more than 1 s late, or no key/credits | fallback rule | `list` if the turn ran 120 s or more, else `silent` |

### The Jev question

Jev is `typesafe/jev-1.13` through `cli/src/lib/jev/jevClient.ts` `createJevDecide`, Harness-paid through the backend, the same way the ⌘B router uses it.

- **State sent:**

  ```json
  { "agent": "<name>", "engine": "codex",
    "recap": "<the turn's recap, ≤ 600 chars>",
    "duration_s": 312,
    "work": { "tests_passed": 640, "tests_failed": 0, "commits": 1 },   // the turn stats the daemon already reads (cable/turnStats.ts)
    "recent": { "alerts_30m": 2, "lists_30m": 5 } }
  ```

- **One choice question,** `tier`, with these criteria (the exact copy lives in code next to the question):
  - `alert`: a substantial result the person would want to know about now, such as a long task finished, a build or deploy done, or a requested deliverable ready. It is less likely when `alerts_30m` is already high.
  - `list`: real progress worth a glance later, such as a small feature or a fix with edits.
  - `silent`: chatter, such as an acknowledgement, a short answer, a no-op, or a step inside a longer job.
- **Logging.** The daemon logs each decision as `notify · <agent> · <tier> · jev p=<probabilities> · <ms>`, or `· rule <name>` / `· fallback <reason>`, so any call can be checked afterwards.
- **Privacy.** Only the recap excerpt (≤ 600 chars) and the counts leave the machine, never the transcript. The environment variable `HARNESS_NOTIFY_SMART=0` turns Jev off, so the fallback rule decides (the daemon has no settings store for this).

## Wire

- `summary` gains `tier: "alert" | "list" | "silent"`.
- `quiet` and `silent` are still sent, so firmware that predates `tier` degrades sensibly:
  - `alert` sets neither;
  - `list` sets `quiet`;
  - `silent` sets `silent`.
- `question` and `turn.error` stay as they are; both devices treat them as `alert`.

## Devices (both the round dial and the Pro)

| Tier | Sound | Wake screen | Toast or banner | Notices / drawer |
|---|---|---|---|---|
| `alert` | one beep (at most one per 30 s per device: a burst of finishes beeps once) | yes | yes (Pro: unless that agent's room is shown) | entry |
| `list` | none | no | no | entry |
| `silent` | none | no | no | none (the pet and the card still update) |

**Device-side rules:**
- If the agent's own room (Pro) or face (round dial) is on screen, any tier is shown in place: no sound, no wake, and the entry is read at once.
- The list keeps **one entry per agent**, the newest. Entries **expire after 6 hours**. The Pro's limit of 16 and the round's 24 still cap the list.
- **Round dial fixes:**
  - honour `quiet` and `list` (no beep; `cable_client.c:1322`);
  - skip the celebration pose for `list`;
  - auto-dismiss the `turn.error` full-screen message after 8 s, keeping its row in the drawer.
- **Pro fix:** a `list` entry goes into Notices with no beep, no wake and no toast. Today `quiet` drops the entry entirely (`pro_cable.c:600-605`).

## Out of scope

- The desktop's own banners and sounds. They keep today's behaviour; making them use the tier is a follow-up.
- Device "Do Not Disturb" hours.
- A device settings screen.
- Per-agent mute.

## Success criteria

- **Measured volume:** over a normal working day on the owner's machine, device beeps fall by 60% or more compared with the same day pattern before the change. The daemon counts tiers per day in its log.
- **Nothing important is missed:** every question and every failure is an `alert`; tests pin both rules.
- **Fallback:** with Jev unavailable, tiers come from the fallback rule and nothing errors.
- **Old firmware:** it keeps working with a new daemon, through `quiet` and `silent`. New firmware keeps working with an old daemon, which sends no `tier` and is treated as today.

## Code map

**Daemon:**
- `cli/src/lib/agentNotifications.ts`: the tier decision. Rules stay synchronous; Jev runs with a 1 s budget.
- `cli/src/lib/commander.ts:773-781`.
- `cli/src/services/devices.ts:265-291` (`alreadyOnScreen`).
- `cli/src/cable/cableSession.ts` `summary` (the `tier` field).
- `cli/src/lib/jev/jevClient.ts` (reused).

**Round dial:**
- `devices/harness-device/firmware/main/cable_client.c:1287-1420`.
- `main/ui/habitat/ui_habitat.c` (`ui_notify_task_done`, the drawer and its expiry, the error view).

**Pro:**
- `devices/harness-pro/firmware/main/cable/pro_cable.c:600-605`.
- `main/app/pod_glue.c:763-794`.
- `main/app/pro_app.c` (beep and wake).
- `main/pod/pod_model.c` (one entry per agent, expiry).

## Risks

- **Jev judges wrong.** The rules guarantee questions and failures, so the only failure mode is a finished turn landing in the wrong tier. The decision log makes that visible, and the criteria copy can be tuned without firmware.
- **Latency.** The summary is held for up to 1 s waiting for Jev. A summary is not time-critical; the pet's state still changes at once.
- **Cost.** About 30 decisions a day at about $0.0002 each is negligible. It is paid by Harness, as the owner chose for the router (2026-10-11).
