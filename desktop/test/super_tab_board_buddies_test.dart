import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// Task #3820 (Phase 2 of the Board, spec "Many Buddies"; #3818's contract): the right pane lists the reader's
/// Buddies, the default first; choosing one shows its chat; + New Buddy names a new one; each can be made the default,
/// renamed or removed. A Swarm whose server makes one Buddy (no `buddyCap`) keeps today's pane.

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _key(String k) => find.byKey(ValueKey(k));

Iterable<Map> _commands(ConversationServer server, String type) => [
  for (final post in server.posts)
    if ((post['command'] as Map?)?['type'] == type) post['command'] as Map,
];

Map<String, dynamic> _buddy(String id, String name, {bool isDefault = false}) =>
    {
      ...conversationFixture(id, name),
      'kind': 'swarm-buddy',
      'buddyOwnerId': 'owner',
      'buddyName': name,
      'agentIds': <String>[],
      if (isDefault) 'buddyDefault': true,
    }..remove('projectId');

void main() {
  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    bool several = true,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1600, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    server.state['swarmBuddy'] = true;
    if (several) server.state['buddyCap'] = 5;
    server.state['machines'] = [
      {
        'machineId': 'mac',
        'name': 'Mac Studio',
        'contributorId': 'owner',
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'resources': {'cpuPercent': 5},
        },
      },
    ];
    (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
      _buddy('b-code', 'Code'),
      _buddy('b-plan', 'Planning', isDefault: true),
    ]);
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            board: true,
          ),
        ),
      ),
    );
    await _settle(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    return (c, server);
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  Future<void> menu(WidgetTester tester, String item) async {
    await tester.tap(_key('super-buddy-menu'));
    await _settle(tester);
    await tester.tap(_key(item));
    await _settle(tester);
  }

  testWidgets('the right pane lists the Buddies, the default first and '
      'open; choosing one shows its chat', (tester) async {
    final (c, _) = await show(tester);
    expect(c.selectedId, 'b-plan');
    final plan = tester.getTopLeft(_key('super-buddy-tab-b-plan'));
    final code = tester.getTopLeft(_key('super-buddy-tab-b-code'));
    // Reading order, in a pane narrow enough to wrap them.
    expect(
      plan.dy < code.dy || plan.dy == code.dy && plan.dx < code.dx,
      isTrue,
    );
    expect(
      find.descendant(
        of: _key('super-buddy-tab-b-plan'),
        matching: find.textContaining('Planning'),
      ),
      findsOneWidget,
    );
    await tester.tap(_key('super-buddy-tab-b-code'));
    await _settle(tester);
    expect(c.selectedId, 'b-code');
    expect(_key('super-board-chat'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets('+ New Buddy names a new one on the reader\'s machine', (
    tester,
  ) async {
    final (c, server) = await show(tester);
    await tester.tap(_key('super-buddy-new'));
    await _settle(tester);
    await tester.enterText(_key('super-buddy-new-name'), 'Research');
    await tester.pump();
    await tester.tap(_key('super-buddy-new-add'));
    await _settle(tester);
    expect(_commands(server, 'buddy.create'), [
      {
        'type': 'buddy.create',
        'machineId': 'mac',
        'engine': 'claude',
        'name': 'Research',
      },
    ]);
    expect(_key('super-buddy-new-add'), findsNothing, reason: 'closed');
    await end(tester, c);
  });

  testWidgets("the cap's refusal is said in the New Buddy form", (
    tester,
  ) async {
    final (c, server) = await show(tester);
    await tester.tap(_key('super-buddy-new'));
    await _settle(tester);
    await tester.enterText(_key('super-buddy-new-name'), 'Research');
    await tester.pump();
    server
      ..refuse = {
        'code': 'BUDDY_CAP',
        'message':
            'You have 5 Buddies, the most this Swarm allows. Remove one to '
            'add another.',
      }
      ..refuseStatus = 409;
    await tester.tap(_key('super-buddy-new-add'));
    await _settle(tester);
    expect(
      tester.widget<Text>(_key('super-buddy-new-error')).data,
      'You have 5 Buddies, the most this Swarm allows. Remove one to add '
      'another.',
    );
    await end(tester, c);
  });

  testWidgets(
    'a Buddy is made the default, renamed and removed from its menu',
    (tester) async {
      final (c, server) = await show(tester);
      await tester.tap(_key('super-buddy-tab-b-code'));
      await _settle(tester);
      await menu(tester, 'super-buddy-make-default');
      expect(_commands(server, 'buddy.default'), [
        {'type': 'buddy.default', 'conversationId': 'b-code'},
      ]);
      await menu(tester, 'super-buddy-rename');
      await tester.enterText(_key('super-buddy-name'), 'Coding');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await _settle(tester);
      expect(_commands(server, 'buddy.rename').last, {
        'type': 'buddy.rename',
        'conversationId': 'b-code',
        'name': 'Coding',
      });
      await menu(tester, 'super-buddy-remove');
      await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
      await _settle(tester);
      expect(_commands(server, 'buddy.remove'), [
        {'type': 'buddy.remove', 'conversationId': 'b-code'},
      ]);
      await end(tester, c);
    },
  );

  testWidgets('a server that makes one Buddy keeps today\'s pane', (
    tester,
  ) async {
    final (c, _) = await show(tester, several: false);
    expect(_key('super-buddy-list'), findsNothing);
    expect(_key('super-buddy-new'), findsNothing);
    await end(tester, c);
  });
}
