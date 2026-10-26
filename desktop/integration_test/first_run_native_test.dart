import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/first_arrival.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/widgets/workspace_machine_prompt.dart';

import '../test/support/capture.dart';

/// Real native rendering and input with synthetic transport only. Never opens a
/// daemon, reads provider credentials, or submits a task to a real agent.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final captures = Platform.environment['HARNESS_FIRST_RUN_CAPTURES'];
  final oldPalette = grid.AppTheme.palette.value;
  final oldBrightness = grid.AppTheme.brightness.value;
  tearDownAll(() {
    grid.AppTheme.palette.value = oldPalette;
    grid.AppTheme.brightness.value = oldBrightness;
  });
  setUpAll(() async {
    await loadCaptureFonts(captures);
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1000, 700));
    await windowManager.show();
    await windowManager.focus();
  });

  testWidgets(
    'native first-run recovery keeps retry and a fresh start reachable',
    (tester) async {
      var retried = 0, fresh = 0, opened = 0;
      for (final brightness in [Brightness.light, Brightness.dark]) {
        grid.AppTheme.palette.value = brightness == Brightness.light
            ? HarnessPalette.paper
            : HarnessPalette.graphite;
        grid.AppTheme.brightness.value = brightness;
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 640,
                  child: WorkspaceMachinePrompt(
                    loading: false,
                    recovery: 'The saved conversation could not be opened. Your project and history are kept.',
                    onRetry: () => retried++,
                    onStartNew: () => fresh++,
                    onChoose: () => opened++,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await captureWindow(tester, captures, 'recovery-${brightness.name}');
        await tester.tap(find.text('Try again'));
        await tester.tap(find.text('Start a new harness'));
        await tester.tap(find.text('Open harnesses'));
        expect(tester.takeException(), isNull);
      }
      expect([retried, fresh, opened], [2, 2, 2]);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'native local first task is editable and remains unsent until Enter',
    (tester) async {
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      const machine = Machine(
        machineId: 'fixture',
        name: 'This computer',
        authMode: MachineAuthMode.self,
      );
      app.machines = [machine];
      app.machineStates['fixture'] = MachineState(machine)..localOnly = true;
      final sent = <String>[];
      var submitted = 0;
      Object? request;
      final session = TerminalSession(
        machineId: 'fixture',
        agentId: 'first',
        agentName: 'First task',
        engineId: 'codex',
        client: const TerminalClientDescriptor(
          kind: 'desktop',
          name: 'Fixture',
        ),
        send: (type, payload) async {
          if (type == 'terminal_open') request = payload['requestId'];
          if (type == 'message') sent.add(payload['content'] as String);
          return true;
        },
        sendBinary: (_) async => true,
      );
      const stream = '00112233-4455-6677-8899-aabbccddeeff';
      await session.open(initialCols: 100, initialRows: 28);
      await session.handleFrame('terminal_ready', {
        'requestId': request,
        'protocolVersion': 3,
        'streamId': stream,
        'agentId': 'first',
      });
      await session.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: stream,
          seq: 0,
          bytes: Uint8List.fromList(
            utf8.encode('Codex\n\nReady for your first task.\n'),
          ),
          compressed: false,
          cols: 100,
          rows: 28,
        ),
      );
      for (final brightness in [Brightness.light, Brightness.dark]) {
        grid.AppTheme.palette.value = brightness == Brightness.light
            ? HarnessPalette.paper
            : HarnessPalette.graphite;
        grid.AppTheme.brightness.value = brightness;
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: TerminalPanel(
                notifier: app,
                session: session,
                focused: true,
                composerVisible: true,
                firstTask: FirstArrival.starterTask,
                onFirstTaskSubmitted: () => submitted++,
                onToggleComposer: () {},
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text(FirstArrival.starterTask), findsOneWidget);
        expect(sent, isEmpty);
        expect(submitted, 0);
        await captureWindow(tester, captures, 'first-task-${brightness.name}');
      }
      await tester.enterText(
        find.byType(TextField),
        'Make a page with a blue background.',
      );
      expect(sent, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(sent, ['Make a page with a blue background.']);
      expect(submitted, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      session.dispose();
      app.dispose();
    },
  );
}
