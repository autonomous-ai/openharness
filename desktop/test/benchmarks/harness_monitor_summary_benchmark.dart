// Explicit component benchmark. No real agents, network, windows, or disk scans.
// Copy this fixture to the baseline checkout and pass
// --dart-define=HARNESS_RESOURCE_BENCH_LEGACY=true to use its original getters.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/harness_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_monitor.dart';
import 'package:harness/state/harness_sessions.dart';

class _App extends AppNotifier {
  _App(int liveCount, int savedCount)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    for (var m = 0; m < 3; m++) {
      final id = 'machine-$m';
      machineStates[id] =
          MachineState(Machine(machineId: id, authMode: MachineAuthMode.remote))
            ..nodeOnline = true
            ..connectionStatus = ConnectionStatus.connected
            ..agents = [
              for (var i = m; i < liveCount; i += 3)
                Agent(id: 'a$i', name: 'Live $i', terminalAvailable: true),
              for (var i = m; i < savedCount; i += 3)
                Agent(id: 'saved$i', name: 'Saved $i', status: 'stopped'),
            ];
      for (var i = m; i < savedCount; i += 3) {
        rememberOpenedHarness(id, 'saved$i');
      }
    }
  }

  @override
  Future<MachineHarnessResources?> readHarnessResources(String id) async =>
      MachineHarnessResources(
        sampledAt: DateTime.now(),
        agents: {
          for (final agent in machineStates[id]!.agents)
            if (!agent.isStopped)
              agent.id: const HarnessResources(
                cpuPercent: 1.5,
                memoryBytes: 150e6,
                gpuPercent: 0,
                workspacePath: '/fixture/workspace',
                workspaceBytes: 1e9,
              ),
        },
        shared: [
          (
            machineStates[id]!.agents.map((a) => a.id).toSet(),
            const HarnessResources(memoryBytes: 400e6, cpuPercent: 2),
          ),
        ],
      );
}

class _Monitor extends HarnessMonitor {
  _Monitor(super.app);
  int inventoryReads = 0;
  @override
  List<HarnessSession> get sessions {
    inventoryReads++;
    return super.sessions;
  }
}

// Match the monitor fields constructed by SwarmScreen._syncNative.
List<String> _footer(_Monitor monitor) {
  // Dynamic only at this benchmark seam: the exact baseline has no `summary`.
  dynamic summary = monitor;
  if (!const bool.fromEnvironment('HARNESS_RESOURCE_BENCH_LEGACY')) {
    summary = summary.summary;
  }
  return [
    summary.label,
    summary.detail,
    summary.detail,
    summary.label,
    summary.metricsLabel(),
    summary.resourceDetail,
    summary.resourceDetail,
    summary.metricsLabel(),
    summary.metricsLabel(storage: false),
    summary.metricsLabel(gpu: false, storage: false),
    summary.metricsLabel(ram: false, gpu: false, storage: false),
  ];
}

void main() {
  test('resource summary workload', () async {
    final results = <Map<String, Object>>[];
    for (final (live, saved) in [(16, 64), (25, 1000), (105, 4096)]) {
      final app = _App(live, saved);
      final monitor = _Monitor(app);
      try {
        await monitor.refresh();
        final expected = _footer(monitor);
        for (var warmup = 0; warmup < 20; warmup++) {
          expect(_footer(monitor), expected);
        }
        final rounds = <double>[];
        monitor.inventoryReads = 0;
        _footer(monitor);
        final reads = monitor.inventoryReads;
        for (var round = 0; round < 7; round++) {
          final watch = Stopwatch()..start();
          for (var i = 0; i < 40; i++) {
            final fields = _footer(monitor);
            if (fields.length != expected.length ||
                fields.first != expected.first) {
              fail('Footer changed during the fixed fixture');
            }
          }
          watch.stop();
          rounds.add(watch.elapsedMicroseconds / 40);
        }
        expect(_footer(monitor), expected);
        final result = <String, Object>{
          'live': live,
          'saved': saved,
          'legacy': const bool.fromEnvironment('HARNESS_RESOURCE_BENCH_LEGACY'),
          'inventoryReadsPerFooter': reads,
          'microsecondsPerFooterByRound': rounds,
          'footer': expected,
        };
        results.add(result);
        // ignore: avoid_print
        print('HARNESS_RESOURCE_SUMMARY_BENCH ${jsonEncode(result)}');
      } finally {
        monitor.dispose();
        app.dispose();
      }
    }
    final path = Platform.environment['HARNESS_RESOURCE_BENCH_OUTPUT'];
    if (path != null) {
      final file = File(path);
      if (file.existsSync()) fail('Refusing to overwrite benchmark evidence');
      file.writeAsStringSync(
        '${jsonEncode({'scope': 'Headless Debug monitor-field construction; not whole-app CPU, energy or frame latency.', 'at': DateTime.now().toUtc().toIso8601String(), 'results': results})}\n',
      );
    }
  });
}
