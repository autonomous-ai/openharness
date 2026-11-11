# Buddy sessions: no count of their own Implementation Plan

> Written after the code: the project's rule for a plan file arrived while this task was in review (Ken, 2026-11-02). It records
> the plan as carried out. Tests were written alongside the code, not first; each test's failure was shown by removing its
> fix (evidence on PR #2534).

**Goal:** A person opens as many extra Buddy sessions as their machine allows; idle ones close themselves, a busy one never
does, a closed one reopens with its history and project, and each has a visible End session.

**Architecture:** The server stops counting a chat's sessions and keeps only the machine's own agent limit, in plain words. The
host asks the core whether a session's turn is open before its idle end. A session reopened in its thread keeps the project of
the thread's latest session row and reads that project's earlier session rows. Desktop drops the count and shows End session on
the chat's thread line too.

**Tech Stack:** backend TypeScript (Prisma on MongoDB, vitest); CLI daemon TypeScript (vitest); Flutter (Desktop).

**Spec:** `docs/superpowers/specs/2026-10-30-buddy-thread-sessions-design.md`, updated in this pull request.

## Global Constraints

- The machine's agent limit stays: it is its owner's setting (Lead, in the task's thread, 2026-11-02).
- The main Buddy's start and stop do not change.
- A session reads nothing of another project or of the main Buddy's rows.
- A session's chat and history are kept when it closes.
- Security-sensitive: two independent reviews. Backend change: the full Super Tab integration suite before Ready.

## Files

- `backend/src/superTabs/buddySessions.ts`: the read rule; the count's constant goes.
- `backend/src/superTabs/commands.ts`, `store.ts`, `model.ts`: the start rule; the thread's latest session project.
- `cli/src/superTabs/host.ts`: the idle end asks about the turn.
- `cli/src/core/experimentQueries.ts`: answers `activity` to the Swarm's own process.
- `desktop/lib/super_tabs/{buddy_sessions,controller,message_row,thread_panel,view}.dart`: no count; End session on the line.
- Tests beside each; the spec above.

## Task 1: No count, the machine's limit in plain words

- [x] Replace "runs at most 3" with a test that a fifth session starts and two racing starts both succeed; see it fail.
- [x] Add a test that a full machine refuses in plain words, leaves no start, entry or message, and starts once a place frees.
- [x] Remove `MAX_BUDDY_SESSIONS` and its check; refuse on the machine's limit before the start is written.
- [x] Run `integration/superTabBuddySessions.test.ts`; expect pass.

## Task 2: A busy session never closes

- [x] Add host tests: an open turn with a quiet screen stays; a read that fails, answers nothing or answers unknown stays.
- [x] Add a test through `processCoreApi` and `answerExperimentQuery` that the Swarm's process gets the answer, and no other does.
- [x] See them fail; answer `activity` to `superTabs`; end only on a read that says idle.
- [x] Run `src/superTabs/host.spec.ts` and `src/core/experimentQueries.spec.ts`; expect pass.

## Task 3: Reopening keeps history and project

- [x] Add tests: reopened naming no project, as a thread's reply box does, it keeps its project and reads the earlier answers;
      another project's session reads none of them; a plain one stays plain; one in a project its person lost is refused alike.
- [x] See them fail; add the read rule and the inherited project.
- [x] Run `integration/superTabSwarmBuddy.test.ts`; expect pass.

## Task 4: End session on Desktop

- [x] Post the ASCII mockup to the person who asked.
- [x] Add widget tests: past 3 New session stays on offer; End session on the chat's line ends without opening; access lost removes it.
- [x] See them fail; drop the count, share one End session widget, draw it outside the thread's link, wrap in a narrow chat.
- [x] Run `test/super_tab_buddy_sessions_test.dart` and `test/super_tab_threads_test.dart`; expect pass.

## Task 5: Evidence and review

- [x] Run the full backend Super Tab integration suite; compare any failure with clean main.
- [x] Post red/green evidence on the pull request; add two review steps and message the Reviewers.
