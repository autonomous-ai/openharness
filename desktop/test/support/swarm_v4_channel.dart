import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart' show AppNotifier;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/instructions_link.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/voice_recorder.dart';

import '../swarm_state_test.dart' show createApp;
import 'super_tab_fixture.dart';

/// Swarm v4's agent-to-agent room: the project "lampos" of three agents, Faye its PM and the builders Pip and Juno, whose
/// channel only agents post in. Juno is on a computer that is off. Its channel is `channel`, not the default `lead`, so what a
/// first open lands on is the project's own. Each agent has its 1:1 chat with its person, `agent-chat-<id>`. A smaller world
/// than `swarmV4Server`'s replay of lampOS: every line in it is known, so a test can say what a person sees of each.
ConversationServer swarmV4Channel({String pip = 'Pip', String juno = 'Juno'}) {
  final server = ConversationServer()..threads = true;
  final groups = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>();
  groups
    ..clear()
    ..add({
      ...conversationFixture('channel', 'lampos'),
      'projectId': 'lampos',
      'leadId': 'faye',
    });
  server.state['projects'] = [
    {
      ...projectFixture('lampos', 'lampos', 'channel'),
      'repository': {
        'repositoryUrl': 'https://github.com/autonomous-ai/lampOS',
      },
    },
  ];
  Map<String, dynamic> agent(
    String id,
    String name,
    String kind, {
    String machine = 'host',
    bool down = false,
  }) => {
    'id': id,
    'projectId': 'lampos',
    'name': name,
    'displayName': name,
    'machineId': machine,
    'harnessId': 'session-$id',
    'contributorId': 'owner',
    'configuration': {'engine': 'claude'},
    'kind': kind,
    'chatId': 'agent-chat-$id',
    'myAgent': true,
    if (down) 'downSince': '2026-11-09T01:00:00Z',
  };
  server.state['agents'] = [
    agent('faye', 'Faye', 'pm'),
    agent('pip', pip, 'regular'),
    agent('juno', juno, 'regular', machine: 'laptop', down: true),
  ];
  for (final (id, name) in [('faye', 'Faye'), ('pip', pip), ('juno', juno)]) {
    groups.add({
      ...conversationFixture('agent-chat-$id', name),
      'kind': 'agent-chat',
      'agentIds': [id],
    });
  }
  return server;
}

/// One post by the agent named [who] in [chat], as `swarm post` writes it; in a task's thread with [thread]. Returns its id.
String swarmV4Post(
  ConversationServer server,
  String who,
  String text, {
  String chat = 'channel',
  String? thread,
}) {
  // An agent's line, which moves no person's read mark (the backend's channel has only agents' lines).
  server.append(text, conversationId: chat, agent: true);
  final message = server.messages.last;
  message['author'] = {'kind': 'agent', 'id': who.toLowerCase(), 'name': who};
  if (thread != null) {
    message['thread'] = thread;
    message['replyTo'] = thread;
  }
  return message['id'] as String;
}

/// What the agents of [swarmV4Channel] say in the channel on a quiet morning.
void swarmV4Talk(ConversationServer server) {
  swarmV4Post(
    server,
    'Faye',
    'Plan for today: #12 the voice in a busy room, #14 the memory page. @Pip takes #12, @Juno #14.',
  );
  swarmV4Post(server, 'Pip', 'free: Pip');
  swarmV4Post(server, 'Pip', '@Juno can you read #12?');
  swarmV4Post(server, 'Juno', 'Reading #12 now. Back in ten minutes.');
}

/// Opens [server]'s Swarm as its person does, in a window of [size]. With [saved] the Swarm was left on that chat, as a person
/// who comes back finds it; without, it is the first open. Two computers are known: Mac Studio, up, and Juno's laptop, off.
/// [github] answers the project's issues, as `gh` does, and [instructions] an agent's file, as its computer does; [machines]
/// are the computers the app knows; [onNewAgent] and [onNewProject] are what the two + buttons do. [app] is the app model the
/// view is given when the test needs to tell it things (the app goes to the background); without it, a fresh one.
/// [onOpenGroupTerminals] is what the chat bar's Terminal does where the workspace would show the chat's terminals.
Future<SuperTabController> openSwarmV4(
  WidgetTester tester,
  ConversationServer server, {
  String? saved,
  Size size = const Size(1440, 860),
  Brightness brightness = Brightness.light,
  SwarmGitHub? github,
  SwarmInstructionsLink? instructions,
  List<Machine>? machines,
  VoidCallback? onNewAgent,
  VoidCallback? onNewProject,
  AppNotifier? app,
  void Function(SuperTabController c)? onOpenGroupTerminals,
  SuperTabVoiceRecorder Function()? voiceRecorder,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  final c = server.controller(
    account: 'owner',
    initial: saved == null
        ? null
        : {'tabId': 'tab', 'accountId': 'owner', 'selectedId': saved},
  );
  addTearDown(c.dispose);
  final shown = app ?? createApp();
  addTearDown(shown.dispose);
  shown.machines =
      machines ??
      const [
        Machine(
          machineId: 'host',
          authMode: MachineAuthMode.managed,
          name: 'Mac Studio',
          status: 'online',
        ),
        Machine(
          machineId: 'laptop',
          authMode: MachineAuthMode.managed,
          name: 'Juno\'s laptop',
          status: 'offline',
        ),
      ];
  await tester.runAsync(c.refresh);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          app: shown,
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          onNewAgent: onNewAgent ?? () {},
          onNewProject: onNewProject ?? () {},
          onOpenGroupTerminals: onOpenGroupTerminals == null
              ? null
              : () => onOpenGroupTerminals(c),
          machineName: (id) =>
              shown.machines.firstWhere((m) => m.machineId == id).displayName,
          github: github,
          instructions: instructions,
          voiceRecorder: voiceRecorder,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}
