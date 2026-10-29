import 'dart:async';

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

/// Jump to latest in a thread (Tony, 2026-10-30), as the chat has it: shown
/// while the latest reply is more than a screen below. The New messages line
/// is left out: the server keeps a read mark per chat, none per thread
/// (Desktop's thread read state is its own, kept on that machine).
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const thread = '$messages?thread=m1';
  final jump = find.byKey(const ValueKey('swarm-jump-latest'));
  final list = find.byKey(const ValueKey('swarm-thread-messages'));

  /// Message [sequence] of g1: the root is m1; every other is a reply in its
  /// thread, only there.
  Map<String, dynamic> said(
    int sequence, {
    String author = 'agent-builder',
    String kind = 'agent',
  }) => {
    'id': 'm$sequence',
    'conversationId': 'g1',
    'text': sequence == 1 ? 'The question.' : 'Reply $sequence.',
    'sequence': sequence,
    'author': {'kind': kind, 'id': author, 'name': author},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'thread': 'm1',
    if (sequence > 1) 'replyTo': 'm1',
    'createdAt': DateTime.utc(2026, 10, 29, 1, sequence).toIso8601String(),
  };

  Map<String, dynamic> lineOf(int replies, int last) => {
    'id': 'm1',
    'replies': replies,
    'lastSequence': last,
    'lastAt': DateTime.utc(2026, 10, 29, 2).toIso8601String(),
    'authors': [
      {'kind': 'agent', 'id': 'agent-builder', 'name': 'agent-builder'},
    ],
    'people': <String>[],
  };

  /// g1 whose thread under m1 holds [replies] (oldest first), the chat read
  /// through [mark] on some device (the server's mark, #2131). With [older],
  /// the thread has replies before those read.
  FakeSwarm backend(
    List<Map<String, dynamic>> replies, {
    required int mark,
    bool older = false,
  }) {
    final last = replies.isEmpty ? 1 : replies.last['sequence'] as int;
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
            'g1',
            title: 'Fix login',
            agentIds: ['agent-lead', 'agent-builder'],
            lastMessageSequence: last,
          ),
        ],
        derived: {
          'readMarks': {'g1': mark},
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
    fake.routes[messages] = (_) => {
      'messages': [said(1)],
      'next': null,
      'threads': [lineOf(replies.length, last)],
    };
    fake.routes[thread] = (_) => {
      'messages': [...replies.reversed, said(1)],
      'next': older
          ? {'sequence': replies.first['sequence'], 'id': 'm-older'}
          : null,
      'threads': [lineOf(replies.length, last)],
    };
    return fake;
  }

  /// The thread under m1 of g1 on screen.
  Future<SwarmHost> open(WidgetTester tester, FakeSwarm fake) async {
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
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('swarm-thread-line-m1')));
    await tester.pumpAndSettle();
    return host;
  }

  List<Map<String, dynamic>> replies(int last) => [
    for (var i = 2; i <= last; i++) said(i),
  ];

  bool onScreen(WidgetTester tester, Finder f) {
    if (f.evaluate().isEmpty) return false;
    final view = tester.getRect(list);
    final row = tester.getRect(f);
    return row.top >= view.top && row.bottom <= view.bottom;
  }

  group('Jump to latest', () {
    testWidgets('while the latest is more than a screen below it takes the '
        'person to the foot; near the foot, none', (tester) async {
      await open(tester, backend(replies(40), mark: 40));
      expect(onScreen(tester, find.text('Reply 40.')), isFalse);
      expect(jump, findsOneWidget, reason: 'opened at the top of a long one');
      expect(find.text('Jump to latest'), findsOneWidget);
      expect(tester.getSemantics(jump).label, 'Jump to latest');

      await tester.tap(jump);
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Reply 40.')), isTrue);
      expect(jump, findsNothing);

      await tester.drag(list, const Offset(0, 120));
      await tester.pumpAndSettle();
      expect(jump, findsNothing, reason: 'not a screen from the foot');

      await tester.drag(list, const Offset(0, 1500));
      await tester.pumpAndSettle();
      expect(jump, findsOneWidget);
    });

    testWidgets('a thread that fits one screen has none', (tester) async {
      await open(tester, backend(replies(4), mark: 4));

      expect(jump, findsNothing);
    });
  });

  group('its privacy edges', () {
    testWidgets('access taken away while it is open: the replies and Jump '
        'to latest go', (tester) async {
      final fake = backend(replies(40), mark: 5);
      final host = await open(tester, fake);
      expect(jump, findsOneWidget);

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();

      expect(jump, findsNothing);
      expect(find.text('Reply 6.'), findsNothing);
      expect(find.text('The question.'), findsNothing);
    });

    testWidgets('a read that fails says so with Try again, no Loading left; '
        'once read, the thread shows', (tester) async {
      final fake = backend(replies(5), mark: 2);
      final answer = fake.routes[thread]!;
      fake.routes[thread] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Thread is down.');
      await open(tester, fake);
      int reads() => fake.paths.where((p) => p == thread).length;

      expect(find.text('Thread is down.'), findsOneWidget);
      expect(jump, findsNothing);
      final opened = reads();
      await tester.pump(const Duration(minutes: 1));
      expect(reads(), opened, reason: 'not again on its own, in a loop');

      fake.routes[thread] = answer;
      await tester.tap(find.byKey(const ValueKey('swarm-thread-retry')));
      await tester.pumpAndSettle();

      expect(reads(), opened + 1);
      expect(find.text('Reply 5.'), findsOneWidget);
      expect(find.text('Thread is down.'), findsNothing);
    });
  });
}
