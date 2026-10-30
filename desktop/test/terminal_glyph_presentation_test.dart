import 'dart:ui'
    show
        Canvas,
        ImageByteFormat,
        Offset,
        ParagraphBuilder,
        ParagraphConstraints,
        PictureRecorder,
        Rect;

import 'package:flutter/painting.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/painter.dart';
import 'package:xterm/xterm.dart';

void main() {
  test('record-button status marker paints as a monochrome filled circle', () {
    expect(terminalGlyphText(0x23FA), '\u25CF');
  });

  test('ordinary terminal glyphs remain unchanged', () {
    expect(terminalGlyphText('A'.codeUnitAt(0)), 'A');
  });

  test('only the private-use icons the bundled face has are drawn with it', () {
    expect(isBundledSymbol(0xF07B), isTrue);
    expect(isBundledSymbol(0xE0B0), isTrue);
    expect(isBundledSymbol(0xF0001), isTrue);
    // SF Mono's Apple logo, and private-use characters the face lacks.
    expect(isBundledSymbol(0xF8FF), isFalse);
    expect(isBundledSymbol(0xF534), isFalse);
    expect(isBundledSymbol(0x100001), isFalse);
    // The face has a few non-private-use symbols too; the text face draws those.
    expect(isBundledSymbol(0x23FB), isFalse);
    expect(isBundledSymbol('A'.codeUnitAt(0)), isFalse);
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

  test(
    'the bundled icon face is one em wide, so fitting lands on the cell',
    () async {
      await _loadIconFace();

      final advance = _advance('\u{f07b}', 13);
      expect(advance, closeTo(13, 1));
      final fitted = symbolFontSizeForCell(
        fontSize: 13,
        cellWidth: 7.8,
        symbolAdvance: advance,
      );
      expect(_advance('\u{f07b}', fitted), closeTo(7.8, 0.5));
    },
  );

  test(
    'an icon cell is drawn with the symbol face and stays inside its cell',
    () async {
      await _loadIconFace();
      await _loadTextFace();
      const fontSize = 13.0;
      // The web's text face: its cell is narrower than an em, so an icon drawn
      // unscaled would spill into the next cell.
      final painter = TerminalPainter(
        theme: TerminalThemes.defaultTheme,
        textStyle: const TerminalStyle(
          fontSize: fontSize,
          fontFamily: 'Roboto Mono',
          fontFamilyFallback: [],
          symbolFontFamily: 'Symbols Nerd Font Mono',
        ),
        textScaler: TextScaler.noScaling,
      );
      final cell = painter.cellSize;
      expect(cell.width, lessThan(fontSize * 0.7));
      final icon = CellData(
        foreground: 0,
        background: 0,
        flags: 0,
        content: 0xF07B | (1 << CellContent.widthShift),
      );

      final painted = await _raster(painter, icon, columns: 2);
      final advance = _advance('\u{f07b}', fontSize);
      final fitted = symbolFontSizeForCell(
        fontSize: fontSize,
        cellWidth: cell.width,
        symbolAdvance: advance,
      );
      final reference = await _rasterParagraph(
        text: '\u{f07b}',
        style: TextStyle(
          fontFamily: 'Symbols Nerd Font Mono',
          fontSize: fitted,
          height: 1.2,
          color: TerminalThemes.defaultTheme.foreground,
        ),
        cell: cell,
        columns: 2,
      );

      expect(
        painted.map((pixel) => pixel.argb),
        reference.map((pixel) => pixel.argb),
      );
      expect(
        painted.any((pixel) => pixel.x < cell.width && pixel.argb != 0),
        isTrue,
      );
      expect(
        painted
            .where((pixel) => pixel.x >= cell.width.ceil())
            .map((pixel) => pixel.argb),
        everyElement(0),
      );
    },
  );

  test('Powerline separators carry their ink; other icons do not', () {
    final (left, right) = powerlineSeparatorInk(0xE0B0)!;
    expect(left, lessThan(0));
    expect(right, closeTo(0.65, 0.01));
    // The branch symbol beside them is an icon, fitted like any other.
    expect(powerlineSeparatorInk(0xE0A0), isNull);
    expect(powerlineSeparatorInk(0xF07B), isNull);
  });

  test('a Powerline separator covers its cell from top to bottom', () async {
    await _loadIconFace();
    await _loadTextFace();
    final painter = TerminalPainter(
      theme: TerminalThemes.defaultTheme,
      textStyle: const TerminalStyle(
        fontSize: 13.0,
        fontFamily: 'Roboto Mono',
        fontFamilyFallback: [],
        symbolFontFamily: 'Symbols Nerd Font Mono',
      ),
      textScaler: TextScaler.noScaling,
    );
    final cell = painter.cellSize;
    final rows = cell.height.ceil();
    final outside = cell.width.ceil();

    // U+E0B0 points right: its flat edge is the cell's left edge and its
    // point reaches the right one.
    final arrow = await _raster(painter, _iconCell(0xE0B0), columns: 2);
    final leftEdge = arrow.where((pixel) => pixel.x == 0).toList();
    expect(leftEdge, hasLength(rows));
    expect(leftEdge.map((pixel) => pixel.argb >>> 24), everyElement(isNonZero));
    expect(leftEdge[rows ~/ 2].argb >>> 24, 0xFF);
    expect(
      arrow.any((pixel) => pixel.x == outside - 1 && pixel.argb != 0),
      isTrue,
    );
    expect(
      arrow.where((pixel) => pixel.x >= outside).map((pixel) => pixel.argb),
      everyElement(0),
    );

    // U+E0B2 points left, its flat edge the cell's right edge.
    final mirrored = await _raster(painter, _iconCell(0xE0B2), columns: 2);
    final rightEdge = mirrored
        .where((pixel) => pixel.x == cell.width.floor() - 1)
        .map((pixel) => pixel.argb >>> 24);
    expect(rightEdge, hasLength(rows));
    expect(rightEdge, everyElement(isNonZero));
    expect(
      mirrored.where((pixel) => pixel.x >= outside).map((pixel) => pixel.argb),
      everyElement(0),
    );
  });

  test(
    'a private-use character the icon face lacks is drawn as text',
    () async {
      await _loadIconFace();
      await _loadTextFace();
      final cell = _iconCell(0xF8FF);
      expect(
        (await _raster(_painter(), cell, columns: 1)).map((p) => p.argb),
        (await _raster(
          _painter(symbols: false),
          cell,
          columns: 1,
        )).map((p) => p.argb),
      );
    },
  );

  test(
    'an underlined icon is underlined level with the text beside it',
    () async {
      await _loadIconFace();
      await _loadTextFace();
      final painter = _painter();
      final text = await _underlineRows(painter, 0x20);
      final icon = await _underlineRows(painter, 0xF07B);
      expect(text, isNotEmpty);
      // Where the icon's own ink lies under the line, it adds nothing there.
      expect(icon, isNotEmpty);
      expect(text.containsAll(icon), isTrue, reason: '$icon not in $text');
    },
  );
}

TerminalPainter _painter({bool symbols = true}) => TerminalPainter(
  theme: TerminalThemes.defaultTheme,
  textStyle: TerminalStyle(
    fontSize: 13.0,
    fontFamily: 'Roboto Mono',
    fontFamilyFallback: [],
    symbolFontFamily: symbols ? 'Symbols Nerd Font Mono' : null,
  ),
  textScaler: TextScaler.noScaling,
);

/// The pixel rows an underline adds to in [codePoint]'s cell.
Future<Set<int>> _underlineRows(TerminalPainter painter, int codePoint) async {
  final plain = await _raster(painter, _iconCell(codePoint), columns: 1);
  final underlined = await _raster(
    painter,
    CellData(
      foreground: 0,
      background: 0,
      flags: CellFlags.underline,
      content: codePoint | (1 << CellContent.widthShift),
    ),
    columns: 1,
  );
  final width = painter.cellSize.width.ceil();
  return {
    for (var i = 0; i < plain.length; i++)
      if (plain[i].argb != underlined[i].argb) i ~/ width,
  };
}

CellData _iconCell(int codePoint) => CellData(
  foreground: 0,
  background: 0,
  flags: 0,
  content: codePoint | (1 << CellContent.widthShift),
);

Future<void> _loadIconFace() async {
  TestWidgetsFlutterBinding.ensureInitialized();
  if (_iconFaceLoaded) return;
  final data = await rootBundle.load(
    'assets/fonts/symbols-nerd-font-mono/SymbolsNerdFontMono-Regular.ttf',
  );
  final loader = FontLoader('Symbols Nerd Font Mono')
    ..addFont(Future.value(data));
  await loader.load();
  _iconFaceLoaded = true;
}

bool _iconFaceLoaded = false;

Future<void> _loadTextFace() async {
  if (_textFaceLoaded) return;
  final loader = FontLoader('Roboto Mono')
    ..addFont(rootBundle.load('assets/fonts/roboto-mono/RobotoMono.ttf'));
  await loader.load();
  _textFaceLoaded = true;
}

bool _textFaceLoaded = false;

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

class _Pixel {
  const _Pixel(this.x, this.argb);
  final int x;
  final int argb;
}

Future<List<_Pixel>> _raster(
  TerminalPainter painter,
  CellData cellData, {
  required int columns,
}) async {
  final cell = painter.cellSize;
  final recorder = PictureRecorder();
  final canvas = Canvas(recorder);
  painter.paintCellForeground(canvas, Offset.zero, cellData);
  return _pixels(recorder, cell, columns);
}

Future<List<_Pixel>> _rasterParagraph({
  required String text,
  required TextStyle style,
  required Size cell,
  required int columns,
}) async {
  final builder = ParagraphBuilder(style.getParagraphStyle())
    ..pushStyle(style.getTextStyle())
    ..addText(text);
  final paragraph = builder.build()
    ..layout(const ParagraphConstraints(width: double.infinity));
  final recorder = PictureRecorder();
  final canvas = Canvas(recorder);
  final bounds = Rect.fromLTWH(0, 0, cell.width, cell.height);
  final dx = (bounds.width - paragraph.maxIntrinsicWidth) / 2;
  final dy = (bounds.height - paragraph.height) / 2;
  canvas.save();
  canvas.clipRect(bounds);
  canvas.drawParagraph(paragraph, Offset(dx, dy));
  canvas.restore();
  paragraph.dispose();
  return _pixels(recorder, cell, columns);
}

Future<List<_Pixel>> _pixels(
  PictureRecorder recorder,
  Size cell,
  int columns,
) async {
  final width = (cell.width * columns).ceil();
  final height = cell.height.ceil();
  final image = await recorder.endRecording().toImage(width, height);
  final bytes = await image.toByteData(format: ImageByteFormat.rawRgba);
  final data = bytes!;
  final pixels = <_Pixel>[];
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      final i = (y * width + x) * 4;
      final argb =
          (data.getUint8(i + 3) << 24) |
          (data.getUint8(i) << 16) |
          (data.getUint8(i + 1) << 8) |
          data.getUint8(i + 2);
      pixels.add(_Pixel(x, argb));
    }
  }
  return pixels;
}
