import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/swarm_v4_channel.dart';

/// A project muted in v3 (its menu's Notifications, which Swarm v4 does not have): in v4 nothing could unmute it, so its
/// old mute is not kept (U1, 2026-11-10). Its "@you" shows on its row, and the row is not greyed; nothing stored changes.
void main() {
  Finder inRow(String row, Finder finder) =>
      find.descendant(of: find.byKey(ValueKey(row)), matching: finder);

  testWidgets(
    'a project muted before shows its "@you" in Swarm v4, and its stored setting stays',
    (tester) async {
      final server = swarmV4Channel();
      server.state['chatSettings'] = {
        'owner': {'channel': 'muted'},
      };
      final id = swarmV4Post(server, 'Faye', '@owner can you check #12?');
      server.tag(
        id,
        conversationId: 'channel',
        messageSequence: server.messages.last['sequence'] as int?,
      );
      final c = await openSwarmV4(tester, server, saved: 'agent-chat-pip');
      await tester.pumpAndSettle();
      expect(
        inRow(
          'super-group-channel',
          find.byKey(const ValueKey('super-mentions-channel')),
        ),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('super-muted-channel')), findsNothing);
      // What the server keeps is the reader's, and stays as it was.
      expect(c.snapshot!.chatSettings['channel'], SuperTabNotify.muted);
      expect(
        server.posts.where((p) => p.toString().contains('notify')),
        isEmpty,
      );
    },
  );
}
