# A PM in My agents wears its crown on its avatar and says which project it leads: implementation plan

> This plan is carried out by the project's Engineer way of working (test first, task by task, one pull request), not
> subagent-driven-development. There is no execution handoff.

**Goal:** In the left pane's My agents, a PM's crown moves from after its name to a small badge on its avatar's corner,
and the name of the project it leads follows its name as quiet text: "Sage  harness". Regular agents are unchanged.
This is task #4421 (anh Dee 11-07 12:32 and 12:37: "let's just put a leader crown on the avatar. it's too much." and
"let's put the project name next to the one that it leads").

```
before                         after
 (S) Sage 👑                    (S)♛ Sage  harness
 (K) Kestrel                    (K)  Kestrel
```

**Architecture:** `SuperTabAvatar` (`desktop/lib/super_tabs/identity.dart`) already draws corner badges (the engine
mark, a person's status). `SuperTabAvatar.agent` gains `crown`, drawn as the same `_Badge` at the top right with
`AppIcons.crown`. `SuperTabBuddyRow` (`buddy_rows.dart`) replaces `crownKey`, the icon after the name, with `crown`,
passed to the avatar. `ProjectSidebar._agentRow` passes the project a PM leads (`snapshot.leadProjectForAgent`) as the
row's `note`, the quiet text after the name that already yields its width first.

**Tech Stack:** Flutter, widget tests.

**Spec:** Task #4421's brief.

## Global Constraints

- Desktop only; only this delta. Bold for unread, dimmed for idle, Buddy first and + New agent stay as they are.
- Existing crown icon, text styles and theme tokens; the project name from the snapshot the client already has.

## Review Focus

- The name keeps its width before the project name in a narrow pane.
- Other avatars (messages, roster, cards) draw no crown.

---

### Task 1: The crown on the avatar, the project after the name

**Files:**
- Modify: `desktop/test/super_tab_v3_left_test.dart`
- Modify: `desktop/lib/super_tabs/identity.dart`, `desktop/lib/super_tabs/buddy_rows.dart`,
  `desktop/lib/super_tabs/project_sidebar.dart`

**Interfaces:** `SuperTabAvatar.agent(..., bool crown = false)`; `SuperTabBuddyRow(..., bool crown = false)` replaces
`crownKey`.

- [ ] Test: a PM row has the crown on its avatar's top right corner, none after its name, and its project's name after
  its name; a Regular row has neither; in a narrow pane the project name is cut and the name is whole. Light and dark
  screenshots when `HARNESS_SUPER_TAB_CAPTURE` is set.
- [ ] Run it and watch it fail.
- [ ] Implement; run `flutter test test/super_tab_v3_left_test.dart` and the tests of the avatar and row's other users.
- [ ] Commit and push.
