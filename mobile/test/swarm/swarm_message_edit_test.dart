import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_chat_cache.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Editing and deleting your own message on the phone (task #2746, plan
/// Task 3): the long-press sheet offers Edit message and Delete message on the
/// person's own plain message alone, Edit opens its text to change, Delete
/// asks first, and the chat shows "(edited)" and "This message was deleted."
/// as the backend's rows say (`editedAt`, `deletedAt`).
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const commands = '/api/super-tabs/$tab/commands';
  const deleted = 'This message was deleted.';

  /// A row of chat g1: an agent's unless [author] is a person's id ([me] or
  /// `person-*`).
  Map<String, dynamic> message(
    String id,
    int sequence, {
    String text = 'hello',
    String author = me,
    String? thread,
    String? replyTo,
    String? editedAt,
    String? deletedAt,
    Map<String, dynamic>? source,
    List<Map<String, dynamic>> attachments = const [],
  }) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'thread': ?thread,
    'replyTo': ?replyTo,
    'editedAt': ?editedAt,
    'deletedAt': ?deletedAt,
    'source': ?source,
    'author': author.startsWith('person')
        ? {
            'kind': 'person',
            'id': author,
            'name': author == me ? 'tony' : 'ann',
          }
        : {
            'kind': 'agent',
            'id': author,
            'name': author == 'agent-lead' ? 'River' : 'Nova',
          },
    'attachments': attachments,
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 11, 4, 1, sequence).toIso8601String(),
  };

  /// The line under thread root [id]: [replies] replies, the last at [last].
  Map<String, dynamic> line(String id, int replies, int last) => {
    'id': id,
    'replies': replies,
    'lastSequence': last,
    'lastAt': DateTime.utc(2026, 11, 4, 1, last).toIso8601String(),
    'authors': [
      {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
    ],
    'people': <String>[],
  };

  /// One Swarm whose chat g1 reads [page] as its latest messages, with the
  /// lines of [threads]; [members] are who is in it, the reader an owner.
  FakeSwarm backend(
    List<Map<String, dynamic>> page, {
    List<Map<String, dynamic>> threads = const [],
    List<Map<String, dynamic>>? members,
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
            lastMessageSequence: page
                .map((m) => m['sequence'] as int)
                .fold(0, (a, b) => a > b ? a : b),
          ),
        ],
      ),
      'members': [
        for (final member
            in members ?? [person(me), person('person-ann', role: 'member')])
          part(member['id'] as String, 1, member),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': page.reversed.toList(),
      'next': null,
      'threads': threads,
      'reactionSeq': 0,
    };
    fake.routes[commands] = (_) => {
      'result': {'changed': true},
    };
    return fake;
  }

  Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
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
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  final edit = key('swarm-edit-message');
  final delete = key('swarm-delete-message');

  setUp(() {
    // The long-press's light tap of the phone.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (_) async => null);
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
    SwarmChatCache.clear();
  });

  group('the long-press sheet', () {
    testWidgets('on your own message offers Edit message and Delete message '
        'under Copy link to message', (tester) async {
      await pump(tester, backend([message('m1', 1, text: 'Plan')]));

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();

      expect(find.text('Edit message'), findsOneWidget);
      expect(find.text('Delete message'), findsOneWidget);
      final link = tester.getRect(key('swarm-copy-link'));
      expect(tester.getRect(edit).top, greaterThanOrEqualTo(link.bottom));
      expect(
        tester.getRect(delete).top,
        greaterThanOrEqualTo(tester.getRect(edit).bottom),
      );
      expect(tester.getSize(edit).height, greaterThanOrEqualTo(44));
      expect(tester.getSize(delete).height, greaterThanOrEqualTo(44));
    });

    testWidgets("never on an agent's message, another person's, or a note "
        'the server wrote in your name', (tester) async {
      await pump(
        tester,
        backend([
          message('m1', 1, text: 'From Nova', author: 'agent-builder'),
          message('m2', 2, text: 'From Ann', author: 'person-ann'),
          message('m3', 3, text: 'Task root', source: {'kind': 'task-line'}),
        ]),
      );

      for (final text in ['From Nova', 'From Ann', 'Task root']) {
        await tester.longPress(find.text(text));
        await tester.pumpAndSettle();
        expect(key('swarm-copy-link'), findsOneWidget, reason: text);
        expect(edit, findsNothing, reason: text);
        expect(delete, findsNothing, reason: text);
        await tester.tapAt(const Offset(20, 20));
        await tester.pumpAndSettle();
      }
    });

    testWidgets('never for a person who may not write here', (tester) async {
      await pump(
        tester,
        backend(
          [message('m1', 1, text: 'Plan')],
          members: [person(me, role: 'viewer')],
        ),
      );

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();

      expect(key('swarm-copy-link'), findsOneWidget);
      expect(edit, findsNothing);
      expect(delete, findsNothing);
    });
  });

  testWidgets('your Buddy proposal offers Delete without Edit', (tester) async {
    await pump(
      tester,
      backend([
        message(
          'm1',
          1,
          text: 'Please fix the menu',
          source: {'kind': 'buddy-proposal', 'personId': me},
        ),
      ]),
    );
    await tester.longPress(find.text('Please fix the menu'));
    await tester.pumpAndSettle();
    expect(delete, findsOneWidget);
    expect(edit, findsNothing);
  });

  for (final author in ['person-ann', 'agent-builder']) {
    testWidgets('$author Buddy proposal offers neither action', (tester) async {
      await pump(
        tester,
        backend([
          message(
            'm1',
            1,
            text: 'Please fix the menu',
            author: author,
            source: {'kind': 'buddy-proposal', 'personId': me},
          ),
        ]),
      );
      await tester.longPress(find.text('Please fix the menu'));
      await tester.pumpAndSettle();
      expect(delete, findsNothing);
      expect(edit, findsNothing);
    });
  }

  for (final source in [
    {'kind': 'buddy-proposal', 'personId': 'person-ann'},
    {'kind': 'buddy-proposal'},
    {'kind': 'task-line', 'personId': me},
  ]) {
    testWidgets('source cannot authorize owner deletion: $source', (
      tester,
    ) async {
      await pump(
        tester,
        backend([
          message('m1', 1, text: 'Please fix the menu', source: source),
        ]),
      );
      await tester.longPress(find.text('Please fix the menu'));
      await tester.pumpAndSettle();
      expect(delete, findsNothing);
      expect(edit, findsNothing);
    });
  }

  testWidgets('your Buddy proposal in a thread offers Delete without Edit', (
    tester,
  ) async {
    final root = message(
      'm1',
      1,
      author: 'agent-lead',
      text: 'Root',
      thread: 'm1',
    );
    final reply = message(
      'm2',
      2,
      text: 'Please fix the menu',
      thread: 'm1',
      replyTo: 'm1',
      source: {'kind': 'buddy-proposal', 'personId': me},
    );
    final fake = backend([root, reply], threads: [line('m1', 1, 2)]);
    fake.routes['$messages?thread=m1'] = (_) => {
      'messages': [reply, root],
      'next': null,
      'threads': <Object>[],
    };
    await pump(tester, fake);
    await tester.tap(key('swarm-thread-line-m1'));
    await tester.pumpAndSettle();
    await tester.longPress(
      find.descendant(
        of: key('swarm-thread-messages'),
        matching: find.text('Please fix the menu'),
      ),
    );
    await tester.pumpAndSettle();
    expect(delete, findsOneWidget);
    expect(edit, findsNothing);
  });

  group('Edit message', () {
    testWidgets('opens the text in a field; Save sends message.edit and the '
        'chat shows the new text, edited', (tester) async {
      final fake = backend([message('m1', 1, text: 'Plan')]);
      fake.routes['$messages?before=2'] = (_) => {
        'messages': [
          message(
            'm1',
            1,
            text: 'Plan B',
            editedAt: DateTime.utc(2026, 11, 4, 2).toIso8601String(),
          ),
        ],
        'next': null,
        'reactionSeq': 1,
      };
      await pump(tester, fake);

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();
      await tester.tap(edit);
      await tester.pumpAndSettle();

      final field = key('swarm-edit-field');
      expect(tester.widget<TextField>(field).controller!.text, 'Plan');
      await tester.enterText(field, '  Plan B \n');
      await tester.tap(key('swarm-edit-save'));
      await tester.pumpAndSettle();

      expect(fake.commands, [
        {
          'type': 'message.edit',
          'conversationId': 'g1',
          'messageId': 'm1',
          'text': 'Plan B',
        },
      ]);
      expect(field, findsNothing, reason: 'the sheet closed');
      expect(find.text('Plan B'), findsOneWidget);
      expect(find.text('Plan'), findsNothing);
      expect(find.text('(edited)'), findsOneWidget);
    });

    testWidgets('Save with the text unchanged, or Cancel, sends nothing', (
      tester,
    ) async {
      final fake = backend([message('m1', 1, text: 'Plan')]);
      await pump(tester, fake);

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();
      await tester.tap(edit);
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-edit-save'));
      await tester.pumpAndSettle();
      expect(key('swarm-edit-field'), findsNothing);

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();
      await tester.tap(edit);
      await tester.pumpAndSettle();
      await tester.enterText(key('swarm-edit-field'), 'Something else');
      await tester.tap(key('swarm-edit-cancel'));
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(find.text('Plan'), findsOneWidget);
    });

    testWidgets('a refusal says why at the foot and keeps the old text', (
      tester,
    ) async {
      final fake = backend([message('m1', 1, text: 'Plan')]);
      fake.routes[commands] = (_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'Only its author can change this message.',
        statusCode: 403,
      );
      await pump(tester, fake);

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();
      await tester.tap(edit);
      await tester.pumpAndSettle();
      await tester.enterText(key('swarm-edit-field'), 'Plan B');
      await tester.tap(key('swarm-edit-save'));
      await tester.pumpAndSettle();

      expect(fake.commands.single['type'], 'message.edit');
      expect(
        find.descendant(
          of: find.byType(SnackBar),
          matching: find.text('Only its author can change this message.'),
        ),
        findsOneWidget,
      );
      expect(find.text('Plan'), findsOneWidget);
      expect(find.text('(edited)'), findsNothing);
    });
  });

  group('Delete message', () {
    testWidgets('asks first: Cancel sends nothing', (tester) async {
      final fake = backend([message('m1', 1, text: 'Plan')]);
      await pump(tester, fake);

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();
      await tester.tap(delete);
      await tester.pumpAndSettle();

      expect(find.text('Delete message?'), findsOneWidget);
      expect(find.text("This can't be undone."), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Cancel'));
      await tester.pumpAndSettle();

      expect(fake.commands, isEmpty);
      expect(find.text('Plan'), findsOneWidget);
    });

    testWidgets('Delete sends message.delete, and the page read again '
        'without it drops the row', (tester) async {
      final fake = backend([
        message('m1', 1, text: 'Before', author: 'agent-builder'),
        message('m2', 2, text: 'Plan'),
      ]);
      fake.routes['$messages?before=3'] = (_) => {
        'messages': [message('m1', 1, text: 'Before', author: 'agent-builder')],
        'next': null,
        'reactionSeq': 1,
      };
      // Nothing after it: the backend's newest stepped back (a Swarm read
      // still saying 2 reads on from what is shown).
      fake.routes['$messages?after='] = (_) => {
        'messages': <Object>[],
        'next': null,
        'reactionSeq': 1,
      };
      await pump(tester, fake);

      await tester.longPress(find.text('Plan'));
      await tester.pumpAndSettle();
      await tester.tap(delete);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();

      expect(fake.commands, [
        {'type': 'message.delete', 'conversationId': 'g1', 'messageId': 'm2'},
      ]);
      expect(find.text('Plan'), findsNothing);
      expect(key('swarm-message-m2'), findsNothing);
      expect(find.text('Before'), findsOneWidget);
    });

    testWidgets('in a thread: your own reply is deleted there, and goes', (
      tester,
    ) async {
      final fake = backend(
        [
          message('m1', 1, author: 'agent-lead', text: 'Root', thread: 'm1'),
          message('m2', 2, text: 'My reply', thread: 'm1', replyTo: 'm1'),
        ],
        threads: [line('m1', 1, 2)],
      );
      var thread = [
        message('m2', 2, text: 'My reply', thread: 'm1', replyTo: 'm1'),
        message('m1', 1, author: 'agent-lead', text: 'Root', thread: 'm1'),
      ];
      fake.routes['$messages?thread=m1'] = (_) => {
        'messages': thread,
        'next': null,
        'threads': <Object>[],
      };
      fake.routes['$messages?before=3'] = (_) => {
        'messages': [
          message('m1', 1, author: 'agent-lead', text: 'Root', thread: 'm1'),
        ],
        'next': null,
        'reactionSeq': 1,
      };
      // Nothing after it: the backend's newest stepped back (a Swarm read
      // still saying 2 reads on from what is shown).
      fake.routes['$messages?after='] = (_) => {
        'messages': <Object>[],
        'next': null,
        'reactionSeq': 1,
      };
      await pump(tester, fake);
      await tester.tap(key('swarm-thread-line-m1'));
      await tester.pumpAndSettle();

      final reply = find.descendant(
        of: key('swarm-thread-messages'),
        matching: find.text('My reply'),
      );
      await tester.longPress(reply);
      await tester.pumpAndSettle();
      thread = [
        message('m1', 1, author: 'agent-lead', text: 'Root', thread: 'm1'),
      ];
      await tester.tap(delete);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();

      expect(fake.commands, [
        {'type': 'message.delete', 'conversationId': 'g1', 'messageId': 'm2'},
      ]);
      expect(reply, findsNothing);
    });
  });

  group('the rows', () {
    testWidgets('an edited message says so after its text', (tester) async {
      await pump(
        tester,
        backend([
          message(
            'm1',
            1,
            text: 'Plan B',
            author: 'agent-builder',
            editedAt: DateTime.utc(2026, 11, 4, 2).toIso8601String(),
          ),
          message('m2', 2, text: 'Untouched', author: 'agent-builder'),
        ]),
      );

      expect(
        find.descendant(
          of: key('swarm-message-m1'),
          matching: find.text('(edited)'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('swarm-message-m2'),
          matching: find.text('(edited)'),
        ),
        findsNothing,
      );
      final text = tester.widget<Text>(
        find.descendant(
          of: key('swarm-message-m1'),
          matching: find.text('(edited)'),
        ),
      );
      expect(text.style?.color, grid.AppPalette.textFaint);
    });

    testWidgets('a deleted message with replies reads "This message was '
        'deleted." in faint italic, keeps its thread line, and opens no '
        'sheet', (tester) async {
      final fake = backend(
        [
          message(
            'm1',
            1,
            text: deleted,
            thread: 'm1',
            deletedAt: DateTime.utc(2026, 11, 4, 2).toIso8601String(),
          ),
        ],
        threads: [line('m1', 2, 3)],
      );
      await pump(tester, fake);

      final words = find.descendant(
        of: key('swarm-message-m1'),
        matching: find.text(deleted),
      );
      expect(words, findsOneWidget);
      final style = tester.widget<Text>(words).style!;
      expect(style.fontStyle, FontStyle.italic);
      expect(style.color, grid.AppPalette.textFaint);
      expect(key('swarm-thread-line-m1'), findsOneWidget);

      await tester.longPress(words);
      await tester.pumpAndSettle();
      expect(key('swarm-copy-link'), findsNothing);
      expect(edit, findsNothing);
      expect(fake.commands, isEmpty);
    });
  });

  // The chat as a reader holds it (swarm_conversation.dart): a page read again
  // when the reaction counter moves is the backend's word on the messages in
  // it, so one it no longer has is gone, here and in the chat kept for the
  // next open.
  group('a page read again', () {
    ({FakeSwarm swarm, SwarmReader reader}) rig() {
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [
            groupData(
              'g1',
              title: 'Fix login',
              agentIds: ['agent-lead', 'agent-builder'],
              lastMessageSequence: 3,
            ),
          ],
        ),
        'members': [part(me, 1, person(me))],
      };
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      swarm.routes[messages] = (_) => {
        'messages': [
          message('m3', 3, text: 'Third'),
          message('m2', 2, text: 'Second', author: 'person-ann'),
          message('m1', 1, text: 'First'),
        ],
        'next': null,
        'reactionSeq': 0,
      };
      final reader = SwarmReader(
        tabId: tab,
        accountId: me,
        request: swarm.request,
      );
      addTearDown(reader.dispose);
      return (swarm: swarm, reader: reader);
    }

    /// g1 with its reaction counter at [reactionSeq], as a change read
    /// brings it.
    Map<String, dynamic> moved(int version, int reactionSeq) => changes(
      cursor: 'c$version',
      groups: [
        part('g1', version, {
          ...groupData(
            'g1',
            title: 'Fix login',
            agentIds: ['agent-lead', 'agent-builder'],
            lastMessageSequence: 3,
          ),
          'reactionSeq': reactionSeq,
        }),
      ],
    );

    List<String> texts(SwarmConversation c) => [
      for (final m in c.messages) m.text,
    ];

    test('without a message drops it, and takes an edited text over the '
        'old one', () async {
      final r = rig();
      await r.reader.refresh();
      final c = SwarmConversation(r.reader, 'g1');
      addTearDown(c.dispose);
      await c.load();
      expect(texts(c), ['First', 'Second', 'Third']);

      r.swarm.routes['$messages?before=4'] = (_) => {
        'messages': [
          message(
            'm3',
            3,
            text: 'Third, fixed',
            editedAt: DateTime.utc(2026, 11, 4, 2).toIso8601String(),
          ),
          message('m1', 1, text: 'First'),
        ],
        'next': null,
        'reactionSeq': 2,
      };
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => moved(30, 2);
      await r.reader.refresh();
      await settle();

      expect(texts(c), ['First', 'Third, fixed']);
      expect(c.messages.last.editedAt, DateTime.utc(2026, 11, 4, 2));
    });

    test('without a message, a chat opened again from what was kept does not '
        'bring it back', () async {
      final r = rig();
      await r.reader.refresh();
      var c = SwarmConversation(r.reader, 'g1');
      await c.load();
      c.dispose();

      r.swarm.routes['$messages?after=3'] = (_) => {
        'messages': <Object>[],
        'next': null,
        'reactionSeq': 2,
      };
      r.swarm.routes['$messages?before=4'] = (_) => {
        'messages': [
          message('m3', 3, text: 'Third'),
          message('m1', 1, text: 'First'),
        ],
        'next': null,
        'reactionSeq': 2,
      };
      c = SwarmConversation(r.reader, 'g1');
      await c.load();
      await settle();
      expect(texts(c), ['First', 'Third']);
      c.dispose();

      c = SwarmConversation(r.reader, 'g1');
      addTearDown(c.dispose);
      expect(texts(c), ['First', 'Third'], reason: 'kept as read again');
    });

    test('that has more before it drops only what it covers', () async {
      final r = rig();
      await r.reader.refresh();
      final c = SwarmConversation(r.reader, 'g1');
      addTearDown(c.dispose);
      await c.load();

      // A page of one: m1 and m2 are before it, not gone.
      r.swarm.routes['$messages?before=4'] = (_) => {
        'messages': [message('m3', 3, text: 'Third')],
        'next': {'sequence': 3, 'id': 'm3'},
        'reactionSeq': 2,
      };
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) => moved(30, 2);
      await r.reader.refresh();
      await settle();

      expect(texts(c), ['First', 'Second', 'Third']);
    });
  });

  group('the model', () {
    test('reads editedAt and deletedAt', () {
      final m = SuperTabMessage.fromJson(
        message(
          'm1',
          1,
          text: deleted,
          editedAt: '2026-11-04T02:00:00.000Z',
          deletedAt: '2026-11-04T03:00:00.000Z',
        ),
      );
      expect(m.editedAt, DateTime.utc(2026, 11, 4, 2));
      expect(m.deletedAt, DateTime.utc(2026, 11, 4, 3));
      expect(m.deleted, isTrue);
      expect(SuperTabMessage.fromJson(message('m2', 2)).deleted, isFalse);
    });
  });
}
