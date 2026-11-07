import 'package:flutter_test/flutter_test.dart';
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
  });

  group('a long message', () {
    final long = [for (var i = 1; i <= 14; i++) 'Line $i of the plan.']
        .join('\n\n');

    testWidgets('from an agent folds after about six lines, with More', (
      tester,
    ) async {
      final server = ConversationServer()..append(long, agent: true);
      await showView(tester, server);
      expect(find.text('More'), findsOneWidget);
      expect(find.text('Line 14 of the plan.').hitTestable(), findsNothing);
      await tester.tap(find.text('More'));
      await tester.pumpAndSettle();
      expect(find.text('More'), findsNothing);
      expect(find.text('Line 14 of the plan.').hitTestable(), findsOneWidget);
    });

    testWidgets('from a person is never folded', (tester) async {
      final server = ConversationServer()..append(long);
      await showView(tester, server);
      expect(find.text('More'), findsNothing);
    });
  });
}
