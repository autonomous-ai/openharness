import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

import 'support/rename_connection.dart';
import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

/// The daemon's reviewed deletion: `inspect` answers a review, `delete` acts on it.
class PurgeConnection extends RenameConnection {
  final purges = <Map<String, dynamic>>[];
  Map<String, dynamic> inspectReply = {'reviewId': 'review-1', 'sessionBytes': 1024};
  Map<String, dynamic> deleteReply = {'deleted': true, 'sessionDeleted': true};

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'agent_purge') {
      purges.add(payload);
      return Future.value(payload['mode'] == 'inspect' ? inspectReply : deleteReply);
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late PurgeConnection connection;
  late AppNotifier app;
  final created = DateTime.utc(2026, 10, 14, 3, 53, 20, 610);
  setUp(() {
    connection = PurgeConnection();
    app = createApp(connectionForTest: (_) => connection);
  });
  tearDown(() => app.dispose());

  test('Delete Harness reviews, then deletes under that review, and the harness leaves the list', () async {
    app.stateOf('m')!.agents = [
      Agent(id: 'a0', name: 'Codex', engine: 'codex', sessionId: 's0', createdAt: created, status: 'stopped'),
    ];
    final pane = app.adoptSessionForTest(terminal('a0', []));
    expect(await app.purgeAgent('m', 'a0'), isNull);
    expect(connection.purges, [
      {'agentId': 'a0', 'sessionId': 's0', 'createdAt': created.millisecondsSinceEpoch, 'mode': 'inspect'},
      {'agentId': 'a0', 'sessionId': 's0', 'createdAt': created.millisecondsSinceEpoch, 'mode': 'delete', 'reviewId': 'review-1'},
    ]);
    expect(app.stateOf('m')!.agents.any((a) => a.id == 'a0'), isFalse);
    expect(app.allPanes, isNot(contains(pane)));
  });

  test('a harness that never bound a conversation is named by no session', () async {
    app.stateOf('m')!.agents = [Agent(id: 'a0', name: 'Codex', engine: 'codex', createdAt: created)];
    expect(await app.purgeAgent('m', 'a0'), isNull);
    expect(connection.purges.first['sessionId'], isNull);
  });

  test('a refused review deletes nothing and says why', () async {
    app.stateOf('m')!.agents = [Agent(id: 'a0', name: 'Codex', engine: 'codex', sessionId: 's0', createdAt: created)];
    connection.inspectReply = {'error': 'DELETE_REFUSED', 'detail': 'Another harness uses this conversation.'};
    expect(await app.purgeAgent('m', 'a0'), 'Delete failed: Another harness uses this conversation.');
    expect(connection.purges.map((p) => p['mode']), ['inspect']);
    expect(app.stateOf('m')!.agents.any((a) => a.id == 'a0'), isTrue);
  });

  test('a delete that is not confirmed keeps the harness listed', () async {
    app.stateOf('m')!.agents = [Agent(id: 'a0', name: 'Codex', engine: 'codex', sessionId: 's0', createdAt: created)];
    connection.deleteReply = {};
    expect(await app.purgeAgent('m', 'a0'), contains('Could not confirm the deletion'));
    expect(app.stateOf('m')!.agents.any((a) => a.id == 'a0'), isTrue);
  });
}
