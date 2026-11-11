# Phone Buddy sessions Implementation Plan

> **For agentic workers:** Work task by task, test first (project instructions, revision 23: Engineer role, not subagent-driven-development). Steps use checkbox (`- [ ]`) syntax. There is no Execution Handoff: the Engineer goes on to implement.

**Goal:** In the phone app's Buddy chat, a person can start a New session (choosing All projects or one project), reply in a thread with New session (also after its session ended), see the session's status line and End session, as Desktop does.

**Architecture:** A new `mobile/lib/swarm/swarm_buddy_sessions.dart` holds the pure rules (when New session is offered or blocked, status and end words), ported from Desktop's `SuperTabController` (`threadSessionBlocked`, `offersChatSessions`, `offersThreadSessions`) and `buddy_sessions.dart`. `SwarmConversation` and `SwarmThread` carry the New session choice into `message.send` (`newSession`, `sessionProjectId`) and send `buddy.sessionEnd`. The chat composer, the thread reply box and a status line under the thread header draw it. No server changes.

**Tech Stack:** Flutter widgets and `flutter_test`, in `mobile/`.

**Spec:** `docs/superpowers/specs/2026-10-30-buddy-thread-sessions-design.md`, and Desktop's behaviour in `desktop/lib/super_tabs/{controller,view,thread_panel,buddy_sessions}.dart`. Task #2118 (Tony).

## Global Constraints

- The pull request body starts with: `Requested by tony@autonomous.ai through Harness.`
- A change people see follows the Harness design language; the ASCII mockup was posted in the task conversation first.
- No server changes. Never install a build on anyone's phone.
- All projects: sends no `sessionProjectId`, reads every project, sends no work to a PM. One project: sends `sessionProjectId`, reads only that project, can hand work to its PM.
- New session on a top-level message needs `snapshot.sessionsFromChat`; on a thread reply `snapshot.threadSessions`. Neither is offered on a server that does not say so, and not for 10 minutes after a refusal for the `newSession` field.
- Only the reader's own Buddy chat (`chat.buddyOwnerId == reader.accountId`, not an older Buddy chat) offers sessions.
- Phone copy, exactly as Desktop's: "New session", "All projects · ask anything", "<Project> · ask and hand off work", "Own session" / "<Project> session", "Starting…", "<machine> is offline", "Idle", "End session", "Ending…", and the ended lines of `superTabSessionEndedWords`.

## Review Focus

