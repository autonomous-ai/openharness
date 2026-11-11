import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/my_agents.dart';

import 'support/swarm_v4_channel.dart';

/// A project or an agent chat muted in v3 (their menus' Notifications, which Swarm v4 does not have): in v4 nothing could
/// unmute it, so its old mute is not kept (U1, 2026-11-10): it reads as Mentions only, and nothing stored changes.
void main() {
  testWidgets(
    'a project muted before is not muted in Swarm v4, and its stored setting stays',
    (tester) async {
      final server = swarmV4Channel();
      server.state['chatSettings'] = {
        'owner': {'channel': 'muted'},
      };
      final c = await openSwarmV4(tester, server, saved: 'agent-chat-pip');
      await tester.pumpAndSettle();
      expect(c.notifyOf('channel'), SuperTabNotify.mentions);
      // What the server keeps is the reader's, and stays as it was.
      expect(c.snapshot!.chatSettings['channel'], SuperTabNotify.muted);
      expect(
        server.posts.where((p) => p.toString().contains('notify')),
        isEmpty,
      );
    },
  );

  testWidgets(
    'an agent chat muted before still asks its person: Swarm v4\'s agent bar has no menu to unmute it',
    (tester) async {
      final server = swarmV4Channel();
      server.state['chatSettings'] = {
        'owner': {'agent-chat-pip': 'muted'},
      };
      final c = await openSwarmV4(tester, server, saved: 'channel');
      await tester.pumpAndSettle();
      // Pip writes to its person in its own chat: it asks them, as an agent never muted does.
      swarmV4Post(server, 'Pip', 'Which build?', chat: 'agent-chat-pip');
      await tester.runAsync(c.refresh);
      await tester.pumpAndSettle();
      expect(c.notifyOf('agent-chat-pip'), SuperTabNotify.mentions);
      expect(
        [for (final (_, chat) in superTabAgentsAsking(c)) chat.id],
        contains('agent-chat-pip'),
      );
      // What the server keeps is the reader's, and stays as it was.
      expect(c.snapshot!.chatSettings['agent-chat-pip'], SuperTabNotify.muted);
      expect(
        server.posts.where((p) => p.toString().contains('notify')),
        isEmpty,
      );
      // Its chat's bar has no menu where a mute could be undone.
      await tester.tap(find.byKey(const ValueKey('super-agent-pip')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('swarm-agent-header')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-group-options')), findsNothing);
    },
  );
}
