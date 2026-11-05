# Swarm on the phone: a Slack-style UI/UX tune

- Date: 2026-11-03
- Scope: the phone app only (`mobile/`). Desktop and the backend do not change.
- Base: `feat/mobile-ios-android` @ `90d2ce56d`
- Reference: [Re-designing Slack on Mobile](https://slack.design/articles/re-designing-slack-on-mobile/) (Siddhant Mehta, Slack)
- Prototype: [2026-11-03-swarm-slack-redesign/prototype.html](2026-11-03-swarm-slack-redesign/prototype.html). Open it in a browser. Each phone is clickable. Tabs: Current · A · B · C · Compare.
- Status: **direction A is implemented**. Tony approved it on 2026-11-03, answers in section 7. Where the build differs from the prototype, the decision says so under **Built**.

## 1. Goal

Make the Swarm part of the phone app as simple to read as Slack. Within 3 seconds of opening the app, a person should see **what needs me** and **where there is something new**, then deal with it in the same session.

Slack reports that people open its mobile apps 15–20 times a day, for 20–30 seconds each time. It does not try to increase screen time. It tries to increase what gets done in each session. Harness has the same pattern: the phone is for catching up, approving and replying, and heavy work happens on the desktop.

## 2. What the article says, mapped to Harness

| Slack idea | Harness before | What shipped (A) |
|---|---|---|
| Five tabs cut to three, still labelled (label-less tabs hurt accessibility and comprehension) | Four labelled tabs: Home · Buddy · Activity · You | Three labelled tabs: Home · Buddy · Activity. You moves to an avatar |
| A bar of tiles for unreads and secondary surfaces | Two large cards: While you were away, Threads | One tile bar: While you were away · Threads · Agents |
| Filters in each tab, as a bottom sheet on Android, not an overflow menu | Home has a Sort and filter sheet | The same sheet, now also holding Mark all read and Refresh |
| Pull down to open search, swipe sideways to change kind | No search in Swarm. Find lives only in the terminal | A Search button on Home's top bar. Chips or a sideways swipe change the kind. Pulling down on Home refreshes it (D5, updated 2026-11-05) |
| One feed for threads, mentions, alerts, invitations | What needs you is in 6 places. Invitations sit on Home | Activity opens on All. Invitations head All and Needs you and count on the tab's badge |
| The header shrinks as you scroll | Fixed header | Built, then dropped with the Search field (D10) |
| Less-used surfaces move to familiar places | Harness is reachable only through 4 "Open terminal" menu items | An Agents tile, and Agents in Search |
| Huddles, Canvases, Lists, Later, Drafts & Sent | Not Harness features | Not applied |

## 3. The five problems this fixes

Paths are relative to `mobile/lib/`.

1. **Two cards took about a third of the screen before the first project** (`SwarmAwayCard`, `SwarmThreadsRow`). An iPhone 16 showed 6 projects.
2. **Each project row had two lines, and the second was the same everywhere.** All 7 of 7 rows said "7 humans".
3. **Almost every row had the unread dot**, so the dot said nothing. Agents post all the time.
4. **What needs you was spread over 6 places:** the Home card, Activity, the Work, Team and Status sheets, and the Buddy chat. Invitations sat on Home.
5. **Several things were hard to reach.** There was no search in Swarm. Harness was behind 4 "Open terminal" menu items. You took a whole tab. Invite was buried in ⋮ › Leaderboard. Switching Swarm from Buddy was buried in ⋮ › Swarm.

**Biggest issue:** everything on Home had the same visual weight, so nothing told the eye where to look first.

## 4. Directions

| | A · Slack trio (**chosen**) | B · Inbox | C · Light tune |
|---|---|---|---|
| Idea | Arrange Swarm as Slack does: tiles, one-line rows, Search, one Activity feed | Merge Home and Activity into one urgency-sorted inbox | Keep the structure, fix density only |
| Tabs | Home · Buddy · Activity, You on the avatar | Inbox · Projects · Buddy | Home · Buddy · Activity · You |
| Strongest point | Fixes all five problems with little to learn | Approve is one tap from opening the app | Lowest risk |
| Cost | You is one tap further. Two earlier decisions are reversed | Far from Slack. The list reorders under your finger. The most work | Four tabs stay, Harness stays hidden |

**Why not B.** Slack keeps places (Home) apart from work (Activity). Merging them gives a list that grows with every task and keeps reordering itself.

**Why not C.** C fixes how things look, not how they are arranged.

## 5. Decisions

Each decision lists what was chosen, the alternatives, the reasoning, the cost, and what was built.

### D1. Three labelled tabs: Home · Buddy · Activity

- **Alternatives:** keep four tabs with You; Inbox · Projects · Buddy (B); five tabs with Search and Harness; icon-only tabs.
- **Why:** Slack found three jobs on mobile: catch up, respond, delegate. Home is for catching up on places, Buddy for delegating (the person's 1:1 chat with their own agent, the role Slack's DMs tab plays), Activity for responding. You is used rarely and does not need a quarter of the bar. Three tabs are about 131pt wide instead of 98pt.
- **Cost:** reaching You takes one more tap. This reverses the You tab from prototype C1 (2026-10-30).
- **Built:** `SwarmTab` is `home · buddy · activity` (`swarm/swarm_tabs.dart`). `showSwarmTab(context, tab, activity:)` switches tabs and can ask Activity for a filter.

### D2. You moves to an avatar at the top right of Home and Activity

- **Alternatives:** keep the You tab; a drawer; fold You into Settings; the avatar on the left.
- **Why:** an avatar at the top right is widely understood, and it carries the status dot. Drawers are hard to discover, and the app already removed one. The left holds the Swarm name, Slack's workspace position, so "who am I" stays apart from "where am I".
- **Cost:** the Buddy chat header has no room for it, so from Buddy you go back to Home first.
- **Built:** `SwarmYouButton` is a 30pt avatar in a 44pt target, heard as "You" or "You, <status>". It pushes `SwarmYouPage` with a back button and the title You. The page's content does not change. A You opened this way goes with the tabs: when Swarm is turned off from its own Settings, back from Settings is the terminal, as it was from the You tab, not a You with no Swarm under it.

### D3. A tile bar replaces the two cards at the top of Home

- **Tiles:** While you were away (34 done · 4 need you) · Threads · Agents (1 working).
- **Alternatives:** keep both cards; a one-line summary; move everything into Activity.
- **Why:** Slack landed on "a simple bar of tiles that optimized for unread conversations while giving quick access to these surfaces". While you were away stays because Tony decided on 2026-11-02 (`c09849c64`) that it always shows. The bar scrolls sideways, so tiles can be added later.
- **Cost:** on a narrow phone the last tile is only partly visible, so the most important tile comes first.
- **Built** (`swarm/swarm_home_tiles.dart`):
  - While you were away is 214pt wide, the others 104pt. All are as tall as each other and at least 44pt.
  - While you were away opens Activity on Needs you.
  - Threads opens the Threads page for the Swarm shown. The prototype had it open Activity › Threads, but the Threads page already scopes to one Swarm and keeps its read marks, so the build kept it.
  - Agents opens the agents list (D7). It shows only when the app's computers can list agents.
  - A figure not known yet is a skeleton, heard as "not known how many". Each tile is one button for a screen reader.

### D4. Project rows become one line

- **Layout:** a 44pt row: `#name  [Swarm] … [tags]`. A bold name means there is something new.
- **Alternatives:** keep two lines with time and an unread dot; a last-message preview; drop the state dot.
- **Why:** the second line repeated on every row, and times like "now / now / 1m" did not help anyone decide. Slack signals two levels, bold for new and a badge for mentions. The prototype kept a state dot (working, waiting, down); the build dropped it (below).
- **Cost:** the people count and the time leave the row. The list is still sorted by latest activity.
- **Built:** `SwarmHomeProjectRow` (`swarm/swarm_home_rows.dart`). With several Swarms, the Swarm's name follows the #name in faint ink. Rows stay inside the grouped card the app already uses.
- **No state dot** (Tony, 2026-11-03): an idle team's grey dot sat on nearly every row and said nothing, so the dot went first for idle teams and then altogether. A tag or decision waiting on the person still makes the name bold and adds `@N`; who works, waits or is down is on the project's page, in Activity and on the Agents tile. Home no longer counts a team per row, and its loading rows draw the name's bar alone.
- **Phase 2:** the unread rule. Agents post constantly, so almost every row ends up bold. The proposal is that only people's messages, tags of the person and items that need them make a row bold. That has to change together with desktop `_hasUnread`.

### D5. Search from the top bar; pull down to refresh Home

- **Alternatives:** a Search tab (old Slack); a magnifier only; the pull only (new Slack); the terminal's Find.
- **Why:** Slack removed the overlap between "Jump to" and a Search tab. Swarm had no search at all. A visible Search button makes it easy to find without taking space from Home's list. People expect a pull down on Home to refresh it.
- **Cost:** Search takes a tap on the top bar; it has no pull shortcut. Refresh is available both by pulling and in Sort and filter (D9).
- **Changed after review** (Tony, 2026-11-03): the field under the top bar is gone. Search is a magnifier on the top bar, before the avatar, where Sort and filter was; it opens the same Search page.
- **Updated** (Tony, 2026-11-05, [#3176](https://github.com/autonomous-ai/openharness/pull/3176)): pulling down refreshes Home again. The earlier pull-to-search behavior looked like a broken refresh, so it was removed.
- **Built** (`swarm/swarm_page.dart`, `swarm/swarm_search_page.dart`):
  - Chips: **Recent · Projects · Chats · Agents**. People are left out: a person has no page of their own in Swarm yet. Agents shows only when the app's computers can list them.
  - Recent lists what moved last, at most 12. While something is typed, the Recent chip reads All and lists every kind.
  - Matching ignores case and accents, as New message's To: does (`swarmSearchFold`). Ranking: the title starts with the text (a leading # is optional), then a word in it does, then the title holds it, then its Swarm or computer does. The prototype said to reuse Find's ranking, but Find ranks machines and agents for the terminal, and the To: field is the matching people already know in Swarm.
  - Projects are those the person reads; a private project someone else owns stays out unless they are on it. Chats are the person's own Buddy chats, never another person's or an archived one.
  - A row opens its project, chat or agent over Search, and back returns to Search as it was left.
  - While the Swarms are read it shows a skeleton, never "nothing". A Swarm that could not be read is said above what the others have.
  - Pulling down at the top of Home shows the refresh indicator and reads the Swarms again, on Android and iOS. With no computer answering, it rechecks the computers first; a failed recheck is logged and the Swarms are still read. This uses the same refresh path as Sort and filter, including when Home is pushed over another page, and opens no Search page.
  - The chips scroll sideways on a narrow phone, as Activity's pills do. A chip opened by a swipe of the pages scrolls into sight.
  - A drag on the results puts the keyboard away, a short list included.
- **Phase 2:** searching message content needs a backend API.

### D6. One Activity feed

- **Chips:** All · Needs you · Mentions · Threads · Reactions.
- **Alternatives:** keep Invitations on Home; put Needs you on Home (B); one list with no chips; an Invitations chip.
- **Why:** Slack calls Activity a "one-stop shop" that "minimizes pogo-sticking". A word is clearer than "@", and a screen reader can say it.
- **Built** (`swarm/swarm_activity.dart`, `swarm/swarm_activity_page.dart`):
  - The Activity tab opens on All. A pushed Activity page (from a project) still opens on Needs you.
  - All (`swarmActivityAll`) lists what still needs the person first, as Needs you does. Then tags, replies and reactions, newest first, those with no time last. Then the needs already handled. Each row appears once.
  - Invitations to other Swarms head All and Needs you, the tab's only; a pushed Activity page and Home list none. They wait on the person's answer, so they count in both chips and on the Activity tab's badge (`swarmActivityTabBadge`): with Home's top gone, the badge is how the person learns one came. Needs you does not say "Nothing needs you." while one shows. With nothing anywhere, All says "You're all caught up."
  - No Invitations chip (Tony, 2026-11-03): it would show 0 almost always, push Mentions further off a narrow phone, and an invitation is something that needs the person, which is what Needs you is for.
  - Home's "While you were away · N need you" does not count invitations: it covers the Swarms Home shows.
  - "@" is renamed "Mentions" **on the phone only**. Desktop keeps "@" (Tony, 2026-11-03).

### D7. A way into Harness from Swarm

- **Flow:** Agents tile, or Search › Agents → the agents list → terminal. The terminal does not change.
- **Alternatives:** only "Open terminal" in four menus; a fourth Harness tab; a drawer.
- **Why:** running agents is the core job of Harness, and Swarm had no way to its list. A fourth tab would bring the four-tab bar back.
- **Built:** `SwarmAgents` (`swarm/swarm_agents.dart`) is what Swarm reads; the app's `AppSwarmAgents` (`swarm/swarm_computers.dart`) serves it from the agent index. It tells its listeners only when how many agents work or wait, or the agent list itself, changes, never at every terminal frame. It is a notifier of its own, so a change of agents never reads the Swarms again the way a computer coming up does. The list opens `AgentsListPage` pushed over Swarm, and an agent opens as it does anywhere else.

### D8. A tap on the project's #name opens its details

- **Sheet:** #name over who is on it. Quick actions: Notifications · Invite · Open terminal. Rows: Status · Work · Team (with who is on it) · Leaderboard.
- **Alternatives:** only today's ⋮ dropdown with six items; project tabs Chat / Tasks / Team (tried and dropped).
- **Why:** in Slack a channel's name opens its details. The sheet separates actions from information, and makes Invite visible.
- **Built** (`swarm/swarm_project_details.dart`, `swarm/swarm_project_page.dart`):
  - The #name in the header is one button, at least 44pt tall, heard as "#name, project details".
  - Invite is for the Swarm's owner alone. Open terminal follows the ⋮ menu's rule: never for a viewer, and greyed with why (Stopped, Offline, Not linked) when it cannot open.
  - A tap closes the sheet, then opens what the ⋮ row opens. Open terminal opens at once.
  - The sheet closes when access is lost, on sign-out, or when the project leaves the Swarm, as the menu's sheets do.
  - The ⋮ menu stays as it was, so nothing people know moves.

### D9. Filters stay one button and one bottom sheet

- **Change:** Mark all read and Refresh move into Sort and filter.
- **Alternatives:** filter chips across Home; an overflow menu; Mark all read in the header.
- **Why:** the app already has the sheet (`swarm/swarm_home_view_sheet.dart`), and the header drops to two controls, which suits Dee's preference for a minimal UI.
- **Where:** at the right of the projects' first caption (Projects, or Pinned when a project is pinned), not on the top bar (Tony, 2026-11-03): it sorts and filters the projects, so it sits over them, and the top bar keeps Search and the avatar. A Home pushed over another page has none, as before.
- **Cost:** Mark all read is one tap further. Its Undo toast stays.
- **Built:** both close the sheet, then act. Mark all read is greyed when nothing is unread. Refresh does what the pull does (recheck the computers when none answers, then read every Swarm) and says "Refreshing…".

### D10. The header folds on scroll

- **Dropped** (Tony, 2026-11-03): it folded the Search field, which is gone (D5). The top bar stays fixed.

### D11. Buddy stays a tab, and a tap on its title switches Swarm

- **Why:** Home switches Swarm by its title, so Buddy works the same way. Swarm has no person-to-person DMs yet, so a DMs tab would be misnamed.
- **Built:** with several Swarms, the Buddy tab's title is a button heard as "<title>. Switch Swarm" that opens the same switcher as ⋮ › Swarm. With one Swarm it is plain text.

### D12. What stays as it is

The New message button (2026-10-30), the composer (approved 2026-11-01), labelled tabs, the Graphite palette and tokens, haptics, and the terminal, untouched.

## 6. Not applied

- **Huddles, Canvases, Lists, Later, Drafts & Sent:** Harness has no such features.
- **A theme per Swarm:** the app has palettes, and nobody asked.
- **Sales Elevate, external-connection and Enterprise Grid filters:** the All Swarms switcher covers the need.

## 7. Decisions taken (Tony, 2026-11-03)

1. Direction A.
2. Drop the You tab and the Threads row on Home: yes.
3. The initial pull-to-search choice was superseded on 2026-11-05: a pull refreshes Home, Search stays on the top bar, and Refresh stays in the filter sheet (D5).
4. "@" becomes "Mentions" on the phone only. Desktop does not change.
5. Built in a worktree from `feat/mobile-ios-android`, with this spec and the prototype in the same commit.

## 8. Where it is in the code

All under `mobile/lib/swarm/`.

- **New:** `swarm_agents.dart`, `swarm_home_tiles.dart`, `swarm_search_page.dart`, `swarm_project_details.dart`.
- **Changed:** `swarm_tabs.dart`, `swarm_you_page.dart`, `swarm_page.dart`, `swarm_home_rows.dart`, `swarm_home_top.dart`, `swarm_home_view_sheet.dart`, `swarm_activity.dart`, `swarm_activity_page.dart`, `swarm_computers.dart`, `swarm_project_page.dart`, `swarm_conversation_page.dart`, `swarm_style.dart`, `swarm_threads_page.dart`.
- **Removed:** `SwarmAwayCard` and `SwarmThreadsRow`, replaced by tiles, and the You tab.
- **Removed on 2026-11-05:** `swarm_home_search.dart` and its pull-to-search widget; Home uses `RefreshIndicator` instead.

## 9. Tests

Widget and unit tests under `mobile/test/swarm/`. Run with `cd mobile && flutter test`, as CI does. `integration_test` is not part of it.

- **Tabs** (`swarm_tabs_test.dart`, `phone/phone_shell_swarm_home_test.dart`): three labelled tabs, the avatar opening You with back, You going with the tabs when Swarm is turned off, While you were away opening Activity on Needs you, a repeated ask applied again.
- **Tiles** (`swarm_home_tiles_test.dart`): figures, skeletons and what a screen reader hears; the row's order, sizes and sideways scroll.
- **Project rows** (`swarm_home_project_row_test.dart`, `swarm_home_test.dart`): one line, bold when new, the Swarm's name with several, no people line.
- **Search** (`swarm_search_page_test.dart`): the ways in; each kind and what it leaves out; ranking, case and accents; chips, swipes and the chip following; opening a row and coming back; agents; reading and failure; the keyboard inset (the page ends at the keyboard, once) and a drag putting the keyboard away. Home has no field; the top bar's Search opens the page, while a pull refreshes Home without opening Search. The page's field takes none of the app's field outline or fill, focused or not, in light and dark.
- **Pull to refresh** (`swarm_home_instant_test.dart`): Android and iOS pulls recheck computers before reading the Swarms when none answers; failed rechecks are logged and the Swarms still read; with computers answering, the pull only reads the Swarms.
- **Activity** (`swarm_activity_test.dart`, `swarm_activity_page_test.dart`, `swarm_activity_feed_page_test.dart`, `swarm_invitations_in_swarm_test.dart`): All's order, Mentions, Invitations in All and Needs you with their counts, the tab badge counting them and dropping one put off.
- **Filter sheet** (`swarm_home_view_test.dart`, `swarm_mark_all_test.dart`, `swarm_home_instant_test.dart`): Mark all read and Refresh in the sheet.
- **Project details** (`swarm_project_details_test.dart`): the header button, every item and its order, Invite for the owner alone, Open terminal and its greyed states, each row's sheet, and the sheet closing with access, sign-out or the project.
- **Agents** (`swarm_computers_test.dart`): what is listed, and when it tells.
- **Buddy title** (`swarm_buddy_tab_test.dart`): the switcher with several Swarms, none with one.

## 10. Design (AGENTS.md)

This change stores no new data and adds no server call. Search reads only what the session already holds.

- **Growth:** N/A, nothing is stored. Recent is worked out from what moved last.
- **Concurrency:** N/A, no writes.
- **Read cost:** Search builds its catalog from the reads Swarm already holds, when they change. The agents notifier counts the agent index the app already keeps, which is memoized.
- **Scale:** at 10× projects or chats the results stay lazy lists, and Recent is capped at 12. The first metric to warn is Search's build time on a change.
- **Compatibility:** no server change, so old and new clients work side by side. Desktop is unchanged.
- **Migration and rollback:** none needed. Existing preference keys stay. Roll back by reverting the commit.
- **Audience:** Search lists only what the person already reads; private projects follow New message's rule.
- **Identity:** N/A.
- **Failure:** a Swarm that cannot be read is said, never shown as "nothing matches".
- **Platforms:** iOS and Android share the sheets; the pull is tested on both scroll physics.

## 11. Next

- The unread rule (D4), with desktop.
- Searching message content (D5), with the backend.
