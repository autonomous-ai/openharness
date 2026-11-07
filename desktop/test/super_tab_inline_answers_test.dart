import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// Task #4555 (anh Dee, 11-07 18:56: no threads). The server posts an agent's
/// reply in the chat itself, naming the message it answers (`answers`), not
/// in a thread. Desktop shows it in time order under a one-line quote of that
/// message, and the quote goes to it.
void main() {
  /// [count] notes in the Lead chat; the last, an agent's, answers note 1.
  ConversationServer chat(int count) {
    final server = ConversationServer();
    server.append('Ship it tonight?');
    for (var i = 2; i < count; i++) {
      server.append('Note $i');
    }
    server.append('Yes, after the last check.', agent: true);
    server.messages.last['answers'] = 'message-1';
    return server;
  }

  Finder row(String id) => find.byKey(ValueKey('super-message-$id'));
  Finder quoteIn(String id) =>
      find.descendant(of: row(id), matching: find.byType(SuperTabReplyPreview));

  testWidgets('an inline answer shows under a quote of what it answers, in '
      'time order, on its own', (tester) async {
    await showView(tester, chat(3));
    final answer = row('message-3');
    expect(answer, findsOneWidget);
    expect(
      find.descendant(
        of: quoteIn('message-3'),
        matching: find.textContaining('Ship it tonight?'),
      ),
      findsOneWidget,
    );
    expect(
      tester.getTopLeft(answer).dy,
      greaterThan(tester.getTopLeft(row('message-2')).dy),
    );
    // A quote starts its own bubble: it joins none above it.
    final bubble = tester.widget<DecoratedBox>(
      find.descendant(
        of: answer,
        matching: find.byKey(const ValueKey('swarm-bubble')),
      ),
    );
    expect(
      ((bubble.decoration as BoxDecoration).borderRadius! as BorderRadius)
          .topLeft,
      const Radius.circular(18),
    );
  });

  testWidgets('clicking the quote brings the answered message into view, lit', (
    tester,
  ) async {
    await showView(tester, chat(60));
    expect(row('message-1').hitTestable(), findsNothing);
    await tester.tap(quoteIn('message-60'));
    await tester.pumpAndSettle();
    expect(row('message-1').hitTestable(), findsOneWidget);
    expect(
      tester
          .widget<SuperTabMessageHighlight>(
            find.ancestor(
              of: row('message-1'),
              matching: find.byType(SuperTabMessageHighlight),
            ),
          )
          .on,
      isTrue,
    );
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });
}
