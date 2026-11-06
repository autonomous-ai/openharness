import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
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
      home: Scaffold(
        body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
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

double _top(WidgetTester tester, String key) =>
    tester.getTopLeft(_key(key)).dy;

void main() {
  testWidgets('rows sit under Yours, Online, Status unknown and Offline, in '
      'that order, each heading with its count', (tester) async {
    final server = ConversationServer();
    (server.state['people'] as List).add({
      'id': 'peer',
      'email': 'peer@example.com',
      'role': 'collaborator',
    });
    server.state['machines'] = [
      _machine('theirs-off', 'Old Box', 'peer', seen: const Duration(hours: 2)),
      _machine('theirs-unknown', 'Quiet Box', 'peer'),
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
      'super-machines-group-unknown',
      'super-machine-row-theirs-unknown',
      'super-machines-group-offline',
      'super-machine-row-theirs-off',
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
        matching: find.text('Yours · 1'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: _key('super-machines-group-online'),
        matching: find.text('Online · 1'),
      ),
      findsOneWidget,
    );
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
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pump();
    expect(_key('super-machines-error'), findsNothing);
    expect(_key('super-machine-row-theirs-live'), findsOneWidget);
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
