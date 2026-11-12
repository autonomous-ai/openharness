import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/swarm_agent_rename.dart';
import 'package:harness_mobile/swarm/swarm_chat_manage.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Rename agent on the phone, as Desktop's agent chat has it (Swarm v4,
/// `view.dart` `_agentTitle` and `_options`): in a person's own chat with
/// their agent, a tap on the agent's name in the header, or ⋮ ▸ Rename,
/// renames the agent for everyone in the Swarm (backend `agent.rename`).
void main() {
  const chat = 'chat-nova';
  const agentId = 'agent-builder';
  late FakeSwarm swarm;
  late SwarmHost host;
  late String name;
  late String role;
  late String contributor;
  var version = 2;

  /// What the next command answers instead of the server, once.
  FutureOr<Object?> Function()? answer;

  /// Nova, the reader's agent unless [contributor] says otherwise, with its
  /// own chat.
  Map<String, dynamic> nova() => {
    ...agent(agentId, displayName: name),
    'contributorId': contributor,
    'chatId': chat,
  };

  /// Nova's own chat with the reader: in no project, read only by its
  /// person (backend agentChats.ts `giveAgentsChats`).
  Map<String, dynamic> novaChat() => {
    ...groupData(
      chat,
      title: 'Chat',
      kind: 'agent-chat',
      agentIds: [agentId],
      audience: [me],
    ),
    'projectId': null,
  };

  Future<void> pump(
    WidgetTester tester, {
    String reader = 'owner',
    String brought = me,
    String conversationId = chat,
  }) async {
    name = 'Nova';
    role = reader;
    contributor = brought;
    version = 2;
    answer = null;
    swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          nova(),
        ],
        groups: [
          groupData('g1', title: 'Fix login', number: 7),
          novaChat(),
        ],
      ),
      'members': [part(me, 1, person(me, role: role))],
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) {
      version++;
      return {
        ...changes(cursor: 'c$version'),
        'members': [part(me, version, person(me, role: role))],
        'agents': [part(agentId, version, nova())],
      };
    };
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    for (final id in [chat, 'g1', leadChat]) {
      swarm.routes['/api/super-tabs/$tab/conversations/$id/messages'] = (_) => {
        'messages': <Object>[],
        'next': null,
      };
    }
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
      final command = body!['command'] as Map<String, dynamic>;
      if (answer case final once?) {
        answer = null;
        return once();
      }
      if (command['type'] == 'agent.rename') {
        name = command['name'] as String;
      }
      return {'ok': true};
    };
    final account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: swarm.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: Scaffold(
          body: SwarmConversationPage(
            swarmId: tab,
            conversationId: conversationId,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  SwarmReader reader() => host.session!.inbox.reader(tab)!;
  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
  }

  /// Opens Rename agent from the agent's name in the header.
  Future<void> tapName(WidgetTester tester) async {
    await tester.tap(key('swarm-title-rename'));
    await tester.pumpAndSettle();
    expect(find.text('Rename agent'), findsOneWidget);
  }

  Future<void> menu(WidgetTester tester) async {
    await tester.tap(key('swarm-chat-menu'));
    await tester.pumpAndSettle();
  }

  List<Map<String, dynamic>> renames() => [
    for (final c in swarm.commands)
      if (c['type'] == 'agent.rename') c,
  ];

  String field(WidgetTester tester) =>
      tester.widget<TextField>(key('swarm-agent-name-field')).controller!.text;

  group('who may', () {
    testWidgets('the agent\'s person renames it from its name, a finger\'s '
        'target that a screen reader names', (tester) async {
      await pump(tester);
      expect(swarmAgentToRename(reader(), chat)?.id, agentId);
      final target = key('swarm-title-rename');
      expect(
        tester.getSize(target).height,
        greaterThanOrEqualTo(minTouchTarget),
      );
      expect(tester.getSemantics(target).hint, 'Rename');
      await tapName(tester);
    });

    testWidgets('a viewer reads the name as text, with no Rename in ⋮', (
      tester,
    ) async {
      await pump(tester, reader: 'viewer');
      expect(swarmAgentToRename(reader(), chat), isNull);
      expect(find.text('Nova'), findsOneWidget);
      expect(key('swarm-title-rename'), findsNothing);
      await menu(tester);
      expect(find.text('Rename'), findsNothing);
    });

    testWidgets('someone else\'s agent is not renamed here', (tester) async {
      await pump(tester, brought: 'person-other');
      expect(swarmAgentToRename(reader(), chat), isNull);
      expect(key('swarm-title-rename'), findsNothing);
    });

    testWidgets('a task\'s chat renames itself, never an agent', (
      tester,
    ) async {
      await pump(tester, conversationId: 'g1');
      expect(swarmAgentToRename(reader(), 'g1'), isNull);
      expect(swarmAgentToRename(reader(), leadChat), isNull);
      expect(key('swarm-title-rename'), findsNothing);
      expect(swarmChatManage(reader(), 'g1'), isNotNull);
    });

    testWidgets('⋮ in an agent\'s own chat renames the agent, with no chat '
        'Rename or Archive (Desktop\'s agent menu)', (tester) async {
      await pump(tester);
      expect(swarmChatManage(reader(), chat), isNull);
      await menu(tester);
      expect(find.text('Rename'), findsOneWidget);
      expect(find.text('Archive'), findsNothing);
      expect(find.text('All new messages'), findsOneWidget);
      await tester.tap(find.text('Rename'));
      await tester.pumpAndSettle();
      expect(find.text('Rename agent'), findsOneWidget);
      expect(field(tester), 'Nova');
    });
  });

  group('rename', () {
    testWidgets('opens on its name, wholly selected; a new name is everyone\'s '
        'at once, in the header', (tester) async {
      await pump(tester);
      await tapName(tester);
      final controller = tester
          .widget<TextField>(key('swarm-agent-name-field'))
          .controller!;
      expect(controller.text, 'Nova');
      expect(controller.selection.start, 0);
      expect(controller.selection.end, 'Nova'.length);

      await tester.enterText(key('swarm-agent-name-field'), '  Atlas ');
      await tester.pump();
      await tester.tap(key('swarm-agent-name-save'));
      await settle(tester);

      expect(renames(), [
        {'type': 'agent.rename', 'agentId': agentId, 'name': 'Atlas'},
      ]);
      expect(find.text('Rename agent'), findsNothing);
      expect(reader().snapshot!.agentName(agentId), 'Atlas');
      expect(tester.widget<Text>(key('swarm-title')).data, 'Atlas');
    });

    testWidgets('⋮ is titled with the agent\'s name now, not the one its '
        'chat was made with', (tester) async {
      await pump(tester);
      await tapName(tester);
      await tester.enterText(key('swarm-agent-name-field'), 'Atlas');
      await tester.pump();
      await tester.tap(key('swarm-agent-name-save'));
      await settle(tester);
      // The backend names an agent's chat once, when it makes it.
      expect(reader().snapshot!.conversation(chat)!.title, 'Chat');

      await menu(tester);
      expect(find.text('Atlas'), findsNWidgets(2));
      expect(find.text('Chat'), findsNothing);
    });

    testWidgets('a refused name says why under the field and stays open', (
      tester,
    ) async {
      await pump(tester);
      await tapName(tester);
      answer = () => throw const SuperTabFailure(
        'AGENT_NAME_TAKEN',
        'River is taken in this Swarm. Choose another.',
        statusCode: 409,
      );
      await tester.enterText(key('swarm-agent-name-field'), 'River');
      await tester.pump();
      await tester.tap(key('swarm-agent-name-save'));
      await settle(tester);

      expect(
        tester.widget<Text>(key('swarm-agent-name-error')).data,
        'River is taken in this Swarm. Choose another.',
      );
      expect(field(tester), 'River');
      expect(reader().snapshot!.agentName(agentId), 'Nova');

      // Typing again clears it.
      await tester.enterText(key('swarm-agent-name-field'), 'Rive');
      await tester.pump();
      expect(key('swarm-agent-name-error'), findsNothing);
    });

    testWidgets('offline: a call lost on the way says so and stays open', (
      tester,
    ) async {
      await pump(tester);
      await tapName(tester);
      answer = () => throw Exception('socket closed');
      await tester.enterText(key('swarm-agent-name-field'), 'Atlas');
      await tester.pump();
      await tester.tap(key('swarm-agent-name-save'));
      await settle(tester);

      expect(
        tester.widget<Text>(key('swarm-agent-name-error')).data,
        'Could not reach this Swarm. Try again.',
      );
      expect(find.text('Rename agent'), findsOneWidget);
    });

    testWidgets('an empty name cannot be saved, and its own name sends '
        'nothing', (tester) async {
      await pump(tester);
      await tapName(tester);
      await tester.enterText(key('swarm-agent-name-field'), '   ');
      await tester.pump();
      await tester.tap(key('swarm-agent-name-save'));
      await settle(tester);
      expect(find.text('Rename agent'), findsOneWidget);

      await tester.enterText(key('swarm-agent-name-field'), ' Nova ');
      await tester.pump();
      await tester.tap(key('swarm-agent-name-save'));
      await settle(tester);
      expect(find.text('Rename agent'), findsNothing);
      expect(renames(), isEmpty);
    });

    testWidgets('Cancel leaves the name as it was', (tester) async {
      await pump(tester);
      await tapName(tester);
      await tester.enterText(key('swarm-agent-name-field'), 'Atlas');
      await tester.tap(key('swarm-agent-name-cancel'));
      await settle(tester);
      expect(find.text('Rename agent'), findsNothing);
      expect(renames(), isEmpty);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Nova');
    });

    testWidgets('the dialog goes once the reader may no longer rename', (
      tester,
    ) async {
      await pump(tester);
      await tapName(tester);
      role = 'viewer';
      await reader().refresh();
      await settle(tester);
      expect(find.text('Rename agent'), findsNothing);
      expect(key('swarm-title-rename'), findsNothing);
    });
  });
}
