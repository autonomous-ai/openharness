import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_message_receipt.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';
import 'swarm_new_project_fixture.dart';

/// The line under the person's newest message before any delivery, as
/// Desktop says it (`message_receipt.dart`): "Waiting for the Product
/// Manager" in the PM's own chat while the PM New project asked for starts,
/// "Not sent · this chat has no Lead" in a chat with none. The phone starts
/// no Lead from it: Desktop chooses a channel's PM from its owner's agents.
void main() {
  const commands = '/api/super-tabs/$tab/commands';
  const line = 'Not sent · this chat has no Lead';

  Map<String, dynamic> own(
    String chat, {
    bool delivered = false,
    Map<String, dynamic>? source,
  }) => {
    'id': 'm1',
    'conversationId': chat,
    'text': 'Who picks this up?',
    'sequence': 1,
    'author': {'kind': 'person', 'id': me, 'name': 'tony'},
    if (delivered)
      'deliveries': [
        {'id': 'd1', 'agentId': 'agent-lead', 'status': 'delivered'},
      ],
    'source': ?source,
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
  /// has a Lead only when [lead]. [kind] makes [chat] a Buddy or an agent's
  /// chat; [pmChat] the PM's own chat its project waits in.
  ({FakeSwarm swarm, SwarmReader reader}) rig({
    String chat = leadChat,
    bool lead = false,
    bool delivered = false,
    String? kind,
    String role = 'owner',
    bool pmChat = false,
    Map<String, dynamic>? source,
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) {
      final load = firstLoad(
        head: headData(
          projects: [
            {
              ...swarmProject(project, 'Mobile', repo: harnessRepo),
              // The PM New project asked for is starting, and its 1:1 chat
              // waits for it (backend pmChat.ts).
              if (pmChat) 'pmChat': {'id': chat},
            },
          ],
        ),
        groups: [
          if (chat != leadChat)
            {...groupData(chat, agentIds: const []), 'kind': ?kind},
        ],
        machines: [machine('mac-1', 'Mac Studio')],
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
      'messages': [own(chat, delivered: delivered, source: source)],
      'next': null,
    };
    fake.routes[commands] = (_) => {'result': <String, Object>{}};
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

  List<String> sent(FakeSwarm swarm) => [
    for (final call in swarm.calls)
      if (call.method == 'POST' && call.path == commands)
        (call.body!['command'] as Map)['type'] as String,
  ];

  const waiting = 'Waiting for the Product Manager';

  group('the line', () {
    testWidgets('a project chat with no Lead says so, and starts none', (
      tester,
    ) async {
      final r = rig();
      await show(tester, r);
      expect(find.text(line), findsOneWidget);
      // Desktop chooses a channel's PM from its owner's agents; nothing is
      // started from here.
      expect(find.text('Add a Lead'), findsNothing);
      expect(find.byType(InkWell), findsNothing);
      expect(sent(r.swarm), isEmpty);
    });

    testWidgets("the PM's own chat waits for the PM while it starts", (
      tester,
    ) async {
      await show(
        tester,
        rig(chat: 'pm1', kind: 'agent-chat', pmChat: true),
        chat: 'pm1',
      );
      expect(find.text(waiting), findsOneWidget);
      expect(find.text(line), findsNothing);
    });

    testWidgets('a row the server wrote under the person\'s name says nothing '
        'of waiting', (tester) async {
      await show(
        tester,
        rig(
          chat: 'pm1',
          kind: 'agent-chat',
          pmChat: true,
          source: {'kind': 'lead-start-failed'},
        ),
        chat: 'pm1',
      );
      expect(find.text(waiting), findsNothing);
      expect(find.text(line), findsNothing);
    });

    testWidgets("none in an agent's own chat: its agent takes the message", (
      tester,
    ) async {
      await show(tester, rig(chat: 'a1', kind: 'agent-chat'), chat: 'a1');
      expect(find.text(line), findsNothing);
      expect(find.text(waiting), findsNothing);
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

    testWidgets('a task chat says so', (tester) async {
      await show(tester, rig(chat: 'g1', lead: true), chat: 'g1');
      expect(find.text(line), findsOneWidget);
    });

    testWidgets('a viewer reads it', (tester) async {
      await show(tester, rig(role: 'viewer'));
      expect(find.text(line), findsOneWidget);
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
