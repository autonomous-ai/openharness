// A real, signed-out local workspace in an isolated Release application.
// All terminal I/O, discovery, daemon supervision, UI and local background
// services run normally. Only installer/auth/update acquisition is substituted.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/connected_semantics.dart';
import 'package:harness/core/crash_log.dart';
import 'package:harness/core/desktop_window.dart';
import 'package:harness/core/startup.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/desktop_workspace.dart';
import 'package:harness/logging/install.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/update/desktop_updater.dart';
import 'package:harness/ws/local_cli_discovery.dart';

const _host = MethodChannel('harness/connected_resource_fixture');

// Observe the framework's visibility decision independently of AppKit. A native
// hidden window alone does not prove that Flutter has stopped drawing frames.
class _ResourceBinding extends HarnessWidgetsBinding {
  int drawnFrames = 0;
  final lifecycleChanges = <Map<String, Object>>[];

  @override
  void handleAppLifecycleStateChanged(AppLifecycleState state) {
    super.handleAppLifecycleStateChanged(state);
    lifecycleChanges.add({
      'state': state.name,
      'at': DateTime.now().toUtc().toIso8601String(),
    });
    if (lifecycleChanges.length > 32) lifecycleChanges.removeAt(0);
  }

  @override
  void drawFrame() {
    drawnFrames++;
    super.drawFrame();
  }

  Map<String, Object?> get snapshot => {
    'lifecycle': lifecycleState?.name,
    'framesEnabled': framesEnabled,
    'drawnFrames': drawnFrames,
    'lifecycleChanges': lifecycleChanges,
  };
}

class _PreparedEnvironment extends EnvironmentProvisioner {
  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    if (install) throw StateError('The fixture never installs software');
    final ready = EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.ready,
    );
    onProgress(ready);
    return ready;
  }
}

class _SignedOut extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: false);
}

class _NoUpdateAcquisition extends DesktopUpdater {
  @override
  Future<DesktopUpdateCheck> check({String? currentVersion}) async =>
      const DesktopUpdateCheck.disabled();
}

Future<void> _until(bool Function() done, String operation) async {
  final deadline = DateTime.now().add(const Duration(seconds: 30));
  while (!done()) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('$operation did not complete');
    }
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

String _tail(TerminalSession session) {
  final lines = session.terminal.buffer.lines;
  return [
    for (
      var index = (lines.length - 50).clamp(0, lines.length);
      index < lines.length;
      index++
    )
      lines[index].getText(),
  ].join('\n');
}

