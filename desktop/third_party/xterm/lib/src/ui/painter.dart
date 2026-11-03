import 'dart:math' as math;
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

/// A private-use code point the bundled Symbols Nerd Font Mono 3.5.1 has an
/// icon for. Unicode assigns them no width; the grid counts each as one cell.
///
/// Only these are drawn with the icon face. Any other private-use character,
/// such as SF Mono's Apple logo at U+F8FF, stays on the text face at its size.
bool isBundledSymbol(int codePoint) {
  if (codePoint < 0xE000) return false;
  for (final (first, last) in _bundledSymbolRanges) {
    if (codePoint < first) return false;
    if (codePoint <= last) return true;
  }
  return false;
}

/// The private-use ranges of the bundled Symbols Nerd Font Mono 3.5.1, read
/// from its character map, in order.
const _bundledSymbolRanges = <(int, int)>[
  (0xE000, 0xE00A), // Pomicons
  (0xE0A0, 0xE0A3), // Powerline symbols
  (0xE0B0, 0xE0C8), // Powerline and Powerline Extra separators
  (0xE0CA, 0xE0CA),
  (0xE0CC, 0xE0D2),
  (0xE0D4, 0xE0D4),
  (0xE0D6, 0xE0D7),
  (0xE200, 0xE2A9), // Font Awesome Extension
  (0xE300, 0xE3E3), // Weather Icons
  (0xE5FA, 0xE6BB), // Seti UI and custom
  (0xE700, 0xE958), // Devicons
  (0xEA60, 0xEA88), // Codicons
  (0xEA8A, 0xEA8C),
  (0xEA8F, 0xEAC7),
  (0xEAC9, 0xEAC9),
  (0xEACC, 0xEB09),
  (0xEB0B, 0xEB4E),
  (0xEB50, 0xEC5E),
  (0xEC60, 0xEC84),
  (0xED00, 0xEFCF), // Font Awesome
  (0xF000, 0xF385), // Font Awesome and Font Logos
  (0xF400, 0xF533), // Octicons
  (0xF0001, 0xF1AF0), // Material Design Icons
];

/// Font size at which an icon whose advance is [symbolAdvance] (measured at
/// [fontSize]) occupies [cellWidth]. Symbols Nerd Font Mono draws each icon
/// one em wide, which is wider than the text face's cell.
double symbolFontSizeForCell({
  required double fontSize,
  required double cellWidth,
  required double symbolAdvance,
}) {
  if (symbolAdvance <= 0 || cellWidth <= 0) return fontSize;
  return fontSize * cellWidth / symbolAdvance;
}

/// Where a Powerline separator's ink starts and ends across its glyph, as
/// fractions of an em from the glyph's origin; null for any other code point
/// and for the filled separators [powerlineSeparatorPath] draws.
///
/// A separator joins the coloured cells on either side of it, so it is
/// stretched to fill its cell edge to edge and top to bottom. Scaled like an
/// icon, it covered about 60% of the row and stopped short of its neighbours.
/// Each glyph sits in its em differently (U+E0B1 at the left, U+E0B3 at the
/// right, U+E0B9 across it), so the painter needs its ink, not its advance.
/// Ink outside 0–1 is the face's bleed past a flat side, which overlaps the
/// neighbouring segment.
(double, double)? powerlineSeparatorInk(int codePoint) {
  final ink = _powerlineSeparatorInk[codePoint];
  if (ink == null) return null;
  return (ink.$1 / _symbolUnitsPerEm, ink.$2 / _symbolUnitsPerEm);
}

