import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// anh Dee (11-07 18:56), task #4529: no threads in the chat. A reply shows
/// inline, in time order, under a one-line quote of the message it answers,
/// as iMessage does; no reply counts, and Reply never opens a thread.
void main() {
  ConversationServer server() {
    final server = ConversationServer()..threads = true;
    server.append('Should we do thread replies?');
    server.append('Yes, like Slack.', agent: true);
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1';
    server.append('Then the next line.');
    return server;
  }

  Finder rowOf(String text) => find.ancestor(
    of: find.text(text),
    matching: find.byType(SuperTabMessageRow),
  );

  testWidgets('an old thread reply shows inline in time order, under a quote '
      'of its message', (tester) async {
    await showView(tester, server());
    expect(rowOf('Yes, like Slack.'), findsOneWidget);
    expect(
      tester.getTopLeft(rowOf('Yes, like Slack.')).dy,
      greaterThan(tester.getTopLeft(rowOf('Should we do thread replies?')).dy),
    );
    expect(
      tester.getTopLeft(rowOf('Yes, like Slack.')).dy,
      lessThan(tester.getTopLeft(rowOf('Then the next line.')).dy),
    );
    expect(
      find.descendant(
        of: rowOf('Yes, like Slack.'),
        matching: find.byType(SuperTabReplyPreview),
      ),
      findsOneWidget,
    );
    expect(find.byType(SuperTabThreadLine), findsNothing);
  });

  testWidgets('Reply quotes the message in the composer and opens no thread', (
    tester,
  ) async {
    final c = await showView(tester, server());
    final reply = find.descendant(
      of: rowOf('Should we do thread replies?'),
      matching: find.byTooltip('Reply'),
    );
    await tester.tap(reply);
    await tester.pumpAndSettle();
    expect(c.openedThread, isNull);
  });
}
