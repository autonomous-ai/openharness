import 'dart:ui';
import 'package:flutter/painting.dart';

import 'package:xterm/src/ui/glyph_run.dart';
import 'package:xterm/src/ui/line_picture_cache.dart';
import 'package:xterm/src/ui/palette_builder.dart';
import 'package:xterm/src/ui/paragraph_cache.dart';
import 'package:xterm/xterm.dart';

/// Returns the glyph text used to paint one terminal code point.
///
/// U+23FA defaults to Apple's coloured "record button" emoji when the active
/// monospace face has no glyph for it. Flutter's Skia fallback still chooses
/// that emoji even with a text-presentation selector, while SF Mono contains
/// U+25CF as the equivalent filled status dot. Substitute only while painting
/// so ANSI supplies the colour and the terminal buffer/copy text stays U+23FA.
String terminalGlyphText(int charCode) => charCode == 0x23FA
    ? String.fromCharCode(0x25CF)
    : String.fromCharCode(charCode);

/// Encapsulates the logic for painting various terminal elements.
class TerminalPainter {
  TerminalPainter({
    required TerminalTheme theme,
    required TerminalStyle textStyle,
    required TextScaler textScaler,
  })  : _textStyle = textStyle,
        _theme = theme,
        _textScaler = textScaler;

  /// A lookup table from terminal colors to Flutter colors.
  late var _colorPalette = PaletteBuilder(_theme).build();

  /// Size of each character in the terminal.
  late var _cellSize = _measureCharSize();

  /// The cached for cells in the terminal. Should be cleared when the same
  /// cell no longer produces the same visual output. For example, when
  /// [_textStyle] is changed, or when the system font changes.
  final _paragraphCache = ParagraphCache(10240);

  /// AUTONOMOUS PATCH: each line's drawing, replayed while the line is
  /// unchanged — see [paintLineCached].
  late final _linePictures = LinePictureCache(paintLine);

  /// Reused by every line drawn: painting is synchronous and never re-entrant.
  final _cell = CellData.empty();
  final _run = GlyphRun();

  TerminalStyle get textStyle => _textStyle;
  TerminalStyle _textStyle;
  set textStyle(TerminalStyle value) {
    if (value == _textStyle) return;
    _textStyle = value;
    _cellSize = _measureCharSize();
    _paragraphCache.clear();
    clearLinePictures();
  }

  TextScaler get textScaler => _textScaler;
  TextScaler _textScaler = TextScaler.linear(1.0);
  set textScaler(TextScaler value) {
    if (value == _textScaler) return;
    _textScaler = value;
    _cellSize = _measureCharSize();
    _paragraphCache.clear();
    clearLinePictures();
  }

  TerminalTheme get theme => _theme;
  TerminalTheme _theme;
  set theme(TerminalTheme value) {
    if (value == _theme) return;
    _theme = value;
    _colorPalette = PaletteBuilder(value).build();
    _paragraphCache.clear();
    clearLinePictures();
  }

  Size _measureCharSize() {
    const test = 'mmmmmmmmmm';

    final textStyle = _textStyle.toTextStyle();
    final builder = ParagraphBuilder(textStyle.getParagraphStyle());
    builder.pushStyle(
      textStyle.getTextStyle(textScaler: _textScaler),
    );
    builder.addText(test);

    final paragraph = builder.build();
    paragraph.layout(ParagraphConstraints(width: double.infinity));

    final result = Size(
      paragraph.maxIntrinsicWidth / test.length,
      paragraph.height,
    );

    paragraph.dispose();
    return result;
  }

  /// The size of each character in the terminal.
  Size get cellSize => _cellSize;

  /// When the set of font available to the system changes, call this method to
  /// clear cached state related to font rendering.
  void clearFontCache() {
    _cellSize = _measureCharSize();
    _paragraphCache.clear();
    clearLinePictures();
  }

  /// Drops every recorded line — the font, the scale or the colours changed, or
  /// the lines themselves belong to an emulator that is gone.
  void clearLinePictures() => _linePictures.clear();

  /// Paints the cursor based on the current cursor type.
  void paintCursor(
    Canvas canvas,
    Offset offset, {
    required TerminalCursorType cursorType,
    bool hasFocus = true,
  }) {
    final paint = Paint()
      ..color = _theme.cursor
      ..strokeWidth = 1;

    if (!hasFocus) {
      paint.style = PaintingStyle.stroke;
      canvas.drawRect(offset & _cellSize, paint);
      return;
    }

    switch (cursorType) {
      case TerminalCursorType.block:
        paint.style = PaintingStyle.fill;
        canvas.drawRect(offset & _cellSize, paint);
        return;
      case TerminalCursorType.underline:
        return canvas.drawLine(
          Offset(offset.dx, _cellSize.height - 1),
          Offset(offset.dx + _cellSize.width, _cellSize.height - 1),
          paint,
        );
      case TerminalCursorType.verticalBar:
        return canvas.drawLine(
          Offset(offset.dx, 0),
          Offset(offset.dx, _cellSize.height),
          paint,
        );
    }
  }

