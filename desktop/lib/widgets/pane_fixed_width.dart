import 'dart:ui';

/// Gives a full-height tile at the canvas's left or right edge the width its
/// pane asks for ([widths], `TerminalPane.fixedWidth`) and slides every other
/// tile's vertical cuts, in proportion, into the room left. Only one such
/// tile is honoured; the others keep at least [minOther] between them.
/// Null when no tile asks, or none that asks can be given it.
List<Rect>? pinFixedColumn(
  List<Rect> tiles,
  List<double?> widths,
  Size canvas, {
  required double gap,
  required double minOther,
}) {
  const slack = .5;
  for (var i = 0; i < tiles.length && tiles.length > 1; i++) {
    final want = widths[i];
    final tile = tiles[i];
    if (want == null ||
        tile.top > slack ||
        (tile.bottom - canvas.height).abs() > slack) {
      continue;
    }
    final atLeft = tile.left < slack;
    if (!atLeft && (tile.right - canvas.width).abs() > slack) continue;
    final room = canvas.width - gap - minOther;
    if (room <= 0) return null;
    final width = want.clamp(0.0, room);
    // The others' span, before and after: everything beside the pinned tile.
    final (from, to) = atLeft
        ? ((tile.right + gap, canvas.width), (width + gap, canvas.width))
        : ((0.0, tile.left - gap), (0.0, canvas.width - width - gap));
    double move(double x) =>
        to.$1 + (x - from.$1) * (to.$2 - to.$1) / (from.$2 - from.$1);
    return [
      for (var j = 0; j < tiles.length; j++)
        j == i
            ? Rect.fromLTWH(
                atLeft ? 0 : canvas.width - width,
                tile.top,
                width,
                tile.height,
              )
            : Rect.fromLTRB(
                move(tiles[j].left),
                tiles[j].top,
                move(tiles[j].right),
                tiles[j].bottom,
              ),
    ];
  }
  return null;
}
