# Phone: "Not sent · this chat has no Lead" Implementation Plan

> Worked by the project instructions (Engineer, revision 27): each plan task commits its failing test, then its code.

**Goal:** A message sent where no Lead runs says so, with Desktop's words, and the phone offers Add a Lead where it can start one.

**Architecture:** `SwarmMessageReceipt` gains Desktop's no-Lead case. In a project chat, Add a Lead picks a machine with the new-project sheet's `swarmLeadMachines` and sends `lead.start`, as a new project does.

**Tech Stack:** Flutter, widget tests over `FakeSwarm`.

**Spec:** Tony's mobile list, task 29; `desktop/lib/super_tabs/message_receipt.dart`.

## Sketch

```
┌──────────────────────────────────────┐
│ (D) dee                              │
│     Who picks this up?               │
│     ⚠ Not sent · this chat has no    │
│       Lead                           │
│     Add a Lead                       │
└──────────────────────────────────────┘

Add a Lead opens the phone's usual sheet:

┌──────────────────────────────────────┐
│ Machine                              │
│  ▭ MacBook Pro                       │
│  ▭ Mac Studio                        │
│  ▭ Mac mini                offline   │
└──────────────────────────────────────┘
```

Red, as Desktop draws it. Choosing a machine starts the Lead; the line goes once the chat has one.

## Decisions

- **Same rule as Desktop:** the person's newest message, no delivery, the chat has no Lead, and it is not a Buddy chat.
- **Where the phone differs:** Desktop's Add a Lead opens its New Harness box in that chat. The phone has no such box, and starting an agent in a task from a phone is a new feature. So:
  - **Project chat:** Add a Lead works, through `lead.start`, which the phone already sends for a new project.
  - **Task chat:** the same line with no action. Offering a button that cannot work would be worse.
- **Who:** only someone the server lets manage the project sees the action; a refusal shows its words.

## Design

N/A for growth, concurrency, migration, audience and identity: nothing new is stored, and the server decides who may start a Lead. Read cost: no new reads. Compatibility: `lead.start` is already sent by this app. Failure: a refusal shows its words on the line. Platforms: phone.

## Global Constraints

- PR body starts: Requested by tony@autonomous.ai through Harness.
- Mobile only, based on main. No new colors or icons. No on/off switch.
- Never install builds on anyone's phone. Phone tests use fakes.

## Review Focus

- A message kept from before, with the chat's Lead arriving meanwhile: no line.
- A Lead already starting: no second start.
- A Buddy chat: no line.
- No machine free: the sheet says why rather than opening empty.
- A viewer: no action.

---

### Task 1: The receipt

**Files:** Modify `mobile/lib/swarm/swarm_message_receipt.dart`, `swarm_conversation_page.dart`. Test `mobile/test/swarm/swarm_no_lead_receipt_test.dart`.

- [ ] Failing tests for each case above; implement; commit test first, then code.

### Task 2: Add a Lead

**Files:** Modify `mobile/lib/swarm/swarm_message_receipt.dart`, `swarm_conversation.dart`. Test as above.

- [ ] Failing tests: the sheet lists machines, choosing one sends `lead.start`, one receipt on a retry, a refusal shows its words. Implement; commit test first, then code. Screenshots in the PR.
