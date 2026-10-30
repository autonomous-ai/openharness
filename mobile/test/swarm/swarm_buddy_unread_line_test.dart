import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The New messages line and Jump to latest of Swarm Home C's project chat
/// (#2259) in the person's own Buddy chat too (Tony, 2026-10-30): above the
/// first message from someone else the person had not read as the chat
/// opened, placed once, the chat opening at it; and Jump to latest while
/// they read more than a screen back. Work chats have neither.
void main() {
  const chat = 'buddy-me';
  const messages = '/api/super-tabs/$tab/conversations/$chat/messages';
  final line = find.byKey(const ValueKey('swarm-new-messages-line'));
  final jump = find.byKey(const ValueKey('swarm-jump-latest'));

  Map<String, dynamic> said(
    int sequence, {
    String author = 'agent-wren',
    String kind = 'agent',
    String? text,
    String conversation = chat,
  }) => {
    'id': 'msg-$sequence',
    'conversationId': conversation,
    'text': text ?? 'Update $sequence.',
    'sequence': sequence,
    'author': {'kind': kind, 'id': author, 'name': author},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 10, 29, 1, sequence).toIso8601String(),
  };

  /// The person's Buddy chat holding [page], read through [mark] on some
  /// device (the server's mark, #2131); [older] ones come before them.
  FakeSwarm backend(
    List<Map<String, dynamic>> page, {
    required int mark,
    bool older = false,
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
            number: 7,
            lastMessageSequence: 3,
          ),
          buddyChatData(
            chat,
            agentIds: ['agent-wren'],
            lastMessageSequence: page.isEmpty
                ? 0
                : page.last['sequence'] as int,
          ),
        ],
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          buddyData('agent-wren', displayName: 'Wren'),
        ],
        derived: {
          'readMarks': {chat: mark, 'g1': 3},
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
      'messages': page.reversed.toList(),
      'next': older
          ? {'sequence': page.first['sequence'], 'id': 'msg-older'}
          : null,
    };
    fake.routes['/api/super-tabs/$tab/conversations/g1/messages'] = (_) => {
      'messages': [for (var i = 1; i <= 40; i++) said(i, conversation: 'g1')]
          .reversed
          .toList(),
      'next': null,
    };
    return fake;
  }

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    bool settle = true,
    Widget home = const SwarmConversationPage(
      swarmId: tab,
      conversationId: chat,
    ),
  }) async {
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
        home: home,
      ),
    );
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }
    return host;
  }

  /// [fake]'s Swarm read failing until the returned function is called, which
  /// reads it again.
  Future<void> Function() swarmDownAt(
    WidgetTester tester,
    FakeSwarm fake,
    SwarmHost Function() host,
  ) {
    final parts = '/api/super-tabs/$tab/parts';
    final answer = fake.routes[parts]!;
    var down = true;
    fake.routes[parts] = (body) {
      if (down) {
        throw const SuperTabFailure(
          'INTERNAL',
          'Swarm temporarily unavailable.',
        );
      }
      return answer(body);
    };
    return () async {
      down = false;
      await host().session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
    };
  }

  /// The read marks sent for [conversation], in order.
  List<Object?> marksSent(FakeSwarm fake, [String conversation = chat]) => [
    for (final call in fake.calls)
      if (call.method == 'POST' &&
          call.path == '/api/super-tabs/$tab/conversations/$conversation/read')
        call.body?['sequence'],
  ];

  bool onScreen(WidgetTester tester, Finder f) {
    if (f.evaluate().isEmpty) return false;
    final list = tester.getRect(find.byKey(const ValueKey('swarm-messages')));
    final row = tester.getRect(f);
    return row.top >= list.top && row.bottom <= list.bottom;
  }

  List<Map<String, dynamic>> forty([String conversation = chat]) => [
    for (var i = 1; i <= 40; i++) said(i, conversation: conversation),
  ];

  group('the New messages line', () {
    testWidgets('sits above the first message from someone else the person '
        'had not read, and says so in words', (tester) async {
      await pump(
        tester,
        backend([for (var i = 1; i <= 4; i++) said(i)], mark: 2),
      );

      expect(line, findsOneWidget);
      expect(find.text('New messages'), findsOneWidget);
      expect(tester.getSemantics(line).label, 'New messages');
      final y = tester.getTopLeft(line).dy;
      expect(tester.getTopLeft(find.text('Update 2.')).dy, lessThan(y));
      expect(tester.getTopLeft(find.text('Update 3.')).dy, greaterThan(y));
    });

    testWidgets("passes over the person's own messages", (tester) async {
      await pump(
        tester,
        backend([
          said(1),
          said(2),
          said(3, author: me, kind: 'person', text: 'On it.'),
        ], mark: 1),
      );

      expect(line, findsNothing);
    });

    testWidgets('a message from an agent that has the person\'s id is still '
        'from someone else', (tester) async {
      await pump(
        tester,
        backend([said(1), said(2, author: me, kind: 'agent')], mark: 1),
      );

      expect(line, findsOneWidget);
    });

    testWidgets('a chat read through its end has none', (tester) async {
      await pump(tester, backend([said(1), said(2)], mark: 2));

      expect(line, findsNothing);
    });

    testWidgets('above the screen, the chat opens at it, and what is below '
        'is read only once the person goes down to it', (tester) async {
      final fake = backend(forty(), mark: 5);
      await pump(tester, fake);

      expect(onScreen(tester, line), isTrue, reason: 'opened at the line');
      expect(onScreen(tester, find.text('Update 6.')), isTrue);
      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(
        marksSent(fake).where((s) => (s! as int) > 5),
        isEmpty,
        reason: 'nothing past the line is read yet',
      );

      await tester.fling(
        find.byKey(const ValueKey('swarm-messages')),
        const Offset(0, -6000),
        4000,
      );
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(marksSent(fake).last, 40);
    });

    testWidgets('is also on the Buddy tab of a project', (tester) async {
      await pump(
        tester,
        backend([for (var i = 1; i <= 4; i++) said(i)], mark: 2),
        home: const SwarmProjectPage(swarmId: tab, projectId: project),
      );
      await tester.tap(find.byKey(const ValueKey('swarm-project-tab-buddy')));
      await tester.pumpAndSettle();

      expect(line, findsOneWidget);
      expect(find.text('Update 4.'), findsOneWidget);
    });

    testWidgets('a work chat has none, nor Jump to latest', (tester) async {
      await pump(
        tester,
        backend([said(1)], mark: 1),
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      expect(line, findsNothing);
      await tester.drag(
        find.byKey(const ValueKey('swarm-messages')),
        const Offset(0, 1500),
      );
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(jump, findsNothing);
    });
  });

  group('Jump to latest', () {
    testWidgets('reading more than a screen back it takes the person to the '
        'foot; a little way back, none', (tester) async {
      await pump(tester, backend(forty(), mark: 40));
      expect(line, findsNothing);
      expect(jump, findsNothing, reason: 'at the foot');

      final list = find.byKey(const ValueKey('swarm-messages'));
      await tester.drag(list, const Offset(0, 120));
      await tester.pumpAndSettle();
      expect(jump, findsNothing, reason: 'not a screen back');

      await tester.drag(list, const Offset(0, 1500));
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(jump, findsOneWidget);
      expect(find.text('Jump to latest'), findsOneWidget);
      expect(tester.getSemantics(jump).label, 'Jump to latest');

      await tester.tap(jump);
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(jump, findsNothing);
    });
  });

  group('its privacy edges', () {
    testWidgets("someone else's Buddy chat, which the Swarm does not list "
        'for this person, is refused: no line, no name, nothing of it', (
      tester,
    ) async {
      final fake = backend(forty(), mark: 5);
      fake.routes['/api/super-tabs/$tab/conversations/buddy-dee/messages'] =
          (_) => {
            'messages': [said(1, conversation: 'buddy-dee')],
            'next': null,
          };
      await pump(
        tester,
        fake,
        home: const SwarmConversationPage(
          swarmId: tab,
          conversationId: 'buddy-dee',
        ),
      );

      expect(line, findsNothing);
      expect(jump, findsNothing);
      expect(find.text('Update 1.'), findsNothing);
      expect(find.textContaining('person-dee'), findsNothing);
    });

    testWidgets('access taken away while it is open: the line and the '
        'messages go', (tester) async {
      final fake = backend(forty(), mark: 5);
      final host = await pump(tester, fake);
      expect(line, findsOneWidget);

      const refused = SuperTabFailure(
        'FORBIDDEN',
        'You cannot read this Swarm.',
        statusCode: 403,
      );
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();

      expect(line, findsNothing);
      expect(jump, findsNothing);
      expect(find.text('Update 6.'), findsNothing);
    });

    testWidgets('a first read that fails says so with no Loading left and no '
        "line, and is read again once, at the Swarm's next read", (
      tester,
    ) async {
      final fake = backend([for (var i = 1; i <= 4; i++) said(i)], mark: 2);
      final answer = fake.routes[messages]!;
      fake.routes[messages] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Messages are down.');
      final host = await pump(tester, fake);
      int reads() => fake.paths.where((p) => p.startsWith(messages)).length;

      expect(find.text('Messages are down.'), findsOneWidget);
      expect(find.byKey(const ValueKey('swarm-chat-skeleton')), findsNothing);
      expect(line, findsNothing);
      final opened = reads();
      await tester.pump(const Duration(minutes: 1));
      expect(reads(), opened, reason: 'not again on its own, in a loop');

      fake.routes[messages] = answer;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(reads(), opened + 1);
      expect(find.text('Update 4.'), findsOneWidget);
      expect(find.text('Messages are down.'), findsNothing);
    });
  });

  group('the Swarm read fails first, then recovers', () {
    testWidgets('a Buddy chat then gets Jump to latest', (tester) async {
      final fake = backend(forty(), mark: 40);
      late SwarmHost host;
      final recover = swarmDownAt(tester, fake, () => host);
      host = await pump(tester, fake, settle: false);
      expect(host.session!.inbox.reader(tab)!.snapshot, isNull);

      await recover();
      expect(find.text('Update 40.'), findsOneWidget);
      await tester.drag(
        find.byKey(const ValueKey('swarm-messages')),
        const Offset(0, 1500),
      );
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(jump, findsOneWidget);
    });

    testWidgets('and the New messages line, with nothing read before it', (
      tester,
    ) async {
      final fake = backend([for (var i = 1; i <= 4; i++) said(i)], mark: 2);
      late SwarmHost host;
      final recover = swarmDownAt(tester, fake, () => host);
      host = await pump(tester, fake, settle: false);
      expect(marksSent(fake), isEmpty);

      await recover();

      expect(line, findsOneWidget);
      final y = tester.getTopLeft(line).dy;
      expect(tester.getTopLeft(find.text('Update 2.')).dy, lessThan(y));
      expect(tester.getTopLeft(find.text('Update 3.')).dy, greaterThan(y));
    });

    testWidgets('a work chat still has neither', (tester) async {
      final fake = backend([said(1)], mark: 1);
      late SwarmHost host;
      final recover = swarmDownAt(tester, fake, () => host);
      host = await pump(
        tester,
        fake,
        settle: false,
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );

      await recover();
      await tester.drag(
        find.byKey(const ValueKey('swarm-messages')),
        const Offset(0, 1500),
      );
      await tester.pumpAndSettle();

      expect(line, findsNothing);
      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(jump, findsNothing);
      expect(marksSent(fake, 'g1'), isNotEmpty, reason: 'read, once known');
    });
  });
}
