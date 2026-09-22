import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'agent_pager_fixture.dart';

/// A machine whose relay session has gone stale: the transport still calls
/// itself connected, and every request into it runs out its clock.
///
/// This is the shape of the real failure — a relayed machine's own Harness
/// restarting drops its in-memory session without ever closing the socket, so
/// nothing fires `onDone` and no screen goes wrong. Measured on a phone at 16
/// minutes of a frozen agent list, with the desk tab holding those agents
/// drawn as an empty tab.
class _StaleConn extends PagerConn {
  bool answering = false;
  int asked = 0;
  int redials = 0;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agents_list') return {};
    asked++;
    if (answering) return {'agents': const []};
    throw const WsRequestTimeout('agents_list');
  }

  @override
  Future<void> forceReconnect() async => redials++;
}

void main() {
  late _StaleConn conn;
  late AppNotifier app;

  setUp(() {
    conn = _StaleConn();
    app = pagerApp(conn, viewer: true);
  });

  tearDown(() => app.dispose());

  test('one timed-out tick is not enough to redial', () async {
    await app.syncAgentsForTest('m');

    expect(conn.asked, 1);
    expect(conn.redials, 0);
    // Untouched: a single missed tick is a busy machine, and every screen
    // should go on showing what it was showing.
    expect(app.stateOf('m')!.nodeOnline, isTrue);
    expect(app.stateOf('m')!.agents, hasLength(pagerAgentIds.length));
  });

  test('two in a row take the machine down and dial it again', () async {
    for (var tick = 0; tick < AppNotifier.agentSyncStaleTicks; tick++) {
      await app.syncAgentsForTest('m');
    }

    expect(conn.redials, 1);
    expect(app.stateOf('m')!.nodeOnline, isFalse);
  });

  test('an answer in between starts the count over', () async {
    await app.syncAgentsForTest('m');
    conn.answering = true;
    await app.syncAgentsForTest('m');
    conn.answering = false;
    await app.syncAgentsForTest('m');

    // The machine answered, so the two timeouts either side of it are not two
    // in a row and nothing is torn down.
    expect(conn.redials, 0);
    expect(app.stateOf('m')!.nodeOnline, isTrue);
  });

  test('a machine that keeps timing out is redialled again, not once', () async {
    for (var tick = 0; tick < AppNotifier.agentSyncStaleTicks * 2; tick++) {
      await app.syncAgentsForTest('m');
    }

    // The count resets after each redial, so a machine that is still dead a
    // minute later is dialled again rather than left on one attempt forever.
    expect(conn.redials, 2);
  });

  test('a disconnected machine is not polled at all', () async {
    app.stateOf('m')!.connectionStatus = ConnectionStatus.reconnecting;

    await app.syncAgentsForTest('m');

    // Its own redial is already in flight; a tick here would only race it.
    expect(conn.asked, 0);
    expect(conn.redials, 0);
  });
}
