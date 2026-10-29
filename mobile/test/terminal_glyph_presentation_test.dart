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
}

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
