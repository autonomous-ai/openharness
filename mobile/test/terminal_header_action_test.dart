import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/terminal_header_action.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// The terminal header's marks sit close enough that their 44pt reaches used to
/// overlap, and a [Row] hit-tests in reverse paint order — so the LAST mark was
/// tested first and answered for a strip of its neighbour.
///
/// It was the tabs grid that lost, every time, because `⋮` is drawn after it.
void main() {
  Future<void> pumpRow(
    WidgetTester tester,
    List<String> pressed,
  ) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              TerminalHeaderAction(
                icon: LucideIcons.layoutGrid300,
                tooltip: 'Tabs',
                onPressed: () => pressed.add('tabs'),
              ),
              TerminalHeaderAction(
                icon: LucideIcons.ellipsisVertical300,
                tooltip: 'Agent actions',
                last: true,
                onPressed: () => pressed.add('actions'),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  test('two marks are far enough apart for two whole touch targets', () {
    // A mark draws a 24pt box and reaches [minTouchTarget] around it, so two
    // of them need their centres that far apart. The distance between two
    // neighbours is one gap from each plus the box between them.
    const boxWidth = 24.0;
    expect(
      2 * TerminalHeaderAction.gap + boxWidth,
      greaterThanOrEqualTo(minTouchTarget),
    );
  });

  testWidgets('the right edge of the tabs mark still presses the tabs mark', (
    tester,
  ) async {
    final pressed = <String>[];
    await pumpRow(tester, pressed);

    final tabs = find.byTooltip('Tabs');
    final box = tester.getRect(tabs);
    // Just inside the far edge of its reach — the strip `⋮` used to take.
    await tester.tapAt(
      Offset(box.center.dx + minTouchTarget / 2 - 1, box.center.dy),
    );
    await tester.pump();

    expect(pressed, ['tabs']);
  });

  testWidgets('and the actions mark still presses its own', (tester) async {
    final pressed = <String>[];
    await pumpRow(tester, pressed);

    await tester.tap(find.byTooltip('Agent actions'));
    await tester.pump();

    expect(pressed, ['actions']);
  });
}
