# Phone Decision Choices Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** On the phone, an open decision also offers `Let <coordinator> decide` and `Not now`, and the answered ones are listed, with Desktop's words and rules.

**Architecture:** `SwarmAsks` learns to send `delegate: true` and to read the `settled` list, falling back to `answered` on an older backend, as Desktop's `SuperTabDecisions` does. The session holds a delegation for Undo as it holds an answer. `Not now` keeps ids on this phone in `SwarmHomePrefs`, as Desktop keeps them on its computer. Activity shows the last 5 answered.

**Tech Stack:** Flutter, `flutter_test` with fakes.

**Spec:** Task #2281, Tony's phone list, task 26. Desktop: `desktop/lib/super_tabs/decisions.dart`, `decisions_view.dart`.

## Sketch

In a chat, an open decision:

```
┌───────────────────────────────────────┐
│ Ship the beta on Friday?              │
│ Unblocks: the release notes           │
│                                       │
│ [ Yes, Friday ]  ( No, wait )         │
│                                       │
│ Let Product Manager decide · Not now  │
└───────────────────────────────────────┘
```

After `Not now`, in that chat:

```
  1 decision set aside · Show
```

After `Let Product Manager decide`, for the Undo window, as an answer is held today:

```
┌───────────────────────────────────────┐
│ Ship the beta on Friday?              │
│ Leaving it to Product Manager   Undo  │
│ ▓▓▓▓▓▓▓▓▓▓░░░░░                       │
└───────────────────────────────────────┘
```

In Activity, under what's open, on the decisions it already lists:

```
  ┌─ Ship the beta on Friday? ─────────┐
  │ Let Product Manager decide         │
  └────────────────────────────────────┘

  Answered
  ┌────────────────────────────────────┐
  │ Which region first?                │
  │ You chose: Europe                  │
  ├────────────────────────────────────┤
  │ Ship the beta on Friday?           │
  │ Product Manager decided: Yes       │
  └────────────────────────────────────┘
```

Rules, as Desktop's:

- `Let <coordinator> decide` shows only with a recommended option, in the word the project calls its coordinator.
- `Not now` shows only in a chat: it folds that card there. It stays in Activity and its count, and isn't sent to the server. A decision asked later still shows.
- `Answered` shows the last 5. A decision the coordinator took never reads as the person's own choice.

## Global Constraints

- The PR body starts with: `Requested by tony@autonomous.ai through Harness.`
- Mobile only, on main. No new colors or icons, no on/off switch. Never install a build on anyone's phone; tests use fakes.

## Review Focus

1. A delegation that didn't get a reply is sent again as a delegation, under the same receipt, never as a choice.
2. Answered rows read after access was lost, or from an earlier read of the Swarm, never show.
3. An older backend with no `settled` list falls back to `answered`; one with no decisions shows none.
4. A recommended option missing from a decision offers no `Let <coordinator> decide`, where the phone used to read it as option 0.

## Design

- **Growth:** set-aside ids on the phone are capped, oldest first, and forgotten once answered or gone.
- **Concurrency:** one answered read at a time per Swarm; one read asked during it runs once more.
- **Read cost:** the answered list is read when Activity opens and after an answer, not on every poll. The backend caps it.
- **Scale:** N/A because it's one capped list per Swarm, only while Activity is open.
- **Compatibility:** falls back as Rule 3 says. An old phone ignores the new field.
- **Migration and rollback:** none. Rolling back leaves unused ids in the phone's prefs.
- **Audience:** the server enforces who reads each list; the phone keeps only ids.
- **Identity:** the server decides who may answer, as today.
- **Failure:** a failed read of the answered list says so on the section, and a failed send says so on the card.
- **Platforms:** the phone app on iOS and Android, the same code.

---

### Task 1: The model and the sends

**Files:** Modify `mobile/lib/swarm/swarm_asks.dart`, `swarm_session.dart`. Test `mobile/test/swarm/swarm_asks_test.dart`.

**Interfaces:** Produces `SuperTabDecision.delegated`, `canDelegate`; `SwarmAsks.delegate`, `answered`, `readAnswered`; `SwarmSession.holdDelegate`.

- [ ] Failing tests: delegate sends `delegate: true` and resends the same; the answered list reads `settled`, then `answered` on a 400, and none on a 404; a read from before the Swarm was read again is dropped; a missing recommended option can't be delegated.
- [ ] Run them, implement, run them, commit.

### Task 2: The screens

**Files:** Modify `swarm_need_rows.dart`, `swarm_conversation_page.dart`, `swarm_activity_page.dart`, `swarm_home_prefs.dart`. Test `mobile/test/swarm/swarm_decision_choices_test.dart`, and a shots test.

**Interfaces:** Produces `SwarmHomePrefs.decisionAside`, `setDecisionsAside`, `forgetDecisionsAside`.

- [ ] Failing tests: the card offers both with the project's word; `Not now` folds it in the chat, `Show` brings it back, it survives a restart, and a later decision still shows; `Let … decide` holds for Undo, then sends; Activity lists the last 5 with the right words.
- [ ] Run them, implement, run them, take screenshots, commit, mark the pull request ready and ask Quinn 2.
