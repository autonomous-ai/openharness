import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_message_receipt.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';
import 'swarm_new_project_fixture.dart';

/// "Not sent · this chat has no Lead" under the person's newest message, as
/// Desktop says it (`message_receipt.dart`), and Add a Lead where the phone can
/// start one: a project chat, through `lead.start` as a new project does
/// (Tony's mobile list, task 29).
void main() {
  const commands = '/api/super-tabs/$tab/commands';
  const line = 'Not sent · this chat has no Lead';

  Map<String, dynamic> own(String chat, {bool delivered = false}) => {
    'id': 'm1',
    'conversationId': chat,
    'text': 'Who picks this up?',
    'sequence': 1,
    'author': {'kind': 'person', 'id': me, 'name': 'tony'},
    if (delivered)
      'deliveries': [
        {'id': 'd1', 'agentId': 'agent-lead', 'status': 'delivered'},
      ],
    'createdAt': DateTime.now().toUtc().toIso8601String(),
  };

  Map<String, dynamic> machine(String id, String name, {bool online = true}) {
    final m = leadPool(id, name: name);
    (m['observation'] as Map)['receivedAt'] = DateTime.now()
        .subtract(Duration(minutes: online ? 0 : 30))
        .millisecondsSinceEpoch;
    return m;
  }

  /// A Swarm whose chat [chat] holds the person's message; the project chat
  /// has a Lead only when [lead]. [kind] makes [chat] a Buddy chat.
  ({FakeSwarm swarm, SwarmReader reader}) rig({
    String chat = leadChat,
    bool lead = false,
    bool delivered = false,
    String? kind,
    String role = 'owner',
    bool machines = true,
    bool waiting = false,
    FutureOr<Object?> Function(Map<String, dynamic>? body)? command,
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) {
      final load = firstLoad(
        head: headData(
          projects: [
            {
              ...swarmProject(project, 'Mobile', repo: harnessRepo),
              // The server keeps the message for the project's Lead: a
              // Personal Swarm's chat with none (backend leadStart.ts).
              if (waiting)
                'leadWaiting': [
                  {'id': 'm1', 'at': 1},
                ],
            },
          ],
        ),
        groups: [
          if (chat != leadChat)
            {...groupData(chat, agentIds: const []), 'kind': ?kind},
        ],
        machines: [
          if (machines) ...[
            machine('mac-1', 'Mac Studio'),
            machine('mac-2', 'MacBook Pro', online: false),
          ],
        ],
      );
      (load['groups'] as List).first['data'] = groupData(
        leadChat,
        title: 'Mobile',
        agentIds: lead ? const ['agent-lead'] : const [],
        leadId: lead ? 'agent-lead' : null,
        lastMessageSequence: chat == leadChat ? 1 : 0,
      );
      load['members'] = [part(me, 1, person(me, role: role))];
      return load;
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (_) => {
      'messages': [own(chat, delivered: delivered)],
      'next': null,
    };
    fake.routes[commands] = command ?? (_) => {'result': <String, Object>{}};
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: fake.request,
    );
    addTearDown(reader.dispose);
    return (swarm: fake, reader: reader);
  }

  Future<SwarmConversation> show(
    WidgetTester tester,
    ({FakeSwarm swarm, SwarmReader reader}) r, {
    String chat = leadChat,
  }) async {
    late SwarmConversation c;
    await tester.runAsync(() async {
      await r.reader.refresh();
      c = SwarmConversation(r.reader, chat);
      await c.load();
    });
    addTearDown(() {
      try {
        c.dispose();
      } on FlutterError catch (_) {}
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: c,
            builder: (_, _) => switch (c.latestOwn) {
              final m? => SwarmMessageReceipt(conversation: c, message: m),
              null => const SizedBox.shrink(),
            },
          ),
        ),
      ),
    );
    await tester.pump();
    return c;
  }

  List<Map<String, dynamic>> starts(FakeSwarm swarm) => [
    for (final call in swarm.calls)
      if (call.method == 'POST' &&
          call.path == commands &&
          (call.body!['command'] as Map)['type'] == 'lead.start')
        call.body!,
  ];

  Finder addLead() => find.byKey(const ValueKey('swarm-receipt-add-lead'));

  group('the line', () {
    testWidgets('a project chat with no Lead says so, with Add a Lead', (
      tester,
    ) async {
      await show(tester, rig());
      expect(find.text(line), findsOneWidget);
      expect(find.text('Add a Lead'), findsOneWidget);
    });

    // River, 11-04 (task #2633): in a Personal Swarm the server keeps the
    // message for the Lead the person's computer starts, so it is not "Not
    // sent"; the phone starts none itself.
    testWidgets('a message the server keeps for the Lead waits for one', (
      tester,
    ) async {
      await show(tester, rig(waiting: true));
      expect(
        find.text(
          'Waiting for a Lead · open Harness on your computer to start one',
        ),
        findsOneWidget,
      );
      expect(find.text(line), findsNothing);
      expect(find.text('Add a Lead'), findsNothing);
    });

    testWidgets('none where the chat has its Lead', (tester) async {
      await show(tester, rig(lead: true));
      expect(find.text(line), findsNothing);
    });

    testWidgets('none for a message that went to someone', (tester) async {
      await show(tester, rig(delivered: true));
      expect(find.text(line), findsNothing);
    });

    testWidgets('none in a Buddy chat: its Buddy takes the message', (
      tester,
    ) async {
      await show(
        tester,
        rig(chat: 'b1', kind: 'buddy'),
        chat: 'b1',
      );
      expect(find.text(line), findsNothing);
    });

    testWidgets('a task chat says so, with nothing the phone cannot do', (
      tester,
    ) async {
      await show(tester, rig(chat: 'g1', lead: true), chat: 'g1');
      expect(find.text(line), findsOneWidget);
      expect(addLead(), findsNothing);
    });

    testWidgets('a viewer reads it, and cannot add one', (tester) async {
      final r = rig(role: 'viewer');
      await show(tester, r);
      expect(find.text(line), findsOneWidget);
      await tester.tap(addLead(), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(find.text('Mac Studio'), findsNothing);
      expect(starts(r.swarm), isEmpty);
    });
  });

  group('Add a Lead', () {
    testWidgets('lists the machines, and one starts the Lead there', (
      tester,
    ) async {
      final r = rig();
      await show(tester, r);
      await tester.tap(addLead());
      await tester.pumpAndSettle();
      expect(find.text('Mac Studio'), findsOneWidget);
      expect(find.text('MacBook Pro'), findsOneWidget);
      // Offline: listed, and not picked; the sheet stays.
      await tester.tap(find.text('MacBook Pro'));
      await tester.pumpAndSettle();
      expect(starts(r.swarm), isEmpty);
      await tester.tap(find.text('Mac Studio'));
      await tester.runAsync(pumpEventQueue);
      await tester.pumpAndSettle();
      final command = starts(r.swarm).single['command'] as Map;
      expect(command, {
        'type': 'lead.start',
        'projectId': project,
        'machineId': 'mac-1',
        'engine': 'claude',
        'repositoryUrl': harnessRepo,
      });
    });

    Future<void> pick(WidgetTester tester) async {
      await tester.tap(addLead());
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mac Studio'));
      await tester.runAsync(pumpEventQueue);
      await tester.pumpAndSettle();
    }

    List<String> receipts(FakeSwarm swarm) => [
      for (final start in starts(swarm)) start['operationId'] as String,
    ];

    testWidgets('a lost answer, tried again, is the same start', (
      tester,
    ) async {
      var lost = true;
      final r = rig(
        command: (_) => lost
            ? throw const SuperTabFailure(
                'MACHINE_UNAVAILABLE',
                'No computer answered.',
                statusCode: 503,
              )
            : {'result': <String, Object>{}},
      );
      await show(tester, r);
      await pick(tester);
      expect(find.text('No computer answered.'), findsOneWidget);
      lost = false;
      await pick(tester);
      final [first, again] = receipts(r.swarm);
      expect(again, first);
      expect(find.text('No computer answered.'), findsNothing);
    });

    testWidgets('after a refusal, the next try is a new start', (tester) async {
      final r = rig(
        command: (_) => throw const SuperTabFailure(
          'MACHINE_BUSY',
          'Mac Studio has no room for another agent.',
          statusCode: 409,
        ),
      );
      await show(tester, r);
      await pick(tester);
      await pick(tester);
      final [first, again] = receipts(r.swarm);
      expect(again, isNot(first));
    });

    testWidgets('with no machine, it says so and opens no empty sheet', (
      tester,
    ) async {
      final r = rig(machines: false);
      await show(tester, r);
      await tester.tap(addLead());
      await tester.pumpAndSettle();
      expect(
        find.text(
          'No machine in this Swarm can run a Lead. Add one on Desktop.',
        ),
        findsOneWidget,
      );
      expect(find.text('Machine'), findsNothing);
      expect(starts(r.swarm), isEmpty);
    });

    testWidgets('a refusal says why, in its own words', (tester) async {
      final r = rig(
        command: (_) => throw const SuperTabFailure(
          'LEAD_STARTING',
          "This project's Product Manager is already starting.",
          statusCode: 409,
        ),
      );
      await show(tester, r);
      await tester.tap(addLead());
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mac Studio'));
      await tester.runAsync(pumpEventQueue);
      await tester.pumpAndSettle();
      expect(
        find.text("This project's Product Manager is already starting."),
        findsOneWidget,
      );
    });
  });

  testWidgets('the chat page draws it under the newest own message', (
    tester,
  ) async {
    final r = rig();
    r.swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    r.swarm.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: r.swarm.request,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.runAsync(() => host.session!.inbox.refresh());
    await tester.pumpWidget(
      MaterialApp(
        builder: (_, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(
          swarmId: tab,
          conversationId: leadChat,
        ),
      ),
    );
    for (var i = 0; i < 5; i++) {
      await tester.runAsync(pumpEventQueue);
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text(line), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });
}
