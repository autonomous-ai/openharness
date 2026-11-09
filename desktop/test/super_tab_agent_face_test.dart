import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/avatar_art.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/profile_model.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/super_tab_fixture.dart';

Map<String, dynamic> _agent(String id, String name) => {
  'id': id,
  'projectId': 'lead',
  'name': name,
  'displayName': name,
  'machineId': 'host',
  'harnessId': 'session',
  'contributorId': 'owner',
  'configuration': {'engine': 'codex'},
  'myAgent': true,
};

/// The reader's agents in My agents: Kestrel, a Regular agent with no picture
/// (its face) talking in its own chat, and Orion, the project's PM, wearing
/// a picture.
ConversationServer agentFaceSwarm() {
  final server = swarm();
  server.state['agents'] = [
    {
      ..._agent('kestrel', 'Kestrel'),
      'kind': 'regular',
      'chatId': 'agent-chat-kestrel',
    },
    {
      ..._agent('orion', 'Orion'),
      'kind': 'pm',
      'chatId': 'lead',
      'avatar': {'kind': 'preset', 'key': 'owl'},
    },
  ];
  final groups = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>();
  groups.firstWhere((g) => g['id'] == 'lead')
    ..['leadId'] = 'orion'
    ..['agentIds'] = ['orion'];
  groups.add({
    ...conversationFixture('agent-chat-kestrel', 'Kestrel'),
    'kind': 'agent-chat',
    'agentIds': ['kestrel'],
  });
  server.append(
    'Please look at the build.',
    conversationId: 'agent-chat-kestrel',
  );
  server.messages.last['author'] = {
    'kind': 'person',
    'id': 'owner',
    'name': 'owner@example.com',
  };
  server.append(
    'On it: the build fails on the lint step, fixing now.',
    conversationId: 'agent-chat-kestrel',
  );
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'kestrel',
    'name': 'Kestrel',
  };
  server.append('The plan for this week.');
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'orion',
    'name': 'Orion',
  };
  return server;
}

/// The Desktop's window on [server], [selectedId] open in the middle.
Future<SuperTabController> showAgentFaces(
  WidgetTester tester,
  ConversationServer server, {
  required String selectedId,
  Brightness brightness = Brightness.light,
}) async {
  final c = server.controller(
    account: 'owner',
    initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': selectedId},
  );
  await tester.runAsync(c.refresh);
  await tester.binding.setSurfaceSize(const Size(1500, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac Studio',
        ),
      ),
    ),
  );
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
  return c;
}

/// Audit finding 6 of task #4211: My agents drew each agent as a letter while
/// the chat, the Board and the Tasks pane drew its face. One face everywhere.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  /// What a face draws: whose, its picture, and the face in its place.
  String look(SuperTabAvatarFace face) =>
      '${face.identity} face=${face.face} picture=${switch (face.picture) {
        SuperTabPresetAvatar(:final key) => key,
        _ => null,
      }}';

  SuperTabAvatarFace rowFace(WidgetTester tester, String agent) =>
      tester.widget<SuperTabAvatarFace>(
        find.descendant(
          of: key('super-agent-$agent'),
          matching: find.byType(SuperTabAvatarFace),
        ),
      );

  /// The faces drawn for [agent] outside My agents: its messages' avatars.
  Set<String> elsewhere(WidgetTester tester, String agent) => {
    for (final face in tester.widgetList<SuperTabAvatarFace>(
      find.byWidgetPredicate(
        (w) => w is SuperTabAvatarFace && w.identity == 'agent:$agent',
      ),
    ))
      look(face),
  };

  Future<void> end(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(c.flush);
    c.dispose();
  }

  testWidgets('an agent in My agents wears the face its chat shows, not an '
      'initial', (tester) async {
    final c = await showAgentFaces(
      tester,
      agentFaceSwarm(),
      selectedId: 'agent-chat-kestrel',
    );
    final face = rowFace(tester, 'kestrel');
    expect(face.face, isTrue, reason: 'its face, not the letter K');
    expect(elsewhere(tester, 'kestrel'), {look(face)});
    // The face alone: the row draws no engine badge.
    expect(
      find.descendant(
        of: key('super-agent-kestrel'),
        matching: find.byType(EngineMark),
      ),
      findsNothing,
    );
    await end(tester, c);
  });

  testWidgets('an agent with a picture wears it in My agents too', (
    tester,
  ) async {
    final c = await showAgentFaces(
      tester,
      agentFaceSwarm(),
      selectedId: 'lead',
    );
    final face = rowFace(tester, 'orion');
    expect(face.picture, isA<SuperTabPresetAvatar>());
    expect(elsewhere(tester, 'orion'), {look(face)});
    expect(
      find.descendant(of: key('super-agent-orion'), matching: find.text('🦉')),
      findsOneWidget,
    );
    await end(tester, c);
  });
}
