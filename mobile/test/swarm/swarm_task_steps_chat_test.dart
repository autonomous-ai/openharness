import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Task steps design: a task's chat on the phone shows its steps' rows by
/// time, each with its step's name beside the author, as on Desktop.
void main() {
  Map<String, dynamic> said(
    String id,
    String conversation,
    int minute,
    String author,
  ) => {
    'id': id,
    'conversationId': conversation,
    'text': 'Row $id.',
    'sequence': minute,
    'author': {'kind': 'agent', 'id': author, 'name': author},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 11, 2, 9, minute).toIso8601String(),
  };

  testWidgets("a task's chat shows its steps' rows with the step's name", (
    tester,
  ) async {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData(
            'task',
            title: 'Fix login',
            number: 12,
            lastMessageSequence: 2,
            status: 'working',
            workerId: 'agent-dev',
          ),
          {
            ...groupData(
              'review',
              title: 'Review',
              number: 13,
              lastMessageSequence: 1,
              status: 'working',
              workerId: 'agent-rev',
            ),
            'reviewOf': 'task',
            'step': 'Review',
          },
        ],
        agents: [
          agent('agent-dev', displayName: 'Dev'),
          agent('agent-rev', displayName: 'Nova'),
        ],
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/task/messages'] = (_) => {
      'messages': [
        said('t2', 'task', 10, 'agent-dev'),
        said('t1', 'task', 1, 'agent-dev'),
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/conversations/review/messages'] = (_) => {
      'messages': [said('s1', 'review', 5, 'agent-rev')],
      'next': null,
    };
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'task'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Row s1.'), findsOneWidget);
    expect(find.textContaining('Nova · Review'), findsOneWidget);
    double y(String text) => tester.getTopLeft(find.textContaining(text)).dy;
    expect(y('Row t1.') < y('Row s1.') && y('Row s1.') < y('Row t2.'), isTrue);
  });
}
