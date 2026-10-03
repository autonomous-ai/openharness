import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// A machine that answers every question with nothing — or with [answers], by request type.
class _Conn extends WsConn {
  _Conn([this.answers = const {}])
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'ready',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final Map<String, Map<String, dynamic>> answers;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => answers[type] ?? {};
}

/// A machine that is answering, and one that is not.
///
/// The second is the whole point of the picker's filter: an agent cannot be created on a machine
/// that has not listed its folders or named its engines, so it must not be offered as a host.
AppNotifier _app({Map<String, Map<String, dynamic>> answers = const {}}) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    // The form asks the machine for its engines and Codex profiles as it opens.
    connectionForTest: (_) => _Conn(answers),
  );
  const ready = Machine(
    machineId: 'ready',
    authMode: MachineAuthMode.remote,
    name: 'Studio',
  );
  const sleeping = Machine(
    machineId: 'sleeping',
    authMode: MachineAuthMode.remote,
    name: 'Laptop',
  );
  app.machines = [ready, sleeping];
  app.machineStates['ready'] = MachineState(ready)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded;
  // Harness is not running there: offline, whatever the socket says.
  app.machineStates['sleeping'] = MachineState(sleeping)
    ..nodeOnline = false
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded;
  return app;
}

void main() {
  testWidgets(
    'the Project chooser offers only machines that can host an agent',
    (tester) async {
      final app = _app();
      addTearDown(app.dispose);
      // A folder on each machine; the sleeping one's must not be offered.
      await app.projectHistory.select('ready', '/code/app');
      await app.projectHistory.select('sleeping', '/code/site');
      await tester.pumpWidget(
        MaterialApp(
          home: NewAgentPage(notifier: app, machineId: 'ready'),
        ),
      );
      await tester.pumpAndSettle();
      // The desktop's default: the project last started on this machine.
      expect(find.text('Studio:app', findRichText: true), findsOneWidget);

      await tester.tap(find.text('project'));
      await tester.pumpAndSettle();

      // One row per `machine:folder` pair.
      expect(
        find.textContaining('Studio:/code/app', findRichText: true),
        findsOneWidget,
      );
      expect(
        find.textContaining('Laptop', findRichText: true),
        findsNothing,
        reason: 'an offline machine cannot host a new agent',
      );
    },
  );

  testWidgets('a worktree Harness made is not the project: its repository is', (
    tester,
  ) async {
    const worktree =
        '/home/u/harnesses/worktrees/autonomous-harness/silent-beacon';
    final app = _app(
      answers: {
        'git_project_info': {
          'isGit': true,
          'branch': 'silent-beacon',
          'root': worktree,
          'mainFolder': '/home/u/code/autonomous-harness',
          'mainBranch': 'main',
          'defaultRef': 'refs/remotes/origin/main',
          'branches': [
            {'ref': 'refs/heads/main', 'name': 'main'},
            {
              'ref': 'refs/remotes/origin/main',
              'name': 'origin/main',
              'remote': true,
            },
          ],
        },
      },
    );
    addTearDown(app.dispose);
    // Opened on another harness's worktree — its folder, handed over as Find hands one.
    await tester.pumpWidget(
      MaterialApp(
        home: NewAgentPage(notifier: app, machineId: 'ready', folder: worktree),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('Studio:autonomous-harness', findRichText: true),
      findsOneWidget,
    );
    expect(
      find.textContaining('silent-beacon', findRichText: true),
      findsNothing,
    );
  });

  testWidgets('a swipe right anywhere goes back', (tester) async {
    final app = _app();
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => NewAgentPage(notifier: app, machineId: 'ready'),
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.byType(NewAgentPage), findsOneWidget);

    await tester.drag(find.text('agent'), const Offset(200, 0));
    await tester.pumpAndSettle();

    expect(find.byType(NewAgentPage), findsNothing);
  });

  testWidgets(
    'a first harness is taught, and offered first tasks; later ones are not',
    (tester) async {
      final app = _app();
      addTearDown(app.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: NewAgentPage(notifier: app, machineId: 'ready'),
        ),
      );
      await tester.pump();
      expect(
        find.text('A harness is one session of an agent. Start your first.'),
        findsOneWidget,
      );
      expect(find.text('Explain this project to me'), findsOneWidget);

      // Something is running: the lesson is learned, and the chips were filler.
      app.machineStates['ready']!.agents = [
        Agent(id: 'a', name: 'hn', engine: 'claude', terminalAvailable: true),
      ];
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(
        MaterialApp(
          home: NewAgentPage(notifier: app, machineId: 'ready'),
        ),
      );
      await tester.pump();
      expect(find.textContaining('A harness is one session'), findsNothing);
      expect(find.text('Explain this project to me'), findsNothing);
    },
  );
}