/// The outline of a filled Powerline separator in [cell], or null for any
/// other code point.
///
/// The face puts these glyphs' corners just outside its em, so fitted to the
/// cell a triangle's flat side began about half a pixel below the cell's top,
/// and whether that corner pixel showed at all depended on the platform's
/// rasteriser. Drawn as shapes, their corners are the cell's. The flat side
/// reaches [bleed] past the cell into the segment it joins, in the same
/// outline, so no seam shows where their edges meet inside a pixel. The round
/// or pointed side stops at the cell's edge.
Path? powerlineSeparatorPath(int codePoint, Rect cell, double bleed) {
  final left = cell.left;
  final top = cell.top;
  final right = cell.right;
  final bottom = cell.bottom;
  switch (codePoint) {
    case 0xE0B0: // left hard divider
      return Path()
        ..moveTo(left - bleed, top)
        ..lineTo(left, top)
        ..lineTo(right, cell.center.dy)
        ..lineTo(left, bottom)
        ..lineTo(left - bleed, bottom)
        ..close();
    case 0xE0B2: // right hard divider
      return Path()
        ..moveTo(right + bleed, top)
        ..lineTo(right, top)
        ..lineTo(left, cell.center.dy)
        ..lineTo(right, bottom)
        ..lineTo(right + bleed, bottom)
        ..close();
    case 0xE0B4: // right half circle thick
      return Path()
        ..moveTo(left - bleed, top)
        ..lineTo(left, top)
        ..arcTo(Rect.fromLTRB(left - cell.width, top, right, bottom),
            -math.pi / 2, math.pi, false)
        ..lineTo(left - bleed, bottom)
        ..close();
    case 0xE0B6: // left half circle thick
      return Path()
        ..moveTo(right + bleed, top)
        ..lineTo(right, top)
        ..arcTo(Rect.fromLTRB(left, top, right + cell.width, bottom),
            -math.pi / 2, -math.pi, false)
        ..lineTo(right + bleed, bottom)
        ..close();
    case 0xE0B8: // lower left triangle
      return Path()
        ..moveTo(left - bleed, top)
        ..lineTo(left, top)
        ..lineTo(right, bottom)
        ..lineTo(left - bleed, bottom)
        ..close();
    case 0xE0BA: // lower right triangle
      return Path()
        ..moveTo(right + bleed, top)
        ..lineTo(right, top)
        ..lineTo(left, bottom)
        ..lineTo(right + bleed, bottom)
        ..close();
    case 0xE0BC: // upper left triangle
      return Path()
        ..moveTo(left - bleed, top)
        ..lineTo(right, top)
        ..lineTo(left, bottom)
        ..lineTo(left - bleed, bottom)
        ..close();
    case 0xE0BE: // upper right triangle
      return Path()
        ..moveTo(left, top)
        ..lineTo(right + bleed, top)
        ..lineTo(right + bleed, bottom)
        ..lineTo(right, bottom)
        ..close();
  }
  return null;
}

