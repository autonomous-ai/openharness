# Route Details groups what couldn't start (task #3292) Plan

> Worked by the Engineer, test first (superpowers test-driven-development): each task's failing test is committed and
> seen red before the code that passes it.

**Goal:** A route decision's Details on Desktop shows the candidates first, then one line per machine for what couldn't
start there, with its distinct reasons, and a route rule that left out candidates on several machines (the grid limit
for security work) once for the whole decision, instead of one "Unavailable" line per machine × agent × model.

**Architecture:** Desktop only. The record's excluded rows (`cli/src/superTabs/route.ts` `recordOf`) keep `title` and
`reason`; the title is the CLI's `titleOf` ("name · engine model effort · machine"), which `route_row.dart` already
parses for the route's target. A pure function in `route_row.dart`, `routeUnavailableLines`, groups the rows:

1. A row's machine is the title's last part when the title has the `titleOf` shape; other rows ("Named model",
   "Local models", "New agents", a model whose host is offline) have none.
2. A reason that a route rule gave ("Name: …", how `route.ts` prefixes a plug-in's refusal) on rows of two or more
   machines is that rule's, not a machine's: one line, "Unavailable on N machines — Grid limits: …".
3. Every other reason goes on its machine's one line, distinct reasons in first-seen order, at most four and then how
   many more (as the CLI's `leftOut` keeps at most four): "Unavailable: Mac 3 — Machine is offline or unreachable."
   A machine whose every reason was a rule's has no line of its own.
4. Rows with no machine stay one line each, once per distinct title and reason.

No shared helper with the CLI: Dart and TypeScript share no code, and the CLI's `leftOut` needs the `machine` field the
record does not keep (adding it would change `recordOf` and the backend's strict record schema, outside this task).
The dialog keeps its layout: the same lines of text under "Considered", fewer of them. There is no expand for the
excluded rows today, so there is none to keep them behind; the full rows stay in the decision record (the CLI's
`route-decisions` read).

**Tech Stack:** Flutter/Dart, `flutter_test` widget tests with the existing `ConversationServer` fixture (memory store,
fake sign-in).

**Spec:** task #3292 brief (Ken, 11-05 17:25 VN).

## Global Constraints

- Owned files only: `desktop/lib/super_tabs/route_row.dart`, `desktop/test/` (and this plan).
- Keep the Details layout (anh Dee's rule): plain text lines, candidates first.
- Desktop tests use a memory store and a fake sign-in; nothing signs the Mac out of the real CLI.
- `make check-ui-style` (or its Desktop equivalent) and the affected Desktop tests before Ready.

## Design

N/A because nothing is stored, synced or exposed anew: Desktop groups, at display time, rows it already reads (at most
200, `recordOf`). Read cost is one pass over those rows; old records group the same (their titles have the same shape,
and a title of another shape is shown as it was). Platforms: the same Flutter text on macOS, Windows, Linux and web.

## Review Focus

- A machine name containing " · " (the regex takes the last part as the machine, as `_target` does).
- A rule reason on one machine stays on that machine's line; the same rule on two machines is lifted once.
- OFFLINE ("Machine is offline or unreachable.") is the same text on every offline machine: it is no rule (no "Name: "
  prefix), so two offline machines keep a line each.

## Task 1: Group the excluded rows

**Files:** `desktop/test/super_tab_route_test.dart`, `desktop/lib/super_tabs/route_row.dart`

**Interfaces:** `List<String> routeUnavailableLines(Iterable<Map<String, dynamic>> excluded)` in `route_row.dart`.

- [ ] Test: an offline machine with 17 excluded rows (17 models, the same OFFLINE reason) shows as one line,
      "Unavailable: Mac 3 — Machine is offline or unreachable.", and the Considered lines come before it.
- [ ] Test: the security grid limit on grid candidates of three machines (about 30 rows) shows once per decision, and
      those machines get no line of their own for it.
- [ ] Test: two offline machines keep a line each; a machine with five distinct reasons shows four and "1 more";
      rows with no machine ("Named model") show once each.
- [ ] Run `flutter test test/super_tab_route_test.dart`: the new tests fail (each row is printed).
- [ ] Commit the failing tests.
- [ ] Implement `routeUnavailableLines` and use it in `_detailsView`.
- [ ] Run `flutter test test/super_tab_route_test.dart` and the UI style check: green.
- [ ] Commit, push, post red/green evidence in a PR comment, mark Ready.
