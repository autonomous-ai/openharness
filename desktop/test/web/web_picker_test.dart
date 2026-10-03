@TestOn('browser')
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/web/shell/web_workspace.dart';
import 'package:harness/widgets/swarm_switcher.dart';

Future<AppNotifier> _mount(WidgetTester tester) async {
  final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession())
    ..newSwarm(newTabPage: true);
  const machine = Machine(
    machineId: 'remote-box',
    name: 'remote-box',
    authMode: MachineAuthMode.remote,
  );
  app.machines.add(machine);
  app.machineStates['remote-box'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected;
  tester.view.physicalSize = const Size(1280, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: WebWorkspace(app: app),
    ),
  );
  await tester.pump(const Duration(milliseconds: 200));
  await tester.tap(find.byKey(const ValueKey('swarm-search-button')));
  await tester.pump(const Duration(milliseconds: 200));
  return app;
}

SwarmSearchController _search(WidgetTester tester) =>
    tester.widget<SwarmSearchResults>(find.byType(SwarmSearchResults)).search;

Future<void> _tap(WidgetTester tester, String key) async {
  await tester.tap(find.byKey(ValueKey(key)));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('scopes switch by click, without prefix keys', (tester) async {
    final app = await _mount(tester);
    // The desktop picker's own scopes: the browser adds no second row.
    await _tap(tester, 'search-category-Machines');
    expect(_search(tester).scopePrefix, '@');
    await _tap(tester, 'search-category-Models');
    expect(_search(tester).scopePrefix, ':');
    await _tap(tester, 'search-category-Harnesses');
    expect(_search(tester).scopePrefix, '');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('Back leaves a machine scope and key hints stay hidden', (
    tester,
  ) async {
    final app = await _mount(tester);
    await _tap(tester, 'search-category-Machines');
    final search = _search(tester);
    expect(find.byKey(const ValueKey('search-back')), findsNothing);
    expect(search.scopeToGroup('machine:remote-box'), isTrue);
    await tester.pump(const Duration(milliseconds: 100));
    expect(search.canGoBack, isTrue);
    await _tap(tester, 'search-back');
    expect(search.canGoBack, isFalse);
    expect(search.scopePrefix, '@');
    // A selected machine shows its actions, not "Enter select · Esc back".
    expect(search.selected, isNotNull);
    expect(find.byKey(const ValueKey('resource-control-hints')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('a resource\'s actions keep a gap above the panel\'s edge', (
    tester,
  ) async {
    final app = await _mount(tester);
    await _tap(tester, 'search-category-Machines');
    // Key hints are hidden here, and they were the only space under the row.
    expect(find.byKey(const ValueKey('resource-control-hints')), findsNothing);
    final actions = tester.getRect(
      find.byKey(const ValueKey('swarm-search-resource-actions')),
    );
    final panel = tester.getRect(
      find.byKey(const ValueKey('swarm-search-results')),
    );
    expect(panel.bottom - actions.bottom, greaterThanOrEqualTo(12));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('the close button dismisses the picker', (tester) async {
    final app = await _mount(tester);
    await _tap(tester, 'search-close');
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byType(SwarmSearchResults), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });
}
