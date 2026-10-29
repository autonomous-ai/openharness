import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

const _offline = Machine(
  machineId: 'm',
  name: 'Fixture computer',
  authMode: MachineAuthMode.remote,
  status: 'offline',
);

/// The account's machine list, with that machine still off, counted.
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
  test('an offline machine waiting with an agent is asked about at 5, 10, 20 s, then every 30 s', () {
    // Each ask is a whole machine-list read from the backend: every 5 s it was
    // 12 reads a minute for one sleeping computer, in every window. 30 s is
    // the backend's own retry-after for an offline machine.
    fakeAsync((async) {
      final api = _Api();
      final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession())
        ..status = AppStatus.authenticated
        ..api = api;
      final machine = MachineState(_offline)
        ..nodeOnline = true
        ..pendingOfflineAgentId = 'a';
      app.machines = [_offline];
      app.machineStates['m'] = machine;
      app.handleEventForTest('m', {
        'type': 'node_status',
        'payload': {'online': false},
      });
      async.flushMicrotasks();
      final seen = <int>[];
      for (var second = 1; second <= 125; second++) {
        final before = api.reads;
        async.elapse(const Duration(seconds: 1));
        if (api.reads > before) seen.add(second);
      }
      expect(seen, [5, 15, 35, 65, 95, 125]);
      // The window closed: no more asks.
      app.dispose();
      async.flushMicrotasks();
      final reads = api.reads;
      async.elapse(const Duration(minutes: 2));
      expect(api.reads, reads);
    });
  });
}
