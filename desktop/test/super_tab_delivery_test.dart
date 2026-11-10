import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  testWidgets(
    'queued and claimed messages have no queue label; uncertain review remains',
    (tester) async {
      final server = ConversationServer();
      for (final status in ['queued', 'claimed', 'uncertain']) {
        server.append('$status message');
        server.messages.last['deliveries'] = [
          {'id': status, 'agentId': 'lead-agent', 'status': status},
        ];
      }
      final controller = server.controller();
      addTearDown(controller.dispose);
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Test Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('queued message'), findsOneWidget);
      expect(find.text('claimed message'), findsOneWidget);
      expect(find.text('Queued'), findsNothing);
      // The uncertain review is now the latest message's receipt and its actions (message_receipt.dart).
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);
      expect(find.text('Send again'), findsOneWidget);
      // The view saves its read mark 200 ms after the change: let it land.
      await tester.pump(const Duration(milliseconds: 250));
    },
  );
}
