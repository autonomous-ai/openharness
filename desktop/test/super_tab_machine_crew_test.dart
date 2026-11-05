// Machine rows show crew sessions, free disk and idle hours (#3412, anh Dee 11-05). Everything is in the Swarm state
// already (#3398 plan, Decisions): the crew are the agents on the machine with a crew record; asleep is the agent's
// asleep record, idle hours run from its `since`; moving is its movedTo; free disk is the machine's own reading. The
// row says "3 crew · 1 asleep · 42 GB free" under its name; its details list each member. Memory store, no sign-in.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/super_tab_fixture.dart';

Map<String, dynamic> _pool({
  DateTime? observedAt,
  num? diskFree = 42e9,
  num? projectDiskFree,
}) => {
  'machineId': 'm',
  'name': 'Mac 3',
  'contributorId': 'owner',
  'scope': 'swarm',
  'cwd': '/swarm',
  'engines': ['claude'],
  'maxAgents': 4,
  'paused': false,
  'observation': {
    'receivedAt': (observedAt ?? DateTime.now()).millisecondsSinceEpoch,
    'resources': {
      'cpuPercent': 10,
      'memoryTotalBytes': 32e9,
      'memoryUsedBytes': 4e9,
      'diskFreeBytes': ?diskFree,
      'diskTotalBytes': 500e9,
      'projectDiskFreeBytes': ?projectDiskFree,
      'projectDiskTotalBytes': projectDiskFree == null ? null : 200e9,
    },
  },
  'teamWork': {'allowed': true},
};

Map<String, dynamic> _agent(
  String id,
  String name, {
  bool crew = true,
  String machineId = 'm',
  String? displayName,
  Object? asleep,
  Map<String, dynamic>? movedTo,
}) => {
  'id': id,
  'projectId': 'lead',
  'name': name,
  'displayName': ?displayName,
  'machineId': machineId,
  'harnessId': 'h-$id',
  'contributorId': 'owner',
  'configuration': {'engine': 'claude'},
  if (crew) 'crew': {'role': 'Engineer', 'at': 1, 'by': 'owner'},
  'asleep': ?asleep,
  'movedTo': ?movedTo,
};

int _hoursAgo(num hours) => DateTime.now()
    .subtract(Duration(minutes: (hours * 60).round()))
    .millisecondsSinceEpoch;

List<Map<String, dynamic>> _crew() => [
  _agent(
    'a1',
    'tk',
    displayName: 'TestKeep',
    asleep: {'since': _hoursAgo(5.4)},
  ),
  _agent('a2', 'Keeper'),
  _agent(
    'a3',
    'Heron',
    movedTo: {
      'machineId': 'mini',
      'startId': 's',
      'reason': 'offline',
      'at': 1,
    },
  ),
  _agent('a4', 'Sorrel', asleep: {'since': _hoursAgo(1.2)}),
  // Not crew, or not on this machine: never counted.
  _agent('a5', 'Engineer 9', crew: false),
  _agent('a6', 'Elsewhere', machineId: 'other'),
];

Future<dynamic> _mount(
  WidgetTester tester,
  Map<String, dynamic> pool,
  List<Map<String, dynamic>> agents,
) async {
  final server = ConversationServer();
  server.state['machines'] = [pool];
  (server.state['agents'] as List).addAll(agents);
  final c = server.controller(account: 'owner');
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuperTabMachines(controller: c, manage: true, onAddAgent: (_) {}),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<void> _unmount(WidgetTester tester, dynamic c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

String? _text(WidgetTester tester, String key) {
  final found = find.byKey(ValueKey(key));
  return found.evaluate().isEmpty ? null : tester.widget<Text>(found).data;
}

Future<void> _expand(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('super-machine-m')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'a machine row shows its crew sessions, how many are asleep and its free disk',
    (tester) async {
      final c = await _mount(tester, _pool(), _crew());
      expect(
        _text(tester, 'super-machine-crew-m'),
        '4 crew · 2 asleep · 42 GB free',
      );
      await _unmount(tester, c);
    },
  );

  testWidgets(
    "the row's details list each crew member: awake or moving first, then asleep with idle hours, most idle last",
    (tester) async {
      final c = await _mount(tester, _pool(), _crew());
      await _expand(tester);
      expect(find.text('Crew · 4'), findsOneWidget);
      final rows = [
        for (var i = 0; i < 4; i++)
          (
            _text(tester, 'super-machine-crew-member-m-$i'),
            _text(tester, 'super-machine-crew-state-m-$i'),
          ),
      ];
      expect(rows, [
        ('Keeper', 'awake'),
        ('Heron', 'moving'),
        ('Sorrel', 'asleep · idle 1 h'),
        ('TestKeep', 'asleep · idle 5 h'),
      ]);
      expect(_text(tester, 'super-machine-crew-member-m-4'), isNull);
      await _unmount(tester, c);
    },
  );

  testWidgets('a machine with no crew keeps its row as today', (tester) async {
    final c = await _mount(tester, _pool(), [
      _agent('a5', 'Engineer 9', crew: false),
    ]);
    expect(_text(tester, 'super-machine-crew-m'), isNull);
    await _expand(tester);
    expect(find.textContaining('Crew'), findsNothing);
    await _unmount(tester, c);
  });

  testWidgets(
    'an offline machine keeps its crew count but drops its old free disk figure',
    (tester) async {
      final c = await _mount(
        tester,
        _pool(observedAt: DateTime.now().subtract(const Duration(hours: 3))),
        _crew(),
      );
      expect(_text(tester, 'super-machine-crew-m'), '4 crew · 2 asleep');
      await _unmount(tester, c);
    },
  );

  testWidgets(
    "free disk is the project's disk when the machine reports one, and a crew line with no reading says no disk",
    (tester) async {
      var c = await _mount(tester, _pool(projectDiskFree: 18e9), _crew());
      expect(
        _text(tester, 'super-machine-crew-m'),
        '4 crew · 2 asleep · 18 GB free',
      );
      await _unmount(tester, c);
      c = await _mount(tester, _pool(diskFree: null), [_agent('a2', 'Keeper')]);
      expect(_text(tester, 'super-machine-crew-m'), '1 crew');
      await _unmount(tester, c);
    },
  );

  test(
    'an asleep record without a time still reads asleep, with no idle hours',
    () {
      final agent = SuperTabAgent.fromJson(
        _agent('a1', 'tk', asleep: {'folderDropped': true}),
      );
      expect(agent.crewAsleep, isTrue);
      expect(agent.crewAsleepSince, isNull);
      expect(agent.crewMoving, isFalse);
      final moving = SuperTabAgent.fromJson(
        _agent('a3', 'Heron', movedTo: {'machineId': 'mini'}),
      );
      expect(moving.crewMoving, isTrue);
    },
  );
}
