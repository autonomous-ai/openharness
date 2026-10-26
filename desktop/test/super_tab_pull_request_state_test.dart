import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/rename_connection.dart';
import 'swarm_state_test.dart' show createApp;

class LinkedPrConnection extends RenameConnection {
  final requests = <Map<String, dynamic>>[];
  final pending = <Completer<Map<String, dynamic>>>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'git_pull_requests_status') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    requests.add(payload);
    final reply = Completer<Map<String, dynamic>>();
    pending.add(reply);
    return reply.future;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('reads with the local computer even when an unrelated remote machine is selected', () async {
    final local = LinkedPrConnection(), remote = LinkedPrConnection();
    final app = createApp(
      connectionForTest: (id) => id == 'm' ? local : remote,
    );
    addTearDown(app.dispose);
    app.stateOf('m')!
      ..localOnly = true
      ..agents = [];
    app.machineStates['remote'] = MachineState(
      const Machine(
        machineId: 'remote',
        authMode: MachineAuthMode.remote,
        name: 'Other',
      ),
    );
    app.selectedMachineId = 'remote';
    final result = app.readPullRequestsStatus([
      'https://github.com/o/r/pull/1',
    ]);
    expect(local.requests.single, {
      'urls': ['https://github.com/o/r/pull/1'],
    });
    expect(remote.requests, isEmpty);
    local.pending.last.complete({
      'rows': [
        {'state': 'Merged', 'title': 'Already done'},
      ],
    });
    expect(await result, {
      'rows': [
        {'state': 'Merged', 'title': 'Already done'},
      ],
    });
  });
  test('preserves typed refusals and partial answers, including older-daemon unsupported', () async {
    for (final code in [
      'UNSUPPORTED',
      'GH_MISSING',
      'GH_SIGNED_OUT',
      'TIMEOUT',
    ]) {
      final connection = LinkedPrConnection();
      final app = createApp(connectionForTest: (_) => connection);
      app.stateOf('m')!.localOnly = true;
      final result = app.readPullRequestsStatus([]);
      connection.pending.last.completeError(
        WsRequestFailure(
          responseType: 'git_pull_requests_status_result',
          code: code,
          payload: {
            'rows': [
              {'title': 'Readable'},
            ],
          },
        ),
      );
      expect(await result, {
        'error': code,
        'rows': [
          {'title': 'Readable'},
        ],
      });
      app.dispose();
    }
  });
  test('does not apply an answer from a replaced machine or a disconnected request', () async {
    final connection = LinkedPrConnection(),
        app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    app.stateOf('m')!.localOnly = true;
    final result = app.readPullRequestsStatus([]);
    app.machineStates['m'] = MachineState(app.stateOf('m')!.machine)
      ..localOnly = true;
    connection.pending.last.complete({
      'rows': [
        {'title': 'Old account'},
      ],
    });
    expect(await result, {'error': 'UNAVAILABLE'});
    final failed = app.readPullRequestsStatus([]);
    connection.pending.last.completeError(StateError('Disconnected'));
    expect(await failed, {'error': 'UNAVAILABLE'});
    app.stateOf('m')!.localOnly = false;
    expect(await app.readPullRequestsStatus([]), {
      'error': 'LOCAL_GITHUB_UNAVAILABLE',
    });
  });
}
