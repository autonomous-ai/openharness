import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_message_receipt.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// "Couldn't confirm delivery" under the person's newest message, and its
/// three answers (the desktop's `_resolveDelivery`): Open terminal, Send
/// again and It arrived, each sent as `delivery.resolve` and then read back.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const exact = '$messages?messageId=';
  const commands = '/api/super-tabs/$tab/commands';
  const note =
      "Lead's computer may have typed this into the terminal without "
      'confirming. Check the terminal before sending again, or it could run '
      'twice.';

  Map<String, dynamic> delivery({
    String status = 'uncertain',
    String agentId = 'agent-lead',
  }) => {'id': 'd1', 'agentId': agentId, 'status': status};

  Map<String, dynamic> own({
    String status = 'uncertain',
    String agentId = 'agent-lead',
  }) => {
    'id': 'm1',
    'conversationId': 'g1',
    'text': 'Please start',
    'sequence': 1,
    'author': {'kind': 'person', 'id': me, 'name': 'tony'},
    'deliveries': [delivery(status: status, agentId: agentId)],
    'createdAt': clock.now().toUtc().toIso8601String(),
  };

  /// What a Swarm read says of the agents: the Lead, in this chat.
  Map<String, dynamic> swarm({
    List<String> agentIds = const ['agent-lead'],
    List<Map<String, dynamic>>? agents,
    String role = 'owner',
    int lastMessageSequence = 1,
  }) => {
    ...firstLoad(
      groups: [
        groupData(
          'g1',
          agentIds: agentIds,
          leadId: agentIds.contains('agent-lead') ? 'agent-lead' : null,
          lastMessageSequence: lastMessageSequence,
        ),
      ],
      agents: agents ?? [agent('agent-lead', name: 'Lead')],
      machines: [
        {
          'machineId': 'mac-1',
          'name': 'Team Mac',
          'contributorId': me,
          'observation': {'receivedAt': clock.now().millisecondsSinceEpoch},
        },
      ],
    ),
    'members': [part(me, 1, person(me, role: role))],
  };

  /// A Swarm where chat g1's newest message is the person's, its delivery
  /// [status]; each read of that message answers [read], each command
  /// [command] (taken by default).
  ({FakeSwarm swarm, SwarmReader reader}) rig({
    String status = 'uncertain',
    Map<String, dynamic> Function()? load,
    FutureOr<Object?> Function()? read,
    FutureOr<Object?> Function(Map<String, dynamic>? body)? command,
    String agentId = 'agent-lead',
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => (load ?? swarm)();
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes[messages] = (_) => {
      'messages': [own(status: status, agentId: agentId)],
      'next': null,
    };
    fake.routes[exact] = (_) =>
        read?.call() ??
        {
          'messages': [own(status: status, agentId: agentId)],
        };
    fake.routes[commands] = command ?? (_) => {'result': {}};
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: fake.request,
    );
    addTearDown(reader.dispose);
    return (swarm: fake, reader: reader);
  }

  List<Map<String, dynamic>> resolves(FakeSwarm swarm) => [
    for (final call in swarm.calls)
      if (call.method == 'POST' &&
          call.path == commands &&
          (call.body!['command'] as Map)['type'] == 'delivery.resolve')
        call.body!,
  ];

  int reads(FakeSwarm swarm) =>
      swarm.paths.where((path) => path.startsWith(exact)).length;

  /// The chat on screen, under a shell that can open [openable] computers;
  /// no shell when [shell] is false. Its newest own message read once.
  Future<SwarmConversation> show(
    WidgetTester tester,
    ({FakeSwarm swarm, SwarmReader reader}) r, {
    bool shell = true,
    Set<String> openable = const {'mac-1'},
    List<(String, String)>? opened,
  }) async {
    late SwarmConversation c;
    await tester.runAsync(() async {
      await r.reader.refresh();
      c = SwarmConversation(r.reader, 'g1');
      await c.load();
      // The Swarm's read sets off the message's own read.
      await r.reader.refresh();
      await pumpEventQueue();
    });
    // A test may close it itself.
    addTearDown(() {
      try {
        c.dispose();
      } on FlutterError catch (_) {}
    });
    Widget line = ListenableBuilder(
      listenable: c,
      builder: (_, _) => switch (c.latestOwn) {
        final m? => SwarmMessageReceipt(conversation: c, message: m),
        null => const SizedBox.shrink(),
      },
    );
    if (shell) {
      line = PhoneShellScope(
        onMachineLinked: (_) {},
        onOpenAgent: (machineId, agentId) => opened?.add((machineId, agentId)),
        canOpenMachine: openable.contains,
        child: line,
      );
    }
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: line)));
    await tester.pump();
    return c;
  }

  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(pumpEventQueue);
    await tester.pump();
  }

  Finder choice(String resolution) =>
      find.byKey(ValueKey('swarm-receipt-$resolution'));

  group('the line', () {
    testWidgets('says Couldn\'t confirm delivery with the three choices', (
      tester,
    ) async {
      await show(tester, rig());
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);
      expect(find.text(note), findsOneWidget);
      expect(find.text('Open terminal'), findsOneWidget);
      expect(find.text('Send again'), findsOneWidget);
      expect(find.text('It arrived'), findsOneWidget);
    });

    testWidgets('Not delivered yet still offers nothing', (tester) async {
      await withClock(Clock.fixed(DateTime.now()), () async {
        await show(
          tester,
          rig(
            status: 'queued',
            read: () => {
              'messages': [
                {
                  ...own(status: 'queued'),
                  'createdAt': DateTime.now()
                      .subtract(const Duration(minutes: 5))
                      .toUtc()
                      .toIso8601String(),
                },
              ],
            },
          ),
        );
      });
      expect(find.text('Not delivered yet'), findsOneWidget);
      expect(find.text('Send again'), findsNothing);
      expect(find.text('It arrived'), findsNothing);
      expect(find.text('Open terminal'), findsNothing);
    });

    testWidgets('Open terminal hides where this phone cannot open that '
        'computer, or outside the shell', (tester) async {
      await show(tester, rig(), openable: const {'another-mac'});
      expect(find.text('Open terminal'), findsNothing);
      expect(find.text('Send again'), findsOneWidget);

      await show(tester, rig(), shell: false);
      expect(find.text('Open terminal'), findsNothing);
      expect(find.text('It arrived'), findsOneWidget);
    });

    testWidgets('kept from before and not read again, it says nothing', (
      tester,
    ) async {
      final r = rig();
      late SwarmConversation c;
      await tester.runAsync(() async {
        await r.reader.refresh();
        c = SwarmConversation(r.reader, 'g1');
        await c.load();
      });
      addTearDown(c.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmMessageReceipt(conversation: c, message: c.latestOwn!),
        ),
      );
      expect(reads(r.swarm), 0);
      expect(find.text("Couldn't confirm delivery"), findsNothing);
    });

    testWidgets('a first read that failed and then worked shows the choices', (
      tester,
    ) async {
      var failing = true;
      final r = rig(
        read: () =>
            failing ? throw const SuperTabFailure('SWARM_BUSY', 'Busy') : null,
      );
      final now = DateTime.now();
      var at = now;
      await withClock(Clock(() => at), () async {
        final c = await show(tester, r);
        expect(find.text("Couldn't confirm delivery"), findsNothing);
        failing = false;
        at = now.add(const Duration(seconds: 30));
        await tester.runAsync(() async {
          await r.reader.refresh();
          await pumpEventQueue();
        });
        await tester.pump();
        expect(c.receiptCurrent(c.latestOwn!), isTrue);
      });
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);
      expect(find.text('Send again'), findsOneWidget);
    });
  });

  group('privacy', () {
    testWidgets('an agent not in this chat, as from another project, is '
        'named nowhere', (tester) async {
      // The same name in another project: its delivery here is not drawn.
      final r = rig(
        agentId: 'agent-other',
        load: () => swarm(
          agents: [
            agent('agent-lead', name: 'Lead'),
            agent('agent-other', name: 'Lead'),
          ],
        ),
      );
      await show(tester, r);
      expect(find.text("Couldn't confirm delivery"), findsNothing);
      expect(find.textContaining('Lead'), findsNothing);
    });

    testWidgets('an agent the Swarm does not know is named nowhere', (
      tester,
    ) async {
      await show(tester, rig(agentId: 'agent-gone'));
      expect(find.text("Couldn't confirm delivery"), findsNothing);
    });

    testWidgets('a viewer sees the line with nothing to tap', (tester) async {
      final r = rig(load: () => swarm(role: 'viewer'));
      await show(tester, r);
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);
      await tester.tap(choice('resend'));
      await tester.tap(choice('received'));
      await settle(tester);
      expect(resolves(r.swarm), isEmpty);
    });
  });

  group('each choice', () {
    for (final (label, resolution) in [
      ('Send again', 'resend'),
      ('It arrived', 'received'),
    ]) {
      testWidgets(
        '$label sends ${resolution == 'resend' ? 'it again' : 'that it arrived'}, '
        'then the line follows the read',
        (tester) async {
          var settled = false;
          Map<String, dynamic> now() => own(
            status: settled
                ? (resolution == 'resend' ? 'superseded' : 'confirmed')
                : 'uncertain',
          );
          final r = rig(
            read: () => {
              'messages': [now()],
            },
            command: (_) {
              settled = true;
              return {'result': {}};
            },
          );
          // The chat's own read, asked with it, says the same.
          r.swarm.routes[messages] = (_) => {
            'messages': [now()],
            'next': null,
          };
          final c = await show(tester, r);
          final before = reads(r.swarm);

          await tester.tap(find.text(label));
          await settle(tester);

          final sent = resolves(r.swarm);
          expect(sent, hasLength(1));
          expect(sent.single['command'], {
            'type': 'delivery.resolve',
            'deliveryId': 'd1',
            'resolution': resolution,
          });
          expect(sent.single['operationId'], isA<String>());
          expect(reads(r.swarm), before + 1, reason: 'read back at once');
          expect(c.error, isNull);
          expect(c.resolving, isNull);
          expect(find.text("Couldn't confirm delivery"), findsNothing);
        },
      );
    }

    testWidgets('Open terminal opens the agent\'s terminal and sends nothing', (
      tester,
    ) async {
      final opened = <(String, String)>[];
      final r = rig();
      await show(tester, r, opened: opened);
      await tester.tap(find.text('Open terminal'));
      await settle(tester);
      expect(opened, [('mac-1', 'harness-agent-lead')]);
      expect(resolves(r.swarm), isEmpty);
    });

    testWidgets('while one answer is on its way, nothing else goes', (
      tester,
    ) async {
      final answer = Completer<Object?>();
      final r = rig(command: (_) => answer.future);
      final c = await show(tester, r);

      await tester.tap(find.text('Send again'));
      await tester.pump();
      expect(c.resolving, ('d1', 'resend'));
      await tester.tap(choice('received'));
      await tester.tap(choice('resend'));
      await tester.pump();
      expect(resolves(r.swarm), hasLength(1));

      answer.complete({'result': {}});
      await settle(tester);
      expect(c.resolving, isNull);
    });
  });

  group('failures', () {
    testWidgets('a refusal says why, gives the choices back, and a new tap '
        'is a new answer', (tester) async {
      final r = rig(
        command: (_) => throw const SuperTabFailure(
          'DELIVERY_REVOKED',
          'This instruction is no longer authorized.',
          statusCode: 403,
        ),
      );
      final c = await show(tester, r);
      await tester.tap(find.text('Send again'));
      await settle(tester);

      expect(c.error, 'This instruction is no longer authorized.');
      expect(c.resolving, isNull);
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);

      await tester.tap(find.text('Send again'));
      await settle(tester);
      final sent = resolves(r.swarm);
      expect(sent, hasLength(2));
      expect(
        sent[1]['operationId'],
        isNot(sent[0]['operationId']),
        reason: 'refused: nothing was done',
      );
    });

    testWidgets('a reply lost on the way goes again under the same receipt, '
        'so it is never sent twice', (tester) async {
      var lose = true;
      final r = rig(
        command: (_) {
          if (lose) throw Exception('connection reset');
          return {'result': {}};
        },
      );
      final c = await show(tester, r);
      final before = reads(r.swarm);
      await tester.tap(find.text('Send again'));
      await settle(tester);

      expect(c.error, 'The action is not confirmed. Retry to check it.');
      expect(c.resolving, isNull);
      expect(reads(r.swarm), before, reason: 'nothing known: not read back');
      expect(find.text('Send again'), findsOneWidget);

      lose = false;
      await tester.tap(find.text('Send again'));
      await settle(tester);
      final sent = resolves(r.swarm);
      expect(sent, hasLength(2));
      expect(sent[1]['operationId'], sent[0]['operationId']);
      expect(c.error, isNull);
    });

    testWidgets('a server error is unsure too: the same receipt again', (
      tester,
    ) async {
      var fail = true;
      final r = rig(
        command: (_) {
          if (fail) {
            throw const SuperTabFailure('INTERNAL', 'Busy', statusCode: 503);
          }
          return {'result': {}};
        },
      );
      await show(tester, r);
      await tester.tap(find.text('It arrived'));
      await settle(tester);
      fail = false;
      await tester.tap(find.text('It arrived'));
      await settle(tester);
      final sent = resolves(r.swarm);
      expect(sent[1]['operationId'], sent[0]['operationId']);
    });

    testWidgets('delivered meanwhile: the refusal is said and the line goes', (
      tester,
    ) async {
      var status = 'uncertain';
      final r = rig(
        read: () => {
          'messages': [own(status: status)],
        },
        command: (_) {
          status = 'delivered';
          throw const SuperTabFailure(
            'DELIVERY_RESOLVED',
            'This delivery no longer needs checking.',
            statusCode: 400,
          );
        },
      );
      final c = await show(tester, r);
      await tester.tap(find.text('Send again'));
      await settle(tester);

      expect(c.error, 'This delivery no longer needs checking.');
      expect(c.latestOwn!.receiptDelivery!.status, 'delivered');
      expect(find.text("Couldn't confirm delivery"), findsNothing);
    });

    testWidgets('an older server without the command says so and keeps '
        'the line', (tester) async {
      final r = rig(
        command: (_) => throw const SuperTabFailure(
          'VALIDATION_ERROR',
          'Invalid discriminator value.',
          statusCode: 400,
        ),
      );
      final c = await show(tester, r);
      await tester.tap(find.text('It arrived'));
      await settle(tester);
      expect(c.error, 'Invalid discriminator value.');
      expect(c.resolving, isNull);
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);
      expect(find.text('It arrived'), findsOneWidget);
    });
  });

  group('lifecycle', () {
    testWidgets('access lost while the answer is on its way: the line goes, '
        'and the late answer says nothing', (tester) async {
      final answer = Completer<Object?>();
      final r = rig(command: (_) => answer.future);
      final c = await show(tester, r);
      await tester.tap(find.text('Send again'));
      await tester.pump();

      r.reader.revoke();
      await tester.pump();
      expect(c.messages, isEmpty);
      expect(c.resolving, isNull);
      expect(find.text("Couldn't confirm delivery"), findsNothing);

      answer.completeError(
        const SuperTabFailure('FORBIDDEN', 'Not available', statusCode: 403),
      );
      await settle(tester);
      expect(c.error, isNull);
      expect(c.resolving, isNull);
    });

    testWidgets('the Swarm read anew meanwhile: the late answer is dropped '
        'and the choices come back', (tester) async {
      final answer = Completer<Object?>();
      final r = rig(command: (_) => answer.future);
      final c = await show(tester, r);
      final before = reads(r.swarm);
      await tester.tap(find.text('It arrived'));
      await tester.pump();

      c.reader.generation++;
      answer.completeError(
        const SuperTabFailure(
          'DELIVERY_REVOKED',
          'This instruction is no longer authorized.',
          statusCode: 403,
        ),
      );
      await settle(tester);
      expect(c.error, isNull);
      expect(c.resolving, isNull);
      expect(reads(r.swarm), before, reason: 'nothing read for it');
    });

    testWidgets('the chat closed meanwhile: the answer tells no one', (
      tester,
    ) async {
      final answer = Completer<Object?>();
      final r = rig(command: (_) => answer.future);
      final c = await show(tester, r);
      await tester.tap(find.text('Send again'));
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      answer.complete({'result': {}});
      await settle(tester);
      expect(resolves(r.swarm), hasLength(1));
    });

    test('an answer for a delivery no longer read is not sent', () async {
      final r = rig();
      await r.reader.refresh();
      final c = SwarmConversation(r.reader, 'g1');
      addTearDown(c.dispose);
      await c.load();
      final m = c.latestOwn!;
      expect(
        await c.resolveDelivery(m, m.receiptDelivery!, 'resend'),
        isFalse,
        reason: 'not read since it was kept',
      );
      expect(resolves(r.swarm), isEmpty);
    });
  });

  group('in the chat', () {
    testWidgets('Send again from the chat page goes, and the line goes with '
        'what is read back', (tester) async {
      var settled = false;
      Map<String, dynamic> now() =>
          own(status: settled ? 'superseded' : 'uncertain');
      final fake = rig(
        read: () => {
          'messages': [now()],
        },
        command: (_) {
          settled = true;
          return {'result': {}};
        },
      ).swarm;
      fake.routes[messages] = (_) => {
        'messages': [now()],
        'next': null,
      };
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'OpenHarness', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      final host = SwarmHost(
        accountId: () => me,
        account: ValueNotifier<String?>(me),
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      final opened = <(String, String)>[];
      await tester.pumpWidget(
        MaterialApp(
          builder: (_, child) => PhoneShellScope(
            onMachineLinked: (_) {},
            onOpenAgent: (machineId, agentId) =>
                opened.add((machineId, agentId)),
            canOpenMachine: (machineId) => machineId == 'mac-1',
            child: SwarmScope(notifier: host, child: child!),
          ),
          home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
        ),
      );
      await tester.pumpAndSettle();
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);

      await tester.tap(find.text('Open terminal'));
      expect(opened, [('mac-1', 'harness-agent-lead')]);

      await tester.tap(find.text('Send again'));
      await tester.pumpAndSettle();
      expect(resolves(fake).single['command'], {
        'type': 'delivery.resolve',
        'deliveryId': 'd1',
        'resolution': 'resend',
      });
      expect(find.text("Couldn't confirm delivery"), findsNothing);
      expect(find.byKey(const ValueKey('swarm-post-error')), findsNothing);

      await tester.pumpWidget(const SizedBox());
      host.dispose();
      await tester.pump(const Duration(minutes: 1));
    });
  });
}
