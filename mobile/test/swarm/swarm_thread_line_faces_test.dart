import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart'
    show swarmAgentRole;
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_thread_line.dart';

import 'swarm_fixture.dart';

/// The faces on a thread's reply line are the ones its repliers wear on
/// their own messages (Dee, 10-30): a person's picture and status, an
/// agent's avatar, and for someone no longer in the Swarm the face their
/// recorded name gives.
void main() {
  SuperTabSnapshot swarm() {
    final load = firstLoad(
      agents: [
        {
          ...agent('agent-lead', name: 'Lead', displayName: 'River'),
          'avatar': {'kind': 'preset', 'key': 'owl'},
        },
      ],
    );
    (load['members'] as List).add(
      part('peer', 1, {
        ...person('peer', role: 'collaborator'),
        'avatar': {'kind': 'preset', 'key': 'fox'},
        'status': {'text': 'Coffee break', 'emoji': '☕'},
      }),
    );
    return SuperTabSnapshot.fromJson(SuperTabParts.firstLoad(load).state);
  }

  final thread = SuperTabThread.fromJson({
    'id': 'm1',
    'replies': 3,
    'lastSequence': 4,
    'authors': [
      {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'},
      {'kind': 'agent', 'id': 'agent-lead', 'name': 'Lead'},
      {'kind': 'person', 'id': 'gone', 'name': 'gone@example.com'},
    ],
    'people': ['peer', 'gone'],
  });

  testWidgets('a person shows their picture and status, an agent its '
      'avatar, and someone who left their initial', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmThreadLine(
            thread: thread,
            faces: swarmThreadFaces(swarm(), thread),
            onOpen: () {},
          ),
        ),
      ),
    );
    final [person, lead, left] = tester
        .widgetList<SwarmChatAvatar>(find.byType(SwarmChatAvatar))
        .toList();
    expect(person.picture, isNotNull);
    expect(person.status?.text, 'Coffee break');
    expect(lead.picture, isNotNull);
    expect(lead.status, isNull);
    expect(left.picture, isNull);
    expect(left.status, isNull);
    expect(left.name, 'gone');
    expect(find.text('🦊'), findsOneWidget);
    expect(find.text('🦉'), findsOneWidget);
    expect(find.text('G'), findsOneWidget);
    // Their size is unchanged.
    expect(tester.getSize(find.byWidget(left)).width, SwarmThreadLine.face);
  });

  testWidgets("keeps the coordinator's face whatever its role is called", (
    tester,
  ) async {
    // The coordinator goes by Coordinator; an engineer is called PM.
    final load = firstLoad(
      agents: [
        {
          ...agent('agent-lead', name: 'Lead', displayName: 'River'),
          'roleName': 'Coordinator',
        },
        {...agent('agent-builder', displayName: 'Nova'), 'roleName': 'PM'},
      ],
    );
    final snapshot = SuperTabSnapshot.fromJson(
      SuperTabParts.firstLoad(load).state,
    );
    final replied = SuperTabThread.fromJson({
      'id': 'm1',
      'replies': 2,
      'lastSequence': 3,
      'authors': [
        {'kind': 'agent', 'id': 'agent-lead', 'name': 'Lead'},
        {'kind': 'agent', 'id': 'agent-builder', 'name': 'Builder'},
      ],
      'people': <String>[],
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmThreadLine(
            thread: replied,
            faces: swarmThreadFaces(snapshot, replied),
            onOpen: () {},
          ),
        ),
      ),
    );
    final [lead, builder] = tester
        .widgetList<SwarmChatAvatar>(find.byType(SwarmChatAvatar))
        .toList();
    expect(lead.pm, isTrue);
    expect(builder.pm, isFalse);
    expect(swarmAgentRole(snapshot, 'agent-lead'), 'Coordinator');
    expect(swarmAgentRole(snapshot, 'agent-builder'), 'PM');
  });
}
