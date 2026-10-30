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
/// fractions of an em from the glyph's origin; null for any other code point.
///
/// A separator joins the coloured cells on either side of it, so it is
/// stretched to fill its cell edge to edge and top to bottom. Scaled like an
/// icon, it covered about 60% of the row and stopped short of its neighbours.
/// Each glyph sits in its em differently (U+E0B0 at the left, U+E0B2 at the
/// right, U+E0B8 across it), so the painter needs its ink, not its advance.
(double, double)? powerlineSeparatorInk(int codePoint) {
  final ink = _powerlineSeparatorInk[codePoint];
  if (ink == null) return null;
  return (ink.$1 / _symbolUnitsPerEm, ink.$2 / _symbolUnitsPerEm);
}

/// Horizontal ink of the Powerline and Powerline Extra separators in the
/// bundled Symbols Nerd Font Mono 3.5.1, in font units. Its line, ascent plus
/// descent, is exactly one em, so an em tall is the cell's height.
const _symbolUnitsPerEm = 2048;
const _powerlineSeparatorInk = <int, (int, int)>{
  0xE0B0: (-122, 1325), // left hard divider
  0xE0B1: (0, 1433), // left soft divider
  0xE0B2: (724, 2171), // right hard divider
  0xE0B3: (615, 2048), // right soft divider
  0xE0B4: (-122, 1097), // right half circle thick
  0xE0B5: (0, 1023), // right half circle thin
  0xE0B6: (951, 2171), // left half circle thick
  0xE0B7: (1024, 2048), // left half circle thin
  0xE0B8: (-101, 2048), // lower left triangle
  0xE0B9: (0, 2047), // backslash separator
  0xE0BA: (1, 2150), // lower right triangle
  0xE0BB: (1, 2048), // forward slash separator
  0xE0BC: (-101, 2048), // upper left triangle
  0xE0BD: (0, 2047), // forward slash separator (redundant)
  0xE0BE: (1, 2150), // upper right triangle
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
    _fittedSymbolFontSize = null;
    _paragraphCache.clear();
    clearLinePictures();
  }

  TextScaler get textScaler => _textScaler;
  TextScaler _textScaler = TextScaler.linear(1.0);
  set textScaler(TextScaler value) {
    if (value == _textScaler) return;
    _textScaler = value;
    _cellSize = _measureCharSize();
    _fittedSymbolFontSize = null;
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
    _fittedSymbolFontSize = null;
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

  /// How many lines [paintLineCached] has drawn afresh rather than replayed.
  int get linesRecorded => _linePictures.recorded;

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

      var style = _textStyle.toTextStyle(
        color: _foregroundColorOf(
          cellData.foreground,
          cellData.background,
          cellFlags,
        ),
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
      canvas.clipRect(cell);
      final ink = powerlineSeparatorInk(charCode);
      if (ink != null) {
        // The em down the cell, the ink across it.
        final (left, right) = ink;
        final em = paragraph.height;
        canvas.translate(cell.left, cell.top);
        canvas.scale(cell.width / ((right - left) * em), cell.height / em);
        canvas.drawParagraph(paragraph, Offset(-left * em, 0));
      } else {
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
      clearLinePictures();
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
