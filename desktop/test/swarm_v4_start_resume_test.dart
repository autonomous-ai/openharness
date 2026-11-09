import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/super_tabs/agent_names.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'keymap_host_test.dart' show MemoryKeymap;
import 'super_tab_new_agent_words_test.dart' show tapNewAgent, unmountSwarm;

/// Two journeys of Swarm v4 a person clicks through end to end in Desktop (readiness rows 1 and 10): starting an agent from
/// Your Team's + with Claude Code and a request, which lands them in its chat; and a stopped agent's Terminal, whose Resume
/// brings its session back.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  /// A Swarm tab as [mountSwarm] mounts it, on a computer whose new folders [prepare] makes.
  Future<SuperTabLaunchFixture> mount(
    WidgetTester tester,
    Future<String> Function(ProjectFolderRequest request) prepare,
  ) async {
    final oldEntry = newHarnessOpensInBox;
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = oldEntry);
    final f = SuperTabLaunchFixture(prepareFolder: prepare);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    final projects = SwarmProjectStore();
    addTearDown(projects.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1500, 900);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.light),
        builder: (context, child) => KeymapProvider(keymap: map, child: child!),
        home: SwarmScreen(notifier: f.app, projectStore: projects),
      ),
    );
    await tester.pumpAndSettle();
    return f;
  }

  List<Map> commands(SuperTabLaunchFixture f) => [
    for (final post in f.connection.server.posts) post['command'] as Map,
  ];

  testWidgets(
    '+ in Your Team, Claude Code, a request and New agent: it starts here as "You are <name>." and its chat opens',
    (tester) async {
      final folders = <ProjectFolderRequest>[];
      final f = await mount(tester, (request) async {
        folders.add(request);
        return '/work/new-agent';
      });
      f.connection.journaled = false;
      await tapNewAgent(tester);
      expect(find.byType(NewHarnessForm), findsOneWidget);
      // The engine, as a person picks it.
      await tester.tap(key('new-harness-field-agent'));
      await tester.pumpAndSettle();
      await tester.tap(key('new-harness-option-claude'));
      await tester.pumpAndSettle();
      await tester.enterText(key('new-harness-task'), 'Tidy the docs.');
      await tester.pump();
      await tester.tap(key('new-harness-field-start'));
      // Its chat opens once the agent has joined it; a running terminal never lets the frames settle.
      for (
        var i = 0;
        i < 200 && f.app.superTabs.peek(tabId)?.selected?.isAgentChat != true;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      final chat = commands(f).singleWhere((c) => c['type'] == 'agent.new');
      final name = chat['name'] as String;
      expect(agentNames, contains(name));
      expect(chat['engine'], 'claude');
      final create = f.connection.calls
          .singleWhere((c) => c.$1 == 'agent_create')
          .$2;
      expect(create['prompt'], 'You are $name.\n\nTidy the docs.');
      // It works in a new folder of its own on this computer.
      expect(folders, hasLength(1));
      // The form is gone and the person is in their chat with it, the agent in Your Team.
      expect(find.byType(NewHarnessForm), findsNothing);
      final c = f.app.superTabs.peek(tabId)!;
      expect(c.selected?.isAgentChat, isTrue);
      expect(key('swarm-agent-header'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-agent-header'),
          matching: find.text(name),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await unmountSwarm(tester, f);
    },
  );

  testWidgets(
    'a stopped agent\'s chat: Terminal shows Resume, and Resume brings its session back',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 860));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture();
      f.connection.nativeSurface = true;
      f.app.machineStates['m']!
        ..terminalCapabilityAvailable = true
        ..localEndpoint = LocalCliEndpoint(
          computerId: 'fixture',
          machineId: 'm',
          wsUri: Uri.parse('ws://fixture.invalid'),
          protocolVersion: 1,
          terminalProtocolVersion: 3,
        );
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      // Pip's session on this computer is stopped: its conversation is saved, its terminal is not running.
      f.connection.native = {
        'id': 'native-lead',
        'name': 'Pip',
        'engine': 'claude',
        'status': 'stopped',
        'sessionId': 'saved-native',
        'terminal': {'available': false},
      };
      f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
      f.connection.server.state['agents'] = [
        {
          'id': 'pip',
          'name': 'Pip',
          'displayName': 'Pip',
          'machineId': 'm',
          'harnessId': 'native-lead',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
          'kind': 'regular',
          'chatId': 'agent-chat-pip',
          'myAgent': true,
        },
      ];
      (f.connection.server.state['conversations'] as List).add({
        'id': 'agent-chat-pip',
        'title': 'Pip',
        'leadId': null,
        'agentIds': ['pip'],
        'archived': false,
        'brief': '',
        'checks': <dynamic>[],
        'assignment': null,
        'lastMessageSequence': 0,
        'kind': 'agent-chat',
      });
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await c.select('agent-chat-pip');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: PaneGrid(notifier: f.app, swarmMode: true),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabView), findsOneWidget);
      expect(key('swarm-agent-header'), findsOneWidget);

      // Its person opens its terminal from the chat's bar.
      await tester.tap(key('swarm-terminal-button'));
      for (var i = 0; i < 40 && find.text('Resume').evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(find.text('Resume'), findsOneWidget);
      // Nothing was started on its own: Resume is the person's.
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_resume'),
        isEmpty,
      );
      await tester.tap(find.text('Resume'));
      for (
        var i = 0;
        i < 60 && f.app.panes.firstOrNull?.session?.streamId == null;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_resume'),
        hasLength(1),
      );
      expect(
        f.app.panes.firstOrNull?.session?.streamId,
        isNotNull,
        reason:
            'panes ${f.app.panes.map((p) => '${p.agentId} ${p.session?.status}')}; calls ${f.connection.calls.map((c) => c.$1).toList()}; agents ${f.app.machineStates['m']!.agents.map((a) => '${a.id} ${a.status}')}',
      );
      expect(find.text('Resume'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      // The app's live terminal and its previews keep timers until the app goes.
      f.dispose();
      await tester.pump(const Duration(seconds: 1));
    },
  );
}
