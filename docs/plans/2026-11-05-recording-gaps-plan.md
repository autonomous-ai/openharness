# Recording gaps out of chats, and one gap per restart: plan

**Goal:** Chats on Desktop and the phone stop drawing terminal-recording gaps ("Nico's terminal recording was interrupted 4
times. Open terminal"), and the recorder reports a restart of Harness as at most one gap, none when nothing was lost
(task #3127, requested by Dee).

**Architecture:** The cause, from the code and this Mac's harness.log (CLI 0.5.43 at 11:32 and 0.5.44 at 12:31 VN, each a
core restart): the core's observer of native turns (cli/src/lib/nativeTurnObservations.ts) starts a new epoch whenever it
forgets an agent: a core restart, and also every history replay or turn resumed at attach (core/turns/funnel.ts passes
`replay || resumed`), which a restart's re-attach, a re-attach from the start or Claude's compaction bring. The recorder
(cli/src/superTabs/native.ts `capture`) reads each new epoch as `recording_restarted` and posts one gap **for every view it
holds of that agent**, open or not, whether or not a recorded turn was unfinished. Two views of one terminal across a
restart and the replay right after it make four gaps in seconds, the line Dee saw. The fix:

1. An epoch change is a loss only for a view whose recorded turn is unfinished (its prompt recorded, its answer not): that
   view, once, gets the gap. Idle views get none. An agent has at most one unfinished turn, and the restart clears it, so a
   replay right after adds nothing: one restart, at most one gap.
2. Desktop and the phone list no native `gap` row, as they already list no native `prompt` row (#2849): no chat row and
   nothing unread. The rows stay stored on the server, readable by `messages` for diagnosis, and a required recovery
   still reaches the coordinator as its delivery. The "interrupted N times" notice and its folding go.

**Tech Stack:** TypeScript (cli, vitest), Dart/Flutter (desktop, mobile).

**Spec:** task #3127 brief.

## Global Constraints

- Swarm code stays out of cli/src/core; the core's observer is unchanged.
- Journal and wire format unchanged: older saved outboxes and backends keep working.
- Desktop tests use a memory store and a fake sign-in; run check-ui-style and the laid-out list tests before Ready.

## Review Focus

- A prompt submitted in the instant before a reset, not yet seen as a turn, is not reported: the recorder never saw it.
  The person who typed it is watching that terminal. Every other loss still reports (history lost, unattributed input,
  expired view, agent stopped, answer without prompt).
- A view expired but kept for its unfinished turn still gets that turn's gap.
- A chat whose only new rows are gaps reads as read, and marking read passes over them (as for prompts).

## Task 1: the recorder reports a restart once, and not at all when nothing was unfinished

**Files:** Modify `cli/src/superTabs/native.ts` (`capture`); Test `cli/src/superTabs/native.spec.ts`.

- [ ] Failing tests: `a restart with no unfinished recorded turn records no gap` (alpha, beta prepared; alpha's prompt and
  answer recorded; `observer.ingest('harness', [], true)`; capture, flush: sent kinds `['prompt', 'answer']`), and
  `one restart and the replay after it give one gap, for the view whose turn it cut` (alpha's prompt open, beta idle;
  reset, capture, reset again, capture, flush: sent kinds `['prompt', 'gap']`, the gap on alpha).
- [ ] Run `npx vitest run src/superTabs/native.spec.ts` in cli: both fail (4 and 2 gaps). Commit.
- [ ] In `capture`, on `page.gap` with a new epoch, gap only the contexts in `Object.values(row.turns)`; history lost and
  unattributed input keep gapping every view. Run the spec: all pass. Commit.

## Task 2: chats list no recording gap

**Files:** Modify `desktop/lib/super_tabs/model.dart`, `controller.dart` (`_listed`), `view.dart` (drop
`superTabTranscriptEntries` and the notice); delete `desktop/lib/super_tabs/recording_notice.dart`; modify
`mobile/lib/swarm/model.dart`, `mobile/lib/swarm/swarm_conversation.dart` (`stream`). Tests:
`desktop/test/super_tab_recording_gap_rows_test.dart` (new), `desktop/test/super_tab_polish_test.dart`,
`mobile/test/swarm/swarm_special_rows_test.dart`.

- [ ] Failing tests: Desktop `a run of recording gaps is no chat row` (four gaps, one a required recovery with a
  delivery: no "recording was interrupted", no "Terminal recording interrupted", no gap text; the real message shows),
  `a chat whose only new rows are recording gaps shows as read`; phone `a recording gap is no chat row`.
- [ ] Run them (`flutter test` on each file): they fail. Commit.
- [ ] Add `bool get terminalGap => fromTerminal && source['phase'] == 'gap'` to both models; leave it out of Desktop's
  `_listed` and the phone's `stream`; remove the notice, its folding and its polish-test cases. Run the tests, the polish
  and laid-out list tests and check-ui-style: all pass. Commit.
