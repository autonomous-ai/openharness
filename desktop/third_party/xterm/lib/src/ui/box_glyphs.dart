import 'dart:math' as math;
import 'dart:ui';

/// Geometry for the Unicode Box Drawing code points (U+2500–U+257F) a terminal
/// draws itself instead of taking from the font.
///
/// A font's line glyphs cover its own ascent and descent, not the cell: a row
/// is taller than that, so a column of `┃` or `│` — the side of a panel in
/// OpenCode, a box in Claude Code — showed a gap at every row. Terminals draw
/// these from cell edge to cell edge (xterm.js `customGlyphs`, Windows
/// Terminal, Alacritty, Kitty, Ghostty), as [BlockGlyph] already does for the
/// block elements. Strokes are whole device pixels thick and placed on device
/// pixels, so neighbours join exactly.
///
/// Covered: light and heavy lines, corners, tees and crosses; dashed lines;
/// rounded corners; diagonals; half lines. The double lines (U+2550–U+256C)
/// stay with the font, whose joins between double strokes are drawn for them.
class BoxGlyph {
  const BoxGlyph._(this._kind, this._arms, [this._count = 0]);

  final _BoxKind _kind;

  /// Weight of each arm, up, right, down, left: 0 none, 1 light, 2 heavy. For
  /// a dash the arm along its axis gives the weight; for an arc, its two ends.
  final String _arms;

  /// How many dashes a dashed line has in one cell.
  final int _count;

  /// The glyph for [codePoint], or null when the font draws it.
  static BoxGlyph? lookup(int codePoint) {
    if (codePoint < 0x2500 || codePoint > 0x257F) return null;
    return _table[codePoint - 0x2500];
  }

  /// The filled rectangles of a line, corner, tee, cross or dash in [cell] at
  /// [devicePixelRatio], every edge on a device pixel; empty for an arc or a
  /// diagonal, which [stroke] draws.
  List<Rect> rects(Rect cell, double devicePixelRatio) {
    final grid = _Grid(cell, devicePixelRatio);
    switch (_kind) {
      case _BoxKind.lines:
        return grid.arms(_weights(_arms));
      case _BoxKind.dashes:
        return grid.dashes(_weights(_arms), _count);
      case _BoxKind.arc:
      case _BoxKind.diagonal:
        return const [];
    }
  }

  /// The stroked path of an arc or a diagonal in [cell], and its width in
  /// logical pixels; null for a glyph [rects] fills.
  (Path, double)? stroke(Rect cell, double devicePixelRatio) {
    final grid = _Grid(cell, devicePixelRatio);
    final width = grid.thickness(1);
    switch (_kind) {
      case _BoxKind.arc:
        return (grid.arc(_weights(_arms)), width / grid.ratio);
      case _BoxKind.diagonal:
        return (grid.diagonal(_arms), width / grid.ratio);
      case _BoxKind.lines:
      case _BoxKind.dashes:
        return null;
    }
  }

  static List<int> _weights(String arms) =>
      [for (final unit in arms.codeUnits) unit - 0x30];
}

enum _BoxKind { lines, dashes, arc, diagonal }

/// One cell in device pixels: whole-pixel stroke widths, positions and edges.
class _Grid {
  _Grid(this.cell, double devicePixelRatio)
      : ratio = devicePixelRatio > 0 ? devicePixelRatio : 1.0;

  final Rect cell;
  final double ratio;

  double get left => (cell.left * ratio).roundToDouble();
  double get right => (cell.right * ratio).roundToDouble();
  double get top => (cell.top * ratio).roundToDouble();
  double get bottom => (cell.bottom * ratio).roundToDouble();

  /// Stroke width in device pixels: one logical pixel light, two heavy, never
  /// less than one and two device pixels.
  double thickness(int weight) => weight >= 2
      ? math.max(2, (2 * ratio).roundToDouble())
      : math.max(1, ratio.roundToDouble());

  /// The left edge of a vertical stroke [width] device pixels wide, centred.
  double strokeLeft(double width) =>
      (cell.center.dx * ratio - width / 2).roundToDouble();

  /// The top edge of a horizontal stroke [width] device pixels tall, centred.
  double strokeTop(double width) =>
      (cell.center.dy * ratio - width / 2).roundToDouble();

  Rect logical(double l, double t, double r, double b) =>
      Rect.fromLTRB(l / ratio, t / ratio, r / ratio, b / ratio);

