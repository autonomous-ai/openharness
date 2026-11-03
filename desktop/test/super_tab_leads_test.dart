import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// The Product Managers ("product-managers") chat is gone (Dee, 2026-10-31):
/// it was the Leads' cross-project room, not a project, and people did not
/// know what it was for. The server no longer sends it; while an older server
/// still does, Desktop drops it when it reads the Swarm, so no list shows it
/// and nothing opens it.
void main() {
  /// Two projects, the owner's Buddy chat and, as an older server still sends
  /// it, the Leads conversation with messages in it.
  ConversationServer swarm() {
    final server = ConversationServer();
    server.state['buddies'] = true;
    server.state['projects'] = [
      projectFixture('lead', 'openharness', 'lead'),
      projectFixture('os', 'autonomous-os', 'os-lead'),
    ];
    server.state['agents'] = [
      for (final (id, name, project) in [
        ('pm-1', 'Wren', 'lead'),
        ('pm-2', 'Nova', 'os'),
      ])
        {
          'id': id,
          'projectId': project,
          'name': 'Lead',
          'displayName': name,
          'machineId': 'm',
          'harnessId': id,
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
    ];
    final conversations = server.state['conversations'] as List;
    conversations[0]['leadId'] = 'pm-1';
    conversations.add({
      ...conversationFixture('os-lead', 'Lead'),
      'projectId': 'os',
      'leadId': 'pm-2',
    });
    conversations.add({
      ...conversationFixture('leads', 'Leads'),
      'kind': 'leads',
      'agentIds': ['pm-1', 'pm-2'],
    });
    server.state['leadsConversationId'] = 'leads';
    giveBuddy(
      server,
      person: 'owner',
      id: 'sol',
      name: 'Sol',
      machineOwnerId: 'owner',
    );
    server.append(
      'I will take the roster file after #12 lands.',
      conversationId: 'leads',
    );
    return server;
  }

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    String selected = 'lead',
  }) async {
    await tester.binding.setSurfaceSize(const Size(1100, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': selected},
    );
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  test('reading a Swarm drops the Leads conversation, whatever its id', () {
    final snapshot = SuperTabSnapshot.fromJson({
      ...swarm().state,
      'conversations': [
        ...swarm().state['conversations'] as List,
        // A Leads conversation the head names, even one sent without its kind.
        conversationFixture('named', 'Product Managers'),
      ],
      'leadsConversationId': 'named',
    });
    expect(snapshot.conversation('leads'), isNull);
    expect(snapshot.conversation('named'), isNull);
    expect(snapshot.conversations.map((g) => g.id), [
      'lead',
      'offline',
      'os-lead',
      'buddy-owner-lead',
    ]);
  });

  testWidgets(
    'an older server still sends it: listed nowhere, never opened, and project and Buddy chats stay',
    (tester) async {
      final server = swarm();
      final reads = <String>[];
      server.onRead = reads.add;
      final controller = await show(tester, server);

      expect(find.byKey(const ValueKey('super-group-leads')), findsNothing);
      expect(find.text('product-managers'), findsNothing);
      expect(find.text('# product-managers'), findsNothing);
      expect(
        find.text('I will take the roster file after #12 lands.'),
        findsNothing,
      );
      // Project chats and the Buddy chat are listed as before.
      for (final key in [
        'super-group-lead',
        'super-group-os-lead',
        'super-buddy-lead',
      ]) {
        expect(find.byKey(ValueKey(key)), findsOneWidget, reason: key);
      }
      expect(find.text('# openharness'), findsOneWidget);

      // Nothing opens it, a link or a notification included.
      expect(await controller.select('leads'), isFalse);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'lead');
      expect(reads.where((path) => path.contains('/leads/')), isEmpty);
      // The other chats still open.
      expect(await controller.select('os-lead'), isTrue);
      expect(await controller.select('buddy-owner-lead'), isTrue);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'buddy-owner-lead');
      await close(tester, controller);
    },
  );

  testWidgets(
    'a view saved while it was open lands on the first project chat',
    (tester) async {
      final controller = await show(tester, swarm(), selected: 'leads');
      expect(controller.selectedId, 'lead');
      expect(find.text('# openharness'), findsOneWidget);
      expect(find.text('# product-managers'), findsNothing);
      await close(tester, controller);
    },
  );
}
