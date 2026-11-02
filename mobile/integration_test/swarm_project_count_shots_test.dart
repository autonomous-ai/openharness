import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_unread.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// Simulator evidence with in-memory accounts, requests and read marks only.
/// Run through test_driver/journey_driver.dart. PROJECT_COUNT_BASELINE captures
/// the old behavior with this identical fixture before applying the fix.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const baseline = bool.fromEnvironment('PROJECT_COUNT_BASELINE');
  testWidgets('reading a project clears only its own number', (tester) async {
    const derived = {'mentionsWaiting': 2, 'decisionsWaiting': 0};
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      derived: derived,
      groups: [
        groupData(leadChat, title: 'Mobile', lastMessageSequence: 4),
        groupData('g1', title: 'Fix login', number: 51, lastMessageSequence: 4),
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': [
        for (final chat in [leadChat, 'g1'])
          {
            'id': 'tag-$chat',
            'projectId': project,
            'projectName': 'Mobile',
            'conversationId': chat,
            'conversationTitle': chat == leadChat ? 'Mobile' : 'Fix login',
            'messageId': 'message-$chat',
            'messageSequence': 4,
            'leadName': 'River',
            'text': 'Please review the update.',
            'createdAt': '2026-11-02T17:00:00.000Z',
          },
      ],
    };
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/'] = (body) => {
      'sequence': body?['sequence'],
      'messages': <Object>[],
      'next': null,
    };
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => me,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    addTearDown(account.dispose);
    await tester.pumpWidget(
      grid.BrightnessScope(
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (_, child) => SwarmScope(notifier: host, child: child!),
          home: const SwarmPage(),
        ),
      ),
    );
    final projectRow = find.byKey(
      const ValueKey('swarm-project-$tab-$project'),
    );
    for (var i = 0; i < 200; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      if (projectRow.evaluate().isNotEmpty &&
          host.session!.inbox.asks(tab)?.mentions.length == 2)
        break;
    }
    expect(projectRow, findsOneWidget);
    final reader = host.session!.inbox.reader(tab)!;
    final asks = host.session!.inbox.asks(tab)!;
    expect(swarmProjectNews(reader, asks)[project]?.tags, baseline ? 2 : 1);
    await binding.takeScreenshot(
      '${baseline ? 'before' : 'after'}-project-number',
    );

    // The same mark opening the project's chat sends; task marks stay intact.
    reader.readMarks!.markRead(leadChat, 4);
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(
      swarmProjectNews(reader, asks)[project]?.tags ?? 0,
      baseline ? 1 : 0,
    );
    expect(
      swarmChatCount(reader, asks, reader.snapshot!.conversation('g1')!),
      1,
    );
    await binding.takeScreenshot(
      '${baseline ? 'before' : 'after'}-project-read',
    );
  });
}
