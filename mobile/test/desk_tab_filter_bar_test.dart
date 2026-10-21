import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsAction;
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
    ValueChanged<String>? onLongPress,
  }) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: DeskTabFilterBar(
          choices: choices,
          selected: null,
          onSelected: onSelected ?? (_) {},
          onNewTab: onNewTab,
          onLongPress: onLongPress,
        ),
      ),
    ),
  );

  bool canHold(WidgetTester tester, String label) => tester
      .getSemantics(find.bySemanticsLabel(label))
      .getSemanticsData()
      .hasAction(SemanticsAction.longPress);

  testWidgets('holding a tab chip hands back its tab, and picks nothing', (
    tester,
  ) async {
    final held = <String>[];
    final picked = <String?>[];
    await pumpBar(tester, onLongPress: held.add, onSelected: picked.add);

    await tester.longPress(find.text('Docker'));
    await tester.pump();

    expect(held, ['t2']);
    expect(picked, isEmpty);
  });

  testWidgets('holding All does nothing: it is no tab', (tester) async {
    final held = <String>[];
    final picked = <String?>[];
    await pumpBar(tester, onLongPress: held.add, onSelected: picked.add);

    await tester.longPress(find.text('All'));
    await tester.pump();

    expect(held, isEmpty);
  });

  testWidgets('a screen reader reaches the hold on a tab chip, not on All', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await pumpBar(tester, onLongPress: (_) {});

    expect(canHold(tester, 'Desktop, 2'), isTrue);
    expect(canHold(tester, 'All, 3'), isFalse);
    semantics.dispose();
  });

  testWidgets('with nothing to hold for, a held chip is still a tap', (
    tester,
  ) async {
    final picked = <String?>[];
    await pumpBar(tester, onSelected: picked.add);

    await tester.longPress(find.text('Docker'));
    await tester.pump();

    expect(picked, ['t2']);
    expect(canHold(tester, 'Docker, 1'), isFalse);
  });

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
