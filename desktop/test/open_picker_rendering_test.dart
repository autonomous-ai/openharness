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
    final prompt = find.byKey(const ValueKey('swarm-search-prompt'));
    final visibleTiles = tester.widgetList<ListTile>(rows);
    for (final tile in visibleTiles.where((tile) => tile.leading != null)) {
      expect(
        tester.getCenter(prompt).dx,
        closeTo(tester.getCenter(find.byWidget(tile.leading!)).dx, .1),
        reason: 'The prompt, create action and engine marks share one column.',
      );
    }
    expect(search.rows.length, greaterThan(50));
    expect(rows.evaluate().length, lessThan(35));
    final visited = <String>{};
    for (var step = 0; step < 35; step++) {
      await key(tester, LogicalKeyboardKey.tab);
      await tester.pumpAndSettle();
      final selected = search.selected;
      if (selected != null) {
        visited.add(selected.id);
        expect(find.byKey(ValueKey(selected.id)).hitTestable(), findsOneWidget);
        expect(
          tester
              .widget<TextField>(
                find.byKey(const ValueKey('swarm-search-input')),
              )
              .focusNode!
              .hasFocus,
          isTrue,
        );
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
