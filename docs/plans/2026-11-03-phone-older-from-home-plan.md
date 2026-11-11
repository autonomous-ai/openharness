# Phone: Reopen an Archived Chat from Older — Implementation Plan

> **For agentic workers:** Follow this plan task by task in the current Harness session. Steps use checkbox syntax for tracking.

**Goal:** From Swarm Home C, a person can open a project's Older list and reopen an archived chat.

**Architecture:** Add a Work destination to the existing Home C project menu. It opens the existing project sheet on Work, whose Older list and conversation rows already provide the rest of the flow. A widget test exercises the route from Home through the reopened chat.

**Tech Stack:** Flutter, Dart, existing Swarm widgets and widget tests.

**Spec:** Task #2257, “Phone: reopen an archived chat from Older,” in the Swarm conversation.

## ASCII screen sketch

```text
Home C: #Mobile                         [⋮]
                                         ├ Status
                                         ├ Leaderboard
                                         ├ Work  ←
                                         └ Team

Mobile                              [×]
 [Work] [Team]
 Working on
 ...
 Older
 #23 Old chat
```

## Design

- Growth: N/A because no new data is stored; existing chat archives remain on the server.
- Concurrency: N/A because the change adds navigation only; the existing server command remains authoritative.
- Read cost: Use the existing on-demand Older read when the sheet opens.
- Scale: N/A because this introduces no collection or new query; the existing paged Older list is retained.
- Compatibility: Old and new clients keep the same data and archive commands; only the new client adds a menu route.
- Migration + rollback: N/A because there is no stored schema; removing the menu entry rolls back the change.
- Audience: The existing server enforces access to the project and archived chat.
- Identity: N/A because no identity field or authorization rule changes.
- Failure: Keep the existing Older loading and error states, and existing chat reopen refusal feedback.
- Platforms: Mobile app only (`mobile/`); no build is installed on a phone.

## Global Constraints

- Mobile only (`mobile/`), based on `main`.
- Use existing Swarm screens and design tokens; add no colors, icons, packages, or switches.
- Phone tests use fakes and never sign out a real account.
- Never install a build on anyone's phone.
- The pull request body starts with: `Requested by tony@autonomous.ai through Harness.`

## Review Focus

- Work must be reachable from the project menu on Home C, the route that currently hides it.
- Older must load on demand and expose an archived chat.
- Reopening must use the existing chat command and return the chat to active work.

---

### Task 1: Expose Older from Home C

**Files:**
- Modify: `mobile/lib/swarm/swarm_project_page.dart`
- Test: `mobile/test/swarm/swarm_home_test.dart`

**Interfaces:**
- Consumes: `SwarmProjectSheet(swarmId, projectId)` and its existing Work/Older/chat behavior.
- Produces: A `Work` entry in Home C's project menu that opens `SwarmProjectSheet` with the Work part selected.

- [ ] **Step 1: Write the failing Home-to-reopen widget test.** Seed an archived project conversation; open the project from Home, open its menu, choose Work, open Older, select the archived chat, and invoke its existing Reopen action. Assert the reopen command names that conversation with `archived: false`.
- [ ] **Step 2: Run the test against `main`.** Run `flutter test test/swarm/swarm_home_test.dart --plain-name 'Home opens Older and reopens an archived chat'`; expect it to fail because the Home C menu has no Work entry.
- [ ] **Step 3: Add Work to the Home C project menu.** Wire it to the existing project Work sheet, which loads Older as before.
- [ ] **Step 4: Run the focused widget test.** Expect the complete path and reopen command assertion to pass.
- [ ] **Step 5: Run the Swarm widget tests and capture the requested Home C and Older screenshots for the PR.**
- [ ] **Step 6: Commit the implementation after the failing-test commit.**

