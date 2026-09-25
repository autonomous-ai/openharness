import 'support/open_harness.dart';
import 'support/launch_menu.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/store/store_screen.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/swarm_search_input.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'support/mixed_agents.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

const _products = [
  {
    'id': 'autonomous/workshop',
    'name': 'Autonomous Workshop',
    'engine': 'claude',
    'installed': true,
  },
  {
    'id': 'autonomous/blender',
    'name': 'Blender',
    'engine': 'claude',
    'installed': true,
  },
];

class _Connection extends WsConn {
  _Connection(String id)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: id,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final starts = <Map<String, dynamic>>[];
  final replies = <Completer<Map<String, dynamic>>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'engines_probe') {
      return {
        'engines': [
          for (final engine in ['codex', 'claude'])
            {'engine': engine, 'installed': true},
        ],
      };
    }
    if (type == 'dsh_list') return {'dsh': _products};
    if (type == 'fs_list_dir') {
      return {'path': payload['path'] ?? '/home/$machineId', 'entries': []};
    }
    if (type == 'agent_create') {
      starts.add(Map.of(payload));
      final reply = Completer<Map<String, dynamic>>();
      replies.add(reply);
      return reply.future;
    }
    return {};
  }

  void created() => replies.last.complete({
    'creationId': starts.last['creationId'],
    'state': 'created',
    'agent': {
      'id': 'created-${starts.length}',
      'name': 'Created harness',
      'engine': starts.last['engine'],
      'dsh': starts.last['dsh'],
      'project': {
        'cwd':
            starts.last['cwd'] ??
            '/home/$machineId/harnesses/${starts.last['projectName']}',
      },
    },
  });
}

