// Interactive native regression fixture. Launch with FLUTTER_TEST=1:
// flutter run -d macos -t tool/pane_move_review.dart
// Move Alpha/Beta with Cmd-Shift-M; Focus contains a terminal owned elsewhere.
// Input echoes locally. No daemon, agent process, or persisted layout is used.
// PANE_MOVE_REVIEW_STATE optionally names a JSON evidence file.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:window_manager/window_manager.dart';

Future<void> main() async {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  await const MethodChannel('harness/swarm_tabs').invokeMethod('configure', {
    'palette': grid.AppTheme.palette.value.nativeColors,
  });
  await windowManager.setSize(const Size(1200, 800));
  await windowManager.setTitle('Pane move regression review');

  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  )..hasNavigationRail = false;
  const machine = Machine(
    machineId: 'review',
    name: 'Isolated review',
    authMode: MachineAuthMode.remote,
  );
  const names = ['Alpha', 'Beta', 'Remote-owned'];
  app.machines = [machine];
  app.machineStates[machine.machineId] = MachineState(machine)
    ..nodeOnline = true
    ..terminalCapabilityAvailable = true
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..localEndpoint = LocalCliEndpoint(
      computerId: 'pane-move-review',
      wsUri: Uri.parse('ws://fixture.invalid'),
      protocolVersion: 1,
      terminalProtocolVersion: 3,
    )
    ..agents = [
      for (final name in names)
        Agent(id: name, name: name, engine: 'codex', terminalAvailable: true),
    ];
  final controls = <String>[];
  final inputs = <String>[];
  final keys = <Map<String, Object>>[];
  HardwareKeyboard.instance.addHandler((event) {
    keys.add({
      'key': event.logicalKey.keyLabel,
      'type': event.runtimeType.toString(),
      'meta': HardwareKeyboard.instance.isMetaPressed,
      'shift': HardwareKeyboard.instance.isShiftPressed,
    });
    return false;
  });
  final sessions = <String, TerminalSession>{};
  for (final name in names) {
    late final TerminalSession session;
    session =
        TerminalSession(
            machineId: machine.machineId,
            agentId: name,
            agentName: name,
            engineId: 'codex',
            send: (type, _) async {
              if (type == 'terminal_open' || type == 'terminal_close') {
                controls.add('$name:$type');
              }
              return true;
            },
            sendBinary: (frame) async {
              if (frame.kind == TerminalBinaryKind.input) {
                final text = utf8.decode(frame.bytes, allowMalformed: true);
                inputs.add('$name:$text');
                session.terminal.write(text);
              }
              return true;
            },
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'review-$name';
    session.terminal.write(
      '$name — original session\r\n'
      'Preserve this scrollback and connection across every move.\r\n'
      'Cmd-Shift-M moves this pane; typed input echoes here.\r\n\r\n> ',
    );
    sessions[name] = session;
    if (name == names.last) app.newSwarm(name: 'Focus');
    // This entrypoint is guarded and never runs against real sessions.
    // ignore: invalid_use_of_visible_for_testing_member
    app.adoptSessionForTest(session);
  }
  final source = app.swarms.first;
  app.renameSwarm(source.id, 'Source');
  app.selectSwarm(source.id);
  app.focusPane(source.panes.first.id);
  sessions[names.last]!.status = TerminalSessionStatus.takenOver;
  final originals = {for (final pane in app.allPanes) pane.agentId: pane};
  final output = Platform.environment['PANE_MOVE_REVIEW_STATE'];
  void record() {
    if (output == null) return;
    File(output).writeAsStringSync(
      jsonEncode({
        'activeTab': app.activeSwarm.name,
        'focusedAgent': app.focusedPane?.agentId,
        'focusByUser': app.paneFocusByUser,
        'tabs': [
          for (final tab in app.swarms)
            {
              'name': tab.name,
              'agents': tab.panes.map((p) => p.agentId).toList(),
            },
        ],
        'panes': [
          for (final pane in app.allPanes)
            {
              'agent': pane.agentId,
              'samePane': identical(pane, originals[pane.agentId]),
              'sameSession': identical(pane.session, sessions[pane.agentId]),
              'stream': pane.session?.streamId,
              'status': pane.session?.status.name,
              'hasOriginalOutput': pane.session?.terminal.buffer
                  .getText()
                  .contains('${pane.agentId} — original session'),
            },
        ],
      'controls': controls,
      'inputs': inputs,
      'keys': keys,
      }),
    );
  }

  app.addListener(record);
  Timer.periodic(const Duration(milliseconds: 500), (_) => record());
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(notifier: app, nativeTabs: true),
    ),
  );
  await windowManager.show();
  await windowManager.focus();
}
