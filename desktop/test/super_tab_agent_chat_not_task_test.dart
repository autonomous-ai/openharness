import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/backlog.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/capture.dart';
import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

/// Audit #4211, finding 3: an agent's own chat is never a task card. The server
/// sends a v3 agent chat with no project; Desktop filed it under the first
/// project, so "Kestrel P2" sat in Next up on that project's Board.
void main() {
  test(
    'an agent\'s own chat is in no project and is not a Board task',
    () async {
      final server = swarm();
      (server.state['conversations'] as List).add({
        ...conversationFixture('agent-chat-kestrel', 'Kestrel'),
        'kind': 'agent-chat',
        'agentIds': ['kestrel'],
      });
      final c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      addTearDown(c.dispose);
      await c.refresh();
      final snapshot = c.snapshot!;
      final chat = snapshot.conversation('agent-chat-kestrel')!;
      expect(chat.isAgentChat, isTrue);
      expect(chat.projectId, '');
      final project = snapshot.projects.first;
      final titles = [
        for (final g in superTabProjectTasks(c, project)) g.label,
      ];
      expect(titles, isNot(contains('Kestrel')));
      // The project's real task is still listed.
      expect(titles, contains('Windows credential fix'));
      expect(
        c.projectConversations(project.id).map((g) => g.id),
        isNot(contains('agent-chat-kestrel')),
      );
    },
  );

  final shots = Platform.environment['HARNESS_AGENT_CHAT_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));
  for (final brightness in Brightness.values) {
    testWidgets(
      'a project\'s Board has no card for an agent\'s chat: ${brightness.name}',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(1500, 900));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final server = swarm();
        (server.state['conversations'] as List).add({
          ...conversationFixture('agent-chat-kestrel', 'Kestrel'),
          'kind': 'agent-chat',
          'agentIds': ['kestrel'],
        });
        final c = server.controller(
          account: 'owner',
          initial: {
            'tabId': 'tab',
            'projectsGroupOpen': true,
            'accountId': 'owner',
            'selectedId': 'lead',
          },
        );
        await tester.runAsync(c.refresh);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Mac Studio',
                paneStore: MemoryKeyValueStore(),
                board: true,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-group-lead')));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('super-tasks-lead')), findsOneWidget);
        // The project's own task is a card; the agent's chat is not.
        expect(
          find.byKey(const ValueKey('super-task-card-offline')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('super-task-card-agent-chat-kestrel')),
          findsNothing,
        );
        await captureWindow(
          tester,
          shots,
          'board-no-agent-chat-card-${brightness.name}',
        );
        await tester.pumpWidget(const SizedBox());
        c.dispose();
        await tester.pump(const Duration(seconds: 5));
      },
    );
  }
}
