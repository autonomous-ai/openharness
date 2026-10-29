import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/phone/sheet_list.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

/// Every themed button reaches the 44-point touch target on its own, while it
/// keeps the size it is drawn at; rows inside a sheet round at the row radius.
/// See the Phone section of desktop/design/desktop-design-system.md.
void main() {
  Future<int Function()> pump(
    WidgetTester tester,
    Widget Function(VoidCallback onPressed) button,
  ) async {
    var presses = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(body: Center(child: button(() => presses++))),
      ),
    );
    return () => presses;
  }

  final buttons = <String, (Widget Function(VoidCallback), double)>{
    'filled': ((p) => FilledButton(onPressed: p, child: const Text('Go')), 32),
    'outlined': (
      (p) => OutlinedButton(onPressed: p, child: const Text('Go')),
      32,
    ),
    'text': ((p) => TextButton(onPressed: p, child: const Text('Go')), 32),
    'icon': (
      (p) => IconButton(onPressed: p, icon: const Icon(Icons.close)),
      40,
    ),
  };

  for (final MapEntry(key: name, value: (build, drawn)) in buttons.entries) {
    testWidgets('a $name button is drawn at $drawn and pressed across 44', (
      tester,
    ) async {
      final presses = await pump(tester, build);
      final ink = find.byType(InkWell);
      expect(tester.getSize(ink).height, drawn);

      final top = tester.getRect(ink).topCenter;
      final reach = (44 - drawn) / 2;
      await tester.tapAt(top - Offset(0, reach - 1));
      expect(presses(), 1);

      await tester.tapAt(top - Offset(0, reach + 2));
      expect(presses(), 1);
    });
  }

  testWidgets('a group of sheet rows rounds its corners at 10', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: const Scaffold(
          body: SheetRow(
            leading: SizedBox(),
            title: Text('main'),
            first: true,
            last: true,
          ),
        ),
      ),
    );
    final box = tester
        .widgetList<Container>(
          find.descendant(
            of: find.byType(SheetRow),
            matching: find.byType(Container),
          ),
        )
        .map((c) => c.decoration)
        .whereType<BoxDecoration>()
        .firstWhere((d) => d.borderRadius != null);
    final radius = box.borderRadius!.resolve(TextDirection.ltr);
    expect(radius.topLeft.x, 10);
    expect(radius.bottomRight.x, 10);
  });
}
