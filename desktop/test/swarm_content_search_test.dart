import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_search_preview_test.dart' show seedPreviews;
import 'swarm_state_test.dart' show createApp;

class _Recent extends WsConn {
  _Recent()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final calls = <String>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add(type);
    expect(payload, {'agentId': 'a0', 'n': 3});
    return {
      'agentId': 'a0',
      'asks': ['Make the tab close control appear on hover.'],
      'events': [
        {'kind': 'summary', 'fullText': 'The skylark animation is complete.'},
      ],
    };
  }
}

void main() {
  testWidgets(
    'cached content matches across fields without additional requests',
    (tester) async {
      final conn = _Recent();
      final app = createApp(connectionForTest: (_) => conn);
      final machine = app.machineStates['m']!;
      machine.nodeOnline = true;
      machine.agents = const [
        Agent(
          id: 'a0',
          sessionId: 'old',
          name: 'Design',
          terminalAvailable: true,
        ),
        Agent(
          id: 'a1',
          sessionId: 'other',
          name: 'Skylark',
          terminalAvailable: true,
        ),
      ];
      final key = app.previewKey('m', machine.agents.first);
      final catalog = SwarmSearchCatalog();
      final metadata = catalog.read(app, []);
      final search = SwarmSearchController(app, [], catalog: catalog);
      search.setQuery('tab close hover');
      expect(search.rows, isEmpty);
      app.sessionPreviews.warm([key]);
      await tester.pump(const Duration(milliseconds: 80));
      // ⌘O's list ends in the row that makes a harness; it is not a match.
      expect(search.rows.where((row) => !row.isCreate).single.agentId, 'a0');
      expect(catalog.read(app, []), same(metadata));
      search.setQuery('DESIGN HOVER');
      // ⌘O's list ends in the row that makes a harness; it is not a match.
      expect(search.rows.where((row) => !row.isCreate).single.agentId, 'a0');
      search.setQuery('skylark');
      expect(search.rows.map((row) => row.agentId), ['a1', 'a0']);
      search.setQuery(
        'sklark',
      ); // No fuzzy letters across a response paragraph.
      expect(search.rows.map((row) => row.agentId), ['a1']);
      search.setQuery('tab close hover');
      var resultChanges = 0;
      search.addListener(() => resultChanges++);
      for (var i = 0; i < 100; i++) {
        app.sessionPreviews.ingest(key, 'text_delta', {
          'content': 'Progress $i',
        });
      }
      await tester.pump(const Duration(milliseconds: 80));
      expect(resultChanges, 0);
      expect(search.selected?.agentId, 'a0');
      search.setQuery('progress 99');
      // ⌘O's list ends in the row that makes a harness; it is not a match.
      expect(search.rows.where((row) => !row.isCreate).single.agentId, 'a0');
      machine.agents = [
        const Agent(
          id: 'a0',
          sessionId: 'new',
          name: 'Design',
          terminalAvailable: true,
        ),
        machine.agents.last,
      ];
      app.notifyListeners();
      expect(
        search.rows,
        isEmpty,
      ); // An old session's cache cannot leak into a restart.
      expect(conn.calls, ['agent_recent']);
      search.dispose();
      app.dispose();
    },
  );

  testWidgets(
    'live matches preserve order and selection until the query changes',
    (tester) async {
      final app = createApp();
      final machine = app.machineStates['m']!;
      machine.agents = const [
        Agent(id: 'a0', name: 'Zulu', terminalAvailable: true),
        Agent(id: 'a1', name: 'Alpha', terminalAvailable: true),
      ];
      final search = SwarmSearchController(app, []);
      search.setQuery('cobalt');
      final zulu = app.previewKey('m', machine.agents.first);
      final alpha = app.previewKey('m', machine.agents.last);
      app.sessionPreviews.ingest(zulu, 'text_delta', {
        'content': 'Cobalt paint',
      });
      await tester.pump(const Duration(milliseconds: 80));
      expect(search.selected?.agentId, 'a0');
      app.sessionPreviews.ingest(alpha, 'text_delta', {
        'content': 'Cobalt blue',
      });
      await tester.pump(const Duration(milliseconds: 80));
      expect(search.rows.map((row) => row.agentId), ['a0', 'a1']);
      expect(search.selected?.agentId, 'a0');
      search.setQuery('cobal');
      expect(search.rows.map((row) => row.agentId), ['a1', 'a0']);
      app.sessionPreviews.ingest(alpha, 'text_delta', {
        'content': 'Changed topic',
      });
      await tester.pump(const Duration(milliseconds: 80));
      // ⌘O's list ends in the row that makes a harness; it is not a match.
      expect(search.rows.where((row) => !row.isCreate).single.agentId, 'a0');
      search.dispose();
      app.dispose();
    },
  );

  for (final inline in [false, true]) {
    testWidgets('content finds the matching preview (inline=$inline)', (
      tester,
    ) async {
      final app = createApp();
      await seedPreviews(app);
      app.adoptSessionForTest(terminal('a69', []));
      app.newSwarm();
      await mount(tester, app);
      if (!inline) await chord(tester, LogicalKeyboardKey.keyP);
      final field = find.byKey(
        ValueKey(inline ? 'harness-start-search' : 'swarm-search-input'),
      );
      await tester.enterText(field, 'IDEMPOTENCY receipt');
      await tester.pump();
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      // ⌘O's list ends in the row that makes a harness; it is not a match.
      expect(search.rows.where((row) => !row.isCreate).single.agentId, 'a0');
      expect(find.textContaining('Payment retries now reuse'), findsOneWidget);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }
}
