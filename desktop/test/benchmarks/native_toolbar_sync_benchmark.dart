// Explicit, headless native-toolbar benchmark. Uses in-memory inventories and
// a mocked platform channel; no agents, network, real windows or disk scans.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';

import '../swarm_screen_test.dart' show mount;

class _App extends AppNotifier {
  _App(int saved, int working)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (_) => throw StateError('No benchmark transport'),
      ) {
    const machine = Machine(
      machineId: 'fixture',
      name: 'Fixture',
      authMode: MachineAuthMode.remote,
    );
    machines = [machine];
    machineStates['fixture'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        for (var i = 0; i < 25; i++)
          Agent(
            id: 'live-$i',
            name: 'Live $i',
            engine: 'codex',
            terminalAvailable: true,
          ),
        for (var i = 0; i < saved; i++)
          Agent(
            id: 'saved-$i',
            name: 'Saved $i',
            engine: 'codex',
            status: 'stopped',
          ),
      ];
    machineStates['fixture']!.processingAgentIds.addAll([
      for (var i = 0; i < working; i++) 'live-$i',
    ]);
    for (var i = 0; i < 25; i++) {
      rememberOpenedHarness('fixture', 'live-$i');
    }
    for (var i = 0; i < saved; i++) {
      rememberOpenedHarness('fixture', 'saved-$i');
    }
    renameSwarm(activeSwarmId, 'Fixture');
  }

  int historyReads = 0;

  // During the measured notification/microtask turn (without a frame), this
  // getter is read by the toolbar's closed-history payload construction.
  @override
  List<ClosedWork> get closedHistory {
    historyReads++;
    return super.closedHistory;
  }

  void announce() => notifyListeners();
}

void main() {
  testWidgets('native toolbar notification workload', (tester) async {
    const channel = MethodChannel('harness/swarm_tabs');
    Map? latest;
    var messages = 0;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'update') {
        latest = call.arguments as Map;
        messages++;
      }
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    final results = <Map<String, Object?>>[];
    for (final (saved, working) in [(64, 0), (1000, 0), (4096, 0), (1000, 4)]) {
      debugPrint('NATIVE_SYNC_SETUP saved=$saved working=$working');
      final app = _App(saved, working);
      await mount(tester, app, nativeTabs: true);
      debugPrint('NATIVE_SYNC_MOUNTED saved=$saved');
      await tester.pumpAndSettle();
      debugPrint('NATIVE_SYNC_READY saved=$saved');
      for (final notifications in [1, 4, 16]) {
        // The baseline's status menu is quadratic in saved history. Keep all
        // inventory sizes and bursts, but avoid minutes of duplicate work.
        final warmupTurns = saved >= 4096 ? 5 : 20;
        final turnsPerRound = saved >= 4096 ? 4 : 20;
        Future<int> turn() async {
          app.historyReads = 0;
          for (var i = 0; i < notifications; i++) {
            app.announce();
          }
          await tester.idle();
          return app.historyReads;
        }

        for (var i = 0; i < warmupTurns; i++) {
          await turn();
        }
        final rounds = <double>[];
        final readCounts = <int>{};
        final initialMessages = messages;
        for (var round = 0; round < 7; round++) {
          final watch = Stopwatch()..start();
          for (var i = 0; i < turnsPerRound; i++) {
            readCounts.add(await turn());
          }
          watch.stop();
          rounds.add(watch.elapsedMicroseconds / turnsPerRound);
        }
        final sorted = [...rounds]..sort();
        debugPrint(
          'NATIVE_SYNC_MEASURED saved=$saved notifications=$notifications reads=$readCounts',
        );
        results.add({
          'live': 25,
          'saved': saved,
          'working': working,
          'notificationsPerTurn': notifications,
          'warmupTurns': warmupTurns,
          'turnsPerRound': turnsPerRound,
          'historyPayloadReadsPerTurn': readCounts.toList()..sort(),
          'medianMicrosecondsPerTurn': sorted[sorted.length ~/ 2],
          'roundMicrosecondsPerTurn': rounds,
          'platformMessagesDuringMeasurement': messages - initialMessages,
          'finalPayload': jsonDecode(
            jsonEncode(latest).replaceAll(app.activeSwarmId, 'fixture-tab'),
          ),
        });
      }
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
    final result = {
      'kind': 'headless_debug_notification_and_microtask_elapsed',
      'rounds': 7,
      'scope': 'Full native toolbar construction with unchanged inventory notifications; excludes Flutter frames, AppKit, transport, agents and whole-app energy.',
      'results': results,
    };
    final path = Platform.environment['HARNESS_NATIVE_SYNC_BENCH_OUTPUT'];
    if (path != null) {
      File(path).writeAsStringSync('${jsonEncode(result)}\n');
    }
    debugPrint(
      'NATIVE_SYNC_BENCH ${jsonEncode({
        for (final entry in result.entries)
          if (entry.key != 'results') entry.key: entry.value,
        'results': [
          for (final row in results) {for (final entry in row.entries)
              if (entry.key != 'finalPayload') entry.key: entry.value},
        ],
      })}',
    );
  });
}
