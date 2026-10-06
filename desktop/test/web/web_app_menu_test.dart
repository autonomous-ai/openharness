@TestOn('browser')
library;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/web/shell/web_workspace.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/workspace_bar_control.dart';
import 'package:harness/widgets/workspace_machine_prompt.dart';

Future<AppNotifier> _mount(
  WidgetTester tester, {
  String? connectedMachine,
}) async {
  final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession())
    ..newSwarm(newTabPage: true);
  if (connectedMachine != null) {
    final machine = Machine(
      machineId: connectedMachine,
      name: connectedMachine,
      authMode: MachineAuthMode.remote,
    );
    app.machines.add(machine);
    app.machineStates[connectedMachine] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
  }
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
  return app;
}

Future<void> _openMenu(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('web-app-menu-button')));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('the menu button opens Settings with one click', (tester) async {
    final app = await _mount(tester);
    await _openMenu(tester);
    expect(
      find.byKey(const ValueKey('web-menu:machines.list')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('web-menu:web.sign_out')), findsOneWidget);
    // An empty tab has no pane to split.
    expect(
      find.byKey(const ValueKey('web-menu:pane.split_right')),
      findsNothing,
    );
    await tester.tap(find.byKey(const ValueKey('web-menu:app.settings')));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('the menu opens with no row lit; keys still walk and close it', (
    tester,
  ) async {
    final app = await _mount(tester);
    await _openMenu(tester);
    bool lit(String id) =>
        Focus.of(tester.element(find.byKey(ValueKey('web-menu:$id'))))
            .hasPrimaryFocus;
    // Opened by a click: the pointer picks the row, so none starts lit.
    expect(lit('machines.list'), isFalse);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(lit('machines.list'), isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const ValueKey('web-menu:machines.list')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('an empty tab opens New harness on a connected machine', (
    tester,
  ) async {
    // The app opens New Harness in the box; tests default to the old form.
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final app = await _mount(tester, connectedMachine: 'remote-box');
    // A browser is never a machine: the connected one is where it starts,
    // with no "Choose a machine" step in between.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 200)),
    );
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
    expect(find.byType(WorkspaceMachinePrompt), findsNothing);
    expect(find.byType(NewHarnessForm), findsOneWidget);
    // A new harness takes files: 📎 and drops on its box.
    expect(find.byKey(const ValueKey('new-harness-attach')), findsOneWidget);
    expect(find.byKey(const ValueKey('new-harness-drop')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('New harness with nothing connected opens Machines', (
    tester,
  ) async {
    final app = await _mount(tester);
    // New work starts where a new tab opens: its "Start an agent" row.
    await tester.tap(find.byKey(const ValueKey('welcome-agent.new')));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(NewHarnessForm), findsNothing);
    expect(
      tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search
          .scopePrefix,
      '@',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('View on a machine picks it and closes Machines', (tester) async {
    final app = await _mount(tester, connectedMachine: 'remote-box');
    await _openMenu(tester);
    await tester.tap(find.byKey(const ValueKey('web-menu:machines.list')));
    await tester.pump(const Duration(milliseconds: 400));
    final search = tester
        .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
        .search;
    final index = search.rows.indexWhere(
      (row) => row.isMachine && row.machineId == 'remote-box',
    );
    search.move(index - search.cursor);
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(
      find.byKey(const ValueKey('resource-action:picker.resource_view')),
    );
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(SwarmSearchResults), findsNothing);
    expect(app.selectedMachineId, 'remote-box');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('an empty new tab closes from its close mark', (tester) async {
    final app = await _mount(tester);
    app.newSwarm(newTabPage: true);
    await tester.pump(const Duration(milliseconds: 200));
    final tabs = app.swarms.length;
    final empty = app.activeSwarmId;
    expect(app.activeSwarm.panes, isEmpty);
    // The close mark shows under the mouse, as on desktop.
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(
      tester.getCenter(find.byKey(ValueKey('tab-close:$empty'))),
    );
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.byKey(ValueKey('tab-close:$empty')));
    // Past the tab's double-tap-to-rename window, which holds the tap.
    await tester.pump(const Duration(milliseconds: 400));
    expect(app.swarms, hasLength(tabs - 1));
    expect(app.swarms.any((tab) => tab.id == empty), isFalse);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('tabs too many for the bar scroll by arrows and wheel', (
    tester,
  ) async {
    final app = await _mount(tester);
    expect(find.byKey(const ValueKey('tab-scroll-right')), findsNothing);
    for (var i = 0; i < 24; i++) {
      app.newSwarm(newTabPage: true);
    }
    await tester.pump(const Duration(milliseconds: 200));
    // The arrows read the list's extent after it lays out: one more frame.
    await tester.pump();
    final left = find.byKey(const ValueKey('tab-scroll-left'));
    final right = find.byKey(const ValueKey('tab-scroll-right'));
    expect(left, findsOneWidget);
    expect(right, findsOneWidget);
    bool enabled(Finder arrow) =>
        tester.widget<WorkspaceBarControl>(arrow).onPressed != null;
    final scrollable = tester.state<ScrollableState>(
      find
          .descendant(
            of: find.byKey(const ValueKey('workspace-tab-bar')),
            matching: find.byType(Scrollable),
          )
          .first,
    );

    // A plain vertical wheel over the strip moves it sideways — here all the
    // way back to the first tab, where the left arrow has nowhere to go.
    await tester.sendEventToBinding(
      PointerScrollEvent(
        position: tester.getCenter(left) + const Offset(80, 0),
        scrollDelta: const Offset(0, -100000),
      ),
    );
    await tester.pump();
    expect(scrollable.position.pixels, scrollable.position.minScrollExtent);
    expect(enabled(left), isFalse);
    expect(enabled(right), isTrue);

    await tester.tap(right);
    // One frame starts the page animation, the next lands it.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(scrollable.position.pixels, greaterThan(0));
    expect(enabled(left), isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('crossing into and out of overflow keeps one tab list', (
    tester,
  ) async {
    final app = await _mount(tester);
    for (var i = 0; i < 12; i++) {
      app.newSwarm(newTabPage: true);
    }
    for (final width in [1800.0, 900.0, 1800.0, 700.0, 1280.0]) {
      tester.view.physicalSize = Size(width, 800);
      await tester.pump();
      await tester.pump();
      expect(tester.takeException(), isNull, reason: 'width $width');
    }
    while (app.swarms.length > 2) {
      await app.closeSwarm(app.swarms.last.id);
      await tester.pump();
      await tester.pump();
      expect(tester.takeException(), isNull, reason: '${app.swarms.length}');
    }
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('keys still reach Settings beside the menu', (tester) async {
    final app = await _mount(tester);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.comma);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });
}
