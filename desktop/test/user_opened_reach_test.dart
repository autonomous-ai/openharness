// A person opening the Store or the Models panel marks that one list request
// `userAction`, which is all the daemon counts as the list's reach
// (docs/plans/2026-10-14-user-opened-reach.md). The refreshes and probes the
// app makes on its own carry no mark.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final calls = <(String, Map<String, dynamic>)>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((type, Map.of(payload)));
    return type == 'dsh_list' ? {'dsh': []} : {};
  }

  List<bool> marks(String type) => [
    for (final (t, payload) in calls)
      if (t == type) payload['userAction'] == true,
  ];
}

void main() {
  test(
    'opening the Store marks one dsh_list, and the Store\'s own probes do not',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      app.stateOf('m')!.localOnly = true;

      // A Store tab restored at launch was not opened by anyone.
      expect(app.takeStoreOpened(), isFalse);
      app.openStore();
      // The Store tab's first ask takes the mark, once.
      expect(app.takeStoreOpened(), isTrue);
      expect(app.takeStoreOpened(), isFalse);
      // Already on the Store: nothing was opened.
      app.openStore();
      expect(app.takeStoreOpened(), isFalse);

      await app.probeDsh('m', force: true, userAction: true);
      await app.probeDsh('m', force: true);
      expect(connection.marks('dsh_list'), [true, false]);
    },
  );

  test('opening the Models panel marks one grid_models_list, and the surfaces\' reads do not', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    app.stateOf('m')!.localOnly = true;

    app.markModelsOpened();
    await app.refreshGridModels('m');
    await app.refreshGridModels('m');
    expect(connection.marks('grid_models_list'), [true, false]);
    expect(connection.calls.first.$2['rowState'], isTrue);
  });
}
