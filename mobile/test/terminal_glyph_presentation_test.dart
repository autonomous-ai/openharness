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
// ignore: implementation_imports
import 'package:xterm/src/ui/painter.dart';
import 'package:xterm/xterm.dart';

void main() {
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
      symbolFontSizeForCell(fontSize: 14, cellWidth: 8.4, symbolAdvance: 14),
      closeTo(8.4, 0.001),
    );
  });

  test(
    'the bundled icon face is one em wide, so fitting lands on the cell',
    () async {
      await _loadIconFace();

      final advance = _advance('\u{f07b}', 14);
      expect(advance, closeTo(14, 1));
      final fitted = symbolFontSizeForCell(
        fontSize: 14,
        cellWidth: 8.4,
        symbolAdvance: advance,
      );
      expect(_advance('\u{f07b}', fitted), closeTo(8.4, 0.5));
    },
  );

  test(
    'an icon cell is drawn with the symbol face and stays inside its cell',
    () async {
      await _loadIconFace();
      const fontSize = 14.0;
      final painter = TerminalPainter(
        theme: TerminalThemes.defaultTheme,
        textStyle: const TerminalStyle(
          fontSize: fontSize,
          symbolFontFamily: 'Symbols Nerd Font Mono',
        ),
        textScaler: TextScaler.noScaling,
      );
      final cell = painter.cellSize;
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
    final (left, right) = powerlineSeparatorInk(0xE0C0)!;
    expect(left, lessThan(0));
    expect(right, closeTo(1, 0.01));
    // The branch symbol beside them is an icon, fitted like any other.
    expect(powerlineSeparatorInk(0xE0A0), isNull);
    expect(powerlineSeparatorInk(0xF07B), isNull);
  });

  test('a filled Powerline separator is a shape cornered on its cell', () {
    const cell = Rect.fromLTWH(10, 0, 7.75, 16);
    expect(powerlineSeparatorInk(0xE0B0), isNull);
    final arrow = powerlineSeparatorPath(0xE0B0, cell, 1)!;
    // Its flat side reaches a pixel into the segment before it, and its
    // corners are the cell's, so the corner pixels show on every platform.
    expect(
      arrow.getBounds(),
      rectMoreOrLessEquals(const Rect.fromLTRB(9, 0, 17.75, 16)),
    );
    expect(arrow.contains(const Offset(10.05, 0.1)), isTrue);
    expect(arrow.contains(const Offset(10.05, 15.9)), isTrue);
    expect(
      powerlineSeparatorPath(0xE0B2, cell, 1)!.getBounds(),
      rectMoreOrLessEquals(const Rect.fromLTRB(10, 0, 18.75, 16)),
    );
    // A cap's curve stays inside the cell.
    expect(
      powerlineSeparatorPath(0xE0B6, cell, 1)!.getBounds().left,
      moreOrLessEquals(10),
    );
    // The thin separators are lines in the face, drawn from it.
    expect(powerlineSeparatorPath(0xE0B1, cell, 1), isNull);
    expect(powerlineSeparatorPath(0xF07B, cell, 1), isNull);
  });

  test('a Powerline separator covers its cell from top to bottom', () async {
    await _loadIconFace();
    final painter = TerminalPainter(
      theme: TerminalThemes.defaultTheme,
      textStyle: const TerminalStyle(
        fontSize: 14.0,
        symbolFontFamily: 'Symbols Nerd Font Mono',
      ),
      textScaler: TextScaler.noScaling,
    );
    final cell = painter.cellSize;
    final rows = cell.height.ceil();
    final last = cell.width.ceil() - 1;
    // A flat side's bleed reaches at most a pixel into the neighbour.
    final outside = (cell.width + 1).ceil();

    // U+E0B0 points right: its flat edge is the cell's left edge and its
    // point reaches the right one, and no further.
    final arrow = await _raster(painter, _iconCell(0xE0B0), columns: 2);
    final leftEdge = arrow.where((pixel) => pixel.x == 0).toList();
    expect(leftEdge, hasLength(rows));
    expect(leftEdge.map((pixel) => pixel.argb >>> 24), everyElement(isNonZero));
    expect(leftEdge[rows ~/ 2].argb >>> 24, 0xFF);
    expect(arrow.any((pixel) => pixel.x == last && pixel.argb != 0), isTrue);
    expect(
      arrow.where((pixel) => pixel.x > last).map((pixel) => pixel.argb),
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

    // U+E0B6 is a cap rounded on the left: its curve stops at its own cell,
    // or a cap in the first column is cut off by the terminal's edge.
    final recorder = PictureRecorder();
    painter.paintCellForeground(
      Canvas(recorder),
      const Offset(2, 0),
      _iconCell(0xE0B6),
    );
    final cap = await _pixels(recorder, cell, 2);
    expect(
      cap.where((pixel) => pixel.x < 2).map((pixel) => pixel.argb),
      everyElement(0),
    );
    expect(cap.any((pixel) => pixel.x == 2 && pixel.argb != 0), isTrue);
  });

  test('a Powerline separator joins its segment without a seam', () async {
    await _loadIconFace();
    final painter = _painter();
    final cell = painter.cellSize;
    const magenta = 0xFFC040C0;
    // A magenta segment, then U+E0B4 closing it over a cyan one. Starting
    // half a pixel in puts the cells' shared edge inside a pixel.
    final segment = CellData(
      foreground: 0,
      background: CellColor.rgb | (magenta & 0xFFFFFF),
      flags: 0,
      content: 0x20 | (1 << CellContent.widthShift),
    );
    final separator = CellData(
      foreground: CellColor.rgb | (magenta & 0xFFFFFF),
      background: CellColor.rgb | 0x40A0C0,
      flags: 0,
      content: 0xE0B4 | (1 << CellContent.widthShift),
    );
    final recorder = PictureRecorder();
    final canvas = Canvas(recorder);
    const start = Offset(0.5, 0);
    painter.paintCell(canvas, start, segment);
    painter.paintCell(canvas, start.translate(cell.width, 0), separator);
    final pixels = await _pixels(recorder, cell, 3);

    final width = (cell.width * 3).ceil();
    final edge = (start.dx + cell.width).floor();
    final middle = pixels[(cell.height ~/ 2) * width + edge].argb;
    for (final shift in [16, 8, 0]) {
      expect(
        (middle >> shift) & 0xFF,
        closeTo((magenta >> shift) & 0xFF, 2),
        reason: middle.toRadixString(16),
      );
    }
  });

  test(
    'a private-use character the icon face lacks is drawn as text',
    () async {
      await _loadIconFace();
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
    fontSize: 14.0,
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
