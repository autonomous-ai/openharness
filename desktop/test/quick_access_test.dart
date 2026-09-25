import 'support/open_harness.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'support/mixed_agents.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  test('Cmd-P never creates harnesses in root or scoped session lists', () {
    final app = createApp();
    seedMixedAgents(app);
    addTearDown(app.dispose);
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      activityFirst: true,
      offersCreate: true,
      offersHarnessCreate: false,
      selectOnEmptyQuery: false,
      placement: HarnessPlacement.currentTab,
    );
    addTearDown(search.dispose);
    expect(search.rows, isNotEmpty);
    expect(search.rows.any((row) => row.isCreate), isFalse);
    expect(search.selected, isNull);
    expect(search.submit(), isNull);
    for (final query in ['@ Office', '# openharness']) {
      search.setQuery(query);
      expect(search.rows.any((row) => row.isCreate), query.startsWith('@'));
      expect(search.selected!.isCreate, isFalse);
      expect(search.submit(), isNull);
      expect(search.canGoBack, isTrue);
      expect(search.rows, isNotEmpty);
      expect(search.rows.any((row) => row.isCreate), isFalse);
      search.setQuery('a harness that does not exist');
      expect(search.rows, isEmpty);
      expect(search.selected, isNull);
      expect(search.submit(), isNull);
      expect(search.back(), isTrue);
    }
    search.setQuery('a harness that does not exist');
    expect(search.rows, isEmpty);
    expect(search.submit(), isNull);
    search.setQuery('');
    for (final machine in app.machineStates.values) {
      machine.agents = [];
    }
    app.notifyListeners();
    expect(search.rows, isEmpty);
    expect(search.showsTypeHints, isTrue);
    search.move(1);
    search.move(-1);
    expect(search.selected, isNull);
    expect(search.submit(), isNull);
  });

  for (final placement in HarnessPlacement.values) {
    test('prefixes switch lists and retain $placement', () {
      final app = createApp();
      seedMixedAgents(app);
      addTearDown(app.dispose);
      final command = SwarmDestination(
        id: 'command:app.store',
        title: 'Harness Store',
        detail: '',
        swarmId: null,
        current: false,
        commandId: 'app.store',
      );
      final search = SwarmSearchController(
        app,
        const [],
        adding: true,
        offersCreate: true,
        placement: placement,
        commands: () => [command],
      );
      addTearDown(search.dispose);
      final target = search.targetId;
      expect(
        search.rows
            .where((row) => !row.isCreate)
            .every((row) => row.agentId != null),
        isTrue,
      );
      search.setQuery('> store');
      expect(search.rows.single.commandId, 'app.store');
      expect(search.createTask, isNull);
      search.setQuery('@ Office');
      expect(search.rows.first.title, 'New Machine');
      expect(
        search.rows.where((row) => !row.isCreate).single.isMachine,
        isTrue,
      );
      expect(search.selected!.machineId, 'studio');
      search.setQuery('# openharness');
      expect(search.rows.any((row) => row.isCreate), isFalse);
      expect(
        search.rows.where((row) => !row.isCreate).single.isProject,
        isTrue,
      );
      search.setQuery('');
      expect(search.rows.any((row) => row.isCreate), isTrue);
      expect(
        search.rows
            .where((row) => !row.isCreate)
            .every((row) => row.agentId != null),
        isTrue,
      );
      expect(search.placement, placement);
      expect(search.targetId, target);
    });
  }

  test('project and machine selections narrow to individual agents and revalidate discovery', () {
    final app = createApp();
    seedMixedAgents(app);
    addTearDown(app.dispose);
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      offersCreate: true,
      placement: HarnessPlacement.newTab,
    );
    addTearDown(search.dispose);
    search.setQuery('# openharness');
    expect(search.submit(), isNull);
    expect(search.query, isEmpty);
    expect(search.canGoBack, isTrue);
    expect(
      search.rows.map((row) => row.agentId),
      unorderedEquals(['a0', 'a1', 'focus', 'login']),
    );
    search.setQuery('keyboard');
    expect(search.rows.single.agentId, 'focus');
    expect(search.submit()?.destination.agentId, 'focus');
    expect(search.back(), isTrue);
    expect(search.query, '# openharness');
    search.setQuery('@ Office');
    final stale = search.selected!;
    expect(search.submit(), isNull);
    expect(
      search.rows.where((row) => !row.isCreate).map((row) => row.agentId),
      unorderedEquals(['focus', 'helmet']),
    );
    expect(search.rows.first.title, 'New Harness');
    expect(search.scopedMachineId, 'studio');
    expect(
      search.rows
          .where((row) => !row.isCreate)
          .every((row) => row.machineId == 'studio'),
      isTrue,
    );
    app.machineStates['studio']!.agents = [];
    app.notifyListeners();
    expect(
      search.rows.where((row) => !row.isCreate),
      isEmpty,
      reason: 'A missing group must never fall back to all agents',
    );
    app.machineStates.remove('studio');
    app.notifyListeners();
    search.back();
    expect(search.submit(stale), isNull);
    search.setQuery('');
    expect(search.canGoBack, isFalse);
    expect(search.rows.any((row) => row.agentId == 'a0'), isTrue);
  });

  for (final entry in [LogicalKeyboardKey.keyO, LogicalKeyboardKey.keyT]) {
    testWidgets(
      'Quick Access stays in the same picker from ${entry.keyLabel}',
      (tester) async {
        final app = createApp();
        seedMixedAgents(app);
        addTearDown(app.dispose);
        final frames = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(terminal('a0', frames));
        final map = MemoryKeymap();
        addTearDown(map.dispose);
        await configured.mount(tester, app, map);
        await key(tester, entry, cmd: true);
        if (entry == LogicalKeyboardKey.keyT) {
          await openHarnessPicker(tester);
        }
        final tabs = app.swarms.length;
        final input = find.byKey(const ValueKey('swarm-search-input'));
        final field = tester.widget<TextField>(input);
        final search = tester
            .widget<SwarmSearchResults>(
              find.descendant(
                of: find.byKey(const ValueKey('swarm-search-results')),
                matching: find.byType(SwarmSearchResults),
              ),
            )
            .search;
        final placement = search.placement;
        Future<void> type(String text) async {
          await tester.enterText(input, text);
          await tester.pump();
        }

        await type('? #');
        await key(tester, LogicalKeyboardKey.enter);
        expect(search.isProjectMode, isTrue);
        expect(
          tester.widget<TextField>(input).controller,
          same(field.controller),
        );
        expect(field.focusNode!.hasFocus, isTrue);
        await type('# openharness');
        await key(tester, LogicalKeyboardKey.enter);
        expect(search.canGoBack, isTrue);
        expect(search.rows.every((row) => row.agentId != null), isTrue);
        expect(app.swarms, hasLength(tabs));
        await key(tester, LogicalKeyboardKey.escape);
        expect(field.controller!.text, '# openharness');
        expect(search.isProjectMode, isTrue);
        await type('? @');
        await key(tester, LogicalKeyboardKey.enter);
        expect(field.controller!.text, '@ ');
        expect(search.isMachineMode, isTrue);
        await type('@ Office');
        await key(tester, LogicalKeyboardKey.enter);
        expect(
          search.rows
              .where((row) => !row.isCreate)
              .every((row) => row.machineId == 'studio'),
          isTrue,
        );
        expect(field.focusNode!.hasFocus, isTrue);
        await key(tester, LogicalKeyboardKey.escape);
        expect(field.controller!.text, '@ Office');
        expect(search.isMachineMode, isTrue);
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        expect(
          find.byKey(const ValueKey('resource-command-input')),
          findsOneWidget,
        );
        expect(field.controller!.text, '@ Office');
        await key(tester, LogicalKeyboardKey.escape);
        expect(field.focusNode!.hasFocus, isTrue);
        await type('? >');
        await key(tester, LogicalKeyboardKey.enter);
        expect(field.controller!.text, '>');
        expect(search.isCommandMode, isTrue);
        expect(search.canGoBack, isFalse);
        // Backspace leaves command mode without closing/reopening the dock.
        await key(tester, LogicalKeyboardKey.backspace);
        await key(tester, LogicalKeyboardKey.backspace);
        expect(search.isCommandMode, isFalse);
        expect(
          search.rows
              .where((row) => !row.isCreate)
              .every((row) => row.agentId != null),
          isTrue,
        );
        expect(search.placement, placement);
        expect(
          tester.widget<TextField>(input).controller,
          same(field.controller),
        );
        expect(frames, isEmpty);
        await key(tester, LogicalKeyboardKey.escape);
        expect(input, findsNothing);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
