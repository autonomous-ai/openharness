import 'dart:ui';
import 'package:flutter/painting.dart';
import 'package:quiver/collection.dart';

import 'package:xterm/src/ui/block_glyphs.dart';
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

  /// Recorded lines, reused while they are unchanged. Cleared with
  /// [_paragraphCache] and whenever anything else that shapes a drawing
  /// changes.
  final _lineCache = LinePictureCache();

  TerminalStyle get textStyle => _textStyle;
  TerminalStyle _textStyle;
  set textStyle(TerminalStyle value) {
    if (value == _textStyle) return;
    _textStyle = value;
    _cellSize = _measureCharSize();
    _paragraphCache.clear();
    _lineCache.clear();
    _runParagraphs.clear();
    _runAligned.clear();
  }

  TextScaler get textScaler => _textScaler;
  TextScaler _textScaler = TextScaler.linear(1.0);
  set textScaler(TextScaler value) {
    if (value == _textScaler) return;
    _textScaler = value;
    _cellSize = _measureCharSize();
    _paragraphCache.clear();
    _lineCache.clear();
    _runParagraphs.clear();
    _runAligned.clear();
  }

  TerminalTheme get theme => _theme;
  TerminalTheme _theme;
  set theme(TerminalTheme value) {
    if (value == _theme) return;
    _theme = value;
    _colorPalette = PaletteBuilder(value).build();
    _paragraphCache.clear();
    _lineCache.clear();
    _runParagraphs.clear();
    _runAligned.clear();
  }

  /// Device pixels per logical pixel, used to snap block-glyph edges so that
  /// neighbouring cells share a pixel boundary. Impeller ignores
  /// `Paint.isAntiAlias = false` (flutter/flutter#104721) and resolves every
  /// edge through MSAA, so without snapping two abutting rectangles can leave a
  /// hairline where one would not.
  double get devicePixelRatio => _devicePixelRatio;
  double _devicePixelRatio = 1.0;
  set devicePixelRatio(double value) {
    if (value == _devicePixelRatio) return;
    _devicePixelRatio = value;
    _lineCache.clear();
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
    _lineCache.clear();
    _runParagraphs.clear();
    _runAligned.clear();
  }

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

  /// Starts a frame of [paintLineCached] calls.
  void beginFrame() => _lineCache.beginFrame();

  /// Ends a frame of [paintLineCached] calls, releasing the drawings of lines
  /// it did not paint.
  void endFrame() => _lineCache.endFrame();

  /// Releases every recorded line, for a renderer that stops drawing.
  void clearLineCache() => _lineCache.clear();

  /// The number of lines with a recorded drawing held.
  int get cachedLineCount => _lineCache.length;

  /// Paints [line] like [paintLine], replaying its recorded drawing when the
  /// line has not changed since it was recorded.
  ///
  /// Block glyphs snap their edges to device pixels where they are drawn, so a
  /// drawing is only valid at the fraction of a device pixel it was recorded
  /// at. The line is recorded at [offset]'s sub-pixel part (its phase) and
  /// replayed moved by the rest, a whole number of device pixels; a line that
  /// lands on another phase — only possible at a fractional pixel ratio — is
  /// recorded again.
  void paintLineCached(Canvas canvas, Offset offset, BufferLine line) {
    final phase = _devicePixelPhase(offset);
    var picture = _lineCache.lookup(line, phase);
    if (picture == null) {
      final recorder = PictureRecorder();
      paintLine(Canvas(recorder), phase, line);
      picture = recorder.endRecording();
      _lineCache.store(line, picture, phase);
    }
    canvas.save();
    canvas.translate(offset.dx - phase.dx, offset.dy - phase.dy);
    canvas.drawPicture(picture);
    canvas.restore();
  }

  /// The part of [offset] that is not a whole number of device pixels.
  Offset _devicePixelPhase(Offset offset) {
    double part(double logical) {
      final device = logical * _devicePixelRatio;
      return (device - device.floorToDouble()) / _devicePixelRatio;
    }

    return Offset(part(offset.dx), part(offset.dy));
  }

  /// Paints [line] to [canvas] at [offset]. The x offset of [offset] is usually
  /// 0, and the y offset is the top of the line.
  ///
  /// Backgrounds first, then glyphs. Neighbouring cells that share a background
  /// colour are filled with one rectangle rather than one per cell — the same
  /// area [paintCellBackground] covers, including its one-pixel overlap to the
  /// right, in a fraction of the draw calls.
  void paintLine(
    Canvas canvas,
    Offset offset,
    BufferLine line,
  ) {
    final cellData = _lineCellData;
    final cellWidth = _cellSize.width;
    final length = line.length;

    Color? runColor;
    var runStart = 0;
    var runEnd = 0;
    void fillRun() {
      if (runColor == null) return;
      _backgroundPaint.color = runColor!;
      canvas.drawRect(
        Rect.fromLTRB(
          offset.dx + runStart * cellWidth,
          offset.dy,
          offset.dx + runEnd * cellWidth + 1,
          offset.dy + _cellSize.height,
        ),
        _backgroundPaint,
      );
      runColor = null;
    }

    for (var i = 0; i < length; i++) {
      line.getCellData(i, cellData);
      final span = cellData.content >> CellContent.widthShift == 2 ? 2 : 1;
      final color = cellBackgroundColor(cellData);
      if (color != runColor || i != runEnd) {
        fillRun();
        if (color != null) {
          runColor = color;
          runStart = i;
        }
      }
      runEnd = i + span;
      if (span == 2) i++;
    }
    fillRun();

    var i = 0;
    while (i < length) {
      line.getCellData(i, cellData);
      final end = _asciiRunEnd(line, i, cellData);
      if (end - i >= 2) {
        _paintAsciiRun(canvas, offset.translate(i * cellWidth, 0), line, i, end,
            cellData);
        i = end;
        continue;
      }
      paintCellForeground(canvas, offset.translate(i * cellWidth, 0), cellData);
      i += cellData.content >> CellContent.widthShift == 2 ? 2 : 1;
    }
  }

  /// How many ASCII runs have been painted as one paragraph — a count for
  /// tests to see where runs were cut. Debug builds only.
  int debugAsciiRunsPainted = 0;

  /// Laid-out runs of plain ASCII, keyed by their colours, flags and text.
  final _runParagraphs = LruMap<String, Paragraph>(maximumSize: 2048);

  /// Whether each weight/slant (bold | italic << 1) sets every printable ASCII
  /// character exactly one cell wide, so a run of them lands on the grid.
  final _runAligned = <int, bool>{};

  static bool _isAsciiRunCode(int content) {
    final code = content & CellContent.codepointMask;
    return code >= 0x20 &&
        code <= 0x7E &&
        content >> CellContent.widthShift == 1;
  }

  /// Where a run of plain ASCII that starts at [start] ends: the first cell that
  /// is not printable ASCII, or is styled differently. [start] itself (in
  /// [cellData]) not qualifying ends the run at once.
  int _asciiRunEnd(BufferLine line, int start, CellData cellData) {
    if (!_isAsciiRunCode(cellData.content)) return start;
    final flags = cellData.flags;
    if (!_runAlignedFor(flags)) return start;
    final foreground = cellData.foreground;
    final background = cellData.background;
    var end = start + 1;
    while (end < line.length &&
        _isAsciiRunCode(line.getContent(end)) &&
        line.getForeground(end) == foreground &&
        line.getBackground(end) == background &&
        line.getAttributes(end) == flags) {
      end++;
    }
    return end;
  }

  bool _runAlignedFor(int flags) {
    final bold = flags & CellFlags.bold != 0;
    final italic = flags & CellFlags.italic != 0;
    return _runAligned[(bold ? 1 : 0) | (italic ? 2 : 0)] ??=
        _measureRunAligned(bold, italic);
  }

  bool _measureRunAligned(bool bold, bool italic) {
    final text = String.fromCharCodes([for (var c = 0x20; c <= 0x7E; c++) c]);
    final style = _runTextStyle(null, bold: bold, italic: italic);
    final builder = ParagraphBuilder(style.getParagraphStyle())
      ..pushStyle(style.getTextStyle(textScaler: _textScaler))
      ..addText(text);
    final paragraph = builder.build()
      ..layout(const ParagraphConstraints(width: double.infinity));
    final advance = paragraph.maxIntrinsicWidth / text.length;
    paragraph.dispose();
    return (advance - _cellSize.width).abs() < 0.001;
  }

  /// The style of a glyph run: what [paintCellForeground] gives one cell, with
  /// ligatures, contextual alternates and kerning off — one cell at a time never
  /// had any of them, and each would move glyphs off the grid.
  TextStyle _runTextStyle(
    Color? color, {
    required bool bold,
    required bool italic,
    bool underline = false,
  }) {
    return _textStyle
        .toTextStyle(
          color: color,
          bold: bold,
          italic: italic,
          underline: underline,
        )
        .copyWith(fontFeatures: const [
          FontFeature.disable('liga'),
          FontFeature.disable('calt'),
          FontFeature.disable('kern'),
        ]);
  }

  /// Paints cells [start]..[end) of [line] — plain ASCII sharing one style, as
  /// found by [_asciiRunEnd] — as one paragraph instead of one per cell.
  void _paintAsciiRun(
    Canvas canvas,
    Offset offset,
    BufferLine line,
    int start,
    int end,
    CellData cellData,
  ) {
    final flags = cellData.flags;
    final underline = flags & CellFlags.underline != 0;
    final codes = <int>[];
    var visible = underline;
    for (var i = start; i < end; i++) {
      final code = line.getCodePoint(i);
      if (code != 0x20) visible = true;
      // The same workaround as [paintCellForeground]: Flutter underlines no
      // trailing space, but does a non-breaking one.
      codes.add(underline && code == 0x20 ? 0xA0 : code);
    }
    // Spaces with nothing under them draw nothing, one cell at a time or not.
    if (!visible) return;
    assert(() {
      debugAsciiRunsPainted++;
      return true;
    }());

    final text = String.fromCharCodes(codes);
    final key = '${cellData.foreground}|${cellData.background}|$flags|'
        '${_textScaler.hashCode}|$text';
    var paragraph = _runParagraphs[key];
    if (paragraph == null) {
      var color = flags & CellFlags.inverse == 0
          ? resolveForegroundColor(cellData.foreground)
          : resolveBackgroundColor(cellData.background);
      if (flags & CellFlags.faint != 0) color = color.withOpacity(0.5);
      final style = _runTextStyle(
        color,
        bold: flags & CellFlags.bold != 0,
        italic: flags & CellFlags.italic != 0,
        underline: underline,
      );
      final builder = ParagraphBuilder(style.getParagraphStyle())
        ..pushStyle(style.getTextStyle(textScaler: _textScaler))
        ..addText(text);
      paragraph = builder.build()
        ..layout(const ParagraphConstraints(width: double.infinity));
      _runParagraphs[key] = paragraph;
    }
    canvas.drawParagraph(paragraph, offset);
  }

  final _lineCellData = CellData.empty();
  final _backgroundPaint = Paint();

  /// The colour [paintCellBackground] fills [cellData] with, or null when it
  /// leaves the cell to the terminal's own background.
  @pragma('vm:prefer-inline')
  Color? cellBackgroundColor(CellData cellData) {
    if (cellData.flags & CellFlags.inverse != 0) {
      return resolveForegroundColor(cellData.foreground);
    }
    if (cellData.background & CellColor.typeMask == CellColor.normal) {
      return null;
    }
    return resolveBackgroundColor(cellData.background);
  }

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

    final block = BlockGlyph.lookup(charCode);
    if (block != null) {
      paintBlockGlyph(canvas, offset, cellData, block);
      return;
    }

    final cacheKey = cellData.getHash() ^ _textScaler.hashCode;
    var paragraph = _paragraphCache.getLayoutFromCache(cacheKey);

    if (paragraph == null) {
      final cellFlags = cellData.flags;

      var color = cellFlags & CellFlags.inverse == 0
          ? resolveForegroundColor(cellData.foreground)
          : resolveBackgroundColor(cellData.background);

      if (cellData.flags & CellFlags.faint != 0) {
        color = color.withOpacity(0.5);
      }

      final style = _textStyle.toTextStyle(
        color: color,
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

  /// Paints a Block Elements character (U+2580–U+259F) as filled rectangles
  /// covering the whole cell instead of the font's glyph. See [BlockGlyph] for
  /// why; the colour rules match the text path above.
  void paintBlockGlyph(
    Canvas canvas,
    Offset offset,
    CellData cellData,
    BlockGlyph block,
  ) {
    final cellFlags = cellData.flags;

    var color = cellFlags & CellFlags.inverse == 0
        ? resolveForegroundColor(cellData.foreground)
        : resolveBackgroundColor(cellData.background);

    var opacity = block.opacity;
    if (cellFlags & CellFlags.faint != 0) opacity *= 0.5;
    if (opacity != 1.0) color = color.withValues(alpha: opacity);

    // Blocks are meant to tile, so every edge lands on a device pixel and
    // anti-aliasing is off (Skia honours that; Impeller relies on the
    // snapping alone). A strip thinner than one device pixel — an eighth of a
    // narrow cell — is widened to one so it never rasterises to nothing.
    final paint = Paint()
      ..color = color
      ..isAntiAlias = false;

    final widthScale = cellData.content >> CellContent.widthShift == 2 ? 2 : 1;
    final width = _cellSize.width * widthScale;
    final height = _cellSize.height;

    for (final unit in block.rects) {
      canvas.drawRect(
        snapRectToDevicePixels(
          Rect.fromLTRB(
            offset.dx + unit.left * width,
            offset.dy + unit.top * height,
            offset.dx + unit.right * width,
            offset.dy + unit.bottom * height,
          ),
          _devicePixelRatio,
        ),
        paint,
      );
    }
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
