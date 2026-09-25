// New Harness, end to end through the real app model: the machine's catalog
// arrives over `dsh_list`, the harness is picked with keys, ⇧⏎ sends
// `dsh_install`, the machine narrates through `dsh_install_status` pushes,
// and `agent_create` follows only once the install lands. Only the socket is
// a fixture; AppNotifier, MachineDsh, the controller and the form are real.
import 'dart:async';

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
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'support/launch_menu.dart' show focusLaunchRow;

const _circuit = 'autonomous/autonomous-circuit';

/// The machine's side of the socket. `dsh_install` holds until the test
/// answers it through [reply], so the test can push the machine's narration
/// in between, exactly as a daemon does while it works.
class _Machine extends WsConn {
  _Machine()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  bool circuitInstalled = false;
  final installs = <String>[];
  final creates = <Map<String, dynamic>>[];
  Completer<Map<String, dynamic>>? reply;

  /// Set to make the next `dsh_install` fail the way a dropped socket does.
  Object? dropInstall;

  List<Map<String, dynamic>> get catalog => [
    {
      'id': 'autonomous/autonomous-blender',
      'name': 'Autonomous Blender',
      'engine': 'claude',
      'engines': ['claude', 'codex'],
      'installed': true,
    },
    {
      'id': _circuit,
      'name': 'Autonomous Circuit',
      'engine': 'claude',
      'engines': ['claude', 'codex'],
      'installed': circuitInstalled,
    },
    {
      'id': 'autonomous/autonomous-viewer',
      'name': 'Autonomous Viewer',
      'engine': 'claude',
      'kind': 'viewer',
      'installed': true,
    },
  ];

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
            {'engine': 'codex', 'installed': true},
          ],
        };
      case 'dsh_list':
        return {'dsh': catalog};
      case 'git_project_info':
        return {'isGit': false};
      case 'dsh_install':
        installs.add(payload['id'] as String);
        if (dropInstall case final error?) {
          dropInstall = null;
          throw error;
        }
        reply = Completer();
        final answer = await reply!.future;
        if (answer['ok'] == true) circuitInstalled = true;
        return answer;
      case 'agent_create':
        creates.add(Map.of(payload));
        return {
          'creationId': payload['creationId'],
          'state': 'created',
          'agent': {
            'id': 'made',
            'name': 'Circuit',
            'engine': payload['engine'],
            'dsh': payload['dsh'],
            'terminal': {'available': true},
          },
        };
    }
    return {};
  }
}

