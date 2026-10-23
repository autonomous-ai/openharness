import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/pane_resize_handle.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_devices_fixture.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

const _viewportKey = ValueKey('devices-center-viewport');

Future<void> _mount(WidgetTester tester, AppNotifier app) async {
  await tester.binding.setSurfaceSize(const Size(700, 700));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox.expand(
          key: _viewportKey,
          child: PaneGrid(
            notifier: app,
            swarmMode: true,
            devicesViewer: (_) => const Center(child: Text('Devices')),
            devicesConversation: (_) =>
                const Center(child: Text('Device conversation')),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<SuperTabLaunchFixture> _embedded(WidgetTester tester) async {
  final f = superTabDevicesFixture();
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  c.selectDevices();
  f.app.prepareSuperTabDevices(f.app.activeSwarmId);
  await _mount(tester, f.app);
  return f;
}

ScrollController _horizontal(WidgetTester tester) => tester
    .widgetList<SingleChildScrollView>(find.byType(SingleChildScrollView))
    .singleWhere((view) => view.scrollDirection == Axis.horizontal)
    .controller!;

void _expectFits(WidgetTester tester, AppNotifier app) {
  final viewport = tester.getRect(find.byKey(_viewportKey));
  final frames = [
    for (final pane in app.panes)
      tester.getRect(find.byKey(ValueKey('pane-frame:${pane.id}'))),
  ];
  expect(frames, hasLength(1));
  expect(frames.single, viewport);
  expect(app.panes.single.isDevices, isTrue);
  expect(find.byType(PaneResizeHandle), findsNothing);
  expect(find.text('Device conversation'), findsNothing);
  expect(_horizontal(tester).position.maxScrollExtent, closeTo(0, .01));
  expect(_horizontal(tester).offset, closeTo(0, .01));
  expect(tester.takeException(), isNull);
}

void main() {
  testWidgets(
    'embedded Devices fills the center at narrow and wide sizes without a chat slot',
    (tester) async {
      final f = await _embedded(tester);
      final panes = List.of(f.app.panes);
      for (final width in [4000.0, 1000.0, 700.0, 500.0, 360.0]) {
        await tester.binding.setSurfaceSize(Size(width, 700));
        await tester.pumpAndSettle();
        _expectFits(tester, f.app);
        f.app.focusPane(panes.single.id, reveal: true);
        await tester.pumpAndSettle();
        _expectFits(tester, f.app);
      }
      expect(f.app.panes, panes);
      await tester.pumpWidget(const SizedBox());
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets('regular terminal splits retain their minimum and scroll', (
    tester,
  ) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    for (var i = 0; i < 2; i++) {
      app.adoptSessionForTest(terminal('a$i', []));
    }
    app.activeSwarm.savePaneSizes(
      '2:manual',
      PaneArrangement.viewerBesideTerminal,
    );
    await _mount(tester, app);
    expect(app.activeSwarm.isSuperTab, isFalse);
    expect(_horizontal(tester).position.maxScrollExtent, greaterThan(0));
    final right = tester.getRect(
      find.byKey(ValueKey('pane-frame:${app.panes.last.id}')),
    );
    expect(right.width, greaterThan(700 * .3));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('standalone Devices keeps the existing terminal floor', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.openDevices();
    await _mount(tester, app);
    expect(app.activeSwarm.isDevices, isTrue);
    expect(app.activeSwarm.isSuperTab, isFalse);
    expect(_horizontal(tester).position.maxScrollExtent, greaterThan(0));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
