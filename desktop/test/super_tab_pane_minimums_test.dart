// Task #4251 (finding 8 of #4211): in a small window the Board keeps two columns while the side panes can give:
// the left pane gives back first, then the Tasks pane down to its own minimum.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/pane_layout.dart';

import 'support/memory_key_value_store.dart';

Finder _key(String k) => find.byKey(ValueKey(k));

void main() {
  for (final (width, left, center, right) in [
    (1500.0, 300.0, 860.0, 340.0),
    (1100.0, 200.0, 560.0, 340.0),
    (1040.0, 180.0, 560.0, 300.0),
    (900.0, 180.0, 440.0, 280.0),
    (880.0, 180.0, 420.0, 280.0),
  ]) {
    testWidgets('the Board layout at $width wide is '
        '$left | $center | $right', (tester) async {
      await tester.binding.setSurfaceSize(Size(width, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          home: SuperTabPaneLayout(
            storage: MemoryKeyValueStore(),
            onLeave: () {},
            rightFixed: true,
            rightDefault: SuperTabPaneLayout.boardRightWidth,
            left: const ColoredBox(color: Colors.black),
            right: const ColoredBox(color: Colors.black),
            center: const ColoredBox(color: Colors.white),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.getSize(_key('super-left-pane')).width, left);
      expect(tester.getSize(_key('super-center-pane')).width, center);
      expect(tester.getSize(_key('super-right-pane')).width, right);
    });
  }
}
