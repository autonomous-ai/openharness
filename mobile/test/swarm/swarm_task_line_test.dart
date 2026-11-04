import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_thread_page.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

// Literal server payloads: expectations below come from Desktop's contract.
Map<String, dynamic> taskLine({
  String state = 'working',
  Object? title = 'Fix login',
  Object? target = 'task-1',
  String? answerFor,
  String id = 'line-1',
  int sequence = 2,
}) => {
  'id': id,
  'conversationId': leadChat,
  'sequence': sequence,
  'text': 'Fix login · $state',
  'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
  'createdAt': DateTime.utc(2026, 11, 2, 17, sequence).toIso8601String(),
  'source': {
    'kind': 'task-line',
    'state': state,
    'title': title,
    'taskId': target,
    'answerFor': ?answerFor,
  },
};

Map<String, dynamic> legacyShip(String target, int sequence) => {
  ...taskLine(id: 'ship-$target', sequence: sequence),
  'text': 'Shipped: $target',
  'source': {'kind': 'ship', 'conversationId': target, 'title': target},
};

FakeSwarm taskLineBackend(
  List<Map<String, dynamic>> page, {
  bool target = true,
  List<Map<String, dynamic>>? replies,
  String? ask,
}) {
  final fake = FakeSwarm();
  final root = page.firstWhere(
    (m) => m['thread'] == m['id'],
    orElse: () => page.first,
  );
  final rootId = root['id'] as String;
  final thread = [
    for (final (i, reply)
        in (replies ??
                [
                  {
                    'text': 'Goal: Save edits while offline.',
                    'source': {'kind': 'message'},
                  },
                ])
            .indexed)
      {
        ...taskLine(id: i == 0 ? 'details' : 'reply-$i', sequence: 3 + i),
        'thread': rootId,
        'replyTo': rootId,
        ...reply,
      },
  ];
  final summary = {
    'id': rootId,
    'ask': ?ask,
    'replies': thread.length,
    'lastSequence': 3,
    'authors': <Object>[],
    'people': <Object>[],
  };
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
          leadChat,
          title: 'Project chat',
          lastMessageSequence: 10,
          // Its PM, as a project chat has one.
          leadId: 'agent-lead',
          agentIds: ['agent-lead'],
        ),
        if (target) groupData('task-1', title: 'Fix login'),
      ],
    ),
    'members': [
      part(me, 1, {...person(me), 'email': 'dee@example.com'}),
    ],
  };
  fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
  fake.routes['/api/super-tabs/$tab/decisions'] = (_) => {
    'decisions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/mentions'] = (_) => {
    'mentions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] = (_) =>
      {
        'messages': page.reversed.toList(),
        'threads': [if (root['thread'] != null) summary],
        'next': null,
      };
  fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages?thread=$rootId'] =
      (_) => {
        'messages': [root, ...thread],
        'threads': [summary],
        'next': null,
      };
  fake.routes['/api/super-tabs/$tab/conversations/task-1/messages'] = (_) => {
    'messages': [
      {
        ...taskLine(),
        'id': 'task-message',
        'conversationId': 'task-1',
        'text': 'Inside the task chat',
        'source': {'kind': 'message'},
      },
    ],
    'threads': <Object>[],
    'next': null,
  };
  fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
    'result': <String, dynamic>{},
  };
  return fake;
}

