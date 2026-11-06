import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_right_pane_row_test.dart' show buddy;
import 'support/memory_key_value_store.dart';

Finder key(String value) => find.byKey(ValueKey(value));

void main() {
  Future<SuperTabController> show(WidgetTester tester, {ValueChanged<SuperTabAgent>? terminal}) async {
    await tester.binding.setSurfaceSize(const Size(1800, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    server.state['swarmBuddy'] = true;
    server.state['buddyCap'] = 5;
    (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
      {...buddy('code', 'Code'), 'agentIds': ['buddy-code']},
      {...buddy('plan', 'Planning', first: true), 'agentIds': ['buddy-plan']},
    ]);
    for (final id in ['code', 'plan']) {
      (server.state['agents'] as List).add(<String, dynamic>{
        'id': 'buddy-$id', 'name': id, 'machineId': 'host', 'harnessId': 'session-$id',
        'contributorId': 'owner', 'buddyOf': {'personId': 'owner'}, 'buddyScope': 'swarm',
        'configuration': {'engine': 'claude'},
      });
    }
    final c = server.controller(account: 'owner', initial: {
      'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead',
    });
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(body: SuperTabView(controller: c,
        paneStore: MemoryKeyValueStore()..values['swarm_right_pane_hidden'] = '1',
        onInvite: () {}, onAddAgent: (_) {}, onOpenTerminal: terminal ?? (_) {},
        machineName: (_) => 'Mac Studio', board: true)),
    ));
    await tester.tap(key('super-group-lead'));
    await tester.runAsync(() => c.loadMessages(c.selectedId));
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  testWidgets('opening a Board card adds its chat once and keeps the Board and wide chat visible', (tester) async {
    final c = await show(tester);
    expect(key('super-right-pane-row'), findsOneWidget);
    expect(key('super-pane-right-toggle'), findsNothing);
    final board = key('super-tasks-lead');
    final before = tester.getRect(board);
    await tester.tap(find.text('Windows credential fix').first);
    await tester.runAsync(() => c.loadMessages('offline'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'offline');
    expect(key('super-chat-tab-offline'), findsOneWidget);
    expect(tester.getRect(board), before);
    expect(tester.getSize(key('super-board-chat')).width, greaterThanOrEqualTo(440));
    await tester.tap(find.text('Windows credential fix').first);
    await tester.pumpAndSettle();
    expect(key('super-chat-tab-offline'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets('Open terminal in selected Buddy header and menu targets that Buddy', (tester) async {
    final opened = <String>[];
    final c = await show(tester, terminal: (agent) => opened.add(agent.id));
    await tester.tap(key('super-buddy-tab-plan'));
    await tester.pumpAndSettle();
    await tester.tap(key('super-buddy-open-terminal'));
    expect(opened, ['buddy-plan']);
    await tester.tap(key('super-buddy-tab-code'));
    await tester.pumpAndSettle();
    await tester.tap(key('super-buddy-menu'));
    await tester.pumpAndSettle();
    await tester.tap(key('super-buddy-menu-terminal'));
    expect(opened, ['buddy-plan', 'buddy-code']);
    await end(tester, c);
  });
}
