import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/desk_tab_filter_bar.dart';

/// The chips under Find's field, and the `+` after the last of them — the desktop's New Tab.
void main() {
  const choices = [
    DeskTabFilterChoice(id: null, name: 'All', count: 3),
    DeskTabFilterChoice(id: 't1', name: 'Desktop', count: 2),
    DeskTabFilterChoice(id: 't2', name: 'Docker', count: 1),
  ];
  final newTab = find.byKey(const ValueKey('find-new-tab'));

  Future<void> pumpBar(
    WidgetTester tester, {
    VoidCallback? onNewTab,
    ValueChanged<String?>? onSelected,
  }) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: DeskTabFilterBar(
          choices: choices,
          selected: null,
          onSelected: onSelected ?? (_) {},
          onNewTab: onNewTab,
        ),
      ),
    ),
  );

  testWidgets('a tap on the + asks for a new tab, and picks no chip', (
    tester,
  ) async {
    var asked = 0;
    final picked = <String?>[];
    await pumpBar(tester, onNewTab: () => asked++, onSelected: picked.add);

    await tester.tap(newTab);
    await tester.pump();

    expect(asked, 1);
    expect(picked, isEmpty);
  });

  testWidgets('the + comes after every chip', (tester) async {
    await pumpBar(tester, onNewTab: () {});

    for (final name in ['All', 'Desktop', 'Docker']) {
      expect(
        tester.getTopLeft(newTab).dx,
        greaterThan(tester.getTopRight(find.text(name)).dx),
        reason: name,
      );
    }
    // As tall as a chip, and square.
    final size = tester.getSize(
      find.descendant(of: newTab, matching: find.byType(AnimatedContainer)),
    );
    expect(size.width, size.height);
  });

  testWidgets('no + without somewhere to send it', (tester) async {
    await pumpBar(tester);

    expect(newTab, findsNothing);
    expect(find.bySemanticsLabel('New Tab'), findsNothing);
  });
}
