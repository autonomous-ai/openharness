// Team at a glance (Dee, 2026-10-27): "it's hard to monitor the team". Each agent row says, in one line, its state, the
// machine it runs on and its model and effort; one click from the Agents heading shows every machine with its agents
// and slots, the model and effort counts, and what looks wrong: work piled on one machine while others have room, busy
// agents on an offline machine, and agents running another effort than their start asked for.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/agent_details.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/super_tabs/team_glance.dart';

import 'support/super_tab_fixture.dart';

const _offline = 10 * 60 * 1000;

Map<String, dynamic> _machine(
  String id,
  String name, {
  int max = 4,
  int? free,
  int age = 0,
}) => {
  'machineId': id,
  'name': name,
  'contributorId': 'owner',
  'scope': 'swarm',
  'cwd': '/swarm',
  'engines': ['claude', 'codex'],
  'maxAgents': max,
  'paused': false,
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
}) async {
  final server = ConversationServer();
  server.state['machines'] =
      machines ?? [_machine('m1', 'Mac Studio'), _machine('m2', 'MacBook Pro')];
  server.state['agents'] = [_agent('Lead', 'm1'), ...agents];
  (server.state['conversations'] as List)[0]['leadId'] = 'Lead';
  (server.state['conversations'] as List).addAll(tasks);
  server.state['starts'] = starts;
  final c = server.controller();
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
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return server;
}

Finder _row(String id) => find.byKey(ValueKey('super-member-$id'));
Finder _line(String id, String text) =>
    find.descendant(of: _row(id), matching: find.text(text));