  /// Each arm runs from its cell edge into the joint far enough to cover the
  /// strokes crossing it, so a corner is square and a tee has no notch.
  List<Rect> arms(List<int> w) {
    final [up, rightArm, down, leftArm] = w;
    final across = math.max(rightArm, leftArm);
    final along = math.max(up, down);
    final rects = <Rect>[];
    if (up > 0 || down > 0) {
      final crossing = thickness(across > 0 ? across : along);
      final crossTop = strokeTop(crossing);
      if (up > 0) {
        final x = strokeLeft(thickness(up));
        rects.add(logical(x, top, x + thickness(up), crossTop + crossing));
      }
      if (down > 0) {
        final x = strokeLeft(thickness(down));
        rects.add(logical(x, crossTop, x + thickness(down), bottom));
      }
    }
    if (rightArm > 0 || leftArm > 0) {
      final crossing = thickness(along > 0 ? along : across);
      final crossLeft = strokeLeft(crossing);
      if (leftArm > 0) {
        final y = strokeTop(thickness(leftArm));
        rects.add(
          logical(left, y, crossLeft + crossing, y + thickness(leftArm)),
        );
      }
      if (rightArm > 0) {
        final y = strokeTop(thickness(rightArm));
        rects.add(logical(crossLeft, y, right, y + thickness(rightArm)));
      }
    }
    return rects;
  }

  /// [count] dashes along the arm [w] names, each centred in an equal part of
  /// the cell so the pattern continues into the next cell.
  List<Rect> dashes(List<int> w, int count) {
    final vertical = w[0] > 0;
    final width = thickness(vertical ? w[0] : w[1]);
    final start = vertical ? top : left;
    final length = (vertical ? bottom : right) - start;
    final rects = <Rect>[];
    for (var i = 0; i < count; i++) {
      final a = (start + length * (i + 0.25) / count).roundToDouble();
      final b = math.max(
        a + 1,
        (start + length * (i + 0.75) / count).roundToDouble(),
      );
      if (vertical) {
        final x = strokeLeft(width);
        rects.add(logical(x, a, x + width, b));
      } else {
        final y = strokeTop(width);
        rects.add(logical(a, y, b, y + width));
      }
    }
    return rects;
  }

  /// A quarter circle joining the two arms [w] names, with straight runs to
  /// the cell edges on the same centre lines as `│` and `─`.
  Path arc(List<int> w) {
    final width = thickness(1);
    final cx = (strokeLeft(width) + width / 2) / ratio;
    final cy = (strokeTop(width) + width / 2) / ratio;
    final up = w[0] > 0, rightArm = w[1] > 0;
    final edgeY = (up ? top : bottom) / ratio;
    final edgeX = (rightArm ? right : left) / ratio;
    final radius = math.min((edgeX - cx).abs(), (edgeY - cy).abs());
    final towardsX = rightArm ? 1.0 : -1.0;
    final towardsY = up ? -1.0 : 1.0;
    return Path()
      ..moveTo(cx, edgeY)
      ..lineTo(cx, cy + towardsY * radius)
      ..arcToPoint(
        Offset(cx + towardsX * radius, cy),
        radius: Radius.circular(radius),
        // Bending towards the cell's middle: ╭ and ╯ turn clockwise.
        clockwise: (towardsX > 0) == (towardsY > 0),
      )
      ..lineTo(edgeX, cy);
  }

  /// `╱`, `╲` or both, corner to corner.
  Path diagonal(String which) {
    final l = left / ratio, r = right / ratio;
    final t = top / ratio, b = bottom / ratio;
    final path = Path();
    if (which != '\\') {
      path
        ..moveTo(l, b)
        ..lineTo(r, t);
    }
    if (which != '/') {
      path
        ..moveTo(l, t)
        ..lineTo(r, b);
    }
    return path;
  }
}

const _l = _BoxKind.lines;
const _d = _BoxKind.dashes;

