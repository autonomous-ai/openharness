import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/message_row.dart';

import 'super_tab_mentions_test.dart' show runsOf, showView;
import 'support/super_tab_fixture.dart';

void main() {
  testWidgets(
    'a person is named in message headers and replies, never by their address',
    (tester) async {
      final server = ConversationServer();
      server.state['people'] = [
        {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
        {'id': 'ivy', 'email': 'ivy@example.com', 'role': 'collaborator'},
      ];
      server.append('Love the generated faces');
      server.messages.last['author'] = {
        'kind': 'person',
        'id': 'ivy',
        'name': 'ivy@example.com',
      };
      server.append('Thanks!');
      server.messages.last['replyTo'] = 'message-1';
      // Someone who has left keeps the name their address gives.
      server.append('Old note');
      server.messages.last['author'] = {
        'kind': 'person',
        'id': 'gone',
        'name': 'sam@example.com',
      };
      await showView(tester, server);
      expect(find.textContaining('@example.com'), findsNothing);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('super-message-message-1')),
          matching: find.text('ivy'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byType(SuperTabReplyPreview),
          matching: find.text('ivy'),
        ),
        findsOneWidget,
      );
      expect(find.text('sam'), findsOneWidget);
    },
  );

  testWidgets('a person who chose a username is shown and tagged by it', (
    tester,
  ) async {
    final server = ConversationServer();
    server.state['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
      {
        'id': 'ivy',
        'email': 'ivy@example.com',
        'role': 'collaborator',
        'username': 'ivy.k',
      },
    ];
    server.append('Over to @ivy.k for the copy.');
    server.messages.last['author'] = {
      'kind': 'person',
      'id': 'ivy',
      'name': 'ivy@example.com',
    };
    server.messages.last['mentions'] = ['ivy'];
    await showView(tester, server);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('super-message-message-1')),
        matching: find.text('ivy.k'),
      ),
      findsOneWidget,
    );
    expect(runsOf(tester, '@ivy.k').single?.backgroundColor, isNotNull);
    expect(find.textContaining('@example.com'), findsNothing);
  });
}
