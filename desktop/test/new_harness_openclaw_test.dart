// OpenClaw in New Harness, clicked through as a person does: the folder is chosen, OpenClaw is
// taken from the agent list and started. Only the socket is a fixture.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/launch_menu.dart' show focusLaunchRow, startHarness;

class _Machine extends WsConn {
  _Machine(this.openclaw)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// What the machine's probe says of OpenClaw.
  final Map<String, Object?> openclaw;
  final creates = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    switch (type) {
      case 'engines_probe':
        return {
          'engines': [
            {'engine': 'claude', 'installed': true},
            {'engine': 'openclaw', ...openclaw},
          ],
        };
      case 'dsh_list':
        return {'dsh': <Object?>[]};
      case 'git_project_info':
        return {'isGit': false};
      case 'agent_create':
        creates.add(Map.of(payload));
        return {
          'creationId': payload['creationId'],
          'state': 'created',
          'agent': {
            'id': 'made',
            'name': 'OpenClaw',
            'engine': payload['engine'],
            'terminal': {'available': true},
          },
        };
    }
    return {};
  }
}

void main() {
  late _Machine machine;

  Future<void> mount(
    WidgetTester tester,
    Map<String, Object?> openclaw, {
    void Function()? onCreated,
  }) async {
    machine = _Machine(openclaw);
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      connectionForTest: (_) => machine,
    )..hasNavigationRail = false;
    const host = Machine(
      machineId: 'm',
      name: 'This Mac',
      authMode: MachineAuthMode.remote,
    );
    app.machines = [host];
    app.machineStates['m'] = MachineState(host)
      ..localOnly = true
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
    app.status = AppStatus.authenticated;
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    await app.agentPreference.remember('claude');
    final box = NewHarnessController(
      app,
      machineId: 'm',
      folder: '/work/air-monitor',
    );
    addTearDown(box.dispose);
    addTearDown(app.dispose);
    final keymap = MemoryKeymap();
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: MediaQuery(
          data: const MediaQueryData(size: Size(960, 700)),
          child: KeymapProvider(
            keymap: keymap,
            child: KeymapHost(
              keymap: keymap,
              enabled: () => true,
              actions: const {},
              child: Scaffold(
                body: Center(
                  child: SizedBox(
                    width: 960,
                    height: 600,
                    child: NewHarnessForm(
                      controller: box,
                      onClose: () {},
                      onCreated: onCreated ?? () {},
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// Agent row, Enter to open its list, type, and look at what the list says.
  Future<void> searchOpenClaw(WidgetTester tester) async {
    await focusLaunchRow(tester, 'agent');
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('new-harness-query')),
      'openclaw',
    );
    await tester.pumpAndSettle();
  }

  Finder row() => find.byKey(const ValueKey('new-harness-option-openclaw'));

  testWidgets('a person starts OpenClaw from New', (tester) async {
    var created = 0;
    await mount(tester, {
      'installed': true,
    }, onCreated: () => created++);
    await searchOpenClaw(tester);
    expect(
      find.descendant(of: row(), matching: find.text('OpenClaw')),
      findsOneWidget,
    );
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    await startHarness(tester);
    await tester.pump(const Duration(milliseconds: 150));
    expect(machine.creates, hasLength(1));
    expect(machine.creates.single['engine'], 'openclaw');
    // The pane opens in the folder New chose, as for every engine.
    expect(machine.creates.single['cwd'], '/work/air-monitor');
    expect(created, 1);
    expect(engineIdentity('openclaw').asset, 'assets/engine-icons/openclaw.png');
    expect(tester.takeException(), isNull);
  });

  testWidgets('New offers to install OpenClaw when it is missing', (
    tester,
  ) async {
    await mount(tester, {'installed': false, 'installable': true});
    await searchOpenClaw(tester);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    await startHarness(tester);
    await tester.pump(const Duration(milliseconds: 150));
    // Nothing blocks Start: the machine's launch installs it inside the new terminal.
    expect(find.textContaining('unavailable'), findsNothing);
    expect(machine.creates.single['engine'], 'openclaw');
    expect(tester.takeException(), isNull);
  });

  testWidgets('New shows OpenClaw needs Node 24 when the daemon reports it', (
    tester,
  ) async {
    await mount(tester, {
      'installed': true,
      'unavailable': 'OpenClaw needs Node 24.',
    });
    await searchOpenClaw(tester);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    await startHarness(tester);
    await tester.pump(const Duration(milliseconds: 150));
    expect(find.text('OpenClaw needs Node 24.'), findsWidgets);
    expect(machine.creates, isEmpty);
    expect(tester.takeException(), isNull);
  });
}
