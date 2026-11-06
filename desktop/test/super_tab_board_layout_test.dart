import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

/// Task #3787 (anh Dee, 11-06): the left rail, the project's Board in the middle and the person's Buddy on the right.
/// Opening a project shows its Board; a card's chat opens on the right, flat, with a way back to the Buddy; the
/// left rail has no Buddy entry and no Threads; both side panes hide and show, remembered.

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _key(String k) => find.byKey(ValueKey(k));

void main() {
  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    LocalKeyValueStore? store,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1500, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm();
    server.append('The project chat line nobody should see');
    final conversations = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    conversations.add({
      ...conversationFixture('buddy-owner-lead', 'Buddy'),
      'kind': 'buddy',
      'projectId': 'lead',
      'buddyOwnerId': 'owner',
      'agentIds': <String>[],
    });
    conversations.firstWhere((g) => g['id'] == 'offline')
      ..['number'] = 42
      ..['assignment'] = {
        'id': 'a1',
        'agentId': 'kestrel',
        'status': 'working',
      };
    server.append('Working on the fix.', conversationId: 'offline');
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
            paneStore: store,
            board: true,
          ),
        ),
      ),
    );
    await _settle(tester);
    return (c, server);
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    c.dispose();
    await tester.pump(const Duration(seconds: 5));
  }

  testWidgets('opening a project shows its Board, and the right pane is the '
      "person's Buddy, not the project chat", (tester) async {
    final (c, _) = await show(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    expect(c.selectedId, 'buddy-owner-lead');
    expect(find.text('The project chat line nobody should see'), findsNothing);
    expect(_key('super-board-chat'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets("a card's chat opens on the right beside the Board, and its "
      'header goes back to the Buddy', (tester) async {
    final (c, _) = await show(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    await tester.tap(_key('super-task-card-offline'));
    await _settle(tester);
    expect(c.selectedId, 'offline');
    expect(_key('super-tasks-lead'), findsOneWidget, reason: 'the Board stays');
    expect(find.text('Working on the fix.'), findsOneWidget);
    await tester.tap(_key('super-board-chat-buddy'));
    await _settle(tester);
    expect(c.selectedId, 'buddy-owner-lead');
    expect(_key('super-tasks-lead'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets("a card's chat is flat: its thread replies show inline, in time "
      'order, with no thread line', (tester) async {
    final (c, server) = await show(tester);
    final root = server.messages
        .lastWhere((m) => m['conversationId'] == 'offline')['id'] as String;
    server.append('A reply in its thread.', conversationId: 'offline');
    server.messages.last['thread'] = root;
    await tester.runAsync(c.refresh);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    await tester.tap(_key('super-task-card-offline'));
    await _settle(tester);
    expect(find.text('Working on the fix.'), findsOneWidget);
    expect(find.text('A reply in its thread.'), findsOneWidget);
    expect(find.textContaining('1 reply'), findsNothing);
    await end(tester, c);
  });

  testWidgets('the left rail has no Buddy entry and no Threads', (
    tester,
  ) async {
    final (c, _) = await show(tester);
    expect(_key('super-threads'), findsNothing);
    expect(_key('super-swarm-buddy'), findsNothing);
    expect(_key('super-group-buddy-owner-lead'), findsNothing);
    expect(find.text('Buddies'), findsNothing);
    await end(tester, c);
  });

  testWidgets('each side pane hides and shows, and a new view starts as it '
      'was left', (tester) async {
    final store = _Memory();
    final (c, _) = await show(tester, store: store);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(_key('super-group-lead'), findsOneWidget);
    await tester.tap(_key('super-pane-left-toggle'));
    await _settle(tester);
    expect(_key('super-group-lead'), findsNothing, reason: 'left rail hidden');
    await tester.tap(_key('super-pane-right-toggle'));
    await _settle(tester);
    expect(_key('super-board-chat'), findsNothing, reason: 'Buddy hidden');
    expect(_key('super-tasks-lead'), findsOneWidget);
    await end(tester, c);

    // A new view: the project's Board opens as the panes were left.
    final (again, _) = await show(tester, store: store);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    expect(_key('super-group-lead'), findsNothing, reason: 'still hidden');
    expect(_key('super-board-chat'), findsNothing, reason: 'still hidden');
    await tester.tap(_key('super-pane-left-toggle'));
    await _settle(tester);
    expect(_key('super-group-lead'), findsOneWidget);
    await end(tester, again);
  });
}
