import 'support/launch_menu.dart';
import 'support/mixed_agents.dart';

import 'package:harness/store/store_screen.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' as configured;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  for (final native in [false, true]) {
    testWidgets(
      'Store entry reuses its tab and preserves work (native=$native)',
      (tester) async {
        final app = createApp();
        final map = MemoryKeymap();
        addTearDown(app.dispose);
        addTearDown(map.dispose);
        final frames = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('a0', frames));
        final work = app.activeSwarm;
        await configured.mount(tester, app, map, native: native);
        final view = find.byWidgetPredicate(
          (widget) =>
              widget is TerminalView &&
              widget.terminal == pane.session!.terminal,
        );
        final terminalState = tester.state(view);
        Future<void> openStore() async {
          if (native) {
            await configured.native(tester, 'store');
          } else {
            await key(tester, LogicalKeyboardKey.keyS, cmd: true);
          }
          await tester.pump();
        }

        await openStore();
        final store = app.activeSwarm;
        expect(store.isStore, isTrue);
        expect(work.panes.single, same(pane));
        expect(app.swarms, hasLength(2));
        app.selectSwarm(work.id);
        await tester.pump();
        await openStore();
        expect(app.activeSwarm, same(store));
        expect(app.swarms, hasLength(2));
        await key(tester, LogicalKeyboardKey.keyW, cmd: true);
        expect(app.activeSwarm, same(work));
        expect(tester.state(view), same(terminalState));
        await key(tester, LogicalKeyboardKey.arrowLeft);
        expect(frames.single.bytes, [27, 91, 68]);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('Store is searchable by install and browse and can be remapped', (
    tester,
  ) async {
    final app = createApp();
    final map = MemoryKeymap();
    addTearDown(app.dispose);
    addTearDown(map.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    final work = app.activeSwarm;
    await configured.mount(tester, app, map);
    for (final query in [
      'store',
      'install',
      'browse harnesses',
      'extensions',
    ]) {
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> $query',
      );
      await tester.pump();
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      expect(search.selected?.commandId, 'app.store', reason: query);
      await acceptSetupOrSearch(tester);
      expect(app.activeSwarm.isStore, isTrue);
      expect(app.swarms, hasLength(2));
      expect(find.byType(SwarmSearchResults), findsNothing);
    }
    app.selectSwarm(work.id);
    map.apply('{"bindings":[{"keys":"cmd+shift+m","command":"app.store"}]}');
    await tester.pump();
    await key(tester, LogicalKeyboardKey.keyM, cmd: true, shift: true);
    expect(app.activeSwarm.isStore, isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  for (final prompt in [null, 'Model a reading nook']) {
    testWidgets(
      'Store ${prompt == null ? 'Open' : 'Try'} uses the dock with its harness and task',
      (tester) async {
        newHarnessOpensInBox = true;
        addTearDown(() => newHarnessOpensInBox = false);
        final app = createApp();
        seedMixedAgents(app);
        final map = MemoryKeymap();
        addTearDown(app.dispose);
        addTearDown(map.dispose);
        app.adoptSessionForTest(terminal('a0', []));
        app.openStore();
        final store = app.activeSwarm;
        final count = app.swarms.length;
        await configured.mount(tester, app, map);
        await openStoreAgent(
          tester.element(find.byType(StoreTab)),
          app,
          'studio/arm',
          'm',
          prompt: prompt,
        );
        await tester.pump();
        final box = tester
            .widget<NewHarnessForm>(find.byType(NewHarnessForm))
            .controller;
        expect(box.harnessId, 'studio/arm');
        expect(box.task, prompt ?? '');
        expect(box.projectLabel, startsWith('~/harnesses/robot-studio-'));
        expect(box.projectFolderRequest!.isGenerated, isTrue);
        expect(box.placement, HarnessPlacement.newTab);
        expect(find.byType(NewHarnessForm), findsOneWidget);
        expect(find.byType(AlertDialog), findsNothing);
        expect(app.activeSwarm, same(store));
        expect(app.swarms, hasLength(count));
        await key(tester, LogicalKeyboardKey.escape);
        expect(app.activeSwarm, same(store));
        expect(find.byType(NewHarnessForm), findsNothing);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('browsing from harness choices retains the task and defaults', (
    tester,
  ) async {
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final app = createApp();
    final map = MemoryKeymap();
    addTearDown(app.dispose);
    addTearDown(map.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final work = app.activeSwarm;
    await configured.mount(tester, app, map);
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);

    final box = tester
        .widget<NewHarnessForm>(find.byType(NewHarnessForm))
        .controller;
    box.setFolder('/work/project');
    await tester.pump();
    box.task = 'Finish the login feature';
    await tester.pump();
    final draft = box.draft;
    await openLaunchRow(tester, 'harness');
    await typeHarnessQuery(tester, 'a harness not in this catalog');
    await tester.pump();
    expect(box.selected?.id, NewHarnessController.storeId);
    expect(find.text('Browse Harness Store…'), findsOneWidget);
    await acceptSetupOrSearch(tester);
    expect(app.activeSwarm.isStore, isTrue);
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(work.panes.single, same(pane));
    app.selectSwarm(work.id);
    await tester.pump();
    await key(tester, LogicalKeyboardKey.keyN, cmd: true);
    final resumed = tester
        .widget<NewHarnessForm>(find.byType(NewHarnessForm))
        .controller;
    expect(resumed.task, draft.task);
    expect(resumed.engine, draft.engine);
    expect(resumed.machineId, draft.machineId);
    expect(resumed.project, draft.project);
    await key(tester, LogicalKeyboardKey.escape);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
