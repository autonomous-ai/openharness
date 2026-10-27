import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

Map<String, dynamic> fromAgent(String id, String text) => {
  'id': id,
  'conversationId': 'lead',
  'sequence': 1,
  'text': text,
  'createdAt': '2026-10-27T00:00:00Z',
  'author': {
    'kind': 'agent',
    'id': 'dev',
    'name': 'Builder',
    'displayName': 'Juno',
  },
  'deliveries': <dynamic>[],
};

ConversationServer kudosServer() {
  final server = ConversationServer();
  (server.state['people'] as List).add({
    'id': 'peer',
    'email': 'theo@example.com',
    'role': 'collaborator',
  });
  server.state['agents'] = [
    {
      'id': 'dev',
      'name': 'Builder',
      'displayName': 'Juno',
      'machineId': 'm1',
      'harnessId': 'h-dev',
      'contributorId': 'owner',
      'configuration': <String, dynamic>{},
    },
  ];
  (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>()
      .firstWhere((g) => g['id'] == 'lead')['agentIds'] = [
    'dev',
  ];
  server.state['kudosReceived'] = {'agent:dev': 3, 'person:owner': 2};
  server.messages.add({
    ...fromAgent('m-agent', 'Merged the office map.'),
    'kudos': [
      {
        'from': {'kind': 'person', 'id': 'peer', 'name': 'theo@example.com'},
        'to': {'kind': 'agent', 'id': 'dev'},
        'note': 'Lovely work',
        'createdAt': '2026-10-27T00:01:00Z',
      },
    ],
  });
  server.append('Thanks all');
  return server;
}

Future<SuperTabController> show(
  WidgetTester tester,
  ConversationServer server, {
  String account = 'owner',
}) async {
  final controller = server.controller(account: account);
  addTearDown(controller.dispose);
  await controller.refresh();
  await controller.loadMessages('lead');
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuperTabView(
          controller: controller,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return controller;
}

void main() {
  group('kudos in the model', () {
    test('a message lists its kudos and the state counts them by member', () {
      final message = SuperTabMessage.fromJson(kudosServer().messages.first);
      expect(message.kudos.map((k) => (k.fromId, k.fromName, k.note)), [
        ('peer', 'theo', 'Lovely work'),
      ]);
      final snapshot = SuperTabSnapshot.fromJson(kudosServer().state);
      expect(snapshot.kudosFor(agent: 'dev'), 3);
      expect(snapshot.kudosFor(person: 'owner'), 2);
      expect(snapshot.kudosFor(person: 'peer'), 0);
    });

    test('an older backend sends neither', () {
      final server = ConversationServer()..append('Hi');
      expect(SuperTabMessage.fromJson(server.messages.first).kudos, isEmpty);
      expect(
        SuperTabSnapshot.fromJson(server.state).kudosFor(person: 'owner'),
        0,
      );
    });
  });

  group('kudos on a message', () {
    testWidgets('shows who said thanks, with the note', (tester) async {
      await show(tester, kudosServer());
      final line = find.byKey(const ValueKey('super-kudos-m-agent'));
      expect(
        find.descendant(of: line, matching: find.text('Thanks from theo')),
        findsOneWidget,
      );
      expect(find.byTooltip('theo: Lovely work'), findsOneWidget);
      expect(find.byKey(const ValueKey('super-kudos-message-1')), findsNothing);
    });

    testWidgets(
      'thanks the author with an optional note, never one\'s own message',
      (tester) async {
        final server = kudosServer();
        await show(tester, server);
        expect(
          find.byKey(const ValueKey('super-thank-message-1')),
          findsNothing,
        );
        await tester.tap(
          find.byKey(const ValueKey('super-thank-m-agent')),
          warnIfMissed: false,
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('super-thank-note')),
          '  Spot on  ',
        );
        await tester.tap(find.widgetWithText(FilledButton, 'Send thanks'));
        await tester.pumpAndSettle();
        expect(server.posts.last['command'], {
          'type': 'kudos.give',
          'conversationId': 'lead',
          'messageId': 'm-agent',
          'note': 'Spot on',
        });
      },
    );

    testWidgets('a viewer cannot give thanks', (tester) async {
      final server = kudosServer();
      (server.state['people'] as List).add({
        'id': 'viewer',
        'email': 'vee@example.com',
        'role': 'viewer',
      });
      await show(tester, server, account: 'viewer');
      expect(find.byKey(const ValueKey('super-thank-m-agent')), findsNothing);
      // Lets the controller's pending timers run out before the test ends.
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 10));
    });
  });

  group('kudos on profiles', () {
    testWidgets(
      'an agent\'s and a person\'s details count the thanks they received',
      (tester) async {
        await show(tester, kudosServer());
        await tester.tap(find.byTooltip('Members and machines'));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-member-dev')));
        await tester.pumpAndSettle();
        expect(find.text('Thanks received'), findsOneWidget);
        expect(find.text('3'), findsOneWidget);
        await tester.tapAt(Offset.zero);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-person-owner')));
        await tester.pumpAndSettle();
        expect(find.textContaining('Thanks received: 2'), findsOneWidget);
      },
    );
  });
}