/// U+2500 to U+257F in order; null for the double lines the font draws.
const _table = <BoxGlyph?>[
  BoxGlyph._(_l, '0101'), // ─
  BoxGlyph._(_l, '0202'), // ━
  BoxGlyph._(_l, '1010'), // │
  BoxGlyph._(_l, '2020'), // ┃
  BoxGlyph._(_d, '0101', 3), // ┄
  BoxGlyph._(_d, '0202', 3), // ┅
  BoxGlyph._(_d, '1010', 3), // ┆
  BoxGlyph._(_d, '2020', 3), // ┇
  BoxGlyph._(_d, '0101', 4), // ┈
  BoxGlyph._(_d, '0202', 4), // ┉
  BoxGlyph._(_d, '1010', 4), // ┊
  BoxGlyph._(_d, '2020', 4), // ┋
  BoxGlyph._(_l, '0110'), // ┌
  BoxGlyph._(_l, '0210'), // ┍
  BoxGlyph._(_l, '0120'), // ┎
  BoxGlyph._(_l, '0220'), // ┏
  BoxGlyph._(_l, '0011'), // ┐
  BoxGlyph._(_l, '0012'), // ┑
  BoxGlyph._(_l, '0021'), // ┒
  BoxGlyph._(_l, '0022'), // ┓
  BoxGlyph._(_l, '1100'), // └
  BoxGlyph._(_l, '1200'), // ┕
  BoxGlyph._(_l, '2100'), // ┖
  BoxGlyph._(_l, '2200'), // ┗
  BoxGlyph._(_l, '1001'), // ┘
  BoxGlyph._(_l, '1002'), // ┙
  BoxGlyph._(_l, '2001'), // ┚
  BoxGlyph._(_l, '2002'), // ┛
  BoxGlyph._(_l, '1110'), // ├
  BoxGlyph._(_l, '1210'), // ┝
  BoxGlyph._(_l, '2110'), // ┞
  BoxGlyph._(_l, '1120'), // ┟
  BoxGlyph._(_l, '2120'), // ┠
  BoxGlyph._(_l, '2210'), // ┡
  BoxGlyph._(_l, '1220'), // ┢
  BoxGlyph._(_l, '2220'), // ┣
  BoxGlyph._(_l, '1011'), // ┤
  BoxGlyph._(_l, '1012'), // ┥
  BoxGlyph._(_l, '2011'), // ┦
  BoxGlyph._(_l, '1021'), // ┧
  BoxGlyph._(_l, '2021'), // ┨
  BoxGlyph._(_l, '2012'), // ┩
  BoxGlyph._(_l, '1022'), // ┪
  BoxGlyph._(_l, '2022'), // ┫
  BoxGlyph._(_l, '0111'), // ┬
  BoxGlyph._(_l, '0112'), // ┭
  BoxGlyph._(_l, '0211'), // ┮
  BoxGlyph._(_l, '0212'), // ┯
  BoxGlyph._(_l, '0121'), // ┰
  BoxGlyph._(_l, '0122'), // ┱
  BoxGlyph._(_l, '0221'), // ┲
  BoxGlyph._(_l, '0222'), // ┳
  BoxGlyph._(_l, '1101'), // ┴
  BoxGlyph._(_l, '1102'), // ┵
  BoxGlyph._(_l, '1201'), // ┶
  BoxGlyph._(_l, '1202'), // ┷
  BoxGlyph._(_l, '2101'), // ┸
  BoxGlyph._(_l, '2102'), // ┹
  BoxGlyph._(_l, '2201'), // ┺
  BoxGlyph._(_l, '2202'), // ┻
  BoxGlyph._(_l, '1111'), // ┼
  BoxGlyph._(_l, '1112'), // ┽
  BoxGlyph._(_l, '1211'), // ┾
  BoxGlyph._(_l, '1212'), // ┿
  BoxGlyph._(_l, '2111'), // ╀
  BoxGlyph._(_l, '1121'), // ╁
  BoxGlyph._(_l, '2121'), // ╂
  BoxGlyph._(_l, '2112'), // ╃
  BoxGlyph._(_l, '2211'), // ╄
  BoxGlyph._(_l, '1122'), // ╅
  BoxGlyph._(_l, '1221'), // ╆
  BoxGlyph._(_l, '2212'), // ╇
  BoxGlyph._(_l, '1222'), // ╈
  BoxGlyph._(_l, '2122'), // ╉
  BoxGlyph._(_l, '2221'), // ╊
  BoxGlyph._(_l, '2222'), // ╋
  BoxGlyph._(_d, '0101', 2), // ╌
  BoxGlyph._(_d, '0202', 2), // ╍
  BoxGlyph._(_d, '1010', 2), // ╎
  BoxGlyph._(_d, '2020', 2), // ╏
  // U+2550–U+256C, the double lines: the font's.
  null, null, null, null, null, null, null, null, null, null, null, null, //
  null, null, null, null, null, null, null, null, null, null, null, null, //
  null, null, null, null, null, //
  BoxGlyph._(_BoxKind.arc, '0110'), // ╭
  BoxGlyph._(_BoxKind.arc, '0011'), // ╮
  BoxGlyph._(_BoxKind.arc, '1001'), // ╯
  BoxGlyph._(_BoxKind.arc, '1100'), // ╰
  BoxGlyph._(_BoxKind.diagonal, '/'), // ╱
  BoxGlyph._(_BoxKind.diagonal, '\\'), // ╲
  BoxGlyph._(_BoxKind.diagonal, 'X'), // ╳
  BoxGlyph._(_l, '0001'), // ╴
  BoxGlyph._(_l, '1000'), // ╵
  BoxGlyph._(_l, '0100'), // ╶
  BoxGlyph._(_l, '0010'), // ╷
  BoxGlyph._(_l, '0002'), // ╸
  BoxGlyph._(_l, '2000'), // ╹
  BoxGlyph._(_l, '0200'), // ╺
  BoxGlyph._(_l, '0020'), // ╻
  BoxGlyph._(_l, '0201'), // ╼
  BoxGlyph._(_l, '1020'), // ╽
  BoxGlyph._(_l, '0102'), // ╾
  BoxGlyph._(_l, '2010'), // ╿
];