  @pragma('vm:prefer-inline')
  void paintHighlight(Canvas canvas, Offset offset, int length, Color color) {
    final endOffset =
        offset.translate(length * _cellSize.width, _cellSize.height);

    final paint = Paint()
      ..color = color
      ..strokeWidth = 1;

    canvas.drawRect(
      Rect.fromPoints(offset, endOffset),
      paint,
    );
  }

  /// AUTONOMOUS PATCH: [paintLine], replayed from the line's last recording while
  /// it has not changed since — see [LinePictureCache].
  void paintLineCached(Canvas canvas, Offset offset, BufferLine line) =>
      _linePictures.draw(canvas, offset, line);

  /// AUTONOMOUS PATCH: [line]'s last recording, handed over to the caller if it
  /// still shows [version] — see [LinePictureCache.take].
  Picture? takeLinePicture(BufferLine line, int version) =>
      _linePictures.take(line, version);

  /// Paints [line] to [canvas] at [offset]. The x offset of [offset] is usually
  /// 0, and the y offset is the top of the line.
  ///
  /// AUTONOMOUS PATCH: the fills first, then the characters — each in runs
  /// rather than a cell at a time. See [_paintBackground] and [_paintForeground].
  void paintLine(
    Canvas canvas,
    Offset offset,
    BufferLine line,
  ) {
    _paintBackground(canvas, offset, line);
    _paintForeground(canvas, offset, line);
  }

  /// The line's fills: one rectangle per run of cells that share a colour,
  /// where it was one per cell — a highlighted prompt row is one, not eighty.
  void _paintBackground(Canvas canvas, Offset offset, BufferLine line) {
    final cell = _cell;
    Color? color;
    var start = 0;
    var index = 0;
    while (index < line.length) {
      line.getCellData(index, cell);
      final next = _backgroundColorOf(cell);
      if (next != color) {
        _fillCells(canvas, offset, start, index, color);
        color = next;
        start = index;
      }
      // A wide character's fill covers its second cell too, whatever that holds.
      index += cell.content >> CellContent.widthShift == 2 ? 2 : 1;
    }
    _fillCells(canvas, offset, start, index, color);
  }

  /// Cells [start] to [end] filled with [color]; nothing for the default ground.
  void _fillCells(
    Canvas canvas,
    Offset offset,
    int start,
    int end,
    Color? color,
  ) {
    if (color == null || end <= start) return;
    canvas.drawRect(
      Rect.fromLTWH(
        offset.dx + start * _cellSize.width,
        offset.dy,
        // One pixel past the run, as each cell's own fill was: no hairline
        // between it and whatever is drawn next to it.
        (end - start) * _cellSize.width + 1,
        _cellSize.height,
      ),
      Paint()..color = color,
    );
  }

  /// The fill [cellData] calls for, or null for the default ground — which is
  /// left to the render object's own clear (see [paintCellBackground]).
  Color? _backgroundColorOf(CellData cellData) {
    if (cellData.flags & CellFlags.inverse != 0) {
      return resolveForegroundColor(cellData.foreground);
    }
    if (cellData.background & CellColor.typeMask == CellColor.normal) {
      return null;
    }
    return resolveBackgroundColor(cellData.background);
  }

  /// The line's characters: a run of printable ASCII in one style as ONE
  /// paragraph ([GlyphRun]), anything else — a wide or non-ASCII character, an
  /// underlined cell — a cell at a time, as before.
  void _paintForeground(Canvas canvas, Offset offset, BufferLine line) {
    final cell = _cell;
    final run = _run..close();
    for (var i = 0; i < line.length; i++) {
      line.getCellData(i, cell);
      if (GlyphRun.takes(cell)) {
        if (!run.add(i, cell)) {
          _paintRun(canvas, offset, run);
          run.open(i, cell);
        }
        continue;
      }
      _paintRun(canvas, offset, run);
      paintCellForeground(
          canvas, offset.translate(i * _cellSize.width, 0), cell);
      if (cell.content >> CellContent.widthShift == 2) i++;
    }
    _paintRun(canvas, offset, run);
  }

  /// Draws [run], when one is open, and closes it.
  void _paintRun(Canvas canvas, Offset offset, GlyphRun run) {
    if (!run.isOpen) return;
    final at = offset.translate(run.start * _cellSize.width, 0);
    if (run.length == 1) {
      // A lone character: the single-cell paragraph, cached across lines.
      paintCellForeground(
        canvas,
        at,
        CellData(
          foreground: run.foreground,
          background: run.background,
          flags: run.flags,
          content: run.content,
        ),
      );
    } else {
      final paragraph = _layoutRun(run);
      canvas.drawParagraph(paragraph, at);
      // The recording holds what it drew; the paragraph itself is not kept.
      paragraph.dispose();
    }
    run.close();
  }

  /// [run]'s characters laid out as one paragraph, in its style.
  Paragraph _layoutRun(GlyphRun run) {
    final style = _textStyle
        .toTextStyle(
          color: _foregroundColorOf(run.foreground, run.background, run.flags),
          bold: run.flags & CellFlags.bold != 0,
          italic: run.flags & CellFlags.italic != 0,
        )
        .copyWith(fontFeatures: _gridFeatures);
    final builder = ParagraphBuilder(style.getParagraphStyle());
    builder.pushStyle(style.getTextStyle(textScaler: _textScaler));
    builder.addText(run.text);
    return builder.build()
      ..layout(ParagraphConstraints(width: double.infinity));
  }

