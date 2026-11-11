# A person sets the name the Swarm shows for them: implementation plan

> Worked by this project's instructions (Engineer role): this plan is the pull request's first commit. Then each task is
> done test first, by one Engineer, with one Review step and one Test step on the pull request. Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** a person can set and change their own display name (for example "Minh Nguyen") on Desktop, web and phone.
People rows, chat authors, reactions, the inbox and tags show it. Until they set one, everything shows their username,
which defaults to the email's first part, as today. Only they can change it, and it can never equal another member's
name, username or email.

**Architecture:** the name is one optional field on the person's member record (`Person.name`), set by a new
`member.name` command beside `member.username` (backend/src/superTabs/personNames.ts). The username stays the handle a
tag types (`@wkpnjjhbnm`); the display name is what the Swarm shows. Readers already receive the whole member record,
so `name` reaches clients with no read change. Each client gets one rule, `shownName = name ?? username`, and every place
that shows a person (not one that types a tag) uses it.

**Tech Stack:** TypeScript backend (vitest unit tests, `npm run test:super-tabs` integration), Flutter 3.47.2 Desktop
(also built for the web) and phone app (`flutter_test` widget tests and headless screenshots).

**Spec:** task #2446 brief (River, 2026-11-03) and the mockup posted for the requester in the task chat
(2026-11-03 17:41 VN):

```
People list (left: today, right: after)
  People                 +      People                 +
   (W) wkpnjjhbnm   12 pts       (M) Minh Nguyen  12 pts
Hover on a person: Minh Nguyen · @wkpnjjhbnm · the email, as today
Chat author: (M) Minh Nguyen  10:42
Typing "@mi" suggests:  (M) Minh Nguyen  @wkpnjjhbnm
A tag in a message reads "@Minh Nguyen"; it still tags by @wkpnjjhbnm.
Your profile: Name [ Minh Nguyen ] [Save] above Username [ wkpnjjhbnm ] [Save]
```

## Global Constraints

- PR body first line: "Requested by wkpnjjhbnm@privaterelay.appleid.com through Harness."
- Visible parts wait for the requester's confirmation of the mockup; backend and model work goes first.
- Harness design language (desktop/design/desktop-design-system.md): design-system roles only, no hardcoded colors or
  sizes; `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs` before Ready.
- Swarm code stays out of cli/src/core. Desktop tests use a memory store and a fake sign-in, never the real CLI.
- Before Ready: a failing-first test for every risk below, red/green evidence in a PR comment, the full Super Tab
  integration suite (`cd backend && npm run test:super-tabs`), and screenshots light and dark.

## Design

- Growth: one string of at most 40 characters per member; it is deleted with the member record (leaving the Swarm) or
  by clearing it.
- Concurrency: `member.name` claims a name against every member's name, username and email, so it touches every member
  part and the head, exactly as `member.username` does (parts/touches.ts). Of two people choosing the same name at once,
  one retries and is refused. `member.username` also checks display names, under the same touches.
- Read cost: none added. The name is inside the member part every reader already loads; `changes` sends it only when
  that member part changed.
- Scale: the check is one pass over members (tens per Swarm); at 10x it is still a few hundred string compares per
  set. The first warning would be command latency on `member.name`, the same as `member.username` today.
- Compatibility: an older client ignores `name` and shows the username, as today. A newer client against an older
  server gets the server's refusal of an unknown command, shown under the field. The phone and Desktop show the name
  wherever the server sends it.
- Migration + rollback: none. The field is optional; a rollback leaves it stored and unread, and the username shows
  again. No new collection, index or query: the MongoDB schema-design and query-optimizer questions (embed vs.
  reference, index use) are answered by "embedded in the existing member document, read with it".
- Audience: the server enforces it. The command changes only the actor's own record (`actor.userId`); agents are
  refused (HUMAN_REQUIRED). Only Swarm members read it, as with username and status.
- Identity: the actor's own person record in this Swarm; never the machine owner's login.
- Failure: every refusal (empty, too long, unprintable, taken) returns a code and a sentence, shown under the field;
  nothing is silently dropped.
- Platforms: backend; Desktop on macOS and the web build; phone app on iOS and Android (shared Dart).

## Review Focus

1. Impersonation: a name that equals another member's name, username or email, ignoring case, width variants
   (NFKC), spaces and a leading `@`, is refused; so is an agent name the person can see. A username equal to another
   member's display name is refused too (Task 1 tests).
