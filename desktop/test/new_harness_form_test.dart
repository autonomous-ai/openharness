import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/box_chrome.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/mixed_agents.dart';
import 'support/launch_menu.dart' show harnessChoicesActive;
import 'swarm_state_test.dart' show createApp;

/// The setup form is driven by six keys and nothing else, so every one of
/// them is pressed here against a real controller. The bugs this file exists
/// to stop were all the same shape: a key that moved something and then had
/// its effect undone by the refresh that followed.
/// Answers the one request the form's Git rows depend on, so Worktree and
/// Branch are exercised rather than skipped as unavailable.
class _Git extends WsConn {
  _Git()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'dsh_list') return {'dsh': []};
    if (type == 'git_project_info') {
      return {
        'isGit': true,
        'branch': 'main',
        'branches': [
          {'ref': 'refs/heads/main', 'name': 'main'},
          {'ref': 'refs/heads/feature', 'name': 'feature'},
        ],
      };
    }
    return {};
  }
}

void main() {
  Future<NewHarnessController> mount(
    WidgetTester tester, {
    bool created = false,
    String? engine,
  }) async {
    final app = createApp(connectionForTest: (_) => _Git());
    seedMixedAgents(app);
    await app.projectHistory.select('m', '/work/harness-app-landing-page');
    await app.projectHistory.select('m', '/work/harness-monitor');
    await app.projectHistory.select('m', '/work/autonomous-harness');
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: engine,
      folder: '/work/harness-app-landing-page',
    );
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 820,
              height: 450,
              child: NewHarnessForm(
                controller: box,
                onClose: () {},
                onCreated: () {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return box;
  }

  Future<void> press(WidgetTester tester, LogicalKeyboardKey key) async {
    await tester.sendKeyEvent(key);
    await tester.pumpAndSettle();
  }

  Future<void> type(WidgetTester tester, String text) async {
    final input = find.byKey(const ValueKey('new-harness-query'));
    final previous = tester.widget<TextField>(input).controller!.text;
    await tester.enterText(input, previous + text);
    await tester.pumpAndSettle();
  }

  testWidgets('shared setup fields stay available for every agent', (
    tester,
  ) async {
    await mount(tester);
    for (final label in [
      'Project',
      'Agent',
      'Machine',
      'Branch',
      'Worktree',
      'Approvals',
    ]) {
      expect(find.text(label), findsOneWidget, reason: '$label must not go');
    }
  });

  testWidgets('down and up walk the rows and wrap', (tester) async {
    final box = await mount(tester);
    expect(box.field, NewHarnessField.projectMenu);
    await press(tester, LogicalKeyboardKey.arrowDown);
    expect(box.field, NewHarnessField.agent);
    await press(tester, LogicalKeyboardKey.arrowDown);
    expect(box.field, NewHarnessField.machine);
    await press(tester, LogicalKeyboardKey.arrowUp);
    expect(box.field, NewHarnessField.agent);
    await press(tester, LogicalKeyboardKey.arrowUp);
    expect(box.field, NewHarnessField.projectMenu);
  });

  testWidgets('right walks every agent instead of bouncing between two', (
    tester,
  ) async {
    final box = await mount(tester);
    await press(tester, LogicalKeyboardKey.arrowDown);
    expect(box.field, NewHarnessField.agent);
    final seen = <String>{box.engine};
    for (var i = 0; i < 6; i++) {
      await press(tester, LogicalKeyboardKey.arrowRight);
      seen.add(box.engine);
    }
    expect(
      seen.length,
      greaterThan(2),
      reason: 'Stepping from the cursor made the arrows flip between a pair.',
    );
  });

  testWidgets('left and right step opposite ways and return', (tester) async {
    final box = await mount(tester);
    await press(tester, LogicalKeyboardKey.arrowDown);
    final first = box.engine;
    await press(tester, LogicalKeyboardKey.arrowRight);
    expect(box.engine, isNot(first));
    await press(tester, LogicalKeyboardKey.arrowLeft);
    expect(box.engine, first, reason: 'Left must undo right.');
  });

  testWidgets('right walks the projects', (tester) async {
    final box = await mount(tester);
    final seen = <String>{box.projectLabel};
    for (var i = 0; i < 4; i++) {
      await press(tester, LogicalKeyboardKey.arrowRight);
      seen.add(box.projectLabel);
    }
    expect(seen.length, greaterThan(2));
  });

  testWidgets('worktree flips on its own row, without a list', (tester) async {
    final box = await mount(tester);
    for (var i = 0; i < 4; i++) {
      await press(tester, LogicalKeyboardKey.arrowDown);
    }
    final was = box.worktree;
    await press(tester, LogicalKeyboardKey.arrowRight);
    expect(box.worktree, !was);
    await press(tester, LogicalKeyboardKey.arrowLeft);
    expect(box.worktree, was);
  });

  testWidgets('a hyphen is typed, never swallowed as a value key', (
    tester,
  ) async {
    final box = await mount(tester);
    final engine = box.engine;
    await type(tester, 'harness-app');
    expect(
      box.query,
      'harness-app',
      reason: 'Folder and branch names are full of hyphens.',
    );
    await press(tester, LogicalKeyboardKey.arrowDown);
    expect(box.engine, engine, reason: 'and it changed no value on the way.');
  });

  testWidgets('a path prompt asks for a path, not a search', (tester) async {
    final box = await mount(tester);
    await press(tester, LogicalKeyboardKey.enter);
    for (var step = 0; step < 40; step++) {
      if (box.selected?.id == NewHarnessController.existingProjectId) break;
      await press(tester, LogicalKeyboardKey.arrowDown);
    }
    await press(tester, LogicalKeyboardKey.enter);
    expect(box.field, NewHarnessField.project);
    expect(find.textContaining('Search'), findsNothing);
    expect(find.textContaining('path'), findsOneWidget);
  });

  testWidgets('typing filters, and one match still shows its list', (
    tester,
  ) async {
    final box = await mount(tester);
    await type(tester, 'landing');
    expect(box.query, 'landing');
    expect(
      box.matchCount,
      greaterThan(0),
      reason: 'A subsequence search must find harness-app-landing-page.',
    );
    expect(
      find.text('harness-app-landing-page'),
      findsOneWidget,
      reason: 'Hiding the list on one match made a hit look like a miss.',
    );
    expect(
      harnessChoicesActive(tester),
      isTrue,
      reason: 'Typing hands the keyboard to the filtered choices.',
    );
  });

  testWidgets('a gappy query still matches, fzf style', (tester) async {
    final box = await mount(tester);
    await type(tester, 'harness l');
    expect(box.matchCount, greaterThan(0));
  });

  testWidgets('backspace deletes and escape clears before it closes', (
    tester,
  ) async {
    var closed = false;
    final app = createApp();
    seedMixedAgents(app);
    final box = NewHarnessController(app, machineId: 'm');
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: Scaffold(
          body: SizedBox(
            width: 820,
            height: 450,
            child: NewHarnessForm(
              controller: box,
              onClose: () => closed = true,
              onCreated: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await type(tester, 'har');
    expect(box.query, 'har');
    await press(tester, LogicalKeyboardKey.backspace);
    expect(box.query, 'ha');
    await press(tester, LogicalKeyboardKey.escape);
    expect(box.query, isEmpty, reason: 'Escape gives the text back first.');
    expect(closed, isFalse);
    await press(tester, LogicalKeyboardKey.escape);
    expect(closed, isTrue, reason: 'A second Escape closes.');
  });

  testWidgets('down moves the highlight in the list without resetting it', (
    tester,
  ) async {
    final box = await mount(tester);
    await type(tester, 'harness');
    final first = box.selected?.id;
    await press(tester, LogicalKeyboardKey.arrowDown);
    expect(
      box.selected?.id,
      isNot(first),
      reason: 'Applying each row as it was passed snapped the cursor home.',
    );
    final second = box.selected?.id;
    await press(tester, LogicalKeyboardKey.arrowDown);
    expect(box.selected?.id, isNot(second));
  });

  testWidgets('return takes the highlighted match and clears the search', (
    tester,
  ) async {
    final box = await mount(tester);
    await type(tester, 'harness');
    final wanted = box.selected?.title;
    await press(tester, LogicalKeyboardKey.enter);
    expect(box.query, isEmpty, reason: 'Taking a value ends the search.');
    if (wanted != null) {
      expect(box.projectLabel, contains(wanted));
    }
  });

  testWidgets('the doors lead, and the highlight opens on the first project', (
    tester,
  ) async {
    final box = await mount(tester);
    await type(tester, 'harness');
    expect(
      tester.getTopLeft(find.text('New Project')).dy,
      lessThan(tester.getTopLeft(find.text('harness-monitor')).dy),
      reason: 'The three doors sit above the recents, not under them.',
    );
    expect(
      box.selected?.synthetic,
      isFalse,
      reason: 'The highlight opens on the first real project, not a door.',
    );
  });

  testWidgets('Tab walks the rows and never escapes the form', (tester) async {
    final box = await mount(tester);
    for (var i = 0; i < 3; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pumpAndSettle();
    }
    expect(box.field, NewHarnessField.branch, reason: 'Tab walks the rows.');
    // The real bug: traversal moved focus out and the form went deaf. Up
    // rather than down, since the row under Branch edits no field at all.
    await press(tester, LogicalKeyboardKey.arrowUp);
    expect(
      box.field,
      NewHarnessField.machine,
      reason: 'Keys must still reach the form after Tab.',
    );
  });

  testWidgets('the doors lead, and the highlight opens on the first project', (
    tester,
  ) async {
    final box = await mount(tester);
    await type(tester, 'harness');
    expect(
      tester.getTopLeft(find.text('New Project')).dy,
      lessThan(tester.getTopLeft(find.text('harness-monitor')).dy),
      reason: 'The three doors sit above the recents, not under them.',
    );
    expect(
      box.selected?.synthetic,
      isFalse,
      reason: 'The highlight opens on the first real project, not a door.',
    );
  });

  testWidgets('the doors can be reached and opened', (tester) async {
    final box = await mount(tester);
    await type(tester, 'harness');
    // Walk down past the matches until the highlight lands on a door.
    var guard = 0;
    while (box.selected?.synthetic != true && guard++ < 30) {
      await press(tester, LogicalKeyboardKey.arrowDown);
    }
    expect(
      box.selected?.synthetic,
      isTrue,
      reason: 'A row drawn but unreachable is worse than one not drawn.',
    );
    // New Project opens its own prompt rather than answering the row.
    while (box.selected?.id != NewHarnessController.newProjectId &&
        guard++ < 60) {
      await press(tester, LogicalKeyboardKey.arrowDown);
    }
    await press(tester, LogicalKeyboardKey.enter);
    expect(box.field, NewHarnessField.projectName);
    expect(find.text('New Project'), findsOneWidget);
    // And Escape backs out of the door to the list it came from.
    await press(tester, LogicalKeyboardKey.escape);
    expect(box.field, NewHarnessField.projectMenu);
  });

  testWidgets('the doors are still listed', (tester) async {
    await mount(tester);
    await type(tester, 'harness');
    expect(find.text('Open Folder'), findsOneWidget);
    expect(find.text('New Project'), findsOneWidget);
    expect(find.text('Clone Repository'), findsOneWidget);
  });

  testWidgets('the choices are always listed, and Return makes them live', (
    tester,
  ) async {
    final box = await mount(tester);
    expect(find.text('New Harness'), findsOneWidget);
    expect(
      find.text('Open Folder'),
      findsOneWidget,
      reason: 'The doors are on screen without being searched for.',
    );

    await press(tester, LogicalKeyboardKey.enter);
    expect(box.busy, isFalse, reason: 'A stray Return must not launch.');
    final first = box.selected?.id;
    await press(tester, LogicalKeyboardKey.arrowDown);
    expect(
      box.field,
      NewHarnessField.projectMenu,
      reason: 'With the list live the arrows move in it, not between rows.',
    );
    expect(box.selected?.id, isNot(first));

    // Escape hands the arrows back to the rows; the list stays on screen.
    await press(tester, LogicalKeyboardKey.escape);
    expect(find.text('Open Folder'), findsOneWidget);
    await press(tester, LogicalKeyboardKey.arrowDown);
    expect(box.field, NewHarnessField.agent);
  });

  testWidgets('the selection bar marks which column has the keys', (
    tester,
  ) async {
    final bright = Colors.white.withValues(alpha: .12);
    int barsOn() => tester
        .widgetList<Container>(find.byType(Container))
        .where((box) => box.color == bright)
        .length;

    await mount(tester);
    final choices = find.byKey(const ValueKey('new-harness-choices'));
    expect(
      tester
          .widgetList<Container>(
            find.descendant(of: choices, matching: find.byType(Container)),
          )
          .where((box) => box.color != null && box.color != Colors.transparent),
      isEmpty,
      reason: 'The right column must not highlight a saved value while the left has focus.',
    );
    expect(
      barsOn(),
      1,
      reason: 'At rest the item column holds the only full highlight.',
    );
    await press(tester, LogicalKeyboardKey.enter);
    expect(
      barsOn(),
      1,
      reason: 'Live, the bar moves to the list — it never lights both.',
    );
    expect(harnessChoicesActive(tester), isTrue);
    await press(tester, LogicalKeyboardKey.escape);
    expect(harnessChoicesActive(tester), isFalse);
  });

  testWidgets('the list dims while the items hold the keys', (tester) async {
    final box = await mount(tester);
    // An unselected option stays quieter than the active choice.
    final other = box.options
        .firstWhere((row) => !row.synthetic && !identical(row, box.selected))
        .title;
    Color? inkOf(String text) =>
        tester.widget<Text>(find.text(text)).style?.color;

    expect(
      inkOf(other),
      kBoxFaint,
      reason: 'The column the arrows are not in is grey.',
    );
    await press(tester, LogicalKeyboardKey.enter);
    expect(
      inkOf(other),
      Colors.white70,
      reason: 'Handing the arrows over brings the column up.',
    );
    await press(tester, LogicalKeyboardKey.escape);
    expect(inkOf(other), kBoxFaint);
  });

  testWidgets('the right column follows the focused row', (tester) async {
    await mount(tester);
    expect(find.text('Open Folder'), findsOneWidget);
    await press(tester, LogicalKeyboardKey.arrowDown);
    expect(
      find.text('Open Folder'),
      findsNothing,
      reason: 'Agent has its own choices; it must not show the project doors.',
    );
    expect(find.text('Codex'), findsWidgets);
  });

  testWidgets('creation stays a distinct action while editing values', (
    tester,
  ) async {
    await mount(tester);
    expect(find.text('New Harness'), findsOneWidget);
    expect(
      tester
          .widget<Semantics>(
            find.byKey(const ValueKey('new-harness-field-start')),
          )
          .properties
          .selected,
      isFalse,
    );
  });

  testWidgets('a visible prompt names the search, and shows what is typed', (
    tester,
  ) async {
    await mount(tester);
    expect(
      find.text('Search project'),
      findsOneWidget,
      reason: '"Type to search" in a key guide is a sentence nobody reads.',
    );
    // The caret belongs to the arrows: absent until they are handed over.
    EditableText input() =>
        tester.widget<EditableText>(find.byType(EditableText));
    expect(input().showCursor, isFalse);
    await press(tester, LogicalKeyboardKey.enter);
    expect(input().showCursor, isTrue);
    expect(input().focusNode.hasFocus, isTrue);

    await type(tester, 'harn');
    expect(find.text('harn'), findsOneWidget);
    expect(input().controller.text, 'harn');
    await press(tester, LogicalKeyboardKey.escape);
    await press(tester, LogicalKeyboardKey.escape);
    expect(input().showCursor, isFalse);
    // Worktree is a boolean: no list, so no prompt either.
    await press(tester, LogicalKeyboardKey.escape);
    for (var i = 0; i < 4; i++) {
      await press(tester, LogicalKeyboardKey.arrowDown);
    }
    expect(find.textContaining('Search '), findsNothing);
  });

  testWidgets('the field stays put when its choices open', (tester) async {
    await mount(tester);
    final field = find.byKey(const ValueKey('new-harness-field-project'));
    final before = tester.getRect(field);
    await type(tester, 'harness');
    expect(find.text('harness-monitor'), findsWidgets);
    expect(
      tester.getRect(field),
      before,
      reason: 'Filtering changes choices without moving the field.',
    );
  });

  /// Walk the highlight in the open list until [wanted] holds, so a test
  /// asserts on the row it meant rather than on a position.
  Future<void> highlight(
    WidgetTester tester,
    NewHarnessController box,
    bool Function(NewHarnessOption row) wanted,
  ) async {
    for (var step = 0; step < 40; step++) {
      final row = box.selected;
      if (row != null && wanted(row)) return;
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pumpAndSettle();
    }
    fail('Never reached the wanted row.');
  }

  testWidgets('Open Folder asks the app to browse', (tester) async {
    var browsed = false;
    final app = createApp(connectionForTest: (_) => _Git());
    seedMixedAgents(app);
    await app.projectHistory.select('m', '/work/harness-app-landing-page');
    final box = NewHarnessController(app, machineId: 'm', folder: '/work/a');
    addTearDown(app.dispose);
    addTearDown(box.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: Scaffold(
          body: SizedBox(
            width: 820,
            height: 450,
            child: NewHarnessForm(
              controller: box,
              onClose: () {},
              onCreated: () {},
              onBrowse: () => browsed = true,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await type(tester, 'harness');
    // "Open Folder" in the menu opens a path prompt; the chooser itself is
    // a row inside THAT list, which must be on screen before anything typed.
    await highlight(
      tester,
      box,
      (row) => row.id == NewHarnessController.existingProjectId,
    );
    await press(tester, LogicalKeyboardKey.enter);
    expect(box.field, NewHarnessField.project);
    await highlight(
      tester,
      box,
      (row) => row.id == NewHarnessController.browseId,
    );
    await press(tester, LogicalKeyboardKey.enter);
    expect(browsed, isTrue, reason: 'Open Folder must reach the chooser.');
  });

  testWidgets('New Project names a project and takes it', (tester) async {
    final box = await mount(tester);
    await press(tester, LogicalKeyboardKey.enter);
    await highlight(
      tester,
      box,
      (row) => row.id == NewHarnessController.newProjectId,
    );
    await press(tester, LogicalKeyboardKey.enter);
    expect(box.field, NewHarnessField.projectName);
    await type(tester, 'ledger');
    await press(tester, LogicalKeyboardKey.enter);
    expect(
      box.projectLabel,
      contains('ledger'),
      reason: 'Naming a project must actually set it.',
    );
  });

  testWidgets('Clone opens the repository prompt', (tester) async {
    final box = await mount(tester);
    await type(tester, 'harness');
    await highlight(
      tester,
      box,
      (row) => row.id == NewHarnessController.repositoryId,
    );
    await press(tester, LogicalKeyboardKey.enter);
    expect(box.field, NewHarnessField.projectRepository);
    expect(find.text('Repository'), findsOneWidget);
  });

  testWidgets('a new branch name can be created from the Branch row', (
    tester,
  ) async {
    final box = await mount(tester);
    for (var i = 0; i < 3; i++) {
      await press(tester, LogicalKeyboardKey.arrowDown);
    }
    expect(box.field, NewHarnessField.branch);
    await type(tester, 'spike');
    await highlight(
      tester,
      box,
      (row) => row.id.startsWith(NewHarnessController.createBranchId),
    );
    await press(tester, LogicalKeyboardKey.enter);
    expect(
      box.branchRowLabel,
      contains('spike'),
      reason: 'Create branch is an answer, not a door.',
    );
  });

  testWidgets('the worktree row reads as a question', (tester) async {
    final box = await mount(tester);
    expect(find.text('Worktree'), findsOneWidget);
    expect(find.text('Yes'), findsOneWidget);
    for (var i = 0; i < 4; i++) {
      await press(tester, LogicalKeyboardKey.arrowDown);
    }
    await press(tester, LogicalKeyboardKey.arrowRight);
    expect(box.worktree, isFalse);
    expect(find.text('No'), findsOneWidget);
  });

  testWidgets('Profile follows the chosen agent and hidden rows are skipped', (
    tester,
  ) async {
    final box = await mount(tester, engine: 'codex');
    expect(find.text('Profile'), findsOneWidget);
    await press(tester, LogicalKeyboardKey.arrowDown);
    await type(tester, 'claude');
    expect(box.engine, 'codex');
    expect(find.text('Profile'), findsOneWidget);
    await press(tester, LogicalKeyboardKey.enter);
    expect(box.engine, 'claude');
    expect(find.text('Profile'), findsNothing);

    for (var i = 0; i < 4; i++) {
      await press(tester, LogicalKeyboardKey.arrowDown);
    }
    expect(box.field, NewHarnessField.mode);
    await press(tester, LogicalKeyboardKey.tab);
    expect(
      tester
          .widget<Semantics>(
            find.byKey(const ValueKey('new-harness-field-start')),
          )
          .properties
          .selected,
      isTrue,
    );
    await press(tester, LogicalKeyboardKey.arrowUp);
    expect(
      tester
          .widget<Semantics>(
            find.byKey(const ValueKey('new-harness-field-approvals')),
          )
          .properties
          .selected,
      isTrue,
    );

    for (var i = 0; i < 4; i++) {
      await press(tester, LogicalKeyboardKey.arrowUp);
    }
    await type(tester, 'codex');
    expect(find.text('Profile'), findsNothing);
    await press(tester, LogicalKeyboardKey.enter);
    expect(box.engine, 'codex');
    expect(find.text('Profile'), findsOneWidget);
  });

  testWidgets('typing moves keyboard focus from fields to choices', (
    tester,
  ) async {
    await mount(tester);
    expect(harnessChoicesActive(tester), isFalse);
    await type(tester, 'harness');
    expect(harnessChoicesActive(tester), isTrue);
    expect(find.text('Select Item'), findsNothing);
  });
}
