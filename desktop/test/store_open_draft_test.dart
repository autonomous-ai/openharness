// Open on a store page opens New Harness in a new tab; dismissing it must give the person back the
// store page they came from, not an empty New Tab.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('dismissing New Harness opened from a store page returns to the store tab', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1400, 1000);
    addTearDown(tester.view.reset);
    final app = createApp();
    final state = app.machineStates['m']!
      ..localOnly = true
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    state.dsh.replace(const [
      DshEntry(id: 'autonomous/marp', name: 'Marp', engine: 'claude', installed: true, category: 'Slides', tier: 2),
    ]);
    await app.addAgentToSwarm('m', 'a0');
    app.newSwarm(name: 'Other work');
    app.openStore();
    final storeTab = app.activeSwarm;
    expect(storeTab.isStore, isTrue);

    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(notifier: app, nativeTabs: false),
      ),
    );
    await tester.pumpAndSettle();
    final tabsBefore = app.swarms.length;

    await tester.enterText(find.byKey(const ValueKey('store-search')), 'marp');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('store-card:autonomous/marp')).first);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('store-primary-action')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('create-agent-submit')), findsOneWidget, reason: 'New Harness is open');
    expect(app.swarms.length, tabsBefore + 1, reason: 'in a new tab');

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('create-agent-submit')), findsNothing, reason: 'dismissed');
    expect(app.swarms.length, tabsBefore, reason: 'the empty tab is gone');
    expect(app.activeSwarm, same(storeTab), reason: 'back on the store');
    expect(find.byKey(const ValueKey('store-page:autonomous/marp')), findsOneWidget, reason: 'on the page it came from');
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('dismissing it returns to the store when the window already had an empty New Tab', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1400, 1000);
    addTearDown(tester.view.reset);
    final app = createApp();
    final state = app.machineStates['m']!
      ..localOnly = true
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    state.dsh.replace(const [
      DshEntry(id: 'autonomous/marp', name: 'Marp', engine: 'claude', installed: true, category: 'Slides', tier: 2),
    ]);
    await app.addAgentToSwarm('m', 'a0');
    app.newSwarm(name: 'Other work');
    app.openStore();
    final storeTab = app.activeSwarm;
    app.newSwarm(); // an empty New Tab of the person's own, left open behind the store
    final emptyTab = app.activeSwarm;
    expect(emptyTab.isEmptyStarter, isTrue);
    app.selectSwarm(storeTab.id);
    expect(app.swarms, contains(emptyTab), reason: 'not a draft, so leaving it keeps it');

    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(notifier: app, nativeTabs: false),
      ),
    );
    await tester.pumpAndSettle();
    final tabsBefore = app.swarms.length;

    await tester.enterText(find.byKey(const ValueKey('store-search')), 'marp');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('store-card:autonomous/marp')).first);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('store-primary-action')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('create-agent-submit')), findsOneWidget, reason: 'New Harness is open');
    expect(app.activeSwarm, same(emptyTab), reason: 'in the empty New Tab the window already had');
    expect(app.swarms.length, tabsBefore, reason: 'no second empty tab');

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('create-agent-submit')), findsNothing, reason: 'dismissed');
    expect(app.activeSwarm, same(storeTab), reason: 'back on the store, not left on the empty tab');
    expect(app.swarms, contains(emptyTab), reason: 'the person\'s own New Tab stays');
    expect(find.byKey(const ValueKey('store-page:autonomous/marp')), findsOneWidget, reason: 'on the page it came from');
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
