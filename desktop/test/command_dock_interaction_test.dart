import 'support/launch_menu.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/box_chrome.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'swarm_screen_test.dart' show terminal;
import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  setUp(() => newHarnessOpensInBox = true);
  tearDown(() => newHarnessOpensInBox = false);

  testWidgets(
    'launch arrows edit the highlighted field without starting an agent',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      addTearDown(app.dispose);
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      final frames = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', frames));
      await configured.mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      final box = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      final original = (box.engine, box.machineId, box.project);
      final paneCount = app.activeSwarm.panes.length;
      void highlighted(String name) {
        final row = find.byKey(ValueKey('new-harness-field-$name'));
        expect(row.hitTestable(), findsOneWidget);
        final highlight = tester.widget<BoxRowHighlight>(
          find.ancestor(of: row, matching: find.byType(BoxRowHighlight)),
        );
        expect(highlight.highlighted, isTrue);
        expect(box.field, NewHarnessField.launch);
      }

      highlighted('create');
      for (final letter in [
        LogicalKeyboardKey.keyA,
        LogicalKeyboardKey.keyM,
        LogicalKeyboardKey.keyP,
        LogicalKeyboardKey.keyT,
        LogicalKeyboardKey.keyO,
        LogicalKeyboardKey.keyG,
      ]) {
        await key(tester, letter);
        highlighted('create');
      }
      // Down wraps from the bottom action into the arguments in visual order.
      for (final (steps, name, field) in [
        (1, 'agent', NewHarnessField.agent),
        (2, 'machine', NewHarnessField.machine),
        (3, 'project', NewHarnessField.projectMenu),
      ]) {
        for (var i = 0; i < steps; i++) {
          await key(tester, LogicalKeyboardKey.arrowDown);
        }
        highlighted(name);
        await key(tester, LogicalKeyboardKey.enter);
        expect(box.field, field);
        await key(tester, LogicalKeyboardKey.escape);
        highlighted('create');
      }
      await key(tester, LogicalKeyboardKey.arrowUp);
      highlighted('worktree');
      await key(tester, LogicalKeyboardKey.arrowUp);
      highlighted('project');
      expect(
        find.byKey(const ValueKey('new-harness-field-options')),
        findsNothing,
      );
      await openLaunchRow(tester, 'agent');
      await openAgentSetting(
        tester,
        box.selected!.engine!,
        NewHarnessController.permissionsId,
      );
      expect(box.field, NewHarnessField.mode);
      expect(find.byKey(const Key('new-agent-task')), findsNothing);
      await tester.enterText(
        find.byKey(const ValueKey('new-harness-input')),
        'ask',
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.field, NewHarnessField.agent);
      expect(box.mode, 'ask');
      await key(tester, LogicalKeyboardKey.escape);
      highlighted('create');
      expect(find.textContaining('Ask first'), findsOneWidget);
      expect((box.engine, box.machineId, box.project), original);
      expect(app.activeSwarm.panes, hasLength(paneCount));
      expect(frames, isEmpty);

      // Navigation obeys the same live picker remaps as the child lists.
      map.apply('''{"bindings":[
      {"keys":"down","command":null,"when":"picker"},
      {"keys":"ctrl+j","command":"picker.next","when":"picker"}
    ]}''');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.arrowDown);
      highlighted('create');
      await key(tester, LogicalKeyboardKey.keyJ, ctrl: true);
      highlighted('agent');
      await key(tester, LogicalKeyboardKey.arrowUp);
      highlighted('create');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Machine returns to its source menu and project search stays on that machine',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      addTearDown(app.dispose);
      await app.projectHistory.select('studio', '/work/remote-project');
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      final frames = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', frames));
      await configured.mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      final box = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      final original = box.project;
      final input = find.byKey(const ValueKey('new-harness-input'));
      await openLegacyTaskEditor(tester);
      await tester.enterText(input, 'Inspect the project');
      await key(tester, LogicalKeyboardKey.escape);
      await openLaunchRow(tester, 'machine');
      await tester.enterText(input, 'Office');
      await key(tester, LogicalKeyboardKey.escape);
      expect(box.field, NewHarnessField.launch);
      expect(box.machineId, 'm');
      expect(box.project, original);
      await openLaunchRow(tester, 'machine');
      await tester.enterText(input, 'Office');
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.field, NewHarnessField.launch);
      expect(box.machineId, 'studio');
      expect(box.needsProject, isTrue);
      await openLaunchRow(tester, 'project');
      final remoteRow = box.options.singleWhere(
        (row) => row.project?.folder == '/work/remote-project',
      );
      expect(find.text('remote-project').hitTestable(), findsOneWidget);
      await tester.enterText(input, 'remote-project');
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.field, NewHarnessField.launch);
      expect(box.project.folder, '/work/remote-project');
      await openLaunchRow(tester, 'machine');
      await tester.enterText(input, 'M2');
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.project, original);
      expect(box.task, 'Inspect the project');
      await openLaunchRow(tester, 'project');
      box.accept(remoteRow);
      expect(box.error, contains('machine has changed'));
      expect(box.machineId, 'm');
      map.apply('''{"bindings":[
        {"keys":"m","command":null,"when":"picker"},
        {"keys":"u","command":"creation.project_machine","when":"picker"},
        {"keys":"ctrl+r","command":"creation.project_recent_1","when":"project"}
      ]}''');
      await tester.pump();
      await tester.enterText(input, 'robotics');
      await key(tester, LogicalKeyboardKey.keyR, ctrl: true);
      expect(box.field, NewHarnessField.launch);
      expect(box.project.folder, '/work/robotics');
      await key(tester, LogicalKeyboardKey.keyM);
      expect(box.field, NewHarnessField.launch);
      await key(tester, LogicalKeyboardKey.keyU);
      expect(box.field, NewHarnessField.machine);
      await key(tester, LogicalKeyboardKey.escape);
      await openLaunchRow(tester, 'project');
      await tester.enterText(input, 'robotics');
      await key(tester, LogicalKeyboardKey.keyU);
      expect(box.field, NewHarnessField.projectMenu);
      await tester.tap(
        find.byKey(const ValueKey('new-harness-change-machine')),
      );
      await tester.pump();
      expect(box.field, NewHarnessField.machine);
      await key(tester, LogicalKeyboardKey.escape);
      expect(box.field, NewHarnessField.projectMenu);
      expect(box.query, 'robotics');
      expect(frames, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Project keeps its actions visible and scopes each prompt to its intent',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      addTearDown(app.dispose);
      for (var i = 0; i < 40; i++) {
        await app.projectHistory.select('m', '/work/project-$i');
      }
      await app.projectHistory.select('studio', '/work/office-only');
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      final frames = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', frames));
      await configured.mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      final box = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      final original = box.project;
      final input = find.byKey(const ValueKey('new-harness-input'));
      await openLaunchRow(tester, 'project');
      expect(box.field, NewHarnessField.projectMenu);
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      for (final label in [
        'New Project',
        'Open Folder',
        'Clone GitHub Repository',
      ]) {
        expect(find.text(label).hitTestable(), findsOneWidget);
      }
      expect(
        find.byKey(const ValueKey('new-harness-change-machine')).hitTestable(),
        findsOneWidget,
      );
      expect(box.options.where((row) => !row.synthetic), hasLength(43));
      expect(box.selected!.project, original);
      for (final shortcut in ['1', '9', 'n', 'o', 'g']) {
        expect(find.text(shortcut), findsNothing);
      }
      final openRow = find.byKey(
        const ValueKey(NewHarnessController.existingProjectId),
      );
      final newRow = find.byKey(
        const ValueKey(NewHarnessController.newProjectId),
      );
      final openBounds = tester.getRect(openRow);
      expect(tester.getRect(newRow).bottom, lessThanOrEqualTo(openBounds.top));
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(box.selected!.id, NewHarnessController.newProjectId);
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(box.selected!.id, NewHarnessController.existingProjectId);
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(box.selected!.id, NewHarnessController.repositoryId);
      final cloneRow = find.byKey(
        const ValueKey(NewHarnessController.repositoryId),
      );
      expect(
        tester.getRect(openRow).bottom,
        lessThanOrEqualTo(tester.getRect(cloneRow).top),
      );
      expect(
        tester.getRect(cloneRow).bottom,
        lessThanOrEqualTo(tester.getRect(input).top),
      );
      // Older recents scroll; project actions remain anchored beside the footer.
      for (var i = 0; i < 5; i++) {
        await key(tester, LogicalKeyboardKey.pageUp);
      }
      await tester.pump();
      expect(box.cursor, greaterThan(12));
      expect(
        find.byKey(ValueKey(box.selected!.id)).hitTestable(),
        findsOneWidget,
      );
      expect(tester.getRect(openRow), openBounds);
      final previousSize = tester.view.physicalSize;
      final selectedProject = box.selected!.id;
      tester.view.physicalSize = const Size(600, 680);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpAndSettle();
      expect(box.selected!.id, selectedProject);
      expect(
        find.byKey(ValueKey(selectedProject)).hitTestable(),
        findsOneWidget,
      );
      expect(openRow.hitTestable(), findsOneWidget);
      tester.view.physicalSize = previousSize;
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await tester.pumpAndSettle();
      // Letters and digits belong to the search, not hidden action shortcuts.
      for (final ordinary in [
        LogicalKeyboardKey.keyN,
        LogicalKeyboardKey.keyO,
        LogicalKeyboardKey.keyG,
        LogicalKeyboardKey.keyM,
        LogicalKeyboardKey.digit1,
        LogicalKeyboardKey.digit9,
      ]) {
        await key(tester, ordinary);
        expect(box.field, NewHarnessField.projectMenu);
      }
      await tester.enterText(input, 'nogm19');
      await tester.pump();
      expect(box.query, 'nogm19');
      expect(box.options, hasLength(3));
      expect(find.text('No projects match “nogm19”'), findsOneWidget);
      for (final label in [
        'New Project',
        'Open Folder',
        'Clone GitHub Repository',
      ]) {
        expect(find.text(label).hitTestable(), findsOneWidget);
      }
      await tester.enterText(input, 'project-9');
      await tester.pump();
      expect(box.selected!.project!.folder, '/work/project-9');
      expect(
        find.byKey(ValueKey(box.selected!.id)).hitTestable(),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.project.folder, '/work/project-9');
      expect(box.field, NewHarnessField.launch);
      box.setFolder(original.folder!);
      await openLaunchRow(tester, 'project');
      expect(box.query, isEmpty);
      await tester.enterText(input, 'office-only');
      await tester.pump();
      expect(box.options.where((row) => !row.synthetic), isEmpty);
      expect(box.selected!.id, NewHarnessController.existingProjectId);
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.field, NewHarnessField.project);
      expect(box.options.single.id, NewHarnessController.browseId);
      await tester.enterText(input, 'new project');
      await tester.pump();
      expect(box.options.any((row) => row.id == 'project:new'), isFalse);
      expect(box.project, original);
      await key(tester, LogicalKeyboardKey.escape);
      expect(box.query, 'office-only');
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(box.selected!.id, NewHarnessController.repositoryId);
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.field, NewHarnessField.projectRepository);
      await tester.enterText(input, 'https://example.com/owner/repo');
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      expect(box.error, contains('GitHub URL'));
      expect(box.project, original);
      await tester.enterText(input, 'acme/payments');
      await key(tester, LogicalKeyboardKey.keyM);
      expect(box.field, NewHarnessField.projectRepository);
      await key(tester, LogicalKeyboardKey.enter);
      expect(
        box.project.repository!.url,
        'https://github.com/acme/payments.git',
      );
      expect(box.field, NewHarnessField.launch);
      await openLaunchRow(tester, 'machine');
      await tester.enterText(input, 'Office');
      await key(tester, LogicalKeyboardKey.enter);
      await openLaunchRow(tester, 'project');
      expect(box.machineId, 'studio');
      expect(
        box.options
            .where((row) => row.project != null)
            .every((row) => row.machineId == 'studio'),
        isTrue,
      );
      await tester.enterText(input, 'office-only');
      await tester.pump();
      expect(box.selected!.project!.folder, '/work/office-only');
      // Explicit custom bindings remain available without reserving search text.
      map.apply(
        '{"bindings":[{"keys":"ctrl+r","command":"creation.project_new","when":"project"}]}',
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyR, ctrl: true);
      expect(box.field, NewHarnessField.projectName);
      await tester.enterText(input, 'payments processing');
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.project.name, 'payments processing');
      expect(
        box.projectLocation,
        'iMac · Office:~/harnesses/payments-processing',
      );
      // The full form remains available through its compatibility shortcut.
      await key(tester, LogicalKeyboardKey.period, cmd: true);
      expect(find.byKey(const Key('new-agent-task')), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      expect(frames, isEmpty);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Pi and Codex both use the compact launch form', (tester) async {
    final app = createApp();
    seedMixedAgents(app);
    addTearDown(app.dispose);
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    await configured.mount(tester, app, map);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    final box = tester
        .widget<NewHarnessBox>(find.byType(NewHarnessBox))
        .controller;
    final input = find.byKey(const ValueKey('new-harness-input'));
    for (final agent in ['pi', 'codex']) {
      await openLaunchRow(tester, 'agent');
      await tester.enterText(input, agent);
      box.accept(box.options.firstWhere((row) => row.id == agent));
      await tester.pump();
      expect(
        find.byKey(const ValueKey('new-harness-field-task')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('new-harness-field-placement')),
        findsNothing,
      );
      expect(find.text('Start Harness'), findsOneWidget);
    }
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'launch keys are remappable and remain text in an argument prompt',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      addTearDown(app.dispose);
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      map.apply(
        '{"bindings":[{"keys":"a","command":null,"when":"picker"},{"keys":"e","command":"creation.agent","when":"picker"}]}',
      );
      final frames = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', frames));
      await configured.mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      final box = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      expect(box.field, NewHarnessField.launch);
      await key(tester, LogicalKeyboardKey.keyA);
      expect(box.field, NewHarnessField.launch);
      await key(tester, LogicalKeyboardKey.keyE);
      expect(box.field, NewHarnessField.agent);
      // The menu action must not steal letters while editing or searching.
      await key(tester, LogicalKeyboardKey.keyP);
      await key(tester, LogicalKeyboardKey.keyT);
      await key(tester, LogicalKeyboardKey.keyO);
      await key(tester, LogicalKeyboardKey.keyE);
      expect(box.field, NewHarnessField.agent);
      final input = find.byKey(const ValueKey('new-harness-input'));
      await tester.enterText(input, 'OpenCode');
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.engine, 'opencode');
      expect(box.field, NewHarnessField.launch);
      await openLegacyTaskEditor(tester);
      await tester.enterText(input, 'a project to open');
      await key(tester, LogicalKeyboardKey.escape);
      expect(box.task, 'a project to open');
      expect(box.field, NewHarnessField.launch);
      await key(tester, LogicalKeyboardKey.escape);
      expect(find.byType(NewHarnessBox), findsNothing);
      expect(frames, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final size in [const Size(1440, 1000), const Size(900, 560)]) {
    testWidgets('recent sessions fill the available dock at $size', (
      tester,
    ) async {
      final app = createApp();
      addTearDown(app.dispose);
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      app.adoptSessionForTest(terminal('a69', []));
      await configured.mount(tester, app, map);
      tester.view.physicalSize = size;
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyO, cmd: true);
      final results = tester.widget<SwarmSearchResults>(
        find.byType(SwarmSearchResults),
      );
      final list = tester.getRect(
        find.byKey(const ValueKey('swarm-search-result-list')),
      );
      final visible = results.search.rows.where((row) {
        if (row.isCreate) return false;
        final finder = find.byKey(ValueKey(row.id));
        if (finder.evaluate().isEmpty) return false;
        final bounds = tester.getRect(finder);
        return bounds.top >= list.top - 1 && bounds.bottom <= list.bottom + 1;
      }).length;
      if (size.height >= 1000) {
        expect(visible, 10);
      } else {
        expect(visible, inInclusiveRange(1, 10));
      }
      expect(
        find.byKey(const ValueKey('swarm-search-input')).hitTestable(),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('create:harness')).hitTestable(),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('swarm-search-hints')).hitTestable(),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
    });
  }

  for (final size in [const Size(1280, 800), const Size(600, 700)]) {
    testWidgets(
      'dock pins creation beside its input while matches filter at $size',
      (tester) async {
        final app = createApp();
        addTearDown(app.dispose);
        final map = MemoryKeymap();
        addTearDown(map.dispose);
        final frames = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('a69', frames));
        app.renameSwarm(app.activeSwarmId, 'Feature work');
        await configured.mount(tester, app, map);
        tester.view.physicalSize = size;
        await tester.pump();
        final paneBounds = tester.getRect(find.byKey(pane.cellKey));
        await key(tester, LogicalKeyboardKey.keyO, cmd: true);
        final input = find.byKey(const ValueKey('swarm-search-input'));
        final preview = find.byKey(const ValueKey('swarm-search-preview'));
        expect(find.text('· Feature work'), findsNothing);
        // The create row already explains itself; only real agents need preview.
        expect(preview, findsNothing);
        await tester.enterText(input, 'Agent 1');
        await tester.pump();
        final search = tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search;
        final best = search.selected!;
        expect(best.agentId, 'a1');
        final bestRow = find.byKey(ValueKey(best.id));
        final queryBounds = tester.getRect(input);
        final matchBounds = tester.getRect(bestRow);
        final createRow = find.byKey(const ValueKey('create:harness'));
        final createBounds = tester.getRect(createRow);
        expect(queryBounds.top - createBounds.bottom, inInclusiveRange(0, 12));
        expect(matchBounds.bottom, lessThanOrEqualTo(createBounds.top + .001));
        expect(search.rows.first.isCreate, isTrue);
        expect(search.rows.first.task, 'Agent 1');
        expect(preview, findsOneWidget);
        if (size.width < 800) {
          expect(
            tester.getRect(preview).bottom,
            lessThan(tester.getRect(bestRow).top),
          );
        } else {
          expect(tester.getRect(preview).left, greaterThan(matchBounds.right));
          expect(
            tester
                .getSize(find.byKey(const ValueKey('swarm-search-results')))
                .height,
            lessThan(size.height * .65),
          );
        }
        await key(tester, LogicalKeyboardKey.slash, ctrl: true);
        expect(preview, findsNothing);
        expect(search.selected, same(best));
        expect(
          tester.getRect(input),
          rectMoreOrLessEquals(queryBounds, epsilon: .001),
        );
        await key(tester, LogicalKeyboardKey.slash, ctrl: true);
        expect(preview, findsOneWidget);
        expect(
          tester.getRect(input),
          rectMoreOrLessEquals(queryBounds, epsilon: .001),
        );
        await key(tester, LogicalKeyboardKey.arrowUp);
        expect(search.cursor, 2);
        final selectedRow = find.byKey(ValueKey(search.selected!.id));
        expect(selectedRow.hitTestable(), findsOneWidget);
        if (bestRow.evaluate().isNotEmpty) {
          expect(
            tester.getRect(selectedRow).center.dy,
            lessThan(tester.getRect(bestRow).center.dy),
          );
        }
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(search.selected, same(best));
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(search.selected!.isCreate, isTrue);
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(
          search.selected!.isCreate,
          isTrue,
          reason: 'Do not wrap at the edge',
        );
        await key(tester, LogicalKeyboardKey.keyK, ctrl: true);
        expect(search.selected, same(best));
        await key(tester, LogicalKeyboardKey.keyJ, ctrl: true);
        expect(search.selected!.isCreate, isTrue);
        expect(
          tester.getRect(createRow),
          rectMoreOrLessEquals(createBounds, epsilon: .001),
        );
        await tester.drag(
          find.byKey(const ValueKey('swarm-search-result-list')),
          const Offset(0, 180),
        );
        await tester.pumpAndSettle();
        expect(
          tester.getRect(createRow),
          rectMoreOrLessEquals(createBounds, epsilon: .001),
        );
        await tester.enterText(input, '');
        await tester.pump();
        expect(
          tester.getRect(createRow),
          rectMoreOrLessEquals(createBounds, epsilon: .001),
        );
        await key(tester, LogicalKeyboardKey.tab);
        expect(
          FocusManager.instance.primaryFocus?.context
              ?.findAncestorWidgetOfExactType<ListTile>()
              ?.key,
          const ValueKey('create:harness'),
          reason: 'Tab reaches the pinned action next to the query first',
        );
        expect(tester.getRect(find.byKey(pane.cellKey)), paneBounds);
        await key(tester, LogicalKeyboardKey.escape);
        await key(tester, LogicalKeyboardKey.arrowLeft);
        expect(frames.single.bytes, [27, 91, 68]);
        await tester.pump(const Duration(milliseconds: 100));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'creation choices follow spatial keys while task arrows edit text',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      await configured.mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      final input = find.byKey(const ValueKey('new-harness-input'));
      final box = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      box.setFolder("/work/project");
      box.focusField(NewHarnessField.task);
      await tester.pump();
      await tester.enterText(input, 'First line\nSecond line');
      await tester.pump();
      expect(box.task, 'First line\nSecond line');
      await key(tester, LogicalKeyboardKey.arrowUp);
      expect(box.task, 'First line\nSecond line');
      final editor = tester.widget<TextField>(input);
      expect(editor.controller!.selection.baseOffset, lessThan(11));
      await key(tester, LogicalKeyboardKey.escape);
      await openLaunchRow(tester, 'agent');
      expect(box.task, 'First line\nSecond line');
      await tester.enterText(input, 'c');
      await tester.pump();
      expect(box.options.length, greaterThan(1));
      expect(box.cursor, 0);
      final first = box.selected!;
      final order = box.options.map((row) => row.id).toList();
      final firstBounds = tester.getRect(find.byKey(ValueKey(first.id)));
      await key(tester, LogicalKeyboardKey.arrowUp);
      expect(box.cursor, 1);
      expect(box.options.map((row) => row.id), order);
      expect(tester.getRect(find.byKey(ValueKey(first.id))), firstBounds);
      expect(find.text('Permissions'), findsNothing);
      expect(find.text('Codex Profile'), findsNothing);
      expect(
        tester.getRect(find.byKey(ValueKey(box.selected!.id))).center.dy,
        lessThan(firstBounds.center.dy),
      );
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(box.selected!.id, first.id);
      expect(tester.getRect(find.byKey(ValueKey(first.id))), firstBounds);
      await key(tester, LogicalKeyboardKey.enter);
      expect(box.field, NewHarnessField.launch);
      expect(box.task, 'First line\nSecond line');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
