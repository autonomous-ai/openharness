// Each agent row says, in one line, its state, the machine it runs on and its model and effort (Dee, 2026-10-27:
// "it's hard to monitor the team"). The Team at a glance screen that once opened from the Agents heading is gone
// (Dee, 2026-10-29: fewer, clearer things).
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/agent_details.dart';
import 'package:harness/super_tabs/agent_line.dart';

import 'dart:io';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

Map<String, dynamic> _machine(
  String id,
  String name, {
  int max = 4,
  int? free,
  int age = 0,
  bool paused = false,
  String? host,
}) => {
  'machineId': id,
  'name': name,
  'contributorId': 'owner',
  'hostMachineId': ?host,
  'scope': 'swarm',
  'cwd': '/swarm',
  'engines': ['claude', 'codex'],
  'maxAgents': max,
  'paused': paused,
  'availableSlots': ?free,
  'observation': {'receivedAt': DateTime.now().millisecondsSinceEpoch - age},
};

Map<String, dynamic> _agent(
  String id,
  String machineId, {
  String model = 'opus',
  String? effort = 'high',
  String engine = 'claude',
  Map<String, dynamic> extra = const {},
}) => {
  'id': id,
  'projectId': 'lead',
  'name': id,
  'displayName': id,
  'machineId': machineId,
  'harnessId': 'h-$id',
  'contributorId': 'owner',
  'configuration': {'engine': engine, 'model': model, 'effort': ?effort},
  ...extra,
};

Map<String, dynamic> _task(String agentId, String status) => {
  ...conversationFixture('task-$agentId', 'Task of $agentId'),
  'leadId': 'Lead',
  'agentIds': ['Lead', agentId],
  'assignment': {'id': 'as-$agentId', 'agentId': agentId, 'status': status},
};

void main() {
  final captureDir = Platform.environment['HARNESS_AGENT_LINE_CAPTURE_DIR'];
  setUpAll(() => loadCaptureFonts(captureDir));
  group('an agent row', () {
    test('reads working only while its turn runs, and keeps the task as assigned otherwise', () async {
      final server = ConversationServer();
      server.state['machines'] = [_machine('m1', 'Mac Studio')];
      server.state['agents'] = [_agent('Atlas', 'm1')];
      (server.state['conversations'] as List).add(_task('Atlas', 'working'));
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      final atlas = c.snapshot!.agent('Atlas')!;
      String line(HarnessActivity? activity) => superTabAgentGlance(
        SuperTabAgentInfo(c, null, atlas, activity: activity),
      ).line;
      expect(
        line(HarnessActivity.working),
        'Working · Mac Studio · Opus · high',
      );
      expect(line(HarnessActivity.idle), 'Assigned · Mac Studio · Opus · high');
      expect(line(null), 'Assigned · Mac Studio · Opus · high');
    });

    test(
      'reads the current task, never an older lost one (task #3649)',
      () async {
        // Gray, 2026-11-06: Lamp showed "Lost" on an old task while the Swarm had it working on another.
        Map<String, dynamic> task(String id, String title, String status) => {
          ...conversationFixture(id, title),
          'leadId': 'Lead',
          'agentIds': ['Lead', 'Lamp'],
          'assignment': {'id': 'as-$id', 'agentId': 'Lamp', 'status': status},
        };
        final server = ConversationServer();
        server.state['machines'] = [_machine('m1', 'Mac Studio')];
        server.state['agents'] = [_agent('Lamp', 'm1')];
        // The lost one comes first, as an older task does in the Swarm's list.
        (server.state['conversations'] as List)
          ..add(task('old', 'First customers', 'lost'))
          ..add(task('now', 'Move the guide link', 'working'));
        final c = server.controller();
        addTearDown(c.dispose);
        await c.refresh();
        final info = SuperTabAgentInfo(
          c,
          null,
          c.snapshot!.agent('Lamp')!,
          activity: HarnessActivity.working,
        );
        expect(
          superTabAgentGlance(info).line,
          'Working · Mac Studio · Opus · high',
        );
        expect(info.status, 'Working on "Move the guide link"');
        // With no other task, the lost one is still the agent's state.
        server.state['conversations'] = [
          ...(server.state['conversations'] as List).where(
            (g) => g['id'] != 'now',
          ),
        ];
        await c.refresh();
        expect(
          superTabAgentGlance(
            SuperTabAgentInfo(c, null, c.snapshot!.agent('Lamp')!),
          ).label,
          'Lost',
        );
      },
    );
  });
}
