import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/crew_panel.dart';
import 'package:harness/super_tabs/model.dart';

// Task #3397: the Crew panel lists a project's crew, the agents the Swarm keeps alive: each one's name, role, machine,
// state and task. Built from the snapshot alone, so no sign-in or store is needed (memory only).

final _now = DateTime.utc(2026, 11, 5, 15);

Map<String, dynamic> _agent(
  String id,
  String name, {
  Map<String, dynamic>? crew,
  String machineId = 'mac3',
  String engine = 'claude',
  DateTime? downSince,
  Map<String, dynamic>? asleep,
}) => {
  'id': id,
  'projectId': 'lead',
  'name': name,
  'machineId': machineId,
  'harnessId': 'h-$id',
  'contributorId': 'owner',
  'configuration': {'engine': engine},
  'crew': ?crew,
  'downSince': ?downSince?.toIso8601String(),
  'asleep': ?asleep,
};

SuperTabSnapshot _swarm(List<Map<String, dynamic>> agents) =>
    SuperTabSnapshot.fromJson({
      'version': 1,
      'id': 'tab',
      'name': 'Pilot',
      'ownerId': 'owner',
      'people': const [],
      'agents': agents,
      'machines': [
        {'machineId': 'mac3', 'name': 'Mac 3'},
        {'machineId': 'tim', 'name': 'Window of Tim'},
      ],
      'conversations': [
        {
          'id': 'lead',
          'title': 'Lead',
          'agentIds': const [],
          'checks': const [],
          'archived': false,
        },
        {
          'id': 'g1',
          'title': 'A standing crew',
          'number': 3397,
          'agentIds': ['keeper'],
          'checks': const [],
          'archived': false,
          'assignment': {'id': 'w1', 'agentId': 'keeper', 'status': 'working'},
        },
        {
          'id': 'g2',
          'title': 'Finished work',
          'number': 3300,
          'agentIds': ['heron'],
          'checks': const [],
          'archived': false,
          'assignment': {'id': 'w2', 'agentId': 'heron', 'status': 'done'},
        },
      ],
    });

const _engineer = {'role': 'Engineer', 'at': 1, 'by': 'pm'};

void main() {
  test('lists each crew member with name, role, machine, state and task, and nobody else', () {
    final rows = superTabCrewRows(
      _swarm([
        _agent('keeper', 'Keeper', crew: {..._engineer, 'lane': 'cli'}),
        _agent('heron', 'Heron', crew: {'role': 'Reviewer', 'at': 1, 'by': 'pm'}),
        _agent(
          'sorrel',
          'Sorrel',
          crew: {'role': 'Tester', 'at': 1, 'by': 'pm'},
          machineId: 'tim',
          engine: 'codex',
          downSince: _now.subtract(const Duration(minutes: 2)),
        ),
        _agent('aster', 'Aster', crew: _engineer, downSince: _now.subtract(const Duration(minutes: 6))),
        _agent('dozy', 'Dozy', crew: _engineer, asleep: {'since': 1}),
        _agent('plain', 'Plain'),
      ]),
      'lead',
      now: _now,
    );
    expect(rows.map((r) => r.name), ['Keeper', 'Heron', 'Sorrel', 'Aster', 'Dozy']);
    expect(rows.first.role, 'Engineer · cli');
    expect(rows.first.machine, 'Mac 3 · Claude');
    expect(rows.first.state, 'Running');
    expect(rows.first.task, '#3397 A standing crew');
    expect(rows[1].task, 'No task');
    expect(rows[2].machine, 'Window of Tim · Codex');
    expect(rows[2].state, 'Reopening');
    expect(rows[3].state, 'Down 6m');
    expect(rows[4].state, 'Asleep');
  });

  testWidgets('shows the rows, and an empty line when the project has no crew', (tester) async {
    final rows = superTabCrewRows(_swarm([_agent('keeper', 'Keeper', crew: _engineer)]), 'lead', now: _now);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SuperTabCrewList(rows: rows))));
    for (final text in ['Keeper', 'Engineer', 'Mac 3 · Claude', 'Running', '#3397 A standing crew']) {
      expect(find.text(text), findsOneWidget);
    }
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SuperTabCrewList(rows: []))));
    expect(find.text(superTabCrewEmpty), findsOneWidget);
  });
}