Future<void> _openGlance(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Team at a glance'));
  await tester.pumpAndSettle();
}

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
          _line('Atlas', 'Assigned · Mac Studio · opus high'),
          findsOneWidget,
        );
        expect(
          _line('Sage', 'Idle · MacBook Pro · sonnet medium'),
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
      expect(line(HarnessActivity.working), 'Working · Mac Studio · opus high');
      expect(line(HarnessActivity.idle), 'Assigned · Mac Studio · opus high');
      expect(line(null), 'Assigned · Mac Studio · opus high');
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
        expect(_line('Moss', 'Stuck · Mac Studio · opus high'), findsOneWidget);
        expect(
          _line('Teal', 'In review · Mac Studio · opus high'),
          findsOneWidget,
        );
        expect(
          _line('Wren', 'Waiting · Mac Studio · opus high'),
          findsOneWidget,
        );
        expect(_line('Lark', 'Lost · Mac Studio · opus high'), findsOneWidget);
        expect(_line('Kite', 'Down · MacBook Pro · opus high'), findsOneWidget);
        expect(
          _line(
            'Rook',
            'Limited until ${two(until.hour)}:${two(until.minute)} · MacBook Pro · opus high',
          ),
          findsOneWidget,
        );
      },
    );

    // Builders started with opus high were stored as auto (fixed in the CLI, 2026-10-27); one stored before the fix
    // shows what its start asked for while the start still says, and otherwise that the effort is not known.
    testWidgets(
      'shows the requested effort for an auto reading its start still names, else unknown',
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
        expect(_line('Nico', 'Idle · Mac Studio · opus high'), findsOneWidget);
        expect(
          _line('Quinn', 'Idle · Mac Studio · opus unknown'),
          findsOneWidget,
        );
        expect(
          _line('Avery', 'Idle · Mac Studio · opus unknown'),
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
      expect(_line('Echo', 'Idle · Mac Studio · opus high'), findsOneWidget);
    });
  });

  group('Team at a glance', () {
    testWidgets(
      'opens with one click and lists each machine with its slots, state and agents',
      (tester) async {
        await _swarm(
          tester,
          machines: [
            _machine('m1', 'Mac Studio', free: 2),
            _machine('m2', 'MacBook Pro', max: 2, free: 2, age: _offline),
          ],
          agents: [_agent('Atlas', 'm1')],
        );
        await _openGlance(tester);
        final studio = find.byKey(const ValueKey('glance-machine-m1'));
        expect(
          find.descendant(of: studio, matching: find.text('Mac Studio')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: studio,
            matching: find.text('Online · 2 of 4 slots used'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: studio, matching: find.text('Lead · Idle')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: studio, matching: find.text('Atlas · Idle')),
          findsOneWidget,
        );
        final laptop = find.byKey(const ValueKey('glance-machine-m2'));
        expect(
          find.descendant(
            of: laptop,
            matching: find.text('Offline · 0 of 2 slots used'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: laptop, matching: find.text('No agents')),
          findsOneWidget,
        );
      },
    );

    testWidgets('counts agents per model and effort, most first', (
      tester,
    ) async {
      await _swarm(
        tester,
        agents: [
          _agent('Atlas', 'm1'),
          _agent('Sage', 'm2', model: 'sonnet', effort: 'medium'),
          _agent('Finn', 'm2'),
        ],
      );
      await _openGlance(tester);
      final counts = find.byKey(const ValueKey('glance-models'));
      expect(
        find.descendant(of: counts, matching: find.text('opus high · 3')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: counts, matching: find.text('sonnet medium · 1')),
        findsOneWidget,
      );
      expect(
        tester.getTopLeft(find.text('opus high · 3')).dy,
        lessThan(tester.getTopLeft(find.text('sonnet medium · 1')).dy),
      );
    });

    testWidgets(
      'warns when most busy agents sit on one machine while another has free slots',
      (tester) async {
        await _swarm(
          tester,
          machines: [
            _machine('m1', 'Mac Studio', free: 0),
            _machine('m2', 'MacBook Pro', free: 3),
          ],
          agents: [
            _agent('Atlas', 'm1'),
            _agent('Sage', 'm1'),
            _agent('Finn', 'm2'),
          ],
          tasks: [
            _task('Atlas', 'working'),
            _task('Sage', 'working'),
            _task('Finn', 'working'),
          ],
        );
        await _openGlance(tester);
        expect(
          find.text(
            '2 of 3 busy agents are on Mac Studio, while MacBook Pro has 3 free slots.',
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'does not warn about piling up when the other machines have no room or are offline',
      (tester) async {
        await _swarm(
          tester,
          machines: [
            _machine('m1', 'Mac Studio', free: 0),
            _machine('m2', 'MacBook Pro', free: 3, age: _offline),
          ],
          agents: [_agent('Atlas', 'm1'), _agent('Sage', 'm1')],
          tasks: [_task('Atlas', 'working'), _task('Sage', 'working')],
        );
        await _openGlance(tester);
        expect(find.textContaining('busy agents are on'), findsNothing);
        expect(find.text('Nothing looks wrong.'), findsOneWidget);
      },
    );

    testWidgets('warns about a busy agent on an offline machine', (
      tester,
    ) async {
      await _swarm(
        tester,
        machines: [
          _machine('m1', 'Mac Studio'),
          _machine('m2', 'MacBook Pro', age: _offline),
        ],
        agents: [_agent('Finn', 'm2')],
        tasks: [_task('Finn', 'working')],
      );
      await _openGlance(tester);
      expect(
        find.text('Finn is busy on MacBook Pro, which is offline.'),
        findsOneWidget,
      );
    });

    testWidgets(
      'warns about an agent running another effort than its start asked for, not an unknown one',
      (tester) async {
        await _swarm(
          tester,
          agents: [
            _agent('Hugo', 'm1', effort: 'xhigh'),
            _agent('Nico', 'm1', effort: 'auto'),
            _agent('Echo', 'm1'),
          ],
          starts: [
            _start('Hugo', 'high'),
            _start('Nico', 'high'),
            _start('Echo', 'high'),
          ],
        );
        await _openGlance(tester);
        expect(
          find.text('Hugo runs effort xhigh; its start asked for high.'),
          findsOneWidget,
        );
        expect(find.textContaining('Nico runs'), findsNothing);
        expect(find.textContaining('Echo runs'), findsNothing);
      },
    );
  });
}
