import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_threads_page.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The phone's Threads page (desktop #2434): the threads the person follows,
/// new replies first, read on open; Follow and Unfollow on a sheet.
void main() {
  const path = '/api/super-tabs/$tab';

  Map<String, dynamic> row(
    String root, {
    int unread = 0,
    int last = 5,
    bool? follow,
    String text = 'Can we retry the refresh?',
  }) => {
    'conversationId': 'g1',
    'rootId': root,
    'root': {
      'id': root,
      'sequence': 1,
      'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
      'text': text,
      'createdAt': '2026-11-01T00:00:00.000Z',
    },
    'lastReplyAt': '2026-11-01T01:00:00.000Z',
    'lastReplySequence': last,
    'unreadReplies': unread,
    'replies': 4,
    'follow': follow,
  };

  Map<String, dynamic> reply(String id, int sequence, String root) => {
    'id': id,
    'conversationId': 'g1',
    'text': 'reply $id',
    'sequence': sequence,
    'thread': root,
    'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
    'createdAt': '2026-11-01T01:00:00.000Z',
  };

  /// One Swarm with chat g1; [threads] answers its followed threads.
  FakeSwarm backend({required Object? Function() threads, bool listed = true}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        if (listed) {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['$path/parts'] = (_) => firstLoad(
      groups: [groupData('g1', title: 'Fix login', lastMessageSequence: 5)],
      derived: {
        'readMarks': {'g1': 1},
      },
    );
    fake.routes['$path/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['$path/decisions'] = (_) => {'decisions': <Object>[]};
    fake.routes['$path/mentions'] = (_) => {'mentions': <Object>[]};
    fake.routes['$path/threads'] = (_) => threads();
    fake.routes['$path/conversations/'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    fake.routes['$path/conversations/g1/messages?thread=m1'] = (_) => {
      'messages': [reply('r5', 5, 'm1'), reply('r4', 4, 'm1')],
    };
    return fake;
  }

  Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: SwarmThreadsPage(now: () => DateTime.utc(2026, 11, 1, 2)),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  /// Leaves the page, so nothing it started outlives the test.
  Future<void> leave(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 30));
  }

  testWidgets('opening lists new replies, then Earlier, and marks the new '
      'thread read once its replies show', (tester) async {
    final fake = backend(
      threads: () => {
        'unread': [row('m1', unread: 2)],
        'read': [row('m7', follow: true, text: 'Rate limits')],
      },
    );
    await pump(tester, fake);

    expect(find.text('New replies'), findsOneWidget);
    expect(find.text('Earlier'), findsOneWidget);
    expect(find.text('2 new replies'), findsOneWidget);
    expect(find.text('reply r4'), findsOneWidget);
    expect(find.text('reply r5'), findsOneWidget);
    expect(find.text('4 replies · last 1h'), findsOneWidget, reason: 'Earlier');
    expect(
      fake.calls.where(
        (c) => c.path == '$path/conversations/g1/threads/m1/read',
      ),
      [
        isA<({String method, String path, Map<String, dynamic>? body})>()
            .having((c) => c.body, 'body', {'sequence': 5}),
      ],
    );
    expect(
      fake.paths.where((p) => p.endsWith('/threads/m7/read')),
      isEmpty,
      reason: 'a read thread marks nothing',
    );
    await leave(tester);
  });

  testWidgets('a tap opens the chat at the newest new reply, which opens its '
      'thread', (tester) async {
    await pump(
      tester,
      backend(
        threads: () => {
          'unread': [row('m1', unread: 2)],
          'read': [],
        },
      ),
    );

    await tester.tap(find.text('Can we retry the refresh?'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(
      find.byWidgetPredicate(
        (w) =>
            w is SwarmOpenedChat &&
            w.conversationId == 'g1' &&
            w.messageId == 'r5',
      ),
      findsOneWidget,
    );
    await leave(tester);
  });

  testWidgets('a tap on a thread with no new replies opens its thread over '
      'the chat at its root, as the desktop does', (tester) async {
    await pump(
      tester,
      backend(
        threads: () => {
          'unread': [],
          'read': [row('m7', follow: true, text: 'Rate limits')],
        },
      ),
    );

    await tester.tap(find.text('Rate limits'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(
      find.byWidgetPredicate(
        (w) =>
            w is SwarmOpenedChat &&
            w.conversationId == 'g1' &&
            w.messageId == 'm7' &&
            w.threadId == 'm7',
      ),
      findsOneWidget,
    );
    await leave(tester);
  });

  testWidgets('Unfollow from ⋯ is kept on the server, and the thread leaves', (
    tester,
  ) async {
    var followed = true;
    final fake = backend(
      threads: () => {
        'unread': <Object>[],
        'read': [if (followed) row('m7', follow: true, text: 'Rate limits')],
      },
    );
    fake.routes['$path/conversations/g1/threads/m7/follow'] = (body) {
      followed = body!['follow'] as bool;
      return {'ok': true};
    };
    await pump(tester, fake);

    await tester.tap(find.byKey(const ValueKey('swarm-thread-more-g1/m7')));
    await tester.pumpAndSettle();
    expect(find.text('Unfollow thread'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('swarm-thread-follow')));
    await tester.pumpAndSettle();

    expect(followed, isFalse);
    expect(find.text('Rate limits'), findsNothing);
    expect(find.text('No threads yet.'), findsOneWidget);
    await leave(tester);
  });

  testWidgets('access lost with the sheet open: the sheet closes and the rows '
      'go', (tester) async {
    var listed = true;
    final fake = backend(
      threads: () => {
        'unread': <Object>[],
        'read': [row('m7', follow: true, text: 'Rate limits')],
      },
    );
    final host = await pump(tester, fake);
    await tester.tap(find.byKey(const ValueKey('swarm-thread-more-g1/m7')));
    await tester.pumpAndSettle();
    expect(find.text('Unfollow thread'), findsOneWidget);

    // Removed from the Swarm: the list no longer has it.
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        if (listed) {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    listed = false;
    await host.session!.inbox.refresh();
    await tester.pumpAndSettle();

    expect(find.text('Unfollow thread'), findsNothing);
    expect(find.text('Rate limits'), findsNothing);
    expect(fake.paths.where((p) => p.endsWith('/follow')), isEmpty);
    await leave(tester);
  });

  testWidgets('a server before followed threads lists the unread ones and '
      'offers no ⋯', (tester) async {
    final fake = backend(
      threads: () =>
          throw const SuperTabFailure('NOT_FOUND', 'Nope', statusCode: 404),
    );
    fake.routes['$path/inbox'] = (_) => {
      'threads': [
        {...row('m1', unread: 2), 'replies': null},
      ],
    };
    await pump(tester, fake);

    expect(find.text('2 new replies'), findsOneWidget);
    expect(find.byKey(const ValueKey('swarm-thread-more-g1/m1')), findsNothing);
    await leave(tester);
  });

  testWidgets('a failed read says so, never a skeleton for ever, and Try '
      'again recovers', (tester) async {
    var fail = true;
    await pump(
      tester,
      backend(
        threads: () => fail
            ? throw const SuperTabFailure('BUSY', 'Busy', statusCode: 500)
            : {
                'unread': <Object>[],
                'read': [row('m7', follow: true, text: 'Rate limits')],
              },
      ),
    );

    expect(find.text('Could not load threads.'), findsOneWidget);
    expect(find.byKey(const ValueKey('swarm-threads-loading')), findsNothing);

    fail = false;
    await tester.tap(find.byKey(const ValueKey('swarm-threads-retry')));
    await tester.pumpAndSettle();

    expect(find.text('Could not load threads.'), findsNothing);
    expect(find.text('Rate limits'), findsOneWidget);
    await leave(tester);
  });
}
