@TestOn('browser')
library;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/web_download_button.dart';
import 'package:harness/widgets/workspace_share_button.dart';

void main() {
  testWidgets('a click opens the download page through the new-tab opener', (
    tester,
  ) async {
    final opened = <Uri>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: WebDownloadButton(
            open: (uri) async {
              opened.add(uri);
              return true;
            },
          ),
        ),
      ),
    );
    await tester.tap(find.byType(WebDownloadButton));
    await tester.pump();
    expect(opened, [WebDownloadButton.uri]);
    // The default opener is the new-tab one, not a same-tab navigation.
    expect(const WebDownloadButton().open, openInNewTab);
  });

  testWidgets('prominent fills it like Share; otherwise it stays quiet', (
    tester,
  ) async {
    Color fill() => tester
        .widget<ColoredBox>(
          find.descendant(
            of: find.byType(WebDownloadButton),
            matching: find.byType(ColoredBox),
          ),
        )
        .color;
    Color? ink() => tester.widget<Text>(find.text('Download app')).style?.color;

    await tester.pumpWidget(
      const MaterialApp(home: Center(child: WebDownloadButton())),
    );
    expect(fill(), Colors.transparent);

    await tester.pumpWidget(
      const MaterialApp(
        home: Center(child: WebDownloadButton(prominent: true)),
      ),
    );
    expect(fill(), WorkspaceShareButton.backgroundFor(true));
    expect(ink(), WorkspaceShareButton.foregroundFor(true));
  });

  for (final prominent in [true, false]) {
    testWidgets(
      'hover lifts the ${prominent ? 'fill' : 'well'}, never the weight',
      (tester) async {
        Color fill() => tester
            .widget<ColoredBox>(
              find.descendant(
                of: find.byType(WebDownloadButton),
                matching: find.byType(ColoredBox),
              ),
            )
            .color;
        FontWeight? weight() =>
            tester.widget<Text>(find.text('Download app')).style?.fontWeight;

        await tester.pumpWidget(
          MaterialApp(
            home: Center(child: WebDownloadButton(prominent: prominent)),
          ),
        );
        final resting = weight();
        expect(resting, prominent ? FontWeight.bold : FontWeight.normal);
        expect(
          fill(),
          WebDownloadButton.backgroundFor(prominent: prominent, hovered: false),
        );

        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: Offset.zero);
        addTearDown(mouse.removePointer);
        await mouse.moveTo(tester.getCenter(find.byType(WebDownloadButton)));
        await tester.pump();

        expect(
          fill(),
          WebDownloadButton.backgroundFor(prominent: prominent, hovered: true),
        );
        expect(
          fill(),
          isNot(
            WebDownloadButton.backgroundFor(
              prominent: prominent,
              hovered: false,
            ),
          ),
        );
        expect(weight(), resting);
      },
    );
  }
}
