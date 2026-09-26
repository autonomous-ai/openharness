import 'support/open_harness.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/swarm_search_input.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/search_result_text.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _CatalogMachine extends MachineState {
  _CatalogMachine(super.machine);
  var projectReads = 0;

  @override
  AgentProject? projectOf(Agent agent) {
    projectReads++;
    return super.projectOf(agent);
  }
}

void main() {
  for (final add in [true]) {
    testWidgets(
      'reopened ${add ? 'Add' : 'Navigate'} sees changed metadata and membership',
      (tester) async {
        final app = createApp();
        final machine = app.machineStates['m']!;
        machine.nodeOnline = true;
        const original = Agent(
          id: 'a0',
          name: 'Original agent',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'Workbench',
            cwd: '/work/workbench',
            branch: 'before-branch',
          ),
        );
        machine.agents = [
          original,
          ...machine.agents.where((agent) => agent.id != original.id),
        ];
        final input = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(terminal('a0', input));
        final source = app.activeSwarm;
        app.newSwarm();
        app.adoptSessionForTest(terminal('a69', input));
        final target = app.activeSwarm;
        await mount(tester, app);
        final field = find.byKey(const ValueKey('swarm-search-input'));
        Future<void> open() => chord(tester, LogicalKeyboardKey.keyP);
        SwarmSearchKeys keys() => tester.widget<SwarmSearchKeys>(
          find.ancestor(of: field, matching: find.byType(SwarmSearchKeys)),
        );
        await open();
        await tester.enterText(field, 'before-branch');
        await tester.pump();
        expect(
          keys().search!.rows.singleWhere((row) => row.agentId == 'a0').title,
          'Original agent',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();

        await app.addAgentToSwarm('m', 'a0', swarmId: target.id);
        machine.agents = [
          const Agent(
            id: 'a0',
            name: 'Latest agent',
            engine: 'codex',
            terminalAvailable: true,
            project: AgentProject(
              name: 'Workbench',
              cwd: '/work/workbench',
              branch: 'after-branch',
            ),
          ),
          ...machine.agents.where((agent) => agent.id != original.id),
        ];
        machine.nodeOnline = false;
        app.renameSwarm(source.id, 'Renamed swarm');
        await tester.pump();
        await open();
        await tester.enterText(field, 'after-branch');
        await tester.pump();
        final search = keys().search!;
        final rows = search.rows.where((row) => row.agentId == 'a0');
        expect(rows, hasLength(add ? 1 : 2));
        expect(rows.every((row) => row.title == 'Latest agent'), isTrue);
        expect(rows.every((row) => row.detail.contains('Offline')), isTrue);
        expect(search.targetId, target.id);
        if (add) {
          expect(search.alreadyHere(rows.single), isTrue);
          expect(search.canSubmit(rows.single), isFalse);
          expect(search.sessionUnavailable(rows.single), 'Offline');
          expect(search.actionLabel(rows.single), 'Focus pane');
        } else {
          expect(rows.map((row) => row.swarmId).toSet(), {
            source.id,
            target.id,
          });
          expect(
            rows.singleWhere((row) => row.swarmId == source.id).swarmName,
            'Renamed swarm',
          );
        }
        await tester.enterText(field, 'before-branch');
        await tester.pump();
        expect(search.rows.where((row) => row.agentId == 'a0'), isEmpty);
        expect(input, isEmpty);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  testWidgets(
    'reopening Add reuses the catalog and previews without reading terminal output',
    (tester) async {
      final app = createApp();
      final machine = _CatalogMachine(app.machineStates['m']!.machine)
        ..agents = app.machineStates['m']!.agents
        ..nodeOnline = true;
      app.machineStates['m'] = machine;
      final input = <TerminalBinaryFrame>[];
      final session = terminal('a0', input);
      session.terminal.write('Earlier useful output.\r\n');
      app.adoptSessionForTest(session);
      app.newSwarm();
      app.adoptSessionForTest(terminal('a69', input));
      await mount(tester, app);
      final field = find.byKey(const ValueKey('swarm-search-input'));
      SwarmSearchInput inputWidget() => tester.widget<SwarmSearchInput>(
        find.ancestor(of: field, matching: find.byType(SwarmSearchInput)),
      );
      await openHarnessPicker(tester);
      await tester.enterText(field, 'Agent 0');
      await tester.pump();
      final first = inputWidget().search!;
      final oldRow = first.selected!;
      expect(oldRow.agentId, 'a0');
      expect(
        find.byKey(const ValueKey('swarm-search-preview')),
        findsOneWidget,
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      session.terminal.write('Newest useful output.\r\n');
      machine.projectReads = 0;
      await openHarnessPicker(tester);
      expect(tester.widget<TextField>(field).controller!.text, isEmpty);
      await tester.enterText(field, 'Agent 0');
      await tester.pump();
      final next = inputWidget().search!;
      expect(find.textContaining('Newest useful output.'), findsNothing);
      expect(next.selected, same(oldRow));
      expect(
        machine.projectReads,
        lessThan(12),
        reason: 'Only visible preview members read metadata; the catalog remains cached.',
      );
      expect(input, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  for (final native in [false, true]) {
    for (final add in [false, true]) {
      testWidgets(
        '${add ? 'Add' : 'Commands'} opening and cancel keep the canvas built (native $native)',
        (tester) async {
          const channel = MethodChannel('harness/swarm_tabs');
          final messenger = tester.binding.defaultBinaryMessenger;
          messenger.setMockMethodCallHandler(channel, (_) async => null);
          addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
          final app = createApp();
          final input = <TerminalBinaryFrame>[];
          app.adoptSessionForTest(terminal('a69', input));
          await mount(tester, app, nativeTabs: native);
          final terminalView = tester.widget<TerminalView>(
            find.byType(TerminalView),
          );
          var canvasBuilds = 0;
          debugOnRebuildDirtyWidget = (element, _) {
            if (element.widget is SwarmScreen) canvasBuilds++;
          };
          try {
            if (add) {
              await openHarnessPicker(tester);
            } else {
              await chord(tester, LogicalKeyboardKey.keyP, shift: true);
            }
            expect(
              tester
                  .widget<TextField>(
                    find.byKey(const ValueKey('swarm-search-input')),
                  )
                  .focusNode!
                  .hasFocus,
              isTrue,
            );
            expect(canvasBuilds, 0, reason: 'The canvas did not change');
            await tester.sendKeyEvent(LogicalKeyboardKey.escape);
            await tester.pump();
            expect(canvasBuilds, 0, reason: 'Cancel only removes the overlay');
          } finally {
            debugOnRebuildDirtyWidget = null;
          }
          expect(terminalView.focusNode!.hasFocus, isTrue);
          expect(
            tester.widget<TerminalView>(find.byType(TerminalView)).controller,
            same(terminalView.controller),
          );
          expect(input, isEmpty);
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
          await tester.pump();
          expect(input.single.bytes, [27, 91, 68]);
          await tester.pumpWidget(const SizedBox());
          app.dispose();
        },
      );
    }
  }

  testWidgets('Add arrow movement rebuilds only the changed result rows', (
    tester,
  ) async {
    final app = createApp();
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a69', input));
    await mount(tester, app);
    await openHarnessPicker(tester);
    final field = find.byKey(const ValueKey('swarm-search-input'));
    await tester.enterText(field, 'Agent');
    await tester.pump(const Duration(milliseconds: 200));
    final search = tester
        .widget<SwarmSearchInput>(
          find.ancestor(of: field, matching: find.byType(SwarmSearchInput)),
        )
        .search!;
    final previous = search.selected!.id;
    final visibleRows = find.byType(InkWell).evaluate().where((element) {
      final key = element.widget.key;
      return key is ValueKey<String> && key.value.startsWith('agent:');
    }).toSet();
    expect(visibleRows, isNotEmpty);
    var fields = 0;
    var rows = 0;
    debugOnRebuildDirtyWidget = (element, _) {
      if (element.widget is TextField) fields++;
      if (element.widget is InkWell && visibleRows.contains(element)) rows++;
    };
    try {
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
    } finally {
      debugOnRebuildDirtyWidget = null;
    }
    expect(search.selected!.id, isNot(previous));
    expect(
      fields,
      0,
      reason: 'Moving the highlight does not change the editor',
    );
    expect(rows, 2, reason: 'Only the old and new existing highlights changed');
    final selected = tester
        .element(find.byKey(ValueKey(search.selected!.id)))
        .findAncestorWidgetOfExactType<Semantics>()!;
    expect(selected.properties.selected, isTrue);
    expect(find.byKey(const ValueKey('swarm-search-count')), findsNothing);
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(input, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'query edits update match text without rebuilding unchanged row controls',
    (tester) async {
      final app = createApp();
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a69', input));
      await mount(tester, app);
      await openHarnessPicker(tester);
      final field = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(field, 'Agent');
      await tester.pump(const Duration(milliseconds: 200));
      final visibleRows = find.byType(InkWell).evaluate().where((element) {
        final key = element.widget.key;
        return key is ValueKey<String> && key.value.startsWith('agent:');
      }).toSet();
      expect(visibleRows, isNotEmpty);
      var rowBuilds = 0;
      debugOnRebuildDirtyWidget = (element, _) {
        if (element.widget is InkWell && visibleRows.contains(element)) {
          rowBuilds++;
        }
      };
      try {
        await tester.enterText(field, 'Agen');
        await tester.pump();
      } finally {
        debugOnRebuildDirtyWidget = null;
      }
      expect(
        rowBuilds,
        0,
        reason: 'Only match text changed on these same result rows',
      );
      final matches = tester
          .widgetList<SearchResultText>(find.byType(SearchResultText))
          .where((widget) => widget.text.startsWith('Agent '))
          .expand((widget) => widget.matches.where((match) => match.title))
          .map((match) => match.term)
          .toSet();
      expect(matches, {'agen'});
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(input, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'cached Add rows keep selection through palette and text changes',
    (tester) async {
      final app = createApp();
      final originalPalette = grid.AppTheme.palette.value;
      addTearDown(() => grid.AppTheme.palette.value = originalPalette);
      app.adoptSessionForTest(terminal('a69', []));
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpWidget(
        grid.BrightnessScope(
          child: MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: SwarmScreen(notifier: app, nativeTabs: false),
          ),
        ),
      );
      await openHarnessPicker(tester);
      final field = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(field, 'Agent');
      await tester.pump();
      final search = tester
          .widget<SwarmSearchInput>(
            find.ancestor(of: field, matching: find.byType(SwarmSearchInput)),
          )
          .search!;
      final row = find.byKey(ValueKey(search.selected!.id));
      expect(find.byType(Checkbox), findsNothing);
      expect(
        tester
            .element(row)
            .findAncestorWidgetOfExactType<Semantics>()!
            .properties
            .selected,
        isTrue,
      );
      final height = tester.getSize(row).height;
      grid.AppTheme.palette.value = HarnessPalette.ember;
      await tester.pump();
      expect(
        tester
            .element(row)
            .findAncestorWidgetOfExactType<Semantics>()!
            .properties
            .selected,
        isTrue,
      );
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      await tester.pump();
      expect(tester.getSize(row).height, greaterThan(height));
      expect(tester.widget<TextField>(field).controller!.text, 'Agent');
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(
        tester
            .element(row)
            .findAncestorWidgetOfExactType<Semantics>()!
            .properties
            .selected,
        isTrue,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('Add header and cached rows respond when capacity changes', (
    tester,
  ) async {
    final app = createApp(connected: true);
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a69', input));
    await mount(tester, app);
    await openHarnessPicker(tester);
    final field = find.byKey(const ValueKey('swarm-search-input'));
    await tester.enterText(field, 'Agent');
    await tester.pump();
    final editor = tester.widget<TextField>(field).controller;
    for (var i = 0; i < AppNotifier.maxPanes - 1; i++) {
      app.adoptSessionForTest(terminal('a$i', input));
    }
    app.dismissError(); // Publish the sessions assembled through the test seam.
    await tester.pump();
    final row = find.byKey(ValueKey(agentDestinationId('m', 'a0')));
    expect(
      tester
          .element(row)
          .findAncestorWidgetOfExactType<Semantics>()!
          .properties
          .enabled,
      isTrue,
    );
    expect(
      find.descendant(of: row, matching: find.text('Already added')),
      findsNothing,
    );
    await app.closePane(app.panes.last.id);
    await tester.pump();
    expect(tester.widget<TextField>(field).controller, same(editor));
    expect(editor!.text, 'Agent');
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    expect(input, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('a completed background add cannot take the picker keyboard', (
    tester,
  ) async {
    final app = createApp();
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    app.newSwarm();
    app.adoptSessionForTest(terminal('a69', input));
    final target = app.activeSwarm;
    await mount(tester, app);
    await openHarnessPicker(tester);
    final field = find.byKey(const ValueKey('swarm-search-input'));
    await tester.enterText(field, 'Agent');
    await tester.pump();
    await app.addAgentToSwarm('m', 'a0', swarmId: target.id);
    await tester.pump();
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    final search = tester
        .widget<SwarmSearchInput>(
          find.ancestor(of: field, matching: find.byType(SwarmSearchInput)),
        )
        .search!;
    final previous = search.selected!.id;
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    expect(search.selected!.id, isNot(previous));
    expect(input, isEmpty);
    expect(target.panes, hasLength(2));
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
