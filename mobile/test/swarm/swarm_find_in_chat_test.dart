import 'dart:async';

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

/// Find in the open chat on the phone (task #2826): from the chat's ⋮ or the
/// thread's search button, a bar under the header lights the loaded
/// messages that match, says "n of N", and steps through them as a message
/// link does — reading older pages on Up past the oldest loaded match, at
/// most 50 a search.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  Map<String, dynamic> message(
    String id,
    int sequence, {
    String text = 'hello',
    String? thread,
    String? replyTo,
    int minute = 0,
  }) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'replyTo': ?replyTo,
    'thread': ?thread,
    'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 10, 27, 1, minute % 60).toIso8601String(),
  };

  /// A message two lines tall, so 30 of them are taller than the screen.
  Map<String, dynamic> tall(int i, {String? text}) =>
      message('m$i', i, text: text ?? 'Line $i\nof the log', minute: i);

  /// One Swarm whose chat g1 reads [page] as its latest messages, with the
  /// lines of [threads], and [next] as the cursor to the page before.
  FakeSwarm backend(
    List<Map<String, dynamic>> page, {
    Object? next,
    List<Map<String, dynamic>> threads = const [],
  }) {
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
            status: 'working',
            lastMessageSequence: page.isEmpty
                ? 0
                : page
                      .map((m) => m['sequence'] as int)
                      .reduce((a, b) => a > b ? a : b),
          ),
        ],
        derived: {'decisionsWaiting': 0},
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: {'decisionsWaiting': 0});
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': page.reversed.toList(),
      'next': next,
      'threads': threads,
    };
    fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    return fake;
  }

  /// Chat g1 on a 390-point phone; [threadId] opens that thread over it.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    String? threadId,
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
          messageId: threadId,
          threadId: threadId,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// [finder] is drawn inside the message list's view.
  bool inView(
    WidgetTester tester,
    Finder finder, {
    String list = 'swarm-messages',
  }) {
    final view = tester.getRect(key(list));
    final rect = tester.getRect(finder);
    return rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1;
  }

  String? count(WidgetTester tester) =>
      switch (key('swarm-find-count').evaluate().firstOrNull?.widget) {
        final Text text => text.data,
        _ => null,
      };

  /// The older pages read.
  int olderReads(FakeSwarm fake) =>
      fake.paths.where((p) => p.contains('before=')).length;

  /// Opens find from the chat's ⋮ and types [query].
  Future<void> findInChat(WidgetTester tester, String query) async {
    await tester.tap(key('swarm-chat-menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Find in chat'));
    await tester.pumpAndSettle();
    await tester.enterText(key('swarm-find-field'), query);
    await tester.pumpAndSettle();
  }

  testWidgets('the chat menu has Find in chat, and it opens the field', (
    tester,
  ) async {
    await pump(tester, backend([message('m1', 1, text: 'The plan')]));
    expect(key('swarm-find-field'), findsNothing);

    await tester.tap(key('swarm-chat-menu'));
    await tester.pumpAndSettle();
    expect(find.text('Find in chat'), findsOneWidget);
    await tester.tap(find.text('Find in chat'));
    await tester.pumpAndSettle();

    expect(key('swarm-find-field'), findsOneWidget);
    final field = find.descendant(
      of: key('swarm-find-field'),
      matching: find.byType(EditableText),
    );
    expect(tester.widget<EditableText>(field).focusNode.hasFocus, isTrue);
    // Directly under the header.
    expect(
      tester.getTopLeft(key('swarm-find-bar')).dy,
      moreOrLessEquals(tester.getBottomLeft(key('swarm-chat-header')).dy),
    );
  });

  testWidgets('matches in loaded messages are lit and counted', (tester) async {
    final fake = backend([
      for (var i = 1; i <= 8; i++)
        message(
          'm$i',
          i,
          text: i.isOdd && i > 1 ? 'Tiếng Việt, bản $i' : 'Line $i',
          minute: i,
        ),
    ]);
    await pump(tester, fake);
    await findInChat(tester, 'tieng viet');

    expect(count(tester), '1 of 3');
    expect(key('swarm-lit-m7'), findsOneWidget);
    expect(key('swarm-match-m7'), findsNothing, reason: 'lit wins');
    expect(key('swarm-match-m5'), findsOneWidget);
    expect(key('swarm-match-m3'), findsOneWidget);
    expect(key('swarm-match-m1'), findsNothing);
    expect(key('swarm-lit-m5'), findsNothing);
    // The current match stays lit while it is current.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(key('swarm-lit-m7'), findsOneWidget);
    // Typing read nothing.
    expect(olderReads(fake), 0);
  });

  testWidgets('Up steps to the older match and brings it into view', (
    tester,
  ) async {
    final fake = backend([
      for (var i = 1; i < 40; i++)
        tall(i, text: i == 3 || i == 38 ? 'needle $i\nin the log' : null),
    ]);
    await pump(tester, fake);
    await findInChat(tester, 'needle');
    expect(count(tester), '1 of 2');
    expect(key('swarm-lit-m38'), findsOneWidget);

    await tester.tap(key('swarm-find-older'));
    await tester.pumpAndSettle();

    expect(count(tester), '2 of 2');
    expect(key('swarm-lit-m3'), findsOneWidget);
    expect(inView(tester, key('swarm-message-m3')), isTrue);
    expect(olderReads(fake), 0);

    await tester.tap(key('swarm-find-newer'));
    await tester.pumpAndSettle();
    expect(count(tester), '1 of 2');
    expect(inView(tester, key('swarm-message-m38')), isTrue);
  });

  testWidgets('Up reads older pages until a match', (tester) async {
    final fake = backend(
      [for (var i = 10; i < 40; i++) tall(i)],
      next: {'sequence': 10, 'id': 'm10'},
    );
    // Three older pages; only the last says it.
    for (final (before, to, next) in [(10, 7, 7), (7, 4, 4), (4, 1, null)]) {
      fake.routes['$messages?before=$before&beforeId=m$before'] = (_) => {
        'messages': [
          for (var i = before - 1; i >= to; i--)
            message(
              'm$i',
              i,
              text: i == 2 ? 'the needle' : 'Older $i',
              minute: i,
            ),
        ],
        'next': next == null ? null : {'sequence': next, 'id': 'm$next'},
      };
    }
    await pump(tester, fake);
    await findInChat(tester, 'needle');
    expect(count(tester), 'No matches');
    expect(olderReads(fake), 0, reason: 'typing never reads a page');

    await tester.tap(key('swarm-find-older'));
    await tester.pumpAndSettle();

    expect(olderReads(fake), 3);
    expect(count(tester), '1 of 1');
    expect(key('swarm-lit-m2'), findsOneWidget);
    expect(inView(tester, key('swarm-message-m2')), isTrue);
    expect(key('swarm-find-status'), findsNothing);
  });

  testWidgets('the 50-page stop', (tester) async {
    final fake = backend(
      [for (var i = 100; i < 130; i++) tall(i)],
      next: {'sequence': 100, 'id': 'm100'},
    );
    // 51 older pages of one message each, none of them a match.
    for (var before = 100; before > 49; before--) {
      final at = before - 1;
      fake.routes['$messages?before=$before&beforeId=m$before'] = (_) => {
        'messages': [message('m$at', at, text: 'Older $at')],
        'next': {'sequence': at, 'id': 'm$at'},
      };
    }
    await pump(tester, fake);
    await findInChat(tester, 'zebra');

    await tester.tap(key('swarm-find-older'));
    await tester.pumpAndSettle();

    expect(olderReads(fake), 50);
    expect(find.text('No more matches in the last 50 pages'), findsOneWidget);
    expect(count(tester), 'No matches');

    // Up again reads nothing more for this search.
    await tester.tap(key('swarm-find-older'));
    await tester.pumpAndSettle();
    expect(olderReads(fake), 50);
  });

  testWidgets('it says how far it reads back, and closing stops it', (
    tester,
  ) async {
    final fake = backend(
      [for (var i = 10; i < 40; i++) tall(i)],
      next: {'sequence': 10, 'id': 'm10'},
    );
    final held = Completer<Object?>();
    fake.routes['$messages?before=10&beforeId=m10'] = (_) => held.future;
    await pump(tester, fake);
    await findInChat(tester, 'zebra');
    await tester.tap(key('swarm-find-older'));
    await tester.pump();
    expect(find.text('Reading older messages · 1 of 50'), findsOneWidget);

    await tester.tap(key('swarm-find-close'));
    await tester.pumpAndSettle();
    held.complete({
      'messages': [message('m9', 9, text: 'Older 9')],
      'next': {'sequence': 9, 'id': 'm9'},
    });
    await tester.pumpAndSettle();
    expect(olderReads(fake), 1);
    expect(key('swarm-find-field'), findsNothing);
  });

  testWidgets('the chat start and a failed read say so', (tester) async {
    final fake = backend(
      [for (var i = 10; i < 40; i++) tall(i)],
      next: {'sequence': 10, 'id': 'm10'},
    );
    fake.routes['$messages?before=10&beforeId=m10'] = (_) =>
        throw const SuperTabFailure('UNAVAILABLE', 'Down', statusCode: 503);
    await pump(tester, fake);
    await findInChat(tester, 'zebra');
    await tester.tap(key('swarm-find-older'));
    await tester.pumpAndSettle();
    expect(find.text('Couldn’t read older messages'), findsOneWidget);

    fake.routes['$messages?before=10&beforeId=m10'] = (_) => {
      'messages': [message('m9', 9, text: 'Older 9')],
      'next': null,
    };
    await tester.tap(key('swarm-find-older'));
    await tester.pumpAndSettle();
    expect(find.text('No more matches in this chat'), findsOneWidget);
  });

  testWidgets('accents and case fold', (tester) async {
    await pump(
      tester,
      backend([
        message('m1', 1, text: 'Tiếng Việt'),
        message('m2', 2, text: 'Giá 100 nghìn đồng', minute: 1),
        message('m3', 3, text: 'Nothing here', minute: 2),
      ]),
    );
    await findInChat(tester, 'dong');
    expect(count(tester), '1 of 1');
    expect(key('swarm-lit-m2'), findsOneWidget);

    await tester.enterText(key('swarm-find-field'), 'TIENG viet');
    await tester.pumpAndSettle();
    expect(count(tester), '1 of 1');
    expect(key('swarm-lit-m1'), findsOneWidget);
    expect(key('swarm-lit-m2'), findsNothing);
  });

  testWidgets('close clears the query, the fills and the light', (
    tester,
  ) async {
    await pump(
      tester,
      backend([
        message('m1', 1, text: 'an x'),
        message('m2', 2, text: 'another x', minute: 1),
      ]),
    );
    await findInChat(tester, 'x');
    expect(key('swarm-lit-m2'), findsOneWidget);
    expect(key('swarm-match-m1'), findsOneWidget);

    await tester.tap(key('swarm-find-close'));
    await tester.pumpAndSettle();

    expect(key('swarm-find-field'), findsNothing);
    expect(key('swarm-lit-m2'), findsNothing);
    expect(key('swarm-match-m1'), findsNothing);

    // Opened again, it starts empty.
    await tester.tap(key('swarm-chat-menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Find in chat'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(key('swarm-find-field')).controller!.text,
      '',
    );
    expect(key('swarm-find-count'), findsNothing);
  });

  testWidgets('the main chat leaves out replies only in a thread', (
    tester,
  ) async {
    await pump(
      tester,
      backend(
        [
          message('m1', 1, text: 'lỗi in the root', thread: 'm1'),
          message(
            'm2',
            2,
            text: 'lỗi only in the thread',
            thread: 'm1',
            replyTo: 'm1',
            minute: 1,
          ),
          message('m3', 3, text: 'lỗi in the chat', minute: 2),
        ],
        threads: [threadLine('m1', replies: 1, last: 2)],
      ),
    );
    await findInChat(tester, 'loi');
    expect(count(tester), '1 of 2');
    expect(key('swarm-lit-m3'), findsOneWidget);
    expect(key('swarm-match-m1'), findsOneWidget);
    expect(key('swarm-match-m2'), findsNothing);
  });

  testWidgets("a thread's search button finds its root and replies only", (
    tester,
  ) async {
    final fake = backend(
      [
        message('m1', 1, text: 'lỗi in the root', thread: 'm1'),
        message('m3', 3, text: 'lỗi in the chat', minute: 2),
      ],
      threads: [threadLine('m1', replies: 2, last: 4)],
    );
    fake.routes['$messages?thread=m1'] = (_) => {
      'messages': [
        message(
          'm4',
          4,
          text: 'no match here',
          thread: 'm1',
          replyTo: 'm1',
          minute: 3,
        ),
        message(
          'm2',
          2,
          text: 'a lỗi reply',
          thread: 'm1',
          replyTo: 'm1',
          minute: 1,
        ),
        message('m1', 1, text: 'lỗi in the root', thread: 'm1'),
      ],
      'next': null,
      'threads': [threadLine('m1', replies: 2, last: 4)],
    };
    await pump(tester, fake, threadId: 'm1');
    expect(find.byType(SwarmThreadPage), findsOneWidget);
    final button = key('swarm-thread-find');
    expect(button, findsOneWidget);
    expect(tester.getSize(button).height, greaterThanOrEqualTo(44));
    expect(find.bySemanticsLabel('Find in thread'), findsOneWidget);

    await tester.tap(button);
    await tester.pumpAndSettle();
    await tester.enterText(key('swarm-find-field'), 'loi');
    await tester.pumpAndSettle();

    expect(count(tester), '1 of 2');
    expect(key('swarm-lit-m2'), findsOneWidget);
    expect(key('swarm-match-m1'), findsOneWidget);

    await tester.tap(key('swarm-find-older'));
    await tester.pumpAndSettle();
    expect(count(tester), '2 of 2');
    expect(key('swarm-lit-m1'), findsOneWidget);
    expect(
      inView(tester, key('swarm-message-m1'), list: 'swarm-thread-messages'),
      isTrue,
    );
    // The main chat's own message is not among them.
    await tester.tap(key('swarm-find-older'));
    await tester.pumpAndSettle();
    expect(find.text('No more matches in this chat'), findsOneWidget);
  });

  testWidgets('a new matching message keeps the current one', (tester) async {
    final fake = backend([
      for (var i = 1; i <= 6; i++)
        message('m$i', i, text: i.isEven ? 'an x $i' : 'Line $i', minute: i),
    ]);
    final host = await pump(tester, fake);
    await findInChat(tester, 'x');
    expect(count(tester), '1 of 3');
    await tester.tap(key('swarm-find-older'));
    await tester.pumpAndSettle();
    expect(count(tester), '2 of 3');
    expect(key('swarm-lit-m4'), findsOneWidget);

    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c3',
      lastChangedAt: 200,
      derived: {'decisionsWaiting': 0},
      groups: [
        part(
          'g1',
          9,
          groupData(
            'g1',
            title: 'Fix login',
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            lastMessageSequence: 7,
          ),
        ),
      ],
    );
    fake.routes['$messages?after=6'] = (_) => {
      'messages': [message('m7', 7, text: 'one more x', minute: 7)],
      'next': null,
    };
    await host.session!.inbox.reader(tab)!.refresh();
    await tester.pumpAndSettle();

    expect(find.text('one more x'), findsOneWidget);
    expect(count(tester), '3 of 4');
    expect(key('swarm-lit-m4'), findsOneWidget);
    expect(key('swarm-match-m7'), findsOneWidget);
  });
}

/// Thread [root]'s line as a page names it.
Map<String, dynamic> threadLine(
  String root, {
  required int replies,
  required int last,
}) => {
  'id': root,
  'replies': replies,
  'lastSequence': last,
  'lastAt': DateTime.utc(2026, 10, 27, 2).toIso8601String(),
  'authors': [
    {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
  ],
  'people': <String>[],
};
