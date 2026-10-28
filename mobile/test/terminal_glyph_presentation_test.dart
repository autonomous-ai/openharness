import 'dart:ui' show ParagraphBuilder, ParagraphConstraints;

import 'package:flutter/painting.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
// ignore: implementation_imports
import 'package:xterm/src/ui/painter.dart';

void main() {
  test('private-use icons are the Nerd Font range', () {
    expect(isPrivateUseIcon(0xF07B), isTrue);
    expect(isPrivateUseIcon(0xF0001), isTrue);
    expect(isPrivateUseIcon('A'.codeUnitAt(0)), isFalse);
  });

  test('an em-wide icon is scaled down to the text cell', () {
    expect(
      symbolFontSizeForCell(fontSize: 14, cellWidth: 8.4, symbolAdvance: 14),
      closeTo(8.4, 0.001),
    );
  });

  test('the bundled icon face is one em wide, so fitting lands on the cell', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    final data = await rootBundle.load(
      'assets/fonts/symbols-nerd-font-mono/SymbolsNerdFontMono-Regular.ttf',
    );
    final loader = FontLoader('Symbols Nerd Font Mono')
      ..addFont(Future.value(data));
    await loader.load();

    final advance = _advance('\u{f07b}', 14);
    expect(advance, closeTo(14, 1));
    final fitted = symbolFontSizeForCell(
      fontSize: 14,
      cellWidth: 8.4,
      symbolAdvance: advance,
    );
    expect(_advance('\u{f07b}', fitted), closeTo(8.4, 0.5));
  });
}

double _advance(String text, double fontSize) {
  final style = TextStyle(
    fontFamily: 'Symbols Nerd Font Mono',
    fontSize: fontSize,
  );
  final builder = ParagraphBuilder(style.getParagraphStyle())
    ..pushStyle(style.getTextStyle())
    ..addText(text);
  final paragraph = builder.build()
    ..layout(const ParagraphConstraints(width: double.infinity));
  final width = paragraph.maxIntrinsicWidth;
  paragraph.dispose();
  return width;
}
