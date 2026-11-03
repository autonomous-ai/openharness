# Phone: a task's Work details: Implementation Plan

> Way of working: this project's instructions. The Engineer implements it task by task, each failing test committed before its code. Reviewer: Orion. The Lead approves the sketch for Tony.

**Goal:** A person can open a task's Work details on the phone and read its goal, changes, constraints and each acceptance check with its evidence, as Desktop shows them.

**Architecture:** A read-only `SwarmWorkDetailsPage`, pushed from the chat's ⋮ sheet, the same place Desktop's chat menu has it. It reads only the conversation the phone's Swarm read already holds and rebuilds as that read changes. It sends nothing.

**Tech Stack:** Flutter, Dart, existing Swarm widgets and widget tests with fakes.

**Spec:** Task #2286; Desktop's `desktop/lib/super_tabs/work_details.dart`.

## Screen sketch

From the chat's existing ⋮ sheet, a new first row:

```text
Fix the login loop
────────────────────
Work details   ←
Rename
Archive
Notifications
  All            ✓
  Mentions
  Muted
```

The page, with the same top bar and text as the phone's Instructions page:

```text
←  Work details
   Fix the login loop
──────────────────────────────────
Goal:
People signed out on a phone get
sent back to sign-in in a loop.

Changes:
Keep the session through the
redirect.

Constraints:
No new dependency.

#14 Review PR 12: passed

Builder · review

ACCEPTANCE CHECKS

The new test fails on main and
passes
Failed at abc123, passes at def456.
Verified

Tried on a real phone
Not verified

RESULT
PR 12 at def456.
```

With no brief, the page says `This task has no description yet.`, as Desktop does. Sections with nothing in them don't show.

## Global Constraints

- Mobile only (`mobile/`). Same sections and words as Desktop, without its Record check button: this view is read-only.
- No new colors or icons. Follows the phone's Swarm screens.
- Phone tests use fakes. Never install a build on anyone's phone. No on/off switch.
- PR body starts: `Requested by tony@autonomous.ai through Harness.`

## Review Focus

- The row shows where Desktop's does: never in a project's own chat, a Buddy chat or a private conversation.
- The page goes once the chat can no longer be read: access lost, signed out or the chat gone.
- A check's fields are read from the server's row: one with no evidence, or an unknown assignment agent, must not throw.

## Design

- **Growth:** N/A because nothing is stored.
- **Concurrency:** N/A because it only reads the snapshot on the UI thread.
- **Read cost:** no new request: it reads what the Swarm read holds.
- **Scale (10x):** N/A because it shows one task; a long brief scrolls.
- **Compatibility:** N/A because it uses fields the phone already parses. An older server's missing field shows as an empty section.
- **Migration + rollback:** none.
- **Audience:** the server sends a chat only to those who may read it; the page goes when that ends.
- **Identity:** N/A because it names the assignee as the read does, never the machine owner.
- **Failure:** nothing to fail after the read; a chat gone closes the page.
- **Platforms:** the phone app, iOS and Android.

---

### Task 1: The page, and its row in the ⋮ sheet

**Files:**
- Create: `mobile/lib/swarm/swarm_work_details_page.dart`, `mobile/test/swarm/swarm_work_details_page_test.dart`, `mobile/test/swarm/swarm_work_details_shots_test.dart`
- Modify: `mobile/lib/swarm/swarm_chat_menu.dart`, `mobile/lib/swarm/swarm_chat_manage.dart`

**Interfaces:**
- Produces: `swarmHasWorkDetails(SwarmReader, String chatId)`; `openSwarmWorkDetails(BuildContext, {reader, chatId})`.
- Consumes: `SuperTabConversation.brief/checks/assignment`, `superTabLinkedLine`, `superTabWorkStatusLabel`, `swarmTextParts`.

- [ ] **Step 1: Commit failing tests:** the page shows goal, changes, constraints, linked line, assignee and status, each check with its evidence and Verified or Not verified, and the result; no brief says so; no write controls; it goes when the chat does; the row shows only where Desktop's does and opens the page.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Commit the code.**
- [ ] **Step 4: Screenshots** on a 390-point phone in both themes from made-up data, in the PR.
