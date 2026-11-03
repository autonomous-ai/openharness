import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_thread_page.dart';

import '../voice_fakes.dart';
import 'swarm_activity_fixture.dart';
import 'swarm_fixture.dart';

/// Opening an Activity row lands on its message (Tony, 2026-11-02): one in a
/// thread opens that thread at it, read in from earlier pages when it is
/// further back, and lights it; one in the main chat lights it there; a
/// whole thread opens at its first unread reply, else its newest; a decision
/// stays answered in Activity.
void main() {
  /// A reply of the thread under [root], [n] of it: its text is "Reply n of
  /// root." and its sequence 100 + n, after the chat's own rows.
  Map<String, dynamic> reply(String root, int n) => {
    ...activityMessage('$root-$n', 100 + n, text: 'Reply $n of $root.'),
    'thread': root,
    'replyTo': root,
  };

  /// The thread under [root] with [count] replies, in pages of [perPage],
  /// newest first, the root last; the page before is read with its cursor.
  void thread(FakeSwarm fake, String root, int count, {int perPage = 100}) {
    Map<String, dynamic> page(int to) {
      final from = to - perPage + 1 < 1 ? 1 : to - perPage + 1;
      return {
        'messages': [
          for (var n = to; n >= from; n--) reply(root, n),
          activityMessage(root, 3, text: 'About $root.', mine: true),
        ],
        'next': from > 1 ? {'sequence': 100 + from, 'id': '$root-$from'} : null,
        'threads': [activityThread(root, last: 100 + count)],
      };
    }

    final path = '$activityChatPath?thread=$root';
    fake.routes[path] = (_) => page(count);
    for (var to = count - perPage; to >= 1; to -= perPage) {
      final before = to + 1;
      fake.routes['$path&before=${100 + before}&beforeId=$root-$before'] = (
        _,
      ) => page(to);
    }
  }

  /// The project chat: the person's thread roots and a main-chat message of
  /// theirs, all on its newest page.
  Map<String, dynamic> chat() => {
    'messages': [
      activityMessage('root-t', 3, text: 'About root-t.', mine: true),
      activityMessage('root-far', 4, text: 'About root-far.', mine: true),
      activityMessage('main-1', 5, text: 'Copy is fixed.', mine: true),
    ],
    'threads': [
      activityThread('root-t', last: 140),
      activityThread('root-far', last: 700),
    ],
    'next': null,
  };

  /// [rows] on a server with Activity (or none: the phone builds its own),
  /// the threads root-t (40 replies) and root-far (600) behind them.
  Future<FakeSwarm> pump(
    WidgetTester tester, {
    List<Map<String, dynamic>>? rows,
    Map<String, int>? threadMarks,
    Map<String, dynamic>? mention,
  }) async {
    final fake = activityBackend(
      page: chat,
      activityDigest: rows == null ? null : () => 'digest-1',
      threadMarks: threadMarks,
    );
    if (rows != null) {
      fake.routes[activityPath] = (_) => {'items': rows, 'more': false};
      fake.routes['$activityPath/read'] = (_) => {'marked': 0};
    }
    if (mention != null) {
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': [mention],
      };
    }
    thread(fake, 'root-t', 40);
    thread(fake, 'root-far', 600);
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
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
        home: const SwarmActivityPage(),
      ),
    );
    await tester.pumpAndSettle();
    return fake;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> filter(WidgetTester tester, String name) async {
    await tester.ensureVisible(key('swarm-activity-filter-$name'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-activity-filter-$name'));
    await tester.pumpAndSettle();
  }

  /// Taps [row]'s Reply and lets the chat, and the thread over it, open.
  Future<void> open(WidgetTester tester, String row) async {
    await tester.tap(key(row));
    await tester.pumpAndSettle();
  }

  /// [text] is drawn inside the thread page's list.
  bool inView(WidgetTester tester, String text) {
    final f = find.text(text);
    if (f.evaluate().isEmpty) return false;
    final view = tester.getRect(key('swarm-thread-messages'));
    final row = tester.getRect(f);
    return row.top >= view.top && row.bottom <= view.bottom;
  }

  Finder lit(String id) => key('swarm-lit-$id');

  Map<String, dynamic> row(
    String id, {
    String kind = 'reply',
    required String messageId,
    String? threadId,
  }) => activityRow(
    id,
    kind: kind,
    messageId: messageId,
    threadId: threadId,
    emoji: kind == 'reaction' ? 'thumbs_up' : null,
  );

  group('a message in a thread', () {
    testWidgets('a reply opens its thread at it, lit', (tester) async {
      await pump(
        tester,
        rows: [row('r1', messageId: 'root-t-20', threadId: 'root-t')],
      );
      await filter(tester, 'threads');
      await open(tester, 'swarm-activity-reply-activity:$tab:r1');

      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(inView(tester, 'Reply 20 of root-t.'), isTrue);
      expect(lit('root-t-20'), findsOneWidget);
    });

    testWidgets('a reaction opens its thread at the message', (tester) async {
      await pump(
        tester,
        rows: [
          row(
            'x1',
            kind: 'reaction',
            messageId: 'root-t-33',
            threadId: 'root-t',
          ),
        ],
      );
      await filter(tester, 'reactions');
      await open(tester, 'swarm-activity-reply-activity:$tab:x1');

      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(inView(tester, 'Reply 33 of root-t.'), isTrue);
      expect(lit('root-t-33'), findsOneWidget);
    });

    testWidgets('a tag opens its thread at it', (tester) async {
      await pump(
        tester,
        rows: const [],
        mention: {
          'id': 'm1',
          'projectName': 'Mobile',
          'conversationId': leadChat,
          'conversationTitle': 'Mobile',
          'messageId': 'root-t-27',
          'leadName': 'River',
          'text': 'Can you check the copy?',
          'threadId': 'root-t',
          'messageSequence': 127,
        },
      );
      await filter(tester, 'mentions');
      await open(tester, 'swarm-activity-reply-mention:m1');

      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(inView(tester, 'Reply 27 of root-t.'), isTrue);
      expect(lit('root-t-27'), findsOneWidget);
    });

    testWidgets('one too far back to be loaded at first is read in', (
      tester,
    ) async {
      await pump(
        tester,
        rows: [row('r1', messageId: 'root-far-3', threadId: 'root-far')],
      );
      await filter(tester, 'threads');
      await open(tester, 'swarm-activity-reply-activity:$tab:r1');

      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(inView(tester, 'Reply 3 of root-far.'), isTrue);
      expect(lit('root-far-3'), findsOneWidget);
    });

    testWidgets('the light goes out after 2 seconds', (tester) async {
      await pump(
        tester,
        rows: [row('r1', messageId: 'root-t-20', threadId: 'root-t')],
      );
      await filter(tester, 'threads');
      await open(tester, 'swarm-activity-reply-activity:$tab:r1');
      expect(lit('root-t-20'), findsOneWidget);

      await tester.pump(const Duration(seconds: 2, milliseconds: 100));
      await tester.pumpAndSettle();

      expect(lit('root-t-20'), findsNothing);
      expect(inView(tester, 'Reply 20 of root-t.'), isTrue);
    });
  });

  group('a message in the main chat', () {
    testWidgets('a reply lands on it in the chat, lit, no thread', (
      tester,
    ) async {
      await pump(tester, rows: [row('r1', messageId: 'main-1')]);
      await filter(tester, 'threads');
      await open(tester, 'swarm-activity-reply-activity:$tab:r1');

      expect(find.byType(SwarmThreadPage), findsNothing);
      expect(lit('main-1'), findsOneWidget);
    });
  });

  group('a row for a whole thread', () {
    testWidgets('opens at the first unread reply', (tester) async {
      await pump(tester, threadMarks: {'root-t': 110});
      await filter(tester, 'threads');
      await open(tester, 'swarm-activity-reply-thread:$tab:root-t');

      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(inView(tester, 'Reply 11 of root-t.'), isTrue);
    });

    testWidgets('with every reply read opens at the newest', (tester) async {
      await pump(tester, threadMarks: {'root-t': 140});
      await filter(tester, 'threads');
      await open(tester, 'swarm-activity-row-thread:$tab:root-t');

      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(inView(tester, 'Reply 40 of root-t.'), isTrue);
    });
  });

  testWidgets('a decision is still answered in Activity, no chat opens', (
    tester,
  ) async {
    await pump(tester, rows: const []);

    await tester.tap(key('swarm-activity-row-decision:d1'));
    await tester.pumpAndSettle();

    expect(key('swarm-option-d1-1'), findsOneWidget);
    expect(find.byType(SwarmThreadPage), findsNothing);
  });
}
