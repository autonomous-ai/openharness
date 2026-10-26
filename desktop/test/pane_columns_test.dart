// The web's column rule (WorkspaceChrome.twoPaneColumnsBelow): a tablet's
// grid is drawn at most two columns wide, a computer's is not, and the tab's
// recorded layout is the same either way.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/pane_resize_handle.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

AppNotifier _threePanes() {
  final app = createApp();
  app.machineStates['m']!.nodeOnline = true;
  for (var i = 0; i < 3; i++) {
    app.adoptSessionForTest(terminal('a$i', []));
  }
  addTearDown(app.dispose);
  return app;
}

Future<void> _mount(
  WidgetTester tester,
  AppNotifier app, {
  required Size size,
  WorkspaceChrome? chrome,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final grid = PaneGrid(notifier: app, swarmMode: true);
  await tester.pumpWidget(
    MaterialApp(
      home: chrome == null
          ? grid
          : WorkspaceChromeScope(chrome: chrome, child: grid),
    ),
  );
  await tester.pump();
}

/// How many columns the panes are drawn in: the distinct left edges.
int _drawnColumns(WidgetTester tester, AppNotifier app) => {
  for (final pane in app.panes)
    tester.getTopLeft(find.byKey(ValueKey('pane-frame:${pane.id}'))).dx,
}.length;

/// What the tab records of its layout — what a split divides, what the
/// neighbour walk reads, and what is saved.
List<Object?> _recorded(AppNotifier app) => [
  app.activeSwarm.arranged?.tiles,
  app.activeSwarm.arrangedKey,
  app.activeSwarm.gridColumns,
  Map.of(app.activeSwarm.paneSizes),
];

void main() {
  testWidgets('three panes on a 768 px browser are drawn in two columns', (
    tester,
  ) async {
    final app = _threePanes();

    await _mount(
      tester,
      app,
      size: const Size(768, 1024),
      chrome: webWorkspaceChrome(app),
    );

    expect(_drawnColumns(tester, app), 2);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a 1440 px browser keeps three columns', (tester) async {
    final app = _threePanes();

    await _mount(
      tester,
      app,
      size: const Size(1440, 900),
      chrome: webWorkspaceChrome(app),
    );

    expect(_drawnColumns(tester, app), 3);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a 768 px Desktop window keeps three columns', (tester) async {
    final app = _threePanes();

    await _mount(tester, app, size: const Size(768, 1024));

    expect(_drawnColumns(tester, app), 3);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the two-column drawing records the layout a computer does', (
    tester,
  ) async {
    final desktop = _threePanes();
    await _mount(tester, desktop, size: const Size(768, 1024));
    final recordedOnDesktop = _recorded(desktop);
    await tester.pumpWidget(const SizedBox());

    final web = _threePanes();
    await _mount(
      tester,
      web,
      size: const Size(768, 1024),
      chrome: webWorkspaceChrome(web),
    );

    expect(_drawnColumns(tester, web), 2);
    expect(_recorded(web), recordedOnDesktop);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('no divider is offered while two columns stand in for three', (
    tester,
  ) async {
    final desktop = _threePanes();
    await _mount(tester, desktop, size: const Size(768, 1024));
    expect(find.byType(PaneResizeHandle), findsWidgets);
    await tester.pumpWidget(const SizedBox());

    final web = _threePanes();
    await _mount(
      tester,
      web,
      size: const Size(768, 1024),
      chrome: webWorkspaceChrome(web),
    );

    expect(find.byType(PaneResizeHandle), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
