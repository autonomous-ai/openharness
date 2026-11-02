import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_thread_page.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A thread opened at a message (Tony, 2026-11-02): an Activity row, a link
/// or a tag lands on the message in its thread — read in from earlier pages
/// when it is further back — and lights it for 2 seconds, as the main chat
/// does; a whole thread lands on its first unread reply, else its newest.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const thread = '$messages?thread=m1';
  final list = find.byKey(const ValueKey('swarm-thread-messages'));

  /// Message [sequence] of g1: the root is m1; every other is a reply in its
  /// thread, only there.
  Map<String, dynamic> said(int sequence) => {
    'id': 'm$sequence',
    'conversationId': 'g1',
    'text': sequence == 1 ? 'The question.' : 'Reply $sequence.',
    'sequence': sequence,
    'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'agent-builder'},
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

  /// g1 whose thread under m1 holds replies 2..[last]. The thread's pages are
  /// [perPage] replies; the newest page answers the plain thread read and
  /// each earlier one the `before` read, so a reply further back than the
  /// pages read on open is only found by reading on.
  FakeSwarm backend(int last, {int mark = 0, int perPage = 100}) {
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
          'readMarks': {'g1': 1},
          'threadMarks': {
            'g1': {'m1': mark},
          },
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
      'threads': [lineOf(last - 1, last)],
    };
    // Replies [from]..[to], newest first, with the cursor to the page before.
    Map<String, dynamic> page(int to) {
      final from = to - perPage + 1 < 2 ? 2 : to - perPage + 1;
      return {
        'messages': [for (var i = to; i >= from; i--) said(i), said(1)],
        'next': from > 2 ? {'sequence': from, 'id': 'm$from'} : null,
        'threads': [lineOf(last - 1, last)],
      };
    }

    fake.routes[thread] = (_) => page(last);
    for (var to = last - perPage; to >= 2; to -= perPage) {
      final before = to + 1;
      fake.routes['$thread&before=$before&beforeId=m$before'] = (_) => page(to);
    }
    return fake;
  }

  /// The chat g1 opened at the thread m1 with [focus] on screen.
  Future<void> openAt(
    WidgetTester tester,
    FakeSwarm fake, {
    SwarmThreadFocus? focus,
    String? messageId = 'm1',
  }) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
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
        home: SwarmConversationPage(
          swarmId: tab,
          conversationId: 'g1',
          messageId: messageId,
          threadId: 'm1',
          threadFocus: focus,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  bool onScreen(WidgetTester tester, Finder f) {
    if (f.evaluate().isEmpty) return false;
    final view = tester.getRect(list);
    final row = tester.getRect(f);
    return row.top >= view.top && row.bottom <= view.bottom;
  }

  Finder lit(String id) => find.byKey(ValueKey('swarm-lit-$id'));

  group('a message in the thread', () {
    testWidgets('lands on it and lights it for 2 seconds', (tester) async {
      await openAt(
        tester,
        backend(40),
        focus: const SwarmThreadFocus.message('m20'),
      );

      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(onScreen(tester, find.text('Reply 20.')), isTrue);
      expect(lit('m20'), findsOneWidget);

      await tester.pump(const Duration(seconds: 2, milliseconds: 50));
      await tester.pumpAndSettle();
      expect(lit('m20'), findsNothing);
      expect(onScreen(tester, find.text('Reply 20.')), isTrue);
    });

    testWidgets('further back than the pages read on open: reads on until '
        'it shows, then lands on it', (tester) async {
      // 600 replies in pages of 100: the newest five are read on open, so
      // reply 3 is on the last page and not loaded at first.
      final fake = backend(600, perPage: 100);
      await openAt(
        tester,
        fake,
        focus: const SwarmThreadFocus.message('m3'),
      );

      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(onScreen(tester, find.text('Reply 3.')), isTrue);
      expect(lit('m3'), findsOneWidget);
    });

    testWidgets('one that is not in the thread leaves it at its top, no '
        'error, no endless reading', (tester) async {
      final fake = backend(40);
      await openAt(
        tester,
        fake,
        focus: const SwarmThreadFocus.message('m999'),
      );

      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(find.text('The question.'), findsOneWidget);
      expect(find.textContaining('Could not'), findsNothing);
      expect(
        fake.paths.where((p) => p.startsWith(thread)).length,
        lessThan(10),
      );
    });
  });

  group('a whole thread', () {
    testWidgets('lands on its first unread reply', (tester) async {
      await openAt(
        tester,
        backend(40, mark: 10),
        focus: const SwarmThreadFocus.firstUnread(),
      );

      expect(onScreen(tester, find.text('Reply 11.')), isTrue);
      expect(onScreen(tester, find.text('The question.')), isFalse);
    });

    testWidgets('with every reply read lands on the newest', (tester) async {
      await openAt(
        tester,
        backend(40, mark: 40),
        focus: const SwarmThreadFocus.firstUnread(),
      );

      expect(onScreen(tester, find.text('Reply 40.')), isTrue);
    });
  });
}