Future<SwarmHost> pumpTaskChat(
  WidgetTester tester,
  FakeSwarm fake, {
  ThemeData? theme,
  GlobalKey? boundary,
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
    notices: SilentSystemNotices(),
    features: features,
    readMarks: MemoryKeyValueStore(),
  )..foreground = false;
  addTearDown(host.dispose);
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundary,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: theme,
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(
          swarmId: tab,
          conversationId: leadChat,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return host;
}

Future<void> pumpRow(
  WidgetTester tester,
  Map<String, dynamic> data, {
  String readerId = me,
  double width = 390,
  double scale = 1,
  VoidCallback? onReply,
  String? askTag,
}) async {
  await tester.binding.setSurfaceSize(Size(width, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: Scaffold(
        body: ListView(
          children: [
            SwarmMessageRow(
              message: SuperTabMessage.fromJson(data),
              name:
                  data['author'] is Map &&
                      (data['author'] as Map)['kind'] == 'person'
                  ? 'Dee'
                  : 'River',
              look: (picture: null, status: null),
              role: 'PM',
              askTag: askTag,
              readerId: readerId,
              mentions: SwarmMentions(const []),
              grouped: false,
              lit: false,
              quote: null,
              actions: onReply != null,
              onTap: () {},
              onReply: onReply,
            ),
          ],
        ),
      ),
    ),
  );
}

void main() {
  // Intercepting source kinds before the ordinary row hides the author,
  // actual text and normal message interactions this contract requires.
  for (final kind in ['task-line', 'buddy-proposal']) {
    testWidgets('$kind root keeps requester, actual text and Reply', (
      tester,
    ) async {
      final data = {
        ...taskLine(),
        'text': "Let's build: Offline drafts",
        'author': {'kind': 'person', 'id': me, 'name': 'Dee'},
        'source': {
          'kind': kind,
          'title': 'Old metadata title',
          'taskId': 'task-1',
        },
      };
      var replies = 0;
      await pumpRow(tester, data, onReply: () => replies++);
      expect(find.text('Dee'), findsOneWidget);
      final avatar = tester.widget<SwarmChatAvatar>(
        find.byType(SwarmChatAvatar),
      );
      expect(avatar.name, 'Dee');
      expect(avatar.id, me);
      expect(avatar.agent, isFalse);
      expect(find.text('Offline drafts'), findsOneWidget);
      expect(find.text('Old metadata title'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('swarm-reply-line-1')));
      expect(replies, 1);
      expect(find.text('Copy'), findsOneWidget);
    });

    testWidgets(
      '$kind legacy text remains complete on a narrow large-text phone',
      (tester) async {
        final text =
            'Goal: Save drafts offline.\nScope: Keep edits and attachments after reconnecting.\nPriority: High.';
        await pumpRow(
          tester,
          {
            ...taskLine(),
            'text': text,
            'source': {
              'kind': kind,
              'title': 'Truncated old title',
              'taskId': 'missing',
            },
          },
          width: 320,
          scale: 2,
        );
        final body = find.text(text);
        expect(body, findsOneWidget);
        expect(tester.widget<Text>(body).maxLines, isNull);
        expect(find.text('River'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    for (final openWith in ['replies', 'Reply']) {
      testWidgets('$kind $openWith opens the ordinary project thread', (
        tester,
      ) async {
        final root = {
          ...taskLine(),
          'text': "Let's build: Offline drafts",
          'author': {'kind': 'person', 'id': me, 'name': 'Dee'},
          'thread': 'line-1',
          'source': {'kind': kind, 'taskId': 'task-1', 'title': 'Wrong title'},
          'reactions': [
            {
              'emoji': 'heart',
              'count': 1,
              'by': [
                {'kind': 'person', 'id': me},
              ],
            },
          ],
        };
        final fake = taskLineBackend([root]);
        await pumpTaskChat(tester, fake);
        // A person is named by their username (dee@example.com).
        expect(find.text('dee'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('swarm-author-line-1')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('swarm-reaction-line-1-heart')),
          findsOneWidget,
        );
        expect(find.text('1 reply'), findsOneWidget);
        if (openWith == 'Reply') {
          await tester.tap(find.text('Offline drafts'));
          await tester.pumpAndSettle();
          expect(find.text('Reply in thread'), findsOneWidget);
          await tester.tap(find.byKey(const ValueKey('swarm-reply-line-1')));
        } else {
          await tester.tap(
            find.byKey(const ValueKey('swarm-thread-line-line-1')),
          );
        }
        await tester.pumpAndSettle();
        final page = tester.widget<SwarmThreadPage>(
          find.byType(SwarmThreadPage),
        );
        expect(page.root, 'line-1');
        expect(page.chat.id, leadChat);
        expect(find.text('Goal: Save edits while offline.'), findsOneWidget);
        expect(
          fake.paths,
          contains(
            '/api/super-tabs/$tab/conversations/$leadChat/messages?thread=line-1',
          ),
        );
        expect(
          fake.paths.any((p) => p.contains('/conversations/task-1/messages')),
          isFalse,
        );
        expect(find.byKey(const ValueKey('swarm-author-line-1')), findsWidgets);
      });
    }
  }

  testWidgets('legacy task without a target opens ordinary inline Reply', (
    tester,
  ) async {
    final fake = taskLineBackend([taskLine(target: null)], target: false);
    await pumpTaskChat(tester, fake);
    expect(find.text('Fix login · working'), findsOneWidget);
    await tester.tap(find.text('Fix login · working'));
    await tester.pumpAndSettle();
    expect(find.text('Reply'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('swarm-reply-line-1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('swarm-quote-line-1')), findsNothing);
    expect(find.textContaining('Reply to'), findsOneWidget);
    expect(find.byType(SwarmConversationPage), findsOneWidget);
  });

  testWidgets('legacy ship text stays readable beside an ordinary task root', (
    tester,
  ) async {
    await pumpTaskChat(
      tester,
      taskLineBackend([taskLine(), legacyShip('task-1', 3)]),
    );
    expect(find.text('Fix login · working'), findsOneWidget);
    expect(find.text('Shipped: task-1'), findsOneWidget);
  });

  test('a task root with no tag follows ordinary same-author grouping', () {
    final line = taskLine(sequence: 1);
    final normal = {
      ...taskLine(id: 'normal', sequence: 2),
      'source': {'kind': 'message'},
      'text': 'A normal follow-up',
    };
    expect(
      swarmGroupedMessages([
        SuperTabMessage.fromJson(line),
        SuperTabMessage.fromJson(normal),
      ]),
      {'normal'},
    );
  });

  // Its header is where its tag shows (#2552), and a message after it is not
  // part of that ask.
  test('a tagged row stands on its own, on either side', () {
    Map<String, dynamic> plain(String id, int sequence) => {
      ...taskLine(id: id, sequence: sequence),
      'source': {'kind': 'message'},
      'text': 'A normal message',
    };
    expect(
      swarmGroupedMessages(
        [
          plain('m1', 1),
          plain('m2', 2),
          plain('m3', 3),
          plain('m4', 4),
        ].map(SuperTabMessage.fromJson).toList(),
        tagged: (m) => m.id == 'm2',
      ),
      {'m4'},
    );
  });

  // Dee, 2026-11-04 (#2552): an ask's row reads as its title alone, with where
  // it stands after the time; older rows still carry the old prefix.
  group('an ask row', () {
    for (final kind in ['task-line', 'buddy-proposal']) {
      for (final text in ["Let's build: Offline drafts", 'Offline drafts']) {
        testWidgets('$kind "$text" shows the title alone', (tester) async {
          await pumpRow(tester, {
            ...taskLine(),
            'text': text,
            'source': {'kind': kind},
          });
          expect(find.text('Offline drafts'), findsOneWidget);
          expect(find.textContaining("Let's build"), findsNothing);
        });
      }
    }

    test('a state this app does not know draws no tag', () {
      SuperTabThread thread(Object? ask) => SuperTabThread.fromJson({
        'id': 'root',
        'replies': 1,
        'lastSequence': 2,
        'ask': ask,
      });
      expect(thread('someday').askTag, isNull);
      expect(thread(null).askTag, isNull);
    });

    for (final (ask, tag) in [
      ('proposal', '✋ Proposal'),
      ('on-it', '● On it'),
      ('shipped', '✓ Shipped'),
    ]) {
      testWidgets('$ask shows $tag after the time in the project chat', (
        tester,
      ) async {
        final root = {
          ...taskLine(),
          'text': 'Offline drafts',
          'author': {'kind': 'person', 'id': me, 'name': 'Dee'},
          'thread': 'line-1',
          'source': {'kind': 'buddy-proposal'},
        };
        await pumpTaskChat(tester, taskLineBackend([root], ask: ask));
        final shown = find.text(tag);
        expect(shown, findsOneWidget);
        expect(tester.widget<Text>(shown).style?.color, AppPalette.textFaint);
        final time = find.textContaining(RegExp(r'^\d\d:\d\d$'));
        expect(
          tester.getTopLeft(time).dx,
          lessThan(tester.getTopLeft(shown).dx),
        );
      });
    }

    testWidgets('has no tag once the PM has replied with no task', (
      tester,
    ) async {
      final root = {
        ...taskLine(),
        'text': 'Offline drafts',
        'author': {'kind': 'person', 'id': me, 'name': 'Dee'},
        'thread': 'line-1',
        'source': {'kind': 'buddy-proposal'},
      };
      await pumpTaskChat(tester, taskLineBackend([root]));
      for (final tag in ['Proposal', 'On it', 'Shipped', 'Task']) {
        expect(find.textContaining(tag), findsNothing);
      }
    });

    testWidgets('tags a person\'s own message a task was opened from', (
      tester,
    ) async {
      final root = {
        ...taskLine(),
        'text': 'can we save drafts offline?',
        'author': {'kind': 'person', 'id': me, 'name': 'Dee'},
        'thread': 'line-1',
        'source': null,
      };
      await pumpTaskChat(tester, taskLineBackend([root], ask: 'on-it'));
      expect(find.text('● On it'), findsOneWidget);
    });

    testWidgets('a message that is no ask keeps its words and has no tag', (
      tester,
    ) async {
      await pumpRow(tester, {
        ...taskLine(),
        'text': "Let's build: a shed",
        'source': {'kind': 'message'},
      });
      expect(find.text("Let's build: a shed"), findsOneWidget);
      expect(find.textContaining('On it'), findsNothing);
    });

    testWidgets('the role badge stays after the name, before the tag', (
      tester,
    ) async {
      await pumpRow(tester, {
        ...taskLine(),
        'text': 'Offline drafts',
      }, askTag: '● On it');
      double left(Finder within) => tester.getTopLeft(within).dx;
      final badge = find.byType(SwarmRoleBadge);
      expect(left(find.text('River')), lessThan(left(badge)));
      expect(left(badge), lessThan(left(find.text('● On it'))));
    });

    testWidgets('keeps its header when the same person wrote just before', (
      tester,
    ) async {
      final author = {'kind': 'person', 'id': me, 'name': 'Dee'};
      final before = {
        ...taskLine(id: 'before', sequence: 1),
        'text': 'A word first',
        'author': author,
        'source': {'kind': 'message'},
      };
      final root = {
        ...taskLine(sequence: 2),
        'text': 'Offline drafts',
        'author': author,
        'thread': 'line-1',
        'source': {'kind': 'buddy-proposal'},
      };
      await pumpTaskChat(tester, taskLineBackend([before, root], ask: 'on-it'));
      expect(find.text('● On it'), findsOneWidget);
      expect(find.text('dee'), findsNWidgets(2));
    });
  });
}
