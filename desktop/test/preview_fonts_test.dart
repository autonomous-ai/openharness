import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;

/// Desktop tests on Linux CI drew every glyph one em wide (Flutter's test font): that machine has neither macOS's system
/// face nor the Flutter SDK's cached Roboto, and the app's text there asks for `Ubuntu Sans` and its fallbacks
/// (lib/shared/theme/app_type.dart), which [loadPreviewFonts] never registered. So a one-line layout check, such as the
/// scorecard's crew move time (#3246), had to skip there and guarded the layout on a Mac only (task #3511). Here the helper
/// runs as on such a machine: nothing from the system and no SDK cache, only what the tests bundle.
void main() {
  /// The app's text on Linux, as lib/shared/theme/app_type.dart asks for it there.
  const linux = TextStyle(
    fontFamily: 'Ubuntu Sans',
    fontFamilyFallback: ['Ubuntu', 'Noto Sans', 'DejaVu Sans', 'sans-serif'],
    fontSize: 13,
  );

  double width(String text, TextStyle style) =>
      (TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: TextDirection.ltr,
      )..layout()).width;

  setUpAll(() async {
    await loadPreviewFonts(
      systemFace: '/nonexistent/SFNS.ttf',
      flutterRoot: '/nonexistent',
    );
  });

  test('gives the app\'s text a real face with no system face and no SDK cache, on Linux\'s families too', () {
    for (final style in [DesktopChrome.control(), linux]) {
      expect(
        width('i', style),
        lessThan(width('W', style) / 2),
        reason: '${style.fontFamily} still draws in the test font, one em per glyph',
      );
    }
  });

  // The scorecard's crew move time (#3246) is its widest cell: 96 px at the table's 13 px.
  Future<Size> cell(WidgetTester tester, double cellWidth) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: cellWidth,
              child: Text('3m06 · 9m59', style: DesktopChrome.control()),
            ),
          ),
        ),
      ),
    );
    return tester.getSize(find.text('3m06 · 9m59'));
  }

  testWidgets('a one-line check fails a too-narrow cell and passes the built one', (tester) async {
    final line = (await cell(tester, 400)).height;
    expect((await cell(tester, 40)).height, greaterThan(line), reason: 'a 40 px cell must wrap');
    expect((await cell(tester, 96)).height, line, reason: 'the 96 px cell holds it on one line');
  });
}
