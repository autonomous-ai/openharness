/// Disposable review of all three production onboarding panels.
/// Launch with FLUTTER_TEST=1. The bottom controls simulate progress in memory.
library;

import 'package:flutter/material.dart';
import 'package:harness/core/desktop_window.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:window_manager/window_manager.dart';

import 'machines_preview.dart' show createMachinesReviewApp;

Future<void> main() async {
  if (!kUnderTest) throw StateError('Preview requires FLUTTER_TEST=1.');
  WidgetsFlutterBinding.ensureInitialized();
  newHarnessOpensInBox = true;
  await configureDesktopWindow();
  await windowManager.setTitle('Onboarding review');
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: const _Review(),
    ),
  );
}

class _Review extends StatefulWidget {
  const _Review();
  @override
  State<_Review> createState() => _ReviewState();
}

class _ReviewState extends State<_Review> {
  late AppNotifier app;
  late WorkspaceOnboarding onboarding;
  int scene = 0, revision = 0;
  bool _switching = false;
  @override
  void initState() {
    super.initState();
    _prepare(0);
  }

  void _prepare(int step) {
    scene = step;
    revision++;
    app = createMachinesReviewApp();
    app.machineStates.removeWhere((id, _) => id != 'm');
    app.stateOf('m')!.agents = [];
    onboarding = WorkspaceOnboarding();
    if (step == 1 || step == 2) {
      app.stateOf('m')!.agents = const [
        Agent(
          id: 'work',
          name: 'Build my website',
          engine: 'codex',
          terminalAvailable: true,
        ),
      ];
      final session =
          TerminalSession(
              machineId: 'm',
              agentId: 'work',
              agentName: 'Build my website',
              engineId: 'codex',
              send: (_, _) async => true,
              sendBinary: (_) async => true,
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'review';
      session.terminal.write(
        'Your website is ready to review.\r\n\r\nWhat would you like to change?\r\n',
      );
      // This entrypoint is guarded by kUnderTest and never opens a real session.
      // ignore: invalid_use_of_visible_for_testing_member
      app.adoptSessionForTest(session);
    }
    if (step == 2) {
      onboarding.sync(
        scope: 'account:review@example.test',
        observed: {OnboardingStep.machines},
        otherComputer: false,
        modelsAvailable: true,
      );
    }
    if (step == 3) {
      const local = Machine(
        machineId: 'm',
        name: 'Mac mini',
        authMode: MachineAuthMode.remote,
      );
      app.machineStates['m'] = MachineState(local)
        ..localOnly = true
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      const source = Machine(
        machineId: 'source',
        name: 'M2',
        authMode: MachineAuthMode.remote,
      );
      app.machineStates['source'] = MachineState(source)
        ..nodeOnline = true
        ..needsLink = true
        ..agents = const [
          Agent(
            id: 'work',
            name: 'Build my website',
            engine: 'codex',
            terminalAvailable: true,
          ),
        ];
    }
    app.machines = app.machineStates.values.map((m) => m.machine).toList();
  }

  void _scene(int next) {
    if (_switching) return;
    final oldApp = app;
    final oldOnboarding = onboarding;
    // Let the old workspace release its native method-channel handler before
    // mounting another one. These controls only exist in the review fixture.
    setState(() => _switching = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      oldApp.dispose();
      oldOnboarding.dispose();
      setState(() {
        _prepare(next);
        _switching = false;
      });
    });
  }

  @override
  void dispose() {
    app.dispose();
    onboarding.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Column(
      children: [
        Expanded(
          child: _switching
              ? const SizedBox()
              : SwarmScreen(
                  key: ValueKey(revision),
                  notifier: app,
                  nativeTabs: true,
                  onboarding: onboarding,
                ),
        ),
        Container(
          color: const Color(0xff202020),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
          child: Row(
            children: [
              const Text(
                'Review',
                style: TextStyle(color: Colors.grey, fontSize: 12),
              ),
              const SizedBox(width: 12),
              for (final (index, label) in [
                (0, '1 · First harness'),
                (1, '2 · Another computer'),
                (2, '3 · Local AI'),
                (3, 'Receiving computer'),
              ])
                TextButton(
                  onPressed: () => _scene(index),
                  style: TextButton.styleFrom(
                    foregroundColor: scene == index
                        ? Colors.white
                        : Colors.grey,
                  ),
                  child: Text(label),
                ),
            ],
          ),
        ),
      ],
    ),
  );
}
