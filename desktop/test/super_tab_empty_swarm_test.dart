import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'swarm_state_test.dart' show createApp;

/// Audit finding 20 (task #4445): a Swarm with no projects says one sentence for both ways to start, under two
/// matching buttons, and a pending action in plain words.

Finder _key(String k) => find.byKey(ValueKey(k));

/// The button in the middle whose label is [label].
Finder _button(String label) => find.ancestor(
  of: find.descendant(
    of: _key('super-center-pane'),
    matching: find.text(label),
  ),
  matching: find.byWidgetPredicate((w) => w is ButtonStyleButton),
);

Future<SuperTabController> _show(
  WidgetTester tester, {
  Map<String, dynamic>? pending,
}) async {
  await tester.binding.setSurfaceSize(const Size(1500, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final server = swarm();
  server.state['projects'] = <dynamic>[];
  server.state['conversations'] = <dynamic>[];
  server.state['agents'] = <dynamic>[];
  final c = server.controller(
    account: 'owner',
    initial: {
      'tabId': 'tab',
      'accountId': 'owner',
      'selectedId': 'lead',
      'pending': ?pending,
    },
  );
  await tester.runAsync(c.refresh);
  // The memory store and a fake sign-in: nothing here reads the real CLI's login.
  final AppNotifier app = createApp();
  addTearDown(app.dispose);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          app: app,
          onNewSwarm: () {},
          onNewProject: () {},
          onNewAgent: () {},
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac Studio',
          board: true,
          rightPane: (_) => const SizedBox.expand(),
        ),
      ),
    ),
  );
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
  return c;
}

Future<void> _end(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await tester.runAsync(c.flush);
  c.dispose();
  await tester.pump(const Duration(seconds: 5));
}

void main() {
  testWidgets('one sentence for both ways to start, over two matching + '
      'buttons', (tester) async {
    final c = await _show(tester);
    expect(
      find.text('Start a project, or bring an agent to work with you.'),
      findsOneWidget,
    );
    final project = _button('New project'), agent = _button('New agent');
    expect(project, findsOneWidget);
    expect(agent, findsOneWidget);
    expect(
      tester.widget(project).runtimeType,
      tester.widget(agent).runtimeType,
      reason: 'drawn by the same widget',
    );
    expect(tester.getSize(project), tester.getSize(agent));
    for (final button in [project, agent]) {
      expect(
        find.descendant(of: button, matching: find.byIcon(AppIcons.plus)),
        findsOneWidget,
      );
    }
    await _end(tester, c);
  });

  testWidgets('a pending action reads Check again', (tester) async {
    final c = await _show(
      tester,
      pending: {
        'operationId': 'op-1',
        'command': {'type': 'project.create', 'name': 'web'},
      },
    );
    expect(c.hasPendingAction, isTrue);
    expect(_button('Check again'), findsOneWidget);
    expect(find.text('Check pending action'), findsNothing);
    await _end(tester, c);
  });
}
