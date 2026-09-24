import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/state/harness_placement.dart';

import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('Open Harness sorts by activity while filtering and refreshing', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      for (final (id, hour) in [
        ('a1', 10),
        ('a10', 12),
        ('a11', 11),
        ('a12', null),
      ])
        Agent(
          id: id,
          sessionId: 'session-$id',
          name: 'Agent ${id.substring(1)}',
          engine: 'codex',
          terminalAvailable: true,
          lastActivityAt: hour == null ? null : DateTime.utc(2026, 9, 23, hour),
        ),
    ];
    final recent = [
      agentDestinationId('m', 'a1'),
      agentDestinationId('m', 'a12'),
      agentDestinationId('m', 'a10'),
    ];
    final search = SwarmSearchController(
      app,
      recent,
      adding: true,
      offersCreate: true,
      activityFirst: true,
      placement: HarnessPlacement.newTab,
    );
    addTearDown(search.dispose);
    expect(search.setupLayout, isTrue);
    expect(search.rows.first.isCreate, isTrue);
    expect(search.rows.skip(1).map((row) => row.agentId), [
      'a10',
      'a11',
      'a1',
      'a12',
    ]);
    search.setQuery('Agent 1');
    expect(
      search.rows.where((row) => !row.isCreate).map((row) => row.agentId),
      ['a10', 'a11', 'a1', 'a12'],
    );

    final ordinary = SwarmSearchController(app, recent, adding: true);
    addTearDown(ordinary.dispose);
    ordinary.setQuery('Agent 1');
    expect(ordinary.setupLayout, isFalse);
    expect(ordinary.rows.first.agentId, 'a1');

    final selected = search.selected!.id;
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {
        'agent': {
          'id': 'a1',
          'sessionId': 'session-a1',
          'name': 'Agent 1',
          'engine': 'codex',
          'terminal': {'available': true},
          'updatedAt': '2026-09-23T12:00:30Z',
        },
      },
    });
    expect(search.rows.first.isCreate, isTrue);
    expect(search.rows.skip(1).map((row) => row.agentId), [
      'a1',
      'a10',
      'a11',
      'a12',
    ]);
    expect(search.selected!.id, selected);

    search.setQuery('retry-safe');
    expect(search.rows.every((row) => row.isCreate), isTrue);
    Future<void> response(String id) async {
      await app.handleEventForTest('m', {
        'type': 'text_delta',
        'payload': {
          'agentId': id,
          'sessionId': 'session-$id',
          'content': 'The operation is now retry-safe.',
        },
      });
      await tester.pump(const Duration(milliseconds: 80));
    }

    await response('a11');
    search.move(1);
    expect(search.selected!.agentId, 'a11');
    await response('a1');
    expect(search.rows.skip(1).map((row) => row.agentId), ['a1', 'a11']);
    expect(search.selected!.agentId, 'a11');
    search.setQuery('>');
    expect(search.setupLayout, isFalse);
  });

  test(
    'activity ordering spans tabs with deterministic ties and missing times',
    () {
      SwarmDestination row(
        String id,
        String title,
        String tab, {
        DateTime? activity,
      }) => SwarmDestination(
        id: id,
        title: title,
        detail: '',
        swarmId: tab,
        current: tab == 'one',
        lastActivityAt: activity,
      );
      final earlier = DateTime.utc(2026, 9, 23, 10);
      final later = DateTime.utc(2026, 9, 23, 12);
      final all = [
        row('tab:one', 'First tab', 'one'),
        row('one:a', 'Alpha harness', 'one', activity: earlier),
        row('tab:two', 'Second tab', 'two'),
        row('two:b', 'Beta harness', 'two', activity: later),
        row('two:c', 'Gamma harness', 'two', activity: later),
      ];
      const recent = ['one:a', 'two:c', 'tab:two', 'tab:one'];
      expect(
        rankSwarmDestinationsByActivity(
          all,
          '',
          recent: recent,
        ).map((row) => row.id),
        ['two:c', 'two:b', 'one:a', 'tab:two', 'tab:one'],
      );
      expect(
        rankSwarmDestinationsByActivity(
          all,
          'harness',
          recent: recent,
        ).map((row) => row.id),
        ['two:c', 'two:b', 'one:a'],
      );
      expect(
        rankSwarmDestinationsByActivity(all, 'missing', recent: recent),
        isEmpty,
      );
    },
  );
}