- A project the person lost access to between choosing it and sending: no `sessionProjectId` goes (Desktop `_chosenSessionProject`).
- A reply with New session never also sends `alsoSend`, and never carries an agent mention (a session's thread hears only its session).
- A refused New session puts the text back in the box and says why; a plain retry sends without New session.
- A thread whose session ended starts a new one on reply: New session shows ticked and locked.
- End session pressed twice sends one `buddy.sessionEnd`; it is disabled while ending.
- A person who cannot write, an archived chat or an older Buddy chat sees no New session.

---

### Task 1: Read the session fields

**Files:**
- Modify: `mobile/lib/swarm/model.dart` (`SuperTabBuddySessionOf`, `SuperTabConversation`, `SuperTabMessage`)
- Test: `mobile/test/swarm/swarm_buddy_session_parse_test.dart`

**Interfaces:**
- Produces: `SuperTabBuddySessionOf.projectId` (`String?`); `SuperTabConversation.sessionFor(String thread)` → `SuperTabBuddySession?`; `SuperTabMessage.sessionEnded` (bool, `source.kind == 'buddy-session-ended'`), `.sessionEndReason` (`String?`), `.sessionRoot` (`buddySession && !threadReply`).

- [ ] **Step 1: Write the failing test** `session fields read as Desktop reads them`: `SuperTabBuddySessionOf.fromJson({'thread':'r','from':1,'projectId':'p'}).projectId == 'p'`, an empty or non-string `projectId` is null; `sessionFor('r')` finds the listed session and `sessionFor('x')` is null; a message with `source: {'kind':'buddy-session-ended','reason':'idle'}` has `sessionEnded` true and `sessionEndReason == 'idle'`, any other message has both false/null.
- [ ] **Step 2: Run it, expect FAIL** (`cd mobile && env -u TMUX flutter test test/swarm/swarm_buddy_session_parse_test.dart`): members not defined.
- [ ] **Step 3: Implement** the members above in `model.dart`, as Desktop's `model.dart` has them.
- [ ] **Step 4: Run it, expect PASS.**
- [ ] **Step 5: Commit** the test first (failing), then the code.

### Task 2: The session rules

**Files:**
- Create: `mobile/lib/swarm/swarm_buddy_sessions.dart`
- Test: `mobile/test/swarm/swarm_buddy_sessions_test.dart`

**Interfaces:**
- Consumes: Task 1; `swarmBuddy(reader, projectId)`, `swarmIsOwnBuddyChat`, `swarmIsOldBuddyChat` (`swarm_buddy.dart`).
- Produces:
  - `String? swarmSessionBlocked(SwarmReader reader, SuperTabConversation chat)`: null when a session can start; else "New work is paused in this Swarm", "Start your Buddy first", "Sessions need a Claude Code Buddy", or "Update Harness on <machine> to start sessions" (Desktop `threadSessionBlocked`; the Buddy is `swarmBuddy(reader, chat.projectId)`, `downSince != null` counts as not running, the machine report is `snapshot.pool(machineId)['observation']['capabilities']` containing `buddySessions`).
  - `bool swarmOffersChatSessions(SwarmReader reader, SuperTabConversation chat)`, `bool swarmOffersThreadSessions(SwarmReader reader, SuperTabConversation chat, {required bool hadSession})`.
  - `({String words, bool live})`-free helpers: `String swarmSessionWords(SuperTabBuddySession session, SwarmReader reader)` returning "Own session · Starting…" / "<Project> session · Idle" style text; `String swarmSessionEndedWords(String? reason)`.

- [ ] **Step 1: Write the failing tests**, one per rule: paused, no Buddy, Buddy down, codex Buddy, host without `buddySessions`, a clear case (null); chat offers only with `sessionsFromChat` and a Buddy; thread offers with `threadSessions` and, for a chat without a Buddy, only when `hadSession`; never in someone else's chat or an older Buddy chat; ended words per reason (`idle`, `ended`, `stopped`, `failed`, `removed`, `maintenance`, unknown).
- [ ] **Step 2: Run, expect FAIL** (file missing).
- [ ] **Step 3: Implement** in `swarm_buddy_sessions.dart`. Port Desktop's logic and words verbatim.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** test, then code.

### Task 3: Start a session from the chat (both modes) and end one

**Files:**
- Modify: `mobile/lib/swarm/swarm_conversation.dart` (`_compose`, state, refusal), `mobile/lib/swarm/swarm_buddy_sessions.dart` (`endSession`)
- Test: `mobile/test/swarm/swarm_chat_session_test.dart`

**Interfaces:**
- Consumes: Task 2.
- Produces on `SwarmConversation`: `bool newSession` (get/set, notifies `composer`), `String? sessionProjectId` (get/set), `bool get offersSessions`, `String? get sessionBlocked`; `Future<bool> endSession(String root)`.
- `_compose` adds `'newSession': true` and, when `sessionProjectId` names a project still in `snapshot.projects` and the chat is the Swarm Buddy chat, `'sessionProjectId'`. After the post is taken, `newSession` and `sessionProjectId` reset. A refusal naming `newSession` as an unrecognized key restores the draft and sets `error` to "New sessions aren't available yet; send without it?" and turns the offer off for 10 minutes.
- `endSession(root)` sends `{'type':'buddy.sessionEnd','conversationId':id,'thread':root,'reason':'ended'}` once; false when the chat has no session for `root`.

- [ ] **Step 1: Write the failing tests** (fail on main: no such members): All projects sends `newSession: true` and no `sessionProjectId`; one project sends `sessionProjectId`; a project missing from the snapshot sends none; New session off sends neither; a blocked chat sends no `newSession`; the refusal restores the draft and says why; `endSession` sends one `buddy.sessionEnd`, a second call while the first runs sends none.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** as above in `SwarmConversation`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** test, then code.

### Task 4: Reply in a thread with New session

**Files:**
- Modify: `mobile/lib/swarm/swarm_thread.dart`
- Test: `mobile/test/swarm/swarm_thread_session_test.dart`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces on `SwarmThread`: `bool newSession` (get/set), `bool get sessionLocked` (the thread's last session ended and none is live), `String? get sessionBlocked`, `bool get offersSessions`, `SuperTabBuddySession? get session`, `SuperTabMessage? get sessionEndedRow`. `send()` adds `'newSession': true` when on (or locked and not blocked) and then never adds `alsoSend`.

- [ ] **Step 1: Write the failing tests**: a reply with New session carries `newSession` and no `alsoSend`; a thread whose session ended is locked and sends `newSession`; a live session's thread sends a plain reply; a blocked thread sends none; refusal restores the draft.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** test, then code.

### Task 5: The screens

**Files:**
- Modify: `mobile/lib/swarm/swarm_conversation_page.dart` (`_composer`), `mobile/lib/swarm/swarm_thread_page.dart` (`_box`, status line under the header)
- Create: `mobile/lib/swarm/swarm_session_widgets.dart` (New session chip, "Works in" sheet, status line)
- Test: `mobile/test/swarm/swarm_session_widgets_test.dart`

**Interfaces:**
- Consumes: Tasks 3 and 4. Keys: `swarm-new-session` (chat chip), `swarm-session-project` ("Works in" row), `swarm-session-any`, `swarm-session-in-<projectId>` (sheet rows), `swarm-thread-new-session` (reply box checkbox), `swarm-thread-session-state`, `swarm-thread-session-end`, `swarm-thread-session-ended`.

- [ ] **Step 1: Write the failing widget tests**: the chip shows only where offered and is disabled with its reason when blocked; ticking it shows "Works in: All projects"; the sheet lists All projects and each project; picking one then Send posts `sessionProjectId`; the reply box shows New session, ticked and locked after an ended session; the status line shows "Own session · …" / "<Project> session · …" and End session; End session sends once; the ended line shows the reason.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with the existing `SwarmComposerCard` toolbar, `phone_sheet.dart`, `AppType`, `AppPalette`, `TtyTap`, matching `_AlsoSend` and `_TagChip`.
- [ ] **Step 4: Run, expect PASS; then `flutter analyze` (0 issues outside third_party/xterm) and the whole `test/swarm` folder.**
- [ ] **Step 5: Commit** test, then code. Screenshots for the pull request come from the Tester in the simulator.
