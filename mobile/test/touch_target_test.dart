import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/widgets/app_icon_button.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

/// A glyph drawn small is still pressed with a thumb.
void main() {
  Future<int Function()> pumpButton(WidgetTester tester) async {
    var presses = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              height: 60,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AppIconButton(icon: Icons.search, onPressed: () => presses++),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    return () => presses;
  }

  testWidgets('a tap just outside the drawn button still presses it', (
    tester,
  ) async {
    final presses = await pumpButton(tester);
    final center = tester.getCenter(find.byType(AppIconButton));

    // 18pt off centre: outside the 24pt box, inside a 44pt target.
    await tester.tapAt(center + const Offset(0, 18));
    await tester.tapAt(center - const Offset(0, 18));

    expect(presses(), 2);
  });

  testWidgets('the button takes no more room than it draws', (tester) async {
    await pumpButton(tester);

    expect(tester.getSize(find.byType(AppIconButton)), const Size(24, 24));
  });

  testWidgets('a tap past the target is not the button\'s', (tester) async {
    final presses = await pumpButton(tester);
    final center = tester.getCenter(find.byType(AppIconButton));

    await tester.tapAt(center + const Offset(0, minTouchTarget / 2 + 4));

    expect(presses(), 0);
  });
}