2. Only the person changes it: an agent, or another person, cannot set someone's name (Task 1 tests).
3. Hidden characters: control, format (bidi, zero-width) and line separators are refused, as in a status (Task 1).
4. Concurrency: two people choosing one name at once, one wins (Task 2 integration test through the real store).
5. Tags still work: a tag in text stays `@username` and still notifies; only its pill label changes (Tasks 4, 6).
6. With no name set, every surface reads exactly as today (each client task has a no-name test).
7. Review 1: role and Swarm names (PM, Lead, Reviewer, Tester, Harness, System, Admin, Everyone, You, Someone) are
   refused; a later joiner's default username is numbered around display names; a name written into server text
   (member rows, task lines, the PM-switch note) is Markdown-escaped. Out of scope, as for Buddy names: look-alike
   letters of other scripts (NFKC does not fold them), and Buddy names against display names (a Minor of review 1).

---

### Task 1: name rules and the `member.name` command (backend)

**Files:**
- Create: `backend/src/superTabs/personNames.ts`, `backend/src/superTabs/personNames.test.ts`
- Modify: `backend/src/superTabs/model.ts` (`Person.name`), `backend/src/superTabs/commands.ts` (schema, dispatch,
  viewer allowed as for `member.username`), `backend/src/superTabs/usernames.ts` (refuse another's display name),
  `backend/src/superTabs/parts/touches.ts`

**Interfaces:**
- `MAX_NAME_LENGTH = 40`; `setName(state, actor, input: string | null): void`; `shownNameOf(state, id): string | undefined`
  (name, else username); `nameKey(text): string` (NFKC, lowercased, spaces and a leading `@` removed).

- [ ] Write failing tests: sets and clears own name; trims and collapses spaces; refuses empty, over 40, hidden
  characters; refuses another member's name, username, email (case, width, spaces, `@`); refuses a visible agent name;
  allows one's own username; refuses an agent actor; a viewer may set theirs; a username equal to another's name is
  refused; touches cover every member and the head.
- [ ] Run `npm test -- src/superTabs/personNames.test.ts`, watch them fail; commit.
- [ ] Implement; run again, green; commit.

### Task 2: through the real store (backend integration)

**Files:**
- Modify: `backend/integration/superTabProfile.test.ts`

- [ ] Failing tests: a name set by one member reaches another member's first load and changes, and no outsider; two
  people choosing one name at once, one is refused (NAME_TAKEN); the name survives a reload (parts round trip).
- [ ] Run `npx vitest run -c vitest.super-tabs.config.ts integration/superTabProfile.test.ts`, red then green; commit.

### Task 3: server-written names (backend)

**Files:**
- Modify: `backend/src/superTabs/mentions.ts` (inbox author), `activity.ts` (actor name), `memberRows.ts`
  (`actorLabel`), `commands.ts` (decision line "who"), `taskLine.ts`; tests beside each.

- [ ] Failing tests: each shows the display name when set and the username when not; tags (`@name` in
  reviewCapacity) keep the username.
- [ ] Red, then switch each to `shownNameOf`; green; commit.

### Task 4: Desktop and web: the model and every place a person shows

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabPerson.name`, `shownName`, author name), `identity.dart`
  (avatar initial), `leaderboard/person_row.dart`, `roster.dart` (card title, hover), `view.dart` (reactions, tag
  labels), `message_text.dart` (a tag's pill reads its label), `composer_tags.dart` (suggestion shows the name, matches
  name or username, inserts the username), `activity.dart`, `notifications.dart`, `manage_page.dart`
- Test: `desktop/test/super_tab_display_name_test.dart`

- [ ] Failing widget tests: with a name, the People row, card, chat author, reaction tooltip, tag pill, suggestion and
  inbox show it, and the inserted tag is `@username`; with none, each reads as today.
- [ ] Red, implement, green; commit.

### Task 5: Desktop and web: setting it in Your profile

**Files:**
- Create: `desktop/lib/super_tabs/name_editor.dart`
- Modify: `desktop/lib/super_tabs/profile_actions.dart` (`setName`), `profile_sheet.dart`
- Test: `desktop/test/super_tab_profile_sheet_test.dart`, screenshots in `super_tab_humans_shots_test.dart`

- [ ] Failing tests: Name field above Username, saves trimmed, clears to the username, shows the server's refusal.
- [ ] Red, implement, green; screenshots light and dark of the profile, People list and a chat; commit.

### Task 6: phone app

**Files:**
- Modify: `mobile/lib/swarm/model.dart`, `swarm_conversation_page.dart` (author, suggestions), `swarm_message_row.dart`
  (tag pill label), `swarm_thread_line.dart`, `swarm_you_page.dart` (Name row with Change), `swarm_profile.dart`
  (`setName`); create `swarm_name_editor.dart`
- Test: `mobile/test/swarm/swarm_display_name_test.dart`, screenshots light and dark

- [ ] Failing tests as in Tasks 4 and 5 for the phone; red, implement, green; commit.
