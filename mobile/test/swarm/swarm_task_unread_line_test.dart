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

/// A task's chat has the New messages line, Jump to first unread and Jump to
/// latest, as the project chat and the person's own Buddy chat do and as
/// Desktop has them in every chat: placed from the server's read mark, above
/// a row the chat draws, the task's own and not its steps'.
void main() {
  const task = 'task-1';
  const step = 'review-1';
  const messages = '/api/super-tabs/$tab/conversations/$task/messages';
  final line = find.byKey(const ValueKey('swarm-new-messages-line'));
  final latest = find.byKey(const ValueKey('swarm-jump-latest'));
  final unread = find.byKey(const ValueKey('swarm-jump-unread'));
  final list = find.byKey(const ValueKey('swarm-messages'));

  Map<String, dynamic> said(
    int sequence, {
    String author = 'agent-dev',
    String kind = 'agent',
    String? text,
    String conversation = task,
    int? minute,
    Map<String, dynamic>? source,
  }) => {
    'id': '$conversation-$sequence',
    'conversationId': conversation,
    'text': text ?? 'Update $sequence.',
    'sequence': sequence,
    'author': {'kind': kind, 'id': author, 'name': author},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'source': ?source,
    'createdAt': DateTime.utc(
      2026,
      11,
      2,
      9,
      minute ?? sequence,
    ).toIso8601String(),
  };

  List<Map<String, dynamic>> forty() => [for (var i = 1; i <= 40; i++) said(i)];

  /// A task in the person's project holding [page], read through [mark] on
  /// some device (the server's mark, #2131). With [steps], it has a Review
  /// step holding them. Its Engineer is [dev], as the Swarm's read has it.
  FakeSwarm backend(
    List<Map<String, dynamic>> page, {
    required int mark,
    List<Map<String, dynamic>>? steps,
    Map<String, dynamic>? dev,
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
            task,
            title: 'Fix login',
            number: 12,
            agentIds: ['agent-dev'],
            status: 'working',
            workerId: 'agent-dev',
            lastMessageSequence: page.isEmpty
                ? 0
                : page.last['sequence'] as int,
          ),
          if (steps != null)
            {
              ...groupData(
                step,
                title: 'Review',
                number: 13,
                status: 'working',
                workerId: 'agent-rev',
                lastMessageSequence: steps.length,
              ),
              'reviewOf': task,
              'step': 'Review',
            },
        ],
        agents: [
          dev ?? agent('agent-dev', displayName: 'Dev'),
          agent('agent-rev', displayName: 'Nova'),
        ],
        derived: {
          'readMarks': {task: mark},
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
      'next': null,
    };
    if (steps != null) {
      fake.routes['/api/super-tabs/$tab/conversations/$step/messages'] = (_) =>
          {'messages': steps.reversed.toList(), 'next': null};
    }
    return fake;
  }

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    bool settle = true,
    String? messageId,
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
        home: SwarmConversationPage(
          swarmId: tab,
          conversationId: task,
          messageId: messageId,
        ),
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

  /// The read marks sent for [conversation], in order.
  List<Object?> marksSent(FakeSwarm fake, [String conversation = task]) => [
    for (final call in fake.calls)
      if (call.method == 'POST' &&
          call.path == '/api/super-tabs/$tab/conversations/$conversation/read')
        call.body?['sequence'],
  ];

  bool onScreen(WidgetTester tester, Finder f) {
    if (f.evaluate().isEmpty) return false;
    final view = tester.getRect(list);
    final row = tester.getRect(f);
    return row.top >= view.top && row.bottom <= view.bottom;
  }

  double y(WidgetTester tester, String text) =>
      tester.getTopLeft(find.textContaining(text)).dy;

  group("a task's chat", () {
    testWidgets('has the New messages line above the first message from '
        'someone else the person had not read', (tester) async {
      final fake = backend([for (var i = 1; i <= 4; i++) said(i)], mark: 2);
      await pump(tester, fake);

      expect(line, findsOneWidget);
      expect(find.text('New messages'), findsOneWidget);
      final at = tester.getTopLeft(line).dy;
      expect(y(tester, 'Update 2.'), lessThan(at));
      expect(y(tester, 'Update 3.'), greaterThan(at));
      expect(marksSent(fake).last, 4, reason: 'the line on screen: all read');
    });

    testWidgets('read through its end has none, and opens at its foot', (
      tester,
    ) async {
      await pump(tester, backend(forty(), mark: 40));

      expect(line, findsNothing);
      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(latest, findsNothing, reason: 'at the foot');
    });

    testWidgets('passes over what the person wrote', (tester) async {
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

    testWidgets('opens at a line above the screen and reads nothing below it '
        'until the person goes down to it', (tester) async {
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

      await tester.fling(list, const Offset(0, -6000), 4000);
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(marksSent(fake).last, 40);
    });

    testWidgets('offers Jump to latest more than a screen back, and a tap '
        'takes the person to the foot', (tester) async {
      await pump(tester, backend(forty(), mark: 40));

      await tester.drag(list, const Offset(0, 120));
      await tester.pumpAndSettle();
      expect(latest, findsNothing, reason: 'not a screen back');

      await tester.drag(list, const Offset(0, 1500));
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(latest, findsOneWidget);
      expect(find.text('Jump to latest'), findsOneWidget);

      await tester.tap(latest);
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(latest, findsNothing);
    });

    testWidgets('opened from a notice below the line, offers Jump to first '
        'unread, which lands on the line', (tester) async {
      await pump(tester, backend(forty(), mark: 5), messageId: '$task-25');

      expect(onScreen(tester, find.text('Update 25.')), isTrue);
      expect(onScreen(tester, line), isFalse);
      expect(unread, findsOneWidget);

      await tester.tap(unread);
      await tester.pumpAndSettle();
      expect(onScreen(tester, line), isTrue);
      expect(unread, findsNothing);
    });
  });

  group('the line sits above a row the task draws', () {
    testWidgets("its own first unread, not a step's row merged in before it", (
      tester,
    ) async {
      final fake = backend(
        [said(1, minute: 1), said(2, minute: 10), said(3, minute: 20)],
        mark: 2,
        // Never read, and written after the task's mark.
        steps: [
          said(
            1,
            conversation: step,
            author: 'agent-rev',
            text: 'Review note.',
            minute: 15,
          ),
        ],
      );
      await pump(tester, fake);

      expect(find.textContaining('Nova · Review'), findsOneWidget);
      expect(line, findsOneWidget);
      final at = tester.getTopLeft(line).dy;
      expect(y(tester, 'Update 2.'), lessThan(at));
      // Merged in by time before the task's first unread: above the line.
      expect(y(tester, 'Review note.'), lessThan(at));
      expect(y(tester, 'Update 3.'), greaterThan(at));
      expect(marksSent(fake).last, 3);
      expect(marksSent(fake, step), isEmpty, reason: 'a step reads on its own');
    });

    testWidgets('an answered prompt warning is passed over: the line goes '
        'above the next message, and the chat is read', (tester) async {
      final fake = backend(
        [
          said(1, text: 'Starting.'),
          said(
            2,
            text: 'Dev is waiting at a prompt in its terminal.',
            source: {
              'kind': 'terminal-alert',
              'agentId': 'agent-dev',
              'alert': 'prompt',
            },
          ),
          said(3, text: 'Prompt answered, carrying on.'),
        ],
        mark: 1,
        // Its prompt answered: the warning is no longer drawn.
        dev: {
          ...agent('agent-dev', displayName: 'Dev'),
          'alerting': <String>[],
        },
      );
      await pump(tester, fake);

      expect(find.textContaining('waiting at a prompt'), findsNothing);
      expect(line, findsOneWidget);
      final at = tester.getTopLeft(line).dy;
      expect(y(tester, 'Starting.'), lessThan(at));
      expect(y(tester, 'Prompt answered'), greaterThan(at));
      expect(marksSent(fake).last, 3, reason: 'the line on screen: all read');
    });
  });

  group("the Swarm's read fails first", () {
    /// [fake]'s Swarm read failing until the returned function is called,
    /// which reads it again.
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

    testWidgets('nothing is read until it works, then the line is placed '
        "from the server's mark", (tester) async {
      final fake = backend([for (var i = 1; i <= 4; i++) said(i)], mark: 2);
      late SwarmHost host;
      final recover = swarmDownAt(tester, fake, () => host);
      host = await pump(tester, fake, settle: false);
      expect(host.session!.inbox.reader(tab)!.snapshot, isNull);
      expect(marksSent(fake), isEmpty);

      await recover();

      expect(line, findsOneWidget);
      final at = tester.getTopLeft(line).dy;
      expect(y(tester, 'Update 2.'), lessThan(at));
      expect(y(tester, 'Update 3.'), greaterThan(at));
      expect(marksSent(fake).last, 4);
    });

    testWidgets('and Jump to latest once it works', (tester) async {
      final fake = backend(forty(), mark: 40);
      late SwarmHost host;
      final recover = swarmDownAt(tester, fake, () => host);
      host = await pump(tester, fake, settle: false);

      await recover();
      await tester.drag(list, const Offset(0, 1500));
      await tester.pumpAndSettle();

      expect(line, findsNothing);
      expect(onScreen(tester, find.text('Update 40.')), isFalse);
      expect(latest, findsOneWidget);
    });
  });
}
