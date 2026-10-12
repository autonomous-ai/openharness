import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/login_fleet_map.dart';

import 'support/real_fonts.dart';

/// The mockup's numbers (`_MapPainter`, a 512×190 drawing): the window's line
/// starts 7 in from the window's left edge, above panes that end at 317.
const _lineLeft = 197.0;
const _panesTop = 66.0;
const _panesRight = 317.0;

/// The sign-in card is 520 wide and pads its picture by 24 a side.
const _sheetMapWidth = 472.0;

void main() {
  // Ahem's square glyphs make every line here too wide to mean anything.
  setUpAll(loadRealFonts);

  testWidgets('in the sign-in sheet the window\'s line stays in the window', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: grid.BrightnessScope(
          child: const Center(
            child: SizedBox(width: _sheetMapWidth, child: LoginFleetMap()),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(seconds: 3));

    final picture = find.descendant(
      of: find.byType(LoginFleetMap),
      matching: find.byType(CustomPaint),
    );
    final canvas = TestRecordingCanvas();
    tester
        .widget<CustomPaint>(picture)
        .painter!
        .paint(canvas, tester.getSize(picture));
    final lines = [
      for (final call in canvas.invocations)
        if (call.invocation.memberName == #drawParagraph)
          (
            call.invocation.positionalArguments[0] as ui.Paragraph,
            call.invocation.positionalArguments[1] as Offset,
          ),
    ];
    final (line, at) = lines.singleWhere(
      (drawn) => drawn.$2.dx == _lineLeft && drawn.$2.dy < _panesTop,
    );
    // "this Mac · 4 linked" ended past the window's right edge here.
    expect(at.dx + line.longestLine, lessThanOrEqualTo(_panesRight));
    // And it is the short line that was drawn, in the picture's own measure:
    // labels keep their point size while the drawing scales.
    double drawn(String label) => (TextPainter(
      text: TextSpan(text: label, style: grid.AppType.caption(height: 1.2)),
      textDirection: TextDirection.ltr,
      textScaler: const TextScaler.linear(512 / _sheetMapWidth),
    )..layout()).width;
    expect(line.longestLine, closeTo(drawn('● this computer'), 0.5));
    expect(
      drawn('● this computer · 4 linked'),
      greaterThan(_panesRight - _lineLeft),
      reason: 'the count has no room in the sheet',
    );
  });

  test('the window is this computer on a Mac and on Linux alike', () {
    double wide(String label) => label.length * 6.0;
    final roomy = loginFleetHereLabel(web: false, room: 400, measure: wide);
    final tight = loginFleetHereLabel(web: false, room: 100, measure: wide);

    // One picture for both: "this Mac" stood on Linux too.
    expect(roomy, '● this computer · 4 linked');
    expect('$roomy $tight', isNot(contains('Mac')));
    // The count goes where it would run out of the window.
    expect(tight, '● this computer');
    expect(wide(tight), lessThanOrEqualTo(100));
    // A browser is not one of the person's computers.
    expect(
      loginFleetHereLabel(web: true, room: 400, measure: wide),
      'this browser · 4 linked',
    );
    expect(
      loginFleetHereLabel(web: true, room: 100, measure: wide),
      'this browser',
    );
  });
}
