import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The person's own Buddy chat on the phone (#2090; Desktop's Buddy chat,
/// `buddies.dart`): named after their Buddy, with what it runs on under the
/// header, the PM's private lines read as "River (PM) → you", every question
/// the PM asked them in the project, Start your Buddy while none runs, and
/// Remove Buddy in its ⋮.
void main() {
  const chat = 'buddy-me';
  const messages = '/api/super-tabs/$tab/conversations/$chat/messages';
  const commands = '/api/super-tabs/$tab/commands';
  const offline = '2026-10-29T01:00:00.000Z';

  Map<String, dynamic> message(
    String id,
    int sequence, {
    required String author,
    String text = 'hello',
    int minute = 0,
  }) => {
    'id': id,
    'conversationId': chat,
    'text': text,
    'sequence': sequence,
    'author': author == me
        ? {'kind': 'person', 'id': me, 'name': 'tony'}
        : {
            'kind': 'agent',
            'id': author,
            'name': author == 'agent-lead' ? 'River' : 'Wren',
          },
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 10, 29, 1, minute).toIso8601String(),
  };

  /// A question River asked the person in work chat g1 of the project.
  Map<String, dynamic> decision(String id, {int minute = 0}) => {
    'id': id,
    'projectId': project,
    'projectName': 'Mobile',
    'conversationId': 'g1',
    'conversationTitle': 'Fix login',
    'askerName': 'River',
    'question': 'Ship #2090 tonight?',
    'options': ['Yes', 'Tomorrow'],
    'recommended': 0,
    'createdAt': DateTime.utc(2026, 10, 29, 1, minute).toIso8601String(),
  };

  Map<String, dynamic> machine(String id, String name, {String owner = me}) => {
    'machineId': id,
    'name': name,
    'contributorId': owner,
    'engines': ['claude', 'codex'],
  };

  Map<String, dynamic> wren({String? downSince}) => {
    ...buddyData('agent-wren', displayName: 'Wren'),
    'downSince': ?downSince,
  };

  /// One Swarm where the person has their Buddy chat in Mobile, reading
  /// [page]; [buddy] runs in it, or none. [after] is what the Swarm reads
  /// next, as a start or a removal changes it.
  FakeSwarm backend({
    List<Map<String, dynamic>> page = const [],
    Map<String, dynamic>? buddy,
    List<Map<String, dynamic>> machines = const [],
    List<Map<String, dynamic>> starts = const [],
    List<Map<String, dynamic>> decisions = const [],
    String role = 'owner',
  }) {
    final derived = {'decisionsWaiting': decisions.length};
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
          groupData('g1', title: 'Fix login', number: 7),
          buddyChatData(
            chat,
            agentIds: [if (buddy != null) 'agent-wren'],
            lastMessageSequence: page.length,
          ),
        ],
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          ?buddy,
        ],
        machines: machines,
        starts: starts,
        derived: derived,
      ),
      'members': [part(me, 1, person(me, role: role))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': decisions,
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': page.reversed.toList(),
      'next': null,
    };
    fake.routes[commands] = (_) => {'result': <String, dynamic>{}};
    return fake;
  }

  Future<void> pump(WidgetTester tester, FakeSwarm fake) async {
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
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(swarmId: tab, conversationId: chat),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  String hint(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).decoration!.hintText!;

  /// The Swarm's next read has [starts], as the backend keeps them once a
  /// start was asked for.
  void startsNext(FakeSwarm fake, List<Map<String, dynamic>> starts) =>
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3'),
        'starts': [for (final s in starts) part(s['id'] as String, 2, s)],
      };

  group('with its Buddy running', () {
    testWidgets('is named after the Buddy, under its project, and says what '
        'it runs on and that only the person reads it', (tester) async {
      await pump(
        tester,
        backend(
          buddy: wren(),
          machines: [machine('mac-1', 'Tonys-MacBook-Pro.local')],
        ),
      );

      expect(
        tester.widget<Text>(key('swarm-title')).data,
        'Wren',
        reason: 'never Chat with PM (#2090)',
      );
      expect(find.text('#Mobile'), findsOneWidget);
      expect(
        tester.widget<Text>(key('swarm-buddy-where')).data,
        'Claude on Tonys-MacBook-Pro · only you can read this chat',
      );
      expect(hint(tester), 'Message Wren');
      expect(key('swarm-buddy-start'), findsNothing);
    });

    testWidgets("a Buddy on someone else's machine says they can see its "
        'terminal', (tester) async {
      await pump(
        tester,
        backend(
          buddy: {...wren(), 'machineOwnerId': 'person-dee'},
          machines: [machine('mac-1', 'Dee Studio', owner: 'person-dee')],
        ),
      );

      expect(
        tester.widget<Text>(key('swarm-buddy-where')).data,
        'Claude on Dee Studio · its owner can see its terminal',
        reason: 'a person the Swarm does not list goes unnamed',
      );
    });

    testWidgets("the PM's private lines read as lines to the person, with no "
        'role beside them; the Buddy keeps its name', (tester) async {
      await pump(
        tester,
        backend(
          buddy: wren(),
          page: [
            message(
              'm1',
              1,
              author: 'agent-lead',
              text: 'The Desktop build is ready',
            ),
            message('m2', 2, author: 'agent-wren', minute: 1),
          ],
        ),
      );

      final pm = key('swarm-message-m1');
      expect(
        find.descendant(of: pm, matching: find.text('River (PM) → you')),
        findsOneWidget,
      );
      expect(find.descendant(of: pm, matching: find.text('PM')), findsNothing);
      expect(
        find.descendant(
          of: key('swarm-message-m2'),
          matching: find.text('Wren'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('the Buddy wears no role beside its name: a Buddy is no Dev, '
        'as on Desktop', (tester) async {
      await pump(
        tester,
        backend(
          buddy: wren(),
          page: [message('m1', 1, author: 'agent-wren')],
        ),
      );

      final line = key('swarm-message-m1');
      expect(
        find.descendant(of: line, matching: find.text('Wren')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: line, matching: find.text('Dev')),
        findsNothing,
      );
      expect(find.byType(SwarmRoleBadge), findsNothing);
    });

    testWidgets("the PM's line is answered in the project chat, with the PM "
        'mentioned, where everyone reads it', (tester) async {
      final fake = backend(
        buddy: wren(),
        page: [
          message('m1', 1, author: 'agent-lead', text: 'Which flag name?'),
          message('m2', 2, author: 'agent-wren', minute: 1),
        ],
      );
      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] = (
        _,
      ) => {'messages': <Object>[], 'next': null};
      await pump(tester, fake);

      expect(key('swarm-answer-in-m2'), findsNothing, reason: 'the Buddy');
      expect(
        find.descendant(
          of: key('swarm-answer-in-m1'),
          matching: find.text('Answer in #Mobile'),
        ),
        findsOneWidget,
      );
      expect(find.text('Everyone there reads it'), findsOneWidget);

      await tester.tap(find.text('Answer in #Mobile'));
      await tester.pumpAndSettle();

      expect(
        key('swarm-project-chat-$leadChat'),
        findsOneWidget,
        reason: 'the project chat',
      );
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '@River ',
      );
      await tester.enterText(find.byType(TextField), '@River Use swarm_buddy');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();
      final post = fake.commands.single;
      expect(post['conversationId'], leadChat);
      expect(post['recipientIds'], ['agent-lead']);
    });

    testWidgets('every open question the PM asked the person in the project '
        'shows here and is answered in place', (tester) async {
      final fake = backend(
        buddy: wren(),
        page: [message('m1', 1, author: 'agent-wren')],
        decisions: [decision('d1', minute: 2)],
      );
      await pump(tester, fake);

      expect(key('swarm-ask-d1'), findsOneWidget);
      expect(find.text('Ship #2090 tonight?'), findsOneWidget);

      await tester.tap(key('swarm-option-d1-1'));
      await tester.pump();
      expect(find.text('Sending “Tomorrow”'), findsOneWidget);
      await tester.pump(const Duration(seconds: 10));
      await tester.pumpAndSettle();
    });

    testWidgets('offline, it says so, the chat stays, and Start again starts '
        'it on the same machine and agent', (tester) async {
      final fake = backend(
        buddy: wren(downSince: offline),
        machines: [machine('mac-1', 'Tonys-MacBook-Pro')],
      );
      await pump(tester, fake);

      expect(find.text('Wren is offline. Your chat stays.'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-buddy-start-again'),
          matching: find.text('Start again'),
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-buddy-start-again'));
      await tester.pumpAndSettle();

      expect(fake.commands, [
        {
          'type': 'buddy.create',
          'projectId': project,
          'machineId': 'mac-1',
          'engine': 'claude',
        },
      ]);
    });

    testWidgets('an offline Codex Buddy starts again with Claude Code, since '
        'the server refuses a Codex Buddy for now', (tester) async {
      final fake = backend(
        buddy: {
          ...wren(downSince: offline),
          'configuration': {'engine': 'codex'},
        },
        machines: [machine('mac-1', 'Tonys-MacBook-Pro')],
      );
      await pump(tester, fake);

      expect(
        find.descendant(
          of: key('swarm-buddy-start-again'),
          matching: find.text('Start with Claude Code'),
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-buddy-start-again'));
      await tester.pumpAndSettle();

      expect(fake.commands, [
        {
          'type': 'buddy.create',
          'projectId': project,
          'machineId': 'mac-1',
          'engine': 'claude',
        },
      ]);
    });

    testWidgets('⋮ Remove Buddy asks first; Cancel removes nothing, Remove '
        'stops it', (tester) async {
      final fake = backend(buddy: wren());
      await pump(tester, fake);

      await tester.tap(key('swarm-buddy-menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Remove Buddy'));
      await tester.pumpAndSettle();
      expect(find.text('Remove Buddy?'), findsOneWidget);
      expect(
        find.text(
          'Its session stops. Your chat stays, and adding a Buddy here '
          'again picks it up.',
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-buddy-remove-cancel'));
      await tester.pumpAndSettle();
      expect(fake.commands, isEmpty);

      await tester.tap(key('swarm-buddy-menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Remove Buddy'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-buddy-remove-confirm'));
      await tester.pumpAndSettle();

      expect(fake.commands, [
        {'type': 'buddy.remove', 'projectId': project},
      ]);
    });

    testWidgets('a removal refused says why under the header', (tester) async {
      final fake = backend(buddy: wren());
      fake.routes[commands] = (_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'Only its person removes a Buddy.',
        statusCode: 403,
      );
      await pump(tester, fake);

      await tester.tap(key('swarm-buddy-menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Remove Buddy'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-buddy-remove-confirm'));
      await tester.pumpAndSettle();

      expect(
        tester.widget<Text>(key('swarm-buddy-error')).data,
        'Only its person removes a Buddy.',
      );
    });
  });

  group('with no Buddy', () {
    testWidgets('reads Buddy, and Start starts one on the first of the '
        "person's own machines with the agent picked, then says it is "
        'starting', (tester) async {
      final fake = backend(
        machines: [
          machine('mac-2', 'Dee Studio', owner: 'person-dee'),
          machine('mac-1', 'Tonys-MacBook-Pro.local'),
        ],
      );
      await pump(tester, fake);

      expect(tester.widget<Text>(key('swarm-title')).data, 'Buddy');
      expect(hint(tester), 'Message');
      expect(find.text('Start your Buddy to brainstorm here'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-buddy-machine'),
          matching: find.text('Tonys-MacBook-Pro'),
        ),
        findsOneWidget,
      );
      expect(key('swarm-buddy-menu'), findsNothing, reason: 'none to remove');

      startsNext(fake, [
        buddyStartData('s1', chatId: chat, machineId: 'mac-1'),
      ]);
      await tester.tap(key('swarm-buddy-start-button'));
      await tester.pumpAndSettle();

      expect(fake.commands, [
        {
          'type': 'buddy.create',
          'projectId': project,
          'machineId': 'mac-1',
          'engine': 'claude',
        },
      ]);
      expect(
        tester.widget<Text>(key('swarm-buddy-starting')).data,
        'Starting Claude on Tonys-MacBook-Pro…',
      );
      expect(key('swarm-buddy-start'), findsNothing);
    });

    testWidgets('the machine is picked from a sheet of the person\'s own', (
      tester,
    ) async {
      final fake = backend(
        machines: [
          machine('mac-1', 'Tonys-MacBook-Pro'),
          machine('mac-4', 'Mac Studio'),
        ],
      );
      await pump(tester, fake);

      await tester.tap(key('swarm-buddy-machine'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mac Studio'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-buddy-start-button'));
      await tester.pumpAndSettle();

      expect(fake.commands, [
        {
          'type': 'buddy.create',
          'projectId': project,
          'machineId': 'mac-4',
          'engine': 'claude',
        },
      ]);
    });

    testWidgets('with no machine of the person\'s own, it says to add one and '
        'offers no Start', (tester) async {
      await pump(
        tester,
        backend(
          machines: [machine('mac-2', 'Dee Studio', owner: 'person-dee')],
        ),
      );

      expect(key('swarm-buddy-no-machine'), findsOneWidget);
      expect(key('swarm-buddy-start-button'), findsNothing);
    });

    testWidgets('Codex is offered turned off, with the reason the server '
        'refuses it beside it, as on Desktop; Claude stays picked', (
      tester,
    ) async {
      final fake = backend(machines: [machine('mac-1', 'Tonys-MacBook-Pro')]);
      await pump(tester, fake);

      expect(
        find.text(
          'A Codex Buddy is not available yet: Codex would run some commands '
          'outside its sandbox without asking. Choose Claude Code.',
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-buddy-engine-codex'));
      await tester.pump();
      await tester.tap(key('swarm-buddy-start-button'));
      await tester.pumpAndSettle();

      expect(fake.commands.single['engine'], 'claude');
    });

    testWidgets('a start that failed says why, and Start again asks with the '
        'same machine and agent', (tester) async {
      final fake = backend(
        machines: [machine('mac-1', 'Tonys-MacBook-Pro')],
        starts: [
          buddyStartData(
            's1',
            chatId: chat,
            error: 'Claude Code is not signed in on Tonys-MacBook-Pro.',
          ),
        ],
      );
      await pump(tester, fake);

      expect(
        find.text(
          "Couldn't start: Claude Code is not signed in on Tonys-MacBook-Pro.",
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-buddy-start-again'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {
        'type': 'buddy.create',
        'projectId': project,
        'machineId': 'mac-1',
        'engine': 'claude',
      });
    });

    testWidgets('a Codex start that failed is asked again with Claude Code', (
      tester,
    ) async {
      final fake = backend(
        machines: [machine('mac-1', 'Tonys-MacBook-Pro')],
        starts: [
          buddyStartData(
            's1',
            chatId: chat,
            engine: 'codex',
            error: 'Codex is not signed in on Tonys-MacBook-Pro.',
          ),
        ],
      );
      await pump(tester, fake);

      expect(
        find.descendant(
          of: key('swarm-buddy-start-again'),
          matching: find.text('Start with Claude Code'),
        ),
        findsOneWidget,
      );
      await tester.tap(key('swarm-buddy-start-again'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {
        'type': 'buddy.create',
        'projectId': project,
        'machineId': 'mac-1',
        'engine': 'claude',
      });
    });

    testWidgets('a refused start says why under the bar', (tester) async {
      final fake = backend(machines: [machine('mac-1', 'Tonys-MacBook-Pro')]);
      fake.routes[commands] = (_) => throw const SuperTabFailure(
        'MACHINE_OFFLINE',
        'Tonys-MacBook-Pro is offline.',
        statusCode: 409,
      );
      await pump(tester, fake);

      await tester.tap(key('swarm-buddy-start-button'));
      await tester.pumpAndSettle();

      expect(
        tester.widget<Text>(key('swarm-buddy-error')).data,
        'Tonys-MacBook-Pro is offline.',
      );
      expect(key('swarm-buddy-start'), findsOneWidget);
    });
  });

  testWidgets('a viewer reads the chat, but starts and removes no Buddy', (
    tester,
  ) async {
    await pump(
      tester,
      backend(
        role: 'viewer',
        machines: [machine('mac-1', 'Tonys-MacBook-Pro')],
      ),
    );
    expect(key('swarm-buddy-start'), findsNothing);
    expect(key('swarm-buddy-bar'), findsNothing);

    await pump(
      tester,
      backend(
        role: 'viewer',
        buddy: wren(downSince: offline),
        machines: [machine('mac-1', 'Tonys-MacBook-Pro')],
      ),
    );
    expect(find.text('Wren is offline. Your chat stays.'), findsOneWidget);
    expect(key('swarm-buddy-start-again'), findsNothing);
    expect(key('swarm-buddy-menu'), findsNothing);

    await pump(
      tester,
      backend(
        role: 'viewer',
        buddy: wren(),
        page: [message('m1', 1, author: 'agent-lead')],
      ),
    );
    expect(find.text('River (PM) → you'), findsOneWidget);
    expect(key('swarm-answer-in-m1'), findsNothing, reason: 'posts nothing');
  });
}
