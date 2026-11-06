import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/usage_controller.dart';
import 'package:harness/usage/usage_window.dart';

import 'super_tab_launch_test.dart';
import 'swarm_state_test.dart' show MemoryStore;

class ReportConnection extends SuperTabFixtureConnection {
  ReportConnection(super.store);
  var reads = 0;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'usage_read')
      return super.request(type, payload: payload, timeout: timeout);
    reads++;
    return {
      'providers': [
        {
          'provider': 'claude',
          'outcome': 'answered',
          'httpStatus': 200,
          'body': {
            'five_hour': {
              'utilization': 42,
              'resets_at': '2099-01-01T00:00:00Z',
            },
          },
        },
      ],
    };
  }
}

void main() {
  test(
    'this computer reports usage through its CLI and retains local identity',
    () async {
      late ReportConnection connection;
      final f = SuperTabLaunchFixture(
        connectionFactory: (MemoryStore store) =>
            connection = ReportConnection(store),
      );
      final usage = UsageController(
        autoStart: false,
        remote: f.app.readRemoteUsage,
      );
      addTearDown(usage.dispose);
      await usage.refresh();
      expect(connection.reads, 1);
      expect(usage.readings.single.provider, UsageProvider.claude);
      expect(usage.accounts.single.isLocal, isTrue);
      expect(usage.hasAnswer, isTrue);
    },
  );
}
