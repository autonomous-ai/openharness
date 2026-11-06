import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart' show SuperTabReplyPreview;
import 'package:harness/super_tabs/tasks_bar.dart';
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

/// The Board's Swarm: project lead with its chat, a task with a card, and the
/// owner's Buddy chat there; with [buddy], a Buddy running in it.
ConversationServer boardSwarm({bool buddy = false}) {
  final server = swarm();
  server.append('The project chat line nobody should see');
  final conversations = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>();
  conversations.add({
    ...conversationFixture('buddy-owner-lead', 'Buddy'),
    'kind': 'buddy',
    'projectId': 'lead',
    'buddyOwnerId': 'owner',
    'agentIds': <String>[if (buddy) 'wren'],
  });
  if (buddy) {
    (server.state['agents'] as List).add({
      'id': 'wren',
      'name': 'Wren',
      'projectId': 'lead',
      'buddyOf': {'personId': 'owner', 'generation': 'fixture'},
      'machineId': 'studio',
      'harnessId': 'h-wren',
      'contributorId': 'owner',
      'machineOwnerId': 'owner',
      'confidential': true,
      'configuration': {'engine': 'claude', 'model': 'default'},
    });
  }
  conversations.firstWhere((g) => g['id'] == 'offline')
    ..['number'] = 42
    ..['assignment'] = {'id': 'a1', 'agentId': 'kestrel', 'status': 'working'};
  server.append('Working on the fix.', conversationId: 'offline');
  return server;
}

void main() {
  Future<(SuperTabController, ConversationServer)> show(
    WidgetTester tester, {
    LocalKeyValueStore? store,
    bool buddy = false,
    Size size = const Size(1500, 900),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = boardSwarm(buddy: buddy);
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
    final root =
        server.messages.lastWhere((m) => m['conversationId'] == 'offline')['id']
            as String;
    server.append('A reply in its thread.', conversationId: 'offline');
    server.messages.last['thread'] = root;
    await tester.runAsync(c.refresh);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    await tester.tap(_key('super-task-card-offline'));
    await _settle(tester);
    // The root, and its quote on the reply below.
    expect(find.text('Working on the fix.'), findsWidgets);
    expect(find.text('A reply in its thread.'), findsOneWidget);
    expect(find.textContaining('1 reply'), findsNothing);
    // Each reply says what it answers, as on the phone (Ken's review of the spec).
    expect(
      find.descendant(
        of: find.byType(SuperTabReplyPreview),
        matching: find.textContaining('Working on the fix.'),
      ),
      findsOneWidget,
    );
    await end(tester, c);
  });

  testWidgets('the project chat stays a tab away: Chat beside Board, Board '
      'first (Ken)', (tester) async {
    final (c, _) = await show(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    await tester.tap(_key('super-board-tab-chat'));
    await _settle(tester);
    expect(c.selectedId, 'lead');
    expect(
      find.text('The project chat line nobody should see'),
      findsOneWidget,
    );
    expect(_key('super-tasks-lead'), findsNothing);
    await tester.tap(_key('super-board-tab-board'));
    await _settle(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    expect(c.selectedId, 'buddy-owner-lead');
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

  testWidgets('the left rail hides and shows, and a new view starts as it '
      'was left', (tester) async {
    final store = _Memory();
    final (c, _) = await show(tester, store: store);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(_key('super-group-lead'), findsOneWidget);
    await tester.tap(_key('super-pane-left-toggle'));
    await _settle(tester);
    expect(_key('super-group-lead'), findsNothing, reason: 'left rail hidden');
    expect(_key('super-tasks-lead'), findsOneWidget);
    await end(tester, c);

    // A new view: the project's Board opens as the rail was left.
    final (again, _) = await show(tester, store: store);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(_key('super-tasks-lead'), findsOneWidget);
    expect(_key('super-group-lead'), findsNothing, reason: 'still hidden');
    await tester.tap(_key('super-pane-left-toggle'));
    await _settle(tester);
    expect(_key('super-group-lead'), findsOneWidget);
    await end(tester, again);
  });

  // anh Dee's fixed layout (#3863): with Show your Buddy gone, a Buddy pane that could hide would never come back.
  // Nothing hides it, and a hidden state saved by an earlier build is not read (review of #3398).
  testWidgets('the Buddy pane always shows, with no hide button, even when '
      'an earlier build saved it hidden', (tester) async {
    final store = _Memory()..values['swarm_right_pane_hidden'] = '1';
    final (c, _) = await show(tester, store: store);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(_key('super-board-chat'), findsOneWidget);
    expect(_key('super-pane-right-toggle'), findsNothing);
    expect(find.byTooltip('Hide your Buddy'), findsNothing);
    await end(tester, c);
  });

  testWidgets('the Buddy pane beside the Board has its options: Remove is '
      'one menu away (Huy, 2026-11-06)', (tester) async {
    final (c, _) = await show(tester, buddy: true);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    final options = find.descendant(
      of: _key('super-board-chat'),
      matching: find.byTooltip('Buddy options'),
    );
    expect(options, findsOneWidget);
    await tester.tap(options);
    await _settle(tester);
    expect(find.text('Remove Buddy'), findsOneWidget);
    expect(find.text('Restart Buddy…'), findsOneWidget);
    expect(find.text('Rename Buddy…'), findsOneWidget);
    await end(tester, c);
  });

  testWidgets('with room, the Board has one row above its lanes: the header, '
      'the layout, Mine and Search (Huy, 2026-11-06), and no Show your Buddy '
      '(anh Dee: a fixed layout, #3863)', (tester) async {
    final (c, _) = await show(tester);
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    await tester.tap(_key('super-pane-left-toggle'));
    await _settle(tester);
    final row = tester.getCenter(_key('super-pane-left-toggle')).dy;
    for (final key in [
      'super-tasks-layout',
      'super-tasks-mine',
      'super-tasks-search',
      'super-board-tab-board',
    ]) {
      expect(
        tester.getCenter(_key(key)).dy,
        moreOrLessEquals(row),
        reason: key,
      );
    }
    expect(find.text('Tasks'), findsNothing, reason: 'the header names it');
    expect(find.byTooltip('Show your Buddy'), findsNothing);
    await end(tester, c);
  });

  testWidgets('in a window too narrow for all three panes, the side panes give '
      'way so the Board keeps its minimum width (Huy, 2026-11-06)', (
    tester,
  ) async {
    // The rail's 300 and the Buddy pane's 280 leave the Board 520 of 1100.
    final (c, _) = await show(tester, size: const Size(1100, 900));
    await tester.tap(_key('super-group-lead'));
    await _settle(tester);
    expect(
      tester.getSize(_key('super-tasks-lead')).width,
      greaterThanOrEqualTo(SuperTabTasksBar.minWidth),
    );
    expect(_key('super-board-chat'), findsOneWidget, reason: 'Buddy stays');
    await end(tester, c);
  });
}
