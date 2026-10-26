import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';

import 'support/rename_connection.dart';
import 'swarm_state_test.dart' show createApp;

/// Records what this Mac's daemon is asked; no socket is opened.
class _Daemon extends RenameConnection {
  final asked = <Map<String, dynamic>>[];
  Map<String, dynamic> answer = {'ok': true, 'state': 'started'};

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'super_tabs' && payload['action'] == 'teamSetup') {
      asked.add(Map.of(payload));
      return Future.value(answer);
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Daemon daemon;
  late AppNotifier app;
  setUp(() {
    daemon = _Daemon();
    app = createApp(connectionForTest: (_) => daemon, connected: true);
    app.machineStates['m']!.localOnly = true;
    app.macOSForTest = true;
  });
  tearDown(() => app.dispose());

  test(
    'asks this Mac\'s own daemon, with the moment the person is here',
    () async {
      await app.offerTeamAccount('join');
      await app.offerTeamAccount('contribute');
      expect(daemon.asked, [
        {'action': 'teamSetup', 'reason': 'join'},
        {'action': 'teamSetup', 'reason': 'contribute'},
      ]);
    },
  );

  test(
    'asks nothing off a Mac, or when the only machine here is another one',
    () async {
      app.macOSForTest = false;
      await app.offerTeamAccount('join');
      app.macOSForTest = true;
      app.machineStates['m']!.localOnly = false;
      await app.offerTeamAccount('join');
      expect(daemon.asked, isEmpty);
    },
  );

  test('a daemon that refuses or cannot say is left alone', () async {
    daemon.answer = {'error': 'UNKNOWN_ACTION'};
    await app.offerTeamAccount('join');
    expect(daemon.asked, hasLength(1));
  });

  test('offers once a launch, as this Mac\'s daemon first connects', () async {
    app.onMachineConnectedForTest('m');
    app.onMachineConnectedForTest('m');
    await pumpEventQueue();
    expect(daemon.asked, [
      {'action': 'teamSetup', 'reason': 'startup'},
    ]);
  });
}
