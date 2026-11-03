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

/// A message that links to another Swarm message shows a small preview of
/// it under its text, as Desktop does: who wrote it, the chat it is in when
/// that is another, and the start of its text; a tap opens it. A reply whose
/// original is outside the pages read reads that one message by itself to
/// quote it, and says it "isn't loaded" only when that read fails.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  String one(String conversation, String id, {String swarm = tab}) =>
      '/api/super-tabs/$swarm/conversations/$conversation/messages'
      '?messageId=$id';

  Map<String, dynamic> message(
    String id,
    int sequence, {
    String conversation = 'g1',
    String text = 'hello',
    String author = 'agent-builder',
    String? replyTo,
    int minute = 0,
  }) => {
    'id': id,
    'conversationId': conversation,
    'text': text,
    'sequence': sequence,
    'replyTo': ?replyTo,
    'author': author == me
        ? {'kind': 'person', 'id': me, 'name': 'tony'}
        : {
            'kind': 'agent',
            'id': author,
            'name': author == 'agent-lead' ? 'River' : 'Nova',
          },
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 10, 27, 1, minute).toIso8601String(),
  };

  /// Swarm [tab] with chat g1 reading [page] as its latest messages, and
  /// chat g2, "Release notes"; with [other], the account also has Swarm
  /// tab-2, whose chat h1 is "Billing".
  FakeSwarm backend(
    List<Map<String, dynamic>> page, {
    Object? next,
    bool other = false,
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        if (other) {'id': 'tab-2', 'name': 'Ops Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      groups: [
        groupData(
          'g1',
          title: 'Fix login',
          agentIds: ['agent-lead', 'agent-builder'],
          status: 'working',
          lastMessageSequence: page.isEmpty ? 0 : page.last['sequence'] as int,
        ),
        groupData('g2', title: 'Release notes', agentIds: ['agent-builder']),
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/tab-2/parts'] = (_) => firstLoad(
      tabId: 'tab-2',
      groups: [
        groupData('h1', title: 'Billing', agentIds: ['agent-builder']),
      ],
    );
    fake.routes['/api/super-tabs/tab-2/changes'] = (_) => changes(cursor: 'c2');
    for (final swarm in [tab, 'tab-2']) {
      fake.routes['/api/super-tabs/$swarm/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$swarm/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
    }
    fake.routes[messages] = (_) => {
      'messages': page.reversed.toList(),
      'next': next,
      'threads': <Object>[],
    };
    return fake;
  }

  late SwarmHost host;

  /// The chat on screen. [inFront]: Harness is in front, so the chat's Swarm
  /// is read every few seconds.
  Future<void> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    bool inFront = false,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
    )..foreground = inFront;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// Leaves the chat, so nothing it reads is still waiting.
  Future<void> leave(WidgetTester tester) async {
    host.foreground = false;
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 30));
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// [text] in the preview of the link to [path], "<swarm>/<chat>/<message>".
  Finder inPreview(String path, String text) => find.descendant(
    of: key('swarm-link-preview-$path'),
    matching: find.text(text),
  );
  int asked(FakeSwarm fake, String path) =>
      fake.paths.where((p) => p == path).length;

  testWidgets('a link to a message the chat holds shows who wrote it and its '
      'text; a tap brings it into view and lights it', (tester) async {
    final fake = backend([
      message('m1', 1, author: 'agent-lead', text: 'The very first plan'),
      for (var i = 2; i < 40; i++)
        message('m$i', i, text: 'Line $i\nof the log', minute: i),
      message(
        'm40',
        40,
        author: me,
        text: 'Read this: harness://swarm/$tab/g1/m1',
        minute: 50,
      ),
    ]);
    await pump(tester, fake);

    expect(inPreview('$tab/g1/m1', 'River'), findsOneWidget);
    expect(inPreview('$tab/g1/m1', 'The very first plan'), findsOneWidget);
    expect(
      fake.paths.where((p) => p.contains('messageId=')),
      isEmpty,
      reason: 'a message the chat holds is not read again',
    );

    await tester.tap(key('swarm-link-preview-$tab/g1/m1'));
    await tester.pumpAndSettle();

    final row = find.descendant(
      of: key('swarm-message-m1'),
      matching: find.text('The very first plan'),
    );
    expect(row, findsOneWidget);
    expect(key('swarm-lit-m1'), findsOneWidget);
    await leave(tester);
  });

  testWidgets('a link to a message the chat has not read reads that one '
      'message once, says Loading meanwhile, then shows it', (tester) async {
    final answer = Completer<Object?>();
    final fake = backend([
      message('m40', 40, author: me, text: 'See harness://swarm/$tab/g1/m-old'),
    ]);
    fake.routes[one('g1', 'm-old')] = (_) => answer.future;
    await pump(tester, fake, inFront: true);

    expect(inPreview('$tab/g1/m-old', 'Loading message…'), findsOneWidget);

    answer.complete({
      'messages': [
        message(
          'm-old',
          3,
          author: 'agent-lead',
          text: '  Ship it\n\n  behind   a flag ',
        ),
      ],
    });
    await tester.pumpAndSettle();
    expect(inPreview('$tab/g1/m-old', 'River'), findsOneWidget);
    expect(inPreview('$tab/g1/m-old', 'Ship it behind a flag'), findsOneWidget);

    // The chat's Swarm is read again and again: the message is not.
    await tester.pump(const Duration(seconds: 20));
    await tester.pumpAndSettle();
    expect(asked(fake, one('g1', 'm-old')), 1);
    await leave(tester);
  });

  testWidgets('a link to another chat names that chat; a tap opens it at the '
      'message', (tester) async {
    final fake = backend([
      message('m1', 1, author: me, text: 'Notes: harness://swarm/$tab/g2/x1'),
    ]);
    fake.routes[one('g2', 'x1')] = (_) => {
      'messages': [message('x1', 7, conversation: 'g2', text: 'v2.4 is out')],
    };
    await pump(tester, fake);

    expect(inPreview('$tab/g2/x1', 'Nova · Release notes'), findsOneWidget);
    expect(inPreview('$tab/g2/x1', 'v2.4 is out'), findsOneWidget);

    await tester.tap(key('swarm-link-preview-$tab/g2/x1'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(
      find.byWidgetPredicate(
        (w) =>
            w is SwarmOpenedChat &&
            w.swarmId == tab &&
            w.conversationId == 'g2' &&
            w.messageId == 'x1',
      ),
      findsOneWidget,
    );
    await leave(tester);
  });

  testWidgets('a link into another of the account\'s Swarms is read with that '
      'Swarm; one the account does not have is unavailable, unread', (
    tester,
  ) async {
    final fake = backend([
      message(
        'm1',
        1,
        author: me,
        text:
            'Billing: harness://swarm/tab-2/h1/b1\n'
            'Old: harness://swarm/tab-9/z1/z2',
      ),
    ], other: true);
    fake.routes[one('h1', 'b1', swarm: 'tab-2')] = (_) => {
      'messages': [
        message('b1', 2, conversation: 'h1', author: me, text: 'Invoice sent'),
      ],
    };
    await pump(tester, fake);

    expect(inPreview('tab-2/h1/b1', 'You · Billing'), findsOneWidget);
    expect(inPreview('tab-2/h1/b1', 'Invoice sent'), findsOneWidget);
    expect(inPreview('tab-9/z1/z2', 'Message unavailable'), findsOneWidget);
    expect(fake.paths.where((p) => p.contains('tab-9')), isEmpty);
    await leave(tester);
  });

  testWidgets('a link the reader may not read, or to a message gone, says '
      'only Message unavailable and opens nothing', (tester) async {
    final fake = backend([
      message(
        'm1',
        1,
        author: me,
        text:
            'harness://swarm/$tab/g9/secret\n'
            'harness://swarm/$tab/g2/gone',
      ),
    ]);
    fake.routes[one('g9', 'secret')] = (_) =>
        throw const SuperTabFailure('FORBIDDEN', 'No access.', statusCode: 403);
    fake.routes[one('g2', 'gone')] = (_) => {'messages': <Object>[]};
    await pump(tester, fake);

    expect(inPreview('$tab/g9/secret', 'Message unavailable'), findsOneWidget);
    expect(inPreview('$tab/g2/gone', 'Message unavailable'), findsOneWidget);
    expect(find.textContaining('No access'), findsNothing);

    await tester.tap(key('swarm-link-preview-$tab/g9/secret'));
    await tester.pumpAndSettle();
    expect(find.byType(SwarmOpenedChat), findsNothing);
    await leave(tester);
  });

  testWidgets('a link in code is no preview', (tester) async {
    final fake = backend([
      message('m1', 1, text: 'Run `open harness://swarm/$tab/g1/m1`'),
    ]);
    await pump(tester, fake);

    expect(key('swarm-link-previews-m1'), findsNothing);
    expect(fake.paths.where((p) => p.contains('messageId=')), isEmpty);
    await leave(tester);
  });

  testWidgets('links to messages of the same id in two chats each show '
      'their own preview', (tester) async {
    final fake = backend([
      message(
        'm1',
        1,
        author: me,
        text: 'harness://swarm/$tab/g1/x1 and harness://swarm/$tab/g2/x1',
      ),
    ]);
    fake.routes[one('g1', 'x1')] = (_) => {
      'messages': [message('x1', 7, text: 'Here')],
    };
    fake.routes[one('g2', 'x1')] = (_) => {
      'messages': [message('x1', 7, conversation: 'g2', text: 'There')],
    };
    await pump(tester, fake);

    expect(tester.takeException(), isNull);
    expect(inPreview('$tab/g1/x1', 'Here'), findsOneWidget);
    expect(inPreview('$tab/g2/x1', 'Nova · Release notes'), findsOneWidget);
    expect(inPreview('$tab/g2/x1', 'There'), findsOneWidget);
    await leave(tester);
  });

  group('a reply whose original is not loaded', () {
    List<Map<String, dynamic>> page() => [
      for (var i = 10; i < 40; i++)
        message('m$i', i, text: 'Line $i\nof the log', minute: i),
      message('m40', 40, author: me, text: 'Yes', replyTo: 'm1', minute: 50),
    ];
    const older = {'sequence': 10, 'id': 'm10'};

    testWidgets('reads the original by itself, once, and quotes it', (
      tester,
    ) async {
      final fake = backend(page(), next: older);
      fake.routes[one('g1', 'm1')] = (_) => {
        'messages': [
          message('m1', 1, author: 'agent-lead', text: 'The very first plan'),
        ],
      };
      await pump(tester, fake, inFront: true);

      final quote = key('swarm-quote-m40');
      expect(
        find.descendant(of: quote, matching: find.text('River')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: quote, matching: find.text('The very first plan')),
        findsOneWidget,
      );
      expect(find.text("The original message isn't loaded."), findsNothing);

      await tester.pump(const Duration(seconds: 20));
      await tester.pumpAndSettle();
      expect(asked(fake, one('g1', 'm1')), 1);
      expect(
        fake.paths,
        isNot(contains('$messages?before=10&beforeId=m10')),
        reason: 'no earlier page is read for a quote',
      );
      await leave(tester);
    });

    testWidgets('says it isn\'t loaded when that read fails, and asks again '
        'only a minute later', (tester) async {
      final fake = backend(page(), next: older);
      fake.routes[one('g1', 'm1')] = (_) =>
          throw const SuperTabFailure('UNAVAILABLE', 'Down.', statusCode: 503);
      await pump(tester, fake, inFront: true);

      expect(find.text("The original message isn't loaded."), findsOneWidget);
      await tester.pump(const Duration(seconds: 20));
      await tester.pumpAndSettle();
      expect(asked(fake, one('g1', 'm1')), 1);

      await tester.pump(const Duration(seconds: 45));
      await tester.pumpAndSettle();
      expect(asked(fake, one('g1', 'm1')), 2);
      expect(find.text("The original message isn't loaded."), findsOneWidget);
      await leave(tester);
    });

    testWidgets('says it is no longer in the chat when it is gone or not the '
        'reader\'s', (tester) async {
      for (final answer in <Object? Function()>[
        () => {'messages': <Object>[]},
        () => throw const SuperTabFailure('NOT_FOUND', 'Gone.'),
      ]) {
        final fake = backend(page(), next: older);
        fake.routes[one('g1', 'm1')] = (_) => answer();
        await pump(tester, fake);

        expect(
          find.descendant(
            of: key('swarm-quote-m40'),
            matching: find.text(
              'The original message is no longer in this chat.',
            ),
          ),
          findsOneWidget,
        );
        await leave(tester);
      }
    });
  });
}
