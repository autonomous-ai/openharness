import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// Jump to first unread on a simulator's own engine and scrolling: a chat
/// opened from a notice below its New messages line offers the way back, holds
/// steady on the way there, and goes once the line has landed.
///
/// Every answer is scripted in memory ([FakeSwarm]): nothing reaches an
/// account, a machine or the backend.
///
///     flutter test integration_test/swarm_jump_unread_test.dart -d <simulator>
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a tap lands on the line, with no flicker on the way', (
    tester,
  ) async {
    const chat = 'buddy-me';
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
          buddyChatData(
            chat,
            agentIds: ['agent-wren'],
            lastMessageSequence: 40,
          ),
        ],
        agents: [buddyData('agent-wren', displayName: 'Wren')],
        derived: {
          'readMarks': {chat: 5},
        },
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
    fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (_) => {
      'messages': [
        for (var i = 40; i >= 1; i--)
          {
            'id': 'msg-$i',
            'conversationId': chat,
            'text': 'Update $i.',
            'sequence': i,
            'author': {
              'kind': 'agent',
              'id': 'agent-wren',
              'name': 'agent-wren',
            },
            'attachments': <Object>[],
            'reactions': <Object>[],
            'createdAt': DateTime.utc(2026, 10, 29, 1, i).toIso8601String(),
          },
      ],
      'next': null,
    };
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (_, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(
          swarmId: tab,
          conversationId: chat,
          messageId: 'msg-25',
        ),
      ),
    );
    await tester.pumpAndSettle();

    final pill = find.byKey(const ValueKey('swarm-jump-unread'));
    final line = find.byKey(const ValueKey('swarm-new-messages-line'));
    final list = find.byKey(const ValueKey('swarm-messages'));
    expect(find.text('Update 25.'), findsOneWidget);
    expect(line, findsNothing);
    expect(pill, findsOneWidget);
    expect(tester.getRect(pill).top, greaterThanOrEqualTo(0));

    await tester.tap(pill);
    final shown = <bool>[];
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      shown.add(pill.evaluate().isNotEmpty);
    }
    await tester.pumpAndSettle();

    expect(shown.first, isTrue, reason: 'still there as the jump starts');
    expect(
      shown.skipWhile((s) => s),
      everyElement(isFalse),
      reason: 'no flicker: $shown',
    );
    expect(line, findsOneWidget);
    final view = tester.getRect(list);
    final landed = tester.getRect(line);
    expect(landed.top, greaterThanOrEqualTo(view.top - 1));
    expect(landed.bottom, lessThanOrEqualTo(view.bottom));
    expect(pill, findsNothing);
    expect(find.text('Update 6.'), findsOneWidget);
  });
}
