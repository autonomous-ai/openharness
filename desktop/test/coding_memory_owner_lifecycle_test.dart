import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'swarm_state_test.dart' show createApp;

LocalCliEndpoint endpoint({int port = 18473}) => LocalCliEndpoint(
  computerId: 'fixture-computer',
  machineId: 'm',
  wsUri: Uri.parse('ws://127.0.0.1:$port/api/web-ws'),
  protocolVersion: 1,
  terminalProtocolVersion: 1,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'memory inspection does not provision an endpoint or use a relayed machine',
    () {
      final app = createApp();
      addTearDown(app.dispose);
      expect(app.openCodingMemoryConnection(), isNull);
      expect(app.machineStates['m']!.localEndpoint, isNull);
    },
  );

  test('discovery refresh preserves the same owner, account replacement invalidates it immediately', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.currentUser = const CurrentUserProfile(
      id: 'fixture-one',
      email: 'one@example.test',
    );
    app.machineStates['m']!.localEndpoint = endpoint();
    final connection = app.openCodingMemoryConnection()!;
    addTearDown(connection.dispose);
    var invalidations = 0;
    connection.addListener(() {
      if (!connection.valid) invalidations++;
    });
    app.machineStates['m']!.localEndpoint = endpoint();
    expect(connection.valid, isTrue);
    app.currentUser = const CurrentUserProfile(
      id: 'fixture-two',
      email: 'two@example.test',
    );
    expect(connection.valid, isFalse);
    expect(invalidations, 1);
  });

  test('endpoint replacement and app disposal cannot retain owner access', () {
    final app = createApp();
    app.machineStates['m']!.localEndpoint = endpoint();
    final old = app.openCodingMemoryConnection()!;
    app.machineStates['m']!.localEndpoint = endpoint(port: 18474);
    expect(old.valid, isFalse);
    final current = app.openCodingMemoryConnection()!;
    expect(current.valid, isTrue);
    app.dispose();
    expect(current.valid, isFalse);
    old.dispose();
    current.dispose();
  });
}
