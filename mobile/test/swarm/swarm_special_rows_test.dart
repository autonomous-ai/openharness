import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_thread_page.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

// Literal server payloads, as Desktop's rows read them.
Map<String, dynamic> row(
  String id,
  int sequence,
  String text,
  Map<String, dynamic> source, {
  String author = 'River',
}) => {
  'id': id,
  'conversationId': leadChat,
  'sequence': sequence,
  'text': text,
  'author': {'kind': 'agent', 'id': 'agent-$author', 'name': author},
  'createdAt': DateTime.utc(2026, 11, 2, 17, sequence).toIso8601String(),
  'source': source,
};

Map<String, dynamic> routeSource({Object? decision = 'd1'}) => {
  'kind': 'route',
  'decisionId': decision,
  'via': 'order',
  'why': 'A small fix',
  'pick': {'id': 'c0', 'title': 'Nico · Claude opus high · Mac Studio'},
  'alternatives': <Object>[],
};

const decisions = '/api/super-tabs/$tab/route-decisions/d1';

FakeSwarm backend(List<Map<String, dynamic>> page) {
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
    ],
    'next': null,
  };
  fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
    groups: [
      groupData(leadChat, title: 'Project chat', lastMessageSequence: 10),
    ],
  );
  fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
  fake.routes['/api/super-tabs/$tab/decisions'] = (_) => {
    'decisions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/mentions'] = (_) => {
    'mentions': <Object>[],
  };
  fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] = (_) =>
      {'messages': page.reversed.toList(), 'threads': <Object>[], 'next': null};
  return fake;
}

Future<void> show(WidgetTester tester, FakeSwarm fake) async {
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
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
      builder: (context, child) => SwarmScope(notifier: host, child: child!),
      home: const SwarmConversationPage(swarmId: tab, conversationId: leadChat),
    ),
  );
  await tester.pumpAndSettle();
}

Finder inRow(String id, Finder inner) => find.descendant(
  of: find.byKey(ValueKey('swarm-message-$id')),
  matching: inner,
);

/// The plain text of everything drawn in message [id].
String textOf(WidgetTester tester, String id) => [
  for (final text in tester.widgetList<RichText>(
    inRow(id, find.byType(RichText)),
  ))
    text.text.toPlainText(),
].join('\n');

