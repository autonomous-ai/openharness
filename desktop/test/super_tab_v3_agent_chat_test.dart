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
final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

Map<String, dynamic> _agent(String id, String name, String kind, String chat) =>
    {
      'id': id,
      'projectId': 'lead',
      'name': name,
      'displayName': name,
      'machineId': 'host',
      'harnessId': 'session-$id',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
      'kind': kind,
      'chatId': chat,
      'myAgent': true,
    };

/// Audit findings 8, 16 and 18 of the Desktop 1.3.89 audit (#4436; task #4444): an agent's chat in Swarm v3's middle,
/// opened from My agents. Its composer, its ⋮ and a PM's header.
void main() {
  setUpAll(() => loadCaptureFonts(shots));
  Finder key(String k) => find.byKey(ValueKey(k));

  late ConversationServer server;

  Future<SuperTabController> open(
    WidgetTester tester,
    String agent, {
    Brightness brightness = Brightness.light,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1500, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final before = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = before);
    server = swarm();
    server.state['agents'] = [
      _agent('kestrel', 'Kestrel', 'regular', 'agent-chat-kestrel'),
      _agent('orion', 'Orion', 'pm', 'lead'),
    ];
    final groups = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    groups.firstWhere((g) => g['id'] == 'lead')['leadId'] = 'orion';
    groups.add({
      ...conversationFixture('agent-chat-kestrel', 'Kestrel'),
      'kind': 'agent-chat',
      'agentIds': ['kestrel'],
    });
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    addTearDown(() => tester.pumpWidget(const SizedBox()));
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            app: app,
            onNewSwarm: () {},
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
    await settle(tester);
    await tester.tap(key('super-agent-$agent'));
    await settle(tester);
    return c;
  }

  // Finding 8: after a rename the header and messages said "Atlas", the composer still "Message Kestrel".
  testWidgets('an agent\'s composer follows its rename', (tester) async {
    final c = await open(tester, 'kestrel');
    expect(find.text('Message Kestrel'), findsOneWidget);
    expect(
      await tester.runAsync(() => c.renameAgent('kestrel', 'Atlas')),
      isNull,
    );
    await settle(tester);
    expect(find.text('Message Atlas'), findsOneWidget);
    expect(find.text('Message Kestrel'), findsNothing);
  });

  // Finding 16: the ⋮ said "Workgroup options" and its Rename renamed the chat, so the header kept the agent's name.
  testWidgets('an agent\'s ⋮ is Agent options, and its Rename renames the '
      'agent', (tester) async {
    await open(tester, 'kestrel');
    final menu = find.descendant(
      of: key('super-middle-chat'),
      matching: key('super-group-options'),
    );
    expect(find.byTooltip('Workgroup options'), findsNothing);
    expect(
      find.descendant(of: menu, matching: find.byTooltip('Agent options')),
      findsOneWidget,
    );
    await tester.tap(menu);
    await settle(tester);
    await tester.tap(find.text('Rename'));
    await settle(tester);
    final field = key('agent-rename-input');
    expect(tester.widget<TextField>(field).controller!.text, 'Kestrel');
    await tester.enterText(field, 'Atlas');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester);
    final agent = (server.state['agents'] as List).cast<Map>().firstWhere(
      (a) => a['id'] == 'kestrel',
    );
    expect(agent['displayName'], 'Atlas');
    // The chat keeps its own title; the agent's name is what changed.
    expect(
      (server.state['conversations'] as List).cast<Map>().firstWhere(
        (g) => g['id'] == 'agent-chat-kestrel',
      )['title'],
      'Kestrel',
    );
    expect(
      find.descendant(
        of: key('super-agent-chat-header'),
        matching: find.text('Atlas'),
      ),
      findsOneWidget,
    );
  });

  // Finding 18: the Board / Chat tabs sat alone on a row above "# web-project ▾", jumped on Board → Chat, and the Tasks
  // icon opened the Board as the Board tab did.
  testWidgets('a PM\'s chat has one header row, and one way to the Board', (
    tester,
  ) async {
    await open(tester, 'orion');
    final board = key('super-board-tab-board');
    final chat = key('super-board-tab-chat');
    final title = key('super-project-menu');
    expect(board, findsOneWidget);
    double row(Finder f) => tester.getRect(f.first).center.dy;
    expect((row(board) - row(title)).abs(), lessThan(4));
    expect((row(chat) - row(title)).abs(), lessThan(4));
    expect((row(key('super-members-button')) - row(title)).abs(), lessThan(4));
    expect(
      tester.getRect(board).left,
      greaterThan(tester.getRect(title.first).right),
    );
    expect(key('super-tasks'), findsNothing);
    final chatTab = tester.getRect(board);
    await tester.tap(board);
    await settle(tester);
    // The Board's own header: its tabs on the same line as in the chat.
    expect(
      (tester.getRect(board).center.dy - chatTab.center.dy).abs(),
      lessThan(4),
    );
    await tester.tap(chat);
    await settle(tester);
    expect(key('super-tasks'), findsNothing);
    expect((row(board) - row(title)).abs(), lessThan(4));
    // The tabs' tooltips and the Board's settle timers run out.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('screenshots, light and dark', (tester) async {
    for (final brightness in Brightness.values) {
      final c = await open(tester, 'kestrel', brightness: brightness);
      await tester.runAsync(() => c.renameAgent('kestrel', 'Atlas'));
      await settle(tester);
      await captureWindow(
        tester,
        shots,
        '08-composer-renamed-${brightness.name}',
      );
      await tester.tap(
        find.descendant(
          of: key('super-middle-chat'),
          matching: key('super-group-options'),
        ),
      );
      await settle(tester);
      await captureWindow(tester, shots, '16-agent-menu-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      await open(tester, 'orion', brightness: brightness);
      await captureWindow(
        tester,
        shots,
        '18-pm-chat-one-row-${brightness.name}',
      );
      await tester.pumpWidget(const SizedBox());
    }
  }, skip: shots == null);
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}
