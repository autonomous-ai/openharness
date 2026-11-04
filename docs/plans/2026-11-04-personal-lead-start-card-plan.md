# Start a Lead card Implementation Plan

> This plan follows the project's own way of working (project instructions, Engineer): each plan task commits its
> failing test before its code, and the pull request's one review step is the independent review. There is no
> execution handoff; the Engineer implements it.

**Goal:** In a Personal Swarm project with no Lead, the empty chat offers to start one right away: a card like the
Buddy's start card, with the machine, engine and folder it will use and Start Lead, above Show panes.

**Architecture:** #2633's `PersonalLeadStarter` (desktop/lib/super_tabs/personal_lead.dart) already decides whether a
chat wants a Lead (`wants`), where it starts (`planFor`), starts it once with one claim (`start`), and keeps its
failure. The card is a view over that: `planFor` and `start` take the machine and engine the card picked, and the
card reads the starter's status for its button and failure line. `view.dart`'s empty project chat shows the card
while `wants` holds, above the panes block it already draws.

**Tech Stack:** Flutter (Desktop and web, one code base), widget tests with the Super Tab fixture server, a memory
store and a fake sign-in.

**Spec:** Swarm task #2815's brief (Huy, 11-04, follow-up to #2633), quoted in the pull request.

## Global Constraints

- Only a Personal Swarm project with no Lead shows the card. Team Swarms are unchanged.
- Defaults: the machine is this Mac (the person's own), else another of their computers that's connected. The engine
  is Claude Code, else Codex (#2633's own choice; the Swarm has no other default engine). The folder is the project's
  repo on that machine, else a new folder in the Harness projects folder.
- Copy: "This project has no Lead yet", "Start Lead", "Starting…", "Couldn’t start a Lead: <reason>" (the receipt's
  own words), and "Or send a message below: that starts the Lead too."
- One start per project, through #2633's claim. A message sent before starting still starts it as #2633 does.
- Harness design language: tokens only, no new numeric `EdgeInsets`, `Color` or radius in `super_tabs`
  (`scripts/check-ui-style.py`).
- Desktop guard tests (`check-ui-style`, `laid_out_list_test`) pass before Ready.

## Review Focus

- A machine picked that has no repo checkout: the folder line and the start both fall back to a new Harness folder.
- Start Lead pressed twice, or a message sent while the card's start runs: one claim and one start.
- The Lead appears while the card is shown, for example after another of the person's machines started it: the card
  goes away on the next snapshot.
- None of the person's computers is online, or neither engine is signed in: the card says why and offers no Start.
- A viewer who can't write: no card, as the Buddy start shows none.

---

### Task 1: The starter takes the card's machine and engine

**Files:**
- Modify: `desktop/lib/super_tabs/personal_lead.dart`
- Test: `desktop/test/super_tab_personal_lead_test.dart`

**Interfaces:**
- Produces: `List<MachineState> PersonalLeadStarter.machinesFor(SuperTabController c)`: the person's own connected
  computers, this one first.
- Produces: `PersonalLeadPlan planFor(SuperTabController c, String conversationId, {String? machineId, String? engine})`:
  with `machineId`, that machine and its repo folder (null when it has none there); with `engine`, that engine.
- Produces: `Future<void> start(SuperTabController c, String conversationId, {String? machineId, String? engine})`.

- [ ] **Step 1: Write the failing test** `a start the card asked for uses its engine` in
  `super_tab_personal_lead_test.dart`: `start(c, games, engine: 'codex')` creates the agent with `engine == 'codex'`.
- [ ] **Step 2: Run it and watch it fail:** `flutter test test/super_tab_personal_lead_test.dart` fails because `start`
  takes no engine.
- [ ] **Step 3: Implement** the three interfaces above. `planFor` keeps its fallback order when given nothing.
- [ ] **Step 4: Run it and watch it pass:** the same command passes, along with #2633's existing cases.
- [ ] **Step 5: Commit** the test first, then the code.

### Task 2: The empty project chat shows the card

**Files:**
- Create: `desktop/lib/super_tabs/personal_lead_card.dart`
- Modify: `desktop/lib/super_tabs/view.dart` (the empty-chat branch that calls `_panesWaiting`)
- Test: `desktop/test/super_tab_personal_lead_card_test.dart`

**Interfaces:**
- Consumes: Task 1's `machinesFor`, `planFor` and `start`, plus `statusOf` and `wants`.
- Produces: `PersonalLeadStartCard({required SuperTabController controller, required String conversationId,
  required AppNotifier app})`, keyed `super-lead-start`. Its machine field is `super-lead-start-machine`, its engine
  field `super-lead-start-engine`, its folder line `super-lead-start-folder` and its failure line
  `super-lead-start-error`.

- [ ] **Step 1: Write the failing tests** in `super_tab_personal_lead_card_test.dart`:
  - The card shows with its defaults (`Test host`, `Claude Code`, the repo's folder) above Show panes.
  - With no repo, the folder line reads "A new folder in your Harness projects folder".
  - Start Lead pressed twice makes one claim and one start, on `m` with `claude` in the repo's folder.
  - The engine picked on the card is the one the start uses.
  - A project with a Lead shows no card.
  - A Team Swarm shows no card.
  - A failed start shows "Couldn’t start a Lead: <reason>" on the card, and Start Lead tries again.
- [ ] **Step 2: Run them and watch them fail:** `flutter test test/super_tab_personal_lead_card_test.dart` fails with
  no `super-lead-start`.
- [ ] **Step 3: Implement** the card after the Buddy start card's layout (`buddies.dart` `_BuddyStart`: a medium
  title, one row of fields and a filled button, lines under it). In `view.dart`, show it above the panes block (alone when the project has no
  panes: with no Lead, "Discuss the plan with …" has no one to name) while `wants` holds and the reader can write.
- [ ] **Step 4: Run them and watch them pass,** then the files that draw the empty chat or start a Lead:
  `super_tab_personal_projects_test.dart`, `super_tab_personal_lead_test.dart`, `super_tab_receipt_test.dart`,
  `super_tab_view_test.dart`. Then the guard tests: `python3 scripts/check-ui-style.py`,
  `flutter test test/laid_out_list_test.dart`.
- [ ] **Step 5: Commit** the tests first, then the code. Light and dark screenshots come from
  `PERSONAL_LEAD_CARD_SHOTS=<dir> flutter test test/super_tab_personal_lead_card_test.dart`.
