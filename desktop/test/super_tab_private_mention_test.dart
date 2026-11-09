import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

import 'super_tab_agent_face_test.dart' show agentFaceSwarm, showAgentFaces;
import 'support/super_tab_fixture.dart';

/// The Swarm of the agent faces, with people to tag: Ken, who set his name,
/// and Dee, who did not.
ConversationServer privateMentionSwarm() {
  final server = agentFaceSwarm();
  server.state['people'] = [
    {'id': 'owner', 'email': 'river@autonomous.ai', 'role': 'owner'},
    {
      'id': 'ken',
      'email': 'ken15@autonomous.ai',
      'role': 'collaborator',
      'name': 'Ken Tran',
    },
    {'id': 'dee', 'email': 'dee@autonomous.ai', 'role': 'collaborator'},
  ];
  return server;
}

/// Audit finding 12 of task #4211: in Kestrel's own chat, which only its
/// person reads, @ offered every person in the Swarm. It offers the agent.
void main() {
  final composer = find.byKey(const ValueKey('super-message-composer'));
  final picker = find.byKey(const ValueKey('super-composer-completions'));

  List<String> offered(WidgetTester tester) => [
    for (final tile in tester.widgetList<ListTile>(
      find.descendant(of: picker, matching: find.byType(ListTile)),
    ))
      (tile.title as Text).data!,
  ];

  Future<void> type(WidgetTester tester, String text) async {
    await tester.tap(composer);
    await tester.enterText(composer, text);
    await tester.pump();
  }

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(c.flush);
    c.dispose();
  }

  testWidgets('in an agent\'s own chat @ offers that agent and no people', (
    tester,
  ) async {
    final c = await showAgentFaces(
      tester,
      privateMentionSwarm(),
      selectedId: 'agent-chat-kestrel',
    );
    await type(tester, 'Please check @');
    expect(offered(tester), ['Kestrel']);
    await type(tester, 'Please check @ke');
    expect(offered(tester), ['Kestrel']);
    await end(tester, c);
  });

  // A PM's chat is its project's chat (backend agentKind.ts agentChatId):
  // shared, so it keeps its people.
}
