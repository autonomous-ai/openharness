import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/avatar_art.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// Task #4529 (anh Dee's mockup, 11-07): the chat reads like iMessage. Your
/// own bubbles on the right in blue, everyone else's on the left in grey,
/// radius 18 with a small corner where one sender's bubbles meet; a group chat
/// names a speaker over their first bubble and puts their face by the last.
void main() {
  const blue = Color(0xFF0A84FF);
  const pm = {'kind': 'agent', 'id': 'pm', 'name': 'Lead'};

  ConversationServer server({String chat = 'lead'}) {
    final server = ConversationServer.chat();
    (server.state['agents'] as List).add({
      'id': 'pm',
      'name': 'Lead',
      'displayName': 'River',
      'machineId': 'mac',
      'harnessId': 'h-pm',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude'},
    });
    void say(String text, Map<String, Object> author) {
      server.append(text, conversationId: chat);
      server.messages.last['author'] = author;
    }

    server.append('From me', conversationId: chat);
    say('First from River', pm);
    say('Second from River', pm);
    say('Last from River', pm);
    return server;
  }

  Finder bubbleOf(String text) => find.ancestor(
    of: find.text(text),
    matching: find.byKey(const ValueKey('swarm-bubble')),
  );

  BoxDecoration decorationOf(WidgetTester tester, String text) =>
      tester.widget<DecoratedBox>(bubbleOf(text).first).decoration
          as BoxDecoration;

  Finder rowOf(String text) => find.ancestor(
    of: find.text(text),
    matching: find.byType(SuperTabMessageRow),
  );

  for (final brightness in Brightness.values) {
    testWidgets('your bubble is blue on the right, theirs grey on the left, '
        'at most three quarters wide (${brightness.name})', (tester) async {
      await showView(tester, server(), brightness: brightness);
      final mine = decorationOf(tester, 'From me');
      expect(mine.color, blue);
      final theirs = decorationOf(tester, 'First from River');
      expect(theirs.color, DesktopChrome.field);

      final row = tester.getRect(rowOf('From me'));
      final myBubble = tester.getRect(bubbleOf('From me').first);
      final theirBubble = tester.getRect(bubbleOf('First from River').first);
      expect(myBubble.center.dx, greaterThan(row.center.dx));
      expect(theirBubble.center.dx, lessThan(row.center.dx));
      for (final bubble in [myBubble, theirBubble]) {
        expect(bubble.width, lessThanOrEqualTo(row.width * .75));
      }
    });
  }

  testWidgets('one sender\'s bubbles meet at a small corner', (tester) async {
    await showView(tester, server());
    BorderRadius radius(String text) =>
        decorationOf(tester, text).borderRadius! as BorderRadius;
    const big = Radius.circular(18), small = Radius.circular(4);
    expect(radius('From me'), const BorderRadius.all(big));
    expect(
      radius('First from River'),
      const BorderRadius.only(
        topLeft: big,
        topRight: big,
        bottomRight: big,
        bottomLeft: small,
      ),
    );
    expect(
      radius('Second from River'),
      const BorderRadius.only(
        topLeft: small,
        topRight: big,
        bottomRight: big,
        bottomLeft: small,
      ),
    );
    expect(
      radius('Last from River'),
      const BorderRadius.only(
        topLeft: small,
        topRight: big,
        bottomRight: big,
        bottomLeft: big,
      ),
    );
  });

  testWidgets('a group chat names the speaker once and shows their face by '
      'their last bubble', (tester) async {
    await showView(tester, server());
    final rows = find.byType(SuperTabMessageRow);
    expect(
      find.descendant(of: rows, matching: find.text('River')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: rowOf('Last from River'),
        matching: find.byType(SuperTabAvatarFace),
      ),
      findsOneWidget,
    );
    for (final text in ['First from River', 'Second from River', 'From me']) {
      expect(
        find.descendant(
          of: rowOf(text),
          matching: find.byType(SuperTabAvatarFace),
        ),
        findsNothing,
        reason: text,
      );
    }
  });

  testWidgets('a chat with one other party shows no names or faces', (
    tester,
  ) async {
    final s = server(chat: 'offline')..state.remove('projects');
    ((s.state['conversations'] as List)[1] as Map)
      ..['kind'] = 'buddy'
      ..['buddyOwnerId'] = 'owner'
      ..['agentIds'] = ['pm'];
    final c = await showView(tester, s, board: false);
    await c.select('offline');
    await tester.pumpAndSettle();
    final rows = find.byType(SuperTabMessageRow);
    expect(rows, findsWidgets);
    expect(
      find.descendant(of: rows, matching: find.text('River')),
      findsNothing,
    );
    expect(find.descendant(of: rows, matching: find.text('You')), findsNothing);
    expect(
      find.descendant(of: rows, matching: find.byType(SuperTabAvatarFace)),
      findsNothing,
    );
  });
}
