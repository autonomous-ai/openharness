import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// Task #4529 (anh Dee's mockup, 11-07): no time in a bubble's row. A time
/// sits centered between messages only after a pause of more than about five
/// minutes; a bubble's exact time is on its tooltip.
void main() {
  ConversationServer server() {
    final server = ConversationServer();
    final now = DateTime.now().toUtc();
    for (final (text, minutesAgo) in [
      ('First', 30),
      ('Two minutes on', 28),
      ('After a pause', 10),
    ]) {
      server.append(text);
      server.messages.last['createdAt'] = now
          .subtract(Duration(minutes: minutesAgo))
          .toIso8601String();
    }
    return server;
  }

  Finder time(String id) => find.byKey(ValueKey('swarm-chat-time-$id'));

  testWidgets('a time sits centered only after a pause over five minutes', (
    tester,
  ) async {
    await showView(tester, server());
    expect(time('message-1'), findsNothing);
    expect(time('message-2'), findsNothing);
    expect(time('message-3'), findsOneWidget);
    final row = tester.getRect(
      find.ancestor(
        of: find.text('After a pause'),
        matching: find.byType(SuperTabMessageRow),
      ),
    );
    expect(tester.getCenter(time('message-3')).dx, closeTo(row.center.dx, 1));
    expect(
      tester.getBottomLeft(time('message-3')).dy,
      lessThanOrEqualTo(row.top),
    );
    // No row carries a time of its own.
    expect(
      find.descendant(
        of: find.byType(SuperTabMessageRow),
        matching: find.textContaining(RegExp(r'^\d{1,2}:\d\d')),
      ),
      findsNothing,
    );
  });

  testWidgets('a bubble\'s exact time is on its tooltip', (tester) async {
    final s = server();
    await showView(tester, s);
    final at = DateTime.parse(s.messages[1]['createdAt'] as String).toLocal();
    final context = tester.element(find.text('Two minutes on'));
    final clock = TimeOfDay.fromDateTime(at).format(context);
    final tip = tester.widget<Tooltip>(
      find
          .ancestor(
            of: find.text('Two minutes on'),
            matching: find.byType(Tooltip),
          )
          .first,
    );
    expect(tip.message, contains(clock));
  });
}
