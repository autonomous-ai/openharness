import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/widgets/terminal_pane_badges.dart';

/// The bar in a terminal's corner while a pasted image goes up to the machine,
/// or a linked file comes down for a preview.
void main() {
  Future<void> pump(WidgetTester tester, TransferProgressBadge badge) =>
      tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: SizedBox(width: 300, child: badge)),
        ),
      );

  testWidgets('says how far along it is, and fills the bar that far', (
    tester,
  ) async {
    await pump(
      tester,
      TransferProgressBadge(
        label: 'Uploading screenshot.png',
        fraction: 0.426,
        onCancel: () {},
      ),
    );
    expect(find.text('Uploading screenshot.png · 43%'), findsOneWidget);
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      0.426,
    );
  });

  testWidgets('before the size is known it gives no figure, and the bar runs '
      'on its own', (tester) async {
    await pump(
      tester,
      TransferProgressBadge(
        label: 'Preparing preview…',
        fraction: null,
        onCancel: () {},
      ),
    );
    // A made-up "0%" would read as stalled.
    expect(find.text('Preparing preview…'), findsOneWidget);
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      isNull,
    );
  });

  testWidgets('Cancel stops the transfer', (tester) async {
    var cancelled = 0;
    await pump(
      tester,
      TransferProgressBadge(
        label: 'Downloading clip.mp4',
        fraction: 0.5,
        onCancel: () => cancelled++,
      ),
    );
    await tester.tap(find.text('CANCEL'));
    expect(cancelled, 1);
  });
}