void main() {
  late _Machine machine;
  late AppNotifier app;

  Future<void> say(Map<String, Object?> progress) => app.handleEventForTest(
    'm',
    {'type': 'dsh_install_status', 'payload': progress},
  );

  Future<NewHarnessController> mount(
    WidgetTester tester, {
    double width = 960,
    double textScale = 1,
    void Function()? onCreated,
  }) async {
    machine = _Machine();
    app = AppNotifier(
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
    // This machine's Git is read from disk, which a widget test cannot wait
    // on; the folder is not a checkout, so start has no branch to check.
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
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
          data: MediaQueryData(
            size: Size(width, 700),
            textScaler: TextScaler.linear(textScale),
          ),
          child: KeymapProvider(
            keymap: keymap,
            child: KeymapHost(
              keymap: keymap,
              enabled: () => true,
              actions: const {},
              child: Scaffold(
                body: Center(
                  child: SizedBox(
                    width: width,
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
    return box;
  }

  /// Harness row, Enter to open its list, type, Enter to take the match.
  Future<void> pickCircuit(WidgetTester tester) async {
    await focusLaunchRow(tester, 'harness');
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('new-harness-query')),
      'circuit',
    );
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
  }

  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    // The controller coalesces app changes on a 100ms window.
    await tester.pump(const Duration(milliseconds: 150));
  }

  final pane = find.byKey(const ValueKey('new-harness-install'));
  Finder inPane(String text) =>
      find.descendant(of: pane, matching: find.text(text));

  testWidgets('pick with keys, install with narration, then create', (
    tester,
  ) async {
    var created = 0;
    final box = await mount(tester, onCreated: () => created++);
    await pickCircuit(tester);
    expect(box.harnessId, _circuit);
    expect(pane, findsNothing, reason: 'quiet until start');

    await key(tester, LogicalKeyboardKey.enter, shift: true);
    await settle(tester);
    expect(machine.installs, [_circuit]);
    expect(inPane('Installing Autonomous Circuit on This Mac'), findsOneWidget);
    expect(inPane('Fetch Autonomous Circuit'), findsOneWidget);

    await say({'id': _circuit, 'phase': 'clone', 'line': 'Cloning into…'});
    await settle(tester);
    expect(inPane('Cloning into…'), findsWidgets);

    await say({'id': _circuit, 'phase': 'setup', 'line': 'uv sync'});
    await settle(tester);
    expect(inPane('✓'), findsOneWidget);
    expect(inPane('uv sync'), findsWidgets);

    await say({'id': _circuit, 'phase': 'doctor', 'line': 'ok kicad-cli'});
    await settle(tester);
    expect(inPane('✓'), findsNWidgets(2));
    expect(inPane('ok kicad-cli'), findsWidgets);
    expect(machine.creates, isEmpty, reason: 'no create before the install');

    await say({'id': _circuit, 'phase': 'done'});
    machine.reply!.complete({'ok': true});
    await settle(tester);
    await settle(tester);

    expect(machine.creates, hasLength(1));
    expect(machine.creates.single['dsh'], _circuit);
    expect(machine.creates.single['engine'], 'claude');
    expect(created, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed install explains itself; ⇧⏎ retries and creates', (
    tester,
  ) async {
    final box = await mount(tester);
    await pickCircuit(tester);
    await key(tester, LogicalKeyboardKey.enter, shift: true);
    await settle(tester);
    await say({'id': _circuit, 'phase': 'clone'});
    await say({'id': _circuit, 'phase': 'setup', 'line': 'npm ci'});
    await say({
      'id': _circuit,
      'phase': 'failed',
      'error': 'DSH_SETUP_FAILED',
      'detail': 'setup exited 1 · npm ERR! code E401',
    });
    machine.reply!.complete({
      'ok': false,
      'error': 'DSH_SETUP_FAILED',
      'detail': 'setup exited 1 · npm ERR! code E401',
    });
    await settle(tester);

    expect(machine.creates, isEmpty);
    expect(
      inPane('Autonomous Circuit did not install on This Mac'),
      findsOneWidget,
    );
    expect(inPane('✓'), findsOneWidget, reason: 'fetch had finished');
    expect(inPane('✗'), findsOneWidget, reason: 'set up is what failed');
    expect(find.textContaining('tries again'), findsOneWidget);
    expect(box.busy, isFalse);

    // Opening a list covers the pane while choosing; leaving it brings it back.
    await focusLaunchRow(tester, 'agent');
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(pane, findsNothing);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(pane, findsOneWidget);

    await key(tester, LogicalKeyboardKey.enter, shift: true);
    await settle(tester);
    expect(machine.installs, [_circuit, _circuit]);
    expect(inPane('✗'), findsNothing, reason: 'a retry is a fresh run');
    expect(inPane('Installing Autonomous Circuit on This Mac'), findsOneWidget);
    await say({'id': _circuit, 'phase': 'done'});
    machine.reply!.complete({'ok': true});
    await settle(tester);
    await settle(tester);
    expect(machine.creates.single['dsh'], _circuit);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a dropped socket says the install may still be finishing', (
    tester,
  ) async {
    await mount(tester);
    await pickCircuit(tester);
    machine.dropInstall = StateError('socket closed');
    await key(tester, LogicalKeyboardKey.enter, shift: true);
    await settle(tester);
    expect(machine.creates, isEmpty);
    expect(pane, findsOneWidget);
    expect(
      find.textContaining('Lost the connection to This Mac'),
      findsWidgets,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a viewer package is not offered as a harness', (tester) async {
    final box = await mount(tester);
    box.focusField(NewHarnessField.harness);
    expect(
      box.options.map((o) => o.id),
      isNot(contains('autonomous/autonomous-viewer')),
    );
    expect(
      box.options.map((o) => o.id),
      containsAllInOrder(['claude', 'autonomous/autonomous-blender', _circuit]),
    );
    await settle(tester);
  });

  for (final (width, scale) in [(960.0, 2.0), (520.0, 1.0), (520.0, 2.0)]) {
    testWidgets('the pane fits a ${width.toInt()}px window at ${scale}x text', (
      tester,
    ) async {
      await mount(tester, width: width, textScale: scale);
      await pickCircuit(tester);
      await key(tester, LogicalKeyboardKey.enter, shift: true);
      await settle(tester);
      await say({'id': _circuit, 'phase': 'clone'});
      await say({
        'id': _circuit,
        'phase': 'setup',
        'line': 'a very long line from the toolchain ' * 8,
      });
      for (var i = 0; i < 20; i++) {
        await say({'id': _circuit, 'phase': 'setup', 'line': 'step $i ' * 6});
      }
      await settle(tester);
      expect(pane, findsOneWidget);
      expect(tester.takeException(), isNull, reason: 'no overflow');
      machine.reply!.complete({'ok': true});
      await settle(tester);
    });
  }
}