  /// No ligatures, contextual alternates or kerning in a run: each would move
  /// or merge glyphs that a terminal draws one per cell.
  static const _gridFeatures = [
    FontFeature.disable('liga'),
    FontFeature.disable('calt'),
    FontFeature.disable('kern'),
  ];

  @pragma('vm:prefer-inline')
  void paintCell(Canvas canvas, Offset offset, CellData cellData) {
    paintCellBackground(canvas, offset, cellData);
    paintCellForeground(canvas, offset, cellData);
  }

  /// Paints the character in the cell represented by [cellData] to [canvas] at
  /// [offset].
  @pragma('vm:prefer-inline')
  void paintCellForeground(Canvas canvas, Offset offset, CellData cellData) {
    final charCode = cellData.content & CellContent.codepointMask;
    if (charCode == 0) return;
    // A plain space has no ink — its colour is [paintCellBackground]'s — and a
    // TUI's screen is mostly spaces: padding, box interiors, the tail of every
    // short line. Each one was still a hash, a cache lookup and a
    // `drawParagraph`, every frame. Only an underlined space draws (see below).
    if (charCode == 0x20 && cellData.flags & CellFlags.underline == 0) return;

    final cacheKey = cellData.getHash() ^ _textScaler.hashCode;
    var paragraph = _paragraphCache.getLayoutFromCache(cacheKey);

    if (paragraph == null) {
      final cellFlags = cellData.flags;

      final style = _textStyle.toTextStyle(
        color: _foregroundColorOf(
          cellData.foreground,
          cellData.background,
          cellFlags,
        ),
        bold: cellFlags & CellFlags.bold != 0,
        italic: cellFlags & CellFlags.italic != 0,
        underline: cellFlags & CellFlags.underline != 0,
      );

      // Flutter does not draw an underline below a space which is not between
      // other regular characters. As only single characters are drawn, this
      // will never produce an underline below a space in the terminal. As a
      // workaround the regular space CodePoint 0x20 is replaced with
      // the CodePoint 0xA0. This is a non breaking space and a underline can be
      // drawn below it.
      var char = terminalGlyphText(charCode);
      if (cellFlags & CellFlags.underline != 0 && charCode == 0x20) {
        char = String.fromCharCode(0xA0);
      }

      paragraph = _paragraphCache.performAndCacheLayout(
        char,
        style,
        _textScaler,
        cacheKey,
      );
    }

    canvas.drawParagraph(paragraph, offset);
  }

  /// Paints the background of a cell represented by [cellData] to [canvas] at
  /// [offset].
  @pragma('vm:prefer-inline')
  void paintCellBackground(Canvas canvas, Offset offset, CellData cellData) {
    late Color color;
    final colorType = cellData.background & CellColor.typeMask;

    if (cellData.flags & CellFlags.inverse != 0) {
      color = resolveForegroundColor(cellData.foreground);
    } else if (colorType == CellColor.normal) {
      return;
    } else {
      color = resolveBackgroundColor(cellData.background);
    }

    final paint = Paint()..color = color;
    final doubleWidth = cellData.content >> CellContent.widthShift == 2;
    final widthScale = doubleWidth ? 2 : 1;
    final size = Size(_cellSize.width * widthScale + 1, _cellSize.height);
    canvas.drawRect(offset & size, paint);
  }

  /// The colour a cell's character is drawn in: its foreground, or its
  /// background when inverse, at half strength when faint.
  Color _foregroundColorOf(int foreground, int background, int flags) {
    final color = flags & CellFlags.inverse == 0
        ? resolveForegroundColor(foreground)
        : resolveBackgroundColor(background);
    return flags & CellFlags.faint != 0 ? color.withOpacity(0.5) : color;
  }

  /// Get the effective foreground color for a cell from information encoded in
  /// [cellColor].
  @pragma('vm:prefer-inline')
  Color resolveForegroundColor(int cellColor) {
    final colorType = cellColor & CellColor.typeMask;
    final colorValue = cellColor & CellColor.valueMask;

    switch (colorType) {
      case CellColor.normal:
        return _theme.foreground;
      case CellColor.named:
      case CellColor.palette:
        return _colorPalette[colorValue];
      case CellColor.rgb:
      default:
        return Color(colorValue | 0xFF000000);
    }
  }

  /// Get the effective background color for a cell from information encoded in
  /// [cellColor].
  @pragma('vm:prefer-inline')
  Color resolveBackgroundColor(int cellColor) {
    final colorType = cellColor & CellColor.typeMask;
    final colorValue = cellColor & CellColor.valueMask;

    switch (colorType) {
      case CellColor.normal:
        return _theme.background;
      case CellColor.named:
      case CellColor.palette:
        return _colorPalette[colorValue];
      case CellColor.rgb:
      default:
        return Color(colorValue | 0xFF000000);
    }
  }
}
