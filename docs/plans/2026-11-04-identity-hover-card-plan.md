# Identity hover card Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** Hovering a name or avatar in a Swarm chat shows a small card: for a person their name, status and local time; for an agent its engine and model, machine, and the task it works on as a link to that task's chat. Desktop and web. Strengthens "Every lab in one crew, on the team's own machines": who someone is, where an agent runs and what it is doing are one hover away.

**Architecture:** The card is one shared Flutter widget (`identity_card.dart`) fed plain facts the chat view works out: a person's from the Swarm's people, an agent's from `SuperTabAgentInfo` (the facts the agent details dialog already uses). The Swarm stores no time zone today, so the backend gains one per person (`member.timeZone`, an IANA name), which each person's own app reports when it differs; readers turn the name into a local time with the Dart team's `timezone` package, loaded only when a card first needs it.

**Tech Stack:** TypeScript, Zod, Vitest (backend); Flutter/Dart Desktop and web, `package:timezone`.

**Spec:** Task #2605 in Super Tab conversation cdbc82e3d4e7f7c81d9d9fe8 (Huy, 2026-11-04; River's brief, and River's ruling the same day: report the zone name, not a UTC offset).

## Global Constraints

- Look, as posted for Huy (screenshots in the task thread):

  ```
  Person                     Agent
  ┌──────────────────────┐   ┌──────────────────────────────────┐
  │ Huy Pham             │   │ Shrike2                          │
  │ 🌴 Out of office     │   │ ✳ Claude Opus 5.5                │
  │ 🕒 3:42 PM local time│   │ 💻 MacbookPro                    │
  └──────────────────────┘   │ Working on #2605 Chat: a card… › │
                             └──────────────────────────────────┘
  ```

- Opens after 500 ms of hover on the avatar or the name; closes 150 ms after the pointer has left both the anchor and the card. Keyboard focus on the name opens it at once; Escape closes it and keeps focus on the name; Tab from the name reaches the task line; Enter there opens the task's chat.
- A fact nobody knows is left out: no status, no zone, an unknown zone, no machine, no task. Never a guessed time.
- Not repeated from the row: no avatar and no message time in the card.
- Harness Design Language: tokens only (`scripts/check-ui-style.py`), the shared popover surface (`AppMenu.fill`, `AppMenu.rim`, `AppMenu.panelRadius`, `AppSurface.shadow`), flat rows, the task link has a hand cursor, an underline and a chevron on hover/focus so colour is not its only sign, no explanatory sentences.
- Copy: `<time> local time`; the task line is `SuperTabAgentInfo.status` with `#<number> <title>` in place of the quoted title.
- Desktop tests use a memory store and a fake sign-in; no test touches the real CLI.
- The zone is the IANA name (`Asia/Ho_Chi_Minh`), never an offset (River, 11-04).

## Design

- Growth: one short string per person, deleted with the person's membership record.
- Concurrency: `member.timeZone` runs in the Swarm's state transaction like `member.status`; last write wins, and it is the person's own.
- Read cost: the zone rides in the people part, which changes only when someone's zone changes; an app sends only when its zone differs from the stored one, once per value per session.
- Scale: 10x people is 10x tiny strings; the first warning is `member.timeZone` commands per minute, which should be near zero at rest.
- Compatibility: an older app ignores the field. A new app on an older backend gets a refusal for the unknown command, ignores it, and its card shows no time.
- Migration + rollback: none; nothing reads an absent field. A rollback leaves stored zones unread.
- Audience: the server sends people only to members (`model.ts` visible state), as it does status.
- Identity: the actor's own person id (`actor.userId`); an agent may not set one, and nobody sets another's.
- Failure: a refused or failed report is silent by design, and the card then shows no time rather than a wrong one. An unknown zone name is refused by the server (`knownTimeZone`).
- Platforms: macOS, Linux and web report a zone; Windows reports none (its zone names are not IANA ones) so Windows people show no time; the phone app is not changed.

## Review Focus

