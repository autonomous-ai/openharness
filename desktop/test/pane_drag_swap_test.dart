// Dragging a pane by its header and dropping it on another pane trades their places.
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/widgets/agent_drag.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  late AppNotifier app;
  late MemoryKeymap map;
  late SwarmProjectStore projects;
  setUp(() {
    app = createApp();
    app.stateOf('m')!.nodeOnline = true;
    map = MemoryKeymap();
    projects = SwarmProjectStore();
  });
  tearDown(() {
    app.dispose();
    map.dispose();
    projects.dispose();
  });

  Agent agent(String id, String name) => Agent.fromJson({
    'id': id,
    'name': name,
    'engine': 'claude',
    'terminal': {'available': true},
  });

  testWidgets('dragging a pane by its header onto another swaps them', (
    tester,
  ) async {
    app.stateOf('m')!.agents = [agent('a0', 'First'), agent('a1', 'Second')];
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1400, 800);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: KeymapProvider(
          keymap: map,
          child: SwarmScreen(
            notifier: app,
            projectStore: projects,
            nativeTabs: false,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final before = app.panes.map((p) => p.agentId).toList();
    expect(before, ['a0', 'a1']);
    final draggables = find.byWidgetPredicate(
      (w) => w is Draggable<PaneDragRef>,
    );
    expect(
      draggables,
      findsNWidgets(2),
      reason: 'each pane header is draggable',
    );

    final first = app.panes.first.id, second = app.panes.last.id;
    final from = tester.getCenter(
      find.descendant(
        of: find.byKey(ValueKey('pane-frame:$first')),
        matching: draggables,
      ),
    );
    final to = tester.getCenter(find.byKey(ValueKey('pane-frame:$second')));
    final gesture = await tester.startGesture(
      from,
      kind: PointerDeviceKind.mouse,
    );
    await tester.pump(const Duration(milliseconds: 50));
    for (var i = 1; i <= 10; i++) {
      await gesture.moveTo(Offset.lerp(from, to, i / 10)!);
      await tester.pump(const Duration(milliseconds: 16));
    }
    // The drop target lights up while the pane is carried over it.
    expect(find.text('Swap with this pane'), findsOneWidget);
    for (final direction in ['right', 'down']) {
      expect(
        find.byKey(ValueKey('pane-split-$direction')).hitTestable(),
        findsNothing,
      );
    }
    await gesture.up();
    await tester.pumpAndSettle();

    expect(app.panes.map((p) => p.agentId).toList(), ['a1', 'a0']);
  });
}
