import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/toolbar_pill.dart';

import 'support/real_fonts.dart';

/// A toolbar pill's label sits in its middle whatever it is given (a bare label, as the leaderboard's This week and
/// Settings > Connectors' Browse are, or a row of an icon and words), and the pill hugs it, also inside a Flexible.
void main() {
  setUpAll(loadRealFonts);

  Future<void> show(WidgetTester tester, Widget pill) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Center(
          child: SizedBox(width: 400, child: Row(children: [pill])),
        ),
      ),
    ),
  );

  final label = find.text('This week');
  final pill = find.byType(ToolbarPill);

  void expectCentred(WidgetTester tester) {
    final box = tester.getRect(pill), words = tester.getRect(label);
    // The words are laid out at their own height, not the pill's, and sit in its middle.
    expect(words.height, lessThan(box.height));
    expect(words.center.dy, moreOrLessEquals(box.center.dy, epsilon: 0.5));
  }

  testWidgets('a bare label sits in the pill\'s middle', (tester) async {
    await show(
      tester,
      ToolbarPill(onTap: () {}, child: const Text('This week')),
    );
    expectCentred(tester);
  });

  testWidgets('a row of an icon and words sits in its middle too', (
    tester,
  ) async {
    await show(
      tester,
      ToolbarPill(
        onTap: () {},
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [Icon(Icons.add, size: 14), Text('This week')],
        ),
      ),
    );
    expectCentred(tester);
  });

  testWidgets('inside a Flexible the pill hugs its label', (tester) async {
    await show(
      tester,
      Flexible(
        child: ToolbarPill(onTap: () {}, child: const Text('This week')),
      ),
    );
    expectCentred(tester);
    // Its 9-point sides and the words, not the 400 the row offers.
    expect(
      tester.getSize(pill).width,
      moreOrLessEquals(tester.getSize(label).width + 18, epsilon: 0.5),
    );
  });
}
