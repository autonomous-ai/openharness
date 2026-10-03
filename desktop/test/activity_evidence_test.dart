import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/agent_activity.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/state/status_menu.dart';

import 'swarm_state_test.dart' show createApp;

const row = {
  'id': 'a0',
  'sessionId': 's',
  'name': 'cmd p',
  'engine': 'codex',
  'terminal': {'available': true},
};
Map<String, Object> evidence(
  String state,
  int revision, {
  String epoch = 'daemon',
  int ms = 1000,
}) => {
  'state': state,
  'epoch': epoch,
  'revision': revision,
  'validForMs': state == 'working' ? ms : 0,
};
Future<void> sync(AppNotifier app, [Map<String, Object>? activity]) =>
    app.handleMachineEventForTest('m', {
      'type': 'agent_synced',
      'payload': {
        'agent': {...row, if (activity != null) 'activity': activity},
      },
    });
Future<void> frame(
  AppNotifier app,
  String type, {
  Map<String, Object>? activity,
  bool replay = false,
  String session = 's',
}) => app.handleMachineEventForTest('m', {
  'type': type,
  'replay': replay,
  'payload': {
    'agentId': 'a0',
    'sessionId': session,
    if (activity != null) 'activity': activity,
  },
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('duplicate packets and snapshots never extend a working lease', (
    tester,
  ) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    app.rememberOpenedHarness('m', 'a0');
    final working = evidence('working', 1);
    await sync(app, working);
    expect(statusMenuWorkingEntries(app), hasLength(1));
    await tester.pump(const Duration(milliseconds: 600));
    await frame(app, 'turn_heartbeat', activity: working);
    await sync(app, working);
    await tester.pump(const Duration(milliseconds: 401));
    expect(statusMenuWorkingEntries(app), isEmpty);
    expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.unknown);
    expect(app.stateOf('m')!.agents.first.terminalAvailable, isTrue);
    expect(app.agentUnread.kindFor('m', 'a0'), isNull);
    await frame(app, 'agent_activity', activity: evidence('working', 2));
    expect(statusMenuWorkingEntries(app), hasLength(1));
    await tester.pump(const Duration(seconds: 2));
  });
  testWidgets(
    'legacy daemon heartbeats cannot keep an abandoned transcript working',
    (tester) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      await sync(app);
      await frame(app, 'turn_started', replay: true);
      expect(app.agentIsProcessing('m', 'a0'), isFalse);
      await frame(app, 'turn_heartbeat');
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(seconds: 5));
        await frame(app, 'turn_heartbeat');
      }
      expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.unknown);
      await frame(app, 'text_delta');
      expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.working);
      await frame(app, 'turn_ended');
      expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.idle);
      await tester.pump(const Duration(milliseconds: 100));
    },
  );
  test(
    'replay, old daemon epochs and late ends cannot overwrite new work',
    () async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      await sync(app, evidence('unknown', 10));
      await frame(
        app,
        'turn_started',
        replay: true,
        activity: evidence('unknown', 11),
      );
      expect(harnessActivity(app, 'm', 'a0'), HarnessActivity.unknown);
      await frame(app, 'turn_started', activity: evidence('working', 12));
      await frame(app, 'turn_ended', activity: evidence('idle', 9));
      expect(app.agentIsProcessing('m', 'a0'), isTrue);
      await sync(app, evidence('idle', 1, epoch: 'restarted'));
      await frame(app, 'turn_heartbeat', activity: evidence('working', 999));
      expect(app.agentIsProcessing('m', 'a0'), isFalse);
      await frame(
        app,
        'turn_started',
        activity: evidence('working', 2, epoch: 'restarted'),
      );
      expect(app.agentIsProcessing('m', 'a0'), isTrue);
      await frame(
        app,
        'agent_activity',
        session: 'old-session',
        activity: evidence('idle', 3, epoch: 'restarted'),
      );
      expect(app.agentIsProcessing('m', 'a0'), isTrue);
    },
  );
  test(
    'a delayed snapshot cannot restore the conversation it replaced',
    () async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      await sync(app, evidence('working', 1));
      await app.handleMachineEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            ...row,
            'sessionId': 'replacement',
            'activity': evidence('idle', 2),
          },
        },
      });
      await sync(app, evidence('working', 1));
      expect(
        app
            .stateOf('m')!
            .agents
            .firstWhere((agent) => agent.id == 'a0')
            .sessionId,
        'replacement',
      );
      expect(app.agentIsProcessing('m', 'a0'), isFalse);
    },
  );
  test('malformed evidence is ignored and excessive leases are bounded', () {
    expect(
      AgentActivity.fromJson({
        'state': 'working',
        'epoch': 'e',
        'revision': 1,
        'validForMs': double.infinity,
      }),
      isNull,
    );
    expect(
      AgentActivity.fromJson(evidence('working', 1, ms: 999999))!.validForMs,
      30000,
    );
    expect(
      AgentActivity.fromJson({...evidence('idle', 1), 'state': 'mystery'}),
      isNull,
    );
  });
}