- A person whose app never reported a zone, or reported one this build's table lacks: no time line, no crash (Task 3 test `unknown zone gives no time`).
- An older backend refusing `member.timeZone`: no error shown, no resend loop (Task 2 test `a refused report is not sent again`).
- The pointer moving from the name into the card: the card stays open (Task 4 test `stays open while the pointer crosses into the card`).
- A grouped follow-up line has no name or avatar: no card anchor there (Task 5 test `a grouped line has no card`).
- An agent with no task, or a task the reader may not read: no task line (Task 5 test `no task line without a readable task`).

---

### Task 1: Backend `member.timeZone`

**Files:**
- Modify: `backend/src/superTabs/model.ts` (`Person.timeZone?: string`)
- Modify: `backend/src/superTabs/profile.ts` (`setTimeZone`)
- Modify: `backend/src/superTabs/commands.ts` (schema line beside `member.status`, viewer rule beside `member.username`, dispatch)
- Test: `backend/src/superTabs/profile.test.ts`

**Interfaces:**
- Produces: command `{ type: 'member.timeZone', timeZone: string | null }` (string 1..64); readers get `people[].timeZone`.

- [x] **Step 1: Failing tests** in `profile.test.ts`, `describe('time zone')`: `sets and clears the person's own zone` (`Asia/Ho_Chi_Minh` stored, `null` deletes it); `refuses an unknown zone and an agent` (`Mars/Base` throws with code `TIME_ZONE`; an agent actor throws; nothing stored); `a viewer may set their own` (viewer actor succeeds).
- [x] **Step 2:** `cd backend && npx vitest run src/superTabs/profile.test.ts` fails on the unknown command.
- [x] **Step 3:** `setTimeZone(state, actor, timeZone: string | null)` in `profile.ts`: person only (`HUMAN_REQUIRED`), `knownTimeZone` from `digest.ts` or `fail('TIME_ZONE', 'Name a time zone such as Asia/Ho_Chi_Minh.', 400)`; null deletes. Add the command to the viewer-allowed list with `member.username`.
- [x] **Step 4:** the same run passes; `npx tsc --noEmit -p .` clean.
- [x] **Step 5:** commit.

### Task 2: Desktop reports the reader's zone

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabPerson.timeZone`)
- Create: `desktop/lib/super_tabs/local_time_zone.dart` (conditional export), `local_time_zone_native.dart`, `local_time_zone_web.dart`
- Modify: `desktop/lib/super_tabs/profile_actions.dart` (`reportTimeZone`), `desktop/lib/super_tabs/controller.dart` (call after a read)
- Modify: `desktop/test/support/super_tab_fixture.dart` (`member.timeZone` like `member.status`)
- Test: `desktop/test/super_tab_time_zone_test.dart`

**Interfaces:**
- Produces: `String? SuperTabPerson.timeZone`; `String? superTabLocalTimeZone()` with a `@visibleForTesting` override `superTabLocalTimeZoneOverride`; `Future<void> SuperTabController.reportTimeZone()`.

- [x] **Step 1: Failing tests:** `reads a person's zone` (fromJson); `zoneFromLocaltimeLink` maps `/var/db/timezone/zoneinfo/Asia/Ho_Chi_Minh` and `/usr/share/zoneinfo/Europe/Berlin` to their names and `/etc/foo` to null; `reports the zone once when it differs` (fixture records one `member.timeZone` after `refresh()`, none after a second refresh); `does not report a zone already stored`; `a refused report is not sent again` (fixture refuses the command: no error surfaced, one attempt over two refreshes).
- [x] **Step 2:** `flutter test test/super_tab_time_zone_test.dart` fails.
- [x] **Step 3:** native reads `TZ` when it is an `Area/City` name, else the `/etc/localtime` link after `zoneinfo/`, else Linux's `/etc/timezone`; Windows null. Web reads `Intl.DateTimeFormat().resolvedOptions().timeZone` through `dart:js_interop`. The controller calls `reportTimeZone()` after a read that built a snapshot, unawaited; it remembers the value it tried.
- [x] **Step 4:** the test file passes.
- [x] **Step 5:** commit.

### Task 3: Local time from a zone name

