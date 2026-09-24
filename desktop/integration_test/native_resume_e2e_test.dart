// Start `node --import tsx scripts/resume-native-e2e.ts --serve` in cli first.
// FLUTTER_TEST=1 flutter test -d macos --no-pub integration_test/native_resume_e2e_test.dart
//   --dart-define=RESUME_FIXTURE_URL=http://127.0.0.1:<fixture-port>
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/widgets/harness_session_manager.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/ws/ws_conn.dart';

import '../test/swarm_interactions_test.dart' show chord;
import '../test/swarm_screen_test.dart' show mount;
import '../test/swarm_state_test.dart' show createApp;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const endpoint = String.fromEnvironment('RESUME_FIXTURE_URL');
  if (!kUnderTest || !endpoint.startsWith('http://127.0.0.1:')) {
    throw StateError(
      'Requires FLUTTER_TEST=1 and the isolated resume fixture URL',
    );
  }
  testWidgets(
    'real Claude/Codex stop, Cmd-P/T search, resume, registry and terminal history',
    (tester) async {
      final previousDebugPrint = debugPrint;
      debugPrint = debugPrintSynchronously;
      addTearDown(() => debugPrint = previousDebugPrint);
      final http = HttpClient();
      addTearDown(() => http.close(force: true));
      Future<Map<String, dynamic>> get(String path) async {
        final response = await (await http.getUrl(Uri.parse('$endpoint$path')))
            .close();
        final body = jsonDecode(
          await utf8.decoder.bind(response).join(),
        ) as Map<String, dynamic>;
        expect(response.statusCode, 200, reason: '$body');
        return body;
      }

      late AppNotifier app;
      final events = <String>[];
      Future<void> until(bool Function() condition, String label) async {
        final waiting = Stopwatch()..start();
        while (!condition() && waiting.elapsed < const Duration(seconds: 60)) {
          await tester.pump(const Duration(milliseconds: 100));
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        // Socket events can arrive during the real-time delay after a pump.
        // Present their enabled controls before the next simulated click.
        await tester.pump();
        if (!condition()) {
          debugPrint('Timed out waiting for $label after ${waiting.elapsed}');
          debugPrint(events.join('\n'));
          debugPrint(
            'Fixture agents: ${app.stateOf('m')?.agents.map((a) => (a.id, a.status, a.launchState, a.launchError))}',
          );
          for (final pane in app.allPanes) {
            debugPrint(
              'Fixture pane ${pane.agentId}: ${pane.session?.status} ${pane.session?.errorMessage} stream=${pane.session?.streamId} ${pane.session?.terminal.buffer.getText()}',
            );
          }
        }
        expect(condition(), isTrue, reason: label);
      }

      final data = await get('/fixtures');
      final connection = WsConn(
        wsBaseUrl: '',
        autonomousEnv: 'test',
        machineId: 'm',
        transportKind: WsTransportKind.localPlaintext,
        localWsUri: Uri.parse(
          '${endpoint.replaceFirst('http:', 'ws:')}/api/local-ws',
        ),
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (frame) {
          if (const [
            'agent_synced',
            'terminal_ready',
            'terminal_closed',
            'terminal_error',
          ].contains(frame['type'])) {
            events.add('Fixture event: ${jsonEncode(frame)}');
            if (events.length > 40) events.removeAt(0);
          }
          return app.handleEventForTest('m', frame);
        },
        onStatus: (_) {},
      );
      app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      addTearDown(connection.close);
      // The test injection supplies the same binary dispatch normally wired by the connection pool.
      connection.onBinaryFrame = (raw) async {
        final frame = decodeTerminalLocal(raw);
        if (frame == null) return;
        for (final pane in app.allPanes) {
          if (pane.session?.streamId == frame.streamId) {
            await pane.session!.handleBinary(frame);
          }
        }
      };
      await connection.connect();
      await connection.waitUntilReady(timeout: const Duration(seconds: 10));
      final inventory = await connection.request(
        'agents_list',
        payload: {'includeStopped': true},
      );
      app.machineStates['m']!
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agents = (inventory['agents'] as List)
            .map((a) => Agent.fromJson(Map<String, dynamic>.from(a)))
            .toList();
      await app.reloadMachineData('m');
      expect(app.stateOf('m')!.terminalCapabilityAvailable, isTrue);
      final anchorId = data['anchorId'] as String;
      await app.addAgentToSwarm('m', anchorId);
      final originalTab = app.activeSwarmId;
      await mount(tester, app);

      for (final raw in data['fixtures'] as List) {
        final fixture = Map<String, dynamic>.from(raw);
        final id = fixture['agentId'] as String;
        final engine = fixture['engine'] as String;
        final marker = fixture['marker'] as String;
        debugPrint('Native manager verification: $engine');
        Future<Map<String, dynamic>> open(LogicalKeyboardKey key) async {
          // A network receipt can finish before the frame that moves keyboard
          // focus away from the removed terminal.
          await tester.pump();
          await chord(tester, key);
          if (key == LogicalKeyboardKey.keyT) {
            await chord(tester, LogicalKeyboardKey.keyP);
          }
          await tester.pump();
          await tester.enterText(
            find.byKey(const ValueKey('swarm-search-input')),
            'Native $engine fixture',
          );
          await tester.pump();
          expect(find.textContaining('Stopped'), findsNothing);
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pump();
          expect(find.byType(AlertDialog), findsNothing);
          await until(
            () => app.allPanes.any(
              (p) =>
                  p.agentId == id &&
                  (p.session?.terminal.buffer.getText().contains(marker) ??
                      false),
            ),
            '$engine original history reaches the desktop terminal',
          );
          await until(
            () => app
                .stateOf('m')!
                .agents
                .any((a) => a.id == id && a.launchState == 'ready'),
            '$engine native hook confirms resume',
          );
          expect(app.allPanes.any((p) => p.agentId == anchorId), isTrue);
          expect(app.swarms.any((s) => s.id == originalTab), isTrue);
          final verified = await get('/verify?id=$id');
          expect(verified['sessionId'], fixture['sessionId']);
          expect(verified['ready'], true);
          return verified;
        }

        var previous = await open(LogicalKeyboardKey.keyP);
        for (final key in [LogicalKeyboardKey.keyP, LogicalKeyboardKey.keyT]) {
          expect(await app.deleteAgent('m', id), isNull);
          await until(
            () =>
                app.stateOf('m')!.agents.any((a) => a.id == id && a.isStopped),
            '$engine remains searchable after Stop',
          );
          expect((await get('/verify?id=$id'))['stopped'], true);
          final resumed = await open(key);
          expect(resumed['pane'], isNot(previous['pane']));
          expect(resumed['pid'], isNot(previous['pid']));
          previous = resumed;
        }
        // Opening an already-running harness must preserve its native process.
        final attached = await open(LogicalKeyboardKey.keyP);
        expect(attached['pid'], previous['pid']);
        expect(attached['pane'], previous['pane']);
        expect(await app.deleteAgent('m', id), isNull);

        // Exercise the actual manager against native engine processes and disk
        // history, including rapid double clicks and repeated background resume.
        final toggle = find.byKey(
          ValueKey('session-toggle:${agentDestinationId('m', id)}'),
        );
        for (var cycle = 0; cycle < 3; cycle++) {
          debugPrint('Native manager $engine cycle ${cycle + 1}/3');
          await until(
            () =>
                app.stateOf('m')!.agents.any((a) => a.id == id && a.isStopped),
            '$engine saved row before manager cycle $cycle',
          );
          await tester.tap(find.byTooltip('Harnesses'));
          await tester.pump();
          await tester.tap(toggle);
          await tester.tap(toggle);
          await until(
            () => app
                .stateOf('m')!
                .agents
                .any(
                  (a) => a.id == id && !a.isStopped && a.launchState == 'ready',
                ),
            '$engine manager resume $cycle',
          );
          await until(
            () => !app.restartAttempt('m', id).busy,
            '$engine resume receipt $cycle',
          );
          expect(find.byType(HarnessSessionManager), findsOneWidget);
          expect(
            app.allPanes.any((p) => p.agentId == id),
            isFalse,
            reason: 'Play resumes in the background',
          );
          final resumed = await get('/verify?id=$id');
          expect(resumed['sessionId'], fixture['sessionId']);
          expect(resumed['pid'], isNot(previous['pid']));
          previous = resumed;

          expect(
            tester
                .widget<Semantics>(
                  find.byKey(
                    ValueKey('session-open:${agentDestinationId('m', id)}'),
                  ),
                )
                .properties
                .enabled,
            isTrue,
          );
          await tester.tap(
            find.byKey(ValueKey('session-open:${agentDestinationId('m', id)}')),
          );
          await until(
            () => app.allPanes.any(
              (p) =>
                  p.agentId == id &&
                  (p.session?.terminal.buffer.getText().contains(marker) ??
                      false),
            ),
            '$engine manager restores original terminal history $cycle',
          );
          expect(app.allPanes.any((p) => p.agentId == anchorId), isTrue);
          expect(find.byType(HarnessSessionManager), findsNothing);
          await tester.tap(find.byTooltip('Harnesses'));
          await tester.pump();
          await tester.tap(toggle);
          await tester.tap(toggle);
          await until(
            () =>
                app
                    .stateOf('m')!
                    .agents
                    .any((a) => a.id == id && a.isStopped) &&
                app.pendingAgentPause('m', id) == null,
            '$engine manager pause $cycle',
          );
          expect((await get('/verify?id=$id'))['stopped'], true);
          expect(app.allPanes.any((p) => p.agentId == id), isFalse);
          expect(app.allPanes.any((p) => p.agentId == anchorId), isTrue);
          expect(find.byType(HarnessSessionManager), findsOneWidget);
          await tester.tap(find.byTooltip('Close harnesses'));
          await tester.pump();
        }
      }
      await tester.pumpWidget(const SizedBox());
    },
    timeout: const Timeout(Duration(minutes: 8)),
    // Let macOS own accessibility activation, as it does in production. A test
    // handle retained across app deactivation keeps Dart's tree alive after the
    // native bridge is reset; its next partial update can be mistaken for a root.
    semanticsEnabled: false,
  );
}
