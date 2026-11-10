import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/swarm_v4_channel.dart';

/// A person writes to their agent whose computer is off (Swarm v4): the message waits on the server, and the chat says so
/// under it in one line, until the agent answers or its computer is back.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<void> say(WidgetTester tester, String text) async {
    await tester.enterText(key('super-message-composer'), text);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'a message to an agent whose computer is off says it waits for it, until the agent is back',
    (tester) async {
      final server = swarmV4Channel();
      final c = await openSwarmV4(tester, server, saved: 'agent-chat-juno');
      // Nothing waits yet: nothing is said.
      expect(key('swarm-agent-offline-note'), findsNothing);
      await say(tester, 'are you there?');
      expect(
        tester.widget<Text>(key('swarm-agent-offline-note')).data,
        'Juno\'s laptop is off. Juno reads this when it is back.',
      );
      // Juno's computer is back: the line goes.
      final juno = (server.state['agents'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((a) => a['id'] == 'juno');
      juno.remove('downSince');
      await tester.runAsync(c.refresh);
      await tester.pumpAndSettle();
      expect(key('swarm-agent-offline-note'), findsNothing);
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  testWidgets('an agent that answered after the message says nothing more', (
    tester,
  ) async {
    final server = swarmV4Channel();
    final c = await openSwarmV4(tester, server, saved: 'agent-chat-juno');
    await say(tester, 'are you there?');
    swarmV4Post(server, 'Juno', 'Back now.', chat: 'agent-chat-juno');
    await tester.runAsync(c.refresh);
    await tester.pumpAndSettle();
    expect(key('swarm-agent-offline-note'), findsNothing);
    await tester.pump(const Duration(milliseconds: 300));
  });

  testWidgets('an agent whose computer is on says nothing', (tester) async {
    final server = swarmV4Channel();
    await openSwarmV4(tester, server, saved: 'agent-chat-pip');
    await say(tester, 'take #12 please');
    expect(key('swarm-agent-offline-note'), findsNothing);
    await tester.pump(const Duration(milliseconds: 300));
  });
}
