// Run explicitly: flutter test test/benchmarks/background_reads_benchmark.dart --reporter expanded
// The reads an idle signed-in window makes on its own (WebSocket roadmap, Phase 2 item 4): ten simulated minutes of
// the experimental settings poll and of an offline machine's poll while an agent waits on it, counted, and the cost of
// one experiments read in this process. Headless: no network, no display, no app CPU. Run it on two builds and compare.
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/state/app_state.dart';

const _offline = Machine(
  machineId: 'm',
  name: 'Sleeping computer',
  authMode: MachineAuthMode.remote,
  status: 'offline',
);

class _Settings implements ExperimentalSettingsTransport {
  int reads = 0;
  @override
  Future<Map<String, dynamic>> read() async {
    reads++;
    return {
      'accountId': 'a',
      'revision': 1,
      'features': {for (final f in ExperimentalFeature.values) f.id: false},
    };
  }

  @override
  Future<Map<String, dynamic>> write(
    String accountId,
    ExperimentalFeature feature,
    bool enabled,
  ) => throw UnimplementedError();
}

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());
  int reads = 0;
  @override
  Future<List<Machine>> machines() async {
    reads++;
    return const [_offline];
  }
}

void main() {
  test('background reads of an idle window over ten minutes', () {
    const window = Duration(minutes: 10);
    final settings = _Settings();
    final api = _Api();
    fakeAsync((async) {
      // As the app makes it, outside tests: its own default timer.
      final store = ExperimentalFeaturesStore()..bind('a', transport: settings);
      final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession())
        ..status = AppStatus.authenticated
        ..api = api;
      app.machines = [_offline];
      app.machineStates['m'] = MachineState(_offline)
        ..nodeOnline = true
        ..pendingOfflineAgentId = 'a';
      app.handleEventForTest('m', {
        'type': 'node_status',
        'payload': {'online': false},
      });
      async.flushMicrotasks();
      async.elapse(window);
      store.dispose();
      app.dispose();
      async.flushMicrotasks();
    });

    // One experiments read through the store, as the timer makes it, timed for real.
    final timed = <int>[];
    final store = ExperimentalFeaturesStore(pollInterval: Duration.zero)
      ..bind('a', transport: _Settings());
    return () async {
      for (var i = 0; i < 200; i++) {
        final watch = Stopwatch()..start();
        await store.refresh();
        timed.add(watch.elapsedMicroseconds);
      }
      store.dispose();
      timed.sort();
      // ignore: avoid_print
      print(
        jsonEncode({
          'simulatedMinutes': window.inMinutes,
          'experimentReads': settings.reads,
          'offlineMachineListReads': api.reads,
          'experimentReadMicroseconds': {
            'p50': timed[timed.length ~/ 2],
            'p95': timed[(timed.length * 95) ~/ 100],
            'max': timed.last,
          },
        }),
      );
    }();
  });
}
