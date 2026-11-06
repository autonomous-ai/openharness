# Board cards show CI state and the next release time: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A Done card on the Tasks board says whether its pull request's checks are green and how long it has waited to merge,
and a Merged card says when the next release is due (task #3827, requested by Dee through Harness; split from #3812, which
shipped the six columns without these two facts).

**Architecture:** The server already reads each open or done task's pull request every minute for the PR watch
(`pullRequestEvents.ts`, #3731's throttle) and settles each project's release list with its rules and the last releases
(`releases.ts settleReleases`). Both write what they already know into the Swarm's own state, so the board's changes feed
carries it and nothing reads GitHub per board load:
- the watch records one state per linked pull request, `green`, `red` or `running`, on the task (`pullRequestChecks`), derived by
  the same rule it uses to post "CI failed" and "CI passed", written only when it changes;
- the settle records the next time each component's release may open (`nextAt`) on the project's release list, derived by
  `nextReleaseAt` from the window, the pace, the backend's pause and its last verified release, written only when it changes;
  the read sends the visible projects' times in `derived.releaseTimes`.
Desktop reads both: Done reads "green, waiting 12 min" (a warning past an hour; red CI puts the task back in Working as "CI red"),
Merged reads "next release about 15:30" in the reader's local time.

**Tech Stack:** TypeScript backend (vitest unit tests, the Super Tab integration suite in PR CI), Dart and Flutter Desktop.

**Spec:** Task #3827's brief; the Task Board table of docs/plans/2026-11-06-buddy-board-final-spec.md; docs/plans/2026-11-03-pr-events-to-engineer-plan.md
and docs/plans/2026-11-05-release-schedule-plan.md.

## Global Constraints

- PR body first line: "Requested by dee through Harness."
- Owns `backend/src/superTabs/`, `desktop/lib/super_tabs/` and `desktop/test/`.
- No extra GitHub read per board load: nothing new is asked of GitHub; the PR watch's existing read is reused.
- Fields are only added. An older Desktop ignores them; a newer Desktop with an older backend shows what it showed.
- Desktop tests use a memory store and a fake sign-in. No fixed sleeps.

## Design

- growth: one short state per linked pull request, replaced in place and dropped with the link; one number per component per
  project, replaced in place. Both die with the task or project. Bounded by the existing link and component limits.
- concurrency: the PR watch's write already runs in the task's transaction (`pullRequestSeen`); the release settle's in the
  project's (`settleReleases`). No new lock; each field is set inside the write that already holds it, and only when it differs.
- read cost: no query is added and nothing is read from GitHub. The state comes from the read the watch already made this pass,
  the times from the rules the settle already loaded. The board's read sends the stored values; `derived.releaseTimes` is a small
  map built from the head's project records the read already holds, with no store read.
- scale: 10x tasks adds a field to each linked task's part, unchanged unless its checks change (a few times per head). The warning
  metric is the part-write rate of `pullRequestSeen`, which does not rise when nothing changed (it already returns early).
- compatibility: backend first. Absent fields mean unknown: Desktop shows the waiting time alone, as in #3812. The server keeps no
  contract it must not change: both fields are new and optional.
- migration and rollback: none to run; a task gets its state at the next watch pass, a project its times at the next settle.
  Rolling back the backend leaves the fields in stored state, ignored by the older code; rolling back Desktop shows the old lines.
- audience: the same as the task: the field is on the task part the reader may read; `derived.releaseTimes` is sent only for
  projects the reader sees, and holds no task, name or content.
- identity: nothing acts as a person; the watch and the settle are the Swarm's own workers.
- failure: a pull request the watch cannot read keeps its last state until it can; a project with no rules saved uses the seed's.
  Nothing breaks without a line: unknown shows the plain wait.
- platforms: backend; Desktop (macOS, Linux, Windows, web share the Dart path).

## Review Focus

- `green` only when every check run of the head is completed and passed and every suite with runs is completed (the rule that
  already posts "CI passed"); a draft or a pull request GitHub is still computing is `running`, never `green`.
- `nextReleaseAt` never answers a time inside the backend's pause or outside the window; a time already allowed is 0, so the read
  does not change every minute.
- Nothing new is written when the state or the time did not change.

## Task 1: the next release time (backend)

**Files:** `backend/src/superTabs/releases.ts`, `backend/src/superTabs/releases.test.ts`.

**Interfaces:** `nextReleaseAt(ledger, component, now, rules): number | null` (0: allowed now; null: this pace releases it by hand);
`ReleaseLedger.nextAt?: Partial<Record<ReleaseComponentId, number>>`.

- [ ] Failing tests: allowed now is 0; before the window it is the window's start the same day; after it, the next day's; inside the
  backend's pause it is the pause's end; within the backend's pace of its last release it is that release plus the pace, moved into the
  window; apps with `appsAfterVisibleBatch` false are null; settle records `nextAt` and writes nothing when it did not change.
- [ ] Implement `nextReleaseAt` and set `ledger.nextAt` at the end of `settleReleases`. Commit.

## Task 2: the times in the read (backend)

**Files:** `backend/src/superTabs/read/contract.ts`, `read/views.ts`, `read/views.test.ts`.

- [ ] Failing test: `derived.releaseTimes` holds each visible project's `nextAt` and nothing for a project the reader does not see
  or one with none.
- [ ] Add `Derived.releaseTimes` and build it in `derive`. Commit.

## Task 3: the pull request's check state (backend)

**Files:** `backend/src/superTabs/pullRequestEvents.ts`, `pullRequestEvents.test.ts`, `model.ts`, `store.ts`,
`backend/integration/superTabPullRequestEvents.test.ts`.

**Interfaces:** `checksStateOf(watch): 'green' | 'red' | 'running'`; `Conversation.pullRequestChecks?: Record<string, ...>`.

- [ ] Failing tests: all runs passed and suites completed is green; any failed run is red; a draft, runs still going or none read is
  running; the same rule that posts "CI passed". Integration: the watch records the state on an open task and on a done one, changes
  it when the head's checks change, and writes nothing when they did not.
- [ ] Implement `checksStateOf`; in `pullRequestSeen` set the state (also for a done task, which returns early today); drop states of
  links no longer watched. Commit.

## Task 4: Desktop reads both and the cards say them

**Files:** `desktop/lib/super_tabs/model.dart`, `parts.dart`, `task_groups.dart`, `tasks_view.dart`, tests under `desktop/test/`.

- [ ] Failing tests: a done task whose state is green reads "green, waiting 12 min" and turns to a warning past an hour; running reads
  "CI running, waiting 12 min"; red is in Working as "CI red"; unknown reads as before. A merged task reads "next release about 15:30"
  from its parts' times (the earliest), "next release due now" at 0, and as before with none.
- [ ] Parse `pullRequestChecks` and `derived.releaseTimes`; place and caption by them. Commit.

## Task 5: screenshots and evidence

- [ ] Light and dark screenshots of the board with the new lines; red/green and the integration run in the pull request.