Future<void> main() async {
  final binding = _ResourceBinding();
  final root = Platform.environment['HARNESS_CONNECTED_ROOT']!;
  if (kUnderTest || Platform.environment['HOME'] != '$root/home') {
    throw StateError(
      'The connected fixture must use its private, non-test home',
    );
  }
  final manifest = jsonDecode(
    await File('$root/stack.json').readAsString(),
  ) as Map<String, dynamic>;
  if (manifest['ready'] != true || manifest['root'] != root) {
    throw StateError('The connected fixture has no matching ready stack');
  }
  final machine = manifest['machineId'] as String;
  final agents = (manifest['agents'] as List).cast<Map<String, dynamic>>();
  final config = AppConfig(
    apiBaseUrl: 'http://127.0.0.1:1',
    localCliBaseUrl: 'http://127.0.0.1:${manifest['port']}',
  );
  final discovery = LocalCliDiscovery(
    config: config,
    spawnCommand: () async =>
        throw StateError('Fixture daemon unexpectedly disappeared'),
    stopCommand: () async =>
        throw StateError('Only the fixture launcher owns its daemon'),
  );
  installFileLogs();
  CrashLog.install();
  final keymap = AppKeymap(store: AppKeymap.fileStore());
  await Future.wait([loadPersistedSettings(), keymap.start()]);
  final app = AppNotifier(
    config: config,
    authSession: AuthSession(),
    localCliDiscovery: discovery,
    environmentProvisioner: _PreparedEnvironment(),
    cliLogin: _SignedOut(),
    desktopUpdater: _NoUpdateAcquisition(),
    paneLayoutStore: PaneLayoutStore(),
  );
  await configureDesktopWindow();
  runApp(
    ProviderScope(
      overrides: [appStateProvider.overrideWithValue(app)],
      child: HarnessApp(
        keymap: keymap,
        authenticatedScreen: authenticatedWorkspace,
        frame: appFrame,
      ),
    ),
  );
  await _host.invokeMethod<void>('ready');
  try {
    await app.bootstrap();
    await _until(
      () => app.machineStates[machine]?.agents.length == agents.length,
      'Private agent discovery',
    );
    if (app.machineStates.length != 1 || app.signedIn) {
      throw StateError('The fixture crossed its signed-out local boundary');
    }
    final first = app.activeSwarmId;
    for (var index = 0; index < agents.length; index++) {
      if (index % 4 == 0) {
        if (index != 0) app.newSwarm();
        app.renameSwarm(
          app.activeSwarmId,
          'Resource fixture ${index ~/ 4 + 1}',
        );
      }
      await app.addAgentToSwarm(machine, agents[index]['id'] as String);
    }
    await _until(
      () =>
          app.allPanes
              .where(
                (pane) =>
                    pane.session?.status == TerminalSessionStatus.controlling,
              )
              .length ==
          agents.length,
      'Private terminal attachments',
    );
    app.selectSwarm(first);
    await WidgetsBinding.instance.endOfFrame;
    final server = await ServerSocket.bind(
      InternetAddress('$root/app-control.sock', type: InternetAddressType.unix),
      0,
    );
    await File('$root/app-ready.json').writeAsString(
      jsonEncode({
        'ready': true,
        'pid': pid,
        'terminals': agents.length,
        'sourceRevision': const String.fromEnvironment(
          'CONNECTED_SOURCE_REVISION',
        ),
        'testMode': kUnderTest,
        'boundary':
            'Signed-out Release desktop, local daemon, real tmux terminals. '
            'No cloud accounts, model inference, installer or update acquisition.',
      }),
    );
    server.listen((socket) {
      socket
          .cast<List<int>>()
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen((line) async {
            try {
              final command = jsonDecode(line) as Map<String, dynamic>;
              final operation = command['operation'];
              if (operation == 'hide' || operation == 'show') {
                await _host.invokeMethod<void>(operation as String);
              } else if (operation == 'input') {
                final agent = command['agentId'] as String;
                final session = app.allPanes
                    .map((pane) => pane.session)
                    .whereType<TerminalSession>()
                    .singleWhere((item) => item.agentId == agent);
                session.terminal.textInput(command['text'] as String);
              } else if (operation != 'status' && operation != 'finish') {
                throw StateError('Unknown fixture operation');
              }
              socket.writeln(
                jsonEncode({
                  'success': true,
                  'pid': pid,
                  'native': await _host.invokeMapMethod<String, dynamic>(
                    'captureState',
                  ),
                  'framework': binding.snapshot,
                  'panes': [
                    for (final pane in app.allPanes)
                      {
                        'agentId': pane.session?.agentId,
                        'status': pane.session?.status.name,
                        'rows': pane.session?.terminal.buffer.lines.length,
                        if (command['includeText'] == true &&
                            pane.session != null)
                          'tail': _tail(pane.session!),
                      },
                  ],
                }),
              );
              await socket.flush();
              await socket.close();
              if (operation == 'finish') {
                app.dispose();
                await _host.invokeMethod<void>('finish');
              }
            } catch (error, stack) {
              socket.writeln(
                jsonEncode({
                  'success': false,
                  'error': '$error',
                  'stack': '$stack',
                }),
              );
              await socket.close();
            }
          });
    });
  } catch (error, stack) {
    await File('$root/app-failed.json').writeAsString(
      jsonEncode({
        'success': false,
        'pid': pid,
        'error': '$error',
        'stack': '$stack',
      }),
    );
    app.dispose();
    await _host.invokeMethod<void>('finish');
  }
}
