import 'dart:ui' show ParagraphBuilder, ParagraphConstraints;

import 'package:flutter/painting.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/painter.dart';

void main() {
  test('record-button status marker paints as a monochrome filled circle', () {
    expect(terminalGlyphText(0x23FA), '\u25CF');
  });

  test('ordinary terminal glyphs remain unchanged', () {
    expect(terminalGlyphText('A'.codeUnitAt(0)), 'A');
  });

  test('private-use icons are the Nerd Font range, including the supplementary planes', () {
    expect(isPrivateUseIcon(0xF07B), isTrue);
    expect(isPrivateUseIcon(0xF0001), isTrue);
    expect(isPrivateUseIcon(0x100001), isTrue);
    expect(isPrivateUseIcon('A'.codeUnitAt(0)), isFalse);
    expect(isPrivateUseIcon(0x2500), isFalse);
    expect(isPrivateUseIcon(0x25CF), isFalse);
  });

  test('an em-wide icon is scaled down to the text cell', () {
    expect(
      symbolFontSizeForCell(fontSize: 13, cellWidth: 7.8, symbolAdvance: 13),
      closeTo(7.8, 0.001),
    );
    expect(
      symbolFontSizeForCell(fontSize: 13, cellWidth: 7.8, symbolAdvance: 0),
      13,
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

    final advance = _advance('\u{f07b}', 13);
    expect(advance, closeTo(13, 1));
    final fitted = symbolFontSizeForCell(
      fontSize: 13,
      cellWidth: 7.8,
      symbolAdvance: advance,
    );
    expect(_advance('\u{f07b}', fitted), closeTo(7.8, 0.5));
  });
}

double _advance(String text, double fontSize) {
  final style = TextStyle(fontFamily: 'Symbols Nerd Font Mono', fontSize: fontSize);
  final builder = ParagraphBuilder(style.getParagraphStyle())
    ..pushStyle(style.getTextStyle())
    ..addText(text);
  final paragraph = builder.build()
    ..layout(const ParagraphConstraints(width: double.infinity));
  final width = paragraph.maxIntrinsicWidth;
  paragraph.dispose();
  return width;
}
