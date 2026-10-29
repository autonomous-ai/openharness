import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/launch.dart';
import 'package:harness/ws/ws_conn.dart';

import 'super_tab_launch_test.dart'
    show SuperTabLaunchFixture, SuperTabFixtureConnection, tabId;

// From the review of #2147 (Reviewer, 10-29). Transport fault after a
// committed response. Enforce the real backend's
// request-hash contract (store.ts:983-986) and lead-start guard (commands.ts:895),
// both of which ConversationServer omits.
class LostReplyConnection extends SuperTabFixtureConnection {
  LostReplyConnection(super.store, this.loseType);
  final String loseType;
  bool lost = false;
  final hashes = <String, String>{};
  final started = <String>{};
  final attempts = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final body = payload['body'];
    final command = body is Map ? body['command'] : null;
    final commandType = command is Map ? command['type'] : null;
    if (type == 'super_tabs' && payload['method'] == 'POST' && command is Map) {
      final id = body['operationId'] as String;
      attempts.add(Map<String, dynamic>.from(body));
      final hash = jsonEncode(command);
      if (hashes.containsKey(id) && hashes[id] != hash) {
        throw const WsRequestFailure(
          responseType: 'super_tabs_result',
          code: 'OPERATION_REUSED',
          detail: 'Use a new operation ID for a different request.',
        );
      }
      if (commandType == 'lead.start' &&
          !hashes.containsKey(id) &&
          started.contains(command['projectId'])) {
        throw const WsRequestFailure(
          responseType: 'super_tabs_result',
          code: 'LEAD_STARTING',
          detail: 'This project’s Product Manager is already starting.',
        );
      }
      final result = await super.request(
        type,
        payload: payload,
        timeout: timeout,
      );
      hashes[id] = hash;
      if (commandType == 'lead.start' && command['machineId'] != null) {
        started.add(command['projectId'] as String);
      }
      if (commandType == loseType && !lost) {
        lost = true;
        throw const WsRequestFailure(
          responseType: 'super_tabs_result',
          code: 'BACKEND_TIMEOUT',
          detail: 'The backend response timed out.',
          payload: {'status': 504},
        );
      }
      return result;
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

void configure(SuperTabLaunchFixture f) {
  f.app.machineStates['m']!.agents = [
    const Agent(
      id: 'old',
      name: 'Earlier',
      engine: 'codex',
      terminalAvailable: true,
      project: AgentProject(
        name: 'project',
        cwd: '/work/project',
        root: '/work/project',
        remote: 'git@github.com:autonomous-ai/lamp-os.git',
      ),
    ),
  ];
  f.connection.server.state['machines'] = [
    {
      'machineId': 'm',
      'name': 'Mac Studio',
      'contributorId': 'owner',
      'maxAgents': 8,
      'availableSlots': 0,
      'paused': false,
      'observation': {
        'receivedAt': DateTime.now().millisecondsSinceEpoch,
        'runningHarnessIds': <String>[],
      },
    },
  ];
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'a task with files recovers after its committed message reply is lost',
    () async {
      final f = SuperTabLaunchFixture(
        connectionFactory: (store) =>
            LostReplyConnection(store, 'message.send'),
      );
      configure(f);
      SuperTabLaunch.uploadForTest = f.connection.server.upload;
      addTearDown(() => SuperTabLaunch.uploadForTest = null);
      final files = HarnessAttachments()
        ..add([
          HarnessAttachment('plan.md', Uint8List.fromList([1, 2, 3])),
        ]);
      final box = await f.box(newProject: true, attachments: files);
      expect(await box.create(), NewHarnessOutcome.failed);
      final recovered = await box.create();
      final c = f.connection as LostReplyConnection;
      // The retry replays the committed message: nothing is uploaded again.
      expect(c.server.uploads, hasLength(1));
      expect(recovered, NewHarnessOutcome.created, reason: box.error);
    },
  );
  test('a Swarm start recovers after its committed reply is lost', () async {
    final f = SuperTabLaunchFixture(
      connectionFactory: (store) => LostReplyConnection(store, 'lead.start'),
    );
    configure(f);
    (f.connection.server.state['machines'] as List).add({
      'machineId': 'far',
      'name': 'Office Mini',
      'contributorId': 'owner',
      'maxAgents': 8,
      'availableSlots': 3,
      'paused': false,
      'observation': {
        'receivedAt': DateTime.now().millisecondsSinceEpoch,
        'runningHarnessIds': <String>[],
        'capabilities': ['leadStart'],
      },
    });
    final box = await f.box(newProject: true);
    box.chooseLeadMachine('far');
    expect(await box.create(), NewHarnessOutcome.failed);
    final recovered = await box.create();
    final c = f.connection as LostReplyConnection;
    final starts = c.attempts
        .where((p) => (p['command'] as Map)['type'] == 'lead.start')
        .map((p) => p['operationId'])
        .toList();
    // The retry repeats the committed start under its original operation.
    expect(starts.toSet(), hasLength(1));
    expect(recovered, NewHarnessOutcome.created, reason: box.error);
  });
}
