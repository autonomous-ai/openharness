import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/super_tabs/agent_names.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'super_tab_new_agent_words_test.dart'
    show mountSwarm, tapNewAgent, unmountSwarm;

/// Two journeys of Swarm v4 a person clicks through in Desktop (readiness rows 1 and 10): starting an agent from Your Team's +
/// with Claude Code and a request, which goes on while they work and is a row they open into its chat (anh Dee, 2026-11-10:
/// "when it's done i can go in and use it"); and a stopped agent, opened from Your Team, whose Terminal shows Resume and
/// brings its session back.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  List<Map> commands(SuperTabLaunchFixture f) => [
    for (final post in f.connection.server.posts)
      if (post['command'] case final Map command) command,
  ];

  /// Pumps frames until [done], at most [limit]: a running terminal never lets the frames settle.
  Future<void> until(
    WidgetTester tester,
    bool Function() done, {
    int limit = 200,
  }) async {
    for (var i = 0; i < limit && !done(); i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  /// Ends a test whose app has a live terminal: its timers go with the app.
  Future<void> end(WidgetTester tester, SuperTabLaunchFixture f) async {
    await unmountSwarm(tester, f);
    f.dispose();
    await tester.pump();
  }

  testWidgets(
    '+ in Your Team, Claude Code, a request and New agent: it starts here as "You are <name>.", and its row opens its chat',
    (tester) async {
      final folders = <ProjectFolderRequest>[];
      final f = await mountSwarm(
        tester,
        prepareFolder: (request) async {
          folders.add(request);
          return '/work/new-agent';
        },
      );
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
      final c = f.app.superTabs.peek(tabId)!;
      // It goes on without the form; once it has joined, its row is in Your Team.
      await until(tester, () => f.connection.joins.isNotEmpty);
      await until(
        tester,
        () => c.snapshot!.agents.any(
          (a) => key('super-agent-${a.id}').evaluate().isNotEmpty,
        ),
      );
      final listed = c.snapshot!.agents.firstWhere(
        (a) => key('super-agent-${a.id}').evaluate().isNotEmpty,
      );
      await tester.tap(key('super-agent-${listed.id}'));
      await until(
        tester,
        () =>
            c.selected?.isAgentChat == true &&
            find
                .byKey(const ValueKey('swarm-agent-header'))
                .evaluate()
                .isNotEmpty,
      );

      final chat = commands(f).singleWhere((c) => c['type'] == 'agent.new');
      final name = chat['name'] as String;
      expect(agentNames, contains(name));
      expect(chat['engine'], 'claude');
      expect(chat['machineId'], 'm');
      final create = f.connection.calls
          .singleWhere((c) => c.$1 == 'agent_create')
          .$2;
      expect(create['prompt'], 'You are $name.\n\nTidy the docs.');
      expect(create['engine'], 'claude');
      // In a new folder of its own on this computer.
      expect(folders, hasLength(1));
      expect(create['cwd'], '/work/new-agent');
      // It joined that chat, and the person is in it: the form is gone, the bar names it, and Your Team lists it.
      final join = f.connection.joins.single['command'] as Map;
      expect(join['conversationId'], c.selectedId);
      expect(join['name'], name);
      expect(find.byType(NewHarnessForm), findsNothing);
      expect(
        find.descendant(
          of: key('swarm-agent-header'),
          matching: find.text(name),
        ),
        findsOneWidget,
      );
      final agent = c.snapshot!.agents.singleWhere(
        (a) => (a.displayName ?? a.name) == name,
      );
      expect(key('super-agent-${agent.id}'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await end(tester, f);
    },
  );

  testWidgets(
    'a stopped agent from Your Team: its Terminal shows Resume, and Resume brings its session back',
    (tester) async {
      final f = await mountSwarm(
        tester,
        before: (f) {
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
          // Pip's session on this computer is stopped: its conversation is saved, its terminal is not running.
          f.connection.native = {
            'id': 'native-lead',
            'name': 'Pip',
            'engine': 'claude',
            'status': 'stopped',
            'sessionId': 'saved-native',
            'terminal': {'available': false},
          };
          f.app.machineStates['m']!.agents = [
            Agent.fromJson(f.connection.native!),
          ];
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
        },
      );
      // Its person opens its chat from Your Team, then its terminal from the chat's bar.
      await tester.tap(key('super-agent-pip'));
      await until(
        tester,
        () => find
            .byKey(const ValueKey('swarm-terminal-button'))
            .evaluate()
            .isNotEmpty,
      );
      await tester.tap(key('swarm-terminal-button'));
      await until(tester, () => find.text('Resume').evaluate().isNotEmpty);
      expect(find.text('Resume'), findsOneWidget);
      // Nothing starts by itself, a while on either: Resume is the person's.
      await tester.pump(const Duration(seconds: 2));
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_resume'),
        isEmpty,
      );
      await tester.tap(find.text('Resume'));
      await until(
        tester,
        () => f.app.panes.firstOrNull?.session?.streamId != null,
      );
      final resumes = [
        for (final call in f.connection.calls)
          if (call.$1 == 'agent_resume') call.$2,
      ];
      expect(resumes, hasLength(1));
      // The stopped session itself, not a new one.
      expect(resumes.single['agentId'], 'native-lead');
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_create'),
        isEmpty,
      );
      expect(f.app.panes.firstOrNull?.session?.streamId, isNotNull);
      expect(find.text('Resume'), findsNothing);
      await end(tester, f);
    },
  );

  testWidgets(
    'closing an agent\'s terminal closes the view and leaves it running; '
    'its session ending stops it, and Terminal then offers Resume',
    (tester) async {
      final f = await mountSwarm(
        tester,
        before: (f) {
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
          // Pip runs on this computer.
          f.connection.native = {
            'id': 'native-lead',
            'name': 'Pip',
            'engine': 'claude',
            'status': 'running',
            'sessionId': 'saved-native',
            'createdAt': '2026-11-10T08:00:00.000Z',
            'closeSupported': true,
            'terminal': {'available': true},
          };
          f.app.machineStates['m']!.agents = [
            Agent.fromJson(f.connection.native!),
          ];
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
        },
      );
      Agent pip() => f.app.machineStates['m']!.agents.single;
      bool live() => f.app.panes.firstOrNull?.session?.streamId != null;
      // Its person opens its chat from Your Team, then its terminal: the session is live.
      await tester.tap(key('super-agent-pip'));
      await until(
        tester,
        () => find
            .byKey(const ValueKey('swarm-terminal-button'))
            .evaluate()
            .isNotEmpty,
      );
      await tester.tap(key('swarm-terminal-button'));
      await until(tester, live);
      expect(live(), isTrue);
      expect(find.text('Resume'), findsNothing);
      // Closing the terminal closes the view: nothing is stopped, and Pip runs on.
      await tester.tap(key('swarm-terminal-button'));
      await tester.pump(const Duration(seconds: 1));
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_close'),
        isEmpty,
      );
      expect(pip().isStopped, isFalse);
      // Its terminal opens again on the same running session.
      await tester.tap(key('swarm-terminal-button'));
      await until(tester, live);
      expect(find.text('Resume'), findsNothing);
      // The session ends in its terminal (its person quits Claude Code): its computer lists it stopped, and Terminal
      // offers Resume, which is the person's to press.
      f.connection.native = {
        ...f.connection.native!,
        'status': 'stopped',
        'terminal': {'available': false},
      };
      f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
      await until(tester, () => find.text('Resume').evaluate().isNotEmpty);
      expect(pip().isStopped, isTrue);
      expect(find.text('Resume'), findsOneWidget);
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_resume'),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
      await end(tester, f);
    },
  );
}
