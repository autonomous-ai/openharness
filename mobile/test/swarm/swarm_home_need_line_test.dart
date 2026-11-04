import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_home_need_line.dart';

/// Swarm Home's need-you line (anh Dee, 2026-11-04: "less is better"): one
/// line in place of the three tiles, how many need the person and the work
/// done since they left.
void main() {
  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> pump(WidgetTester tester, Widget line, {double width = 390}) =>
      tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(width: width, child: line),
            ),
          ),
        ),
      );

  String words(WidgetTester tester) =>
      tester.widget<Text>(key('swarm-need-line-text')).textSpan!.toPlainText();

  testWidgets('says how many need the person, then the work done', (
    tester,
  ) async {
    await pump(tester, SwarmNeedLine(needs: 2, done: 1, onTap: () {}));

    expect(words(tester), '2 need you · 1 done');
    expect(
      tester.getSize(key('swarm-need-line')).height,
      greaterThanOrEqualTo(44),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('with no work done, or not known yet, it says only what needs '
      'the person', (tester) async {
    await pump(tester, SwarmNeedLine(needs: 3, done: 0, onTap: () {}));
    expect(words(tester), '3 need you');

    await pump(tester, SwarmNeedLine(needs: 3, done: null, onTap: () {}));
    expect(words(tester), '3 need you');
  });

  testWidgets('is one button for a screen reader, and a tap opens it', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    var taps = 0;
    await pump(tester, SwarmNeedLine(needs: 2, done: 1, onTap: () => taps++));

    expect(find.bySemanticsLabel('2 need you, 1 done'), findsOneWidget);
    await tester.tap(key('swarm-need-line'));
    expect(taps, 1);
    semantics.dispose();
  });

  testWidgets('a narrow phone shortens the words, never overflows', (
    tester,
  ) async {
    await pump(
      tester,
      SwarmNeedLine(needs: 12, done: 340, onTap: () {}),
      width: 120,
    );

    expect(tester.takeException(), isNull);
  });
}
