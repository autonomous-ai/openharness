import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('Open Harness builds a small window and Tab reaches later rows', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    app.adoptSessionForTest(terminal('a0', []));
    final map = MemoryKeymap();
    await mount(tester, app, map);
    await key(tester, LogicalKeyboardKey.keyO, cmd: true);
    final results = find.byType(SwarmSearchResults);
    final search = tester.widget<SwarmSearchResults>(results).search;
    final rows = find.descendant(of: results, matching: find.byType(ListTile));
    expect(search.rows.length, greaterThan(50));
    expect(rows.evaluate().length, lessThan(12));
    final visited = <String>{};
    for (var step = 0; step < 35; step++) {
      await key(tester, LogicalKeyboardKey.tab);
      await tester.pumpAndSettle();
      final row = FocusManager.instance.primaryFocus?.context
          ?.findAncestorWidgetOfExactType<ListTile>();
      if (row != null) {
        final id = (row.key! as ValueKey<String>).value;
        visited.add(id);
        expect(search.selected?.id, id);
        expect(find.byKey(row.key!).hitTestable(), findsOneWidget);
      }
    }
    // Focus crosses the initial viewport repeatedly as new rows are built.
    expect(visited.length, greaterThan(15));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
  });
}
