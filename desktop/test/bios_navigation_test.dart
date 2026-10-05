import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('Cmd-P ages update without changing order or selection', (
    tester,
  ) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final now = tester.binding.clock.now();
    app.machineStates['m']!.agents = [
      Agent(
        id: 'new',
        name: 'New work',
        engine: 'claude',
        terminalAvailable: true,
        lastActivityAt: now.subtract(const Duration(seconds: 20)),
      ),
      Agent(
        id: 'viewed',
        name: 'Old work viewed now',
        engine: 'codex',
        terminalAvailable: true,
        lastActivityAt: now.subtract(const Duration(minutes: 5)),
        lastOpenedAt: now,
      ),
    ];
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      activityFirst: true,
    );
    addTearDown(search.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: DesktopChrome(
          child: Scaffold(
            body: SwarmSearchResults(
              search: search,
              onChoose: (_) {},
              onRefocus: () {},
              now: tester.binding.clock.now,
              showPreview: false,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final order = search.rows.map((row) => row.id).toList();
    final selected = search.selected?.id;
    final position = tester.getTopLeft(find.byKey(ValueKey(order.first)));
    expect(find.text('now'), findsOneWidget);
    expect(find.text('5m'), findsOneWidget);
    await tester.pump(const Duration(minutes: 1));
    expect(find.text('now'), findsNothing);
    expect(find.text('1m'), findsOneWidget);
    expect(find.text('6m'), findsOneWidget);
    expect(search.rows.map((row) => row.id), order);
    expect(search.selected?.id, selected);
    expect(tester.getTopLeft(find.byKey(ValueKey(order.first))), position);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    'Open Harness sorts by activity as it opened, and keeps that order while open',
    (tester) async {
      final app = createApp();
      try {
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
              lastActivityAt: hour == null
                  ? null
                  : DateTime.utc(2026, 9, 23, hour),
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
        // The harness named exactly that leads; the rest keep activity order.
        expect(
          search.rows.where((row) => !row.isCreate).map((row) => row.agentId),
          ['a1', 'a10', 'a11', 'a12'],
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
        // Agent 1 just worked, but the open list does not move under the cursor.
        expect(search.rows.first.isCreate, isTrue);
        expect(search.rows.skip(1).map((row) => row.agentId), [
          'a1',
          'a10',
          'a11',
          'a12',
        ]);
        expect(search.selected!.id, selected);
        search.setQuery('');
        expect(search.rows.skip(1).map((row) => row.agentId), [
          'a10',
          'a11',
          'a1',
          'a12',
        ]);
        // The next opening reads activity afresh.
        final reopened = SwarmSearchController(
          app,
          recent,
          adding: true,
          offersCreate: true,
          activityFirst: true,
          placement: HarnessPlacement.newTab,
        );
        addTearDown(reopened.dispose);
        expect(reopened.rows.skip(1).map((row) => row.agentId), [
          'a1',
          'a10',
          'a11',
          'a12',
        ]);

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
        // Found now too, in the order this opening listed them.
        expect(search.rows.skip(1).map((row) => row.agentId), ['a11', 'a1']);
        expect(search.selected!.agentId, 'a11');
        search.setQuery('>');
        expect(search.setupLayout, isTrue);
      } finally {
        app.dispose();
      }
    },
  );

  testWidgets(
    'Open Harness sorts by when the conversation last moved: opening a '
    'harness does not move it',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      Agent agent(String id, int active, {int? opened}) => Agent(
        id: id,
        sessionId: 'session-$id',
        name: 'Agent $id',
        engine: 'codex',
        terminalAvailable: true,
        lastActivityAt: DateTime.utc(2026, 9, 26, active),
        lastOpenedAt: opened == null ? null : DateTime.utc(2026, 9, 26, opened),
      );
      app.machineStates['m']!.agents = [
        agent('busy', 11),
        agent('quiet', 9, opened: 12),
        agent('idle', 10),
        // Opened long ago, then busy since: activity is the later of the two.
        agent('worked', 8, opened: 7),
      ];
      final search = SwarmSearchController(
        app,
        const [],
        adding: true,
        offersCreate: true,
        activityFirst: true,
        placement: HarnessPlacement.newTab,
      );
      addTearDown(search.dispose);
      List<String?> order() => [
        for (final row in search.rows)
          if (!row.isCreate) row.agentId,
      ];
      // The owner: "use conversation last move, not last open — that's the
      // true timestamp". `quiet`, opened at 12 but quiet since 9, stays put.
      expect(order(), ['busy', 'idle', 'quiet', 'worked']);
      expect(
        search.rows.firstWhere((row) => row.agentId == 'quiet').lastActivityAt,
        DateTime.utc(2026, 9, 26, 9),
      );

      // Another client opens `idle`: the daemon's push carries only the new
      // open stamp, and an open is not work, so nothing moves.
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': 'idle',
            'sessionId': 'session-idle',
            'name': 'Agent idle',
            'engine': 'codex',
            'terminal': {'available': true},
            'updatedAt': '2026-09-26T10:00:00Z',
            'lastOpenedAt': '2026-09-26T13:00:00Z',
          },
        },
      });
      expect(order(), ['busy', 'idle', 'quiet', 'worked']);
    },
  );

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
