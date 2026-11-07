import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/restart_connection.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late RestartConnection connection;
  late AppNotifier app;
  setUp(() {
    connection = RestartConnection();
    app = createApp(connectionForTest: (_) => connection);
  });
  tearDown(() => app.dispose());
  String id() => connection.requests.last['creationId'] as String;

  test('restart sends launchArgs and reads the echo as honoured', () async {
    final request = app.restartAgent('m', 'a0', launchArgs: '--chrome');
    expect(connection.requests.single['launchArgs'], '--chrome');
    connection.restartReplies.single.complete({
      ...restartReceipt(id()),
      'launchArgs': ['--chrome'],
    });
    final result = await request;
    expect(result.error, isNull);
    expect(result.launchArgsIgnored, isFalse);
  });

  test('an empty string is still sent, to clear the saved flags', () async {
    final request = app.restartAgent('m', 'a0', launchArgs: '');
    expect(connection.requests.single['launchArgs'], '');
    connection.restartReplies.single.complete({
      ...restartReceipt(id()),
      'launchArgs': <String>[],
    });
    expect((await request).launchArgsIgnored, isFalse);
  });

  test('a created reply with no echo means an old daemon', () async {
    final request = app.restartAgent('m', 'a0', launchArgs: '--chrome');
    connection.restartReplies.single.complete(restartReceipt(id()));
    final result = await request;
    expect(result.error, isNull);
    expect(result.launchArgsIgnored, isTrue);
  });

  test(
    'without launchArgs the payload has none and nothing is ignored',
    () async {
      final request = app.restartAgent('m', 'a0');
      expect(connection.requests.single.containsKey('launchArgs'), isFalse);
      connection.restartReplies.single.complete(restartReceipt(id()));
      expect((await request).launchArgsIgnored, isFalse);
    },
  );

  test('a status check never sends launchArgs or reports ignored', () async {
    final attempt = app.restartAttempt('m', 'a0');
    var request = app.restartAgent(
      'm',
      'a0',
      attempt: attempt,
      launchArgs: '--chrome',
    );
    connection.restartReplies.single.completeError(
      const WsRequestTimeout('agent_restart'),
    );
    expect((await request).error, contains('not confirmed'));
    request = app.restartAgent(
      'm',
      'a0',
      attempt: attempt,
      launchArgs: '--chrome',
    );
    expect(connection.checks.single.containsKey('launchArgs'), isFalse);
    connection.checkReplies.single.complete(restartReceipt(id()));
    final result = await request;
    expect(result.error, isNull);
    expect(result.launchArgsIgnored, isFalse);
    expect(connection.requests, hasLength(1));
  });

  test('a refusal carries the daemon detail and is marked', () async {
    final request = app.restartAgent('m', 'a0', launchArgs: '--model x');
    connection.restartReplies.single.completeError(
      const WsRequestFailure(
        responseType: 'agent_restart_result',
        code: 'INVALID_LAUNCH_ARGS',
        detail: "--model is set by Harness and can't be added here.",
      ),
    );
    final result = await request;
    expect(result.error, "--model is set by Harness and can't be added here.");
    expect(result.launchArgsRefused, isTrue);
  });

  for (final code in ['RESTART_FAILED', 'RESUME_UNCONFIRMED']) {
    test(
      '$code and an unconfirmed receipt mean the engine did not start',
      () async {
        final request = app.restartAgent('m', 'a0', launchArgs: '--bad');
        connection.restartReplies.single.completeError(
          WsRequestFailure(responseType: 'agent_restart_result', code: code),
        );
        expect((await request).engineNotStarted, isTrue);
      },
    );
  }

  test('a lost reply is not read as the engine not starting', () async {
    final request = app.restartAgent('m', 'a0', launchArgs: '--bad');
    connection.restartReplies.single.completeError(
      const WsRequestTimeout('agent_restart'),
    );
    final result = await request;
    expect(result.error, isNotNull);
    expect(result.engineNotStarted, isFalse);
  });

  test('Agent.fromJson keeps only string launchArgs', () {
    final agent = Agent.fromJson({
      'id': 'a1',
      'launchArgs': ['--chrome', 3],
    });
    expect(agent.launchArgs, ['--chrome']);
    expect(Agent.fromJson({'id': 'a1'}).launchArgs, isEmpty);
    expect(Agent.fromJson({'id': 'a1', 'launchArgs': 'x'}).launchArgs, isEmpty);
  });
}
