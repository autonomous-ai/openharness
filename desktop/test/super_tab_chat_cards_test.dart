import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/chat/chat_card.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/ship_row.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'super_tab_ship_test.dart' show shipServer;
import 'support/super_tab_fixture.dart';

/// Task #4529 (anh Dee's mockup, 11-07): no walls of text. A sent brief or a
/// shipped note is a compact card, a label, one title line and one blue
/// action; a long agent message folds after about six lines, with More.
void main() {
  group('a sent brief', () {
    ConversationServer server() {
      final server = ConversationServer();
      (server.state['agents'] as List).add({
        'id': 'kai',
        'name': 'Kai',
        'machineId': 'm',
        'harnessId': 'kai',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      });
      (server.state['conversations'] as List).add({
        ...conversationFixture('work', 'Friendly agent faces'),
        'number': 12,
        'agentIds': ['kai'],
        'assignment': {'id': 'w', 'agentId': 'kai', 'status': 'working'},
        'cards': {'task': 'message-1', 'pullRequests': <Object>[]},
      });
      server.append(
        'Goal:\nGive every agent a face.\n\nChanges:\nDraw the faces.',
        conversationId: 'work',
      );
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'lead',
        'name': 'Lead',
      };
      server.messages.last['source'] = {'kind': 'system'};
      return server;
    }

    testWidgets('is a card naming who it went to and its title; View brief '
        'shows the rest', (tester) async {
      final c = await showView(tester, server());
      await c.select('work');
      await tester.pumpAndSettle();
      final row = find.byType(SuperTabMessageRow);
      Finder inRow(String text) =>
          find.descendant(of: row, matching: find.textContaining(text));
      expect(inRow('Sent to Kai'), findsOneWidget);
      expect(inRow('Friendly agent faces'), findsOneWidget);
      expect(inRow('Give every agent a face.'), findsNothing);
      await tester.tap(inRow('View brief'));
      await tester.pumpAndSettle();
      expect(inRow('Give every agent a face.'), findsOneWidget);
    });
  });

  group('a shipped note', () {
    testWidgets('is a card: Shipped, its title and What changed, which shows '
        'its pull requests and credits', (tester) async {
      await showView(tester, shipServer());
      final ship = find.byType(SuperTabShipRow);
      Finder inCard(String text) =>
          find.descendant(of: ship, matching: find.text(text));
      expect(inCard('Shipped'), findsOneWidget);
      expect(inCard('Avatars'), findsOneWidget);
      expect(inCard('Built by'), findsNothing);
      await tester.tap(inCard('What changed'));
      await tester.pumpAndSettle();
      expect(inCard('Built by'), findsOneWidget);
      expect(inCard('app · PR #7'), findsOneWidget);
    });

    testWidgets('is as wide as its words, as a brief\'s card is', (
      tester,
    ) async {
      await showView(tester, shipServer());
      final ship = find.byType(SuperTabShipRow);
      final card = tester.getRect(
        find.descendant(
          of: ship,
          matching: find.byKey(const ValueKey('swarm-chat-card')),
        ),
      );
      expect(card.width, lessThan(tester.getSize(ship).width / 2));
    });
  });

  group('a long message', () {
    final long = [for (var i = 1; i <= 14; i++) 'Line $i of the plan.']
        .join('\n\n');

    testWidgets('from an agent shows whole, never folded behind More', (
      tester,
    ) async {
      final server = ConversationServer()..append(long, agent: true);
      await showView(tester, server);
      expect(find.text('More'), findsNothing);
      expect(find.text('Line 14 of the plan.').hitTestable(), findsOneWidget);
    });

    testWidgets('from a person shows whole too', (tester) async {
      final server = ConversationServer()..append(long);
      await showView(tester, server);
      expect(find.text('More'), findsNothing);
      expect(find.text('Line 14 of the plan.').hitTestable(), findsOneWidget);
    });
  });

  group('a decision', () {
    testWidgets('is a card: Decision, its question, and View for the rest', (
      tester,
    ) async {
      final server = ConversationServer();
      server.append(
        'River asks owner (#12): Ship it tonight?\n\nOptions: Yes, No\n',
        agent: true,
      );
      server.messages.last['source'] = {
        'kind': 'decision-asked',
        'decisionId': 'd1',
      };
      await showView(tester, server);
      final row = find.byType(SuperTabMessageRow);
      Finder inRow(String text) =>
          find.descendant(of: row, matching: find.textContaining(text));
      expect(inRow('Decision'), findsOneWidget);
      expect(inRow('Ship it tonight?'), findsOneWidget);
      expect(inRow('Options: Yes, No'), findsNothing);
      await tester.tap(inRow('View'));
      await tester.pumpAndSettle();
      expect(inRow('Options: Yes, No'), findsOneWidget);
    });
  });

  group('by keyboard', () {
    /// Focuses the control drawing [label] and presses Enter on it.
    Future<void> press(WidgetTester tester, String label) async {
      Focus.of(tester.element(find.text(label))).requestFocus();
      await tester.pump();
      expect(
        Focus.of(tester.element(find.text(label))).hasPrimaryFocus,
        isTrue,
        reason: '$label takes focus',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
    }

    testWidgets('View brief opens with Enter', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SwarmChatCard(
              icon: Icons.send,
              label: 'Sent to Kai',
              title: 'Faces',
              action: 'View brief',
              details: const Text('Give every agent a face.'),
            ),
          ),
        ),
      );
      await press(tester, 'View brief');
      expect(find.text('Give every agent a face.'), findsOneWidget);
    });

    testWidgets('More opens with Enter', (tester) async {
      final long = [for (var i = 1; i <= 14; i++) 'Line $i of the plan.']
          .join('\n\n');
      final server = ConversationServer()..append(long, agent: true);
      await showView(tester, server);
      await press(tester, 'More');
      expect(find.text('More'), findsNothing);
      expect(find.text('Line 14 of the plan.').hitTestable(), findsOneWidget);
    });
  });
}
