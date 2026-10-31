// Each agent row says, in one line, its state, the machine it runs on and its model and effort (Dee, 2026-10-27:
// "it's hard to monitor the team"). The Team at a glance screen that once opened from the Agents heading is gone
// (Dee, 2026-10-29: fewer, clearer things).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/agent_details.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/super_tabs/agent_line.dart';

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

Map<String, dynamic> _start(String agentId, String effort) => {
  'id': 'start-$agentId',
  'harnessId': 'h-$agentId',
  'request': {
    'machineId': 'm1',
    'engine': 'claude',
    'model': 'opus',
    'effort': effort,
    'name': agentId,
  },
};

/// A Swarm whose Lead runs on Mac Studio, with [agents], [machines], [tasks] and [starts] besides.
Future<ConversationServer> _swarm(
  WidgetTester tester, {
  List<Map<String, dynamic>> agents = const [],
  List<Map<String, dynamic>>? machines,
  List<Map<String, dynamic>> tasks = const [],
  List<Map<String, dynamic>> starts = const [],
  String account = 'owner',
}) async {
  final server = ConversationServer();
  if (account != 'owner') {
    (server.state['people'] as List).add({
      'id': account,
      'email': '$account@example.com',
      'role': 'collaborator',
    });
  }
  server.state['machines'] =
      machines ?? [_machine('m1', 'Mac Studio'), _machine('m2', 'MacBook Pro')];
  server.state['agents'] = [_agent('Lead', 'm1'), ...agents];
  (server.state['conversations'] as List)[0]['leadId'] = 'Lead';
  (server.state['conversations'] as List).addAll(tasks);
  server.state['starts'] = starts;
  final c = server.controller(account: account);
  await c.refresh();
  addTearDown(c.dispose);
  await tester.binding.setSurfaceSize(const Size(320, 1600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: SuperTabRoster(
          controller: c,
          onInvite: () {},
          onOpenAgent: (_) {},
          onAddAgent: (_) {},
          onAnswer: (_) {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return server;
}

Finder _row(String id) => find.byKey(ValueKey('super-member-$id'));

/// The row's state, machine, model and effort, now on hover (Dee, 2026-10-30):
/// the row's own line is its task.
Finder _line(String id, String text) => find.ancestor(
  of: _row(id),
  matching: find.byWidgetPredicate(
    (w) => w is Tooltip && (w.message ?? '').split('\n').contains(text),
  ),
);

void main() {
  group('an agent row', () {
    testWidgets(
      'says in one line its state, its machine, and its model and effort',
      (tester) async {
        await _swarm(
          tester,
          agents: [
            _agent('Atlas', 'm1'),
            _agent('Sage', 'm2', model: 'sonnet', effort: 'medium'),
          ],
          tasks: [_task('Atlas', 'working')],
        );
        // Holding a task with no turn seen running: assigned, never claimed as working.
        expect(
          _line('Atlas', 'Assigned · Mac Studio · Opus · high'),
          findsOneWidget,
        );
        expect(
          _line('Sage', 'Idle · MacBook Pro · Sonnet · medium'),
          findsOneWidget,
        );
      },
    );

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

    testWidgets(
      'names each state in a word: waiting, lost, down, limited, stuck, in review',
      (tester) async {
        final until = DateTime.now().add(const Duration(hours: 2)).toLocal();
        String two(int n) => n.toString().padLeft(2, '0');
        await _swarm(
          tester,
          agents: [
            _agent('Wren', 'm1'),
            _agent('Lark', 'm1'),
            _agent(
              'Kite',
              'm2',
              extra: {'downSince': DateTime.now().toUtc().toIso8601String()},
            ),
            _agent(
              'Rook',
              'm2',
              extra: {'limitedUntil': until.toUtc().toIso8601String()},
            ),
            _agent('Moss', 'm1'),
            _agent('Teal', 'm1'),
          ],
          tasks: [
            _task('Wren', 'needs_human'),
            _task('Lark', 'lost'),
            _task('Moss', 'blocked'),
            _task('Teal', 'review'),
          ],
        );
        expect(
          _line('Moss', 'Stuck · Mac Studio · Opus · high'),
          findsOneWidget,
        );
        expect(
          _line('Teal', 'Waiting on others · Mac Studio · Opus · high'),
          findsOneWidget,
        );
        expect(
          _line('Wren', 'Waiting · Mac Studio · Opus · high'),
          findsOneWidget,
        );
        expect(
          _line('Lark', 'Lost · Mac Studio · Opus · high'),
          findsOneWidget,
        );
        final tip = tester
            .widgetList<Tooltip>(
              find.ancestor(of: _row('Lark'), matching: find.byType(Tooltip)),
            )
            .single
            .message!;
        expect(tip, contains('Lost "Task of Lark"'));
        expect(
          _line('Kite', 'Down · MacBook Pro · Opus · high'),
          findsOneWidget,
        );
        expect(
          _line(
            'Rook',
            'Limited until ${two(until.hour)}:${two(until.minute)} · MacBook Pro · Opus · high',
          ),
          findsOneWidget,
        );
      },
    );

    // Builders started with opus high were stored as auto (fixed in the CLI, 2026-10-27); one stored before the fix
    // shows what its start asked for while the start still says. An effort nobody reported is left out: the PM's row
    // read "opus unknown" (2026-10-28), and a row says only what is known.
    testWidgets(
      'shows the requested effort for an auto reading its start still names, else no effort',
      (tester) async {
        await _swarm(
          tester,
          agents: [
            _agent('Nico', 'm1', effort: 'auto'),
            _agent('Quinn', 'm1', effort: 'auto'),
            _agent('Avery', 'm1', effort: null),
          ],
          starts: [_start('Nico', 'high')],
        );
        expect(
          _line('Nico', 'Idle · Mac Studio · Opus · high'),
          findsOneWidget,
        );
        expect(_line('Quinn', 'Idle · Mac Studio · Opus'), findsOneWidget);
        expect(_line('Avery', 'Idle · Mac Studio · Opus'), findsOneWidget);
        expect(find.textContaining('unknown'), findsNothing);
      },
    );

    testWidgets(
      'names the model by its display name, with its version when reported',
      (tester) async {
        await _swarm(
          tester,
          agents: [
            _agent('Iris', 'm1', model: 'claude-opus-5-5'),
            _agent('Juno', 'm1', model: 'claude-sonnet-5-5', effort: null),
            _agent(
              'Kai',
              'm2',
              engine: 'codex',
              model: 'gpt-5.6-sol',
              effort: 'xhigh',
            ),
          ],
        );
        expect(
          _line('Iris', 'Idle · Mac Studio · Opus 5.5 · high'),
          findsOneWidget,
        );
        expect(_line('Juno', 'Idle · Mac Studio · Sonnet 5.5'), findsOneWidget);
        expect(
          _line('Kai', 'Idle · MacBook Pro · GPT-5.6 Sol · xhigh'),
          findsOneWidget,
        );
      },
    );

    testWidgets('a start that asked for effort high is shown as high', (
      tester,
    ) async {
      await _swarm(
        tester,
        agents: [_agent('Echo', 'm1')],
        starts: [_start('Echo', 'high')],
      );
      expect(_line('Echo', 'Idle · Mac Studio · Opus · high'), findsOneWidget);
    });
  });

  testWidgets('the Agents heading has no Team at a glance button', (
    tester,
  ) async {
    await _swarm(tester, agents: [_agent('Atlas', 'm1')]);
    expect(find.text('Agents'), findsWidgets);
    expect(find.byTooltip('Team at a glance'), findsNothing);
    expect(find.text('Team at a glance'), findsNothing);
  });
}
