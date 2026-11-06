import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_right_pane_row_test.dart' show buddy;
import 'support/memory_key_value_store.dart';
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

Finder key(String value) => find.byKey(ValueKey(value));

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));
  Future<SuperTabController> show(
    WidgetTester tester, {
    ValueChanged<SuperTabAgent>? terminal,
    Brightness brightness = Brightness.light,
    int cards = 0,
    Size size = const Size(1800, 1000),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final oldBrightness = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
    final server = swarm();
    server.state['swarmBuddy'] = true;
    server.state['buddyCap'] = 5;
    (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
      {
        ...buddy('code', 'Code'),
        'agentIds': ['buddy-code'],
      },
      {
        ...buddy('plan', 'Planning', first: true),
        'agentIds': ['buddy-plan'],
      },
    ]);
    server.state['agents'] = <Map<String, dynamic>>[
      ...(server.state['agents'] as List).cast<Map<String, dynamic>>(),
    ];
    for (final id in ['code', 'plan']) {
      (server.state['agents'] as List).add(<String, dynamic>{
        'id': 'buddy-$id',
        'name': id,
        'machineId': 'host',
        'harnessId': 'session-$id',
        'contributorId': 'owner',
        'buddyOf': {'personId': 'owner'},
        'buddyScope': 'swarm',
        'configuration': {'engine': 'claude'},
      });
    }
    for (var i = 0; i < cards; i++) {
      (server.state['conversations'] as List).add(<String, dynamic>{
        ...conversationFixture('chat-$i', 'Conversation $i'),
        'projectId': 'lead',
        'lastMessageSequence': 2,
        'lastMainSequence': 2,
      });
    }
    server.append('Here is the plan.', conversationId: 'plan', agent: true);
    server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'buddy-plan',
      'name': 'plan',
    };
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            paneStore: MemoryKeyValueStore()
              ..values['swarm_right_pane_hidden'] = '1',
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: terminal ?? (_) {},
            machineName: (_) => 'Mac Studio',
            board: true,
          ),
        ),
      ),
    );
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

  testWidgets(
    'opening a Board card adds its chat once and keeps the Board and wide chat visible',
    (tester) async {
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
      expect(
        tester.getSize(key('super-board-chat')).width,
        greaterThanOrEqualTo(440),
      );
      await tester.tap(find.text('Windows credential fix').first);
      await tester.pumpAndSettle();
      expect(key('super-chat-tab-offline'), findsOneWidget);
      await end(tester, c);
    },
  );

  testWidgets(
    'beside the wide chat on a 1280 px window, the Tasks bar fits and its search stays usable',
    (tester) async {
      final c = await show(tester, size: const Size(1280, 800));
      expect(key('super-board-chat'), findsOneWidget);
      expect(tester.takeException(), isNull);
      final board = tester.getRect(key('super-tasks-lead'));
      final search = tester.getRect(key('super-tasks-search'));
      expect(search.right, lessThanOrEqualTo(board.right));
      expect(search.width, greaterThanOrEqualTo(120));
      await end(tester, c);
    },
  );

  testWidgets(
    'Open terminal in selected Buddy header and menu targets that Buddy',
    (tester) async {
      final opened = <String>[];
      final c = await show(tester, terminal: (agent) => opened.add(agent.id));
      await tester.tap(key('super-buddy-tab-plan'));
      await tester.pumpAndSettle();
      expect(find.text('Message Planning'), findsOneWidget);
      await tester.tap(key('super-buddy-open-terminal'));
      expect(opened, ['buddy-plan']);
      await tester.tap(key('super-buddy-tab-code'));
      await tester.pumpAndSettle();
      expect(find.text('Message Code'), findsOneWidget);
      expect(key('super-buddy-context'), findsOneWidget);
      await tester.tap(key('super-buddy-menu'));
      await tester.pumpAndSettle();
      await tester.tap(key('super-buddy-menu-terminal'));
      await tester.pumpAndSettle();
      expect(opened, ['buddy-plan', 'buddy-code']);
      await tester.tap(key('super-buddy-tab-plan'));
      await tester.runAsync(() => c.loadMessages('plan'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('plan').last);
      await tester.pumpAndSettle();
      expect(opened, ['buddy-plan', 'buddy-code', 'buddy-plan']);
      await end(tester, c);
    },
  );
  for (final brightness in Brightness.values) {
    testWidgets('Board avatar row screenshot in ${brightness.name}', (
      tester,
    ) async {
      if (shots == null) return;
      final c = await show(tester, brightness: brightness, cards: 8);
      for (var i = 0; i < 8; i++) {
        await tester.runAsync(() => c.select('chat-$i'));
        await tester.pump();
      }
      await tester.runAsync(() => c.select('plan'));
      await tester.pumpAndSettle();
      expect(key('super-chat-overflow'), findsOneWidget);
      expect(key('super-chat-unread-chat-0'), findsOneWidget);
      await captureWindow(tester, shots, 'avatar-row-board-${brightness.name}');
      await end(tester, c);
    });
  }
}