/// Horizontal ink of the Powerline and Powerline Extra separators, other than
/// the filled ones drawn as paths, in the bundled Symbols Nerd Font Mono
/// 3.5.1, in font units. Its line, ascent plus descent, is exactly one em, so
/// an em tall is the cell's height.
const _symbolUnitsPerEm = 2048;
const _powerlineSeparatorInk = <int, (int, int)>{
  0xE0B1: (0, 1433), // left soft divider
  0xE0B3: (615, 2048), // right soft divider
  0xE0B5: (0, 1023), // right half circle thin
  0xE0B7: (1024, 2048), // left half circle thin
  0xE0B9: (0, 2047), // backslash separator
  0xE0BB: (1, 2048), // forward slash separator
  0xE0BD: (0, 2047), // forward slash separator (redundant)
  0xE0BF: (1, 2048), // backslash separator (redundant)
  0xE0C0: (-101, 2048), // flame thick
  0xE0C1: (0, 2049), // flame thin
  0xE0C2: (0, 2150), // flame thick mirrored
  0xE0C3: (1, 2049), // flame thin mirrored
  0xE0C4: (61, 1769), // pixelated squares small
  0xE0C5: (280, 1987), // pixelated squares small mirrored
  0xE0C6: (61, 1609), // pixelated squares big
  0xE0C7: (439, 1987), // pixelated squares big mirrored
  0xE0C8: (-101, 2048), // ice waveform
  0xE0CA: (1, 2150), // ice waveform mirrored
  0xE0CC: (-40, 1718), // honeycomb
  0xE0CD: (0, 1770), // honeycomb outline
  0xE0CE: (0, 2047), // lego separator
  0xE0CF: (52, 1996), // lego separator thin
  0xE0D0: (0, 1906), // lego block facing
  0xE0D1: (0, 1510), // lego block sideways
  0xE0D2: (-40, 1407), // trapezoid top bottom
  0xE0D4: (642, 2089), // trapezoid top bottom mirrored
  0xE0D6: (-101, 1346), // right hard divider inverse
  0xE0D7: (703, 2150), // left hard divider inverse
};

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
    _fittedSymbolFontSize = null;
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
    _fittedSymbolFontSize = null;
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
    _fittedSymbolFontSize = null;
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

    if (_symbolFace(charCode)) {
      final outline = powerlineSeparatorPath(
        charCode,
        offset & _cellSize,
        _separatorBleed,
      );
      if (outline != null) {
        _paintSeparatorOutline(canvas, offset, cellData, outline);
        return;
      }
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

      var style = _textStyle.toTextStyle(
        color: color,
        bold: cellFlags & CellFlags.bold != 0,
        italic: cellFlags & CellFlags.italic != 0,
        underline: cellFlags & CellFlags.underline != 0,
      );
      if (_symbolFace(charCode)) {
        // Read first for every icon: it drops paragraphs laid out before the
        // face resolved.
        final iconFontSize = _symbolFontSize;
        final separator = powerlineSeparatorInk(charCode) != null;
        style = style.copyWith(
          fontFamily: _textStyle.symbolFontFamily,
          // A separator is laid out one em tall, the em the cell's height,
          // and stretched across the cell when painted.
          fontSize: separator ? _separatorFontSize : iconFontSize,
          height: separator ? 1.0 : null,
          // Drawn at the text's place by [_paintIconUnderline]: the icon's own
          // would follow its fitted size.
          decoration: TextDecoration.none,
          // A missing icon stays on the text face rather than a blank.
          fontFamilyFallback: [
            _textStyle.fontFamily,
            ..._textStyle.fontFamilyFallback,
          ],
        );
      }

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

    if (_symbolFace(charCode)) {
      final span = cellData.content >> CellContent.widthShift == 2 ? 2 : 1;
      final cell = Rect.fromLTWH(
        offset.dx,
        offset.dy,
        _cellSize.width * span,
        _cellSize.height,
      );
      canvas.save();
      final ink = powerlineSeparatorInk(charCode);
      if (ink != null) {
        // The em down the cell and the ink inside the em across it. Ink past
        // the em is the face's bleed on a separator's flat side: it reaches
        // into the segment it joins, so no seam shows where their edges meet
        // inside a pixel. The round or pointed side stops at the cell's edge.
        canvas.clipRect(
          Rect.fromLTRB(
            cell.left - (ink.$1 < 0 ? _separatorBleed : 0),
            cell.top,
            cell.right + (ink.$2 > 1 ? _separatorBleed : 0),
            cell.bottom,
          ),
        );
        final left = ink.$1.clamp(0.0, 1.0);
        final right = ink.$2.clamp(0.0, 1.0);
        final em = paragraph.height;
        canvas.translate(cell.left, cell.top);
        canvas.scale(cell.width / ((right - left) * em), cell.height / em);
        canvas.drawParagraph(paragraph, Offset(-left * em, 0));
      } else {
        canvas.clipRect(cell);
        final dx = (cell.width - paragraph.maxIntrinsicWidth) / 2;
        final dy = (cell.height - paragraph.height) / 2;
        canvas.drawParagraph(paragraph, offset.translate(dx, dy));
      }
      canvas.restore();
      if (cellData.flags & CellFlags.underline != 0) {
        _paintIconUnderline(canvas, offset, cellData, span);
      }
      return;
    }
    canvas.drawParagraph(paragraph, offset);
  }

  /// Fills a filled Powerline separator's [outline] (see
  /// [powerlineSeparatorPath]) in the colour its text would have.
  void _paintSeparatorOutline(
    Canvas canvas,
    Offset offset,
    CellData cellData,
    Path outline,
  ) {
    final cellFlags = cellData.flags;
    var color = cellFlags & CellFlags.inverse == 0
        ? resolveForegroundColor(cellData.foreground)
        : resolveBackgroundColor(cellData.background);
    if (cellFlags & CellFlags.faint != 0) {
      color = color.withValues(alpha: 0.5);
    }
    canvas.drawPath(outline, Paint()..color = color);
    if (cellData.flags & CellFlags.underline != 0) {
      _paintIconUnderline(canvas, offset, cellData, 1);
    }
  }

  final _underlineCellData = CellData.empty();

  /// Underlines an icon's [span] cells as an underlined no-break space in the
  /// text face would be, so the line runs on level with the text beside it.
  void _paintIconUnderline(
    Canvas canvas,
    Offset offset,
    CellData cellData,
    int span,
  ) {
    _underlineCellData
      ..foreground = cellData.foreground
      ..background = cellData.background
      ..flags = cellData.flags
      ..content = 0xA0 | (1 << CellContent.widthShift);
    for (var i = 0; i < span; i++) {
      paintCellForeground(
        canvas,
        offset.translate(i * _cellSize.width, 0),
        _underlineCellData,
      );
    }
  }

  /// The most of a separator's bleed drawn past its cell: the pixel a
  /// background reaches into the next one.
  static const _separatorBleed = 1.0;

  /// The font size whose em, scaled, is the cell's height.
  double get _separatorFontSize =>
      _textStyle.fontSize *
      _cellSize.height /
      _textScaler.scale(_textStyle.fontSize);

  /// The icon face, at a size that fits one cell. Null until the bundled face
  /// has actually resolved: a probe taken before it loads measures the text
  /// face's missing-glyph box, and caching that would leave the icons oversized.
  double? _fittedSymbolFontSize;

  bool _symbolFace(int charCode) =>
      _textStyle.symbolFontFamily != null && isBundledSymbol(charCode);

  double get _symbolFontSize {
    final cached = _fittedSymbolFontSize;
    if (cached != null) return cached;
    final fitted = _measureSymbolFontSize();
    if (_symbolProbeAdvance >= _textScaler.scale(_textStyle.fontSize) * 0.9) {
      _fittedSymbolFontSize = fitted;
      // Paragraphs laid out before the face resolved stay under a key that
      // does not include the font. Drop them, or the oversized glyph is reused.
      _paragraphCache.clear();
      _lineCache.clear();
    }
    return fitted;
  }

  double _symbolProbeAdvance = 0;

  double _measureSymbolFontSize() {
    final family = _textStyle.symbolFontFamily;
    if (family == null) return _textStyle.fontSize;
    final probe = TextStyle(fontFamily: family, fontSize: _textStyle.fontSize);
    _symbolProbeAdvance = _measureAdvance(probe, '\u{f07b}');
    return symbolFontSizeForCell(
      fontSize: _textStyle.fontSize,
      cellWidth: _cellSize.width,
      symbolAdvance: _symbolProbeAdvance,
    );
  }

  double _measureAdvance(TextStyle style, String text) {
    final builder = ParagraphBuilder(style.getParagraphStyle())
      ..pushStyle(style.getTextStyle(textScaler: _textScaler))
      ..addText(text);
    final paragraph = builder.build()
      ..layout(const ParagraphConstraints(width: double.infinity));
    final advance = paragraph.maxIntrinsicWidth / text.length;
    paragraph.dispose();
    return advance;
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
    final color = _cellBackgroundColor(cellData);
    if (color == null) return;
    _fillCell(canvas, offset, cellData, color);
  }

  /// Paints over a cell, glyph and all, with the background it sits on.
  void paintCellCover(Canvas canvas, Offset offset, CellData cellData) {
    _fillCell(
      canvas,
      offset,
      cellData,
      _cellBackgroundColor(cellData) ?? _theme.background,
    );
  }

  /// Null for the default background, which the terminal already shows.
  Color? _cellBackgroundColor(CellData cellData) {
    if (cellData.flags & CellFlags.inverse != 0) {
      return resolveForegroundColor(cellData.foreground);
    }
    if (cellData.background & CellColor.typeMask == CellColor.normal) {
      return null;
    }
    return resolveBackgroundColor(cellData.background);
  }

  void _fillCell(Canvas canvas, Offset offset, CellData cellData, Color color) {
    final doubleWidth = cellData.content >> CellContent.widthShift == 2;
    final widthScale = doubleWidth ? 2 : 1;
    final size = Size(_cellSize.width * widthScale + 1, _cellSize.height);
    canvas.drawRect(offset & size, Paint()..color = color);
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