void main() {
  late AppNotifier app;
  late MemoryKeymap map;
  late Map<String, _Connection> connections;

  NewHarnessController box(WidgetTester tester) =>
      tester.widget<NewHarnessForm>(find.byType(NewHarnessForm)).controller;

  setUp(() {
    newHarnessOpensInBox = true;
  });
  tearDown(() {
    map.dispose();
    app.dispose();
    newHarnessOpensInBox = false;
  });

  Future<void> mount(WidgetTester tester, {bool store = true}) async {
    connections = {
      for (final id in ['m', 'studio', 'build']) id: _Connection(id),
    };
    app = createApp(connectionForTest: (id) => connections[id]!);
    seedMixedAgents(app);
    app.machineStates['m']!.localOnly = true;
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    for (final machine in app.machineStates.values) {
      machine.dsh.replace(_products.map((json) => DshEntry.fromJson(json)!));
    }
    map = MemoryKeymap();
    await app.agentPreference.remember('codex');
    await app.projectHistory.select('m', '/work/openharness');
    app.adoptSessionForTest(terminal('a0', []));
    if (store) app.openStore();
    await configured.mount(tester, app, map);
  }

  Future<void> product(
    WidgetTester tester,
    String id, {
    String machine = 'm',
    String? task,
  }) async {
    await openStoreAgent(
      tester.element(
        find
            .descendant(
              of: find.byType(SwarmScreen),
              matching: find.byType(Scaffold),
            )
            .first,
      ),
      app,
      id,
      machine,
      prompt: task,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
  }

  Future<void> dismiss(WidgetTester tester) async {
    for (
      var i = 0;
      i < 4 && find.byType(NewHarnessForm).evaluate().isNotEmpty;
      i++
    ) {
      await key(tester, LogicalKeyboardKey.escape);
    }
    expect(find.byType(NewHarnessForm), findsNothing);
  }

  Future<void> nameProject(WidgetTester tester, String name) async {
    box(tester).focusField(NewHarnessField.projectName);
    await tester.pump();
    await typeHarnessQuery(tester, name);
    await acceptSetupOrSearch(tester);
  }

  for (final shortcut in [LogicalKeyboardKey.keyN, LogicalKeyboardKey.keyP]) {
    testWidgets(
      '${shortcut.keyLabel == 'N' ? 'Cmd-N' : 'command palette'} starts a pane with no extra launch controls',
      (tester) async {
        await mount(tester, store: false);
        final origin = app.activeSwarm;
        await key(
          tester,
          shortcut,
          cmd: true,
          shift: shortcut == LogicalKeyboardKey.keyP,
        );
        if (shortcut != LogicalKeyboardKey.keyN) {
          await tester.enterText(
            find.byKey(const ValueKey('swarm-search-input')),
            '> New Harness',
          );
          await acceptSetupOrSearch(tester);
        }
        final controller = box(tester);
        const initial = HarnessPlacement.currentTab;
        expect(controller.placement, initial);
        for (final removed in ['task', 'placement']) {
          expect(
            find.byKey(ValueKey('new-harness-field-$removed')),
            findsNothing,
          );
        }
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('new-harness-field-start')),
            matching: find.text('New Harness'),
          ),
          findsOneWidget,
        );
        expect(connections['m']!.starts, isEmpty);
        await acceptSetupOrSearch(tester);
        expect(connections['m']!.starts, hasLength(1));
        connections['m']!.created();
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 200));
        if (shortcut == LogicalKeyboardKey.keyT) {
          expect(app.swarms.length, 2);
          expect(origin.panes.single.agentId, 'a0');
          expect(app.activeSwarm.panes.single.agentId, 'created-1');
        } else {
          expect(app.activeSwarm, same(origin));
          expect(origin.panes.map((pane) => pane.agentId), ['a0', 'created-1']);
        }
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  for (final closeFirst in [false, true]) {
    for (final task in [null, 'Model a reading nook']) {
      testWidgets(
        'switching Store products ${closeFirst ? 'after Escape' : 'with the dock open'} respects ${task == null ? 'Open' : 'Try'}',
        (tester) async {
          await mount(tester);
          await product(tester, 'autonomous/workshop');
          expect(
            box(tester).projectLabel,
            startsWith('~/harnesses/autonomous-workshop-'),
          );
          await nameProject(tester, 'workshop-design');
          box(tester).task = 'Workshop task';
          if (closeFirst) await dismiss(tester);
          await product(tester, 'autonomous/blender', task: task);
          expect(box(tester).harnessId, 'autonomous/blender');
          expect(box(tester).projectLabel, startsWith('~/harnesses/blender-'));
          expect(box(tester).project.generated, isNotNull);
          expect(box(tester).task, task ?? '');
          expect(box(tester).placement, HarnessPlacement.newTab);
          await dismiss(tester);
          await product(tester, 'autonomous/workshop');
          expect(box(tester).harnessId, 'autonomous/workshop');
          expect(box(tester).projectLabel, '~/harnesses/workshop-design');
          expect(box(tester).task, 'Workshop task');
          expect(connections.values.expand((c) => c.starts), isEmpty);
          await dismiss(tester);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }

  testWidgets(
    'Store machine choices have separate drafts and override edited defaults',
    (tester) async {
      await mount(tester);
      await product(tester, 'autonomous/blender');
      await nameProject(tester, 'local-scene');
      await product(tester, 'autonomous/blender', machine: 'studio');
      expect(box(tester).machineId, 'studio');
      expect(box(tester).project.generated, isNotNull);
      await nameProject(tester, 'remote-scene');
      await product(tester, 'autonomous/blender');
      expect(box(tester).machineId, 'm');
      expect(box(tester).project.name, 'local-scene');
      box(tester).focusField(NewHarnessField.machine);
      box(tester).accept(const NewHarnessOption(id: 'studio', title: 'Studio'));
      await dismiss(tester);
      await product(tester, 'autonomous/blender');
      expect(
        box(tester).machineId,
        'm',
        reason: 'The Store explicitly requested this machine',
      );
      expect(box(tester).projectLabel, startsWith('~/harnesses/blender-'));
      await dismiss(tester);
      await product(tester, 'autonomous/blender', machine: 'studio');
      expect(box(tester).project.name, 'remote-scene');
      await dismiss(tester);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'product entry from a pane does not inherit workspace projects or search tasks',
    (tester) async {
      await mount(tester, store: false);
      await openHarnessPicker(tester);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Review the API',
      );
      await product(tester, 'autonomous/blender');
      expect(box(tester).projectLabel, startsWith('~/harnesses/blender-'));
      expect(box(tester).task, isEmpty);
      expect(box(tester).placement, HarnessPlacement.newTab);
      await dismiss(tester);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      expect(box(tester).engine, 'codex');
      expect(box(tester).project.folder, '/work/openharness');
      expect(box(tester).task, isEmpty);
      await dismiss(tester);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final task in [null, 'Model a reading nook']) {
    testWidgets(
      'Store ${task == null ? 'Open' : 'Try'} starts the displayed product, project and machine after a product switch',
      (tester) async {
        await mount(tester);
        final store = app.activeSwarm;
        await product(tester, 'autonomous/workshop');
        await product(
          tester,
          'autonomous/blender',
          machine: 'studio',
          task: task,
        );
        final displayed = box(tester).projectFolderRequest!.folderName;
        await acceptSetupOrSearch(tester);
        expect(connections['m']!.starts, isEmpty);
        final connection = connections['studio']!;
        expect(connection.starts, hasLength(1));
        expect(connection.starts.single['engine'], 'claude');
        expect(connection.starts.single['dsh'], 'autonomous/blender');
        expect(connection.starts.single['projectName'], displayed);
        expect(displayed, startsWith('blender-'));
        expect(connection.starts.single['prompt'], task);
        expect(app.activeSwarm, same(store));
        connection.created();
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 200));
        expect(app.activeSwarm.isStore, isFalse);
        expect(app.focusedPane?.machineId, 'studio');
        expect(app.focusedPane?.agentId, 'created-1');
        expect(find.byType(NewHarnessForm), findsNothing);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('Store Open restores its harness after switching to Code', (
    tester,
  ) async {
    await mount(tester);
    await product(tester, 'autonomous/blender');
    box(tester).focusField(NewHarnessField.harness);
    box(tester).accept(
      const NewHarnessOption(id: NewHarnessController.codingId, title: 'Code'),
    );
    box(tester).focusField(NewHarnessField.agent);
    box(tester).accept(const NewHarnessOption(id: 'codex', title: 'Codex'));
    expect(box(tester).engine, 'codex');
    await dismiss(tester);
    await product(tester, 'autonomous/blender');
    expect(box(tester).harnessId, 'autonomous/blender');
    expect(box(tester).projectLabel, startsWith('~/harnesses/blender-'));
    await dismiss(tester);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'an explicit coding engine reopens its draft and overrides a different harness',
    (tester) async {
      await mount(tester);
      await product(tester, 'codex');
      expect(box(tester).engine, 'codex');
      expect(box(tester).harnessId, isNull);
      box(tester).setFolder('/work/explicit-code');
      await dismiss(tester);
      await product(tester, 'codex');
      expect(box(tester).project.folder, '/work/explicit-code');
      box(tester).focusField(NewHarnessField.harness);
      box(tester).applyOption(
        box(tester).options
            .singleWhere((option) => option.id == 'autonomous/blender'),
      );
      await dismiss(tester);
      await product(tester, 'codex');
      expect(box(tester).engine, 'codex');
      expect(box(tester).harnessId, isNull);
      expect(
        connections.values.expand((connection) => connection.starts),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'an in-flight or uncertain Store start cannot be replaced or retried as a new task',
    (tester) async {
      await mount(tester);
      // This receipt test leaves folder preparation to the fake remote CLI.
      app.machineStates['m']!.localOnly = false;
      await product(tester, 'autonomous/workshop', task: 'Original task');
      final original = box(tester);
      final starting = original.create();
      await tester.pump();
      expect(connections['m']!.starts, hasLength(1));
      await product(tester, 'autonomous/blender');
      expect(box(tester), same(original));
      expect(original.error, contains('Finish the current action'));
      connections['m']!.replies.single.completeError(
        const WsRequestTimeout('agent_create'),
      );
      expect(await starting, NewHarnessOutcome.failed);
      await tester.pump();
      await product(tester, 'autonomous/blender');
      expect(box(tester), same(original));
      expect(original.checking, isTrue);
      expect(original.error, contains('Check the pending start'));
      await dismiss(tester);
      await product(tester, 'autonomous/blender');
      expect(box(tester).harnessId, 'autonomous/blender');
      await dismiss(tester);
      await product(tester, 'autonomous/workshop', task: 'A different example');
      expect(box(tester).checking, isTrue);
      expect(box(tester).task, 'Original task');
      expect(connections['m']!.starts, hasLength(1));
      await dismiss(tester);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('repeating Cmd-O keeps the highlighted existing harness', (
    tester,
  ) async {
    await mount(tester, store: false);
    final origin = app.activeSwarm;
    await openHarnessPicker(tester);
    final search = find.byKey(const ValueKey('swarm-search-input'));
    await tester.enterText(search, 'login');
    final picker = tester
        .widget<SwarmSearchInput>(find.byType(SwarmSearchInput))
        .search!;
    for (
      var i = 0;
      i < picker.rows.length && picker.selected?.agentId != 'a1';
      i++
    ) {
      await key(tester, LogicalKeyboardKey.arrowUp);
    }
    expect(picker.selected?.agentId, 'a1');
    await openHarnessPicker(tester);
    final updated = tester
        .widget<SwarmSearchInput>(find.byType(SwarmSearchInput))
        .search!;
    expect(updated.query, 'login');
    expect(updated.selected?.agentId, 'a1');
    await acceptSetupOrSearch(tester);
    expect(app.focusedPane?.agentId, 'a1');
    expect(app.activeSwarm, same(origin));
    expect(app.swarms.length, 1);
    expect(connections.values.expand((c) => c.starts), isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an unmatched search query waits for explicit Cmd-N creation', (
    tester,
  ) async {
    await mount(tester, store: false);
    final origin = app.activeSwarm;

    await openHarnessPicker(tester);
    final search = find.byKey(const ValueKey('swarm-search-input'));
    await tester.enterText(search, 'Check the keyboard workflow');
    final editor = tester.widget<SwarmSearchInput>(
      find.byType(SwarmSearchInput),
    );
    editor.controller.selection = const TextSelection(
      baseOffset: 6,
      extentOffset: 18,
    );
    await openHarnessPicker(tester);
    final updated = tester.widget<SwarmSearchInput>(
      find.byType(SwarmSearchInput),
    );
    expect(updated.controller.text, 'Check the keyboard workflow');
    expect(
      updated.controller.selection,
      const TextSelection(baseOffset: 6, extentOffset: 18),
    );
    expect(updated.focusNode.hasFocus, isTrue);
    expect(find.text('New Pane'), findsNothing);
    expect(app.swarms.first, same(origin));
    expect(app.swarms.length, 1);
    await acceptSetupOrSearch(tester);
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(updated.search!.rows, isEmpty);
    expect(connections.values.expand((c) => c.starts), isEmpty);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    expect(box(tester).task, 'Check the keyboard workflow');
    expect(box(tester).placement, HarnessPlacement.currentTab);
    await acceptSetupOrSearch(tester);
    expect(
      connections['m']!.starts.single['prompt'],
      'Check the keyboard workflow',
    );
    connections['m']!.created();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(app.swarms.length, 1);
    expect(app.focusedPane?.agentId, 'created-1');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'Cmd-N uses local saved defaults regardless of the focused pane',
    (tester) async {
      await mount(tester, store: false);
      final first = app.focusedPane!;
      final other = app.adoptSessionForTest(terminal('a2', []));
      app.focusPane(first.id);
      await tester.pump();
      final shortcut = LogicalKeyboardKey.keyN;
      await key(tester, shortcut, cmd: true);
      await nameProject(tester, 'keyboard-review');
      box(tester).task = 'Review this project';
      await dismiss(tester);
      app.focusPane(other.id);
      await tester.pump();
      await key(tester, shortcut, cmd: true);
      expect(box(tester).harnessId, isNull);
      expect(box(tester).engine, 'codex');
      expect(box(tester).machineId, 'm');
      expect(box(tester).project.folder, '/work/openharness');
      expect(box(tester).task, isEmpty);
      await dismiss(tester);
      app.focusPane(first.id);
      await tester.pump();
      await key(tester, shortcut, cmd: true);
      expect(box(tester).engine, 'codex');
      expect(box(tester).project.folder, '/work/openharness');
      expect(box(tester).task, isEmpty);
      expect(connections.values.expand((c) => c.starts), isEmpty);
      await dismiss(tester);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 60));
    },
  );

  testWidgets(
    'fresh Cmd-N keeps successful defaults and discards canceled edits',
    (tester) async {
      await mount(tester, store: false);
      final origin = app.activeSwarm;
      final shortcut = LogicalKeyboardKey.keyN;
      await key(tester, shortcut, cmd: true);
      var draft = box(tester);
      expect(draft.engine, 'codex');
      expect(draft.machineId, 'm');
      expect(draft.project.folder, '/work/openharness');
      expect(app.swarms.first, same(origin));
      expect(app.swarms.length, 1);
      draft.task = 'Check keyboard focus';
      await nameProject(tester, 'keyboard-review');
      await dismiss(tester);
      expect(app.swarms, [origin]);
      expect(app.activeSwarm, same(origin));
      await openHarnessPicker(tester);
      await acceptSetupOrSearch(tester);
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(connections.values.expand((c) => c.starts), isEmpty);
      await key(tester, LogicalKeyboardKey.keyN, cmd: true);
      draft = box(tester);
      expect(draft.task, isEmpty);
      expect(draft.project.folder, '/work/openharness');
      expect(draft.placement, HarnessPlacement.currentTab);
      await acceptSetupOrSearch(tester);
      final connection = connections['m']!;
      expect(connection.starts, hasLength(1));
      expect(connection.starts.single['engine'], 'codex');
      expect(connection.starts.single['cwd'], '/work/openharness');
      expect(connection.starts.single['prompt'], isNull);
      expect(connection.starts.single['dsh'], isNull);
      connection.created();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(app.swarms.length, 1);
      expect(app.activeSwarm.panes.last.agentId, 'created-1');
      expect(app.focusedPane?.agentId, 'created-1');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'switching the picker keeps its project scope and Escape goes back',
    (tester) async {
      await mount(tester, store: false);
      await openHarnessPicker(tester);
      final search = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(search, '# openharness');
      await acceptSetupOrSearch(tester);
      await tester.enterText(search, 'login');
      final before = tester
          .widget<SwarmSearchInput>(find.byType(SwarmSearchInput))
          .search!;
      expect(before.canGoBack, isTrue);
      final selected = before.selected?.id;
      final results = before.rows.map((row) => row.id).toList();
      await openHarnessPicker(tester);
      final picker = tester
          .widget<SwarmSearchInput>(find.byType(SwarmSearchInput))
          .search!;
      expect(picker.query, 'login');
      expect(picker.canGoBack, isTrue);
      expect(picker.rows.any((row) => row.isCreate), isFalse);
      expect(picker.selected?.id, selected);
      expect(picker.rows.map((row) => row.id), results);
      expect(find.text('Harnesses · openharness'), findsNothing);
      expect(
        tester.widget<TextField>(search).decoration!.hintText,
        'Search harnesses in openharness',
      );
      await key(tester, LogicalKeyboardKey.escape);
      expect(picker.query, '# openharness');
      expect(picker.canGoBack, isFalse);
      expect(connections.values.expand((c) => c.starts), isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
