@TestOn('browser')
library;

// The browser build's frame draws the keyboard focus ring (P8).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/web_entry.dart';

void main() {
  testWidgets('Tab in the web app draws the ring; a click puts it away', (
    tester,
  ) async {
    await tester.pumpWidget(
      appFrame(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: Column(
              children: [
                FilledButton(
                  autofocus: true,
                  onPressed: () {},
                  child: const Text('First'),
                ),
                OutlinedButton(onPressed: () {}, child: const Text('Second')),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    final ring = find.byKey(const Key('web-focus-ring'));
    expect(ring, findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.pump();
    expect(ring, findsOneWidget);
    await tester.tapAt(const Offset(5, 500));
    await tester.pump();
    expect(ring, findsNothing);
  });
}
