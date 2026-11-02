# Phone: remove a note in a project's Instructions Implementation Plan

> **Way of working:** by this project's instructions (Engineer role), not subagent-driven-development: the failing test committed before its code, one independent review of the pull request. There is no Execution Handoff.

**Goal:** A person who may remove one of the PM's notes can do it on the phone, under the rule Desktop uses.

**Architecture:** The phone's Instructions page gets a Remove action on each note for a person who can write in the Swarm. It asks first, sends `note.remove`, and reads the notes again. The server keeps the rule and tells the PM.

**Tech Stack:** Flutter widgets and `flutter_test`, in `mobile/`.

**Spec:** Task #2277 (Tony). Desktop's `desktop/lib/super_tabs/instructions_panel.dart` `_removeNote`.

## Global Constraints

- The PR body starts with: Requested by tony@autonomous.ai through Harness.
- Mobile only. No new colors or icons. Phone tests use fakes. Never install on a phone. No on/off switch.

## Sketch

```
 ‹ Instructions
   #openharness · revision 12

   …the instructions…

   River's notes
   Do not use Codex on machine A.
   asked by dee · 2h ago                Remove
   Ship the phone first.
   asked by tony · 1d ago · until 18:00 Remove

        ┌───────────────────────────────┐
        │ Remove this note?             │
        │ River is told it was removed. │
        │            Cancel    Remove   │
        └───────────────────────────────┘
```

Nothing shows for a viewer. While a remove is under way its button is off, and a refusal says why above the text, where this page says errors.

## Review Focus

- Pressed twice: one `note.remove`.
- Refused or offline: the note stays, and the page says why.
- A note already gone (another device, or expired): the server's refusal shows and the next read drops it.
- A person who becomes a viewer while the page is open loses Remove.
- Remove sits inside the page's selectable text: a tap still presses it.

## Design

- **Growth, concurrency, migration, audience, identity:** N/A because it sends an existing command the server authorizes.
- **Read cost:** one read of the document after a remove, as a revision move already does.
- **Scale:** N/A because it is one command per press.
- **Compatibility:** every backend that has notes takes the command.
- **Failure:** a refusal is said on the page.
- **Platforms:** iOS and Android share this page.

---

### Task 1: Remove on a note

**Files:**
- Modify: `mobile/lib/swarm/swarm_instructions_page.dart`
- Test: `mobile/test/swarm/swarm_instructions_page_test.dart`

- [ ] **Step 1: Write the failing tests:** an allowed person confirms and `note.remove` goes once with the project and note; Cancel sends nothing; a viewer sees no Remove; a refusal says why and keeps the note.
- [ ] **Step 2: Run to verify they fail.** Run: `flutter test test/swarm/swarm_instructions_page_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement,** with `confirmPhoneAction`.
- [ ] **Step 4: Run to verify they pass,** then `flutter test test/swarm`.
- [ ] **Step 5: Commit** the test first, then the code; push. Add a screenshot to the PR.
