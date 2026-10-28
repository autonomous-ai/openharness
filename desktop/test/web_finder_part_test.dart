import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/finder/widgets/finder_pane_panel.dart' as finder;
import 'package:harness/web/parts/finder_pane_panel.dart' as web;

void main() {
  testWidgets('a browser Finder tile downloads the Finder, then draws it', (
    tester,
  ) async {
    Future<bool> Function()? guard;
    double? width;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: web.FinderPanePanel(
            key: const ValueKey('finder-pane-p1'),
            root: '/nowhere',
            onGuardClose: (check) => guard = check,
            onFixedWidth: (value) => width = value,
            compactHeader: true,
          ),
        ),
      ),
    );
    expect(find.text('Loading…'), findsOneWidget);

    // A native test has no part to fetch; loadLibrary answers on a timer.
    await tester.pump(const Duration(milliseconds: 1));

    final panel = tester.widget<finder.FinderPanePanel>(
      find.byType(finder.FinderPanePanel),
    );
    expect(panel.root, '/nowhere');
    expect(panel.compactHeader, isTrue);
    panel.onGuardClose!(() async => true);
    panel.onFixedWidth!(44);
    expect(guard, isNotNull);
    expect(width, 44);
  });
}
