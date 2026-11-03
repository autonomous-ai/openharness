# Phone: special message rows drawn as Desktop draws them Implementation Plan

> **Way of working:** by this project's instructions (Engineer role), not subagent-driven-development: each failing test committed before its code, the branch pushed after each task, one independent review of the pull request. There is no Execution Handoff.

**Goal:** 'Routed to', terminal input and alerts, proposals, Excerpt and 'Response interrupted' stop looking like ordinary messages on the phone, and each reads as it does on Desktop.

**Architecture:** `SwarmMessageRow` already hands task lines and ship rows to their own widgets. It does the same for three more kinds, in a new `swarm_special_rows.dart`, and adds Desktop's small lines to an ordinary row. The words and rules are Desktop's (`route_row.dart`, `terminal_row.dart`, `task_line.dart`, `message_row.dart`, `view.dart`).

**Tech Stack:** Flutter widgets and `flutter_test`, in `mobile/`.

**Spec:** Task #2284 (Tony).

## Global Constraints

- The PR body starts with: Requested by tony@autonomous.ai through Harness.
- Mobile only. No new colors or icons beyond the phone's existing set. Phone tests use fakes. Never install on a phone. No on/off switch.

## Sketch

```
 Routed to River                Details          no avatar, no name, quiet
   (Details open) the pick, why, how it was chosen, who else was considered

 ⌨ River typed `2` + Enter into Nico's terminal   quiet, what was typed in mono
 ⚠ Nico is waiting at a prompt                    quiet, the mark in warning colour
 ⚠ River hit its usage limit  until 18:00

 › Proposal from diego: Activity read fix         one line; a tap opens its thread

 In that thread, the proposal reads whole:
 ◉ Buddy  8:02
   [Proposal · on diego's behalf]
   Goal: Activity read fix …

 ◉ Nico  8:12
   Terminal answer                                quiet line above a terminal's answer
   The build passed.

 ◉ Nico  8:12
   The build passed…
   Excerpt · open the terminal for the full response    quiet line under it
   Response interrupted                                 (or this one)
```

## Review Focus

- A route row from an older server with no decision id, or a pick that isn't well formed, is an ordinary message, as on Desktop.
- Route details that fail to load say so and offer Retry.
- What was typed containing backticks shows whole: only the first and last are the wrapper.
- A proposal's owner who left the Swarm reads "its owner".
- None of these rows groups with the message before it, and a terminal answer groups only with one of the same note.

Not in this task: Desktop's Switch PM… on a PM's limit note. The phone has no Switch PM screen, so the note says the limit and its time alone.

## Design

- **Growth, concurrency, migration, audience, identity:** N/A because this only draws what the reader already reads; route details use the checked read Desktop uses.
- **Read cost:** route details read only when opened, once.
- **Scale:** N/A because the rows are built as today's are.
- **Compatibility:** a kind the phone doesn't know stays an ordinary message.
- **Failure:** a failed details read says so, with Retry.
- **Platforms:** iOS and Android share these rows.

---

### Task 1: The rows

**Files:**
- Create: `mobile/lib/swarm/swarm_special_rows.dart`
- Modify: `mobile/lib/swarm/swarm_message_row.dart`, `mobile/lib/swarm/swarm_conversation_page.dart`
- Test: `mobile/test/swarm/swarm_special_rows_test.dart`

- [ ] **Step 1: Write the failing tests,** one per kind: route, terminal input, terminal alert, proposal, proposal in its thread, terminal answer, Excerpt, Response interrupted; and the Review Focus lines above.
- [ ] **Step 2: Run to verify they fail.** Run: `flutter test test/swarm/swarm_special_rows_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass,** then `flutter test test/swarm`.
- [ ] **Step 5: Commit** the test first, then the code; push. Add screenshots to the PR.
