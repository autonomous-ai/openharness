import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/decisions.dart';
import 'package:harness/super_tabs/decisions_view.dart';
import 'package:harness/super_tabs/notifications.dart';

import 'support/super_tab_fixture.dart';

ConversationServer privateLegacyChat() {
  final server = ConversationServer();
  server.state['projects'] = [
    projectFixture('lead', 'web-project', 'lead', visibility: 'private'),
  ];
  server.state['conversations'] = [
    {
      ...conversationFixture('lead', 'Old Chat with PM'),
      'audience': {
        'people': [
          {'id': 'owner'},
        ],
      },
    },
  ];
  return server;
}

void main() {
  testWidgets('private legacy decision channel uses a lock mark', (
    tester,
  ) async {
    final server = privateLegacyChat()..ask(['Ship it?']);
    final controller = server.controller();
    addTearDown(controller.dispose);
    await controller.refresh();
    final decisions = SuperTabDecisions.of(controller);
    await decisions.load();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: SuperTabDecisionList(decisions: decisions)),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byIcon(AppIcons.lock), findsOneWidget);
    expect(find.textContaining('#web-project'), findsNothing);
  });

  testWidgets('private legacy mention channel uses a lock mark', (
    tester,
  ) async {
    final server = privateLegacyChat()..tag('message-1');
    final controller = server.controller();
    addTearDown(controller.dispose);
    await controller.refresh();
    final mentions = SuperTabMentions.of(controller);
    await mentions.load();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabNotifications(mentions: mentions, onOpen: (_) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byIcon(AppIcons.lock), findsOneWidget);
    expect(find.textContaining('#web-project'), findsNothing);
  });
}