void main() {
  group('a route row', () {
    testWidgets('is a quiet line naming who it went to, with no author', (
      tester,
    ) async {
      await show(
        tester,
        backend([row('r1', 2, 'Routed to Nico', routeSource())]),
      );
      expect(textOf(tester, 'r1'), contains('Routed to Nico'));
      expect(inRow('r1', find.text('River')), findsNothing);
      expect(inRow('r1', find.text('Details')), findsOneWidget);
    });

    testWidgets('a new agent reads as its engine', (tester) async {
      await show(
        tester,
        backend([
          row('r1', 2, 'x', {
            ...routeSource(),
            'pick': {'id': 'c0', 'title': 'New agent · Codex gpt high · Mac'},
          }),
        ]),
      );
      expect(textOf(tester, 'r1'), contains('Routed to new Codex agent'));
    });

    testWidgets('Details reads the decision once, and hides again', (
      tester,
    ) async {
      final fake = backend([row('r1', 2, 'x', routeSource())]);
      fake.routes[decisions] = (_) => {
        'record': {
          'instructionsRevision': 7,
          'candidates': [
            {'title': 'Echo · Claude', 'label': 'busy'},
          ],
          'excluded': [
            {'title': 'Mac 3', 'reason': 'offline'},
          ],
        },
      };
      await show(tester, fake);
      await tester.tap(inRow('r1', find.text('Details')));
      await tester.pumpAndSettle();
      for (final words in const [
        'Nico · Claude opus high · Mac Studio',
        'A small fix',
        'Selection: Ranked by strength, price and quota',
        'Relied on instructions revision 7',
        'Considered',
        'Echo · Claude — busy',
        'Unavailable: Mac 3 — offline',
      ]) {
        expect(inRow('r1', find.text(words)), findsOneWidget, reason: words);
      }
      await tester.tap(inRow('r1', find.text('Hide details')));
      await tester.pumpAndSettle();
      expect(inRow('r1', find.text('Considered')), findsNothing);
      await tester.tap(inRow('r1', find.text('Details')));
      await tester.pumpAndSettle();
      expect(fake.paths.where((p) => p == decisions), hasLength(1));
    });

    testWidgets('a failed read says so, and Retry reads again', (tester) async {
      final fake = backend([row('r1', 2, 'x', routeSource())]);
      var fails = true;
      fake.routes[decisions] = (_) {
        if (fails) throw StateError('offline');
        return {
          'record': {'instructionsRevision': 0},
        };
      };
      await show(tester, fake);
      await tester.tap(inRow('r1', find.text('Details')));
      await tester.pumpAndSettle();
      expect(
        inRow('r1', find.text('Could not load this decision.')),
        findsOneWidget,
      );
      fails = false;
      await tester.tap(inRow('r1', find.text('Retry')));
      await tester.pumpAndSettle();
      expect(
        inRow('r1', find.text('Relied on the built-in instructions')),
        findsOneWidget,
      );
    });

    testWidgets('one with no decision is an ordinary message', (tester) async {
      await show(
        tester,
        backend([
          row('r1', 2, 'Routed somewhere', routeSource(decision: null)),
        ]),
      );
      expect(inRow('r1', find.text('Details')), findsNothing);
      expect(inRow('r1', find.text('River')), findsOneWidget);
    });
  });

  group('a terminal note', () {
    testWidgets('of input: a quiet line, what was typed in the mono face', (
      tester,
    ) async {
      await show(
        tester,
        backend([
          row('t1', 2, 'River typed `echo `date`` into the terminal', {
            'kind': 'terminal-input',
          }),
        ]),
      );
      expect(inRow('t1', find.byIcon(LucideIcons.keyboard300)), findsOneWidget);
      expect(inRow('t1', find.text('River')), findsNothing);
      // Only the first and last backtick are the wrapper.
      final spans = <TextSpan>[];
      for (final text in tester.widgetList<RichText>(
        inRow('t1', find.byType(RichText)),
      )) {
        text.text.visitChildren((span) {
          if (span is TextSpan) spans.add(span);
          return true;
        });
      }
      expect(
        spans.where((s) => s.text == 'echo `date`').single.style?.fontFamily,
        isNotNull,
      );
    });

    testWidgets('of an alert: a warning mark, and no author', (tester) async {
      await show(
        tester,
        backend([
          row('t1', 2, 'Nico is waiting at a prompt', {
            'kind': 'terminal-alert',
            'alert': 'other',
          }),
        ]),
      );
      expect(
        inRow('t1', find.byIcon(LucideIcons.triangleAlert300)),
        findsOneWidget,
      );
      expect(inRow('t1', find.text('River')), findsNothing);
    });

    testWidgets('of a usage limit says until when', (tester) async {
      await show(
        tester,
        backend([
          row('t1', 2, 'River hit its usage limit', {
            'kind': 'terminal-alert',
            'alert': 'limit',
            'agentId': 'agent-River',
            'limitedUntil': DateTime(2026, 11, 3, 18, 5).toIso8601String(),
          }),
        ]),
      );
      expect(textOf(tester, 't1'), contains('until'));
      expect(textOf(tester, 't1'), contains('18:05'));
    });
  });

  group('a proposal', () {
    Map<String, dynamic> proposal() => row(
      'p1',
      2,
      'Asked by dee.\nGoal: Activity read fix\nChanges: more words',
      {'kind': 'buddy-proposal', 'personId': me},
      author: 'Buddy',
    );

    testWidgets('is one line, named by its goal, with no author', (
      tester,
    ) async {
      await show(tester, backend([proposal()]));
      expect(textOf(tester, 'p1'), contains(': Activity read fix'));
      expect(textOf(tester, 'p1'), startsWith('Proposal from '));
      expect(textOf(tester, 'p1'), isNot(contains('Changes: more words')));
      expect(inRow('p1', find.text('Buddy')), findsNothing);
    });

    testWidgets('opens its thread, where it reads whole and says for whom', (
      tester,
    ) async {
      final fake = backend([proposal()]);
      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
          (_) => {
            'messages': [proposal()],
            'threads': <Object>[],
            'next': null,
          };
      await show(tester, fake);
      await tester.tap(find.byKey(const ValueKey('swarm-message-p1')));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmThreadPage), findsOneWidget);
      expect(find.textContaining('on '), findsWidgets);
      expect(
        find.byKey(const ValueKey('swarm-proposal-label')),
        findsOneWidget,
      );
      expect(find.textContaining('Changes: more words'), findsOneWidget);
    });
  });

  group('an ordinary message says', () {
    testWidgets('Terminal answer above a terminal\'s answer', (tester) async {
      await show(
        tester,
        backend([
          row('n1', 2, 'The build passed.', {'kind': 'native'}),
        ]),
      );
      expect(inRow('n1', find.text('Terminal answer')), findsOneWidget);
      expect(inRow('n1', find.text('River')), findsOneWidget);
    });

    testWidgets('Excerpt under a truncated response', (tester) async {
      await show(
        tester,
        backend([
          row('n1', 2, 'The build…', {'kind': 'native', 'truncated': true}),
        ]),
      );
      expect(
        inRow(
          'n1',
          find.text('Excerpt · open the terminal for the full response'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('Response interrupted under an interrupted one', (
      tester,
    ) async {
      await show(
        tester,
        backend([
          row('n1', 2, 'The build', {'kind': 'native', 'interrupted': true}),
        ]),
      );
      expect(inRow('n1', find.text('Response interrupted')), findsOneWidget);
    });
  });

  testWidgets('none of them groups with the message before it', (tester) async {
    await show(
      tester,
      backend([
        row('a', 2, 'Short.', {'kind': 'message'}),
        row('b', 3, 'Short too.', {'kind': 'native'}),
      ]),
    );
    expect(inRow('b', find.text('River')), findsOneWidget);
  });
}
