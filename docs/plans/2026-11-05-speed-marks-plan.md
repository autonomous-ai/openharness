# Speed marks: launch, big-chat load and image load — Plan

**Goal:** A repeatable measurement of the three things Huy's speed plan (A) needs before any B or C change: the time from opening Desktop to a painted chat, the time to load messages in a large chat (first page and scroll-up pages), and the time and bytes of each image in an image-heavy chat.
**Architecture:** One small recorder (`SpeedMarks`, `lib/measurement/speed_marks.dart`) that the launch path, the Swarm chat controller and the attachment image provider call. It writes one `speed` line per mark to the app log that Desktop already keeps (`~/.harness/logs/app-YYYYMMDD.log`), counts and milliseconds only. A pure-Dart report builder (`speed_report.dart`) turns those lines into the table with the three slowest steps, and `tool/speed_report.dart` prints it from the real log.
**Tech Stack:** Flutter/Dart (Desktop), `flutter_test`.
**Spec:** Task #3176 (Huy, 2026-11-05: before and after numbers for each speed task).

## Design
- growth: marks are logged to the daily app log (DEBUG, the log's batched path), pruned after 14 days like every other line; a launch step is logged once per launch, messages only for first-page and scroll-up reads (polls are not logged), images once per fetch; the report reads only the last launch.
- concurrency: single UI isolate; no locks.
- read cost: no reads at runtime; the report tool reads the log files on request.
- scale: 10x chat size changes row counts, not the number of lines per read; the log line rate is bounded by pages read and images shown.
- compatibility: a new log category only; old tools ignore it.
- migration + rollback: none; remove the calls to roll back.
- audience: local file on the person's own Mac; no network, nothing is reported.
- identity: no ids, names or paths in a line (steps, kinds, counts, milliseconds and bytes only).
- failure: a failed logging call is swallowed and never blocks the product; a failed image records `failed`.
- platforms: all native targets; the web build records in memory only.

## Global Constraints
- No new settings. Measurement never carries content, paths or identifiers, and never blocks or slows the product (ENGINEERING.md).
- Tests use a memory store and a fake sign-in; nothing signs the real CLI in or out.
- Swarm code stays out of cli/src/core.

## Review Focus
- Marks never change behavior (a mark call that throws must not break a read or a paint).
- Nothing identifying in a line.
- The report names the three slowest steps from real log lines.

## Tasks
- [ ] 1. `SpeedMarks` recorder: test — a launch step is kept once, in order, in milliseconds since launch; a messages mark keeps kind, rows, request ms and total ms; an image mark keeps bytes and ms; every line names no id; a sink that throws is swallowed.
- [ ] 2. Report builder: test — lines in, table out; the three slowest launch steps and the three slowest message reads are named by the time each step took after the one before it.
- [ ] 3. Hook the launch path (`app_shell.dart`, `main.dart`, `AppNotifier._markStartup`) and the first painted chat row (`super_tabs/view.dart`): test — `_markStartup` steps reach the recorder; a built chat row marks first chat once.
- [ ] 4. Hook message reads (`super_tabs/controller.dart` `_loadMessages`): test — a latest-page read and an older-page read each record rows and times; a poll that adds nothing records none.
- [ ] 5. Hook image fetches (`super_tabs/attachment_viewer.dart` `AttachmentImage`): test — a fetched picture records its bytes and time; a failed one records `failed`.
- [ ] 6. `tool/speed_report.dart` prints the report from `~/.harness/logs`; document the run in `desktop/README.md`.
- [ ] 7. Run it on a real Mac and post the table in the task's conversation.
