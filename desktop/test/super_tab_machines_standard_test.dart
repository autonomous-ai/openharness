import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';

import 'support/super_tab_fixture.dart';

/// Task #3801 (Scholes, 11-06): the Machines screen groups its rows by status, with the reader's own machines pinned
/// first, and has real loading, empty and error states.

Finder _key(String k) => find.byKey(ValueKey(k));

Map<String, dynamic> _machine(
  String id,
  String name,
  String owner, {
  Duration? seen,
}) => {
  'machineId': id,
  'name': name,
  'contributorId': owner,
  if (seen != null)
    'observation': {
      'receivedAt': DateTime.now().millisecondsSinceEpoch - seen.inMilliseconds,
      'resources': {'cpuPercent': 5},
    },
};

Future<void> _mount(WidgetTester tester, SuperTabController c) async {
  await tester.binding.setSurfaceSize(const Size(420, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      // As the Swarm view does: it rebuilds on the controller's changes.
      home: Scaffold(
        body: ListenableBuilder(
          listenable: c,
          builder: (context, _) =>
              SuperTabMachines(controller: c, onAddAgent: (_) {}),
        ),
      ),
    ),
  );
  await tester.pump();
}

Future<void> _end(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

double _top(WidgetTester tester, String key) => tester.getTopLeft(_key(key)).dy;

void main() {
  // Status unknown is the Swarm's own state (it cannot be read), not a machine's: its group shows only then.
  testWidgets('rows sit under Yours, Online and Offline, in that order, each '
      'heading with its count', (tester) async {
    final server = ConversationServer();
    (server.state['people'] as List).add({
      'id': 'peer',
      'email': 'peer@example.com',
      'role': 'collaborator',
    });
    server.state['machines'] = [
      _machine('theirs-off', 'Old Box', 'peer', seen: const Duration(hours: 2)),
      _machine('theirs-silent', 'Quiet Box', 'peer'),
      _machine('theirs-live', 'Build Box', 'peer', seen: Duration.zero),
      _machine('mine', 'My Mac', 'owner', seen: const Duration(hours: 2)),
    ];
    final c = server.controller();
    await c.refresh();
    await _mount(tester, c);

    final order = [
      'super-machines-group-yours',
      'super-machine-row-mine',
      'super-machines-group-online',
      'super-machine-row-theirs-live',
      'super-machines-group-offline',
      'super-machine-row-theirs-off',
      'super-machine-row-theirs-silent',
    ];
    for (final key in order) {
      expect(_key(key), findsOneWidget, reason: key);
    }
    for (var i = 1; i < order.length; i++) {
      expect(
        _top(tester, order[i - 1]),
        lessThan(_top(tester, order[i])),
        reason: '${order[i - 1]} above ${order[i]}',
      );
    }
    // Yours holds the reader's machine whatever its status (offline here).
    expect(
      find.descendant(
        of: _key('super-machines-group-yours'),
        matching: find.text('YOUR MACHINE'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _key('super-machines-group-online'),
        matching: find.text('ONLINE · 1'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _key('super-machines-group-offline'),
        matching: find.text('OFFLINE · 2'),
      ),
      findsOneWidget,
    );
    expect(_key('super-machines-group-unknown'), findsNothing);
    final heading = tester.getSemantics(_key('super-machines-group-online'));
    expect(heading.flagsCollection.isHeader, isTrue);
    await _end(tester, c);
  });

  testWidgets('a group with no machine shows no heading', (tester) async {
    final server = ConversationServer();
    server.state['machines'] = [
      _machine('theirs-live', 'Build Box', 'peer', seen: Duration.zero),
    ];
    final c = server.controller();
    await c.refresh();
    await _mount(tester, c);
    expect(_key('super-machines-group-online'), findsOneWidget);
    expect(_key('super-machines-group-yours'), findsNothing);
    expect(_key('super-machines-group-offline'), findsNothing);
    expect(_key('super-machines-group-unknown'), findsNothing);
    await _end(tester, c);
  });

  testWidgets('before the Swarm is read the screen is loading, not empty', (
    tester,
  ) async {
    final server = ConversationServer();
    server.state['machines'] = [
      _machine('theirs-live', 'Build Box', 'peer', seen: Duration.zero),
    ];
    final c = server.controller();
    await _mount(tester, c);
    expect(_key('super-machines-loading'), findsOneWidget);
    expect(find.textContaining('Add a machine'), findsNothing);
    await _end(tester, c);
  });

  testWidgets('a Swarm that cannot be read says so with Retry, and Retry reads '
      'it again', (tester) async {
    final server = ConversationServer()..failReads = true;
    server.state['machines'] = [
      _machine('theirs-live', 'Build Box', 'peer', seen: Duration.zero),
    ];
    final c = server.controller();
    await tester.runAsync(() async {
      try {
        await c.refresh();
      } catch (_) {}
    });
    await _mount(tester, c);
    expect(_key('super-machines-error'), findsOneWidget);
    expect(find.textContaining('Add a machine'), findsNothing);

    server.failReads = false;
    await tester.tap(_key('super-machines-retry'));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    expect(_key('super-machines-error'), findsNothing);
    expect(_key('super-machine-row-theirs-live'), findsOneWidget);
    await _end(tester, c);
  });

  // Review of #3370: a machine that leaves Online for Offline keeps the same order of rows, and its group's heading
  // and count must follow it all the same. Mounted with no host rebuilding it: only the machines' own news redraws.
  testWidgets('a machine going offline moves its group heading and counts, '
      'even when the order of rows stays the same', (tester) async {
    final server = ConversationServer();
    server.state['machines'] = [
      _machine('a', 'Alpha', 'peer', seen: Duration.zero),
      _machine('b', 'Bravo', 'peer', seen: Duration.zero),
      _machine('c', 'Charlie', 'peer', seen: const Duration(hours: 2)),
    ];
    final c = server.controller();
    await c.refresh();
    await tester.binding.setSurfaceSize(const Size(420, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('ONLINE · 2'), findsOneWidget);
    expect(find.text('OFFLINE · 1'), findsOneWidget);

    // Bravo goes quiet: the rows still read Alpha, Bravo, Charlie.
    final machines = (server.state['machines'] as List)
        .cast<Map<String, dynamic>>();
    machines[1] = _machine(
      'b',
      'Bravo',
      'peer',
      seen: const Duration(hours: 2),
    );
    server.revision++;
    await tester.runAsync(c.refresh);
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(find.text('ONLINE · 1'), findsOneWidget);
    expect(find.text('OFFLINE · 2'), findsOneWidget);
    await _end(tester, c);
  });

  testWidgets('a Swarm read empty, then unreachable, says so with Retry, not '
      'Add a machine', (tester) async {
    final server = ConversationServer();
    server.state['machines'] = <dynamic>[];
    final c = server.controller();
    await c.refresh();
    server.failReads = true;
    await tester.runAsync(() async {
      try {
        await c.refresh();
      } catch (_) {}
    });
    expect(c.backendUnreachable, isTrue);
    await _mount(tester, c);
    expect(_key('super-machines-error'), findsOneWidget);
    expect(find.textContaining('Add a machine'), findsNothing);
    await _end(tester, c);
  });

  testWidgets('a read Swarm with no machine shows the empty note', (
    tester,
  ) async {
    final server = ConversationServer();
    server.state['machines'] = <dynamic>[];
    final c = server.controller();
    await c.refresh();
    await _mount(tester, c);
    expect(find.textContaining('Add a machine'), findsOneWidget);
    expect(_key('super-machines-loading'), findsNothing);
    expect(_key('super-machines-error'), findsNothing);
    await _end(tester, c);
  });
}
