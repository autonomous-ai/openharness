import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_BOARD_NAV_SHOTS'];

Map<String, dynamic> _agent(String id, String name, String kind) => {
  'id': id,
  'projectId': 'lead',
  'name': name,
  'displayName': name,
  'machineId': 'host',
  'harnessId': 'session',
  'contributorId': 'owner',
  'configuration': {'engine': 'codex'},
  'kind': kind,
  'myAgent': true,
};

/// The v3 Swarm (task #4441, audit of 1.3.89 findings 1 and 5): the reader's Buddy, a PM Orion leading `# web-project`
/// and a task "Windows credential fix" on its Board, with the Tasks pane on the right.
Future<SuperTabController> _open(
  WidgetTester tester,
  Brightness brightness,
) async {
  await tester.binding.setSurfaceSize(const Size(1500, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  final server = swarm();
  final groups = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>();
  server.state['swarmBuddy'] = true;
  server.state['agents'] = [
    {
      ..._agent('buddy', 'Buddy', 'buddy'),
      'buddyScope': 'swarm',
      'buddyOf': {'personId': 'owner'},
      'chatId': 'swarm-buddy-owner',
    },
    {..._agent('orion', 'Orion', 'pm'), 'chatId': 'lead'},
    {..._agent('kestrel', 'Kestrel', 'regular'), 'myAgent': false},
  ];
  groups.add({
    ...conversationFixture('swarm-buddy-owner', 'Buddy'),
    'kind': 'swarm-buddy',
    'buddyOwnerId': 'owner',
    'agentIds': ['buddy'],
  });
  groups.firstWhere((g) => g['id'] == 'lead')['leadId'] = 'orion';
  server.append('Working on the fix.', conversationId: 'offline');
  final c = server.controller(
    account: 'owner',
    initial: {
      'tabId': 'tab',
      'accountId': 'owner',
      'selectedId': 'swarm-buddy-owner',
      'projectsGroupOpen': true,
    },
  );
  await tester.runAsync(c.refresh);
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
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac Studio',
          board: true,
          rightPane: (_) => Center(
            child: Text(
              'Tasks pane (stand-in)',
              style: TextStyle(color: grid.AppPalette.textFaint),
            ),
          ),
        ),
      ),
    ),
  );
  await _settle(tester);
  return c;
}

/// [body] in both appearances, its window captured as [shot] for the PR; the Swarm closed after it, passed or failed.
void _scene(
  String name,
  String shot,
  Future<void> Function(WidgetTester tester, SuperTabController c) body,
) {
  for (final brightness in Brightness.values) {
    testWidgets('$name (${brightness.name})', (tester) async {
      final c = await _open(tester, brightness);
      try {
        await body(tester, c);
        await captureWindow(tester, shots, '$shot-${brightness.name}');
      } finally {
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(c.flush);
        c.dispose();
        await tester.pump(const Duration(seconds: 5));
      }
    });
  }
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// Whether the left pane's row [key] is lit: an agent's row says so itself; a project's row by its selected fill.
bool _lit(WidgetTester tester, String key) {
  final row = find.byKey(ValueKey(key));
  final widget = tester.widget(row);
  if (widget is SuperTabBuddyRow) return widget.selected;
  final ground = tester.widget<Material>(
    find.ancestor(of: row, matching: find.byType(Material)).first,
  );
  return ground.color == grid.SidebarInk.selected;
}

/// The rows the left pane lights, of Buddy, the PM Orion and the project `# web-project`.
List<String> _litRows(WidgetTester tester) => [
  for (final key in [
    'super-swarm-buddy',
    'super-agent-orion',
    'super-group-lead',
  ])
    if (_lit(tester, key)) key,
];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  _scene('a Board card opens its task in the middle', 'board-card-opens-task', (
    tester,
    c,
  ) async {
    await tester.tap(find.byKey(const ValueKey('super-group-lead')));
    await _settle(tester);
    await tester.tap(find.byKey(const ValueKey('super-task-card-offline')));
    await _settle(tester);

    expect(c.selectedId, 'offline');
    expect(find.byKey(const ValueKey('super-board-tab-board')), findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('super-middle-chat')),
        matching: find.text('Working on the fix.'),
      ),
      findsOneWidget,
    );
  });

  _scene('a Board lights its project row, not Buddy', 'board-lights-project', (
    tester,
    c,
  ) async {
    await tester.tap(find.byKey(const ValueKey('super-group-lead')));
    await _settle(tester);

    expect(find.byKey(const ValueKey('super-board-tab-board')), findsOneWidget);
    expect(_litRows(tester), ['super-group-lead']);
  });

  _scene('a PM lights its own row alone', 'pm-lights-one-row', (
    tester,
    c,
  ) async {
    await tester.tap(find.byKey(const ValueKey('super-agent-orion')));
    await _settle(tester);

    expect(c.selectedId, 'lead');
    expect(_litRows(tester), ['super-agent-orion']);
  });
}