**Files:**
- Modify: `desktop/pubspec.yaml`, `desktop/pubspec.lock` (`timezone: ^0.11.2`)
- Create: `desktop/lib/super_tabs/zone_time.dart`
- Test: `desktop/test/super_tab_zone_time_test.dart`

**Interfaces:**
- Produces: `Future<TimeOfDay?> superTabTimeIn(String? zone, DateTime nowUtc)`.

- [x] **Step 1: Failing tests:** `Asia/Ho_Chi_Minh at 08:42Z is 15:42`; `New York keeps daylight saving` (`2026-07-01T16:00Z` → 12:00, `2026-12-01T17:00Z` → 12:00); `unknown zone gives no time`; `null gives no time`.
- [x] **Step 2:** fails (no file).
- [x] **Step 3:** deferred import of `package:timezone/data/latest_10y.dart`, initialized once; `tz.getLocation` in a try, null on `LocationNotFoundException`.
- [x] **Step 4:** passes. Note the `latest_10y` data size in the PR's dependency justification.
- [x] **Step 5:** commit.

### Task 4: The card and its hover

**Files:**
- Create: `desktop/lib/super_tabs/identity_card.dart` (`SuperTabIdentityFacts`, `SuperTabPersonFacts`, `SuperTabAgentFacts`, `SuperTabIdentityCard`, `SuperTabHoverCard`)
- Test: `desktop/test/super_tab_identity_card_test.dart`, `desktop/test/super_tab_identity_card_shots_test.dart` (screenshots only with `SUPER_TAB_CARD_SHOTS`)

**Interfaces:**
- Produces: `SuperTabHoverCard({required Widget child, required SuperTabIdentityFacts Function() facts, FocusNode? focusNode})`, `SuperTabHoverCard.openDelay = Duration(milliseconds: 500)`, `closeDelay = Duration(milliseconds: 150)`; keys `super-identity-card`, `super-identity-card-name`, `super-identity-card-time`, `super-identity-card-task`.

- [x] **Step 1: Failing tests:** `a person's card shows name, status and local time`; `a person's card leaves out a time it does not know`; `an agent's card shows engine and model, machine and task`; `opens after the hover delay, not before`; `closes when the pointer leaves`; `stays open while the pointer crosses into the card`; `keyboard focus opens it and Escape closes it, focus kept`; `Tab reaches the task line and Enter opens the task`.
- [x] **Step 2:** fails.
- [x] **Step 3:** `OverlayPortal` + `CompositedTransformFollower` under the anchor, flipped above when there is no room below; `Timer`s for the delays; the card inside a `FocusTraversalGroup` so Tab follows the name.
- [x] **Step 4:** passes; `python3 ../scripts/check-ui-style.py` passes.
- [x] **Step 5:** commit.

### Task 5: Wire the card into the chat

**Files:**
- Modify: `desktop/lib/super_tabs/message_row.dart` (wrap avatar and name; drop the avatar's identity tooltip; person name focusable)
- Modify: `desktop/lib/super_tabs/view.dart` (build facts; open a task with `c.select`)
- Test: `desktop/test/super_tab_identity_card_view_test.dart`

**Interfaces:**
- Consumes: Tasks 2–4. Produces: `SuperTabMessageRow.identity` (`SuperTabIdentityFacts Function()?`).

- [x] **Step 1: Failing tests** on the `ConversationServer` fixture: `hovering a person's name shows their card with local time`; `hovering an agent's avatar shows its machine, model and task, and the task opens its chat`; `a grouped line has no card`; `no task line without a readable task`.
- [x] **Step 2:** fails.
- [x] **Step 3:** person facts from `_people` (`statusAt(now)`, `superTabTimeIn(person.timeZone, now)`); agent facts from `SuperTabAgentInfo(c, widget.app, agent)` (`engine`, `model`, `machine`, task line, `onOpenTask` selecting `taskGroup.id`).
- [x] **Step 4:** passes; `flutter test test/laid_out_list_test.dart` and `check-ui-style.py` pass; before/after screenshots, light and dark, into the PR.
- [x] **Step 5:** commit.
