import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_V3_EMPTY_ORG_SHOTS'];

/// A new org with no projects on the Desktop (task #4219): its middle says how to start, with New project and + New
/// agent, and never waits on a "Loading conversation…" that cannot end.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 3; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  Future<SuperTabController> show(
    WidgetTester tester, {
    Brightness brightness = Brightness.light,
    void Function(ConversationServer server)? setup,
    VoidCallback? onNewProject,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1500, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final before = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = before);
    final server = swarm();
    server.state['projects'] = <dynamic>[];
    server.state['conversations'] = <dynamic>[];
    server.state['agents'] = <dynamic>[];
    setup?.call(server);
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    await tester.runAsync(c.refresh);
    // The memory store and a fake sign-in: nothing here reads the real CLI's login.
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            app: app,
            onNewSwarm: () {},
            onNewProject: onNewProject,
            onNewAgent: () {},
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            board: true,
            rightPane: (_) => Center(
              child: Text(
                'Tasks (v3)',
                style: TextStyle(color: grid.AppPalette.textFaint),
              ),
            ),
          ),
        ),
      ),
    );
    await settle(tester);
    return c;
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(c.flush);
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  testWidgets('no projects: the way to start, not an endless Loading', (
    tester,
  ) async {
    var made = 0;
    final c = await show(tester, onNewProject: () => made++);
    expect(find.text('Loading conversation…'), findsNothing);
    expect(find.text('Create a project to get started.'), findsOneWidget);
    final project = find.widgetWithText(FilledButton, 'New project');
    expect(project, findsOneWidget);
    expect(find.byKey(const ValueKey('super-empty-new-agent')), findsOneWidget);
    await tester.tap(project);
    expect(made, 1);
    await end(tester, c);
  });

  testWidgets('no projects, an agent\'s chat open: the chat, not the start', (
    tester,
  ) async {
    final c = await show(
      tester,
      setup: (server) {
        server.state['conversations'] = [
          {
            ...conversationFixture('agent-chat-kestrel', 'Kestrel'),
            'kind': 'agent-chat',
          },
        ];
      },
    );
    expect(find.text('Create a project to get started.'), findsOneWidget);
    unawaited(c.select('agent-chat-kestrel'));
    await settle(tester);
    expect(c.selected?.id, 'agent-chat-kestrel');
    expect(find.text('Create a project to get started.'), findsNothing);
    await end(tester, c);
  });

  for (final brightness in Brightness.values) {
    testWidgets('picture (${brightness.name})', (tester) async {
      final c = await show(tester, brightness: brightness, onNewProject: () {});
      await captureWindow(tester, shots, 'empty-org-${brightness.name}');
      await end(tester, c);
    });
  }
}
